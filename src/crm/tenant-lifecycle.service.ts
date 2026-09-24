import { BadRequestException, ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { CRM_PRODUCT_CODE } from './crm.constants';

type Tx = Prisma.TransactionClient;

export const LIFECYCLE_TYPES = new Set(['tenant.deletion_requested', 'tenant.deletion_cancelled', 'tenant.purge_requested']);

/** Max clock skew tolerated between Platform and CRM when checking `scheduledPurgeAt`. */
const PURGE_SKEW_MS = 5 * 60_000;
/** Deletion work can be larger than Prisma's 5 s default interactive-transaction timeout. */
export const LIFECYCLE_TX = { timeout: 60_000, maxWait: 10_000 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_KEY = /(secret|token|password|credential|signingkey|privatekey|cookie|enc$)/i;

export type DeletionStatus = 'PENDING' | 'CANCELLED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface DeletionInput {
  requestId: string;
  requestedAt: Date;
  scheduledPurgeAt: Date;
  retentionDays: number;
}

export interface PurgeStatusBody {
  requestId: string;
  platformTenantId: string;
  productCode: typeof CRM_PRODUCT_CODE;
  status: DeletionStatus;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function statusBody(row: { requestId: string; platformTenantId: string; status: string; completedAt: Date | null; errorCode: string | null; errorMessage: string | null }): PurgeStatusBody {
  return {
    requestId: row.requestId,
    platformTenantId: row.platformTenantId,
    productCode: CRM_PRODUCT_CODE,
    status: row.status as DeletionStatus,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

/** Drops any key that looks like secret material, recursively — defence in depth over the explicit field lists. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !SECRET_KEY.test(key)).map(([key, item]) => [key, redact(item)]));
}

/**
 * Tenant termination lifecycle driven exclusively by the Platform control plane (signed events).
 * CRM never schedules or starts a deletion on its own; it locks, exports and purges only its own
 * tenant data when Platform asks, and reports a status Platform can reconcile and retry against.
 */
@Injectable()
export class TenantLifecycleService {
  private readonly logger = new Logger(TenantLifecycleService.name);

  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService) {}

  parseDeletion(body: Record<string, any>): DeletionInput {
    const deletion = body?.deletion || {};
    const requestId = String(deletion.requestId || '');
    if (!UUID.test(requestId)) throw new BadRequestException('Invalid deletion request');
    const requestedAt = toDate(deletion.requestedAt) ?? new Date();
    const scheduledPurgeAt = toDate(deletion.scheduledPurgeAt);
    if (!scheduledPurgeAt) throw new BadRequestException('Invalid scheduledPurgeAt');
    const retentionDays = Number.isInteger(deletion.retentionDays) && deletion.retentionDays >= 0 ? deletion.retentionDays : 30;
    return { requestId, requestedAt, scheduledPurgeAt, retentionDays };
  }

  /** Lock the tenant, keep all data, and return the export Platform stores with its deletion request. */
  async requestDeletion(tx: Tx, platformTenantId: string, input: DeletionInput) {
    const existing = await tx.crmTenantDeletion.findUnique({ where: { requestId: input.requestId } });
    if (existing && existing.platformTenantId !== platformTenantId) throw new ConflictException('REQUEST_TENANT_MISMATCH');
    if (existing?.status === 'CANCELLED') throw new ConflictException('DELETION_CANCELLED');
    if (existing?.status === 'COMPLETED') return { result: 'IGNORED_ALREADY_PURGED', status: statusBody(existing), export: null, exportChecksum: existing.exportChecksum };
    const other = await tx.crmTenantDeletion.findFirst({ where: { platformTenantId, requestId: { not: input.requestId }, status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } } });
    if (other) throw new ConflictException('DELETION_ALREADY_OPEN');

    const exported = await this.buildExport(tx, platformTenantId);
    const exportChecksum = createHash('sha256').update(JSON.stringify(exported)).digest('hex');
    const row = existing
      ? await tx.crmTenantDeletion.update({ where: { requestId: input.requestId }, data: { exportChecksum } })
      : await tx.crmTenantDeletion.create({ data: { requestId: input.requestId, platformTenantId, status: 'PENDING', requestedAt: input.requestedAt, scheduledPurgeAt: input.scheduledPurgeAt, retentionDays: input.retentionDays, exportChecksum } });

    await tx.crmTenant.updateMany({ where: { platformTenantId }, data: { deletionRequestId: input.requestId, deletionRequestedAt: input.requestedAt } });
    await tx.crmSession.updateMany({ where: { platformTenantId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'TENANT_DELETION' } });
    return { result: existing ? 'IGNORED_ALREADY_LOCKED' : 'APPLIED', status: statusBody(row), export: exported, exportChecksum };
  }

  /** Lift the lock only. Entitlement is whatever Platform confirms in the same event — never self-restored. */
  async cancelDeletion(tx: Tx, platformTenantId: string, requestId: string, entitlementData: Record<string, unknown>, occurredAt: Date) {
    if (!UUID.test(requestId)) throw new BadRequestException('Invalid deletion request');
    const existing = await tx.crmTenantDeletion.findUnique({ where: { requestId } });
    if (!existing) return { result: 'IGNORED_UNKNOWN_REQUEST', status: null };
    if (existing.platformTenantId !== platformTenantId) throw new ConflictException('REQUEST_TENANT_MISMATCH');
    if (existing.status === 'CANCELLED') return { result: 'IGNORED_ALREADY_CANCELLED', status: statusBody(existing) };
    if (existing.status === 'COMPLETED' || existing.status === 'PROCESSING') throw new ConflictException('DELETION_ALREADY_PURGED');

    // Ledger keeps only non-PII metadata (+ export checksum for reconciliation); CRM never stores the export itself.
    const row = await tx.crmTenantDeletion.update({ where: { requestId }, data: { status: 'CANCELLED', cancelledAt: new Date(), errorCode: null, errorMessage: null, deletedCounts: Prisma.DbNull } });
    const tenant = await tx.crmTenant.findUnique({ where: { platformTenantId }, select: { entitlementUpdatedAt: true } });
    // A delayed (retried) cancel must not roll back a newer entitlement already applied: lift the lock only.
    const stale = Boolean(tenant?.entitlementUpdatedAt && tenant.entitlementUpdatedAt > occurredAt);
    await tx.crmTenant.updateMany({
      where: { platformTenantId, deletionRequestId: requestId },
      data: { deletionRequestId: null, deletionRequestedAt: null, ...(!stale && Object.keys(entitlementData).length ? { ...entitlementData, entitlementUpdatedAt: occurredAt } : {}) },
    });
    return { result: stale ? 'APPLIED_LOCK_ONLY_STALE_ENTITLEMENT' : 'APPLIED', status: statusBody(row) };
  }

  /** Current ledger status, used to answer a redelivered event without re-running it. */
  async currentStatus(requestId: string) {
    const row = await this.prisma.crmTenantDeletion.findUnique({ where: { requestId } });
    return row ? statusBody(row) : null;
  }

  async assertPurgeAllowed(platformTenantId: string, input: DeletionInput) {
    const row = await this.prisma.crmTenantDeletion.findUnique({ where: { requestId: input.requestId } });
    if (!row) throw new ConflictException('DELETION_NOT_REQUESTED');
    if (row.platformTenantId !== platformTenantId) throw new ConflictException('REQUEST_TENANT_MISMATCH');
    if (row.status === 'CANCELLED') throw new ConflictException('DELETION_CANCELLED');
    if (row.status !== 'COMPLETED' && Date.now() + PURGE_SKEW_MS < row.scheduledPurgeAt.getTime()) throw new ConflictException('PURGE_NOT_DUE');
    return row;
  }

  /**
   * Delete every CRM row owned by this tenant, in FK-safe order, inside the caller's transaction.
   * Scope is derived only from the tenant id carried by the signed Platform event: installations and
   * Zalo accounts are looked up by that tenant, never taken from the payload. Shared/system tables
   * (SystemSetting, AdminUser, ControlNonce) and the PlatformEvent idempotency ledger are untouched.
   */
  async purge(tx: Tx, platformTenantId: string, requestId: string) {
    const ledger = await tx.crmTenantDeletion.findUnique({ where: { requestId } });
    if (ledger?.status === 'COMPLETED') return { result: 'IGNORED_ALREADY_PURGED', status: statusBody(ledger) };
    await tx.crmTenantDeletion.update({ where: { requestId }, data: { status: 'PROCESSING', purgeStartedAt: new Date(), purgeAttempts: { increment: 1 } } });

    const installationIds = (await tx.installation.findMany({ where: { tenantId: platformTenantId }, select: { id: true } })).map((i) => i.id);
    const accountIds = (await tx.zaloAccount.findMany({ where: { tenantId: platformTenantId }, select: { id: true } })).map((a) => a.id);
    const byInstallation = { installationId: { in: installationIds } };

    const counts: Record<string, number> = {};
    const run = async (name: string, op: Promise<{ count: number }>) => { counts[name] = (await op).count; };
    await run('webhookDelivery', tx.webhookDelivery.deleteMany({ where: byInstallation }));
    await run('deliveryAttempt', tx.deliveryAttempt.deleteMany({ where: { tenantId: platformTenantId } }));
    await run('careJob', tx.careJob.deleteMany({ where: byInstallation }));
    await run('senderHealthEvent', tx.senderHealthEvent.deleteMany({ where: { tenantId: platformTenantId } }));
    await run('zaloRoutingRule', tx.zaloRoutingRule.deleteMany({ where: { tenantId: platformTenantId } }));
    await run('zaloAccount', tx.zaloAccount.deleteMany({ where: { tenantId: platformTenantId } }));
    await run('optOut', tx.optOut.deleteMany({ where: byInstallation }));
    await run('messageTemplate', tx.messageTemplate.deleteMany({ where: byInstallation }));
    await run('apiCredential', tx.apiCredential.deleteMany({ where: byInstallation }));
    await run('requestNonce', tx.requestNonce.deleteMany({ where: byInstallation }));
    await run('petclinicConnection', tx.petclinicConnection.deleteMany({ where: byInstallation }));
    // Retention: tenant audit logs are personal/operational data and go with the tenant. The only record
    // kept is the no-PII TENANT_PURGED entry below, mirroring Platform's deletion receipt.
    await run('auditLog', tx.auditLog.deleteMany({ where: { OR: [{ tenantId: platformTenantId }, byInstallation] } }));
    await run('installation', tx.installation.deleteMany({ where: { tenantId: platformTenantId } }));
    await run('deliveryQuotaCounter', tx.deliveryQuotaCounter.deleteMany({ where: { OR: [
      { scope: 'TENANT', scopeId: platformTenantId },
      { scope: 'INSTALLATION', scopeId: { in: installationIds } },
      { scope: 'ACCOUNT', scopeId: { in: accountIds } },
    ] } }));
    await run('crmSsoTokenReplay', tx.crmSsoTokenReplay.deleteMany({ where: { platformTenantId } }));
    await run('crmSession', tx.crmSession.deleteMany({ where: { platformTenantId } }));
    await run('crmTenant', tx.crmTenant.deleteMany({ where: { platformTenantId } }));

    const row = await tx.crmTenantDeletion.update({ where: { requestId }, data: { status: 'COMPLETED', completedAt: new Date(), deletedCounts: counts, errorCode: null, errorMessage: null } });
    await tx.auditLog.create({ data: { tenantId: platformTenantId, actorType: 'PLATFORM', actorId: 'platform-admin', action: 'TENANT_PURGED', targetType: 'CrmTenant', targetId: platformTenantId, result: 'SUCCESS', metadata: { requestId, deletedCounts: counts } } });
    return { result: 'APPLIED', status: statusBody(row) };
  }

  /** Record a failed purge outside the rolled-back transaction so Platform sees FAILED and retries. */
  async markFailed(requestId: string, error: unknown) {
    const errorCode = error instanceof ConflictException ? String((error.getResponse() as any)?.message ?? 'CONFLICT') : 'PURGE_FAILED';
    const errorMessage = 'Không xóa được dữ liệu CRM; Platform sẽ thử lại.';
    this.logger.error(`Purge ${requestId} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    const row = await this.prisma.crmTenantDeletion.update({ where: { requestId }, data: { status: 'FAILED', errorCode: errorCode.slice(0, 80), errorMessage } }).catch(() => null);
    return row ? statusBody(row) : null;
  }

  failure(status: PurgeStatusBody | null) {
    return new ServiceUnavailableException({ code: 'PURGE_FAILED', status });
  }

  private decrypt(blob: string | null, warnings: { count: number }): string | null {
    if (!blob) return null;
    try { return this.crypto.decrypt(blob); } catch { warnings.count += 1; return null; }
  }

  /** Tenant-owned CRM data only. No secrets, tokens, signing keys, JWTs or other tenants' rows. */
  async buildExport(tx: Tx, platformTenantId: string) {
    const warnings = { count: 0 };
    const tenant = await tx.crmTenant.findUnique({ where: { platformTenantId } });
    const installations = await tx.installation.findMany({ where: { tenantId: platformTenantId }, orderBy: { createdAt: 'asc' } });
    const installationIds = installations.map((i) => i.id);
    const byInstallation = { installationId: { in: installationIds } };
    const [sessions, connections, templates, jobs, optOuts, accounts, rules, attempts, audits, events] = await Promise.all([
      tx.crmSession.findMany({ where: { platformTenantId }, orderBy: { issuedAt: 'asc' }, select: { platformUserId: true, displayName: true, username: true, roles: true, issuedAt: true, lastCheckedAt: true } }),
      tx.petclinicConnection.findMany({ where: byInstallation }),
      tx.messageTemplate.findMany({ where: byInstallation, orderBy: { code: 'asc' } }),
      tx.careJob.findMany({ where: byInstallation, orderBy: { createdAt: 'asc' } }),
      tx.optOut.findMany({ where: byInstallation, orderBy: { createdAt: 'asc' } }),
      tx.zaloAccount.findMany({ where: { tenantId: platformTenantId }, orderBy: { createdAt: 'asc' } }),
      tx.zaloRoutingRule.findMany({ where: { tenantId: platformTenantId }, orderBy: { createdAt: 'asc' } }),
      tx.deliveryAttempt.findMany({ where: { tenantId: platformTenantId }, orderBy: { createdAt: 'asc' } }),
      tx.auditLog.findMany({ where: { OR: [{ tenantId: platformTenantId }, byInstallation] }, orderBy: { createdAt: 'asc' } }),
      tx.platformEvent.findMany({ where: { platformTenantId }, orderBy: { receivedAt: 'asc' } }),
    ]);

    // CRM only knows its users through sessions created from Platform token-exchange.
    const users = new Map<string, { platformUserId: string; displayName: string | null; username: string | null; roles: string[]; firstSeenAt: Date; lastSeenAt: Date }>();
    for (const s of sessions) {
      const prev = users.get(s.platformUserId);
      users.set(s.platformUserId, { platformUserId: s.platformUserId, displayName: s.displayName, username: s.username, roles: s.roles, firstSeenAt: prev?.firstSeenAt ?? s.issuedAt, lastSeenAt: s.lastCheckedAt });
    }

    const exported = {
      schemaVersion: 1,
      productCode: CRM_PRODUCT_CODE,
      platformTenantId,
      exportedAt: new Date().toISOString(),
      settings: tenant ? {
        displayName: tenant.displayName, planCode: tenant.planCode, entitlementStatus: tenant.entitlementStatus, limits: tenant.limits, features: tenant.features,
        entitlementStartsAt: tenant.entitlementStartsAt, entitlementExpiresAt: tenant.entitlementExpiresAt, tenantDailyQuota: tenant.tenantDailyQuota,
        timezone: tenant.timezone, autoSendPaused: tenant.autoSendPaused, createdAt: tenant.createdAt,
      } : null,
      users: [...users.values()],
      installations: installations.map((i) => ({ id: i.id, sourceProduct: i.sourceProduct, status: i.status, scopes: i.scopes, dailyQuota: i.dailyQuota, quietHoursStart: i.quietHoursStart, quietHoursEnd: i.quietHoursEnd, timezone: i.timezone, paused: i.paused, createdAt: i.createdAt, revokedAt: i.revokedAt })),
      connectors: connections.map((c) => ({ installationId: c.installationId, apiBaseUrl: c.apiBaseUrl, allowedBranchIds: c.allowedBranchIds, reminderLeadMinutes: c.reminderLeadMinutes, active: c.active, lastSyncAt: c.lastSyncAt, lastSyncStatus: c.lastSyncStatus })),
      templates: templates.map((t) => ({ installationId: t.installationId, code: t.code, body: t.body, allowedVariables: t.allowedVariables, active: t.active, createdAt: t.createdAt })),
      careJobs: jobs.map((j) => ({
        id: j.id, installationId: j.installationId, externalReferenceId: j.externalReferenceId, eventType: j.eventType, branchId: j.branchId,
        recipientName: this.decrypt(j.recipientNameEnc, warnings), phone: this.decrypt(j.phoneEnc, warnings), templateCode: j.templateCode, templateVariables: j.templateVariables,
        consentStatus: j.consentStatus, status: j.status, attempts: j.attempts, scheduledAt: j.scheduledAt, sentAt: j.sentAt, cancelledAt: j.cancelledAt,
        failureCode: j.failureCode, selectedChannel: j.selectedChannel, selectedZaloAccountId: j.selectedZaloAccountId, createdAt: j.createdAt,
      })),
      optOuts: optOuts.map((o) => ({ installationId: o.installationId, phoneHash: o.phoneHash, source: o.source, reason: o.reason, createdAt: o.createdAt })),
      zaloAccounts: accounts.map((a) => ({ id: a.id, channel: a.channel, displayName: a.displayName, phoneMasked: a.phoneMasked, status: a.status, paused: a.paused, priority: a.priority, isDefault: a.isDefault, dailyQuota: a.dailyQuota, timezone: a.timezone, lastConnectedAt: a.lastConnectedAt, createdAt: a.createdAt, revokedAt: a.revokedAt })),
      routingRules: rules.map((r) => ({ id: r.id, zaloAccountId: r.zaloAccountId, installationId: r.installationId, branchId: r.branchId, eventType: r.eventType, priority: r.priority, active: r.active, createdAt: r.createdAt })),
      deliveryHistory: attempts.map((d) => ({ id: d.id, careJobId: d.careJobId, zaloAccountId: d.zaloAccountId, attemptNumber: d.attemptNumber, status: d.status, outcomeCode: d.outcomeCode, providerMessageId: d.providerMessageId, sendCount: d.sendCount, startedAt: d.startedAt, finishedAt: d.finishedAt })),
      // Connection/activity log for reconciliation. `metadata` is dropped entirely: it is free-form and can
      // carry connector tokens; nothing in it is needed to reconcile.
      activityLog: audits.map((l) => ({ action: l.action, actorType: l.actorType, targetType: l.targetType, targetId: l.targetId, result: l.result, reason: l.reason, createdAt: l.createdAt })),
      platformEvents: events.map((e) => ({ eventId: e.eventId, type: e.type, occurredAt: e.occurredAt, receivedAt: e.receivedAt, result: e.result })),
      warnings: warnings.count ? { undecryptableFields: warnings.count } : undefined,
    };
    return redact(exported) as Record<string, unknown>;
  }
}
