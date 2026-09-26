import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { Crm, CrmAuthGuard, crmCookieSecure, crmSessionCookieName, readCookie, RequirePermission } from '../crm/crm-auth.guard';
import { CrmContext, CrmSessionService } from '../crm/crm-session.service';
import { LocalAuthService } from './local-auth.service';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Unauthenticated POSTs (setup, login) are same-origin only: when the browser sends Origin it must match
 * CRM_PUBLIC_ORIGIN (or the Host header when that is not configured).
 */
function assertSameOrigin(req: Request) {
  const origin = req.headers.origin;
  if (!origin) return;
  const expected = (process.env.CRM_PUBLIC_ORIGIN || '').replace(/\/$/, '');
  let ok = false;
  try { ok = expected ? origin === expected : new URL(origin).host === req.headers.host; } catch { ok = false; }
  if (!ok) throw new ForbiddenException({ code: 'CSRF_INVALID', message: 'Nguồn yêu cầu không hợp lệ.' });
}

/**
 * Standalone PC edition login surface. Keeps the same /crm/auth/me and /crm/auth/logout contract as the
 * Platform edition so the web UI is shared; adds /crm/auth/local/* for first-run setup and password login.
 */
@Controller('crm/auth')
export class StandaloneAuthController {
  constructor(private readonly prisma: PrismaService, private readonly sessions: CrmSessionService, private readonly local: LocalAuthService) {}

  private setCookie(res: Response, token: string, expiresAt: Date) {
    res.cookie(crmSessionCookieName(), token, { httpOnly: true, secure: crmCookieSecure(), sameSite: 'strict', path: '/', expires: expiresAt });
  }

  @Get('local/status')
  status() { return this.local.status(); }

  /**
   * First-run setup, allowed once per PC and only from the PC itself (loopback). Returns the self-issued
   * API credential exactly once.
   */
  @Post('local/setup')
  @HttpCode(200)
  async setup(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: Record<string, unknown>) {
    assertSameOrigin(req);
    if (!LOOPBACK.has(String(req.socket.remoteAddress || ''))) throw new ForbiddenException({ code: 'SETUP_LOCAL_ONLY', message: 'Chỉ thiết lập được trên chính máy cài VETCLINIC CRM.' });
    const out = await this.local.setup(body || {});
    const session = await this.local.startSession(out.user, out.tenant, String(req.headers['user-agent'] || ''));
    this.setCookie(res, session.token, session.expiresAt);
    return { tenant: { id: out.tenant.platformTenantId, name: out.tenant.displayName }, apiCredential: { ...out.credential, revealOnce: true } };
  }

  @Post('local/login')
  @HttpCode(200)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: Record<string, unknown>) {
    assertSameOrigin(req);
    const { user, tenant } = await this.local.login(body?.username, body?.password, String(req.socket.remoteAddress || ''));
    const session = await this.local.startSession(user, tenant, String(req.headers['user-agent'] || ''));
    this.setCookie(res, session.token, session.expiresAt);
    return { authenticated: true };
  }

  @Post('local/change-password')
  @HttpCode(200)
  @UseGuards(CrmAuthGuard)
  @RequirePermission('crm.dashboard.read')
  async changePassword(@Crm() crm: CrmContext, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: Record<string, unknown>) {
    const user = await this.local.changePassword(crm.platformTenantId, crm.platformUserId, body?.currentPassword, body?.newPassword);
    // All sessions of this user were revoked; continue with a fresh one on this device.
    const tenant = await this.prisma.crmTenant.findUniqueOrThrow({ where: { platformTenantId: crm.platformTenantId } });
    const session = await this.local.startSession(await this.prisma.localUser.findUniqueOrThrow({ where: { id: user.id } }), tenant, String(req.headers['user-agent'] || ''));
    this.setCookie(res, session.token, session.expiresAt);
    return { changed: true };
  }

  @Get('me')
  @UseGuards(CrmAuthGuard)
  @RequirePermission('crm.dashboard.read')
  me(@Crm() crm: CrmContext) {
    return {
      mode: 'standalone',
      user: { platformUserId: crm.platformUserId, displayName: crm.displayName, username: crm.username },
      tenant: { id: crm.platformTenantId, name: crm.tenant.displayName },
      roles: crm.roles, permissions: crm.permissions, csrfToken: crm.csrf, expiresAt: crm.expiresAt,
      entitlement: { status: crm.tenant.entitlementStatus, planCode: crm.tenant.planCode, expiresAt: crm.tenant.entitlementExpiresAt },
      platformAccountUrl: null,
    };
  }

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
    res.clearCookie(crmSessionCookieName(), { httpOnly: true, secure: crmCookieSecure(), sameSite: 'strict', path: '/' });
    return { authenticated: false };
  }
}
