import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { CRM_SESSION_COOKIE, CRM_SESSION_COOKIE_SECURE, CrmPermission, entitlementDenyCode, entitlementUsable } from './crm.constants';
import { CrmContext, CrmSessionService } from './crm-session.service';

export const CRM_PERMISSION_KEY = 'crm:permission';
export const CRM_REQUIRES_SENDING_KEY = 'crm:requiresSending';
/** Required permission for a CRM route. Every CRM route must declare one. */
export const RequirePermission = (permission: CrmPermission) => SetMetadata(CRM_PERMISSION_KEY, permission);
/** Marks mutations that could cause messages to be sent; blocked when the entitlement is not usable. */
export const RequiresSendingEntitlement = () => SetMetadata(CRM_REQUIRES_SENDING_KEY, true);

export type CrmRequest = Request & { crm?: CrmContext };
export const Crm = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<CrmRequest>().crm!);

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

export function crmSessionCookieName(): string {
  return process.env.NODE_ENV === 'production' ? CRM_SESSION_COOKIE_SECURE : CRM_SESSION_COOKIE;
}

@Injectable()
export class CrmAuthGuard implements CanActivate {
  constructor(private readonly sessions: CrmSessionService, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<CrmRequest>();
    const permission = this.reflector.getAllAndOverride<CrmPermission | undefined>(CRM_PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    // Fail closed: a CRM route without an explicit permission is a programming error.
    if (!permission) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Bạn không có quyền thực hiện thao tác này.' });
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating) this.assertOrigin(req);
    const ctx = await this.sessions.resolve(readCookie(req, crmSessionCookieName()) || '', String(req.headers['x-csrf-token'] || '') || null, mutating);
    if (!ctx.permissions.includes(permission)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Bạn không có quyền thực hiện thao tác này.' });
    const needsSending = this.reflector.getAllAndOverride<boolean>(CRM_REQUIRES_SENDING_KEY, [context.getHandler(), context.getClass()]);
    if (needsSending && !entitlementUsable(ctx.tenant)) throw new ForbiddenException({ code: entitlementDenyCode(ctx.tenant), message: 'Gói dịch vụ không cho phép thao tác này.' });
    req.crm = ctx;
    return true;
  }

  /** Browsers always send Origin on cross-site POST/PATCH/DELETE; when present it must be ours. */
  private assertOrigin(req: Request) {
    const origin = req.headers.origin;
    const expected = (process.env.CRM_PUBLIC_ORIGIN || '').replace(/\/$/, '');
    if (origin && expected && origin !== expected) throw new ForbiddenException({ code: 'CSRF_INVALID', message: 'Nguồn yêu cầu không hợp lệ.' });
  }
}
