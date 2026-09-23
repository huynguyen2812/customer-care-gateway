import { Injectable } from '@nestjs/common';
import { CareJob, DeliveryAttempt, Installation, Prisma, ZaloAccount } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { isQuietHour } from '../common/quiet-hours';
import { sha256 } from '../common/canonical';
import { ChannelRouterService } from '../channel/channel-router.service';
import { ACCOUNT_LEVEL_NOT_SENT, capabilitiesOf, SendOutcome } from '../channel/channel.adapter';
import { TemplateService } from '../templates/template.service';
import { SourceVerifierService } from './source-verifier.service';
import { WebhookOutboxService } from '../webhooks/webhook-outbox.service';
import { PetclinicSyncService } from '../petclinic/petclinic-sync.service';
import { TenantAccessService } from '../crm/tenant-access.service';
import { AccountSelectorService, TIER_LABEL } from '../delivery/account-selector.service';
import { QuotaScope, QuotaService } from '../delivery/quota.service';
import { redactText } from '../crm/crm-redact';

const STALE_LOCK_MS = 5 * 60_000;
const MAX_SAME_ATTEMPT_SENDS = 3;
const MAX_ACCOUNT_SWITCHES = 3;

class QuotaExhausted extends Error { constructor(readonly scope: string) { super(scope); } }

/**
 * Worker delivery pipeline (one job per claim, claimed with FOR UPDATE SKIP LOCKED):
 * policy gates → unresolved-attempt handling → source recheck → account selection (sticky) →
 * atomic quota reservation + DeliveryAttempt → send through the selected account → outcome.
 *
 * Duplicate-send rules:
 *   - an attempt that may have reached Zalo (IN_FLIGHT after a crash, or UNKNOWN) is never followed by
 *     a new attempt or another account; it is retried with the SAME deliveryAttemptId on the SAME account
 *     only when that sender dedupes (capabilities.idempotentSend), otherwise the job is parked as
 *     FAILED/DELIVERY_UNCERTAIN for manual review (no webhook, quota kept);
 *   - failover to another account happens only after a certain NOT_SENT with an account-level cause;
 *   - the database allows at most one SENT and one open attempt per job (partial unique indexes).
 */
