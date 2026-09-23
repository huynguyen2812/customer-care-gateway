import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CareJobStatus, Installation, Prisma } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { InstallationsService } from '../installations/installations.service';
import { PetclinicSyncService } from '../petclinic/petclinic-sync.service';
import { CrmContext } from './crm-session.service';
import { entitlementUsable } from './crm.constants';
import { maskPhone, redact, redactText } from './crm-redact';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE = /^[0-9a-f]{32}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const JOB_STATUSES = Object.values(CareJobStatus);
const FAILED: CareJobStatus[] = ['FAILED', 'ACCOUNT_RESTRICTED', 'RECIPIENT_NOT_FOUND'];
const CANCELLABLE: CareJobStatus[] = ['QUEUED', 'PROCESSING'];
const MAX_CUSTOMER_GROUPS = 5000;

function page(q: Record<string, unknown>) {
  const p = Math.max(1, Math.min(10_000, Number(q.page) || 1));
  const size = Math.max(1, Math.min(100, Number(q.pageSize) || 20));
  return { page: p, pageSize: size, skip: (p - 1) * size };
}
function notFound(): never { throw new NotFoundException({ code: 'NOT_FOUND', message: 'Không tìm thấy dữ liệu.' }); }
function actor(ctx: CrmContext) { return { actorType: 'CRM_USER', actorId: ctx.platformUserId }; }

/**
 * Every method takes the CrmContext built from the server-side session. Tenant scope is always
 * `Installation.tenantId = ctx.platformTenantId`; IDs from the client are only looked up inside that
 * scope, and anything outside it is reported exactly like a missing record (404, no oracle).
 */
