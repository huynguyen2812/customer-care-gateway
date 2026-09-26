import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { branchIdMatchesNamespace, isLicensedSource, licensedSourceOf, LicenseGateService } from './platform/license-gate.service';
import { Installation, SourceConnection } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { maskPhone } from '../crm/crm-redact';
import { normalizeVietnamPhone } from '../common/phone';
import { CareJobsService } from '../care-jobs/care-jobs.service';
import { TenantAccessService } from '../crm/tenant-access.service';
import type { CrmContext } from '../crm/crm-session.service';
import { appointmentConsentAllowed, assertConnectorBaseUrl, receivableConsentAllowed, SourceAppointment, SourceConnectorClient, SourceReceivable } from './source-connector.client';

export const APPOINTMENT_TEMPLATE = 'APPT_REMINDER_V1';
export const DEBT_TEMPLATE = 'DEBT_REMINDER_V1';
const REMINDABLE = ['SCHEDULED', 'CONFIRMED'];

const viTime = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
const viMoney = new Intl.NumberFormat('vi-VN');

function sourceError(error: unknown): never {
  const code = error instanceof Error && /^SOURCE_[A-Z0-9_]+$/.test(error.message) ? error.message : 'SOURCE_UNAVAILABLE';
  throw new BadGatewayException({ code, message: 'Không đọc được dữ liệu từ hệ thống nguồn.' });
}

/**
 * Standalone source connector: reads appointments/receivables from the customer's own system and turns
 * eligible rows into idempotent care jobs. Mirrors PetclinicSyncService (dry-run by default, approved
 * branches, consent gate, reschedule/cancel handling) and B2bSourceService (manual debt reminder).
 */
@Injectable()
export class SourceConnectorService {
  constructor(private readonly prisma: PrismaService, private readonly client: SourceConnectorClient, private readonly jobs: CareJobsService, private readonly tenantAccess: TenantAccessService, @Optional() private readonly licence?: LicenseGateService) {}

  /**
   * Branches Platform licensed for THIS connector's source entry (PC edition, once a signed config exists).
   * null = no signed configuration yet (not activated): configuring and previewing stay possible, and activation later
   * shrinks the branch list to the licensed ones; nothing can be created or sent before that anyway.
   */
  private async licensedBranches(kind: string | null | undefined): Promise<Set<string> | null> {
    if (!this.licence) return null;
    const d = await this.licence.evaluate();
    if (d.mode !== 'MANAGED' || !d.config) return null;
    return this.licence.licensedBranches(d.config, isLicensedSource(kind) ? kind : null);
  }

  async installationFor(tenantId: string): Promise<Installation> {
    const inst = await this.prisma.installation.findUnique({ where: { tenantId_sourceProduct: { tenantId, sourceProduct: 'EXTERNAL_CONNECTOR' } } });
    if (!inst) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Không tìm thấy dữ liệu.' });
    return inst;
  }

  async get(ctx: CrmContext) {
    const inst = await this.installationFor(ctx.platformTenantId);
    const c = await this.prisma.sourceConnection.findUnique({ where: { installationId: inst.id } });
    return { installationId: inst.id, configured: !!c, connection: c && { sourceKind: c.sourceKind, apiBaseUrl: c.apiBaseUrl, appointmentsEnabled: c.appointmentsEnabled, receivablesEnabled: c.receivablesEnabled, allowedBranchIds: c.allowedBranchIds, reminderLeadMinutes: c.reminderLeadMinutes, active: c.active, lastSyncAt: c.lastSyncAt, lastSyncStatus: c.lastSyncStatus, lastError: c.lastError } };
  }

