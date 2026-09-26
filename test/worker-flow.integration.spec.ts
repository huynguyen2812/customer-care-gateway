import { TenantAccessService } from '../src/crm/tenant-access.service';
import { createServer, Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient, SourceProduct } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { CareJobsService } from '../src/care-jobs/care-jobs.service';
import { MockAdapter } from '../src/channel/mock.adapter';
import { SourceVerifierService } from '../src/worker/source-verifier.service';
import { WebhookOutboxService } from '../src/webhooks/webhook-outbox.service';
import { CareWorkerService } from '../src/worker/care-worker.service';
import { PersonalZaloAdapter } from '../src/channel/personal-zalo.adapter';
import { ChannelRouterService } from '../src/channel/channel-router.service';
import { TemplateService } from '../src/templates/template.service';
import { AccountSelectorService } from '../src/delivery/account-selector.service';
import { QuotaService } from '../src/delivery/quota.service';

describe('worker flow (real PostgreSQL + loopback HTTP)', () => {
  const prisma = new PrismaClient(); const crypto = new CryptoService();
  let server: Server; let baseUrl = ''; let callbackCount = 0; const installationIds: string[] = []; const tenantIds: string[] = [];

  beforeAll(async () => {
    process.env.PHONE_HASH_PEPPER = randomBytes(32).toString('hex');
    process.env.DATA_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
    await prisma.$connect();
    server = createServer((req, res) => {
      let raw = ''; req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
        if (req.url === '/verify') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"valid":true}'); return; }
        if (req.url === '/callback') { callbackCount++; expect(req.headers['x-care-signature']).toMatch(/^[a-f0-9]{64}$/); expect(JSON.parse(raw).status).toBe('SENT'); res.writeHead(204); res.end(); return; }
        res.writeHead(404); res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await prisma.webhookDelivery.deleteMany({ where: { installationId: { in: installationIds } } });
    await prisma.careJob.deleteMany({ where: { installationId: { in: installationIds } } });
    await prisma.installation.deleteMany({ where: { id: { in: installationIds } } });
    await prisma.zaloAccount.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.$disconnect(); await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('verifies source, sends once, and delivers a signed webhook', async () => {
    const secret = randomBytes(32).toString('base64url');
    const installation = await prisma.installation.create({ data: {
      tenantId: randomUUID(), sourceProduct: SourceProduct.PETCLINIC_ESSENTIAL, status: 'ACTIVE',
      scopes: ['care:job:create', 'care:job:read', 'care:job:cancel'], callbackUrl: `${baseUrl}/callback`,
      sourceVerifyUrl: `${baseUrl}/verify`, callbackSecretEnc: crypto.encrypt(secret), quietHoursStart: '00:00', quietHoursEnd: '00:00', dailyQuota: 30,
    }}); installationIds.push(installation.id); tenantIds.push(installation.tenantId);
    process.env.MOCK_ADAPTER_ENABLED = 'true';
    // MOCK is never implicit: the tenant needs an explicit MOCK account (test/local only).
    await prisma.zaloAccount.create({ data: { tenantId: installation.tenantId, channel: 'MOCK', status: 'CONNECTED', isDefault: true, dailyQuota: 30, displayName: 'Mock QA' } });
    const ctx = { installation, installationId: installation.id, tenantId: installation.tenantId, sourceProduct: installation.sourceProduct, scopes: installation.scopes };
    const jobs = new CareJobsService(prisma as any, crypto, new TenantAccessService(prisma as any));
    const created = await jobs.create(ctx, { sourceProduct: 'PETCLINIC_ESSENTIAL', externalReferenceId: 'appointment:worker-test', eventType: 'APPOINTMENT_REMINDER', recipient: { name: 'Khach Test', phone: '0901234567' }, templateCode: 'PC_APPT_REMINDER_V1', templateVariables: { petName: 'Mit' }, scheduledAt: new Date(Date.now() - 1000).toISOString(), consentStatus: 'GRANTED', idempotencyKey: randomUUID() });
    await prisma.messageTemplate.create({ data: { installationId: installation.id, code: 'PC_APPT_REMINDER_V1', body: 'Nhac lich cho {{petName}}', allowedVariables: ['petName'] } });
    const outbox = new WebhookOutboxService(prisma as any, crypto);
    const mock = new MockAdapter(); const personal = new PersonalZaloAdapter(crypto); const router = new ChannelRouterService(mock, personal);
    const worker = new CareWorkerService(prisma as any, crypto, router, new SourceVerifierService(), outbox, new TemplateService(prisma as any), {} as any, new TenantAccessService(prisma as any), new AccountSelectorService(prisma as any, personal), new QuotaService(prisma as any), { revalidate: jest.fn(async () => false) } as any, {} as any);
    expect(await worker.processNext('integration-worker')).toBe(true);
    expect((await prisma.careJob.findUniqueOrThrow({ where: { id: String(created.id) } })).status).toBe('SENT');
    expect(await outbox.deliverNext()).toBe(true); expect(callbackCount).toBe(1);
  });
});
