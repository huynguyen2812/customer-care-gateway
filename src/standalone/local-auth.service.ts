import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { CrmTenant, LocalUser, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { CrmRole, CRM_ROLES } from '../crm/crm.constants';
import { CrmSessionService } from '../crm/crm-session.service';
import { LocalCredentialsService } from './local-credentials.service';
import { dummyHash, hashLocalPassword, passwordPolicyError, verifyLocalPassword } from './local-password';
import { APPOINTMENT_TEMPLATE, DEBT_TEMPLATE } from './source-connector.service';

const USERNAME = /^[a-z0-9._-]{3,80}$/;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60_000;
const IP_WINDOW_MS = 15 * 60_000;
const IP_MAX_FAILED = 20;

const DEFAULT_TEMPLATES = [
  { code: APPOINTMENT_TEMPLATE, body: 'Chào {{customerName}}, phòng khám nhắc lịch hẹn cho bé {{petName}} ({{serviceName}}) lúc {{appointmentTime}}. Nếu cần đổi lịch, anh/chị vui lòng nhắn lại để được hỗ trợ.', allowedVariables: ['customerName', 'petName', 'serviceName', 'appointmentTime'] },
  { code: DEBT_TEMPLATE, body: 'Chào {{customerName}}, chứng từ {{documentCode}} còn {{remainingAmount}} đ cần thanh toán (hạn {{dueAt}}). Nếu đã thanh toán, anh/chị vui lòng bỏ qua tin này.', allowedVariables: ['customerName', 'documentCode', 'remainingAmount', 'dueAt'] },
];

function bad(code: string, message: string): never { throw new BadRequestException({ code, message }); }
export function normalizeUsername(v: unknown): string { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }

/**
 * Local accounts for the standalone PC edition. One business per PC (StandaloneInstance singleton);
 * the first-run setup creates the business, its owner, the EXTERNAL_CONNECTOR installation and its
 * self-issued API credential in one transaction. Sessions reuse CrmSession (HttpOnly cookie + CSRF).
 */
@Injectable()
export class LocalAuthService {
  private readonly ipFailures = new Map<string, { count: number; since: number }>();
  constructor(private readonly prisma: PrismaService, private readonly sessions: CrmSessionService, private readonly credentials: LocalCredentialsService) {}

  async status() {
    const inst = await this.prisma.standaloneInstance.findUnique({ where: { id: 1 } });
    if (!inst) return { mode: 'standalone', setupRequired: true, businessName: null };
    const tenant = await this.prisma.crmTenant.findUnique({ where: { platformTenantId: inst.tenantId } });
    return { mode: 'standalone', setupRequired: false, businessName: tenant?.displayName ?? null };
  }

  async setup(input: Record<string, unknown>) {
    const businessName = typeof input.businessName === 'string' ? input.businessName.trim() : '';
    const username = normalizeUsername(input.username);
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim().slice(0, 200) : '';
    if (!businessName || businessName.length > 200) bad('BUSINESS_NAME_INVALID', 'Tên doanh nghiệp không hợp lệ.');
    if (!USERNAME.test(username)) bad('USERNAME_INVALID', 'Tên đăng nhập 3–80 ký tự: chữ thường, số, dấu chấm, gạch.');
    const policy = passwordPolicyError(input.password, username);
    if (policy) bad(policy, 'Mật khẩu cần 10–200 ký tự, không chỉ gồm số và không chứa tên đăng nhập.');
    if (await this.prisma.standaloneInstance.findUnique({ where: { id: 1 } })) throw new ConflictException({ code: 'ALREADY_SET_UP', message: 'Máy này đã được thiết lập doanh nghiệp.' });
    const passwordHash = await hashLocalPassword(String(input.password));
    const tenantId = randomUUID();
    try {
      return await this.prisma.$transaction(async (tx) => {
        // The singleton row (id = 1, CHECK constraint) is inserted first: a concurrent second setup fails here.
        await tx.standaloneInstance.create({ data: { id: 1, tenantId } });
        const tenant = await tx.crmTenant.create({ data: {
          platformTenantId: tenantId, displayName: businessName, installationStatus: 'ACTIVE', entitlementStatus: 'ACTIVE', planCode: 'STANDALONE_PC', entitlementUpdatedAt: new Date(),
        } });
        const user = await tx.localUser.create({ data: { tenantId, username, displayName: displayName || null, passwordHash, role: 'CRM_OWNER', createdBy: 'SETUP', lastLoginAt: new Date() } });
        const installation = await tx.installation.create({ data: { tenantId, sourceProduct: 'EXTERNAL_CONNECTOR', status: 'ACTIVE', scopes: ['care:job:create', 'care:job:read', 'care:job:cancel'], dailyQuota: 30 } });
        for (const t of DEFAULT_TEMPLATES) await tx.messageTemplate.create({ data: { installationId: installation.id, ...t } });
        const credential = await this.credentials.issue(installation.id, tx);
        await tx.auditLog.create({ data: { tenantId, installationId: installation.id, actorType: 'CRM_USER', actorId: user.id, action: 'STANDALONE_SETUP_COMPLETED', targetType: 'CrmTenant', targetId: tenantId, result: 'SUCCESS', metadata: { clientId: credential.clientId } } });
        return { tenant, user, installationId: installation.id, credential };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'ALREADY_SET_UP', message: 'Máy này đã được thiết lập doanh nghiệp.' });
      throw error;
    }
  }

  /** Same error for unknown user, wrong password, locked or disabled account (no enumeration). */
  async login(usernameRaw: unknown, password: unknown, ip: string): Promise<{ user: LocalUser; tenant: CrmTenant }> {
    const deny = () => new UnauthorizedException({ code: 'LOGIN_FAILED', message: 'Tên đăng nhập hoặc mật khẩu không đúng, hoặc tài khoản đang bị khóa tạm.' });
    const ipRec = this.ipFailures.get(ip);
    if (ipRec && Date.now() - ipRec.since < IP_WINDOW_MS && ipRec.count >= IP_MAX_FAILED) throw new UnauthorizedException({ code: 'LOGIN_THROTTLED', message: 'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.' });
    const username = normalizeUsername(usernameRaw);
    const pw = typeof password === 'string' && password.length <= 200 ? password : '';
    const user = USERNAME.test(username) ? await this.prisma.localUser.findUnique({ where: { username } }) : null;
    const ok = await verifyLocalPassword(pw, user?.passwordHash || await dummyHash());
    const inst = await this.prisma.standaloneInstance.findUnique({ where: { id: 1 } });
    const usable = !!user && ok && user.active && (!user.lockedUntil || user.lockedUntil <= new Date()) && inst?.tenantId === user.tenantId;
    if (!usable) {
      this.noteIpFailure(ip);
      if (user && !ok) {
        const failed = user.failedLogins + 1;
        await this.prisma.localUser.update({ where: { id: user.id }, data: failed >= MAX_FAILED ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } : { failedLogins: failed } });
        await this.prisma.auditLog.create({ data: { tenantId: user.tenantId, actorType: 'CRM_USER', actorId: user.id, action: 'LOCAL_LOGIN_FAILED', targetType: 'LocalUser', targetId: user.id, result: 'FAILED', metadata: { locked: failed >= MAX_FAILED } } });
      }
      throw deny();
    }
    this.ipFailures.delete(ip);
    await this.prisma.localUser.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    const tenant = await this.prisma.crmTenant.findUniqueOrThrow({ where: { platformTenantId: user.tenantId } });
    return { user, tenant };
  }

  private noteIpFailure(ip: string) {
    if (this.ipFailures.size > 10_000) this.ipFailures.clear();
    const rec = this.ipFailures.get(ip);
    if (!rec || Date.now() - rec.since >= IP_WINDOW_MS) this.ipFailures.set(ip, { count: 1, since: Date.now() });
    else rec.count++;
  }

  async startSession(user: LocalUser, tenant: CrmTenant, userAgent: string) {
    const session = await this.sessions.create({ tenant, platformUserId: user.id, roles: [user.role as CrmRole], displayName: user.displayName, username: user.username, userAgent });
    await this.prisma.auditLog.create({ data: { tenantId: tenant.platformTenantId, actorType: 'CRM_USER', actorId: user.id, action: 'CRM_LOGIN', targetType: 'CrmSession', result: 'SUCCESS', metadata: { roles: [user.role], local: true } } });
    return session;
  }

  async changePassword(tenantId: string, userId: string, current: unknown, next: unknown) {
    const user = await this.prisma.localUser.findFirst({ where: { id: userId, tenantId, active: true } });
    if (!user || typeof current !== 'string' || !(await verifyLocalPassword(current, user.passwordHash))) throw new ForbiddenException({ code: 'CURRENT_PASSWORD_WRONG', message: 'Mật khẩu hiện tại không đúng.' });
    const policy = passwordPolicyError(next, user.username);
    if (policy) bad(policy, 'Mật khẩu cần 10–200 ký tự, không chỉ gồm số và không chứa tên đăng nhập.');
    await this.prisma.localUser.update({ where: { id: user.id }, data: { passwordHash: await hashLocalPassword(String(next)), passwordChangedAt: new Date() } });
    await this.sessions.revokeTenant(tenantId, 'PASSWORD_CHANGED', user.id);
    await this.prisma.auditLog.create({ data: { tenantId, actorType: 'CRM_USER', actorId: user.id, action: 'LOCAL_PASSWORD_CHANGED', targetType: 'LocalUser', targetId: user.id, result: 'SUCCESS' } });
    return user;
  }

  // ---------- staff management (owner only) ----------
  private view(u: LocalUser) {
    return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, active: u.active, locked: !!u.lockedUntil && u.lockedUntil > new Date(), lastLoginAt: u.lastLoginAt, createdAt: u.createdAt };
  }

  async listUsers(tenantId: string) {
    return (await this.prisma.localUser.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } })).map((u) => this.view(u));
  }

  private staffRole(v: unknown): CrmRole {
    // A PC has exactly one owner (created at setup); staff roles only.
    if (typeof v !== 'string' || !CRM_ROLES.includes(v as CrmRole) || v === 'CRM_OWNER') bad('ROLE_INVALID', 'Vai trò không hợp lệ.');
    return v as CrmRole;
  }

  async createUser(tenantId: string, actorId: string, input: Record<string, unknown>) {
    const username = normalizeUsername(input.username);
    if (!USERNAME.test(username)) bad('USERNAME_INVALID', 'Tên đăng nhập 3–80 ký tự: chữ thường, số, dấu chấm, gạch.');
    const role = this.staffRole(input.role);
    const policy = passwordPolicyError(input.password, username);
    if (policy) bad(policy, 'Mật khẩu cần 10–200 ký tự, không chỉ gồm số và không chứa tên đăng nhập.');
    try {
      const u = await this.prisma.localUser.create({ data: { tenantId, username, displayName: typeof input.displayName === 'string' ? input.displayName.trim().slice(0, 200) || null : null, role, passwordHash: await hashLocalPassword(String(input.password)), createdBy: actorId } });
      await this.prisma.auditLog.create({ data: { tenantId, actorType: 'CRM_USER', actorId, action: 'LOCAL_USER_CREATED', targetType: 'LocalUser', targetId: u.id, result: 'SUCCESS', metadata: { role } } });
      return this.view(u);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'USERNAME_TAKEN', message: 'Tên đăng nhập đã tồn tại.' });
      throw error;
    }
  }

  private async ownUser(tenantId: string, id: string) {
    const u = /^[0-9a-f-]{36}$/i.test(id) ? await this.prisma.localUser.findFirst({ where: { id, tenantId } }) : null;
    if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Không tìm thấy dữ liệu.' });
    return u;
  }

  /** Role change, disable or password reset ends that user's sessions immediately. */
  async updateUser(tenantId: string, actorId: string, id: string, input: Record<string, unknown>) {
    const u = await this.ownUser(tenantId, id);
    if (u.role === 'CRM_OWNER') throw new ForbiddenException({ code: 'OWNER_PROTECTED', message: 'Không thể sửa vai trò hoặc khóa chủ doanh nghiệp.' });
    const data: Prisma.LocalUserUpdateInput = {};
    if (input.displayName !== undefined) data.displayName = typeof input.displayName === 'string' ? input.displayName.trim().slice(0, 200) || null : null;
    if (input.role !== undefined) data.role = this.staffRole(input.role);
    if (input.active !== undefined) { if (typeof input.active !== 'boolean') bad('ACTIVE_INVALID', 'Giá trị không hợp lệ.'); data.active = input.active; }
    if (input.password !== undefined) {
      const policy = passwordPolicyError(input.password, u.username);
      if (policy) bad(policy, 'Mật khẩu cần 10–200 ký tự, không chỉ gồm số và không chứa tên đăng nhập.');
      data.passwordHash = await hashLocalPassword(String(input.password)); data.passwordChangedAt = new Date(); data.failedLogins = 0; data.lockedUntil = null;
    }
    const updated = await this.prisma.localUser.update({ where: { id: u.id }, data });
    const revoked = data.role !== undefined || data.active === false || data.passwordHash !== undefined ? await this.sessions.revokeTenant(tenantId, 'ACCESS_REVOKED', u.id) : 0;
    await this.prisma.auditLog.create({ data: { tenantId, actorType: 'CRM_USER', actorId, action: 'LOCAL_USER_UPDATED', targetType: 'LocalUser', targetId: u.id, result: 'SUCCESS', metadata: { role: updated.role, active: updated.active, passwordReset: data.passwordHash !== undefined, sessionsRevoked: revoked } } });
    return this.view(updated);
  }
}