  async configure(ctx: CrmContext, input: Record<string, unknown>) {
    const inst = await this.installationFor(ctx.platformTenantId);
    let base: URL;
    try { base = assertConnectorBaseUrl(String(input.apiBaseUrl || '')); } catch (e) { throw new BadRequestException({ code: (e as Error).message, message: 'Địa chỉ hệ thống nguồn không hợp lệ (cần HTTPS hoặc máy nội bộ).' }); }
    const branches = Array.isArray(input.allowedBranchIds) ? [...new Set(input.allowedBranchIds.map(String).filter((b) => /^[A-Za-z0-9._:-]{1,80}$/.test(b)))] : [];
    if (!branches.length) throw new BadRequestException({ code: 'BRANCH_REQUIRED', message: 'Cần ít nhất một chi nhánh được duyệt.' });
    const previous = await this.prisma.sourceConnection.findUnique({ where: { installationId: inst.id } });
    // The owner states explicitly which kind of system this is; it selects the Platform source entry (never guessed).
    const sourceKind = input.sourceKind ?? previous?.sourceKind;
    if (!isLicensedSource(sourceKind)) throw new BadRequestException({ code: 'SOURCE_KIND_REQUIRED', message: 'Chọn loại hệ thống nguồn (PETCLINIC, B2B SALE hoặc hệ thống khác).' });
    // Once Platform manages this PC the owner may only choose a subset of the branches Platform granted to THIS source.
    const licensed = await this.licensedBranches(sourceKind);
    if (licensed && branches.some((b) => !branchIdMatchesNamespace(sourceKind, b))) throw new BadRequestException({ code: 'BRANCH_MAPPING_REQUIRED', message: 'Mã chi nhánh phải là mã chi nhánh Platform (UUID) đã ánh xạ từ hệ thống nguồn.' });
    if (licensed && branches.some((b) => !licensed.has(b))) throw new BadRequestException({ code: 'BRANCH_NOT_LICENSED', message: 'Có chi nhánh nằm ngoài danh sách Platform đã cấp cho nguồn này.' });
    const entry = licensed && this.licence ? this.licence.sourceEntry((await this.licence.evaluate()).config, sourceKind) : null;
    if (entry?.maxBranches != null && branches.length > entry.maxBranches) throw new BadRequestException({ code: 'BRANCH_LIMIT_EXCEEDED', message: `Gói chỉ cho tối đa ${entry.maxBranches} chi nhánh.` });
    const lead = Math.max(15, Math.min(10080, Number(input.reminderLeadMinutes) || 1440));
    const data = { sourceKind, apiBaseUrl: base.toString().replace(/\/$/, ''), appointmentsEnabled: input.appointmentsEnabled !== false, receivablesEnabled: input.receivablesEnabled === true, allowedBranchIds: branches, reminderLeadMinutes: lead, active: input.active === true };
    const kindChanged = !!previous?.sourceKind && previous.sourceKind !== sourceKind;
    const { c, cancelled } = await this.prisma.$transaction(async (tx) => {
      const c = await tx.sourceConnection.upsert({ where: { installationId: inst.id }, create: { installationId: inst.id, ...data }, update: data });
      // Jobs queued for the previous source were licensed under another Platform entry: they end here (the worker would too).
      const cancelled = kindChanged ? (await tx.careJob.updateMany({ where: { installationId: inst.id, status: 'QUEUED', OR: [{ licenseSource: null }, { licenseSource: { not: sourceKind } }] }, data: { status: 'CANCELLED', cancelledAt: new Date(), failureCode: 'SOURCE_KIND_CHANGED' } })).count : 0;
      return { c, cancelled };
    });
    await this.prisma.auditLog.create({ data: { installationId: inst.id, tenantId: ctx.platformTenantId, actorType: 'CRM_USER', actorId: ctx.platformUserId, action: 'SOURCE_CONNECTOR_CONFIGURED', targetType: 'SourceConnection', targetId: c.id, result: 'SUCCESS', metadata: { active: c.active, sourceKind, kindChanged, cancelledJobs: cancelled, branchCount: branches.length, appointments: c.appointmentsEnabled, receivables: c.receivablesEnabled } } });
    return this.get(ctx);
  }

