import { Injectable } from '@nestjs/common';
import { PlatformDeviceRegistration } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { DesiredConfigPayload, LICENSED_SOURCES, LicensedSource } from './platform-device.contract';
import { openDeviceKey } from './platform-crypto';

export type { LicensedSource } from './platform-device.contract';
/** NOT_ACTIVATED: never paired (production default: nothing is created or sent). BYPASS: test-only override. */
export type LicenseMode = 'NOT_ACTIVATED' | 'MANAGED' | 'BYPASS';
export type LicenseDecision = {
  mode: LicenseMode;
  /** null = allowed. Otherwise a stable reason code shown to the owner and written to jobs/audit. */
  deny: string | null;
  /** Deny codes that can never be fixed by waiting (job is cancelled rather than held). */
  permanent: boolean;
  config: DesiredConfigPayload | null;
  registration: PlatformDeviceRegistration | null;
  /** Sending window of the latest verified config (null when there is none). */
  window: LicenceWindow | null;
};
/**
 * Sending window of the latest VERIFIED signed config. Nothing unsigned (HTTP 200, heartbeat ACK, replay of the same
 * revision) can move it, and the PC adds no time of its own: Platform already folded offlineGraceHours into the signed
 * expiresAt. Sending is allowed strictly before `until` (at `until` it is blocked).
 */
export type LicenceWindow = { configExpiresAt: Date; planValidUntil: Date | null; until: Date };

/** until = min(signed expiresAt, signed plan.validUntil). An unparsable plan end fails closed (treated as already over). */
export function licenceWindow(row: { payload: unknown; expiresAt: Date }): LicenceWindow {
  const p = row.payload as DesiredConfigPayload;
  const raw = p.plan?.validUntil;
  const planValidUntil = raw ? new Date(raw) : null;
  const planEnd = planValidUntil ? (Number.isNaN(planValidUntil.getTime()) ? -Infinity : planValidUntil.getTime()) : Infinity;
  return { configExpiresAt: row.expiresAt, planValidUntil, until: new Date(Math.max(0, Math.min(row.expiresAt.getTime(), planEnd))) };
}
/**
 * What a job (or a job about to be created) is licensed under. sourceProduct is the Platform source entry, resolved
 * with licensedSourceOf(); branchId/eventType are checked against THAT entry only (never a union of all sources).
 */
export type JobScope = { sourceProduct?: LicensedSource | null; branchId?: string | null; eventType?: string | null; sourceChanged?: boolean };

const PLAN_DENY: Record<string, string> = { SUSPENDED: 'PLAN_SUSPENDED', EXPIRED: 'PLAN_EXPIRED', TERMINATED: 'PLAN_TERMINATED' };

const PLATFORM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * PETCLINIC and B2B_SALE: the branch id on the wire must be the Platform branch UUID. EXTERNAL connectors have no
 * agreed namespace: they are never treated as compatible by default (Platform currently grants no EXTERNAL entry).
 */
export function branchIdMatchesNamespace(source: LicensedSource, branchId: string): boolean {
  return source === 'EXTERNAL' ? true : PLATFORM_UUID.test(branchId);
}

export const isLicensedSource = (v: unknown): v is LicensedSource => typeof v === 'string' && (LICENSED_SOURCES as readonly string[]).includes(v);

/**
 * Explicit mapping from CareJob/Installation.sourceProduct to the Platform source entry. EXTERNAL_CONNECTOR has no
 * fixed product: its kind is SourceConnection.sourceKind, chosen explicitly by the owner (never inferred from branch ids).
 */
export function licensedSourceOf(sourceProduct: string, connectorKind?: string | null): LicensedSource | null {
  switch (sourceProduct) {
    case 'PETCLINIC_OPERATING': case 'PETCLINIC_ESSENTIAL': return 'PETCLINIC';
    case 'B2B_SALE': return 'B2B_SALE';
    case 'EXTERNAL_CONNECTOR': return isLicensedSource(connectorKind) ? connectorKind : null;
    default: return null;
  }
}