@Injectable()
export class CrmDataService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly installationsSvc: InstallationsService, private readonly petclinic: PetclinicSyncService) {}

  // ---------- scope ----------
  private async installationIds(ctx: CrmContext): Promise<string[]> {
    return (await this.prisma.installation.findMany({ where: { tenantId: ctx.platformTenantId }, select: { id: true } })).map((i) => i.id);
  }
  async ownInstallation(ctx: CrmContext, id: unknown): Promise<Installation> {
    if (typeof id !== 'string' || !UUID.test(id)) notFound();
    const row = await this.prisma.installation.findFirst({ where: { id, tenantId: ctx.platformTenantId } });
    if (!row) notFound();
    return row;
  }
  private opaqueId(kind: string, installationId: string, phoneHash: string): string {
    return createHmac('sha256', process.env.PHONE_HASH_PEPPER || '').update(`crm:${kind}:${installationId}:${phoneHash}`).digest('hex').slice(0, 32);
  }
  private decryptSafe(v: string | null | undefined): string | null { if (!v) return null; try { return this.crypto.decrypt(v); } catch { return null; } }

  // ---------- overview ----------
  async overview(ctx: CrmContext, period: string) {
    const ids = await this.installationIds(ctx);
    const days = period === 'today' ? 1 : period === '30d' ? 30 : 7;
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));
    const scope = { installationId: { in: ids } };
    const [queued, processing, sent, failed, cancelled, optedOut, upcomingCount, windowRows, upcoming, recent, kill] = await Promise.all([
      this.prisma.careJob.count({ where: { ...scope, status: 'QUEUED' } }),
      this.prisma.careJob.count({ where: { ...scope, status: 'PROCESSING' } }),
      this.prisma.careJob.count({ where: { ...scope, status: 'SENT' } }),
      this.prisma.careJob.count({ where: { ...scope, status: { in: FAILED } } }),
      this.prisma.careJob.count({ where: { ...scope, status: { in: ['CANCELLED', 'OPTED_OUT'] } } }),
      this.prisma.optOut.count({ where: scope }),
      this.prisma.careJob.count({ where: { ...scope, status: 'QUEUED', scheduledAt: { gt: new Date() } } }),
      this.prisma.careJob.findMany({ where: { ...scope, OR: [{ status: 'SENT', sentAt: { gte: start } }, { status: { in: FAILED }, updatedAt: { gte: start } }] }, select: { status: true, sentAt: true, updatedAt: true }, take: 20_000 }),
      this.prisma.careJob.findMany({ where: { ...scope, status: { in: CANCELLABLE } }, orderBy: { scheduledAt: 'asc' }, take: 5, select: { id: true, externalReferenceId: true, eventType: true, scheduledAt: true, status: true } }),
      this.prisma.auditLog.findMany({ where: { OR: [{ tenantId: ctx.platformTenantId }, { installationId: { in: ids } }] }, orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, action: true, result: true, actorType: true, actorId: true, createdAt: true } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'kill_switch' } }),
    ]);
    const buckets = new Map<string, { date: string; sent: number; failed: number }>();
    for (let i = 0; i < days; i++) { const d = new Date(start); d.setDate(start.getDate() + i); buckets.set(d.toDateString(), { date: d.toISOString(), sent: 0, failed: 0 }); }
    for (const r of windowRows) {
      const when = r.status === 'SENT' ? r.sentAt : r.updatedAt; const b = when && buckets.get(new Date(when).toDateString());
      if (b) { if (r.status === 'SENT') b.sent++; else b.failed++; }
    }
    return {
      period: days === 1 ? 'today' : `${days}d`,
      counts: { connections: ids.length, queued, processing, sent, failed, cancelled, optedOut, upcoming: upcomingCount },
      series: [...buckets.values()],
      upcoming,
      recent: recent.map((a) => ({ ...a, actorId: redactText(a.actorId) })),
      autoSend: { paused: ctx.tenant.autoSendPaused, workerRunning: process.env.WORKER_ENABLED === 'true' },
      sendingService: { available: (kill?.value as { enabled?: boolean } | null)?.enabled !== true },
      entitlement: { status: ctx.tenant.entitlementStatus, usable: entitlementUsable(ctx.tenant), planCode: ctx.tenant.planCode, expiresAt: ctx.tenant.entitlementExpiresAt },
    };
  }

  // ---------- installations / sources ----------
  private installationView = {
    id: true, sourceProduct: true, status: true, paused: true, dailyQuota: true, quietHoursStart: true, quietHoursEnd: true, timezone: true, lastConnectedAt: true, lastError: true, createdAt: true,
    zaloAccounts: { where: { revokedAt: null }, select: { id: true, channel: true, displayName: true, status: true, paused: true, isDefault: true, lastConnectedAt: true, lastError: true } },
    petclinicConnection: { select: { apiBaseUrl: true, apiTenantId: true, allowedBranchIds: true, reminderLeadMinutes: true, active: true, lastSyncAt: true, lastSyncStatus: true, lastError: true } },
    _count: { select: { jobs: true, templates: true, optOuts: true } },
  } satisfies Prisma.InstallationSelect;

  private cleanInstallation<T extends { lastError: string | null; zaloAccounts: { lastError: string | null }[]; petclinicConnection: { lastError: string | null } | null }>(row: T): T {
    return { ...row, lastError: redactText(row.lastError), zaloAccounts: row.zaloAccounts.map((z) => ({ ...z, lastError: redactText(z.lastError) })), petclinicConnection: row.petclinicConnection && { ...row.petclinicConnection, lastError: redactText(row.petclinicConnection.lastError) } };
  }
  async installations(ctx: CrmContext) {
    const rows = await this.prisma.installation.findMany({ where: { tenantId: ctx.platformTenantId }, orderBy: { createdAt: 'asc' }, select: this.installationView });
    return rows.map((r) => this.cleanInstallation(r));
  }
  async installation(ctx: CrmContext, id: string) {
    await this.ownInstallation(ctx, id);
    return this.cleanInstallation(await this.prisma.installation.findUniqueOrThrow({ where: { id }, select: this.installationView }));
  }
  async configurePetclinic(ctx: CrmContext, id: string, body: Record<string, unknown>) {
    const inst = await this.ownInstallation(ctx, id);
    if (inst.status === 'REVOKED') notFound();
    try { new URL(String(body.apiBaseUrl || '')); } catch { throw new BadRequestException({ code: 'VALIDATION', message: 'Địa chỉ API PETCLINIC không hợp lệ.' }); }
    const input = { apiBaseUrl: body.apiBaseUrl, apiToken: body.apiToken, apiTenantId: body.apiTenantId, allowedBranchIds: body.allowedBranchIds, pilotAllowedPhones: body.pilotAllowedPhones, reminderLeadMinutes: body.reminderLeadMinutes, active: body.active === true };
    const out = await this.petclinic.configure(id, input, `crm:${ctx.platformUserId}`, 'CRM_USER');
    return { installationId: out.installationId, active: out.active, branchCount: out.branchCount, pilotAllowCount: out.pilotAllowCount };
  }
  async previewPetclinic(ctx: CrmContext, id: string) {
    await this.ownInstallation(ctx, id);
    const out = await this.petclinic.sync(id, {}, `crm:${ctx.platformUserId}`, 'CRM_USER');
    return { dryRun: out.dryRun, scanned: out.scanned, eligible: out.eligible, created: out.created, cancelled: out.cancelled, skippedByReason: out.skippedByReason };
  }

  // ---------- customers (derived from the tenant's own care jobs; no cross-tenant data) ----------
  private async customerRows(ctx: CrmContext) {
    const ids = await this.installationIds(ctx);
    if (!ids.length) return [];
    const [latest, groups, optOuts, installs] = await Promise.all([
      this.prisma.careJob.findMany({ where: { installationId: { in: ids } }, distinct: ['installationId', 'phoneHash'], orderBy: [{ installationId: 'asc' }, { phoneHash: 'asc' }, { createdAt: 'desc' }], take: MAX_CUSTOMER_GROUPS, select: { installationId: true, phoneHash: true, recipientNameEnc: true, phoneEnc: true, sourceProduct: true, consentStatus: true, createdAt: true } }),
      this.prisma.careJob.groupBy({ by: ['installationId', 'phoneHash'], where: { installationId: { in: ids } }, _count: { _all: true }, _max: { createdAt: true, sentAt: true } }),
      this.prisma.optOut.findMany({ where: { installationId: { in: ids } }, select: { installationId: true, phoneHash: true } }),
      this.prisma.installation.findMany({ where: { id: { in: ids } }, select: { id: true, sourceProduct: true } }),
    ]);
    const stats = new Map(groups.map((g) => [`${g.installationId}:${g.phoneHash}`, g]));
    const opted = new Set(optOuts.map((o) => `${o.installationId}:${o.phoneHash}`));
    const product = new Map(installs.map((i) => [i.id, i.sourceProduct]));
    return latest.map((r) => {
      const key = `${r.installationId}:${r.phoneHash}`; const g = stats.get(key);
      const name = this.decryptSafe(r.recipientNameEnc);
      return {
        id: this.opaqueId('customer', r.installationId, r.phoneHash), installationId: r.installationId, phoneHash: r.phoneHash,
        name: name || 'Khách hàng', maskedPhone: maskPhone(this.decryptSafe(r.phoneEnc)), sourceProduct: product.get(r.installationId) || r.sourceProduct,
        consentStatus: opted.has(key) ? 'WITHDRAWN' : r.consentStatus, optedOut: opted.has(key),
        careCount: g?._count._all || 0, lastInteractionAt: g?._max.sentAt || g?._max.createdAt || r.createdAt,
      };
    });
  }
  async customers(ctx: CrmContext, q: Record<string, unknown>) {
    const rows = await this.customerRows(ctx);
    const search = String(q.q || '').trim().toLowerCase();
    const source = String(q.source || '');
    const consent = String(q.consent || '');
    const filtered = rows.filter((r) => (!search || r.name.toLowerCase().includes(search) || (r.maskedPhone || '').includes(search) || r.id.startsWith(search))
      && (!source || r.sourceProduct === source) && (!consent || r.consentStatus === consent))
      .sort((a, b) => +new Date(b.lastInteractionAt) - +new Date(a.lastInteractionAt));
    const p = page(q);
    return {
      items: filtered.slice(p.skip, p.skip + p.pageSize).map(({ phoneHash: _h, ...r }) => r), total: filtered.length, page: p.page, pageSize: p.pageSize,
      stats: { total: rows.length, granted: rows.filter((r) => r.consentStatus === 'GRANTED').length, optedOut: rows.filter((r) => r.optedOut).length },
    };
  }
  async customer(ctx: CrmContext, id: string) {
    if (!OPAQUE.test(id)) notFound();
    const row = (await this.customerRows(ctx)).find((r) => r.id === id);
    if (!row) notFound();
    const history = await this.prisma.careJob.findMany({ where: { installationId: row.installationId, phoneHash: row.phoneHash }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, externalReferenceId: true, eventType: true, templateCode: true, scheduledAt: true, status: true, sentAt: true, failureCode: true, createdAt: true } });
    const { phoneHash: _h, ...customer } = row;
    return { ...customer, history };
  }

  // ---------- templates ----------
  async templates(ctx: CrmContext) {
    const ids = await this.installationIds(ctx);
    return this.prisma.messageTemplate.findMany({ where: { installationId: { in: ids } }, orderBy: { updatedAt: 'desc' }, select: { id: true, installationId: true, code: true, body: true, allowedVariables: true, active: true, updatedAt: true } });
  }
  async upsertTemplate(ctx: CrmContext, body: Record<string, unknown>) {
    const inst = await this.ownInstallation(ctx, body.installationId);
    if (inst.status === 'REVOKED') notFound();
    const out = await this.installationsSvc.upsertTemplate(inst.id, { code: body.code, body: body.body, allowedVariables: body.allowedVariables, active: body.active !== false }, `crm:${ctx.platformUserId}`, 'CRM_USER');
    return out;
  }
  async setTemplateActive(ctx: CrmContext, id: string, active: unknown) {
    if (typeof id !== 'string' || !UUID.test(id)) notFound();
    if (typeof active !== 'boolean') throw new BadRequestException({ code: 'VALIDATION', message: 'Thiếu trạng thái bật/tắt.' });
    const ids = await this.installationIds(ctx);
    const t = await this.prisma.messageTemplate.findFirst({ where: { id, installationId: { in: ids } } });
    if (!t) notFound();
    if (active && !entitlementUsable(ctx.tenant)) throw new ForbiddenException({ code: 'ENTITLEMENT_INACTIVE', message: 'Gói dịch vụ không cho phép bật mẫu tin.' });
    await this.prisma.messageTemplate.update({ where: { id }, data: { active } });
    await this.prisma.auditLog.create({ data: { installationId: t.installationId, tenantId: ctx.platformTenantId, ...actor(ctx), action: 'MESSAGE_TEMPLATE_UPSERTED', targetType: 'MessageTemplate', targetId: id, result: 'SUCCESS', metadata: { code: t.code, active } } });
    return { id, active };
  }

  // ---------- jobs ----------
  private jobSelect = { id: true, installationId: true, externalReferenceId: true, sourceProduct: true, eventType: true, templateCode: true, scheduledAt: true, consentStatus: true, status: true, attempts: true, failureCode: true, failureReason: true, sentAt: true, cancelledAt: true, createdAt: true, updatedAt: true, branchId: true, selectedZaloAccountId: true, selectedChannel: true, selectedZaloAccount: { select: { displayName: true } } } satisfies Prisma.CareJobSelect;
  async jobs(ctx: CrmContext, q: Record<string, unknown>) {
    const ids = await this.installationIds(ctx);
    const where: Prisma.CareJobWhereInput = { installationId: { in: ids } };
    const group = String(q.status || '');
    const groups: Record<string, CareJobStatus[]> = { pending: ['QUEUED'], processing: ['PROCESSING'], sent: ['SENT'], failed: FAILED, cancelled: ['CANCELLED', 'OPTED_OUT'] };
    if (groups[group]) where.status = { in: groups[group] };
    else if (JOB_STATUSES.includes(group as CareJobStatus)) where.status = group as CareJobStatus;
    if (q.installationId) { if (!ids.includes(String(q.installationId))) return { items: [], total: 0, page: 1, pageSize: 20, stats: await this.jobStats(ids) }; where.installationId = String(q.installationId); }
    if (q.templateCode) where.templateCode = String(q.templateCode).slice(0, 100);
    const from = q.from ? new Date(`${q.from}T00:00:00`) : null; const to = q.to ? new Date(`${q.to}T23:59:59.999`) : null;
    if ((from && !Number.isNaN(+from)) || (to && !Number.isNaN(+to))) where.scheduledAt = { ...(from && !Number.isNaN(+from) ? { gte: from } : {}), ...(to && !Number.isNaN(+to) ? { lte: to } : {}) };
    const search = String(q.q || '').trim().slice(0, 100);
    if (search) where.OR = [{ externalReferenceId: { contains: search, mode: 'insensitive' } }, { eventType: { contains: search, mode: 'insensitive' } }, { templateCode: { contains: search, mode: 'insensitive' } }];
    const p = page(q);
    const [items, total, stats, templates] = await Promise.all([
      this.prisma.careJob.findMany({ where, orderBy: { scheduledAt: 'desc' }, skip: p.skip, take: p.pageSize, select: this.jobSelect }),
      this.prisma.careJob.count({ where }), this.jobStats(ids),
      this.prisma.careJob.findMany({ where: { installationId: { in: ids } }, distinct: ['templateCode'], select: { templateCode: true }, take: 200 }),
    ]);
    return { items: items.map(({ selectedZaloAccount, ...j }) => ({ ...j, selectedZaloAccountName: selectedZaloAccount?.displayName ?? null, failureReason: redactText(j.failureReason) })), total, page: p.page, pageSize: p.pageSize, stats, templateCodes: templates.map((t) => t.templateCode).sort() };
  }
  private async jobStats(ids: string[]) {
    const rows = await this.prisma.careJob.groupBy({ by: ['status'], where: { installationId: { in: ids } }, _count: { _all: true } });
    const n = (s: CareJobStatus[]) => rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + r._count._all, 0);
    return { pending: n(['QUEUED']), processing: n(['PROCESSING']), sent: n(['SENT']), failed: n(FAILED), cancelled: n(['CANCELLED', 'OPTED_OUT']) };
  }
  async job(ctx: CrmContext, id: string) {
    if (typeof id !== 'string' || !UUID.test(id)) notFound();
    const ids = await this.installationIds(ctx);
    const job = await this.prisma.careJob.findFirst({ where: { id, installationId: { in: ids } }, select: this.jobSelect });
    if (!job) notFound();
    const attempts = await this.prisma.deliveryAttempt.findMany({ where: { careJobId: id, tenantId: ctx.platformTenantId }, orderBy: { attemptNumber: 'asc' }, select: { id: true, attemptNumber: true, zaloAccountId: true, status: true, outcomeCode: true, providerMessageId: true, sendCount: true, startedAt: true, finishedAt: true, createdAt: true, account: { select: { displayName: true } } } });
    const { selectedZaloAccount, ...rest } = job;
    return { ...rest, selectedZaloAccountName: selectedZaloAccount?.displayName ?? null, failureReason: redactText(job.failureReason), deliveryAttempts: attempts.map(({ account, ...a }) => ({ ...a, accountName: account.displayName })) };
  }
  async cancelJobs(ctx: CrmContext, rawIds: unknown) {
    const ids = Array.isArray(rawIds) ? [...new Set(rawIds.map(String))] : [];
    if (!ids.length || ids.length > 100 || ids.some((i) => !UUID.test(i))) throw new BadRequestException({ code: 'VALIDATION', message: 'Danh sách tác vụ không hợp lệ (1–100 mã).' });
    const own = await this.installationIds(ctx);
    const results: { id: string; cancelled: boolean; reason?: string }[] = [];
    for (const id of ids) {
      const job = await this.prisma.careJob.findFirst({ where: { id, installationId: { in: own } }, select: { id: true, installationId: true } });
      // Foreign or unknown IDs get the same answer: not found.
      if (!job) { results.push({ id, cancelled: false, reason: 'NOT_FOUND' }); continue; }
      const r = await this.prisma.careJob.updateMany({ where: { id, installationId: job.installationId, status: { in: CANCELLABLE } }, data: { status: 'CANCELLED', cancelledAt: new Date(), failureCode: 'TENANT_CANCELLED' } });
      await this.prisma.auditLog.create({ data: { installationId: job.installationId, tenantId: ctx.platformTenantId, ...actor(ctx), action: 'CARE_JOB_CANCELLED', targetType: 'CareJob', targetId: id, result: r.count ? 'SUCCESS' : 'NO_CHANGE' } });
      results.push({ id, cancelled: r.count === 1, ...(r.count ? {} : { reason: 'NOT_CANCELLABLE' }) });
    }
    return { results, cancelled: results.filter((r) => r.cancelled).length };
  }

  // ---------- opt-outs ----------
  private async optOutRows(ctx: CrmContext) {
    const ids = await this.installationIds(ctx);
    const rows = await this.prisma.optOut.findMany({ where: { installationId: { in: ids } }, orderBy: { createdAt: 'desc' }, take: 5000 });
    const phones = await this.prisma.careJob.findMany({ where: { installationId: { in: ids }, phoneHash: { in: rows.map((r) => r.phoneHash) } }, distinct: ['installationId', 'phoneHash'], select: { installationId: true, phoneHash: true, phoneEnc: true } });
    const phoneBy = new Map(phones.map((p) => [`${p.installationId}:${p.phoneHash}`, p.phoneEnc]));
    return rows.map((r) => ({ id: this.opaqueId('optout', r.installationId, r.phoneHash), installationId: r.installationId, phoneHash: r.phoneHash, maskedPhone: maskPhone(this.decryptSafe(phoneBy.get(`${r.installationId}:${r.phoneHash}`))), source: r.source, reason: redactText(r.reason), createdAt: r.createdAt }));
  }
  async optOuts(ctx: CrmContext, q: Record<string, unknown>) {
    const rows = await this.optOutRows(ctx);
    const search = String(q.q || '').trim().toLowerCase();
    const filtered = rows.filter((r) => !search || (r.maskedPhone || '').includes(search) || (r.reason || '').toLowerCase().includes(search) || r.source.toLowerCase().includes(search));
    const p = page(q);
    return { items: filtered.slice(p.skip, p.skip + p.pageSize).map(({ phoneHash: _h, ...r }) => r), total: filtered.length, page: p.page, pageSize: p.pageSize };
  }
  async removeOptOut(ctx: CrmContext, id: string, reason: unknown) {
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (why.length < 5 || why.length > 300) throw new BadRequestException({ code: 'VALIDATION', message: 'Cần nhập lý do (5–300 ký tự).' });
    if (!OPAQUE.test(id)) notFound();
    const row = (await this.optOutRows(ctx)).find((r) => r.id === id);
    if (!row) notFound();
    await this.prisma.optOut.delete({ where: { installationId_phoneHash: { installationId: row.installationId, phoneHash: row.phoneHash } } });
    await this.prisma.auditLog.create({ data: { installationId: row.installationId, tenantId: ctx.platformTenantId, ...actor(ctx), action: 'OPT_OUT_REMOVED', targetType: 'OptOut', targetId: id, result: 'SUCCESS', reason: redactText(why)?.slice(0, 500) } });
    return { id, removed: true };
  }

  // ---------- audit ----------
  async audit(ctx: CrmContext, q: Record<string, unknown>) {
    const ids = await this.installationIds(ctx);
    // Tenant audit = rows tagged with this tenant OR with one of its installations (older admin rows lack tenantId).
    const scope: Prisma.AuditLogWhereInput = { OR: [{ tenantId: ctx.platformTenantId }, { installationId: { in: ids } }] };
    const where: Prisma.AuditLogWhereInput = { AND: [scope] };
    const and = where.AND as Prisma.AuditLogWhereInput[];
    if (q.action) and.push({ action: String(q.action).slice(0, 120) });
    if (q.installationId) and.push({ installationId: ids.includes(String(q.installationId)) ? String(q.installationId) : '00000000-0000-0000-0000-000000000000' });
    const result = String(q.result || '');
    if (result === 'success') and.push({ result: 'SUCCESS' }); else if (result === 'no_change') and.push({ result: 'NO_CHANGE' }); else if (result === 'failed') and.push({ result: { notIn: ['SUCCESS', 'NO_CHANGE'] } });
    const search = String(q.q || '').trim().slice(0, 100);
    if (search) and.push({ OR: [{ action: { contains: search, mode: 'insensitive' } }, { actorId: { contains: search, mode: 'insensitive' } }] });
    const p = page(q);
    const [items, total, actions] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.pageSize, select: { id: true, installationId: true, actorType: true, actorId: true, action: true, targetType: true, targetId: true, result: true, reason: true, metadata: true, createdAt: true } }),
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where: scope, distinct: ['action'], select: { action: true }, take: 200 }),
    ]);
    return { items: items.map((a) => ({ ...a, actorId: redactText(a.actorId), reason: redactText(a.reason), metadata: redact(a.metadata) })), total, page: p.page, pageSize: p.pageSize, actions: actions.map((a) => a.action).sort() };
  }

  // ---------- settings ----------
  private planDailyMax(ctx: CrmContext): number | null {
    const v = (ctx.tenant.limits as Record<string, unknown> | null)?.dailyQuotaMax;
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
  }
  async settings(ctx: CrmContext) {
    const [installs, kill] = await Promise.all([
      this.prisma.installation.findMany({ where: { tenantId: ctx.platformTenantId }, orderBy: { createdAt: 'asc' }, select: { id: true, sourceProduct: true, status: true, dailyQuota: true, quietHoursStart: true, quietHoursEnd: true, timezone: true } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'kill_switch' } }),
    ]);
    return {
      autoSendPaused: ctx.tenant.autoSendPaused, autoSendPausedAt: ctx.tenant.autoSendPausedAt, tenantDailyQuota: ctx.tenant.tenantDailyQuota, timezone: ctx.tenant.timezone,
      entitlement: { status: ctx.tenant.entitlementStatus, usable: entitlementUsable(ctx.tenant), planCode: ctx.tenant.planCode, expiresAt: ctx.tenant.entitlementExpiresAt, dailyQuotaMax: this.planDailyMax(ctx) },
      sendingService: { available: (kill?.value as { enabled?: boolean } | null)?.enabled !== true },
      workerRunning: process.env.WORKER_ENABLED === 'true',
      installations: installs,
    };
  }
  async updateSettings(ctx: CrmContext, body: Record<string, unknown>) {
    const usable = entitlementUsable(ctx.tenant);
    const changes: string[] = [];
    if (body.autoSendPaused !== undefined) {
      if (typeof body.autoSendPaused !== 'boolean') throw new BadRequestException({ code: 'VALIDATION', message: 'Giá trị tạm dừng không hợp lệ.' });
      if (!body.autoSendPaused && !usable) throw new ForbiddenException({ code: 'ENTITLEMENT_INACTIVE', message: 'Gói dịch vụ không cho phép bật lại tự động gửi.' });
      if (body.autoSendPaused !== ctx.tenant.autoSendPaused) {
        await this.prisma.crmTenant.update({ where: { platformTenantId: ctx.platformTenantId }, data: { autoSendPaused: body.autoSendPaused, autoSendPausedAt: body.autoSendPaused ? new Date() : null, autoSendPausedBy: body.autoSendPaused ? ctx.platformUserId : null } });
        await this.prisma.auditLog.create({ data: { tenantId: ctx.platformTenantId, ...actor(ctx), action: body.autoSendPaused ? 'CRM_AUTO_SEND_PAUSED' : 'CRM_AUTO_SEND_RESUMED', targetType: 'CrmTenant', targetId: ctx.platformTenantId, result: 'SUCCESS' } });
        changes.push('autoSendPaused');
      }
    }
    if (body.tenantDailyQuota !== undefined) {
      const q = body.tenantDailyQuota === null ? null : Number(body.tenantDailyQuota);
      if (q !== null && (!Number.isInteger(q) || q < 1)) throw new BadRequestException({ code: 'VALIDATION', message: 'Hạn mức doanh nghiệp phải là số nguyên dương.' });
      const max = this.planDailyMax(ctx);
      if (q !== null && max !== null && q > max) throw new ForbiddenException({ code: 'PLAN_LIMIT', message: `Hạn mức vượt giới hạn của gói (${max} tin/ngày).` });
      if (q !== null && (ctx.tenant.tenantDailyQuota === null || q > ctx.tenant.tenantDailyQuota) && !usable) throw new ForbiddenException({ code: 'ENTITLEMENT_INACTIVE', message: 'Gói dịch vụ không cho phép tăng hạn mức.' });
      if (q !== ctx.tenant.tenantDailyQuota) {
        await this.prisma.crmTenant.update({ where: { platformTenantId: ctx.platformTenantId }, data: { tenantDailyQuota: q } });
        await this.prisma.auditLog.create({ data: { tenantId: ctx.platformTenantId, ...actor(ctx), action: 'CRM_TENANT_QUOTA_UPDATED', targetType: 'CrmTenant', targetId: ctx.platformTenantId, result: 'SUCCESS', metadata: { before: ctx.tenant.tenantDailyQuota, after: q } } });
        changes.push('tenantDailyQuota');
      }
    }
    if (body.installations !== undefined) {
      if (!Array.isArray(body.installations) || body.installations.length > 20) throw new BadRequestException({ code: 'VALIDATION', message: 'Danh sách kết nối không hợp lệ.' });
      const max = this.planDailyMax(ctx);
      for (const raw of body.installations as Record<string, unknown>[]) {
        const inst = await this.ownInstallation(ctx, raw?.id);
        const data: Prisma.InstallationUpdateInput = {};
        if (raw.dailyQuota !== undefined) {
          const q = Number(raw.dailyQuota);
          if (!Number.isInteger(q) || q < 1) throw new BadRequestException({ code: 'VALIDATION', message: 'Hạn mức phải là số nguyên dương.' });
          if (q > inst.dailyQuota && !usable) throw new ForbiddenException({ code: 'ENTITLEMENT_INACTIVE', message: 'Gói dịch vụ không cho phép tăng hạn mức.' });
          // Without a Platform plan limit the tenant may only lower its quota.
          if ((max !== null && q > max) || (max === null && q > inst.dailyQuota)) throw new ForbiddenException({ code: 'PLAN_LIMIT', message: `Hạn mức vượt giới hạn của gói${max !== null ? ` (${max} tin/ngày)` : ''}.` });
          data.dailyQuota = q;
        }
        for (const k of ['quietHoursStart', 'quietHoursEnd'] as const) {
          if (raw[k] !== undefined) { if (typeof raw[k] !== 'string' || !HHMM.test(raw[k] as string)) throw new BadRequestException({ code: 'VALIDATION', message: 'Giờ yên tĩnh phải theo định dạng HH:MM.' }); data[k] = raw[k] as string; }
        }
        const start = (data.quietHoursStart as string) ?? inst.quietHoursStart; const end = (data.quietHoursEnd as string) ?? inst.quietHoursEnd;
        if (start === end) throw new BadRequestException({ code: 'VALIDATION', message: 'Giờ bắt đầu và kết thúc giờ yên tĩnh phải khác nhau.' });
        if (Object.keys(data).length) {
          await this.prisma.installation.update({ where: { id: inst.id }, data });
          await this.prisma.auditLog.create({ data: { installationId: inst.id, tenantId: ctx.platformTenantId, ...actor(ctx), action: 'CRM_SENDING_LIMITS_UPDATED', targetType: 'Installation', targetId: inst.id, result: 'SUCCESS', metadata: { before: { dailyQuota: inst.dailyQuota, quietHoursStart: inst.quietHoursStart, quietHoursEnd: inst.quietHoursEnd }, after: data as Prisma.InputJsonValue } } });
          changes.push(`installation:${inst.id}`);
        }
      }
    }
    if (!changes.length) throw new ConflictException({ code: 'NO_CHANGE', message: 'Không có thay đổi nào.' });
    return { updated: changes };
  }

}
