import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { CryptoService } from '../src/common/crypto.service';

const EVENTS_SECRET = randomBytes(32).toString('hex');

function signed(body: Record<string, unknown>, eventId: string = randomUUID()) {
  const timestamp = String(Date.now());
  const raw = JSON.stringify({ version: 1, eventId, ...body });
  const signature = createHmac('sha256', EVENTS_SECRET).update(`${timestamp}.${eventId}.${createHash('sha256').update(raw).digest('hex')}`).digest('hex');
  return { eventId, raw, headers: { 'content-type': 'application/json', 'x-platform-provisioning-id': eventId, 'x-platform-provisioning-timestamp': timestamp, 'x-platform-provisioning-signature': signature } };
}

describe('Platform provisioned PETCLINIC source (real PostgreSQL)', () => {
  const prisma = new PrismaClient();
  const tenantId = randomUUID();
  const branchId = randomUUID();
  const sourceInstallationId = randomUUID();
  let app: INestApplication;

  const send = (body: Record<string, unknown>, eventId?: string) => {
    const ev = signed(body, eventId);
    return request(app.getHttpServer()).post('/api/v1/crm/platform/events').set(ev.headers).send(ev.raw);
  };
  const token = (key: string) => `pccrm_${key.padEnd(12, '0')}.${randomBytes(32).toString('base64url')}`;

  beforeAll(async () => {
    Object.assign(process.env, {
      PHONE_HASH_PEPPER: randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), WORKER_ENABLED: 'false',
      CRM_SESSION_SECRET: randomBytes(32).toString('hex'), ADMIN_SESSION_SECRET: randomBytes(32).toString('hex'), CRM_PUBLIC_ORIGIN: 'http://crm.test',
      PLATFORM_API_BASE_URL: 'http://127.0.0.1:9/api', PLATFORM_ALLOW_HTTP_LOCAL: 'true', PLATFORM_AUTH_ISSUER: 'qa', PLATFORM_WEB_ORIGIN: 'http://platform.test',
      CRM_PLATFORM_EVENTS_SECRET: EVENTS_SECRET,
    });
    await prisma.$connect();
    await prisma.crmTenant.create({ data: { platformTenantId: tenantId, displayName: 'PETCLINIC source QA', installationStatus: 'ACTIVE', entitlementStatus: 'ACTIVE' } });
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ rawBody: true }); app.setGlobalPrefix('api/v1'); await app.init();
  });

  afterAll(async () => {
    const installs = await prisma.installation.findMany({ where: { tenantId }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.installation.deleteMany({ where: { id: { in: installs.map((x) => x.id) } } });
    await prisma.platformEvent.deleteMany({ where: { platformTenantId: tenantId } });
    await prisma.crmTenant.deleteMany({ where: { platformTenantId: tenantId } });
    await app.close(); await prisma.$disconnect();
  });

  it('provisions Essential, rotates once, rejects tenant mismatch, handles status, replay and revoke without leaking the token', async () => {
    const firstToken = token('first');
    const upsert = {
      type: 'petclinic_source.upserted', productCode: 'PETCLINIC_ESSENTIAL', occurredAt: new Date().toISOString(), tenant: { platformTenantId: tenantId },
      source: { sourceProduct: 'PETCLINIC_ESSENTIAL', installationId: sourceInstallationId, revision: 1, apiBaseUrl: 'https://petclinic.example', apiTenantId: tenantId, allowedBranchIds: [branchId], credential: { token: firstToken, keyId: 'first0000000' } },
    };
    const first = signed(upsert);
    const concurrent = await Promise.all([
      request(app.getHttpServer()).post('/api/v1/crm/platform/events').set(first.headers).send(first.raw),
      request(app.getHttpServer()).post('/api/v1/crm/platform/events').set(first.headers).send(first.raw),
    ]);
    expect(concurrent.map((r) => r.body.result)).toEqual(expect.arrayContaining(['APPLIED']));
    expect(concurrent.filter((r) => r.body.duplicate === true)).toHaveLength(1);
    const reused = signed({ ...upsert, source: { ...upsert.source, revision: 2 } }, first.eventId);
    expect((await request(app.getHttpServer()).post('/api/v1/crm/platform/events').set(reused.headers).send(reused.raw)).status).toBe(409);
    const installation = await prisma.installation.findUniqueOrThrow({ where: { tenantId_sourceProduct: { tenantId, sourceProduct: 'PETCLINIC_ESSENTIAL' } }, include: { petclinicConnection: true } });
    expect(installation).toMatchObject({ status: 'ACTIVE', paused: false });
    expect(installation.petclinicConnection).toMatchObject({ apiTenantId: tenantId, allowedBranchIds: [branchId], sourceProduct: 'PETCLINIC_ESSENTIAL', sourceInstallationId, sourceRevision: 1, contractVersion: 1, active: true, credentialKeyId: 'first0000000' });
    expect(new CryptoService().decrypt(installation.petclinicConnection!.apiTokenEnc!)).toBe(firstToken);

    const mismatch = await send({ ...upsert, tenant: { platformTenantId: tenantId }, source: { ...upsert.source, revision: 2, apiTenantId: randomUUID(), credential: { token: token('wrong') } } });
    expect(mismatch.status).toBe(422);

    const rotatedToken = token('second');
    expect((await send({ type: 'petclinic_source.credential_rotated', productCode: 'PETCLINIC_ESSENTIAL', occurredAt: new Date().toISOString(), tenant: { platformTenantId: tenantId }, source: { ...upsert.source, revision: 3, credential: { token: rotatedToken, keyId: 'second000000' } } })).body.result).toBe('APPLIED');
    const rotated = await prisma.petclinicConnection.findUniqueOrThrow({ where: { installationId: installation.id } });
    expect(new CryptoService().decrypt(rotated.apiTokenEnc!)).toBe(rotatedToken);

    const staleToken = token('stale');
    const stale = await send({ ...upsert, occurredAt: new Date(Date.now() + 10_000).toISOString(), source: { ...upsert.source, revision: 2, credential: { token: staleToken, keyId: 'stale0000000' } } });
    expect(stale.body.result).toBe('IGNORED_STALE');
    expect(new CryptoService().decrypt((await prisma.petclinicConnection.findUniqueOrThrow({ where: { installationId: installation.id } })).apiTokenEnc!)).toBe(rotatedToken);

    const suspended = await send({ type: 'petclinic_source.status_changed', productCode: 'PETCLINIC_ESSENTIAL', occurredAt: new Date(Date.now() + 1000).toISOString(), tenant: { platformTenantId: tenantId }, source: { sourceProduct: 'PETCLINIC_ESSENTIAL', installationId: sourceInstallationId, revision: 4, status: 'SUSPENDED' } });
    expect(suspended.body.result).toBe('APPLIED');
    expect(await prisma.petclinicConnection.findUnique({ where: { installationId: installation.id } })).toMatchObject({ active: false, lastSyncStatus: 'SUSPENDED' });

    expect((await send({ type: 'petclinic_source.revoked', productCode: 'PETCLINIC_ESSENTIAL', occurredAt: new Date().toISOString(), tenant: { platformTenantId: tenantId }, source: { sourceProduct: 'PETCLINIC_ESSENTIAL', installationId: sourceInstallationId, revision: 5 } })).body.result).toBe('APPLIED');
    const revoked = await prisma.petclinicConnection.findUniqueOrThrow({ where: { installationId: installation.id } });
    expect(revoked).toMatchObject({ active: false, apiTokenEnc: null, lastSyncStatus: 'REVOKED' });
    const rendered = JSON.stringify(await prisma.platformEvent.findMany({ where: { platformTenantId: tenantId } })) + JSON.stringify(await prisma.auditLog.findMany({ where: { tenantId } }));
    expect(rendered).not.toContain(firstToken); expect(rendered).not.toContain(rotatedToken);
  });
});
