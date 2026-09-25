import { BadRequestException, Body, ConflictException, Controller, HttpCode, HttpException, Post, Req, ServiceUnavailableException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { InstallationStatus, Prisma, SourceProduct } from '@prisma/client';
import { Request } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { CRM_PRODUCT_CODE } from './crm.constants';
import { crmCallbackBase } from './crm-auth.controller';
import { DeletionInput, LIFECYCLE_TX, LIFECYCLE_TYPES, TenantLifecycleService } from './tenant-lifecycle.service';

const TYPE_ALIASES: Record<string, string> = { UPSERT_INSTALLATION: 'installation.upserted', REVOKE_INSTALLATION: 'installation.revoked' };
const SOURCE_TYPES = new Set(['petclinic_source.upserted', 'petclinic_source.credential_rotated', 'petclinic_source.status_changed', 'petclinic_source.revoked']);
const TYPES = new Set(['installation.upserted', 'installation.revoked', 'subscription.activated', 'subscription.changed', 'subscription.suspended', 'subscription.expired', 'user_product_access.revoked', 'source.changed', ...SOURCE_TYPES]);
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
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly lifecycle: TenantLifecycleService) {}

  @Post('events')
  @HttpCode(200)
  async receive(@Req() req: RawRequest, @Body() body: Record<string, any>) {
    const secret = process.env.CRM_PLATFORM_EVENTS_SECRET || '';
    if (secret.length < 32) throw new ServiceUnavailableException('CRM_EVENTS_NOT_CONFIGURED');
    const eventId = String(req.headers['x-platform-provisioning-id'] || '');
    const timestamp = String(req.headers['x-platform-provisioning-timestamp'] || '');
    const signature = String(req.headers['x-platform-provisioning-signature'] || '');
    const raw = req.rawBody?.toString('utf8') ?? '';
    const payloadHash = createHash('sha256').update(raw).digest('hex');
    if (!UUID.test(eventId) || !/^\d{10,16}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(signature) || !raw) throw new UnauthorizedException('Invalid event signature');
    const expected = createHmac('sha256', secret).update(`${timestamp}.${eventId}.${createHash('sha256').update(raw).digest('hex')}`).digest('hex');
    if (!timingSafeEqual(hex(expected), hex(signature.toLowerCase()))) throw new UnauthorizedException('Invalid event signature');
    if (Math.abs(Date.now() - Number(timestamp)) > MAX_SKEW_MS) throw new UnauthorizedException('Stale event');
    if (body?.eventId !== undefined && body.eventId !== eventId) throw new UnauthorizedException('Event id mismatch');

    const type = TYPE_ALIASES[String(body?.action || '')] || String(body?.type || '');
    if (!TYPES.has(type) && !LIFECYCLE_TYPES.has(type)) throw new BadRequestException('Unsupported event type');
    if (SOURCE_TYPES.has(type) && (body?.eventId !== eventId || !toDate(body?.occurredAt))) throw new BadRequestException('Invalid PETCLINIC source event envelope');
    const platformTenantId = String(body?.tenant?.platformTenantId || body?.tenantId || '');
    if (!UUID.test(platformTenantId)) throw new BadRequestException('Invalid tenant');
    const productCode = body?.entitlement?.productCode ?? body?.productCode;
    if (productCode !== undefined && productCode !== CRM_PRODUCT_CODE && !(SOURCE_TYPES.has(type) && ['PETCLINIC_ESSENTIAL', 'PETCLINIC_OPERATING'].includes(String(productCode)))) throw new UnprocessableEntityException('Wrong product');
    const occurredAt = toDate(body?.occurredAt) || new Date(Number(timestamp));

    if (LIFECYCLE_TYPES.has(type)) return this.receiveLifecycle(eventId, type, platformTenantId, occurredAt, body, payloadHash);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.platformEvent.create({ data: { eventId, type, platformTenantId, occurredAt, result: 'PROCESSING', payloadHash } });
        const result = SOURCE_TYPES.has(type)
          ? await this.applyPetclinicSource(tx, type, platformTenantId, occurredAt, body)
          : await this.apply(tx, type, platformTenantId, occurredAt, body);
        await tx.platformEvent.update({ where: { eventId }, data: { result } });
        await tx.auditLog.create({ data: { tenantId: platformTenantId, actorType: 'PLATFORM', actorId: 'platform-admin', action: `PLATFORM_EVENT_${type.replace(/[.]/g, '_').toUpperCase()}`, targetType: 'CrmTenant', targetId: platformTenantId, result: result === 'APPLIED' ? 'SUCCESS' : 'NO_CHANGE', reason: result, metadata: { eventId } } });
        return { accepted: true, eventId, result };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.platformEvent.findUnique({ where: { eventId } });
        if (!existing?.payloadHash || existing.payloadHash !== payloadHash) throw new ConflictException('EVENT_ID_REUSED');
        return { accepted: true, eventId, duplicate: true, result: existing.result };
      }
      throw error;
    }
  }

  private entitlementData(body: Record<string, any>) {
    const ent = body?.entitlement || {};
    return {
      ...(typeof ent.status === 'string' ? { entitlementStatus: ent.status.slice(0, 20) } : {}),
      ...(ent.planCode !== undefined ? { planCode: ent.planCode ? String(ent.planCode).slice(0, 64) : null } : {}),
      ...(ent.limits !== undefined ? { limits: ent.limits ?? Prisma.JsonNull } : {}),
      ...(ent.features !== undefined ? { features: ent.features ?? Prisma.JsonNull } : {}),
      ...(ent.startsAt !== undefined ? { entitlementStartsAt: toDate(ent.startsAt) } : {}),
      ...(ent.expiresAt !== undefined ? { entitlementExpiresAt: toDate(ent.expiresAt) } : {}),
    };
  }

  /**
   * Platform forwards PETCLINIC's one-time credential through this already signed server channel.
   * The token is encrypted immediately and is never returned, logged or written to PlatformEvent.
   */
  private async applyPetclinicSource(tx: Prisma.TransactionClient, type: string, platformTenantId: string, occurredAt: Date, body: Record<string, any>): Promise<string> {
    const tenant = await tx.crmTenant.findUnique({ where: { platformTenantId } });
    if (!tenant) return 'IGNORED_UNKNOWN_TENANT';
    const source = body?.source || body?.petclinicSource || {};
    const productValue = String(source.sourceProduct || body?.productCode || 'PETCLINIC_ESSENTIAL');
    if (!['PETCLINIC_ESSENTIAL', 'PETCLINIC_OPERATING'].includes(productValue)) throw new UnprocessableEntityException('Wrong PETCLINIC product');
    if (body?.productCode !== productValue || source.sourceProduct !== productValue) throw new UnprocessableEntityException('PETCLINIC product identity mismatch');
    const sourceProduct = productValue as SourceProduct;
    if (body?.version !== 1) throw new BadRequestException('Unsupported PETCLINIC source contract version');
    const sourceInstallationId = String(source.installationId || '');
    if (!UUID.test(sourceInstallationId)) throw new BadRequestException('Invalid PETCLINIC source installation');
    const sourceRevision = Number(source.revision);
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1) throw new BadRequestException('Invalid PETCLINIC source revision');
    const existingInstallation = await tx.installation.findUnique({ where: { tenantId_sourceProduct: { tenantId: platformTenantId, sourceProduct } }, include: { petclinicConnection: true } });
    const existingConnection = existingInstallation?.petclinicConnection;
    const sourceOwner = await tx.petclinicConnection.findUnique({ where: { sourceInstallationId }, include: { installation: { select: { tenantId: true, sourceProduct: true } } } });
    if (sourceOwner && (sourceOwner.installation.tenantId !== platformTenantId || sourceOwner.installation.sourceProduct !== sourceProduct)) throw new ConflictException('PETCLINIC_SOURCE_ALREADY_BOUND');
    if (existingConnection?.sourceInstallationId && existingConnection.sourceInstallationId !== sourceInstallationId) throw new ConflictException('PETCLINIC_SOURCE_INSTALLATION_MISMATCH');

    // A delayed provisioning snapshot must never roll a newer endpoint, branch scope or
    // credential back. Credential rotations and revocations are security events and are
    // deliberately applied regardless of their business timestamp.
    if (type !== 'petclinic_source.revoked' && existingConnection?.sourceRevision && sourceRevision <= existingConnection.sourceRevision) return 'IGNORED_STALE';

    if (type === 'petclinic_source.revoked') {
      if (!existingInstallation) return 'IGNORED_UNKNOWN_SOURCE';
      const revokeRevision = Math.max(existingConnection?.sourceRevision ?? 0, sourceRevision);
      const revokeUpdatedAt = existingConnection?.sourceUpdatedAt && existingConnection.sourceUpdatedAt > occurredAt ? existingConnection.sourceUpdatedAt : occurredAt;
      await tx.petclinicConnection.updateMany({ where: { installationId: existingInstallation.id }, data: { active: false, apiTokenEnc: null, credentialExpiresAt: null, sourceUpdatedAt: revokeUpdatedAt, sourceInstallationId, sourceRevision: revokeRevision, contractVersion: 1, lastSyncStatus: 'REVOKED', lastError: null } });
      await tx.installation.update({ where: { id: existingInstallation.id }, data: { status: InstallationStatus.REVOKED, paused: true, revokedAt: new Date() } });
      await tx.careJob.updateMany({ where: { installationId: existingInstallation.id, status: { in: ['QUEUED', 'PROCESSING'] } }, data: { status: 'CANCELLED', cancelledAt: new Date(), failureCode: 'PETCLINIC_SOURCE_REVOKED', lockedAt: null, lockedBy: null } });
      return 'APPLIED';
    }

    if (type === 'petclinic_source.status_changed') {
      if (!existingInstallation || !existingConnection) return 'IGNORED_UNKNOWN_SOURCE';
      const rawStatus = String(source.status || body?.status || '').toUpperCase();
      if (!['ACTIVE', 'SUSPENDED', 'REVOKED'].includes(rawStatus)) throw new BadRequestException('Invalid PETCLINIC source status');
      const status = rawStatus === 'ACTIVE' ? InstallationStatus.ACTIVE : rawStatus === 'REVOKED' ? InstallationStatus.REVOKED : InstallationStatus.SUSPENDED;
      await tx.installation.update({ where: { id: existingInstallation.id }, data: { status, paused: status !== InstallationStatus.ACTIVE, revokedAt: status === InstallationStatus.REVOKED ? new Date() : null } });
      await tx.petclinicConnection.update({ where: { installationId: existingInstallation.id }, data: { active: status === InstallationStatus.ACTIVE && !!existingConnection.apiTokenEnc, sourceUpdatedAt: occurredAt, sourceInstallationId, sourceRevision, contractVersion: 1, lastSyncStatus: status } });
      return 'APPLIED';
    }

    const apiBaseUrl = this.petclinicOrigin(source.apiBaseUrl);
    const apiTenantId = String(source.apiTenantId || '');
    if (apiTenantId !== platformTenantId) throw new UnprocessableEntityException('PETCLINIC tenant mismatch');
    const allowedBranchIds: string[] = Array.isArray(source.allowedBranchIds) ? [...new Set<string>(source.allowedBranchIds.map((value: unknown) => String(value)))] : [];
    if (!allowedBranchIds.length || allowedBranchIds.length > 200 || allowedBranchIds.some((id) => !UUID.test(id))) throw new UnprocessableEntityException('Invalid PETCLINIC branch scope');
    const token = String(source?.credential?.token || source.apiToken || '');
    if (!/^pccrm_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{40,80}$/.test(token)) throw new BadRequestException('Invalid PETCLINIC credential');
    const credentialExpiresAt = source.credentialExpiresAt === undefined ? null : toDate(source.credentialExpiresAt);
    if (source.credentialExpiresAt !== undefined && !credentialExpiresAt) throw new BadRequestException('Invalid credential expiry');
    const credentialKeyId = String(source?.credential?.keyId || source.keyId || token.slice(6, 18)).slice(0, 80);
    const appointmentsPath = source.appointmentsPath === undefined ? '/clinic-service/api/v1/clinic/appointments' : String(source.appointmentsPath);
    if (appointmentsPath !== '/clinic-service/api/v1/clinic/appointments') throw new UnprocessableEntityException('Invalid PETCLINIC appointments path');
    const installation = existingInstallation
      ? await tx.installation.update({ where: { id: existingInstallation.id }, data: { status: InstallationStatus.ACTIVE, paused: false, revokedAt: null, scopes: ['care:job:create', 'care:job:read', 'care:job:cancel'], expiresAt: credentialExpiresAt } })
      : await tx.installation.create({ data: { tenantId: platformTenantId, sourceProduct, status: InstallationStatus.ACTIVE, scopes: ['care:job:create', 'care:job:read', 'care:job:cancel'], expiresAt: credentialExpiresAt } });
    await tx.petclinicConnection.upsert({ where: { installationId: installation.id }, create: {
      installationId: installation.id, apiBaseUrl, apiTokenEnc: this.crypto.encrypt(token), apiTenantId, allowedBranchIds,
      sourceProduct, credentialKeyId, credentialExpiresAt, sourceUpdatedAt: occurredAt, sourceInstallationId, sourceRevision, contractVersion: 1, pilotAllowedPhoneHashes: [], appointmentsPath, active: true,
    }, update: {
      apiBaseUrl, apiTokenEnc: this.crypto.encrypt(token), apiTenantId, allowedBranchIds, sourceProduct, credentialKeyId,
      credentialExpiresAt, sourceUpdatedAt: occurredAt, sourceInstallationId, sourceRevision, contractVersion: 1, appointmentsPath, active: true, lastError: null, lastSyncStatus: null,
    } });
    return 'APPLIED';
  }

  private petclinicOrigin(value: unknown): string {
    let url: URL;
    try { url = new URL(String(value || '')); } catch { throw new BadRequestException('Invalid PETCLINIC API URL'); }
    const localAllowed = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localAllowed) throw new UnprocessableEntityException('PETCLINIC API requires HTTPS');
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new UnprocessableEntityException('PETCLINIC API must be an origin');
    return url.origin;
  }

  /**
   * Termination lifecycle. Same signature/replay checks as every other event, but a redelivery answers
   * with the current ledger status (and re-issues a pending export) instead of a bare `duplicate`, because
   * Platform decides COMPLETED/PURGE_BLOCKED from this body. A failed purge rolls back everything,
   * including the event row, so the next Platform retry with the same eventId genuinely runs again.
   */
  private async receiveLifecycle(eventId: string, type: string, platformTenantId: string, occurredAt: Date, body: Record<string, any>, payloadHash: string) {
    const input = this.lifecycle.parseDeletion(body);
    const prior = await this.prisma.platformEvent.findUnique({ where: { eventId } });
    if (prior) return this.replay(eventId, type, platformTenantId, input);
    if (type === 'tenant.purge_requested') await this.lifecycle.assertPurgeAllowed(platformTenantId, input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.platformEvent.create({ data: { eventId, type, platformTenantId, occurredAt, result: 'PROCESSING', payloadHash } });
        const out: { result: string; status: object | null; export?: unknown; exportChecksum?: string | null } =
          type === 'tenant.deletion_requested' ? await this.lifecycle.requestDeletion(tx, platformTenantId, input)
          : type === 'tenant.deletion_cancelled' ? await this.lifecycle.cancelDeletion(tx, platformTenantId, input.requestId, this.entitlementData(body), occurredAt)
          : await this.lifecycle.purge(tx, platformTenantId, input.requestId);
        await tx.platformEvent.update({ where: { eventId }, data: { result: out.result } });
        await tx.auditLog.create({ data: { tenantId: platformTenantId, actorType: 'PLATFORM', actorId: 'platform-admin', action: `PLATFORM_EVENT_${type.replace(/[.]/g, '_').toUpperCase()}`, targetType: 'CrmTenant', targetId: platformTenantId, result: out.result === 'APPLIED' ? 'SUCCESS' : 'NO_CHANGE', reason: out.result, metadata: { eventId, requestId: input.requestId } } });
        return { accepted: true, eventId, result: out.result, ...(out.status ?? {}), ...(out.export !== undefined ? { export: out.export, exportChecksum: out.exportChecksum } : {}) };
      }, LIFECYCLE_TX);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && String(error.meta?.target ?? '').includes('eventId')) {
        return this.replay(eventId, type, platformTenantId, input);
      }
      if (type === 'tenant.purge_requested' && !(error instanceof HttpException && error.getStatus() < 500)) {
        throw this.lifecycle.failure(await this.lifecycle.markFailed(input.requestId, error));
      }
      throw error;
    }
  }

  private async replay(eventId: string, type: string, platformTenantId: string, input: DeletionInput) {
    const status = await this.lifecycle.currentStatus(input.requestId);
    if (status && status.platformTenantId !== platformTenantId) throw new ConflictException('REQUEST_TENANT_MISMATCH');
    const base = { accepted: true, eventId, duplicate: true, ...(status ?? {}) };
    if (type !== 'tenant.deletion_requested' || status?.status !== 'PENDING') return base;
    // Platform may have lost the first response: re-issue the export (read-only) so it is never stranded.
    const exported = await this.prisma.$transaction((tx) => this.lifecycle.buildExport(tx, platformTenantId), LIFECYCLE_TX);
    const exportChecksum = createHash('sha256').update(JSON.stringify(exported)).digest('hex');
    await this.prisma.crmTenantDeletion.update({ where: { requestId: input.requestId }, data: { exportChecksum } });
    return { ...base, export: exported, exportChecksum };
  }

  private async apply(tx: Prisma.TransactionClient, type: string, platformTenantId: string, occurredAt: Date, body: Record<string, any>): Promise<string> {
    const existing = await tx.crmTenant.findUnique({ where: { platformTenantId } });
    const ent = body?.entitlement || {};
    const entitlementData = this.entitlementData(body);
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
        ...(typeof body?.platformApiBaseUrl === 'string' ? { platformApiBaseUrl: body.platformApiBaseUrl.slice(0, 300) } : {}),
        ...(body?.source?.productCode === 'B2B_SALE' ? { b2bSourceStatus: String(body.source.status || 'NOT_GRANTED').slice(0, 20), b2bSourceUpdatedAt: occurredAt } : {}),
      };
      await tx.crmTenant.upsert({ where: { platformTenantId }, create: { platformTenantId, ...data }, update: data });
      await this.syncB2bInstallation(tx, platformTenantId, body?.source, body?.platformApiBaseUrl);
      return 'APPLIED';
    }
    if (!existing) return 'IGNORED_UNKNOWN_TENANT';
    if (type === 'source.changed') {
      if (body?.source?.productCode !== 'B2B_SALE') throw new UnprocessableEntityException('Wrong source product');
      await tx.crmTenant.update({ where: { platformTenantId }, data: { b2bSourceStatus: String(body.source.status || 'NOT_GRANTED').slice(0, 20), b2bSourceUpdatedAt: occurredAt } });
      await this.syncB2bInstallation(tx, platformTenantId, body.source, existing.platformApiBaseUrl);
      return 'APPLIED';
    }
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

  private async syncB2bInstallation(tx: Prisma.TransactionClient, tenantId: string, source: Record<string, any> | undefined, platformApiBaseUrl?: string | null) {
    if (source?.productCode !== 'B2B_SALE') return;
    const usable = ['ACTIVE', 'TRIAL'].includes(String(source.status));
    const base = String(platformApiBaseUrl || '').replace(/\/$/, '');
    const installation = await tx.installation.upsert({
      where: { tenantId_sourceProduct: { tenantId, sourceProduct: 'B2B_SALE' } },
      create: { tenantId, sourceProduct: 'B2B_SALE', status: usable ? 'ACTIVE' : 'SUSPENDED', scopes: ['care:job:create', 'care:job:read', 'care:job:cancel'], sourceVerifyUrl: base ? `${base}/crm-b2b-source/receivables` : null, paused: !usable },
      update: { status: usable ? 'ACTIVE' : 'SUSPENDED', paused: !usable, sourceVerifyUrl: base ? `${base}/crm-b2b-source/receivables` : undefined, lastError: usable ? null : 'B2B entitlement inactive' },
    });
    await tx.messageTemplate.upsert({
      where: { installationId_code: { installationId: installation.id, code: 'B2B_DEBT_REMINDER_V1' } },
      create: { installationId: installation.id, code: 'B2B_DEBT_REMINDER_V1', body: 'Kính gửi {{customerName}}, chứng từ {{documentCode}} còn {{remainingAmount}} và đến hạn {{dueAt}}.', allowedVariables: ['customerName', 'documentCode', 'remainingAmount', 'dueAt'] },
      update: {},
    });
  }
}