/**
 * Test-only override for a PC that was never activated. Needs PLATFORM_LICENSE_BYPASS=1 in the process environment AND
 * a non-production NODE_ENV; the Windows services always run NODE_ENV=production and the release never writes this flag.
 * No request, cookie or browser setting can turn it on. It never applies once the PC has been paired.
 */
export function licenseBypassEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLATFORM_LICENSE_BYPASS === '1' && env.NODE_ENV !== 'production';
}

/**
 * Standalone licensing gate (Platform = control plane). Rules (decision of 2026-09-26: activation is mandatory):
 *  - Never paired (no registration or only a PENDING attempt): PLATFORM_ACTIVATION_REQUIRED ⇒ no new care jobs and no
 *    sending. Setup, login, users, the local API Client ID/Secret, source configuration/preview, backup and the
 *    activation screen keep working.
 *  - Once paired it never falls back: UNPAIRED / REVOKED / a new PENDING attempt / plan not usable / signed config
 *    expired (its expiresAt already includes the ≤72 h offline grace) — see licenceWindow() / device key not openable on this machine (restored elsewhere) ⇒ no new jobs and no sending.
 *    Nothing is deleted: jobs are HELD, data and Zalo sessions stay local.
 *  - Source, branch and feature scope come only from the latest verified (signed) configuration, per source entry.
 */
@Injectable()
export class LicenseGateService {
  private keyCheck: { enc: string; ok: boolean; at: number } | null = null;
  constructor(private readonly prisma: PrismaService) {}

  async effectiveConfig(deviceId: string): Promise<DesiredConfigPayload | null> {
    return (await this.effectiveRow(deviceId))?.payload as unknown as DesiredConfigPayload ?? null;
  }
  effectiveRow(deviceId: string) {
    return this.prisma.platformDesiredConfiguration.findFirst({ where: { deviceId, applyStatus: 'APPLIED' }, orderBy: { revision: 'desc' } });
  }

  private keyUsable(enc: string): boolean {
    if (this.keyCheck && this.keyCheck.enc === enc && Date.now() - this.keyCheck.at < 60_000) return this.keyCheck.ok;
    let ok = true; try { openDeviceKey(enc); } catch { ok = false; }
    this.keyCheck = { enc, ok, at: Date.now() };
    return ok;
  }

  /** The Platform source entry for one source product (null = Platform did not license that source at all). */
  sourceEntry(config: DesiredConfigPayload | null, source: LicensedSource | null | undefined) {
    if (!config || !source) return null;
    return config.sources.find((s) => s.product === source) ?? null;
  }

  /** Branches Platform allows for ONE source; empty set = that source has no licensed branch. */
  licensedBranches(config: DesiredConfigPayload | null, source: LicensedSource | null | undefined): Set<string> {
    return new Set(this.sourceEntry(config, source)?.allowedBranchIds ?? []);
  }

  /** Platform source for a new job of this installation (EXTERNAL_CONNECTOR ⇒ the connector's explicit kind). */
  async sourceForInstallation(installationId: string, sourceProduct: string): Promise<LicensedSource | null> {
    if (sourceProduct !== 'EXTERNAL_CONNECTOR') return licensedSourceOf(sourceProduct);
    const conn = await this.prisma.sourceConnection.findUnique({ where: { installationId }, select: { sourceKind: true } });
    return licensedSourceOf(sourceProduct, conn?.sourceKind);
  }

  /** Scope of an existing job for the pre-send check: the source recorded at creation; a changed connector kind ends it. */
  async jobScope(job: { installationId: string; sourceProduct: string; licenseSource: string | null; branchId: string | null; eventType: string }): Promise<JobScope> {
    const current = await this.sourceForInstallation(job.installationId, job.sourceProduct);
    const recorded = isLicensedSource(job.licenseSource) ? job.licenseSource : null;
    return { sourceProduct: recorded ?? current, branchId: job.branchId, eventType: job.eventType, sourceChanged: !!recorded && !!current && recorded !== current };
  }

