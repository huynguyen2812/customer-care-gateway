import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, PlatformDeviceRegistration } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaService } from '../../common/prisma.service';
import { canonicalJson } from '../../common/canonical';
import { Heartbeat, PLATFORM_DEVICE_API, PlatformDeviceApi, PlatformError, redeemCanonical, SignedConfig } from './platform-device.contract';
import { generateDeviceKeys, loadConfigKeys, openDeviceKey, signWithDevice, VerifiedConfig, verifyConfig } from './platform-crypto';
import { isLicensedSource, licenceWindow, LicenseGateService } from './license-gate.service';

const CODE = /^[A-Z0-9]{4}(-?[A-Z0-9]{4}){1,5}$/;
const ACTIVATION_LEASE_MS = 2 * 60_000;
const DEFINITIVE = new Set(['ACTIVATION_CODE_INVALID', 'ACTIVATION_CODE_EXPIRED', 'ACTIVATION_CODE_USED', 'ACTIVATION_WRONG_PRODUCT', 'ACTIVATION_WRONG_TENANT', 'PLAN_NOT_ACTIVE', 'DEVICE_REVOKED']);
/** Platform refused before binding this device: the pending identity is certainly not bound by this attempt. */
const NOT_BOUND = new Set(['ACTIVATION_CODE_INVALID', 'ACTIVATION_CODE_EXPIRED', 'ACTIVATION_CODE_USED', 'ACTIVATION_WRONG_PRODUCT', 'ACTIVATION_WRONG_TENANT', 'PLAN_NOT_ACTIVE', 'DEVICE_PROOF_INVALID', 'ACTIVATION_CODE_FORMAT']);
/** On a possibly-bound attempt these answers mean the same code can never finish it: confirmed recovery is needed. */
const RECOVERY_REQUIRED = new Set(['ACTIVATION_CODE_EXPIRED', 'DEVICE_REVOKED']);
export type ActivationState = 'IN_PROGRESS' | 'NOT_BOUND' | 'RETRY_SAME_CODE' | 'RECOVERY_REQUIRED';
export type PlatformResetResult = 'PLATFORM_UNPAIRED' | 'PLATFORM_ALREADY_REVOKED' | 'PLATFORM_DEVICE_UNKNOWN' | 'PLATFORM_NOT_CONFIRMED';

/** Scope of a config without its timing fields: a renewal changes only revision/issuedAt/expiresAt. */
function scopeKey(payload: unknown): string {
  const { revision, issuedAt, expiresAt, ...rest } = payload as Record<string, unknown>;
  void revision; void issuedAt; void expiresAt;
  return canonicalJson(rest); // key order independent (jsonb reorders keys)
}

/**
 * "Maybe bound on Platform": the flag, OR an outstanding pendingRequestId (the request may have left this machine). A row
 * with an outstanding request is never treated as unbound — including rows written by older builds that set the flag
 * only after a failure (a crash before that write left false).
 */
function maybeBound(reg: PlatformDeviceRegistration): boolean {
  return reg.activationMaybeBound || !!reg.pendingRequestId;
}

function activationState(reg: PlatformDeviceRegistration): ActivationState {
  if (reg.activationLockedUntil && reg.activationLockedUntil > new Date()) return 'IN_PROGRESS';
  if (!maybeBound(reg)) return 'NOT_BOUND';
  return RECOVERY_REQUIRED.has(reg.activationError ?? '') ? 'RECOVERY_REQUIRED' : 'RETRY_SAME_CODE';
}

export function buildInfo(): { version: string; crmCommit: string | null; senderCommit: string | null; builtAt: string | null; dirty: boolean | null } {
  try {
    const b = JSON.parse(readFileSync(process.env.VC_BUILD_INFO_FILE || '', 'utf8'));
    return { version: String(b.version), crmCommit: b.crmCommit ?? null, senderCommit: b.senderCommit ?? null, builtAt: b.builtAt ?? null, dirty: typeof b.crmSourceDirty === 'boolean' ? b.crmSourceDirty || !!b.senderSourceDirty : null };
  } catch {
    return { version: process.env.npm_package_version || 'dev', crmCommit: null, senderCommit: null, builtAt: null, dirty: null };
  }
}

