import { TenantAccessService } from '../src/crm/tenant-access.service';
import { createServer, Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient, SourceProduct } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { CareJobsService } from '../src/care-jobs/care-jobs.service';
import { PetclinicClientService } from '../src/petclinic/petclinic-client.service';
import { PetclinicSyncService } from '../src/petclinic/petclinic-sync.service';

describe('operating PETCLINIC sync (real PostgreSQL + loopback source API)', () => {
  const prisma = new PrismaClient();
  const crypto = new CryptoService();
  const client = new PetclinicClientService(crypto);
  const tenantAccess = new TenantAccessService(prisma as any);
  const jobs = new CareJobsService(prisma as any, crypto, tenantAccess);
  const sync = new PetclinicSyncService(prisma as any, crypto, client, jobs, tenantAccess);
  let server: Server; let baseUrl = ''; let installationId = '';
  let status = 'SCHEDULED';
  let appointmentTime = new Date(Date.now() + 2 * 86400_000).toISOString();

  beforeAll(async () => {
    process.env.PHONE_HASH_PEPPER = randomBytes(32).toString('hex');
    process.env.DATA_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
    await prisma.$connect();
    server = createServer((req, res) => {
      expect(req.headers.authorization).toBe('Bearer test-petclinic-token-32-characters');
      expect(req.headers['x-tenant-id']).toBeUndefined();
      if (req.method === 'POST' && req.url?.endsWith('/appointments/appt-pilot-1/revalidate')) {
        let raw = ''; req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
          const body = JSON.parse(raw);
          const eligible = status === 'SCHEDULED' && body.expectedAppointmentTime === appointmentTime && body.expectedRevision === 'revision-current';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: { eligible, reasonCode: eligible ? 'ELIGIBLE' : 'APPOINTMENT_CHANGED', appointmentId: 'appt-pilot-1' } }));
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { content: [{
        id: 'appt-pilot-1', appointmentTime, status, branchId: 'branch-approved',
        ownerName: 'Khach Pilot', ownerPhone: '0901234567', petName: 'Miu',
        serviceName: 'Kham tong quat', messagingConsent: true, revision: 'revision-current',
      }], last: true, totalPages: 1 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    const installation = await prisma.installation.create({ data: {
      tenantId: randomUUID(), sourceProduct: SourceProduct.PETCLINIC_ESSENTIAL, status: 'ACTIVE',
      scopes: ['care:job:create', 'care:job:read', 'care:job:cancel'], dailyQuota: 20,
    }});
    installationId = installation.id;
    await sync.configure(installationId, {
      apiBaseUrl: baseUrl, apiToken: 'test-petclinic-token-32-characters', apiTenantId: 'petclinic-tenant-test',
      allowedBranchIds: ['branch-approved'], pilotAllowedPhones: ['0901234567'], reminderLeadMinutes: 1440, active: true,
    }, 'integration-test');
  });

  afterAll(async () => {
    await prisma.webhookDelivery.deleteMany({ where: { installationId } });
    await prisma.careJob.deleteMany({ where: { installationId } });
    await prisma.auditLog.deleteMany({ where: { installationId } });
    await prisma.installation.delete({ where: { id: installationId } });
    await prisma.$disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('previews, commits once, replaces a reschedule, and cancels an ineligible appointment', async () => {
    const preview = await sync.sync(installationId, {}, 'integration-test');
    expect(preview).toMatchObject({ dryRun: true, scanned: 1, eligible: 1, created: 0 });
    expect(await prisma.careJob.count({ where: { installationId } })).toBe(0);

    const committed = await sync.sync(installationId, { commit: true }, 'integration-test');
    expect(committed).toMatchObject({ dryRun: false, created: 1, cancelled: 0 });
    expect((await sync.sync(installationId, { commit: true }, 'integration-test')).created).toBe(0);

    appointmentTime = new Date(Date.now() + 3 * 86400_000).toISOString();
    const rescheduled = await sync.sync(installationId, { commit: true }, 'integration-test');
    expect(rescheduled).toMatchObject({ created: 1, cancelled: 1 });
    expect(await prisma.careJob.count({ where: { installationId, status: 'QUEUED' } })).toBe(1);
    expect(await sync.verify(installationId, 'appointment:appt-pilot-1', new Date(appointmentTime), 'revision-current')).toBe(true);

    status = 'CANCELLED';
    const cancelled = await sync.sync(installationId, { commit: true }, 'integration-test');
    expect(cancelled.cancelled).toBe(1);
    expect(await sync.verify(installationId, 'appointment:appt-pilot-1', new Date(appointmentTime), 'revision-current')).toBe(false);
    expect(await prisma.careJob.count({ where: { installationId, status: 'QUEUED' } })).toBe(0);
  });
});
