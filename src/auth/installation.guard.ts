import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { HmacAuthService } from './hmac-auth.service';
import { sha256 } from '../common/canonical';

@Injectable()
export class InstallationGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly hmac: HmacAuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer; installationContext?: any }>();
    const clientId = String(req.headers['x-care-client-id'] || '');
    const timestamp = String(req.headers['x-care-timestamp'] || '');
    const nonce = String(req.headers['x-care-nonce'] || '');
    const signature = String(req.headers['x-care-signature'] || '');
    const credential = await this.prisma.apiCredential.findUnique({ where: { clientId }, include: { installation: true } });
    const age = Math.abs(Date.now() - Number(timestamp));
    if (!credential || !timestamp || !nonce || !Number.isFinite(age) || age > 300_000) throw new UnauthorizedException('Invalid request authentication');
    if (!['ACTIVE', 'ROTATING_OUT'].includes(credential.status) || credential.revokedAt || (credential.expiresAt && credential.expiresAt <= new Date())) throw new UnauthorizedException('Invalid request authentication');
    const installation = credential.installation;
    if (installation.status !== 'ACTIVE' || installation.paused || installation.revokedAt || (installation.expiresAt && installation.expiresAt <= new Date())) throw new UnauthorizedException('Invalid request authentication');
    this.hmac.verify(credential.secretHash, signature, `${req.method}\n${req.path}\n${timestamp}\n${nonce}\n${sha256(req.rawBody || Buffer.alloc(0))}`);
    try { await this.prisma.requestNonce.create({ data: { installationId: installation.id, nonce } }); }
    catch { throw new UnauthorizedException('Invalid request authentication'); }
    req.installationContext = { installation, installationId: installation.id, tenantId: installation.tenantId, sourceProduct: installation.sourceProduct, scopes: installation.scopes };
    await this.prisma.installation.update({ where: { id: installation.id }, data: { lastConnectedAt: new Date(), lastError: null } });
    return true;
  }
}
