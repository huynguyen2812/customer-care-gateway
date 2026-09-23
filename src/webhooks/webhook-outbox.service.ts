import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { canonicalJson } from '../common/canonical';
import { signWebhook } from './webhook-signer';
import { assertSafeEndpoint } from '../worker/source-verifier.service';

@Injectable()
export class WebhookOutboxService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService) {}

  async enqueue(careJobId: string): Promise<void> {
    const job = await this.prisma.careJob.findUniqueOrThrow({ where: { id: careJobId }, select: { installationId: true, status: true } });
    const latest = await this.prisma.webhookDelivery.aggregate({ where: { careJobId }, _max: { sequence: true } });
    await this.prisma.webhookDelivery.create({ data: { installationId: job.installationId, careJobId, status: job.status, sequence: (latest._max.sequence || 0) + 1, nextAttemptAt: new Date() } });
  }

  async deliverNext(): Promise<boolean> {
    const delivery = await this.prisma.webhookDelivery.findFirst({ where: { deliveredAt: null, nextAttemptAt: { lte: new Date() } }, orderBy: { createdAt: 'asc' }, include: { installation: true, careJob: true } });
    if (!delivery) return false;
    if (!delivery.installation.callbackUrl || !delivery.installation.callbackSecretEnc) {
      await this.fail(delivery.id, delivery.attempts, 'CALLBACK_UNCONFIGURED'); return true;
    }
    try {
      const url = assertSafeEndpoint(delivery.installation.callbackUrl);
      const payload = { eventId: delivery.id, sequence: delivery.sequence, careJobId: delivery.careJobId, externalReferenceId: delivery.careJob.externalReferenceId, status: delivery.status, occurredAt: new Date().toISOString() };
      const raw = Buffer.from(canonicalJson(payload)); const timestamp = Date.now().toString();
      const signature = signWebhook(this.crypto.decrypt(delivery.installation.callbackSecretEnc), timestamp, delivery.id, raw);
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-care-event-id': delivery.id, 'x-care-timestamp': timestamp, 'x-care-signature': signature }, body: raw, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      await this.prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { deliveredAt: new Date(), lastHttpStatus: response.status, attempts: { increment: 1 }, lastError: null } });
    } catch (error) { await this.fail(delivery.id, delivery.attempts, error instanceof Error ? error.message : 'DELIVERY_FAILED'); }
    return true;
  }

  private async fail(id: string, attempts: number, reason: string): Promise<void> {
    const delays = [60, 300, 1800, 7200, 21600, 86400]; const next = Math.min(attempts, delays.length - 1);
    await this.prisma.webhookDelivery.update({ where: { id }, data: { attempts: { increment: 1 }, lastError: reason.slice(0, 500), nextAttemptAt: attempts >= delays.length ? null : new Date(Date.now() + delays[next] * 1000) } });
  }
}
