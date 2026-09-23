import { Injectable } from '@nestjs/common';
import { CareJob } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { isQuietHour } from '../common/quiet-hours';
import { ChannelRouterService } from '../channel/channel-router.service';
import { ChannelError } from '../channel/channel.errors';
import { TemplateService } from '../templates/template.service';
import { SourceVerifierService } from './source-verifier.service';
import { WebhookOutboxService } from '../webhooks/webhook-outbox.service';
import { PetclinicSyncService } from '../petclinic/petclinic-sync.service';

@Injectable()
export class CareWorkerService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly adapter: ChannelRouterService, private readonly verifier: SourceVerifierService, private readonly webhooks: WebhookOutboxService, private readonly templates: TemplateService, private readonly petclinic: PetclinicSyncService) {}

  async processNext(workerId = `worker-${randomUUID()}`): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<CareJob[]>`
      UPDATE "CareJob" SET "status"='PROCESSING', "lockedAt"=NOW(), "lockedBy"=${workerId}, "updatedAt"=NOW()
      WHERE "id"=(SELECT "id" FROM "CareJob" WHERE "status"='QUEUED' AND "scheduledAt"<=NOW()
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt"<=NOW()) ORDER BY "scheduledAt" FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`;
    const job = rows[0]; if (!job) return false;
    const installation = await this.prisma.installation.findUniqueOrThrow({ where: { id: job.installationId } });
    if (installation.status !== 'ACTIVE' || installation.paused) return this.finish(job.id, 'CANCELLED', 'INSTALLATION_INACTIVE');
    const kill = await this.prisma.systemSetting.findUnique({ where: { key: 'kill_switch' } });
    if ((kill?.value as any)?.enabled === true) return this.requeue(job.id, 'SYSTEM_PAUSED', 15);
    if (job.consentStatus !== 'GRANTED' || await this.prisma.optOut.findUnique({ where: { installationId_phoneHash: { installationId: job.installationId, phoneHash: job.phoneHash } } })) return this.finish(job.id, 'OPTED_OUT', 'RECIPIENT_OPTED_OUT');
    if (isQuietHour(new Date(), installation.quietHoursStart, installation.quietHoursEnd, installation.timezone)) return this.requeue(job.id, 'QUIET_HOURS', 15);
    const since = new Date(Date.now() - 24 * 3600_000);
    if (await this.prisma.careJob.count({ where: { installationId: job.installationId, status: 'SENT', sentAt: { gte: since } } }) >= installation.dailyQuota) return this.requeue(job.id, 'DAILY_QUOTA', 60);
    try {
      let valid = false;
      if (job.sourceProduct === 'PETCLINIC_OPERATING') valid = await this.petclinic.verify(job.installationId, job.externalReferenceId, job.scheduledAt);
      else {
        if (!installation.sourceVerifyUrl || !installation.callbackSecretEnc) return this.finish(job.id, 'CANCELLED', 'SOURCE_VERIFY_UNCONFIGURED');
        const callbackSecret = this.crypto.decrypt(installation.callbackSecretEnc);
        valid = await this.verifier.verify(installation.sourceVerifyUrl, callbackSecret, { externalReferenceId: job.externalReferenceId, sourceProduct: job.sourceProduct, eventType: job.eventType, scheduledAt: job.scheduledAt.toISOString() });
      }
      if (!valid) return this.finish(job.id, 'CANCELLED', 'SOURCE_NO_LONGER_VALID');
      const content = await this.templates.render(job.installationId, job.templateCode, job.templateVariables as Record<string, unknown>);
      const sent = await this.adapter.send({ installationId: job.installationId, externalReferenceId: job.externalReferenceId, recipientName: this.crypto.decrypt(job.recipientNameEnc), phoneE164: this.crypto.decrypt(job.phoneEnc), templateCode: job.templateCode, content });
      await this.prisma.careJob.update({ where: { id: job.id }, data: { status: 'SENT', sentAt: new Date(), providerMessageId: sent.providerMessageId, attempts: { increment: 1 }, lockedAt: null, lockedBy: null, failureCode: null, failureReason: null } });
      await this.webhooks.enqueue(job.id); return true;
    } catch (error) {
      if (error instanceof ChannelError && ['ACCOUNT_RESTRICTED', 'RECIPIENT_NOT_FOUND'].includes(error.code)) {
        const terminalStatus = error.code === 'ACCOUNT_RESTRICTED' ? 'ACCOUNT_RESTRICTED' : 'RECIPIENT_NOT_FOUND';
        await this.prisma.careJob.update({ where: { id: job.id }, data: { status: terminalStatus, attempts: { increment: 1 }, lockedAt: null, lockedBy: null, failureCode: error.code, failureReason: error.message.slice(0, 500) } });
        await this.webhooks.enqueue(job.id); return true;
      }
      const attempts = job.attempts + 1; const terminal = attempts >= 5;
      await this.prisma.careJob.update({ where: { id: job.id }, data: { status: terminal ? 'FAILED' : 'QUEUED', attempts, nextAttemptAt: terminal ? null : new Date(Date.now() + Math.min(2 ** attempts, 60) * 60_000), lockedAt: null, lockedBy: null, failureCode: 'SEND_FAILED', failureReason: (error instanceof Error ? error.message : 'SEND_FAILED').slice(0, 500) } });
      if (terminal) await this.webhooks.enqueue(job.id); return true;
    }
  }

  private async finish(id: string, status: 'CANCELLED' | 'OPTED_OUT', code: string): Promise<boolean> {
    await this.prisma.careJob.update({ where: { id }, data: { status, cancelledAt: new Date(), failureCode: code, lockedAt: null, lockedBy: null } }); await this.webhooks.enqueue(id); return true;
  }
  private async requeue(id: string, code: string, minutes: number): Promise<boolean> {
    await this.prisma.careJob.update({ where: { id }, data: { status: 'QUEUED', nextAttemptAt: new Date(Date.now() + minutes * 60_000), failureCode: code, lockedAt: null, lockedBy: null } }); return true;
  }
}
