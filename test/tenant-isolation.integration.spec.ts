import { TenantAccessService } from '../src/crm/tenant-access.service';
import { randomBytes, randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { PrismaClient, SourceProduct } from '@prisma/client';
import { CareJobsService } from '../src/care-jobs/care-jobs.service';
import { CryptoService } from '../src/common/crypto.service';

describe('tenant isolation and idempotency (real PostgreSQL)', () => {
  const prisma = new PrismaClient();
  const crypto = new CryptoService();
  const service = new CareJobsService(prisma as any, crypto, new TenantAccessService(prisma as any));
  const createdInstallationIds: string[] = [];

  beforeAll(async () => {
    process.env.PHONE_HASH_PEPPER = randomBytes(32).toString('hex');
    process.env.DATA_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.careJob.deleteMany({ where: { installationId: { in: createdInstallationIds } } });
    await prisma.installation.deleteMany({ where: { id: { in: createdInstallationIds } } });
    await prisma.$disconnect();
  });

  async function context() {
    const installation = await prisma.installation.create({ data: {
      tenantId: randomUUID(), sourceProduct: SourceProduct.PETCLINIC_ESSENTIAL,
      status: 'ACTIVE', scopes: ['care:job:create', 'care:job:read', 'care:job:cancel'],
    }});
    createdInstallationIds.push(installation.id);
    return { installation, installationId: installation.id, tenantId: installation.tenantId, sourceProduct: installation.sourceProduct, scopes: installation.scopes };
  }

  const payload = () => ({
    sourceProduct: 'PETCLINIC_ESSENTIAL', externalReferenceId: 'appointment:123',
    eventType: 'APPOINTMENT_REMINDER', recipient: { name: 'Khach Test', phone: '0901234567' },
    templateCode: 'PC_APPT_REMINDER_V1', templateVariables: { appointmentAt: '2026-09-25T09:00:00+07:00' },
    scheduledAt: '2026-09-25T08:00:00+07:00', consentStatus: 'GRANTED', idempotencyKey: `test-${randomUUID()}`,
  });

  it('deduplicates two concurrent requests at the database boundary', async () => {
    const ctx = await context(); const input = payload();
    const results = await Promise.all([service.create(ctx, input), service.create(ctx, input)]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await prisma.careJob.count({ where: { installationId: ctx.installationId, idempotencyKey: input.idempotencyKey } })).toBe(1);
  });

  it('returns 404 when tenant A asks for tenant B job', async () => {
    const tenantA = await context(); const tenantB = await context();
    const job = await service.create(tenantB, payload());
    await expect(service.get(tenantA, String(job.id))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a tenantId supplied for another tenant', async () => {
    const ctx = await context();
    await expect(service.create(ctx, { ...payload(), tenantId: randomUUID() })).rejects.toThrow('Credential scope mismatch');
  });
});