  private async activeConnection(tenantId: string): Promise<{ inst: Installation; conn: SourceConnection }> {
    const inst = await this.installationFor(tenantId);
    const conn = await this.prisma.sourceConnection.findUnique({ where: { installationId: inst.id } });
    if (!conn) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Không tìm thấy dữ liệu.' });
    if (!conn.active || inst.status !== 'ACTIVE' || inst.paused) throw new ConflictException({ code: 'SOURCE_CONNECTION_INACTIVE', message: 'Kết nối nguồn dữ liệu đang tắt.' });
    return { inst, conn };
  }

  decideAppointment(conn: SourceConnection, a: SourceAppointment, licensed: Set<string> | null = null): string {
    if (!REMINDABLE.includes(a.status)) return 'STATUS_INELIGIBLE';
    if (!a.branchId || !conn.allowedBranchIds.includes(a.branchId)) return 'BRANCH_NOT_APPROVED';
    if (licensed && !isLicensedSource(conn.sourceKind)) return 'SOURCE_KIND_REQUIRED';
    if (licensed && !branchIdMatchesNamespace(conn.sourceKind as never, a.branchId)) return 'BRANCH_MAPPING_REQUIRED';
    if (licensed && !licensed.has(a.branchId)) return 'BRANCH_NOT_LICENSED';
    if (!a.customerName || !a.phone) return 'CONTACT_MISSING';
    if (!a.revision) return 'REVISION_MISSING';
    if (!appointmentConsentAllowed(a.consent)) return a.consent ? 'CONSENT_BLOCKED' : 'CONSENT_MISSING';
    try { normalizeVietnamPhone(a.phone); } catch { return 'PHONE_INVALID'; }
    return 'ELIGIBLE';
  }

