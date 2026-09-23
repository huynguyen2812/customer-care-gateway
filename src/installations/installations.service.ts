import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CredentialStatus, InstallationStatus, SourceProduct } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';

@Injectable()
export class InstallationsService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService) {}

  async create(input: Record<string, unknown>, actorId: string) {
    const tenantId = String(input.tenantId || '');
    const sourceProduct = String(input.sourceProduct || '') as SourceProduct;
    if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !Object.values(SourceProduct).includes(sourceProduct)) throw new ConflictException('Invalid tenant/product');
    const existing = await this.prisma.installation.findUnique({ where: { tenantId_sourceProduct: { tenantId, sourceProduct } } });
    if (existing && existing.status !== InstallationStatus.REVOKED) throw new ConflictException('Installation already exists');
    const clientSecret = randomBytes(32).toString('base64url');
    const callbackSecret = randomBytes(32).toString('base64url');
    const clientId = `ccg_${randomBytes(18).toString('base64url')}`;
    const scopes = Array.isArray(input.scopes) ? input.scopes.map(String) : ['care:job:create', 'care:job:read', 'care:job:cancel'];
    const installation = await this.prisma.$transaction(async (tx) => {
      const created = await tx.installation.create({ data: {
        tenantId, sourceProduct, scopes, status: InstallationStatus.ACTIVE,
        callbackUrl: input.callbackUrl ? String(input.callbackUrl) : null,
        sourceVerifyUrl: input.sourceVerifyUrl ? String(input.sourceVerifyUrl) : null,
        callbackSecretEnc: this.crypto.encrypt(callbackSecret),
        dailyQuota: Number(input.dailyQuota || 30),
        expiresAt: input.expiresAt ? new Date(String(input.expiresAt)) : null,
      }});
      await tx.apiCredential.create({ data: {
        installationId: created.id, clientId, secretHash: this.crypto.secretHash(clientSecret), secretLast4: clientSecret.slice(-4),
        expiresAt: input.credentialExpiresAt ? new Date(String(input.credentialExpiresAt)) : null,
      }});
      await tx.auditLog.create({ data: { installationId: created.id, tenantId, actorType: 'PLATFORM_ADMIN', actorId, action: 'INSTALLATION_CREATED', targetType: 'Installation', targetId: created.id, result: 'SUCCESS' } });
      return created;
    });
    return { installationId: installation.id, clientId, clientSecret, callbackSecret, revealOnce: true };
  }

  async rotate(id: string, actorId: string) {
    const installation = await this.prisma.installation.findUnique({ where: { id } });
    if (!installation) throw new NotFoundException();
    const secret = randomBytes(32).toString('base64url'); const clientId = `ccg_${randomBytes(18).toString('base64url')}`;
    await this.prisma.$transaction(async (tx) => {
      await tx.apiCredential.updateMany({ where: { installationId: id, status: CredentialStatus.ACTIVE }, data: { status: CredentialStatus.ROTATING_OUT, expiresAt: new Date(Date.now() + 24 * 3600_000) } });
      await tx.apiCredential.create({ data: { installationId: id, clientId, secretHash: this.crypto.secretHash(secret), secretLast4: secret.slice(-4) } });
      await tx.auditLog.create({ data: { installationId: id, tenantId: installation.tenantId, actorType: 'PLATFORM_ADMIN', actorId, action: 'CREDENTIAL_ROTATED', targetType: 'Installation', targetId: id, result: 'SUCCESS' } });
    });
    return { clientId, clientSecret: secret, revealOnce: true };
  }

  async revoke(id: string, actorId: string) {
    const installation = await this.prisma.installation.findUnique({ where: { id } });
    if (!installation) throw new NotFoundException();
    await this.prisma.$transaction(async (tx) => {
      await tx.installation.update({ where: { id }, data: { status: InstallationStatus.REVOKED, revokedAt: new Date(), paused: true } });
      await tx.apiCredential.updateMany({ where: { installationId: id }, data: { status: CredentialStatus.REVOKED, revokedAt: new Date() } });
      await tx.careJob.updateMany({ where: { installationId: id, status: 'QUEUED' }, data: { status: 'CANCELLED', cancelledAt: new Date(), failureCode: 'INSTALLATION_REVOKED' } });
      await tx.auditLog.create({ data: { installationId: id, tenantId: installation.tenantId, actorType: 'PLATFORM_ADMIN', actorId, action: 'INSTALLATION_REVOKED', targetType: 'Installation', targetId: id, result: 'SUCCESS' } });
    });
    return { installationId: id, status: 'REVOKED' };
  }

  async status(id: string) {
    const row = await this.prisma.installation.findUnique({ where: { id }, include: { credentials: { select: { clientId: true, secretLast4: true, status: true, expiresAt: true } }, zaloAccounts: { select: { id: true, channel: true, status: true, paused: true, lastConnectedAt: true, lastError: true } } } });
    if (!row) throw new NotFoundException();
    return row;
  }

  async setKillSwitch(enabled: boolean, actorId: string, reason?: string) {
    await this.prisma.systemSetting.upsert({ where: { key: 'kill_switch' }, create: { key: 'kill_switch', value: { enabled, reason: reason || null, changedAt: new Date().toISOString() }, updatedBy: actorId }, update: { value: { enabled, reason: reason || null, changedAt: new Date().toISOString() }, updatedBy: actorId } });
    await this.prisma.auditLog.create({ data: { actorType: 'PLATFORM_ADMIN', actorId, action: enabled ? 'SYSTEM_KILL_SWITCH_ENABLED' : 'SYSTEM_KILL_SWITCH_DISABLED', result: 'SUCCESS', reason: reason?.slice(0, 500) } });
    return { enabled };
  }

  async upsertTemplate(id: string, input: Record<string, unknown>, actorId: string, actorType = 'PLATFORM_ADMIN') {
    const installation = await this.prisma.installation.findUnique({ where: { id } });
    if (!installation) throw new NotFoundException();
    const code = String(input.code || ''); const body = String(input.body || '');
    const allowedVariables = Array.isArray(input.allowedVariables) ? input.allowedVariables.map(String) : [];
    if (!/^[A-Z0-9_]{3,100}$/.test(code) || !body || body.length > 2000 || allowedVariables.some((key) => !/^[a-zA-Z0-9_]{1,80}$/.test(key))) throw new ConflictException('Invalid template');
    const placeholders = [...body.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)].map((match) => match[1]);
    if (placeholders.some((key) => !allowedVariables.includes(key))) throw new ConflictException('Template placeholder is not allowed');
    const template = await this.prisma.messageTemplate.upsert({ where: { installationId_code: { installationId: id, code } }, create: { installationId: id, code, body, allowedVariables, active: input.active !== false }, update: { body, allowedVariables, active: input.active !== false } });
    await this.prisma.auditLog.create({ data: { installationId: id, tenantId: installation.tenantId, actorType, actorId, action: 'MESSAGE_TEMPLATE_UPSERTED', targetType: 'MessageTemplate', targetId: template.id, result: 'SUCCESS', metadata: { code } } });
    return { id: template.id, code: template.code, active: template.active };
  }

  async configurePersonalZalo(id: string, input: Record<string, unknown>, actorId: string) {
    const installation = await this.prisma.installation.findUnique({ where: { id } });
    if (!installation) throw new NotFoundException();
    const senderBaseUrl = String(input.senderBaseUrl || ''); const senderClientId = String(input.senderClientId || ''); const signingKey = String(input.signingKey || '');
    let parsed: URL; try { parsed = new URL(senderBaseUrl); } catch { throw new ConflictException('Invalid sender URL'); }
    if (parsed.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new ConflictException('Sender URL must use HTTPS');
    if (!senderClientId || signingKey.length < 32) throw new ConflictException('Invalid sender credential');
    // Operator/control-plane configuration of a private sender. Accounts are tenant-owned: target an
    // existing account of this installation's tenant (zaloAccountId), else the account provisioned for
    // this installation, else create one with an installation routing rule (default if the tenant has none).
    const caps = input.capabilities && typeof input.capabilities === 'object' ? input.capabilities as Record<string, unknown> : {};
    const capabilities = { contractVersion: Number(caps.contractVersion) === 2 ? 2 : 1, idempotentSend: caps.idempotentSend === true, recipientPreflight: caps.recipientPreflight === true, qrLogin: caps.qrLogin === true, remoteControl: caps.remoteControl === true };
    const sender = { channel: 'PERSONAL_ZALO' as const, status: 'CONNECTED' as const, senderBaseUrl, senderClientId, credentialEnc: this.crypto.encrypt(signingKey), capabilities, lastConnectedAt: new Date(), lastError: null, sessionVersion: { increment: 1 } };
    let account = input.zaloAccountId
      ? await this.prisma.zaloAccount.findFirst({ where: { id: String(input.zaloAccountId), tenantId: installation.tenantId } })
      : await this.prisma.zaloAccount.findFirst({ where: { installationId: id, tenantId: installation.tenantId, revokedAt: null }, orderBy: { createdAt: 'asc' } });
    if (input.zaloAccountId && !account) throw new NotFoundException();
    if (account) {
      account = await this.prisma.zaloAccount.update({ where: { id: account.id }, data: sender });
    } else {
      account = await this.prisma.$transaction(async (tx) => {
        const hasDefault = await tx.zaloAccount.count({ where: { tenantId: installation.tenantId, isDefault: true, revokedAt: null } });
        const created = await tx.zaloAccount.create({ data: { ...sender, sessionVersion: 1, tenantId: installation.tenantId, installationId: id, dailyQuota: installation.dailyQuota, timezone: installation.timezone, isDefault: hasDefault === 0 } });
        await tx.zaloRoutingRule.create({ data: { tenantId: installation.tenantId, zaloAccountId: created.id, installationId: id, createdBy: actorId.slice(0, 160) } });
        return created;
      });
    }
    await this.prisma.auditLog.create({ data: { installationId: id, tenantId: installation.tenantId, actorType: 'PLATFORM_ADMIN', actorId, action: 'PERSONAL_ZALO_CONFIGURED', targetType: 'ZaloAccount', targetId: account.id, result: 'SUCCESS', metadata: { capabilities } } });
    return { installationId: id, zaloAccountId: account.id, channel: 'PERSONAL_ZALO', status: 'CONNECTED', secretStoredEncrypted: true };
  }
}