  async evaluate(scope: JobScope = {}, now = new Date()): Promise<LicenseDecision> {
    const reg = await this.prisma.platformDeviceRegistration.findUnique({ where: { id: 1 } });
    const everPaired = !!reg && (reg.everPaired || !!reg.pairedAt || reg.status !== 'PENDING');
    if (!everPaired) {
      if (licenseBypassEnabled()) return { mode: 'BYPASS', deny: null, permanent: false, config: null, registration: reg, window: null };
      return { mode: 'NOT_ACTIVATED', deny: 'PLATFORM_ACTIVATION_REQUIRED', permanent: false, config: null, registration: reg, window: null };
    }
    let window: LicenceWindow | null = null;
    const deny = (code: string, config: DesiredConfigPayload | null, permanent = false): LicenseDecision => ({ mode: 'MANAGED', deny: code, permanent, config, registration: reg, window });
    // A paired-then-reset PC re-activating (fresh identity, PENDING) has no usable licence until the new pairing completes.
    if (reg.status === 'PENDING') return deny('PLATFORM_ACTIVATION_REQUIRED', null);
    const row = await this.effectiveRow(reg.deviceId);
    const config = (row?.payload as unknown as DesiredConfigPayload) ?? null;
    if (row) window = licenceWindow(row);
    if (reg.status === 'UNPAIRED') return deny('PLATFORM_UNPAIRED', config);
    if (reg.status === 'REVOKED' || config?.deviceStatus === 'REVOKED') return deny('DEVICE_REVOKED', config);
    if (!config) return deny('PLATFORM_CONFIG_MISSING', null);
    if (!this.keyUsable(reg.devicePrivateKeyEnc)) return deny('DEVICE_REPAIR_REQUIRED', config);
    if (PLAN_DENY[config.plan.status]) return deny(PLAN_DENY[config.plan.status], config);
    if (config.plan.validFrom && new Date(config.plan.validFrom) > now) return deny('PLAN_NOT_STARTED', config);
    // Sending stops at the EARLIER of the signed plan end and the signed config expiry ("at or after ⇒ blocked").
    // Both are HOLDs (a new valid signed revision lifts them); nothing is deleted.
    const w = window!;
    if (w.planValidUntil && !(w.planValidUntil.getTime() > now.getTime())) return deny('PLAN_EXPIRED', config);
    if (w.configExpiresAt <= now) return deny('PLATFORM_CONFIG_EXPIRED', config);
    if (scope.eventType === 'APPOINTMENT_REMINDER' && !config.features.appointmentReminder) return deny('FEATURE_NOT_LICENSED', config, true);
    if (scope.eventType === 'DEBT_REMINDER' && !config.features.debtReminder) return deny('FEATURE_NOT_LICENSED', config, true);
    if (scope.sourceChanged) return deny('SOURCE_KIND_CHANGED', config, true);
    if (scope.sourceProduct !== undefined || scope.branchId !== undefined) {
      // The owner can still pick the connector kind, so a job without a resolvable source is held, not cancelled.
      if (!scope.sourceProduct) return deny('SOURCE_SCOPE_REQUIRED', config);
      const entry = this.sourceEntry(config, scope.sourceProduct);
      if (!entry) return deny('SOURCE_NOT_LICENSED', config, true);
      if (scope.branchId !== undefined) {
        if (!scope.branchId) return deny('BRANCH_REQUIRED', config, true);
        // Wire contract: PETCLINIC and B2B_SALE branch ids are Platform branch UUIDs (the PETCLINIC bridge maps its local
        // ids through platform_branch_mappings). Anything else is an unmapped id: blocked with an explicit reason.
        if (!branchIdMatchesNamespace(scope.sourceProduct, scope.branchId)) return deny('BRANCH_MAPPING_REQUIRED', config, true);
        if (!entry.allowedBranchIds.includes(scope.branchId)) return deny('BRANCH_NOT_LICENSED', config, true);
      }
    }
    return { mode: 'MANAGED', deny: null, permanent: false, config, registration: reg, window };
  }
}
