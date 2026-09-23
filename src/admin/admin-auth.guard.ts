import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AdminAuthService } from './admin-auth.service';

export type AdminRequest = Request & { adminUser?: string; adminCsrf?: string };

function cookies(header?: string): Record<string, string> {
  return Object.fromEntries((header || '').split(';').map((item) => item.trim().split('=')).filter(([key, value]) => key && value).map(([key, value]) => [key, decodeURIComponent(value)]));
}

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly auth: AdminAuthService) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const payload = this.auth.verifySession(cookies(req.headers.cookie).ccg_admin_session || '');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const csrf = String(req.headers['x-csrf-token'] || '');
      if (!csrf || csrf !== payload.csrf) throw new UnauthorizedException('Invalid CSRF token');
    }
    req.adminUser = payload.sub;
    req.adminCsrf = payload.csrf;
    return true;
  }
}
