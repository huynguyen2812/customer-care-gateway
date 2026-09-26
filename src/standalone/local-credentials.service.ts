import { Injectable, NotFoundException } from '@nestjs/common';
import { ApiCredential, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';

type Tx = Prisma.TransactionClient;
const ROTATION_GRACE_MS = 24 * 3600_000;

/** HMAC signing key derived from the one-time secret; identical to docs/api-contract.md `signingKey`. */
export function signingKeyOf(secret: string): string { return createHash('sha256').update(secret).digest('hex'); }

/**
 * Self-issued API credentials for the standalone edition (no Platform). The raw secret is shown once;
 * only the signing key is kept, AES-GCM encrypted (`signingKeyEnc`), and `secretHash` holds just a
 * fingerprint of it, so a database dump alone cannot be used to forge signatures.
 */
@Injectable()
export class LocalCredentialsService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService) {}

  async issue(installationId: string, tx: Tx = this.prisma): Promise<{ clientId: string; clientSecret: string }> {
    const clientSecret = randomBytes(32).toString('base64url');
    const clientId = `vccrm_${randomBytes(15).toString('base64url')}`;
    const signingKey = signingKeyOf(clientSecret);
    await tx.apiCredential.create({ data: {
      installationId, clientId, secretHash: signingKeyOf(signingKey), secretLast4: clientSecret.slice(-4), signingKeyEnc: this.crypto.encrypt(signingKey),
    } });
    return { clientId, clientSecret };
  }

  /** Old key keeps working for 24 hours so the external system can switch without downtime. */
  async rotate(installationId: string, tenantId: string, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.apiCredential.updateMany({ where: { installationId, status: 'ACTIVE' }, data: { status: 'ROTATING_OUT', expiresAt: new Date(Date.now() + ROTATION_GRACE_MS) } });
      const out = await this.issue(installationId, tx);
      await tx.auditLog.create({ data: { installationId, tenantId, actorType: 'CRM_USER', actorId, action: 'LOCAL_CREDENTIAL_ROTATED', targetType: 'Installation', targetId: installationId, result: 'SUCCESS', metadata: { clientId: out.clientId } } });
      return { ...out, revealOnce: true, previousValidUntil: new Date(Date.now() + ROTATION_GRACE_MS) };
    });
  }

  async revoke(installationId: string, tenantId: string, clientId: string, actorId: string) {
    const r = await this.prisma.apiCredential.updateMany({ where: { installationId, clientId, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', revokedAt: new Date() } });
    if (!r.count) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Không tìm thấy dữ liệu.' });
    await this.prisma.auditLog.create({ data: { installationId, tenantId, actorType: 'CRM_USER', actorId, action: 'LOCAL_CREDENTIAL_REVOKED', targetType: 'ApiCredential', targetId: clientId, result: 'SUCCESS' } });
    return { clientId, status: 'REVOKED' };
  }

  async list(installationId: string) {
    const rows = await this.prisma.apiCredential.findMany({ where: { installationId }, orderBy: { createdAt: 'desc' }, select: { clientId: true, secretLast4: true, status: true, expiresAt: true, revokedAt: true, createdAt: true } });
    return rows.map((r) => ({ ...r, usable: r.status !== 'REVOKED' && !r.revokedAt && (!r.expiresAt || r.expiresAt > new Date()) }));
  }

  /** Key the CRM uses to sign outbound connector requests: the newest usable credential. */
  async outboundKey(installationId: string): Promise<{ clientId: string; signingKey: string }> {
    const now = new Date();
    const rows = await this.prisma.apiCredential.findMany({ where: { installationId, status: 'ACTIVE', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, orderBy: { createdAt: 'desc' }, take: 1 });
    const row = rows[0];
    if (!row) throw new Error('SOURCE_CREDENTIAL_REVOKED');
    return { clientId: row.clientId, signingKey: this.verificationKey(row) };
  }

  /** Key used to verify an inbound request (legacy rows keep the old secretHash-as-key behaviour). */
  verificationKey(row: Pick<ApiCredential, 'secretHash' | 'signingKeyEnc'>): string {
    return row.signingKeyEnc ? this.crypto.decrypt(row.signingKeyEnc) : row.secretHash;
  }
}
