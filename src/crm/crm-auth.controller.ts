import { Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { CRM_PRODUCT_CODE, CRM_STATE_COOKIE, USABLE_ENTITLEMENTS, entitlementUsable, mapPlatformRoles } from './crm.constants';
import { Crm, CrmAuthGuard, crmCookieSecure, crmSessionCookieName, readCookie, RequirePermission } from './crm-auth.guard';
import { CrmContext, CrmSessionService } from './crm-session.service';
import { PlatformClientService, PlatformDeniedError } from './platform-client.service';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const CODE_PATTERN = /^[A-Za-z0-9._~-]{16,256}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{4,100}$/;

function secure() { return crmCookieSecure(); }
export function crmPublicOrigin(): string { return (process.env.CRM_PUBLIC_ORIGIN || '').replace(/\/$/, ''); }
export function crmCallbackBase(): string { return `${crmPublicOrigin()}/api/v1/crm`; }
export function platformWebOrigin(): string {
  const raw = (process.env.PLATFORM_WEB_ORIGIN || '').replace(/\/$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (process.env.NODE_ENV === 'production' && (url.protocol !== 'https:' || url.hostname !== 'admin.vetclinic.vn')) return '';
    return url.origin;
  } catch {
    return '';
  }
}

@Controller('crm/auth')
export class CrmAuthController {
  constructor(private readonly prisma: PrismaService, private readonly sessions: CrmSessionService, private readonly platform: PlatformClientService) {}

  /** Starts Platform SSO: state in a short-lived HttpOnly cookie, then the Platform launcher. */
  @Get('start')
  start(@Res() res: Response) {
    const launcher = platformWebOrigin();
    if (!launcher || !crmPublicOrigin()) return res.redirect(302, '/#loi=CRM_NOT_CONFIGURED');
    const state = randomBytes(32).toString('base64url');
    res.cookie(CRM_STATE_COOKIE, state, { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/api/v1/crm/auth', maxAge: 10 * 60_000 });
    return res.redirect(302, `${launcher}/product-launch/${CRM_PRODUCT_CODE}?state=${encodeURIComponent(state)}`);
  }

  /**
   * Platform redirects here with `code` (single use, ~60s), public `installation` clientId and `state`.
   * The code is exchanged server-to-server with the per-tenant installation credential; tenant,
   * user and roles come only from the verified RS256 token, never from the query string.
   */
  @Get('platform/callback')
  async callback(@Query('code') code: string, @Query('installation') installation: string, @Query('state') state: string, @Req() req: Request, @Res() res: Response) {
    const fail = (reason: string) => { res.clearCookie(CRM_STATE_COOKIE, { path: '/api/v1/crm/auth' }); return res.redirect(302, `/#loi=${reason}`); };
    const expectedState = readCookie(req, CRM_STATE_COOKIE) || '';
    if (!STATE_PATTERN.test(String(state || '')) || !STATE_PATTERN.test(expectedState) || !timingSafeEqual(Buffer.from(sha256(state)), Buffer.from(sha256(expectedState)))) return fail('STATE_INVALID');
    if (!CODE_PATTERN.test(String(code || '')) || !CLIENT_ID_PATTERN.test(String(installation || ''))) return fail('CODE_INVALID');
    const tenant = await this.prisma.crmTenant.findUnique({ where: { platformClientId: installation } });
    if (!tenant || tenant.installationStatus !== 'ACTIVE') return fail('ACCESS_DENIED');
    // Redirect URI binding: the Platform installation must be registered with exactly our callback base.
    if (!crmPublicOrigin() || tenant.callbackBaseUrl !== crmCallbackBase()) return fail('REDIRECT_MISMATCH');
    let result;
    try {
      result = await this.platform.exchange(this.sessions.credential(tenant), code);
    } catch (error) {
      if (error instanceof PlatformDeniedError) return fail(error.code === 'CODE_INVALID' ? 'CODE_INVALID' : 'ACCESS_DENIED');
      const status = (error as { getStatus?: () => number }).getStatus?.();
      return fail(status === 401 ? 'CODE_INVALID' : 'PLATFORM_UNAVAILABLE');
    }
    const c = result.claims;
    if (c.tenantId !== tenant.platformTenantId || c.productCode !== CRM_PRODUCT_CODE) return fail('ACCESS_DENIED');
    // Platform binds the code to the installation's registered `callbackBaseUrl` (same value for every
    // SSO product); accept exactly that, or the full callback URL, and nothing else.
    if (typeof c.redirectUri === 'string' && ![crmCallbackBase(), `${crmCallbackBase()}/auth/platform/callback`].includes(c.redirectUri.replace(/\/$/, ''))) return fail('REDIRECT_MISMATCH');
    if (typeof c.entitlementStatus === 'string' && !USABLE_ENTITLEMENTS.has(c.entitlementStatus)) return fail('ENTITLEMENT_INACTIVE');
    if (!entitlementUsable(tenant)) return fail('ENTITLEMENT_INACTIVE');
    try {
      await this.prisma.crmSsoTokenReplay.create({ data: { jti: String(c.jti).slice(0, 100), platformTenantId: tenant.platformTenantId, expiresAt: new Date(c.exp * 1000) } });
    } catch {
      return fail('CODE_INVALID');
    }
    const roles = mapPlatformRoles(c);
    const session = await this.sessions.create({ tenant, platformUserId: c.sub, roles, displayName: result.user?.fullName || null, username: result.user?.username || null, userAgent: String(req.headers['user-agent'] || '') });
    await this.prisma.auditLog.create({ data: { tenantId: tenant.platformTenantId, actorType: 'CRM_USER', actorId: c.sub, action: 'CRM_LOGIN', targetType: 'CrmSession', result: 'SUCCESS', metadata: { roles } } });
    res.clearCookie(CRM_STATE_COOKIE, { path: '/api/v1/crm/auth' });
    res.cookie(crmSessionCookieName(), session.token, { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/', expires: session.expiresAt });
    return res.redirect(302, '/#/tong-quan');
  }

  @Get('me')
  @UseGuards(CrmAuthGuard)
  @RequirePermission('crm.dashboard.read')
  me(@Crm() crm: CrmContext) {
    return {
      user: { platformUserId: crm.platformUserId, displayName: crm.displayName, username: crm.username },
      tenant: { id: crm.platformTenantId, name: crm.tenant.displayName },
      roles: crm.roles, permissions: crm.permissions, csrfToken: crm.csrf, expiresAt: crm.expiresAt,
      entitlement: { status: crm.tenant.entitlementStatus, planCode: crm.tenant.planCode, expiresAt: crm.tenant.entitlementExpiresAt },
      platformAccountUrl: platformWebOrigin() ? `${platformWebOrigin()}/account` : null,
    };
  }

  /** Logout works even when the entitlement is no longer active; requires the session's CSRF token. */
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readCookie(req, crmSessionCookieName()) || '';
    if (token) {
      const tokenHash = sha256(token);
      const csrf = String(req.headers['x-csrf-token'] || '');
      const session = await this.prisma.crmSession.findUnique({ where: { tokenHash } });
      if (session && csrf && timingSafeEqual(Buffer.from(sha256(csrf)), Buffer.from(sha256(this.sessions.csrfFor(tokenHash))))) {
        await this.sessions.revoke(session.id, 'LOGOUT');
        await this.prisma.auditLog.create({ data: { tenantId: session.platformTenantId, actorType: 'CRM_USER', actorId: session.platformUserId, action: 'CRM_LOGOUT', targetType: 'CrmSession', result: 'SUCCESS' } });
      }
    }
    res.clearCookie(crmSessionCookieName(), { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/' });
    return { authenticated: false };
  }
}
