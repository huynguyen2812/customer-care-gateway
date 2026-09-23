import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { HmacAuthService } from './hmac-auth.service';
import { sha256 } from '../common/canonical';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class PlatformControlGuard implements CanActivate {
  constructor(private readonly hmac: HmacAuthService, private readonly prisma: PrismaService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const clientId = String(req.headers['x-platform-client-id'] || '');
    const timestamp = String(req.headers['x-platform-timestamp'] || '');
    const nonce = String(req.headers['x-platform-nonce'] || '');
    const signature = String(req.headers['x-platform-signature'] || '');
    if (clientId !== process.env.PLATFORM_CONTROL_CLIENT_ID) throw new UnauthorizedException('Invalid request authentication');
    const age = Math.abs(Date.now() - Number(timestamp));
    if (!timestamp || !Number.isFinite(age) || age > 300_000 || !nonce) throw new UnauthorizedException('Invalid request authentication');
    this.hmac.verify(process.env.PLATFORM_CONTROL_SECRET || '', signature, `${req.method}\n${req.path}\n${timestamp}\n${nonce}\n${sha256(req.rawBody || Buffer.alloc(0))}`);
    try { await this.prisma.controlNonce.create({ data: { clientId, nonce } }); }
    catch { throw new UnauthorizedException('Invalid request authentication'); }
    return true;
  }
}