  /** Dry-run unless commit === true. Never sends; only creates/cancels queued jobs. */
  async syncAppointments(ctx: CrmContext, input: Record<string, unknown>) {
    const { inst, conn } = await this.activeConnection(ctx.platformTenantId);
    if (!conn.appointmentsEnabled) throw new ConflictException({ code: 'APPOINTMENTS_DISABLED', message: 'Chưa bật đồng bộ lịch hẹn.' });
    const commit = input.commit === true;
    if (commit) {
      const access = await this.tenantAccess.canCreateJobs(ctx.platformTenantId, { sourceProduct: licensedSourceOf('EXTERNAL_CONNECTOR', conn.sourceKind), eventType: 'APPOINTMENT_REMINDER' });
      if (!access.ok) throw new ForbiddenException({ code: access.code });
    }
    const from = input.from ? new Date(String(input.from)) : new Date();
    const to = input.to ? new Date(String(input.to)) : new Date(Date.now() + 7 * 86400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 31 * 86400_000) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'Khoảng thời gian không hợp lệ (tối đa 31 ngày).' });
    let rows: SourceAppointment[];
    try { rows = await this.client.appointments(conn, from, to); }
    catch (e) { await this.markSync(conn.id, 'FAILED', (e as Error).message); sourceError(e); }
    const licensed = await this.licensedBranches(conn.sourceKind);
    const decisions = rows.map((a) => ({ a, reason: this.decideAppointment(conn, a, licensed) }));
    let created = 0; let cancelled = 0;
    if (commit) {
      const jobCtx = { installation: inst, installationId: inst.id, tenantId: inst.tenantId, sourceProduct: inst.sourceProduct, scopes: inst.scopes };
      for (const { a, reason } of decisions) {
        const externalReferenceId = `appointment:${a.id}`;
        if (reason !== 'ELIGIBLE') {
          cancelled += (await this.prisma.careJob.updateMany({ where: { installationId: inst.id, externalReferenceId, status: 'QUEUED' }, data: { status: 'CANCELLED', cancelledAt: new Date(), failureCode: `SOURCE_${reason}` } })).count;
          continue;
        }
        const scheduledAt = new Date(a.appointmentAt.getTime() - conn.reminderLeadMinutes * 60_000);
        cancelled += (await this.prisma.careJob.updateMany({ where: { installationId: inst.id, externalReferenceId, status: 'QUEUED', OR: [{ sourceRevision: { not: a.revision } }, { scheduledAt: { not: scheduledAt } }] }, data: { status: 'CANCELLED', cancelledAt: new Date(), failureCode: 'SOURCE_RESCHEDULED' } })).count;
        const r = await this.jobs.create(jobCtx, {
          sourceProduct: 'EXTERNAL_CONNECTOR', externalReferenceId, eventType: 'APPOINTMENT_REMINDER', recipient: { name: a.customerName, phone: a.phone },
          templateCode: APPOINTMENT_TEMPLATE, templateVariables: { customerName: a.customerName, petName: a.petName, serviceName: a.serviceName, appointmentTime: viTime.format(a.appointmentAt) },
          scheduledAt: scheduledAt.toISOString(), sourceAppointmentAt: a.appointmentAt.toISOString(), sourceRevision: a.revision, consentStatus: 'GRANTED',
          branchId: a.branchId || undefined, idempotencyKey: `${externalReferenceId}:${a.appointmentAt.toISOString()}:${a.revision}`,
        });
        if (r.replay !== true && r.status !== 'OPTED_OUT') created++;
      }
    }
    await this.markSync(conn.id, commit ? 'SUCCESS' : 'DRY_RUN', null);
    const eligible = decisions.filter((d) => d.reason === 'ELIGIBLE').length;
    const skippedByReason = decisions.reduce<Record<string, number>>((o, d) => { if (d.reason !== 'ELIGIBLE') o[d.reason] = (o[d.reason] || 0) + 1; return o; }, {});
    await this.prisma.auditLog.create({ data: { installationId: inst.id, tenantId: ctx.platformTenantId, actorType: 'CRM_USER', actorId: ctx.platformUserId, action: commit ? 'SOURCE_SYNC_COMMITTED' : 'SOURCE_SYNC_PREVIEWED', targetType: 'SourceConnection', targetId: conn.id, result: 'SUCCESS', metadata: { scanned: rows.length, eligible, created, cancelled } } });
    return { dryRun: !commit, scanned: rows.length, eligible, created, cancelled, skippedByReason };
  }

  async receivables(ctx: CrmContext) {
    const { conn } = await this.activeConnection(ctx.platformTenantId);
    if (!conn.receivablesEnabled) throw new ConflictException({ code: 'RECEIVABLES_DISABLED', message: 'Chưa bật đồng bộ công nợ.' });
    let rows: SourceReceivable[];
    try { rows = await this.client.receivables(conn); } catch (e) { sourceError(e); }
    const licensed = await this.licensedBranches(conn.sourceKind);
    return { items: rows.map((r) => {
      const reason = this.receivableReason(conn, r, licensed);
      let phoneMasked: string | null = null;
      try { phoneMasked = maskPhone(normalizeVietnamPhone(r.phone)); } catch { phoneMasked = null; }
      return { id: r.id, documentCode: r.documentCode, customerName: r.customerName, phoneMasked, remainingAmount: r.remainingAmount, dueAt: r.dueAt, branchId: r.branchId, eligible: reason === 'ELIGIBLE', ineligibleReason: reason === 'ELIGIBLE' ? null : reason };
    }) };
  }

  private receivableReason(conn: SourceConnection, r: SourceReceivable, licensed: Set<string> | null = null): string {
    if (!(r.remainingAmount > 0)) return 'NOTHING_DUE';
    if (!r.branchId || !conn.allowedBranchIds.includes(r.branchId)) return 'BRANCH_NOT_APPROVED';
    if (licensed && !isLicensedSource(conn.sourceKind)) return 'SOURCE_KIND_REQUIRED';
    if (licensed && !branchIdMatchesNamespace(conn.sourceKind as never, r.branchId)) return 'BRANCH_MAPPING_REQUIRED';
    if (licensed && !licensed.has(r.branchId)) return 'BRANCH_NOT_LICENSED';
    if (!r.customerName || !r.phone) return 'CONTACT_MISSING';
    if (!r.revision) return 'REVISION_MISSING';
    if (!receivableConsentAllowed(r.consent)) return 'CONSENT_NOT_GRANTED';
    try { normalizeVietnamPhone(r.phone); } catch { return 'PHONE_INVALID'; }
    return 'ELIGIBLE';
  }

  /** Manual debt reminder: at most one per receivable per day (idempotency key includes the day). */
  async queueReceivable(ctx: CrmContext, id: string) {
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(id)) throw new BadRequestException({ code: 'INVALID_REFERENCE' });
    const { inst, conn } = await this.activeConnection(ctx.platformTenantId);
    if (!conn.receivablesEnabled) throw new ConflictException({ code: 'RECEIVABLES_DISABLED', message: 'Chưa bật đồng bộ công nợ.' });
    let rows: SourceReceivable[];
    try { rows = await this.client.receivables(conn); } catch (e) { sourceError(e); }
    const r = rows.find((x) => x.id === id);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Không tìm thấy dữ liệu.' });
    const reason = this.receivableReason(conn, r, await this.licensedBranches(conn.sourceKind));
    if (reason !== 'ELIGIBLE') throw new ForbiddenException({ code: reason });
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
    // Already queued today: return that job (the request hash differs because scheduledAt is "now").
    const existing = await this.prisma.careJob.findUnique({ where: { installationId_idempotencyKey: { installationId: inst.id, idempotencyKey: `receivable:${r.id}:${day}` } }, select: { id: true, status: true } });
    if (existing) return { ...existing, replay: true };
    return this.jobs.create({ installation: inst, installationId: inst.id, tenantId: inst.tenantId, sourceProduct: inst.sourceProduct, scopes: inst.scopes }, {
      sourceProduct: 'EXTERNAL_CONNECTOR', externalReferenceId: `receivable:${r.id}`, eventType: 'DEBT_REMINDER', recipient: { name: r.customerName, phone: r.phone },
      templateCode: DEBT_TEMPLATE, templateVariables: { customerName: r.customerName, documentCode: r.documentCode, remainingAmount: viMoney.format(r.remainingAmount), dueAt: r.dueAt || '' },
      scheduledAt: new Date().toISOString(), sourceRevision: r.revision, consentStatus: 'GRANTED', branchId: r.branchId || undefined, idempotencyKey: `receivable:${r.id}:${day}`,
    });
  }

  /** Called by the worker right before sending. Throws when the source is unreachable (worker requeues). */
  async verify(installationId: string, externalReferenceId: string, sourceAppointmentAt: Date | null, sourceRevision: string | null): Promise<boolean> {
    const conn = await this.prisma.sourceConnection.findUnique({ where: { installationId } });
    if (!conn?.active || !sourceRevision) return false;
    if (externalReferenceId.startsWith('appointment:')) {
      if (!conn.appointmentsEnabled || !sourceAppointmentAt) return false;
      return this.client.revalidateAppointment(conn, externalReferenceId.slice('appointment:'.length), sourceAppointmentAt, sourceRevision);
    }
    if (externalReferenceId.startsWith('receivable:')) {
      if (!conn.receivablesEnabled) return false;
      return this.client.revalidateReceivable(conn, externalReferenceId.slice('receivable:'.length), sourceRevision);
    }
    return false;
  }

  private async markSync(id: string, status: string, error: string | null) {
    await this.prisma.sourceConnection.update({ where: { id }, data: { lastSyncAt: new Date(), lastSyncStatus: status, lastError: error ? error.slice(0, 500) : null } });
  }
}
