import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { entitlementDenyCode, entitlementUsable } from './crm.constants';
import { JobScope, LicensedSource, LicenseGateService } from '../standalone/platform/license-gate.service';

export type SendingDecision =
  | { action: 'SEND' }
  | { action: 'HOLD'; code: string }
  | { action: 'CANCEL'; code: string };

/**
 * Sending gate derived from the CRM tenant record (Platform entitlement + tenant auto-send pause).
 * Tenants without a CrmTenant row are not CRM-managed (internal pilot installations provisioned via
 * Platform control only) and keep their existing behaviour.
 * Standalone PC edition only: the Platform licence gate (LicenseGateService) is injected and consulted as well —
 * always, with or without a CrmTenant row; it is absent in the VPS module, so that edition is unchanged.
 */
@Injectable()
export class TenantAccessService {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly licence?: LicenseGateService) {}

  async sendingDecision(platformTenantId: string, scope?: JobScope): Promise<SendingDecision> {
    const tenant = await this.prisma.crmTenant.findUnique({ where: { platformTenantId } });
    if (tenant && !entitlementUsable(tenant)) {
      const code = entitlementDenyCode(tenant);
      // Suspension or a pending deletion may be lifted, so queued work is held; expiry/revocation ends it.
      return code === 'ENTITLEMENT_SUSPENDED' || code === 'ENTITLEMENT_INACTIVE' || code === 'TENANT_DELETION_PENDING' ? { action: 'HOLD', code } : { action: 'CANCEL', code };
    }
    if (this.licence) {
      const d = await this.licence.evaluate(scope ?? {});
      // Licence problems HOLD queued work (nothing is deleted); only an out-of-scope source/branch/feature ends a job.
      if (d.deny) return d.permanent ? { action: 'CANCEL', code: d.deny } : { action: 'HOLD', code: d.deny };
    }
    if (tenant?.autoSendPaused) return { action: 'HOLD', code: 'TENANT_PAUSED' };
    return { action: 'SEND' };
  }

  /** New care jobs are refused whenever the entitlement (or, on the PC edition, the Platform licence) is not usable. */
  async canCreateJobs(platformTenantId: string, scope?: JobScope): Promise<{ ok: true } | { ok: false; code: string }> {
    const tenant = await this.prisma.crmTenant.findUnique({ where: { platformTenantId } });
    if (tenant && !entitlementUsable(tenant)) return { ok: false, code: entitlementDenyCode(tenant) };
    if (this.licence) {
      const d = await this.licence.evaluate(scope ?? {});
      if (d.deny) return { ok: false, code: d.deny };
    }
    return { ok: true };
  }

  /** PC edition: Platform source entry a new job of this installation is licensed under (undefined on the VPS edition). */
  async licenseSourceFor(installationId: string, sourceProduct: string): Promise<LicensedSource | null | undefined> {
    return this.licence ? this.licence.sourceForInstallation(installationId, sourceProduct) : undefined;
  }

  /** Scope for the pre-send check of an existing job (source recorded on the job; VPS edition: branch/event only). */
  async jobScope(job: { installationId: string; sourceProduct: string; licenseSource: string | null; branchId: string | null; eventType: string }): Promise<JobScope> {
    return this.licence ? this.licence.jobScope(job) : { branchId: job.branchId, eventType: job.eventType };
  }
}
