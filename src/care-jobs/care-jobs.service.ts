import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConsentStatus, Prisma, SourceProduct } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { canonicalJson, sha256 } from '../common/canonical';
import { normalizeVietnamPhone } from '../common/phone';
import { InstallationContext } from '../auth/auth.types';
import { TenantAccessService } from '../crm/tenant-access.service';

@Injectable()
export class CareJobsService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly tenantAccess: TenantAccessService) {}

  private requireScope(ctx: InstallationContext, scope: string): void {
    if (!ctx.scopes.includes(scope)) throw new ForbiddenException('Insufficient scope');
  }

  async create(ctx: InstallationContext, input: Record<string, any>): Promise<Record<string, unknown>> {
    this.requireScope(ctx, 'care:job:create');
    if (input.tenantId && input.tenantId !== ctx.tenantId) throw new ForbiddenException('Credential scope mismatch');
    if (input.sourceProduct !== ctx.sourceProduct) throw new ForbiddenException('Credential scope mismatch');
    // Source/branch/event scope is only enforced by the PC edition's Platform licence gate (no-op for the VPS edition):
    // the branch is checked against the Platform entry of THIS job's source, which is recorded on the job.
    const scopedBranch = typeof input.branchId === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(input.branchId) ? input.branchId : null;
    const licenseSource = await this.tenantAccess.licenseSourceFor(ctx.installationId, ctx.sourceProduct);
    const access = await this.tenantAccess.canCreateJobs(ctx.tenantId, { ...(licenseSource !== undefined ? { sourceProduct: licenseSource } : {}), branchId: scopedBranch, eventType: typeof input.eventType === 'string' ? input.eventType : null });
    if (!access.ok) throw new ForbiddenException(access.code);
    const required = ['externalReferenceId', 'eventType', 'templateCode', 'scheduledAt', 'idempotencyKey', 'consentStatus'];
    for (const key of required) if (!input[key]) throw new BadRequestException(`${key} is required`);
    if (!input.recipient?.name || !input.recipient?.phone) throw new BadRequestException('recipient name and phone are required');
    if (!Object.values(ConsentStatus).includes(input.consentStatus)) throw new BadRequestException('Invalid consentStatus');
    if (input.consentStatus !== ConsentStatus.GRANTED) return { status: 'OPTED_OUT', accepted: false };
    const phoneE164 = normalizeVietnamPhone(input.recipient.phone);
    const phoneHash = this.crypto.phoneHash(phoneE164);
    if (await this.prisma.optOut.findUnique({ where: { installationId_phoneHash: { installationId: ctx.installationId, phoneHash } } })) return { status: 'OPTED_OUT', accepted: false };
    const sourceAppointmentAt = input.sourceAppointmentAt ? new Date(input.sourceAppointmentAt) : null;
    if (sourceAppointmentAt && Number.isNaN(sourceAppointmentAt.getTime())) throw new BadRequestException('Invalid sourceAppointmentAt');
    const sourceRevision = input.sourceRevision === undefined || input.sourceRevision === null ? null : String(input.sourceRevision);
    if (sourceRevision !== null && (!sourceRevision.trim() || sourceRevision.length > 100)) throw new BadRequestException('Invalid sourceRevision');
    const normalized = {
      externalReferenceId: String(input.externalReferenceId), sourceProduct: input.sourceProduct,
      eventType: String(input.eventType), recipient: { name: String(input.recipient.name), phoneE164 },
      templateCode: String(input.templateCode), templateVariables: input.templateVariables || {},
      scheduledAt: new Date(input.scheduledAt).toISOString(), consentStatus: input.consentStatus,
      sourceAppointmentAt: sourceAppointmentAt?.toISOString() ?? null,
      sourceRevision,
    };
    const requestHash = sha256(canonicalJson(normalized));
    const existing = await this.prisma.careJob.findUnique({ where: { installationId_idempotencyKey: { installationId: ctx.installationId, idempotencyKey: String(input.idempotencyKey) } } });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ConflictException('IDEMPOTENCY_CONFLICT');
      return { id: existing.id, status: existing.status, replay: true };
    }
    try {
      const created = await this.prisma.careJob.create({ data: {
        installationId: ctx.installationId, idempotencyKey: String(input.idempotencyKey), requestHash,
        // Optional branch reference used only for account routing (not part of the idempotency hash).
        branchId: typeof input.branchId === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(input.branchId) ? input.branchId : null,
        externalReferenceId: normalized.externalReferenceId, sourceProduct: ctx.sourceProduct as SourceProduct, licenseSource: licenseSource ?? null,
        eventType: normalized.eventType, recipientNameEnc: this.crypto.encrypt(normalized.recipient.name),
        phoneEnc: this.crypto.encrypt(phoneE164), phoneHash, templateCode: normalized.templateCode,
        templateVariables: normalized.templateVariables as Prisma.InputJsonValue, scheduledAt: new Date(normalized.scheduledAt),
        sourceAppointmentAt: normalized.sourceAppointmentAt ? new Date(normalized.sourceAppointmentAt) : null,
        sourceRevision: normalized.sourceRevision, consentStatus: input.consentStatus,
      }});
      return { id: created.id, status: created.status, replay: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return this.create(ctx, input);
      throw error;
    }
  }

  async get(ctx: InstallationContext, id: string) {
    this.requireScope(ctx, 'care:job:read');
    const job = await this.prisma.careJob.findFirst({ where: { id, installationId: ctx.installationId }, select: { id: true, externalReferenceId: true, eventType: true, templateCode: true, scheduledAt: true, status: true, attempts: true, failureCode: true, failureReason: true, sentAt: true, createdAt: true, updatedAt: true } });
    if (!job) throw new NotFoundException();
    return job;
  }

  async cancel(ctx: InstallationContext, id: string) {
    this.requireScope(ctx, 'care:job:cancel');
    const result = await this.prisma.careJob.updateMany({ where: { id, installationId: ctx.installationId, status: { in: ['QUEUED', 'PROCESSING'] } }, data: { status: 'CANCELLED', cancelledAt: new Date(), failureCode: 'SOURCE_CANCELLED' } });
    if (!result.count) throw new NotFoundException();
    return { id, status: 'CANCELLED' };
  }

  async optOut(ctx: InstallationContext, phone: unknown, source = 'SOURCE_PRODUCT') {
    const phoneHash = this.crypto.phoneHash(normalizeVietnamPhone(phone));
    await this.prisma.$transaction([
      this.prisma.optOut.upsert({ where: { installationId_phoneHash: { installationId: ctx.installationId, phoneHash } }, create: { installationId: ctx.installationId, phoneHash, source }, update: { source } }),
      this.prisma.careJob.updateMany({ where: { installationId: ctx.installationId, phoneHash, status: 'QUEUED' }, data: { status: 'OPTED_OUT', cancelledAt: new Date(), failureCode: 'RECIPIENT_OPTED_OUT' } }),
    ]);
    return { optedOut: true };
  }
}