@Injectable()
export class CareWorkerService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly router: ChannelRouterService, private readonly verifier: SourceVerifierService, private readonly webhooks: WebhookOutboxService, private readonly templates: TemplateService, private readonly petclinic: PetclinicSyncService, private readonly tenantAccess: TenantAccessService, private readonly selector: AccountSelectorService, private readonly quota: QuotaService) {}

  /** Jobs left PROCESSING by a crashed worker go back to QUEUED; their open attempt decides what happens next. */
  async recoverStale(now = new Date()): Promise<number> {
    const r = await this.prisma.careJob.updateMany({ where: { status: 'PROCESSING', lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) } }, data: { status: 'QUEUED', lockedAt: null, lockedBy: null } });
    return r.count;
  }

  async processNext(workerId = `worker-${randomUUID()}`): Promise<boolean> {
    await this.recoverStale();
    const rows = await this.prisma.$queryRaw<CareJob[]>`
      UPDATE "CareJob" SET "status"='PROCESSING', "lockedAt"=NOW(), "lockedBy"=${workerId}, "updatedAt"=NOW()
      WHERE "id"=(SELECT "id" FROM "CareJob" WHERE "status"='QUEUED' AND "scheduledAt"<=NOW()
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt"<=NOW()) ORDER BY "scheduledAt" FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`;
    const job = rows[0]; if (!job) return false;
    const installation = await this.prisma.installation.findUniqueOrThrow({ where: { id: job.installationId } });
    if (installation.status !== 'ACTIVE' || installation.paused) return this.finish(job.id, 'CANCELLED', 'INSTALLATION_INACTIVE');
    const decision = await this.tenantAccess.sendingDecision(installation.tenantId);
    if (decision.action === 'CANCEL') return this.finish(job.id, 'CANCELLED', decision.code);
    if (decision.action === 'HOLD') return this.requeue(job.id, decision.code, 15);
    const kill = await this.prisma.systemSetting.findUnique({ where: { key: 'kill_switch' } });
    if ((kill?.value as any)?.enabled === true) return this.requeue(job.id, 'SYSTEM_PAUSED', 15);
    if (job.consentStatus !== 'GRANTED' || await this.prisma.optOut.findUnique({ where: { installationId_phoneHash: { installationId: job.installationId, phoneHash: job.phoneHash } } })) return this.finish(job.id, 'OPTED_OUT', 'RECIPIENT_OPTED_OUT');
    if (isQuietHour(new Date(), installation.quietHoursStart, installation.quietHoursEnd, installation.timezone)) return this.requeue(job.id, 'QUIET_HOURS', 15);

    const sent = await this.prisma.deliveryAttempt.findFirst({ where: { careJobId: job.id, status: 'SENT' } });
    if (sent) return this.markSent(job, sent, sent.providerMessageId || 'reconciled'); // reconcile, never resend
    const open = await this.prisma.deliveryAttempt.findFirst({ where: { careJobId: job.id, status: { in: ['RESERVED', 'IN_FLIGHT', 'UNKNOWN'] } } });
    if (open && open.status === 'RESERVED') {
      // Reserved but the send never started (crash before IN_FLIGHT committed): certainly not sent.
      await this.closeNotSent(open, 'WORKER_RESTARTED_BEFORE_SEND');
    } else if (open) {
      return this.resolveUncertain(job, installation, open);
    }

    try {
      if (!(await this.sourceStillValid(job, installation))) return this.finish(job.id, 'CANCELLED', 'SOURCE_NO_LONGER_VALID');
    } catch {
      return this.requeue(job.id, 'SOURCE_VERIFY_UNAVAILABLE', 5);
    }
    let content: string;
    try { content = await this.templates.render(job.installationId, job.templateCode, job.templateVariables as Record<string, unknown>); }
    catch { return this.finish(job.id, 'CANCELLED', 'TEMPLATE_UNAVAILABLE'); }
    return this.deliver(job, installation, content);
  }

  private async sourceStillValid(job: CareJob, installation: Installation): Promise<boolean> {
    if (job.sourceProduct === 'PETCLINIC_OPERATING') return this.petclinic.verify(job.installationId, job.externalReferenceId, job.scheduledAt);
    if (!installation.sourceVerifyUrl || !installation.callbackSecretEnc) return false;
    return this.verifier.verify(installation.sourceVerifyUrl, this.crypto.decrypt(installation.callbackSecretEnc), { externalReferenceId: job.externalReferenceId, sourceProduct: job.sourceProduct, eventType: job.eventType, scheduledAt: job.scheduledAt.toISOString() });
  }

  private async deliver(job: CareJob, installation: Installation, content: string): Promise<boolean> {
    const phoneE164 = this.crypto.decrypt(job.phoneEnc);
    const exclude: string[] = [];
    for (let i = 0; i < MAX_ACCOUNT_SWITCHES; i++) {
      const current = i === 0 ? job : await this.prisma.careJob.findUniqueOrThrow({ where: { id: job.id } });
      const sel = await this.selector.select(current, installation, phoneE164, exclude);
      if (sel.kind === 'NONE') {
        if (sel.reason === 'RECIPIENT_NOT_FOUND') return this.terminal(job.id, 'RECIPIENT_NOT_FOUND', 'RECIPIENT_NOT_FOUND');
        return this.requeue(job.id, 'NO_ELIGIBLE_ACCOUNT', 15);
      }
      const account = sel.account;
      const scopes = await this.quota.scopesFor(installation, account);
      let attempt: DeliveryAttempt;
      try {
        attempt = await this.prisma.$transaction(async (tx) => {
          const r = await this.quota.reserveIn(tx, scopes);
          if (!r.ok) throw new QuotaExhausted(r.exhausted);
          const attemptNumber = (await tx.deliveryAttempt.count({ where: { careJobId: job.id } })) + 1;
          const created = await tx.deliveryAttempt.create({ data: {
            tenantId: installation.tenantId, careJobId: job.id, installationId: installation.id, zaloAccountId: account.id, attemptNumber,
            requestHash: sha256(`${job.requestHash}:${account.id}`), quotaScopes: scopes as unknown as Prisma.InputJsonValue,
          } });
          if (current.selectedZaloAccountId !== account.id) {
            await tx.careJob.update({ where: { id: job.id }, data: { selectedZaloAccountId: account.id, selectedChannel: account.channel } });
            await tx.auditLog.create({ data: { installationId: installation.id, tenantId: installation.tenantId, actorType: 'SYSTEM', actorId: 'worker', action: current.selectedZaloAccountId ? 'ZALO_ACCOUNT_RESELECTED' : 'ZALO_ACCOUNT_SELECTED', targetType: 'CareJob', targetId: job.id, result: 'SUCCESS', metadata: { zaloAccountId: account.id, previousZaloAccountId: current.selectedZaloAccountId, tier: TIER_LABEL[sel.tier as 1 | 2 | 3], ruleId: sel.ruleId, reason: sel.reason, preflight: sel.preflight ?? null, attemptNumber } } });
          }
          return created;
        });
      } catch (error) {
        if (error instanceof QuotaExhausted) {
          if (error.scope === 'ACCOUNT') { exclude.push(account.id); continue; } // certain: nothing was sent
          return this.requeue(job.id, 'DAILY_QUOTA', 60);
        }
        throw error;
      }
      // Commit IN_FLIGHT before the network call so a crash is later treated as "maybe sent".
      await this.prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { status: 'IN_FLIGHT', startedAt: new Date(), sendCount: 1 } });
      const outcome = await this.sendSafely(account, installation, job, attempt, content, phoneE164);
      const next = await this.applyOutcome(job, installation, account, attempt, outcome);
      if (next !== 'FAILOVER') return true;
      exclude.push(account.id);
    }
    return this.requeue(job.id, 'NO_ELIGIBLE_ACCOUNT', 15);
  }

  private async sendSafely(account: ZaloAccount, installation: Installation, job: CareJob, attempt: DeliveryAttempt, content: string, phoneE164: string): Promise<SendOutcome> {
    try {
      return await this.router.send(account, installation.tenantId, { installationId: installation.id, channelAccountId: account.id, deliveryAttemptId: attempt.id, externalReferenceId: job.externalReferenceId, recipientName: this.crypto.decrypt(job.recipientNameEnc), phoneE164, templateCode: job.templateCode, content });
    } catch {
      return { kind: 'UNKNOWN', code: 'ADAPTER_EXCEPTION' };
    }
  }

  /** Attempt that may have reached Zalo: same attempt on the same account if the sender dedupes, else park. */
  private async resolveUncertain(job: CareJob, installation: Installation, attempt: DeliveryAttempt): Promise<boolean> {
    if (attempt.status === 'IN_FLIGHT') await this.prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { status: 'UNKNOWN', outcomeCode: attempt.outcomeCode || 'WORKER_RESTARTED_DURING_SEND' } });
    const account = await this.prisma.zaloAccount.findUnique({ where: { id: attempt.zaloAccountId } });
    const canRetrySame = account && account.tenantId === installation.tenantId && capabilitiesOf(account).idempotentSend && attempt.sendCount < MAX_SAME_ATTEMPT_SENDS;
    if (!canRetrySame) return this.parkUncertain(job, installation, attempt);
    let content: string;
    try { content = await this.templates.render(job.installationId, job.templateCode, job.templateVariables as Record<string, unknown>); }
    catch { return this.parkUncertain(job, installation, attempt); }
    await this.prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { status: 'IN_FLIGHT', sendCount: { increment: 1 } } });
    const outcome = await this.sendSafely(account, installation, job, attempt, content, this.crypto.decrypt(job.phoneEnc));
    const fresh = await this.prisma.deliveryAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    // A certain NOT_SENT on a retry of an attempt that was UNKNOWN before still cannot prove the first send failed.
    if (outcome.kind === 'NOT_SENT') return this.parkUncertain(job, installation, fresh, `RETRY_${outcome.code}`);
    await this.applyOutcome(job, installation, account, fresh, outcome);
    return true;
  }

  private async applyOutcome(job: CareJob, installation: Installation, account: ZaloAccount, attempt: DeliveryAttempt, outcome: SendOutcome): Promise<'DONE' | 'FAILOVER'> {
    if (outcome.kind === 'SENT') {
      await this.markSent(job, attempt, outcome.providerMessageId, account);
      return 'DONE';
    }
    if (outcome.kind === 'NOT_SENT') {
      await this.closeNotSent(attempt, outcome.code);
      if (outcome.accountStatus) await this.prisma.zaloAccount.update({ where: { id: account.id }, data: { status: outcome.accountStatus, lastError: outcome.code } });
      if (outcome.code === 'RECIPIENT_NOT_FOUND') { await this.terminal(job.id, 'RECIPIENT_NOT_FOUND', 'RECIPIENT_NOT_FOUND'); return 'DONE'; }
      if (ACCOUNT_LEVEL_NOT_SENT.includes(outcome.code)) {
        await this.prisma.auditLog.create({ data: { installationId: installation.id, tenantId: installation.tenantId, actorType: 'SYSTEM', actorId: 'worker', action: 'ZALO_ACCOUNT_REJECTED_BEFORE_SEND', targetType: 'CareJob', targetId: job.id, result: 'NO_CHANGE', reason: outcome.code, metadata: { zaloAccountId: account.id, deliveryAttemptId: attempt.id } } });
        return 'FAILOVER';
      }
      await this.terminal(job.id, 'FAILED', outcome.code);
      return 'DONE';
    }
    await this.prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { status: 'UNKNOWN', outcomeCode: outcome.code.slice(0, 80) } });
    await this.prisma.zaloAccount.update({ where: { id: account.id }, data: { lastError: `Kết quả gửi không xác định (${outcome.code})`.slice(0, 500) } });
    if (capabilitiesOf(account).idempotentSend && attempt.sendCount < MAX_SAME_ATTEMPT_SENDS) {
      await this.prisma.careJob.update({ where: { id: job.id }, data: { status: 'QUEUED', nextAttemptAt: new Date(Date.now() + 2 * 60_000), failureCode: 'DELIVERY_RETRY_SAME_ATTEMPT', lockedAt: null, lockedBy: null } });
      return 'DONE';
    }
    await this.parkUncertain(job, installation, { ...attempt, status: 'UNKNOWN' });
    return 'DONE';
  }

  private async markSent(job: CareJob, attempt: DeliveryAttempt, providerMessageId: string, account?: ZaloAccount): Promise<boolean> {
    await this.prisma.$transaction([
      this.prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { status: 'SENT', providerMessageId, finishedAt: attempt.finishedAt ?? new Date() } }),
      this.prisma.careJob.update({ where: { id: job.id }, data: { status: 'SENT', sentAt: new Date(), providerMessageId, attempts: { increment: 1 }, lockedAt: null, lockedBy: null, failureCode: null, failureReason: null } }),
      ...(account ? [this.prisma.zaloAccount.update({ where: { id: account.id }, data: { lastActiveAt: new Date(), lastError: null } })] : []),
    ]);
    await this.webhooks.enqueue(job.id);
    return true;
  }

  private async closeNotSent(attempt: DeliveryAttempt, code: string) {
    await this.prisma.$transaction(async (tx) => {
      const marked = await tx.deliveryAttempt.updateMany({ where: { id: attempt.id, quotaReleased: false }, data: { status: 'REJECTED_BEFORE_SEND', outcomeCode: code.slice(0, 80), quotaReleased: true, finishedAt: new Date() } });
      if (marked.count) await this.quota.release(attempt.quotaScopes as unknown as QuotaScope[], tx);
    });
  }

  /** Outcome unknown and not safely retryable: stop, keep quota, no webhook (a FAILED callback could make a source re-create the job). */
  private async parkUncertain(job: CareJob, installation: Installation, attempt: DeliveryAttempt, extra?: string): Promise<boolean> {
    const reason = redactText(`${attempt.outcomeCode || 'UNKNOWN'}${extra ? `/${extra}` : ''}`)!.slice(0, 500);
    await this.prisma.$transaction([
      this.prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { status: 'UNKNOWN', finishedAt: new Date() } }),
      this.prisma.careJob.update({ where: { id: job.id }, data: { status: 'FAILED', failureCode: 'DELIVERY_UNCERTAIN', failureReason: reason, attempts: { increment: 1 }, lockedAt: null, lockedBy: null } }),
      this.prisma.auditLog.create({ data: { installationId: installation.id, tenantId: installation.tenantId, actorType: 'SYSTEM', actorId: 'worker', action: 'DELIVERY_UNCERTAIN', targetType: 'CareJob', targetId: job.id, result: 'FAILED', reason, metadata: { zaloAccountId: attempt.zaloAccountId, deliveryAttemptId: attempt.id } } }),
    ]);
    return true;
  }

  private async terminal(id: string, status: 'RECIPIENT_NOT_FOUND' | 'FAILED', code: string): Promise<boolean> {
    await this.prisma.careJob.update({ where: { id }, data: { status, failureCode: code.slice(0, 80), attempts: { increment: 1 }, lockedAt: null, lockedBy: null } });
    await this.webhooks.enqueue(id); return true;
  }
  private async finish(id: string, status: 'CANCELLED' | 'OPTED_OUT', code: string): Promise<boolean> {
    await this.prisma.careJob.update({ where: { id }, data: { status, cancelledAt: new Date(), failureCode: code, lockedAt: null, lockedBy: null } }); await this.webhooks.enqueue(id); return true;
  }
  private async requeue(id: string, code: string, minutes: number): Promise<boolean> {
    await this.prisma.careJob.update({ where: { id }, data: { status: 'QUEUED', nextAttemptAt: new Date(Date.now() + minutes * 60_000), failureCode: code, lockedAt: null, lockedBy: null } }); return true;
  }
}
