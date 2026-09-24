import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { entitlementDenyCode, entitlementUsable } from './crm.constants';

export type SendingDecision =
  | { action: 'SEND' }
  | { action: 'HOLD'; code: string }
  | { action: 'CANCEL'; code: string };

/**
 * Sending gate derived from the CRM tenant record (Platform entitlement + tenant auto-send pause).
 * Tenants without a CrmTenant row are not CRM-managed (internal pilot installations provisioned via
 * Platform control only) and keep their existing behaviour.
 */
@Injectable()
export class TenantAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async sendingDecision(platformTenantId: string): Promise<SendingDecision> {
    const tenant = await this.prisma.crmTenant.findUnique({ where: { platformTenantId } });
    if (!tenant) return { action: 'SEND' };
    if (!entitlementUsable(tenant)) {
      const code = entitlementDenyCode(tenant);
      // Suspension or a pending deletion may be lifted, so queued work is held; expiry/revocation ends it.
      return code === 'ENTITLEMENT_SUSPENDED' || code === 'ENTITLEMENT_INACTIVE' || code === 'TENANT_DELETION_PENDING' ? { action: 'HOLD', code } : { action: 'CANCEL', code };
    }
    if (tenant.autoSendPaused) return { action: 'HOLD', code: 'TENANT_PAUSED' };
    return { action: 'SEND' };
  }

  /** New care jobs are refused whenever the entitlement is not usable (pause alone still accepts). */
  async canCreateJobs(platformTenantId: string): Promise<{ ok: true } | { ok: false; code: string }> {
    const tenant = await this.prisma.crmTenant.findUnique({ where: { platformTenantId } });
    if (!tenant || entitlementUsable(tenant)) return { ok: true };
    return { ok: false, code: entitlementDenyCode(tenant) };
  }
}
