import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConsentStatus, SourceProduct } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { normalizeVietnamPhone } from '../common/phone';
import { CareJobsService } from '../care-jobs/care-jobs.service';
import { PetclinicClientService } from './petclinic-client.service';
import { isReminderEligible, PetclinicAppointment } from './petclinic.types';
import { TenantAccessService } from '../crm/tenant-access.service';

@Injectable()
export class PetclinicSyncService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly client: PetclinicClientService, private readonly jobs: CareJobsService, private readonly tenantAccess: TenantAccessService) {}

  async configure(installationId: string, input: Record<string, any>, actorId: string, actorType = 'PLATFORM_ADMIN') {
    const installation = await this.prisma.installation.findUnique({ where: { id: installationId } });
    if (!installation || (installation.sourceProduct !== SourceProduct.PETCLINIC_OPERATING && installation.sourceProduct !== SourceProduct.PETCLINIC_ESSENTIAL)) throw new NotFoundException();
    const base = new URL(String(input.apiBaseUrl || ''));
    if (base.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(base.hostname))) throw new ConflictException('PETCLINIC API must use HTTPS');
    const token = String(input.apiToken || ''); const tenantId = String(input.apiTenantId || '');
    if (token.length < 16 || !tenantId) throw new ConflictException('Invalid PETCLINIC credential');
    const allowedBranches = Array.isArray(input.allowedBranchIds) ? input.allowedBranchIds.map(String) : [];
    if (!allowedBranches.length) throw new ConflictException('At least one approved branch is required');
    const hashes = (Array.isArray(input.pilotAllowedPhones) ? input.pilotAllowedPhones : []).map((phone: unknown) => this.crypto.phoneHash(normalizeVietnamPhone(phone)));
    const connection = await this.prisma.petclinicConnection.upsert({ where: { installationId }, create: {
      installationId, apiBaseUrl: base.origin, apiTokenEnc: this.crypto.encrypt(token), apiTenantId: tenantId,
      allowedBranchIds: allowedBranches, pilotAllowedPhoneHashes: hashes, sourceProduct: installation.sourceProduct,
      reminderLeadMinutes: Math.max(15, Math.min(10080, Number(input.reminderLeadMinutes || 1440))), active: input.active === true,
    }, update: {
      apiBaseUrl: base.origin, apiTokenEnc: this.crypto.encrypt(token), apiTenantId: tenantId,
      allowedBranchIds: allowedBranches, pilotAllowedPhoneHashes: hashes, sourceProduct: installation.sourceProduct,
      reminderLeadMinutes: Math.max(15, Math.min(10080, Number(input.reminderLeadMinutes || 1440))), active: input.active === true,
    }});
    await this.prisma.auditLog.create({ data: { installationId, tenantId: installation.tenantId, actorType, actorId, action: 'PETCLINIC_CONNECTION_CONFIGURED', targetType: 'PetclinicConnection', targetId: connection.id, result: 'SUCCESS', metadata: { active: connection.active, branchCount: connection.allowedBranchIds.length, pilotAllowCount: hashes.length } } });
    return { installationId, active: connection.active, branchCount: connection.allowedBranchIds.length, pilotAllowCount: hashes.length, secretStoredEncrypted: true };
  }

  async sync(installationId: string, input: Record<string, any>, actorId: string, actorType = 'PLATFORM_ADMIN') {
    const installation = await this.prisma.installation.findUnique({ where: { id: installationId } });
    const connection = await this.prisma.petclinicConnection.findUnique({ where: { installationId } });
    if (!installation || !connection) throw new NotFoundException();
    if (!connection.active || installation.status !== 'ACTIVE' || installation.paused) throw new ConflictException('PETCLINIC_CONNECTION_INACTIVE');
    const access = await this.tenantAccess.canCreateJobs(installation.tenantId);
    if (!access.ok) throw new ConflictException(access.code);
    const dryRun = input.commit !== true;
    const from = input.from ? new Date(String(input.from)) : new Date();
    const to = input.to ? new Date(String(input.to)) : new Date(Date.now() + 7 * 86400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 31 * 86400_000) throw new ConflictException('Invalid sync range');
    try {
      const appointments = await this.client.list(connection, from, to, installation.timezone);
      const decisions = appointments.map((appointment) => this.decide(connection.allowedBranchIds, connection.pilotAllowedPhoneHashes, appointment));
      let created = 0; let cancelled = 0;
      if (!dryRun) {
        const ctx = { installation, installationId, tenantId: installation.tenantId, sourceProduct: installation.sourceProduct, scopes: installation.scopes };
        for (const item of decisions) {
          const externalReferenceId = `appointment:${item.appointment.id}`;
          if (!item.eligible) {
            const result = await this.prisma.careJob.updateMany({ where: { installationId, externalReferenceId, status: { in: ['QUEUED', 'PROCESSING'] } }, data: { status: 'CANCELLED', cancelledAt: new Date(), failureCode: `SOURCE_${item.reason}` } });
            cancelled += result.count; continue;
          }
          const scheduledAt = new Date(item.appointment.appointmentAt.getTime() - connection.reminderLeadMinutes * 60_000);
          cancelled += (await this.prisma.careJob.updateMany({ where: { installationId, externalReferenceId, status: { in: ['QUEUED', 'PROCESSING'] }, scheduledAt: { not: scheduledAt } }, data: { status: 'CANCELLED', cancelledAt: new Date(), failureCode: 'SOURCE_RESCHEDULED' } })).count;
          const result = await this.jobs.create(ctx as any, { sourceProduct: installation.sourceProduct, externalReferenceId, eventType: 'APPOINTMENT_REMINDER', recipient: { name: item.appointment.ownerName, phone: item.appointment.phone }, templateCode: 'PC_APPT_REMINDER_V1', templateVariables: { ownerName: item.appointment.ownerName, petName: item.appointment.petName, appointmentTime: item.appointment.appointmentAt.toISOString(), serviceName: item.appointment.serviceName }, scheduledAt: scheduledAt.toISOString(), sourceAppointmentAt: item.appointment.appointmentAt.toISOString(), sourceRevision: item.appointment.revision, consentStatus: ConsentStatus.GRANTED, branchId: item.appointment.branchId ? String(item.appointment.branchId) : undefined, idempotencyKey: `${externalReferenceId}:${item.appointment.appointmentAt.toISOString()}:${item.appointment.revision}` });
          if (result.replay !== true) created++;
        }
      }
      await this.prisma.petclinicConnection.update({ where: { installationId }, data: { lastSyncAt: new Date(), lastSyncStatus: dryRun ? 'DRY_RUN' : 'SUCCESS', lastError: null } });
      await this.prisma.auditLog.create({ data: { installationId, tenantId: installation.tenantId, actorType, actorId, action: dryRun ? 'PETCLINIC_SYNC_PREVIEWED' : 'PETCLINIC_SYNC_COMMITTED', targetType: 'PetclinicConnection', targetId: connection.id, result: 'SUCCESS', metadata: { scanned: appointments.length, eligible: decisions.filter((x) => x.eligible).length, created, cancelled } } });
      return { dryRun, scanned: appointments.length, eligible: decisions.filter((x) => x.eligible).length, created, cancelled, skippedByReason: this.countReasons(decisions) };
    } catch (error) {
      await this.prisma.petclinicConnection.update({ where: { installationId }, data: { lastSyncAt: new Date(), lastSyncStatus: 'FAILED', lastError: (error instanceof Error ? error.message : 'SYNC_FAILED').slice(0, 500) } });
      throw error;
    }
  }

  async verify(installationId: string, externalReferenceId: string, expectedAppointmentAt: Date | null, expectedRevision: string | null): Promise<boolean> {
    const connection = await this.prisma.petclinicConnection.findUnique({ where: { installationId } });
    if (!connection?.active || !externalReferenceId.startsWith('appointment:') || !expectedAppointmentAt || !expectedRevision) return false;
    const id = externalReferenceId.slice('appointment:'.length);
    return this.client.revalidate(connection, id, expectedAppointmentAt, expectedRevision);
  }

  private decide(branches: string[], phoneHashes: string[], appointment: PetclinicAppointment) {
    let reason = 'ELIGIBLE';
    if (!isReminderEligible(appointment)) reason = 'STATUS_INELIGIBLE';
    else if (!appointment.branchId || !branches.includes(appointment.branchId)) reason = 'BRANCH_NOT_APPROVED';
    else if (!appointment.ownerName || !appointment.phone) reason = 'CONTACT_MISSING';
    else if (!appointment.consentGranted) reason = 'CONSENT_MISSING';
    else { try { if (phoneHashes.length && !phoneHashes.includes(this.crypto.phoneHash(normalizeVietnamPhone(appointment.phone)))) reason = 'NOT_IN_PILOT_ALLOWLIST'; } catch { reason = 'PHONE_INVALID'; } }
    return { appointment, eligible: reason === 'ELIGIBLE', reason };
  }

  private countReasons(rows: Array<{ eligible: boolean; reason: string }>) { return rows.reduce<Record<string, number>>((out, row) => { if (!row.eligible) out[row.reason] = (out[row.reason] || 0) + 1; return out; }, {}); }
}
