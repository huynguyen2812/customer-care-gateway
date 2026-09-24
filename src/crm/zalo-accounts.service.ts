import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, NotImplementedException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, ZaloAccount } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { dayKey } from '../common/day-key';
import { capabilitiesOf } from '../channel/channel.adapter';
import { ChannelError } from '../channel/channel.errors';
import { PersonalZaloAdapter } from '../channel/personal-zalo.adapter';
import { unavailableReason } from '../delivery/account-selector.service';
import { QuotaService } from '../delivery/quota.service';
import { CrmContext } from './crm-session.service';
import { entitlementUsable } from './crm.constants';
import { redactText } from './crm-redact';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRANCH = /^[A-Za-z0-9._:-]{1,80}$/;
const EVENT = /^[A-Z0-9_]{2,80}$/;
/** Without a Platform plan limit, a single personal account is capped conservatively (docs/security.md). */
export const MAX_ACCOUNT_DAILY_WITHOUT_PLAN = 200;

/** Cấu hình sender v2 phía Gateway (một client cho cả deployment). Thiếu → không tự đăng ký. */
export function senderV2Config(): { baseUrl: string; clientId: string; signingKey: string } | null {
  const baseUrl = process.env.SENDER_V2_BASE_URL || ''; const clientId = process.env.SENDER_V2_CLIENT_ID || ''; const signingKey = process.env.SENDER_V2_SIGNING_KEY || '';
  return baseUrl && clientId && signingKey.length >= 32 ? { baseUrl, clientId, signingKey } : null;
}

/** Khoá tuần tự theo account trong một tiến trình (pause/resume/đăng ký không chen nhau). */
class KeyedMutex {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void; const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine); this.tails.set(key, tail);
    await prev;
    try { return await fn(); } finally { release(); if (this.tails.get(key) === tail) this.tails.delete(key); }
  }
}

function notFound(): never { throw new NotFoundException({ code: 'NOT_FOUND', message: 'Không tìm thấy dữ liệu.' }); }
function bad(message: string): never { throw new BadRequestException({ code: 'VALIDATION', message }); }

/**
 * Tenant-scoped management of Zalo accounts for the CRM. The tenant comes from the CRM session; an
 * account id outside the tenant is answered exactly like an unknown id. Responses never contain the
 * sender URL, client id, signing key, Zalo session or full phone number.
 */
@Injectable()
export class ZaloAccountsService {
  private readonly lock = new KeyedMutex();
  constructor(private readonly prisma: PrismaService, private readonly quota: QuotaService, private readonly personal: PersonalZaloAdapter, private readonly crypto: CryptoService) {}

  private async own(ctx: CrmContext, id: unknown): Promise<ZaloAccount> {
    if (typeof id !== 'string' || !UUID.test(id)) notFound();
    const a = await this.prisma.zaloAccount.findFirst({ where: { id, tenantId: ctx.platformTenantId, revokedAt: null } });
    if (!a) notFound();
    return a;
  }

  private audit(ctx: CrmContext, action: string, accountId: string, metadata?: Prisma.InputJsonValue, result = 'SUCCESS') {
    return this.prisma.auditLog.create({ data: { tenantId: ctx.platformTenantId, actorType: 'CRM_USER', actorId: ctx.platformUserId, action, targetType: 'ZaloAccount', targetId: accountId, result, metadata } });
  }

