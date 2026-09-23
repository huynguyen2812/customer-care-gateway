import { ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { CrmSession, CrmTenant } from '@prisma/client';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { CRM_PRODUCT_CODE, CrmRole, entitlementDenyCode, entitlementUsable, mapPlatformRoles, permissionsFor } from './crm.constants';
import { PlatformClientService, PlatformCredential } from './platform-client.service';

export type CrmContext = {
  sessionId: string;
  platformUserId: string;
  platformTenantId: string;
  productCode: string;
  roles: CrmRole[];
  permissions: string[];
  displayName: string | null;
  username: string | null;
  expiresAt: Date;
  csrf: string;
  tenant: CrmTenant;
};

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

@Injectable()
export class CrmSessionService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly platform: PlatformClientService) {}

  private secret(): string {
    const secret = process.env.CRM_SESSION_SECRET || '';
    if (secret.length < 32) throw new ServiceUnavailableException('CRM_SESSION_NOT_CONFIGURED');
    // Products must not share session secrets; the internal admin console has its own.
    if (secret === process.env.ADMIN_SESSION_SECRET) throw new ServiceUnavailableException('CRM_SESSION_SECRET_REUSED');
    return secret;
  }

  ttlMs(): number { return Math.min(Math.max(Number(process.env.CRM_SESSION_TTL_HOURS || 8), 1), 24) * 3600_000; }
  recheckMs(): number { return Math.min(Math.max(Number(process.env.CRM_ENTITLEMENT_RECHECK_SECONDS || 60), 15), 600) * 1000; }

  /** CSRF token bound to the session token: HMAC(secret, tokenHash). Never stored, never in a cookie. */
  csrfFor(tokenHash: string): string { return createHmac('sha256', this.secret()).update(`csrf:${tokenHash}`).digest('base64url'); }

  credential(tenant: CrmTenant): PlatformCredential {
    if (!tenant.platformClientId || !tenant.platformClientSecretEnc) throw new ServiceUnavailableException('CRM_PLATFORM_NOT_PROVISIONED');
    return { clientId: tenant.platformClientId, clientSecret: this.crypto.decrypt(tenant.platformClientSecretEnc) };
  }

  async create(input: { tenant: CrmTenant; platformUserId: string; roles: CrmRole[]; displayName?: string | null; username?: string | null; userAgent?: string | null }): Promise<{ token: string; expiresAt: Date }> {
    this.secret();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlMs());
    await this.prisma.crmSession.create({ data: {
      tokenHash: sha256(token), platformTenantId: input.tenant.platformTenantId, platformUserId: input.platformUserId, productCode: CRM_PRODUCT_CODE,
      roles: input.roles, displayName: input.displayName?.slice(0, 200) || null, username: input.username?.slice(0, 160) || null,
      expiresAt, userAgent: input.userAgent?.slice(0, 300) || null,
    } });
    return { token, expiresAt };
  }

  async revoke(sessionId: string, reason: string) {
    await this.prisma.crmSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason.slice(0, 80) } });
  }

  async revokeTenant(platformTenantId: string, reason: string, platformUserId?: string) {
    const r = await this.prisma.crmSession.updateMany({ where: { platformTenantId, ...(platformUserId ? { platformUserId } : {}), revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason.slice(0, 80) } });
    return r.count;
  }

  /**
   * Resolves the session cookie into a tenant-scoped context. Order: token → not revoked/expired →
   * local entitlement cache (updated by signed Platform events) → periodic live Platform recheck.
   */
  async resolve(token: string, csrfHeader: string | null, mutating: boolean): Promise<CrmContext> {
    if (!token || token.length > 200) throw new UnauthorizedException({ code: 'SESSION_REQUIRED', message: 'Phiên đăng nhập không hợp lệ.' });
    const tokenHash = sha256(token);
    const session = await this.prisma.crmSession.findUnique({ where: { tokenHash }, include: { tenant: true } });
    if (!session || session.revokedAt) throw new UnauthorizedException({ code: session?.revokeReason === 'ACCESS_REVOKED' ? 'ACCESS_REVOKED' : 'SESSION_REQUIRED', message: 'Phiên đăng nhập đã kết thúc.' });
    if (session.expiresAt <= new Date()) throw new UnauthorizedException({ code: 'SESSION_EXPIRED', message: 'Phiên đăng nhập đã hết hạn.' });
    const csrf = this.csrfFor(tokenHash);
    if (mutating) {
      const a = Buffer.from(sha256(csrfHeader || '')); const b = Buffer.from(sha256(csrf));
      if (!csrfHeader || !timingSafeEqual(a, b)) throw new ForbiddenException({ code: 'CSRF_INVALID', message: 'Phiên làm việc không hợp lệ, vui lòng tải lại trang.' });
    }
    let current: CrmSession = session;
    if (!entitlementUsable(session.tenant)) {
      throw new ForbiddenException({ code: entitlementDenyCode(session.tenant), message: 'Doanh nghiệp không còn quyền sử dụng VETCLINIC CRM.' });
    }
    if (Date.now() - session.lastCheckedAt.getTime() >= this.recheckMs()) current = await this.recheck(session);
    const roles = current.roles as CrmRole[];
    return {
      sessionId: current.id, platformUserId: current.platformUserId, platformTenantId: current.platformTenantId, productCode: current.productCode,
      roles, permissions: permissionsFor(roles), displayName: current.displayName, username: current.username, expiresAt: current.expiresAt, csrf, tenant: session.tenant,
    };
  }

  private async recheck(session: CrmSession & { tenant: CrmTenant }): Promise<CrmSession> {
    const result = await this.platform.sessionCheck(this.credential(session.tenant), session.platformUserId);
    if (result.kind === 'DENIED') {
      await this.revoke(session.id, 'ACCESS_REVOKED');
      throw new UnauthorizedException({ code: 'ACCESS_REVOKED', message: 'Tài khoản không còn quyền truy cập VETCLINIC CRM.' });
    }
    if (result.kind === 'UNAVAILABLE') {
      // Outage grace only extends an already ACTIVE decision; never used to create or elevate.
      if (session.checkGraceUntil && session.checkGraceUntil > new Date()) return session;
      throw new ServiceUnavailableException({ code: 'PLATFORM_UNAVAILABLE', message: 'Không kiểm tra được quyền truy cập. Vui lòng thử lại sau.' });
    }
    if (result.claims.tenantId !== session.platformTenantId || result.claims.productCode !== CRM_PRODUCT_CODE) {
      await this.revoke(session.id, 'ACCESS_REVOKED');
      throw new UnauthorizedException({ code: 'ACCESS_REVOKED', message: 'Tài khoản không còn quyền truy cập VETCLINIC CRM.' });
    }
    return this.prisma.crmSession.update({ where: { id: session.id }, data: { lastCheckedAt: new Date(), checkGraceUntil: result.graceUntil, roles: mapPlatformRoles(result.claims) } });
  }
}