/**
 * Platform Device Agent: pairing with a one-time activation code, signed desired configuration, heartbeat.
 * The PC always calls out over HTTPS; Platform never calls into the PC/LAN. Nothing here touches the local source API
 * credential (ApiCredential), Zalo sessions, recovery key or customer data.
 */
@Injectable()
export class PlatformDeviceService {
  private readonly log = new Logger('PlatformDevice');
  constructor(private readonly prisma: PrismaService, private readonly gate: LicenseGateService, @Inject(PLATFORM_DEVICE_API) private readonly api: PlatformDeviceApi) {}

  private keys() { const k = loadConfigKeys(); if (!k.size) throw new ServiceUnavailableException({ code: 'PLATFORM_NOT_CONFIGURED', message: 'Bản cài này chưa có cấu hình Platform.' }); return k; }
  private audit(action: string, result: string, metadata: Record<string, unknown> = {}, actorId = 'system', tenantId?: string) {
    return this.auditIn(this.prisma, action, result, metadata, actorId, tenantId);
  }
  private auditIn(db: Prisma.TransactionClient, action: string, result: string, metadata: Record<string, unknown> = {}, actorId = 'system', tenantId?: string) {
    return db.auditLog.create({ data: { tenantId: tenantId ?? null, actorType: actorId === 'system' ? 'SYSTEM' : 'CRM_USER', actorId, action, targetType: 'PlatformDevice', result, metadata: metadata as Prisma.InputJsonValue } });
  }

  async status() {
    const d = await this.gate.evaluate();
    const reg = d.registration; const active = reg?.status === 'ACTIVE';
    // Only an ACTIVE device shows a licence/sending window; after unpair/revoke/reset the old config is history, not a permit.
    const c = active ? d.config : null; const w = active ? d.window : null;
    const now = Date.now();
    return {
      mode: d.mode, allowed: d.deny === null, reason: d.deny,
      // Test-only override (never in a release): the UI shows a red warning whenever it is on.
      licenseBypass: d.mode === 'BYPASS',
      device: reg ? {
        deviceIdMasked: `${reg.deviceId.slice(0, 4)}…${reg.deviceId.slice(-4)}`, status: reg.status, pairedAt: reg.pairedAt, lastValidatedAt: reg.lastValidatedAt, lastSyncAt: reg.lastSyncAt,
        lastSyncError: reg.lastSyncError,
        // Sending window of the latest verified signed config: earlier of signed expiresAt and signed plan end.
        licensedUntil: w?.until ?? null, configExpiresAt: w?.configExpiresAt ?? null, offlineGraceUntil: w?.until ?? null,
        offlineRemainingHours: w ? Math.max(0, Math.round((w.until.getTime() - now) / 36e5 * 10) / 10) : null,
        configRevision: reg.lastConfigRevision,
      } : null,
      // Unfinished activation (PENDING): what the owner can do next. Never "activated" until a verified config is stored.
      activation: reg?.status === 'PENDING' ? { state: activationState(reg), lastError: reg.activationError } : null,
      license: c ? { businessName: c.tenant.name, planCode: c.plan.code, planStatus: c.plan.status, validUntil: c.plan.validUntil, sources: c.sources, features: c.features, dailyQuota: c.limits.dailyQuota, reminderLeadMinutes: c.reminderLeadMinutes, quietHours: c.quietHours } : null,
      platformConfigured: loadConfigKeys().size > 0 && !!process.env.PLATFORM_DEVICE_API_URL,
    };
  }

  /** HMAC (machine key) of the activation code: recognises a retry of the SAME code without storing the code. */
  private codeHash(code: string): string {
    return createHmac('sha256', Buffer.from(process.env.DEVICE_KEY_ENC_KEY || '', 'hex')).update(`vccrm-activation-code\n${code}`).digest('hex');
  }