  private async view(ctx: CrmContext, accounts: ZaloAccount[]) {
    const ids = accounts.map((a) => a.id);
    const [rules, queued, counters] = await Promise.all([
      this.prisma.zaloRoutingRule.findMany({ where: { tenantId: ctx.platformTenantId, zaloAccountId: { in: ids } }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.careJob.groupBy({ by: ['selectedZaloAccountId'], where: { selectedZaloAccountId: { in: ids }, status: { in: ['QUEUED', 'PROCESSING'] } }, _count: { _all: true } }),
      this.prisma.deliveryQuotaCounter.findMany({ where: { scope: 'ACCOUNT', scopeId: { in: ids } } }),
    ]);
    return accounts.map((f) => {
      const caps = capabilitiesOf(f);
      const today = dayKey(new Date(), f.timezone);
      return {
        id: f.id, channel: f.channel, displayName: f.displayName, phoneMasked: f.phoneMasked, status: f.status, paused: f.paused, pausedAt: f.pausedAt,
        priority: f.priority, isDefault: f.isDefault, dailyQuota: f.dailyQuota, timezone: f.timezone,
        sentToday: counters.find((c) => c.scopeId === f.id && c.day === today)?.used ?? 0,
        queuedJobs: queued.find((q) => q.selectedZaloAccountId === f.id)?._count._all ?? 0,
        lastConnectedAt: f.lastConnectedAt, lastActiveAt: f.lastActiveAt, lastError: redactText(f.lastError), createdAt: f.createdAt,
        usable: unavailableReason(f) === null, unavailableReason: unavailableReason(f),
        capabilities: { qrLogin: caps.qrLogin === true, recipientPreflight: caps.recipientPreflight === true, idempotentSend: caps.idempotentSend === true, remoteControl: caps.remoteControl === true },
        assignments: rules.filter((r) => r.zaloAccountId === f.id).map((r) => ({ id: r.id, installationId: r.installationId, branchId: r.branchId, eventType: r.eventType, priority: r.priority, active: r.active })),
      };
    });
  }

  async list(ctx: CrmContext) {
    const accounts = await this.prisma.zaloAccount.findMany({ where: { tenantId: ctx.platformTenantId, revokedAt: null }, orderBy: [{ isDefault: 'desc' }, { priority: 'asc' }, { createdAt: 'asc' }] });
    const tenant = await this.quota.tenantLimit(ctx.platformTenantId);
    return { accounts: await this.view(ctx, accounts), tenantDailyLimit: tenant.limit, maxAccountDailyWithoutPlan: MAX_ACCOUNT_DAILY_WITHOUT_PLAN };
  }

  async get(ctx: CrmContext, id: string) {
    const a = await this.own(ctx, id);
    const [view] = await this.view(ctx, [a]);
    const recent = await this.prisma.deliveryAttempt.findMany({ where: { zaloAccountId: a.id, tenantId: ctx.platformTenantId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, careJobId: true, attemptNumber: true, status: true, outcomeCode: true, createdAt: true, finishedAt: true } });
    return { ...view, recentAttempts: recent };
  }

  /** Sum of account quotas may not exceed the tenant/plan limit; without a plan limit each account is capped. */
  private async assertQuota(ctx: CrmContext, dailyQuota: number, excludeId?: string) {
    if (!Number.isInteger(dailyQuota) || dailyQuota < 1) bad('Hạn mức phải là số nguyên dương.');
    const { limit } = await this.quota.tenantLimit(ctx.platformTenantId);
    if (limit === null) {
      if (dailyQuota > MAX_ACCOUNT_DAILY_WITHOUT_PLAN) throw new ForbiddenException({ code: 'PLAN_LIMIT', message: `Hạn mức mỗi tài khoản tối đa ${MAX_ACCOUNT_DAILY_WITHOUT_PLAN} tin/ngày khi gói chưa có giới hạn.` });
      return;
    }
    const others = await this.prisma.zaloAccount.aggregate({ where: { tenantId: ctx.platformTenantId, revokedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) }, _sum: { dailyQuota: true } });
    if ((others._sum.dailyQuota ?? 0) + dailyQuota > limit) throw new ForbiddenException({ code: 'PLAN_LIMIT', message: `Tổng hạn mức các tài khoản vượt giới hạn của doanh nghiệp (${limit} tin/ngày).` });
  }

  async create(ctx: CrmContext, body: Record<string, unknown>) {
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (displayName.length < 2 || displayName.length > 160) bad('Tên hiển thị 2–160 ký tự.');
    const channel = body.channel === 'ZNS' ? 'ZNS' : body.channel === undefined || body.channel === 'PERSONAL_ZALO' ? 'PERSONAL_ZALO' : bad('Loại kênh không hợp lệ.');
    const dailyQuota = body.dailyQuota === undefined ? 20 : Number(body.dailyQuota);
    const priority = body.priority === undefined ? 100 : Number(body.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 1000) bad('Mức ưu tiên 0–1000.');
    await this.assertQuota(ctx, dailyQuota);
    const created = await this.prisma.$transaction(async (tx) => {
      const hasDefault = await tx.zaloAccount.count({ where: { tenantId: ctx.platformTenantId, isDefault: true, revokedAt: null } });
      const makeDefault = body.isDefault === true || hasDefault === 0;
      if (makeDefault && hasDefault) await tx.zaloAccount.updateMany({ where: { tenantId: ctx.platformTenantId, isDefault: true }, data: { isDefault: false } });
      return tx.zaloAccount.create({ data: { tenantId: ctx.platformTenantId, channel, displayName, dailyQuota, priority, isDefault: makeDefault, status: 'PENDING_LOGIN', timezone: ctx.tenant.timezone } });
    });
    await this.audit(ctx, 'ZALO_ACCOUNT_CREATED', created.id, { channel, dailyQuota, priority, isDefault: created.isDefault });
    // Tự đăng ký với sender v2 (luồng chính; script quản trị phía sender chỉ dùng khi sự cố).
    if (channel === 'PERSONAL_ZALO' && senderV2Config()) await this.registerWithSender(ctx, created.id).catch(() => undefined);
    return this.get(ctx, created.id);
  }

  async update(ctx: CrmContext, id: string, body: Record<string, unknown>) {
    const a = await this.own(ctx, id);
    const data: Prisma.ZaloAccountUpdateInput = {};
    if (body.displayName !== undefined) { const n = typeof body.displayName === 'string' ? body.displayName.trim() : ''; if (n.length < 2 || n.length > 160) bad('Tên hiển thị 2–160 ký tự.'); data.displayName = n; }
    if (body.priority !== undefined) { const p = Number(body.priority); if (!Number.isInteger(p) || p < 0 || p > 1000) bad('Mức ưu tiên 0–1000.'); data.priority = p; }
    if (body.dailyQuota !== undefined) {
      const q = Number(body.dailyQuota);
      if (q > a.dailyQuota && !entitlementUsable(ctx.tenant)) throw new ForbiddenException({ code: 'ENTITLEMENT_INACTIVE', message: 'Gói dịch vụ không cho phép tăng hạn mức.' });
      await this.assertQuota(ctx, q, a.id); data.dailyQuota = q;
    }
    if (body.isDefault !== undefined && body.isDefault !== true) bad('Chỉ có thể đặt một tài khoản làm mặc định (chọn tài khoản khác để thay).');
    if (!Object.keys(data).length && body.isDefault !== true) throw new ConflictException({ code: 'NO_CHANGE', message: 'Không có thay đổi nào.' });
    await this.prisma.$transaction(async (tx) => {
      if (body.isDefault === true && !a.isDefault) {
        await tx.zaloAccount.updateMany({ where: { tenantId: ctx.platformTenantId, isDefault: true }, data: { isDefault: false } });
        data.isDefault = true;
      }
      await tx.zaloAccount.update({ where: { id: a.id }, data });
    });
    await this.audit(ctx, 'ZALO_ACCOUNT_UPDATED', a.id, { before: { displayName: a.displayName, priority: a.priority, dailyQuota: a.dailyQuota, isDefault: a.isDefault }, after: data as Prisma.InputJsonValue });
    return this.get(ctx, a.id);
  }

  /**
   * Đăng ký (lại) account với sender v2 — idempotent. Chỉ khi sender xác nhận mới ghi cấu hình gửi;
   * trước đó account KHÔNG dùng được (unavailableReason CREDENTIAL_MISSING) và không thể đăng nhập QR.
   */
  async registerWithSender(ctx: CrmContext, id: string) {
    const a = await this.own(ctx, id);
    const cfg = senderV2Config();
    if (!cfg || a.channel !== 'PERSONAL_ZALO') throw new ServiceUnavailableException({ code: 'SENDER_NOT_CONFIGURED', message: 'Dịch vụ gửi tin chưa được cấu hình.' });
    return this.lock.run(a.id, async () => {
      const r = await this.personal.register({ accountId: a.id, baseUrl: cfg.baseUrl, clientId: cfg.clientId, signingKey: cfg.signingKey }).catch(() => ({ ok: false as const, code: 'SENDER_UNREACHABLE' }));
      if (!r.ok) {
        await this.prisma.zaloAccount.update({ where: { id: a.id }, data: { lastError: `SENDER_REGISTRATION_PENDING (${r.code})`.slice(0, 500) } });
        await this.audit(ctx, 'ZALO_ACCOUNT_SENDER_REGISTRATION', a.id, { ok: false, code: r.code }, 'FAILED');
        throw new ServiceUnavailableException({ code: 'SENDER_REGISTRATION_PENDING', message: 'Chưa đăng ký được tài khoản với dịch vụ gửi tin. Vui lòng thử lại sau.' });
      }
      const caps = { contractVersion: 2, qrLogin: r.capabilities.qrLogin === true, recipientPreflight: r.capabilities.recipientPreflight === true, idempotentSend: r.capabilities.idempotentSend === true, remoteControl: r.capabilities.remoteControl === true };
      await this.prisma.zaloAccount.update({ where: { id: a.id }, data: { senderBaseUrl: cfg.baseUrl, senderClientId: cfg.clientId, credentialEnc: this.crypto.encrypt(cfg.signingKey), capabilities: caps, lastError: null } });
      await this.audit(ctx, 'ZALO_ACCOUNT_SENDER_REGISTRATION', a.id, { ok: true, capabilities: caps });
      return { id: a.id, registered: true, capabilities: caps };
    });
  }

  /**
   * Tạm dừng: khoá ở Gateway TRƯỚC rồi báo sender (không có cửa sổ Gateway còn gửi).
   * Bật lại: hỏi sender TRƯỚC; chỉ khi sender xác nhận phiên còn sống mới bỏ pause ở Gateway.
   * Sender trả RELOGIN_REQUIRED/ACCOUNT_UNAVAILABLE, timeout hay phản hồi lạ → giữ pause.
   */
  async setPaused(ctx: CrmContext, id: string, paused: boolean) {
    const a = await this.own(ctx, id);
    if (!paused && !entitlementUsable(ctx.tenant)) throw new ForbiddenException({ code: 'ENTITLEMENT_INACTIVE', message: 'Gói dịch vụ không cho phép bật lại tài khoản.' });
    return this.lock.run(a.id, async () => {
      const cur = await this.prisma.zaloAccount.findUniqueOrThrow({ where: { id: a.id } });
      if (paused) {
        await this.prisma.zaloAccount.update({ where: { id: a.id }, data: { paused: true, pausedAt: cur.paused ? cur.pausedAt : new Date(), pausedBy: cur.paused ? cur.pausedBy : ctx.platformUserId } });
        const r = await this.personal.controlDetailed(cur, 'pause').catch(() => ({ kind: 'UNKNOWN' as const, code: 'ADAPTER_ERROR' }));
        await this.audit(ctx, 'ZALO_ACCOUNT_PAUSED', a.id, { senderApplied: r.kind === 'APPLIED', sender: r.kind });
        return { id: a.id, paused: true, senderApplied: r.kind === 'APPLIED' };
      }
      if (!cur.paused) return { id: a.id, paused: false, senderApplied: true, unchanged: true };
      const r = await this.personal.controlDetailed(cur, 'resume').catch(() => ({ kind: 'UNKNOWN' as const, code: 'ADAPTER_ERROR' }));
      if (r.kind === 'APPLIED' || r.kind === 'UNSUPPORTED') {
        // UNSUPPORTED = sender không có điều khiển từ xa (v1/legacy): chỉ Gateway giữ pause, bỏ pause cục bộ như trước.
        await this.prisma.zaloAccount.update({ where: { id: a.id }, data: { paused: false, pausedAt: null, pausedBy: null, ...(r.kind === 'APPLIED' ? { status: 'CONNECTED', lastError: null } : {}) } });
        await this.audit(ctx, 'ZALO_ACCOUNT_RESUMED', a.id, { senderApplied: r.kind === 'APPLIED', sender: r.kind });
        return { id: a.id, paused: false, senderApplied: r.kind === 'APPLIED' };
      }
      const code = r.kind === 'REJECTED' ? r.code : r.code;
      if (r.kind === 'REJECTED' && r.code === 'RELOGIN_REQUIRED') {
        await this.prisma.zaloAccount.update({ where: { id: a.id }, data: { status: 'RELOGIN_REQUIRED', lastError: 'Phiên Zalo đã hết — cần đăng nhập lại.' } });
      }
      await this.audit(ctx, 'ZALO_ACCOUNT_RESUMED', a.id, { senderApplied: false, sender: r.kind, code }, 'FAILED');
      if (r.kind === 'REJECTED' && r.code === 'RELOGIN_REQUIRED') throw new ConflictException({ code: 'RELOGIN_REQUIRED', message: 'Tài khoản Zalo cần đăng nhập lại trước khi bật lại. Tài khoản vẫn đang tạm dừng.' });
      if (r.kind === 'REJECTED') throw new ConflictException({ code: 'ACCOUNT_UNAVAILABLE', message: 'Dịch vụ gửi tin chưa sẵn sàng cho tài khoản này. Tài khoản vẫn đang tạm dừng.' });
      throw new ServiceUnavailableException({ code: 'SENDER_UNAVAILABLE', message: 'Không xác nhận được với dịch vụ gửi tin. Tài khoản vẫn đang tạm dừng — vui lòng thử lại.' });
    });
  }

  /** Stops routing to the account immediately. Terminating the Zalo session on the sender needs contract v2. */
  async disconnect(ctx: CrmContext, id: string) {
    const a = await this.own(ctx, id);
    await this.prisma.zaloAccount.update({ where: { id: a.id }, data: { status: 'DISCONNECTED', sessionVersion: { increment: 1 }, lastError: null } });
    const senderSessionTerminated = await this.personal.control(a, 'disconnect').catch(() => false);
    await this.audit(ctx, 'ZALO_ACCOUNT_DISCONNECTED', a.id, { senderSessionTerminated });
    return { id: a.id, status: 'DISCONNECTED', senderSessionTerminated };
  }

  async loginStart(ctx: CrmContext, id: string) {
    let a = await this.own(ctx, id);
    if (a.channel === 'PERSONAL_ZALO' && !a.senderBaseUrl && senderV2Config()) {
      await this.registerWithSender(ctx, a.id);
      a = await this.own(ctx, a.id);
    }
    if (a.channel !== 'PERSONAL_ZALO' || !capabilitiesOf(a).qrLogin || !a.senderBaseUrl) {
      await this.audit(ctx, 'ZALO_ACCOUNT_LOGIN_START', a.id, { supported: false }, 'NO_CHANGE');
      throw new NotImplementedException({ code: 'SENDER_NOT_SUPPORTED', message: 'Dịch vụ gửi tin chưa hỗ trợ đăng nhập Zalo bằng mã QR cho tài khoản này.' });
    }
    try {
      const out = await this.personal.loginStart(a);
      await this.prisma.zaloAccount.update({ where: { id: a.id }, data: { status: 'CONNECTING' } });
      await this.audit(ctx, 'ZALO_ACCOUNT_LOGIN_START', a.id, { supported: true });
      return out;
    } catch (e) {
      if (e instanceof ChannelError && e.code === 'NOT_SUPPORTED') throw new NotImplementedException({ code: 'SENDER_NOT_SUPPORTED', message: 'Dịch vụ gửi tin chưa hỗ trợ đăng nhập bằng mã QR.' });
      throw new ServiceUnavailableException({ code: 'SENDER_UNAVAILABLE', message: 'Không tạo được mã QR lúc này. Vui lòng thử lại.' });
    }
  }

  async loginStatus(ctx: CrmContext, id: string, loginId: unknown) {
    const a = await this.own(ctx, id);
    if (typeof loginId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(loginId)) bad('Mã phiên đăng nhập không hợp lệ.');
    let s;
    try { s = await this.personal.loginStatus(a, loginId); } catch (e) {
      if (e instanceof ChannelError && e.code === 'NOT_SUPPORTED') throw new NotImplementedException({ code: 'SENDER_NOT_SUPPORTED', message: 'Dịch vụ gửi tin chưa hỗ trợ đăng nhập bằng mã QR.' });
      throw new ServiceUnavailableException({ code: 'SENDER_UNAVAILABLE', message: 'Không kiểm tra được trạng thái đăng nhập.' });
    }
    if (s.status === 'CONNECTED') {
      await this.prisma.zaloAccount.update({ where: { id: a.id }, data: { status: 'CONNECTED', lastConnectedAt: new Date(), sessionVersion: { increment: 1 }, lastError: null, ...(s.displayName && !a.displayName ? { displayName: s.displayName } : {}), ...(s.phoneMasked ? { phoneMasked: s.phoneMasked } : {}) } });
      await this.audit(ctx, 'ZALO_ACCOUNT_CONNECTED', a.id);
    } else if (s.status === 'EXPIRED' || s.status === 'FAILED') {
      await this.prisma.zaloAccount.update({ where: { id: a.id }, data: { status: a.lastConnectedAt ? 'RELOGIN_REQUIRED' : 'PENDING_LOGIN' } });
    }
    return { status: s.status };
  }

  async rules(ctx: CrmContext) {
    return this.prisma.zaloRoutingRule.findMany({ where: { tenantId: ctx.platformTenantId }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }], select: { id: true, zaloAccountId: true, installationId: true, branchId: true, eventType: true, priority: true, active: true } });
  }

  /** Replaces the tenant's routing rules atomically. Every account/installation must belong to the tenant. */
  async replaceRules(ctx: CrmContext, body: Record<string, unknown>) {
    const input = body.rules;
    if (!Array.isArray(input) || input.length > 200) bad('Danh sách quy tắc không hợp lệ (tối đa 200).');
    const [accounts, installs] = await Promise.all([
      this.prisma.zaloAccount.findMany({ where: { tenantId: ctx.platformTenantId, revokedAt: null }, select: { id: true } }),
      this.prisma.installation.findMany({ where: { tenantId: ctx.platformTenantId }, select: { id: true } }),
    ]);
    const acc = new Set(accounts.map((a) => a.id)); const ins = new Set(installs.map((i) => i.id));
    const rules = (input as Record<string, unknown>[]).map((r) => {
      if (!r || typeof r !== 'object') bad('Quy tắc không hợp lệ.');
      if (typeof r.zaloAccountId !== 'string' || !acc.has(r.zaloAccountId)) notFound();
      const installationId = r.installationId === undefined || r.installationId === null || r.installationId === '' ? null : String(r.installationId);
      if (installationId !== null && !ins.has(installationId)) notFound();
      const branchId = r.branchId === undefined || r.branchId === null || r.branchId === '' ? null : String(r.branchId);
      if (branchId !== null && !BRANCH.test(branchId)) bad('Mã chi nhánh không hợp lệ.');
      const eventType = r.eventType === undefined || r.eventType === null || r.eventType === '' ? null : String(r.eventType);
      if (eventType !== null && !EVENT.test(eventType)) bad('Loại sự kiện không hợp lệ.');
      const priority = r.priority === undefined ? 100 : Number(r.priority);
      if (!Number.isInteger(priority) || priority < 0 || priority > 1000) bad('Mức ưu tiên 0–1000.');
      return { tenantId: ctx.platformTenantId, zaloAccountId: r.zaloAccountId, installationId, branchId, eventType, priority, active: r.active !== false, createdBy: `crm:${ctx.platformUserId}` };
    });
    const keys = new Set(rules.map((r) => `${r.zaloAccountId}|${r.installationId}|${r.branchId}|${r.eventType}`));
    if (keys.size !== rules.length) throw new ConflictException({ code: 'DUPLICATE_RULE', message: 'Có quy tắc bị trùng.' });
    const before = await this.prisma.zaloRoutingRule.count({ where: { tenantId: ctx.platformTenantId } });
    await this.prisma.$transaction([
      this.prisma.zaloRoutingRule.deleteMany({ where: { tenantId: ctx.platformTenantId } }),
      this.prisma.zaloRoutingRule.createMany({ data: rules }),
    ]);
    await this.prisma.auditLog.create({ data: { tenantId: ctx.platformTenantId, actorType: 'CRM_USER', actorId: ctx.platformUserId, action: 'ZALO_ROUTING_RULES_REPLACED', targetType: 'ZaloRoutingRule', result: 'SUCCESS', metadata: { before, after: rules.length } } });
    return this.rules(ctx);
  }
}
