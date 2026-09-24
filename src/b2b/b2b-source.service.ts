import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CrmTenant } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { CareJobsService } from '../care-jobs/care-jobs.service';
import type { CrmContext } from '../crm/crm-session.service';

type B2bReceivable = {
  externalReferenceId: string; sourceType: string; sourceId: string; customerCode: string; customerName: string;
  phoneE164: string | null; remainingAmount: number; dueAt: string | null; documentCode: string; branchId: string;
  updatedAt: string; consent: { status: string; source: string | null; recordedAt: string | null; withdrawnAt: string | null };
  eligible: boolean; ineligibleReason: string | null;
};

@Injectable()
export class B2bSourceService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly jobs: CareJobsService) {}

  private endpoint(tenant: CrmTenant, path: string) {
    if (!tenant.platformApiBaseUrl) throw new BadGatewayException('B2B_SOURCE_NOT_CONFIGURED');
    const base = new URL(tenant.platformApiBaseUrl);
    const local = base.protocol === 'http:' && ['localhost', '127.0.0.1', 'host.docker.internal'].includes(base.hostname);
    if (base.protocol !== 'https:' && !local) throw new BadGatewayException('B2B_SOURCE_INSECURE');
    return new URL(path.replace(/^\//, ''), `${base.toString().replace(/\/$/, '')}/`);
  }

  private async request(tenant: CrmTenant, path: string) {
    if (!tenant.platformClientId || !tenant.platformClientSecretEnc) throw new BadGatewayException('B2B_SOURCE_NOT_PROVISIONED');
    let response: Response;
    try {
      response = await fetch(this.endpoint(tenant, path), { headers: {
        'x-installation-client-id': tenant.platformClientId,
        'x-installation-client-secret': this.crypto.decrypt(tenant.platformClientSecretEnc),
      }, signal: AbortSignal.timeout(10_000) });
    } catch { throw new BadGatewayException('B2B_SOURCE_UNAVAILABLE'); }
    if (!response.ok) throw new BadGatewayException(response.status === 403 ? 'B2B_SOURCE_INACTIVE' : 'B2B_SOURCE_UNAVAILABLE');
    return response.json() as Promise<any>;
  }

  async list(ctx: CrmContext) {
    const body = await this.request(ctx.tenant, '/crm-b2b-source/receivables');
    return { sourceProduct: 'B2B_SALE', items: Array.isArray(body?.items) ? body.items : [] } as { sourceProduct: string; items: B2bReceivable[] };
  }

  async revalidate(tenantId: string, externalReferenceId: string): Promise<boolean> {
    const tenant = await this.prisma.crmTenant.findUnique({ where: { platformTenantId: tenantId } });
    if (!tenant) return false;
    const body = await this.request(tenant, `/crm-b2b-source/receivables/${encodeURIComponent(externalReferenceId)}/revalidate`);
    return body?.eligible === true && body?.item?.externalReferenceId === externalReferenceId && Number(body?.item?.remainingAmount) > 0 && body?.item?.consent?.status === 'GRANTED';
  }

  async queue(ctx: CrmContext, externalReferenceId: string) {
    if (!/^b2b:(SALES_ORDER|COMMERCIAL_INVOICE):[0-9a-f-]{36}$/i.test(externalReferenceId)) throw new BadRequestException('INVALID_REFERENCE');
    const source = await this.list(ctx);
    const item = source.items.find((row) => row.externalReferenceId === externalReferenceId);
    if (!item) throw new NotFoundException('NOT_FOUND');
    if (!item.eligible || !item.phoneE164 || item.consent.status !== 'GRANTED') throw new ForbiddenException(item.ineligibleReason || 'CONSENT_NOT_GRANTED');
    const installation = await this.prisma.installation.findUnique({ where: { tenantId_sourceProduct: { tenantId: ctx.platformTenantId, sourceProduct: 'B2B_SALE' } } });
    if (!installation || installation.status !== 'ACTIVE' || installation.paused) throw new ForbiddenException('B2B_SOURCE_INACTIVE');
    const day = new Date().toISOString().slice(0, 10);
    return this.jobs.create({ installation, installationId: installation.id, tenantId: ctx.platformTenantId, sourceProduct: installation.sourceProduct, scopes: installation.scopes }, {
      sourceProduct: 'B2B_SALE', externalReferenceId, eventType: 'DEBT_REMINDER', recipient: { name: item.customerName, phone: item.phoneE164 },
      templateCode: 'B2B_DEBT_REMINDER_V1', templateVariables: { customerName: item.customerName, documentCode: item.documentCode, remainingAmount: String(item.remainingAmount), dueAt: item.dueAt || '' },
      scheduledAt: new Date().toISOString(), consentStatus: 'GRANTED', branchId: item.branchId, idempotencyKey: `b2b-debt:${item.sourceId}:${day}`,
    });
  }
}
