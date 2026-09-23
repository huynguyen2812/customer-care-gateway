import { BadRequestException, Body, Controller, HttpCode, Post, Req, ServiceUnavailableException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { CRM_PRODUCT_CODE } from './crm.constants';
import { crmCallbackBase } from './crm-auth.controller';

const TYPE_ALIASES: Record<string, string> = { UPSERT_INSTALLATION: 'installation.upserted', REVOKE_INSTALLATION: 'installation.revoked' };
const TYPES = new Set(['installation.upserted', 'installation.revoked', 'subscription.activated', 'subscription.changed', 'subscription.suspended', 'subscription.expired', 'user_product_access.revoked']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SKEW_MS = 5 * 60_000;

type RawRequest = Request & { rawBody?: Buffer };

function hex(v: string) { return createHash('sha256').update(v).digest(); }
function toDate(v: unknown): Date | null { if (!v) return null; const d = new Date(String(v)); return Number.isNaN(d.getTime()) ? null : d; }

/**
 * Signed Platform → CRM events (same signing scheme as the TIMEKEEPING provisioning contract):
 * `x-platform-provisioning-signature = hex(HMAC-SHA256(secret, "${timestamp}.${eventId}.${sha256(rawBody)}"))`.
 * The signature is verified over the raw body BEFORE any field (including tenant) is trusted.
 * Replays are rejected by timestamp window + unique eventId; redelivery of the same eventId is a no-op.
 */
@Controller('crm/platform')
export class PlatformEventsController {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService) {}

  @Post('events')
  @HttpCode(200)
  async receive(@Req() req: RawRequest, @Body() body: Record<string, any>) {
    const secret = process.env.CRM_PLATFORM_EVENTS_SECRET || '';
    if (secret.length < 32) throw new ServiceUnavailableException('CRM_EVENTS_NOT_CONFIGURED');
    const eventId = String(req.headers['x-platform-provisioning-id'] || '');
    const timestamp = String(req.headers['x-platform-provisioning-timestamp'] || '');
    const signature = String(req.headers['x-platform-provisioning-signature'] || '');
    const raw = req.rawBody?.toString('utf8') ?? '';
    if (!UUID.test(eventId) || !/^\d{10,16}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(signature) || !raw) throw new UnauthorizedException('Invalid event signature');
    const expected = createHmac('sha256', secret).update(`${timestamp}.${eventId}.${createHash('sha256').update(raw).digest('hex')}`).digest('hex');
    if (!timingSafeEqual(hex(expected), hex(signature.toLowerCase()))) throw new UnauthorizedException('Invalid event signature');
    if (Math.abs(Date.now() - Number(timestamp)) > MAX_SKEW_MS) throw new UnauthorizedException('Stale event');
    if (body?.eventId !== undefined && body.eventId !== eventId) throw new UnauthorizedException('Event id mismatch');

    const type = TYPE_ALIASES[String(body?.action || '')] || String(body?.type || '');
    if (!TYPES.has(type)) throw new BadRequestException('Unsupported event type');
    const platformTenantId = String(body?.tenant?.platformTenantId || body?.tenantId || '');
    if (!UUID.test(platformTenantId)) throw new BadRequestException('Invalid tenant');
    const productCode = body?.entitlement?.productCode ?? body?.productCode;
    if (productCode !== undefined && productCode !== CRM_PRODUCT_CODE) throw new UnprocessableEntityException('Wrong product');
    const occurredAt = toDate(body?.occurredAt) || new Date(Number(timestamp));

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.platformEvent.create({ data: { eventId, type, platformTenantId, occurredAt, result: 'PROCESSING' } });
        const result = await this.apply(tx, type, platformTenantId, occurredAt, body);
        await tx.platformEvent.update({ where: { eventId }, data: { result } });
        await tx.auditLog.create({ data: { tenantId: platformTenantId, actorType: 'PLATFORM', actorId: 'platform-admin', action: `PLATFORM_EVENT_${type.replace(/[.]/g, '_').toUpperCase()}`, targetType: 'CrmTenant', targetId: platformTenantId, result: result === 'APPLIED' ? 'SUCCESS' : 'NO_CHANGE', reason: result, metadata: { eventId } } });
        return { accepted: true, eventId, result };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return { accepted: true, eventId, duplicate: true };
      throw error;
    }
  }

  private async apply(tx: Prisma.TransactionClient, type: string, platformTenantId: string, occurredAt: Date, body: Record<string, any>): Promise<string> {
    const existing = await tx.crmTenant.findUnique({ where: { platformTenantId } });
    const ent = body?.entitlement || {};
    const entitlementData = {
      ...(typeof ent.status === 'string' ? { entitlementStatus: ent.status.slice(0, 20) } : {}),
      ...(ent.planCode !== undefined ? { planCode: ent.planCode ? String(ent.planCode).slice(0, 64) : null } : {}),
      ...(ent.limits !== undefined ? { limits: ent.limits ?? Prisma.JsonNull } : {}),
      ...(ent.features !== undefined ? { features: ent.features ?? Prisma.JsonNull } : {}),
      ...(ent.startsAt !== undefined ? { entitlementStartsAt: toDate(ent.startsAt) } : {}),
      ...(ent.expiresAt !== undefined ? { entitlementExpiresAt: toDate(ent.expiresAt) } : {}),
    };
    // Out-of-order delivery must not roll entitlement back to an older state.
    const stale = existing?.entitlementUpdatedAt && existing.entitlementUpdatedAt > occurredAt;

    if (type === 'installation.upserted') {
      const inst = body?.installation || {};
      const clientId = String(inst.clientId || ''); const clientSecret = String(inst.clientSecret || '');
      if (!/^[A-Za-z0-9._-]{4,100}$/.test(clientId) || clientSecret.length < 16) throw new BadRequestException('Invalid installation');
      if (inst.callbackBaseUrl !== crmCallbackBase()) throw new UnprocessableEntityException('Callback base URL does not match this CRM');
      const data = {
        displayName: body?.tenant?.name ? String(body.tenant.name).slice(0, 200) : existing?.displayName ?? null,
        platformInstallationId: UUID.test(String(inst.installationId || '')) ? String(inst.installationId) : null,
        platformClientId: clientId, platformClientSecretEnc: this.crypto.encrypt(clientSecret), callbackBaseUrl: String(inst.callbackBaseUrl),
        installationStatus: 'ACTIVE', ...(stale ? {} : { ...entitlementData, entitlementUpdatedAt: occurredAt }),
      };
      await tx.crmTenant.upsert({ where: { platformTenantId }, create: { platformTenantId, ...data }, update: data });
      return 'APPLIED';
    }
    if (!existing) return 'IGNORED_UNKNOWN_TENANT';
    if (type === 'installation.revoked') {
      const clientId = body?.installation?.clientId;
      if (clientId !== undefined && clientId !== existing.platformClientId) return 'IGNORED_CLIENT_MISMATCH';
      await tx.crmTenant.update({ where: { platformTenantId }, data: { installationStatus: 'REVOKED', platformClientSecretEnc: null } });
      await tx.crmSession.updateMany({ where: { platformTenantId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'ACCESS_REVOKED' } });
      return 'APPLIED';
    }
    if (type === 'user_product_access.revoked') {
      const userId = String(body?.user?.platformUserId || body?.platformUserId || '');
      if (!UUID.test(userId)) throw new BadRequestException('Invalid user');
      await tx.crmSession.updateMany({ where: { platformTenantId, platformUserId: userId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'ACCESS_REVOKED' } });
      return 'APPLIED';
    }
    // subscription.*
    if (stale) return 'IGNORED_STALE';
    const statusByType: Record<string, string | undefined> = { 'subscription.suspended': 'SUSPENDED', 'subscription.expired': 'EXPIRED', 'subscription.activated': ent.status === 'TRIAL' ? 'TRIAL' : 'ACTIVE' };
    const status = statusByType[type] ?? (typeof ent.status === 'string' ? ent.status : existing.entitlementStatus);
    await tx.crmTenant.update({ where: { platformTenantId }, data: { ...entitlementData, entitlementStatus: status.slice(0, 20), entitlementUpdatedAt: occurredAt } });
    if (type === 'subscription.suspended' || type === 'subscription.expired') {
      await tx.crmSession.updateMany({ where: { platformTenantId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'ACCESS_REVOKED' } });
    }
    return 'APPLIED';
  }
}
