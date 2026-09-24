import { BadGatewayException, ForbiddenException } from '@nestjs/common';
import { B2bSourceService } from '../src/b2b/b2b-source.service';

const tenant: any = { platformTenantId: '11111111-1111-1111-1111-111111111111', platformApiBaseUrl: 'http://127.0.0.1:4000/api', platformClientId: 'client', platformClientSecretEnc: 'enc' };
const ctx: any = { tenant, platformTenantId: tenant.platformTenantId };
const item = { externalReferenceId: 'b2b:SALES_ORDER:22222222-2222-2222-2222-222222222222', sourceId: '22222222-2222-2222-2222-222222222222', customerName: 'Khách', phoneE164: '+84901234567', remainingAmount: 1000, dueAt: null, documentCode: 'SO1', branchId: 'b1', consent: { status: 'GRANTED' }, eligible: true, ineligibleReason: null };

describe('B2bSourceService', () => {
  const oldFetch = global.fetch;
  afterEach(() => { global.fetch = oldFetch; jest.restoreAllMocks(); });

  function service() {
    const prisma: any = { crmTenant: { findUnique: jest.fn(async () => tenant) }, installation: { findUnique: jest.fn(async () => ({ id: 'i1', tenantId: tenant.platformTenantId, sourceProduct: 'B2B_SALE', status: 'ACTIVE', paused: false, scopes: ['care:job:create'] })) } };
    const crypto: any = { decrypt: jest.fn(() => 'secret') };
    const jobs: any = { create: jest.fn(async (_ctx: any, input: any) => ({ id: 'j1', input })) };
    return { prisma, jobs, value: new B2bSourceService(prisma, crypto, jobs) };
  }

  it('uses server-side credential and stable daily idempotency', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ items: [item] }) })) as any;
    const { value, jobs } = service();
    await value.queue(ctx, item.externalReferenceId);
    const input = jobs.create.mock.calls[0][1];
    expect(input.idempotencyKey).toMatch(/^b2b-debt:22222222-2222-2222-2222-222222222222:\d{4}-\d{2}-\d{2}$/);
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers).toMatchObject({ 'x-installation-client-id': 'client', 'x-installation-client-secret': 'secret' });
  });

  it('does not queue when consent is absent', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ items: [{ ...item, eligible: false, consent: { status: 'UNKNOWN' }, ineligibleReason: 'CONSENT_NOT_GRANTED' }] }) })) as any;
    await expect(service().value.queue(ctx, item.externalReferenceId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed when B2B is unavailable during revalidation', async () => {
    global.fetch = jest.fn(async () => { throw new Error('offline'); }) as any;
    await expect(service().value.revalidate(tenant.platformTenantId, item.externalReferenceId)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