  /**
   * Takes the short activation lease on the singleton registration (one activation at a time) and — BEFORE anything is
   * sent to Platform — durably records the binding of this attempt: deviceId/key, pendingRequestId, pendingCodeHash and
   * activationMaybeBound = true. A crash (kill, power loss) at any later point therefore leaves a row that only accepts a
   * retry of the SAME code (same requestId/deviceId/key); a different code is refused before any Platform call.
   * The flag is lowered again only on proof that this requestId was never bound (see activate()).
   * Returns the lease token: every later write of this attempt is conditional on it, so a late answer of an attempt whose
   * lease was taken over (retry, recovery) can never overwrite the newer state.
   */
  private async claim(codeHash: string): Promise<{ reg: PlatformDeviceRegistration; lease: Date; firstSend: boolean }> {
    const now = new Date(); const lease = new Date(now.getTime() + ACTIVATION_LEASE_MS);
    const existing = await this.prisma.platformDeviceRegistration.findUnique({ where: { id: 1 } });
    if (existing?.status === 'ACTIVE') throw new ConflictException({ code: 'ALREADY_PAIRED', message: 'Máy này đã được ghép với Platform.' });
    if (!existing) {
      const keys = generateDeviceKeys();
      try {
        const reg = await this.prisma.platformDeviceRegistration.create({ data: { id: 1, deviceId: randomUUID(), devicePublicKey: keys.publicKeyPem, devicePrivateKeyEnc: keys.privateKeyEnc, status: 'PENDING', pendingRequestId: randomUUID(), pendingCodeHash: codeHash, activationMaybeBound: true, activationLockedUntil: lease } });
        return { reg, lease, firstSend: true };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'ACTIVATION_IN_PROGRESS', message: 'Đang kích hoạt, vui lòng đợi.' });
        throw e;
      }
    }
    // A revoked/unpaired identity is never reused. A key that no longer opens on this machine (restored backup) gets a
    // fresh identity too. A PENDING identity (failed, unanswered or interrupted attempt) is kept so Platform can answer idempotently.
    let fresh = existing.status === 'REVOKED' || existing.status === 'UNPAIRED';
    try { openDeviceKey(existing.devicePrivateKeyEnc); } catch { fresh = true; }
    const sameRequest = !fresh && existing.status === 'PENDING' && !!existing.pendingRequestId && existing.pendingCodeHash === codeHash;
    if (existing.activationLockedUntil && existing.activationLockedUntil > now) throw new ConflictException({ code: 'ACTIVATION_IN_PROGRESS', message: 'Đang có thao tác kích hoạt/phục hồi khác, vui lòng đợi.' });
    // A pending attempt that may already be bound on Platform is finished ONLY with the same code until that code expires;
    // after that (or if Platform revoked it) the owner must run the confirmed recovery. Nothing here resets the binding,
    // rotates the key or creates a new device on its own. An outstanding pendingRequestId counts as "maybe bound" even if
    // the flag says otherwise (rows left by older builds, or a crash between claim and the first send).
    if (!fresh && existing.status === 'PENDING' && maybeBound(existing)) {
      if (!sameRequest) throw new ConflictException({ code: 'ACTIVATION_RETRY_SAME_CODE', message: 'Máy đang chờ hoàn tất kích hoạt bằng mã trước. Nhập lại đúng mã đó; nếu mã đã hết hạn, dùng mục Phục hồi kích hoạt.' });
      if (RECOVERY_REQUIRED.has(existing.activationError ?? '')) throw new ConflictException({ code: 'ACTIVATION_RECOVERY_REQUIRED', message: 'Mã kích hoạt cũ không dùng được nữa. Cần phục hồi kích hoạt rồi nhập mã mới.' });
    }
    const keys = fresh ? generateDeviceKeys() : null;
    const r = await this.prisma.platformDeviceRegistration.updateMany({
      where: { id: 1, status: { not: 'ACTIVE' }, deviceId: existing.deviceId, OR: [{ activationLockedUntil: null }, { activationLockedUntil: { lt: now } }] },
      data: {
        activationLockedUntil: lease, pendingCodeHash: codeHash, pendingRequestId: sameRequest ? existing.pendingRequestId : randomUUID(),
        activationMaybeBound: true, // persisted before the request can leave this machine
        ...(sameRequest ? {} : { activationError: null }),
        ...(keys ? { deviceId: randomUUID(), devicePublicKey: keys.publicKeyPem, devicePrivateKeyEnc: keys.privateKeyEnc, status: 'PENDING', pairedAt: null, revokedAt: null, lastConfigRevision: 0, lastValidatedAt: null, offlineGraceUntil: null, entitlementValidUntil: null } : {}),
      },
    });
    if (!r.count) throw new ConflictException({ code: 'ACTIVATION_IN_PROGRESS', message: 'Đang kích hoạt, vui lòng đợi.' });
    return { reg: await this.prisma.platformDeviceRegistration.findUniqueOrThrow({ where: { id: 1 } }), lease, firstSend: !sameRequest };
  }

  /**
   * One-time activation. The network call to Platform happens outside any DB transaction; everything after it is ONE
   * transaction: verify the answer, store the signed config, apply quota/quiet hours/plan/source scope, mark the device
   * ACTIVE, clear the pending request and record the revision. Any failure rolls all of it back: the device stays
   * PENDING (same deviceId/requestId for an idempotent retry of the same code) and the owner can simply try again.
   */
  async activate(codeRaw: unknown, actorId: string, tenantId: string) {
    const code = typeof codeRaw === 'string' ? codeRaw.trim().toUpperCase().replace(/\s+/g, '') : '';
    if (!CODE.test(code)) throw new BadRequestException({ code: 'ACTIVATION_CODE_FORMAT', message: 'Mã kích hoạt không đúng định dạng.' });
    const keys = this.keys();
    // Installs upgraded from 0.2.x by the old auto-updater do not have the machine key yet (the .exe installer adds it).
    if (Buffer.from(process.env.DEVICE_KEY_ENC_KEY || '', 'hex').length !== 32) throw new ServiceUnavailableException({ code: 'DEVICE_KEY_UNAVAILABLE', message: 'Cần chạy bộ cài phiên bản mới để bật kết nối Platform.' });
    const { reg, lease, firstSend } = await this.claim(this.codeHash(code));
    // Every later write of this attempt must still own the lease (same requestId AND same lease token).
    const ours = { id: 1, status: 'PENDING', deviceId: reg.deviceId, pendingRequestId: reg.pendingRequestId, activationLockedUntil: lease };
    try {
      const priv = openDeviceKey(reg.devicePrivateKeyEnc);
      const base = { activationCode: code, requestId: reg.pendingRequestId!, deviceId: reg.deviceId, devicePublicKey: reg.devicePublicKey, appVersion: buildInfo().version };
      const res = await this.api.redeem({ ...base, proof: signWithDevice(priv, redeemCanonical(base)) });
      await this.prisma.$transaction(async (tx) => {
        if (res?.deviceId !== reg.deviceId) throw new PlatformError('PLATFORM_RESPONSE_INVALID');
        const verified = verifyConfig(res.config, reg.deviceId, keys);
        const now = new Date();
        // Still our attempt (lease not taken over by a retry/recovery): only then does the device become ACTIVE.
        const mine = await tx.platformDeviceRegistration.updateMany({ where: ours, data: {
          status: 'ACTIVE', everPaired: true, pendingRequestId: null, pendingCodeHash: null, activationLockedUntil: null, activationError: null, activationMaybeBound: false,
          platformInstallationId: String(res.platformInstallationId).slice(0, 100), pairedAt: now, lastSyncAt: now, lastSyncError: null,
        } });
        if (!mine.count) throw new ConflictException({ code: 'ACTIVATION_IN_PROGRESS', message: 'Đang có thao tác kích hoạt/phục hồi khác, vui lòng đợi.' });
        const applied = await this.applyConfigTx(tx, verified, tenantId);
        if (applied !== 'APPLIED') throw new PlatformError('CONFIG_REVISION_CONFLICT');
        await this.auditIn(tx, 'PLATFORM_DEVICE_PAIRED', 'SUCCESS', { deviceId: reg.deviceId, revision: verified.payload.revision }, actorId, tenantId);
      });
      return this.status();
    } catch (e) {
      const code = e instanceof PlatformError ? e.code : e instanceof ConflictException ? 'ACTIVATION_IN_PROGRESS' : e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'ACTIVATION_FAILED';
      // Only proof that THIS requestId was never bound lowers "maybe bound": a clear refusal of Platform to the FIRST send
      // of this requestId (no earlier send could have bound it). A refusal to a retry proves nothing about the earlier
      // send (e.g. an expired code may belong to a device already created), so the binding is kept. No answer, 5xx,
      // an answer we could not apply, a local DB error: binding kept.
      const provenUnbound = firstSend && e instanceof PlatformError && e.status >= 400 && e.status < 500 && NOT_BOUND.has(code);
      if (!(e instanceof ConflictException)) {
        await this.prisma.platformDeviceRegistration.updateMany({ where: ours, data: {
          activationLockedUntil: null, activationError: code.slice(0, 80),
          ...(provenUnbound ? { activationMaybeBound: false, pendingRequestId: null, pendingCodeHash: null } : {}),
        } }).catch(() => undefined); // a failed write leaves the (safe) maybe-bound row; the lease simply expires
      }
      await this.audit('PLATFORM_DEVICE_PAIR_FAILED', 'FAILED', { code, provenUnbound }, actorId, tenantId).catch(() => undefined);
      if (e instanceof ConflictException) throw e;
      if (DEFINITIVE.has(code)) throw new ForbiddenException({ code, message: 'Platform từ chối mã kích hoạt.' });
      throw new ServiceUnavailableException({ code, message: 'Chưa kích hoạt được. Máy vẫn chưa kích hoạt; có thể nhập lại đúng mã này để thử lại.' });
    }
  }

  /** Sync path: applies one verified config in its own transaction. */
  async applyConfig(v: VerifiedConfig, tenantId?: string): Promise<'APPLIED' | 'DUPLICATE'> {
    try {
      return await this.prisma.$transaction((tx) => this.applyConfigTx(tx, v, tenantId));
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return 'DUPLICATE';
      throw e;
    }
  }

  /**
   * Stores and applies a verified config INSIDE the caller's transaction (never opens its own). Revision must strictly
   * increase; the same revision with the same bytes is an idempotent no-op (lost ACK / resend); a lower revision or a
   * different document with the same revision is rejected. Branch scope is applied per source entry.
   */
  async applyConfigTx(tx: Prisma.TransactionClient, v: VerifiedConfig, tenantId?: string): Promise<'APPLIED' | 'DUPLICATE'> {
    const p = v.payload;
    const reg = await tx.platformDeviceRegistration.findUniqueOrThrow({ where: { id: 1 } });
    if (reg.deviceId !== p.deviceId) throw new PlatformError('CONFIG_WRONG_DEVICE');
    const same = await tx.platformDesiredConfiguration.findUnique({ where: { deviceId_revision: { deviceId: reg.deviceId, revision: p.revision } } });
    if (same) { if (same.payloadHash === v.payloadHash) return 'DUPLICATE'; throw new PlatformError('CONFIG_REVISION_CONFLICT'); }
    if (p.revision <= reg.lastConfigRevision) throw new PlatformError('CONFIG_REVISION_STALE');
    const localTenant = tenantId ?? (await tx.standaloneInstance.findUnique({ where: { id: 1 } }))?.tenantId;
    const now = new Date();
    const previous = await tx.platformDesiredConfiguration.findFirst({ where: { deviceId: reg.deviceId, applyStatus: 'APPLIED' }, orderBy: { revision: 'desc' } });
    const created = await tx.platformDesiredConfiguration.create({ data: { deviceId: reg.deviceId, revision: p.revision, payload: p as unknown as Prisma.InputJsonValue, payloadHash: v.payloadHash, signature: v.signed.signature.slice(0, 200), keyId: v.signed.keyId.slice(0, 80), expiresAt: v.expiresAt, applyStatus: 'APPLIED', appliedAt: now } });
    // Only a NEW verified revision renews the licence (lastValidatedAt + signed window). Replays returned DUPLICATE above.
    const window = licenceWindow(created);
    const upd = await tx.platformDeviceRegistration.updateMany({ where: { id: 1, deviceId: reg.deviceId, lastConfigRevision: { lt: p.revision } }, data: {
      lastConfigRevision: p.revision, platformTenantId: p.tenant.id.slice(0, 100), businessName: p.tenant.name.slice(0, 200),
      entitlementValidUntil: p.plan.validUntil ? new Date(p.plan.validUntil) : null, lastValidatedAt: now, offlineGraceUntil: window.until,
      ...(p.deviceStatus === 'REVOKED' ? { status: 'REVOKED', revokedAt: now } : {}),
    } });
    if (!upd.count) throw new PlatformError('CONFIG_REVISION_STALE');
    if (localTenant) {
      // Enforce the signed scope locally: quota, quiet hours, lead time; branches/features can only shrink.
      await tx.installation.updateMany({ where: { tenantId: localTenant, sourceProduct: 'EXTERNAL_CONNECTOR' }, data: { dailyQuota: p.limits.dailyQuota, quietHoursStart: p.quietHours.start, quietHoursEnd: p.quietHours.end, timezone: p.quietHours.timezone || 'Asia/Ho_Chi_Minh' } });
      const tenant = await tx.crmTenant.findUnique({ where: { platformTenantId: localTenant } });
      await tx.crmTenant.update({ where: { platformTenantId: localTenant }, data: { planCode: p.plan.code.slice(0, 64), limits: { dailyQuotaMax: p.limits.dailyQuota }, tenantDailyQuota: tenant?.tenantDailyQuota != null ? Math.min(tenant.tenantDailyQuota, p.limits.dailyQuota) : null } });
      for (const conn of await tx.sourceConnection.findMany({ where: { installation: { tenantId: localTenant } } })) {
        // Intersect with the entry of THIS connector's source only (never a union of all sources). A connector whose
        // kind is not chosen yet keeps its list: nothing can be created or sent for it until the kind is set.
        const kind = isLicensedSource(conn.sourceKind) ? conn.sourceKind : null;
        const entry = kind ? p.sources.find((s) => s.product === kind) : undefined;
        await tx.sourceConnection.update({ where: { id: conn.id }, data: {
          allowedBranchIds: kind ? conn.allowedBranchIds.filter((b) => !!entry?.allowedBranchIds.includes(b)) : conn.allowedBranchIds,
          reminderLeadMinutes: p.reminderLeadMinutes,
          appointmentsEnabled: conn.appointmentsEnabled && p.features.appointmentReminder, receivablesEnabled: conn.receivablesEnabled && p.features.debtReminder,
        } });
      }
    }
    // Periodic renewals (same scope, new revision/issuedAt/expiresAt) are not audited one by one; keep the last 200 revisions.
    if (!previous || scopeKey(previous.payload) !== scopeKey(p)) {
      await this.auditIn(tx, 'PLATFORM_CONFIG_APPLIED', 'SUCCESS', { revision: p.revision, planStatus: p.plan.status, deviceStatus: p.deviceStatus, sources: p.sources.map((s) => ({ product: s.product, branches: s.allowedBranchIds.length })) }, 'system', localTenant);
    }
    await tx.platformDesiredConfiguration.deleteMany({ where: { deviceId: reg.deviceId, revision: { lte: p.revision - 200 } } });
    return 'APPLIED';
  }

  /**
   * Periodic (worker) or on-demand check: heartbeat + pick up a new signed revision. Only a NEW verified revision renews
   * the licence (inside applyConfigTx). A plain HTTP 200 / heartbeat ACK, a replay of the same revision, or a rejected
   * config changes nothing but lastSyncAt/lastSyncError. Offline ⇒ the last signed config is used only up to its own
   * expiresAt/plan end. Revocation is recorded only for an answer of the configured Platform endpoint that says so
   * exactly (HTTP 403 {code: DEVICE_REVOKED}, or deviceStatus REVOKED / a signed REVOKED config); a network error, another
   * 403 or 401 DEVICE_UNKNOWN is just a sync error.
   */
  async sync(reason: 'SCHEDULE' | 'MANUAL' = 'SCHEDULE') {
    const reg = await this.prisma.platformDeviceRegistration.findUnique({ where: { id: 1 } });
    if (!reg || reg.status !== 'ACTIVE') return { skipped: true as const, status: reg?.status ?? 'NONE' };
    let priv: string;
    try { priv = openDeviceKey(reg.devicePrivateKeyEnc); }
    catch { await this.prisma.platformDeviceRegistration.update({ where: { id: 1 }, data: { lastSyncError: 'DEVICE_REPAIR_REQUIRED', lastSyncAt: new Date() } }); return { skipped: false as const, ok: false, code: 'DEVICE_REPAIR_REQUIRED' }; }
    const keys = this.keys();
    const now = new Date();
    try {
      const res = await this.api.sync(reg.deviceId, priv, { currentRevision: reg.lastConfigRevision, heartbeat: await this.buildHeartbeat(reg.deviceId) });
      let applied: string | null = null;
      if (res?.config) {
        try { applied = await this.applyConfig(verifyConfig(res.config as SignedConfig, reg.deviceId, keys, now)); }
        catch (e) {
          const code = e instanceof Error ? e.message : 'CONFIG_REJECTED';
          await this.audit('PLATFORM_CONFIG_REJECTED', 'FAILED', { code: /^[A-Z_]+$/.test(code) ? code : 'CONFIG_REJECTED' });
          applied = 'REJECTED';
        }
      }
      const revoked = res?.deviceStatus === 'REVOKED';
      await this.prisma.platformDeviceRegistration.update({ where: { id: 1 }, data: {
        lastSyncAt: now, lastSyncError: applied === 'REJECTED' ? 'CONFIG_REJECTED' : null,
        ...(revoked ? { status: 'REVOKED', revokedAt: now } : {}),
      } });
      if (revoked) await this.audit('PLATFORM_DEVICE_REVOKED', 'SUCCESS', { reason });
      return { skipped: false as const, ok: applied !== 'REJECTED', applied };
    } catch (e) {
      const code = e instanceof PlatformError ? e.code : 'PLATFORM_UNREACHABLE';
      const revoked = e instanceof PlatformError && e.status === 403 && e.code === 'DEVICE_REVOKED';
      await this.prisma.platformDeviceRegistration.update({ where: { id: 1 }, data: { lastSyncAt: now, lastSyncError: code.slice(0, 80), ...(revoked ? { status: 'REVOKED', revokedAt: now } : {}) } });
      if (revoked) await this.audit('PLATFORM_DEVICE_REVOKED', 'SUCCESS', { reason: code });
      else this.log.warn(`Platform sync failed: ${code}`);
      return { skipped: false as const, ok: false, code };
    }
  }

  /**
   * Confirmed recovery / unpair (ACTIVE or PENDING). Two different things, reported separately:
   *  A. local: this PC drops its pairing (status UNPAIRED; the next activation uses a NEW deviceId/key). Always done here.
   *  B. Platform: the device record on Platform. Only the signed unpair call can tell; the result is reported as Platform
   *     answered it (unpaired / already revoked / no such device) or PLATFORM_NOT_CONFIRMED (no answer, other error) — A
   *     succeeding never implies B. Revoking a device record on Platform is a Platform admin action.
   * Holds the activation lease, so it never runs concurrently with an activation attempt. Deletes nothing: customers,
   * sources, history, templates and the local API Client ID/Secret stay; sending stays stopped until a new activation.
   */
  async unpair(actorId: string, tenantId: string) {
    const reg = await this.prisma.platformDeviceRegistration.findUnique({ where: { id: 1 } });
    if (!reg || reg.status === 'UNPAIRED') return { ...(await this.status()), reset: null };
    const now = new Date();
    const leaseToken = new Date(now.getTime() + ACTIVATION_LEASE_MS);
    const lease = await this.prisma.platformDeviceRegistration.updateMany({
      where: { id: 1, deviceId: reg.deviceId, status: { not: 'UNPAIRED' }, OR: [{ activationLockedUntil: null }, { activationLockedUntil: { lt: now } }] },
      data: { activationLockedUntil: leaseToken },
    });
    if (!lease.count) throw new ConflictException({ code: 'ACTIVATION_IN_PROGRESS', message: 'Đang có thao tác kích hoạt/phục hồi khác, vui lòng đợi.' });
    let platform: PlatformResetResult = 'PLATFORM_NOT_CONFIRMED';
    try {
      await this.api.unpair(reg.deviceId, openDeviceKey(reg.devicePrivateKeyEnc));
      platform = 'PLATFORM_UNPAIRED';
    } catch (e) {
      if (e instanceof PlatformError && e.status === 403 && e.code === 'DEVICE_REVOKED') platform = 'PLATFORM_ALREADY_REVOKED';
      else if (e instanceof PlatformError && e.status === 401 && e.code === 'DEVICE_UNKNOWN') platform = 'PLATFORM_DEVICE_UNKNOWN';
    }
    // Only while this reset still owns its lease (a slow Platform call must not overwrite a newer attempt).
    const done = await this.prisma.platformDeviceRegistration.updateMany({ where: { id: 1, deviceId: reg.deviceId, activationLockedUntil: leaseToken }, data: {
      status: 'UNPAIRED', pendingRequestId: null, pendingCodeHash: null, activationLockedUntil: null, activationError: null, activationMaybeBound: false, offlineGraceUntil: null,
    } });
    if (!done.count) throw new ConflictException({ code: 'ACTIVATION_IN_PROGRESS', message: 'Đang có thao tác kích hoạt/phục hồi khác, vui lòng thử lại.' });
    await this.audit('PLATFORM_DEVICE_UNPAIRED', 'SUCCESS', { fromStatus: reg.status, platformResult: platform }, actorId, tenantId);
    return { ...(await this.status()), reset: { local: 'UNPAIRED' as const, platform } };
  }

  /** Aggregate, redacted health only (no names, phones, content, appointments, debts, sessions, keys). */
  async buildHeartbeat(deviceId: string): Promise<Heartbeat> {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [queued, processing, sent24h, failed24h, uncertain, conn, codes] = await Promise.all([
      this.prisma.careJob.count({ where: { status: 'QUEUED' } }),
      this.prisma.careJob.count({ where: { status: 'PROCESSING' } }),
      this.prisma.careJob.count({ where: { status: 'SENT', sentAt: { gte: since } } }),
      this.prisma.careJob.count({ where: { status: { in: ['FAILED', 'ACCOUNT_RESTRICTED', 'RECIPIENT_NOT_FOUND'] }, updatedAt: { gte: since } } }),
      this.prisma.careJob.count({ where: { failureCode: 'DELIVERY_UNCERTAIN' } }),
      this.prisma.sourceConnection.findFirst({ select: { lastSyncAt: true, lastSyncStatus: true } }),
      this.prisma.careJob.findMany({ where: { updatedAt: { gte: since }, failureCode: { not: null } }, distinct: ['failureCode'], select: { failureCode: true }, take: 50 }),
    ]);
    const probe = async (url: string | null) => { if (!url) return 'UNKNOWN' as const; try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); return r.ok ? 'UP' as const : 'DOWN' as const; } catch { return 'DOWN' as const; } };
    const port = process.env.PORT || '47100';
    const sender = process.env.SENDER_V2_BASE_URL ? `${process.env.SENDER_V2_BASE_URL.replace(/\/$/, '')}/health` : null;
    const b = buildInfo();
    const src = conn?.lastSyncStatus;
    return {
      deviceId, appVersion: b.version, buildCommit: b.crmCommit,
      services: { api: (await probe(`http://127.0.0.1:${port}/api/v1/health`)) === 'UP' ? 'UP' : 'DOWN', worker: 'UP', sender: await probe(sender), source: !conn ? 'NOT_CONFIGURED' : src === 'SUCCESS' ? 'OK' : src === 'FAILED' ? 'FAILED' : src === 'DRY_RUN' ? 'DRY_RUN' : 'UNKNOWN' },
      lastSourceSyncAt: conn?.lastSyncAt?.toISOString() ?? null,
      queue: { queued, processing, sent24h, failed24h, deliveryUncertain: uncertain },
      errorCodes: codes.map((c) => String(c.failureCode)).filter((c) => /^[A-Z][A-Z0-9_]{2,60}$/.test(c)).slice(0, 20),
    };
  }
}
