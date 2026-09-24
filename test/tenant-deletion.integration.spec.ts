import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { CryptoService } from '../src/common/crypto.service';
import { TenantAccessService } from '../src/crm/tenant-access.service';
import { TenantLifecycleService } from '../src/crm/tenant-lifecycle.service';

/**
 * Tenant termination lifecycle over the real signed events endpoint and a real PostgreSQL QA database:
 * lock + export on request, cancel in grace, no purge before due, tenant-scoped purge, idempotent retry.
 */
const ORIGIN = 'http://crm.test';
const EVENTS_SECRET = randomBytes(32).toString('hex');

function signedEvent(body: Record<string, unknown>, opts: { eventId?: string; timestamp?: number; secret?: string } = {}) {
  const eventId = opts.eventId || randomUUID();
  const timestamp = String(opts.timestamp ?? Date.now());
  const raw = JSON.stringify({ version: 1, eventId, ...body });
  const sig = createHmac('sha256', opts.secret || EVENTS_SECRET).update(`${timestamp}.${eventId}.${createHash('sha256').update(raw).digest('hex')}`).digest('hex');
  return { eventId, raw, headers: { 'content-type': 'application/json', 'x-platform-provisioning-id': eventId, 'x-platform-provisioning-timestamp': timestamp, 'x-platform-provisioning-signature': sig } };
}

describe('VETCLINIC CRM tenant deletion lifecycle (Platform-driven)', () => {
  const prisma = new PrismaClient();
  let app: INestApplication; let crypto: CryptoService; let access: TenantAccessService; let lifecycle: TenantLifecycleService;
  const mk = () => ({ tenantId: randomUUID(), clientId: `crm_${randomUUID().slice(0, 12)}`, secret: `CLIENT_SECRET_${randomBytes(16).toString('hex')}`, inst: '', account: '', job: '' });
  const A = mk(); const B = mk(); const C = mk();
  const all = [A, B, C];
  const http = () => request(app.getHttpServer());
  const post = (ev: ReturnType<typeof signedEvent>) => http().post('/api/v1/crm/platform/events').set(ev.headers).send(ev.raw);
  const deletion = (requestId: string, dueInMs: number) => ({ requestId, requestedAt: new Date().toISOString(), scheduledPurgeAt: new Date(Date.now() + dueInMs).toISOString(), retentionDays: 30, exportRequired: true });
  const lifecycleEvent = (t: typeof A, type: string, requestId: string, dueInMs: number, extra: Record<string, unknown> = {}) =>
    signedEvent({ type, productCode: 'CUSTOMER_CARE_CRM', tenant: { platformTenantId: t.tenantId }, deletion: deletion(requestId, dueInMs), ...extra });
  const tenantRows = async (t: typeof A) => ({
    crmTenant: await prisma.crmTenant.count({ where: { platformTenantId: t.tenantId } }),
    installation: await prisma.installation.count({ where: { tenantId: t.tenantId } }),
    careJob: await prisma.careJob.count({ where: { installation: { tenantId: t.tenantId } } }),
    zaloAccount: await prisma.zaloAccount.count({ where: { tenantId: t.tenantId } }),
    session: await prisma.crmSession.count({ where: { platformTenantId: t.tenantId } }),
  });

  beforeAll(async () => {
    Object.assign(process.env, {
      PHONE_HASH_PEPPER: randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), WORKER_ENABLED: 'false',
      CRM_SESSION_SECRET: randomBytes(32).toString('hex'), ADMIN_SESSION_SECRET: randomBytes(32).toString('hex'), CRM_PUBLIC_ORIGIN: ORIGIN,
      PLATFORM_API_BASE_URL: 'http://127.0.0.1:9/api', PLATFORM_ALLOW_HTTP_LOCAL: 'true', PLATFORM_AUTH_ISSUER: 'vetclinic.vn-platform-test', PLATFORM_WEB_ORIGIN: 'http://platform.test',
      CRM_PLATFORM_EVENTS_SECRET: EVENTS_SECRET,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ rawBody: true }); app.setGlobalPrefix('api/v1'); await app.init();
    crypto = new CryptoService(); access = app.get(TenantAccessService); lifecycle = app.get(TenantLifecycleService);

    for (const [i, t] of all.entries()) {
      const up = signedEvent({ action: 'UPSERT_INSTALLATION', tenant: { platformTenantId: t.tenantId, name: `QA-CRM-E2E ${i}` }, entitlement: { productCode: 'CUSTOMER_CARE_CRM', status: 'ACTIVE', planCode: 'CRM_BASIC' }, installation: { installationId: randomUUID(), clientId: t.clientId, clientSecret: t.secret, callbackBaseUrl: `${ORIGIN}/api/v1/crm` } });
      expect((await post(up)).status).toBe(200);
      const inst = await prisma.installation.create({ data: { tenantId: t.tenantId, sourceProduct: 'PETCLINIC_OPERATING', status: 'ACTIVE', scopes: ['care:job:create'], callbackSecretEnc: crypto.encrypt('CALLBACK_SECRET_MUST_NOT_LEAK') } });
      t.inst = inst.id;
      await prisma.petclinicConnection.create({ data: { installationId: inst.id, apiBaseUrl: 'http://petclinic.test', apiTokenEnc: crypto.encrypt('PETCLINIC_TOKEN_MUST_NOT_LEAK'), apiTenantId: 'qa', allowedBranchIds: ['qa-branch'], pilotAllowedPhoneHashes: [] } });
      await prisma.messageTemplate.create({ data: { installationId: inst.id, code: 'QA', body: 'Chào {{ownerName}}', allowedVariables: ['ownerName'] } });
      t.account = (await prisma.zaloAccount.create({ data: { tenantId: t.tenantId, channel: 'PERSONAL_ZALO', displayName: `QA-CRM-E2E Zalo ${i}`, phoneMasked: '090****001', credentialEnc: crypto.encrypt('SENDER_KEY_MUST_NOT_LEAK') } })).id;
      t.job = (await prisma.careJob.create({ data: {
        installationId: inst.id, idempotencyKey: `qa-${randomUUID()}`, requestHash: 'a'.repeat(64), externalReferenceId: `appointment:QA-${i}`, sourceProduct: 'PETCLINIC_OPERATING',
        eventType: 'APPOINTMENT_REMINDER', recipientNameEnc: crypto.encrypt(`Khách QA ${i}`), phoneEnc: crypto.encrypt(`+8490000000${i}`), phoneHash: crypto.phoneHash(`+8490000000${i}`),
        templateCode: 'QA', templateVariables: {}, scheduledAt: new Date(Date.now() + 3600_000), consentStatus: 'GRANTED', status: 'QUEUED', selectedZaloAccountId: t.account,
      } })).id;
      await prisma.optOut.create({ data: { installationId: inst.id, phoneHash: crypto.phoneHash(`+8491111111${i}`), source: 'QA' } });
      await prisma.auditLog.create({ data: { installationId: inst.id, tenantId: t.tenantId, actorType: 'PLATFORM_ADMIN', actorId: 'qa', action: 'PETCLINIC_CONNECTION_CONFIGURED', result: 'SUCCESS', metadata: { apiToken: 'AUDIT_TOKEN_MUST_NOT_LEAK' } } });
      await prisma.deliveryQuotaCounter.create({ data: { scope: 'ACCOUNT', scopeId: t.account, day: '2026-09-24', used: 1 } });
      await prisma.crmSession.create({ data: { tokenHash: randomBytes(32).toString('hex'), platformTenantId: t.tenantId, platformUserId: randomUUID(), productCode: 'CUSTOMER_CARE_CRM', roles: ['CRM_OWNER'], displayName: `Chủ QA ${i}`, username: `qa_owner_${i}`, expiresAt: new Date(Date.now() + 3600_000) } as any });
    }
  });

  afterAll(async () => {
    const ids = all.map((t) => t.tenantId);
    for (const t of all) {
      const installationIds = (await prisma.installation.findMany({ where: { tenantId: t.tenantId }, select: { id: true } })).map((i) => i.id);
      const accountIds = (await prisma.zaloAccount.findMany({ where: { tenantId: t.tenantId }, select: { id: true } })).map((a) => a.id);
      await prisma.webhookDelivery.deleteMany({ where: { installationId: { in: installationIds } } });
      await prisma.deliveryAttempt.deleteMany({ where: { tenantId: t.tenantId } });
      await prisma.careJob.deleteMany({ where: { installationId: { in: installationIds } } });
      await prisma.zaloAccount.deleteMany({ where: { tenantId: t.tenantId } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ tenantId: t.tenantId }, { installationId: { in: installationIds } }] } });
      await prisma.installation.deleteMany({ where: { tenantId: t.tenantId } });
      if (accountIds.length) await prisma.deliveryQuotaCounter.deleteMany({ where: { scopeId: { in: accountIds } } });
      await prisma.crmSession.deleteMany({ where: { platformTenantId: t.tenantId } });
    }
    await prisma.crmTenant.deleteMany({ where: { platformTenantId: { in: ids } } });
    await prisma.crmTenantDeletion.deleteMany({ where: { platformTenantId: { in: ids } } });
    await prisma.platformEvent.deleteMany({ where: { platformTenantId: { in: ids } } });
    await app.close(); await prisma.$disconnect();
  });

  const reqA = randomUUID(); const reqB = randomUUID(); const reqC = randomUUID();

  it('rejects bad signature, stale timestamp and wrong product before touching the tenant', async () => {
    expect((await post(lifecycleEvent(A, 'tenant.deletion_requested', reqA, -1000, {}))).status).toBe(200); // prime A for later steps
    const bad = lifecycleEvent(B, 'tenant.deletion_requested', reqB, 60_000);
    expect((await http().post('/api/v1/crm/platform/events').set({ ...bad.headers, 'x-platform-provisioning-signature': 'f'.repeat(64) }).send(bad.raw)).status).toBe(401);
    const stale = signedEvent({ type: 'tenant.deletion_requested', productCode: 'CUSTOMER_CARE_CRM', tenant: { platformTenantId: B.tenantId }, deletion: deletion(reqB, 60_000) }, { timestamp: Date.now() - 10 * 60_000 });
    expect((await post(stale)).status).toBe(401);
    const wrongProduct = signedEvent({ type: 'tenant.deletion_requested', productCode: 'TIMEKEEPING', tenant: { platformTenantId: B.tenantId }, deletion: deletion(reqB, 60_000) });
    expect((await post(wrongProduct)).status).toBe(422);
    expect(await prisma.crmTenantDeletion.count({ where: { platformTenantId: B.tenantId } })).toBe(0);
    expect((await prisma.crmTenant.findUnique({ where: { platformTenantId: B.tenantId } }))?.deletionRequestId).toBeNull();
  });

  it('deletion_requested locks immediately, keeps data, holds queued work, returns a secret-free export', async () => {
    const ev = lifecycleEvent(B, 'tenant.deletion_requested', reqB, 60 * 60_000);
    const res = await post(ev);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: true, result: 'APPLIED', status: 'PENDING', requestId: reqB, platformTenantId: B.tenantId, productCode: 'CUSTOMER_CARE_CRM' });
    const exported = JSON.stringify(res.body.export);
    expect(res.body.exportChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.export.careJobs[0]).toMatchObject({ recipientName: 'Khách QA 1', phone: '+84900000001' });
    expect(res.body.export.templates[0]).toMatchObject({ code: 'QA' });
    expect(res.body.export.users[0]).toMatchObject({ username: 'qa_owner_1', roles: ['CRM_OWNER'] });
    for (const leak of [B.secret, 'MUST_NOT_LEAK', 'credentialEnc', 'apiTokenEnc', 'callbackSecretEnc', 'platformClientSecretEnc', 'tokenHash', 'Enc"']) expect(exported).not.toContain(leak);
    expect(exported).not.toContain(A.tenantId);
    expect(await tenantRows(B)).toMatchObject({ crmTenant: 1, installation: 1, careJob: 1, zaloAccount: 1 });
    expect(await prisma.crmSession.count({ where: { platformTenantId: B.tenantId, revokedAt: null } })).toBe(0);
    expect(await access.sendingDecision(B.tenantId)).toEqual({ action: 'HOLD', code: 'TENANT_DELETION_PENDING' });
    expect(await access.canCreateJobs(B.tenantId)).toEqual({ ok: false, code: 'TENANT_DELETION_PENDING' });
    // Redelivery of the same event: no second effect, but the export is re-issued so it is never stranded.
    const again = await post(signedEvent({ type: 'tenant.deletion_requested', productCode: 'CUSTOMER_CARE_CRM', tenant: { platformTenantId: B.tenantId }, deletion: deletion(reqB, 60 * 60_000) }, { eventId: ev.eventId }));
    expect(again.body).toMatchObject({ duplicate: true, status: 'PENDING', requestId: reqB });
    expect(again.body.export.careJobs).toHaveLength(1);
    expect(await prisma.crmTenantDeletion.count({ where: { platformTenantId: B.tenantId } })).toBe(1);
  });

  it('does not purge before scheduledPurgeAt', async () => {
    const res = await post(lifecycleEvent(B, 'tenant.purge_requested', reqB, 60 * 60_000));
    expect(res.status).toBe(409); expect(res.body.message).toBe('PURGE_NOT_DUE');
    expect(await tenantRows(B)).toMatchObject({ crmTenant: 1, careJob: 1 });
  });

  it('tenant B cannot use tenant A requestId, and purge without a request is refused', async () => {
    expect((await post(lifecycleEvent(B, 'tenant.purge_requested', reqA, -1000))).body.message).toBe('REQUEST_TENANT_MISMATCH');
    expect((await post(lifecycleEvent(C, 'tenant.purge_requested', reqC, -1000))).body.message).toBe('DELETION_NOT_REQUESTED');
    expect(await tenantRows(A)).toMatchObject({ crmTenant: 1, careJob: 1 });
    expect(await tenantRows(C)).toMatchObject({ crmTenant: 1, careJob: 1 });
  });

  it('cancel in grace lifts the lock only with the entitlement Platform confirms', async () => {
    const res = await post(lifecycleEvent(B, 'tenant.deletion_cancelled', reqB, 60 * 60_000, { entitlement: { productCode: 'CUSTOMER_CARE_CRM', status: 'ACTIVE', planCode: 'CRM_BASIC' } }));
    expect(res.status).toBe(200); expect(res.body).toMatchObject({ result: 'APPLIED', status: 'CANCELLED' });
    expect((await prisma.crmTenant.findUnique({ where: { platformTenantId: B.tenantId } }))?.deletionRequestId).toBeNull();
    expect(await access.sendingDecision(B.tenantId)).toEqual({ action: 'SEND' });
    expect((await post(lifecycleEvent(B, 'tenant.purge_requested', reqB, -1000))).body.message).toBe('DELETION_CANCELLED');
    expect(await tenantRows(B)).toMatchObject({ crmTenant: 1, careJob: 1 });
  });

  it('cancel with a non-usable entitlement keeps the product closed', async () => {
    const req = randomUUID();
    await post(lifecycleEvent(C, 'tenant.deletion_requested', req, 60_000));
    await post(lifecycleEvent(C, 'tenant.deletion_cancelled', req, 60_000, { entitlement: { productCode: 'CUSTOMER_CARE_CRM', status: 'SUSPENDED' } }));
    expect(await access.sendingDecision(C.tenantId)).toEqual({ action: 'HOLD', code: 'ENTITLEMENT_SUSPENDED' });
  });

  it('redelivered cancel (same eventId) never reopens an entitlement Platform changed afterwards', async () => {
    const req = randomUUID();
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    expect((await post(lifecycleEvent(B, 'tenant.deletion_requested', req, 60_000))).body.status).toBe('PENDING');
    const cancel = signedEvent({ type: 'tenant.deletion_cancelled', productCode: 'CUSTOMER_CARE_CRM', occurredAt: at(500), tenant: { platformTenantId: B.tenantId }, deletion: deletion(req, 60_000), entitlement: { productCode: 'CUSTOMER_CARE_CRM', status: 'ACTIVE' } });
    expect((await post(cancel)).body).toMatchObject({ result: 'APPLIED', status: 'CANCELLED' });
    // Platform later suspends the product (newer occurredAt).
    expect((await post(signedEvent({ type: 'subscription.suspended', occurredAt: at(1500), tenant: { platformTenantId: B.tenantId }, entitlement: { productCode: 'CUSTOMER_CARE_CRM', status: 'SUSPENDED' } }))).status).toBe(200);
    // Outbox retry of the old cancel with the same eventId: idempotent, entitlement stays SUSPENDED.
    const again = await post(signedEvent({ type: 'tenant.deletion_cancelled', productCode: 'CUSTOMER_CARE_CRM', occurredAt: at(-2000), tenant: { platformTenantId: B.tenantId }, deletion: deletion(req, 60_000), entitlement: { productCode: 'CUSTOMER_CARE_CRM', status: 'ACTIVE' } }, { eventId: cancel.eventId }));
    expect(again.body).toMatchObject({ duplicate: true, status: 'CANCELLED', requestId: req });
    // A different eventId for the same already-cancelled request is also a no-op.
    expect((await post(signedEvent({ type: 'tenant.deletion_cancelled', productCode: 'CUSTOMER_CARE_CRM', occurredAt: at(700), tenant: { platformTenantId: B.tenantId }, deletion: deletion(req, 60_000), entitlement: { productCode: 'CUSTOMER_CARE_CRM', status: 'ACTIVE' } }))).body.result).toBe('IGNORED_ALREADY_CANCELLED');
    expect((await prisma.crmTenant.findUnique({ where: { platformTenantId: B.tenantId } }))?.entitlementStatus).toBe('SUSPENDED');

    // Cancel older than the current entitlement lifts the lock only (no rollback of the newer status).
    const req2 = randomUUID();
    await post(lifecycleEvent(B, 'tenant.deletion_requested', req2, 60_000));
    await post(signedEvent({ type: 'subscription.activated', occurredAt: at(3000), tenant: { platformTenantId: B.tenantId }, entitlement: { productCode: 'CUSTOMER_CARE_CRM', status: 'ACTIVE' } }));
    const staleCancel = await post(signedEvent({ type: 'tenant.deletion_cancelled', productCode: 'CUSTOMER_CARE_CRM', occurredAt: at(2000), tenant: { platformTenantId: B.tenantId }, deletion: deletion(req2, 60_000), entitlement: { productCode: 'CUSTOMER_CARE_CRM', status: 'SUSPENDED' } }));
    expect(staleCancel.body).toMatchObject({ result: 'APPLIED_LOCK_ONLY_STALE_ENTITLEMENT', status: 'CANCELLED' });
    const tenantB = await prisma.crmTenant.findUnique({ where: { platformTenantId: B.tenantId } });
    expect(tenantB).toMatchObject({ deletionRequestId: null, entitlementStatus: 'ACTIVE' });
    expect(await access.sendingDecision(B.tenantId)).toEqual({ action: 'SEND' });
  });

  it('after cancel the CRM ledger keeps only non-PII metadata (no export), and A cannot cancel via B', async () => {
    const ledgers = await prisma.crmTenantDeletion.findMany({ where: { platformTenantId: B.tenantId, status: 'CANCELLED' } });
    expect(ledgers.length).toBeGreaterThanOrEqual(2);
    for (const row of ledgers) {
      expect(Object.keys(row).sort()).toEqual(['cancelledAt', 'completedAt', 'createdAt', 'deletedCounts', 'errorCode', 'errorMessage', 'exportChecksum', 'platformTenantId', 'purgeAttempts', 'purgeStartedAt', 'requestId', 'requestedAt', 'retentionDays', 'scheduledPurgeAt', 'status', 'updatedAt']);
      expect(row.deletedCounts).toBeNull();
      expect(JSON.stringify(row)).not.toMatch(/Khách QA|\+849|qa_owner|MUST_NOT_LEAK/);
    }
    const crossTenant = await post(lifecycleEvent(A, 'tenant.deletion_cancelled', ledgers[0]!.requestId, 60_000, { entitlement: { productCode: 'CUSTOMER_CARE_CRM', status: 'ACTIVE' } }));
    expect(crossTenant.status).toBe(409); expect(crossTenant.body.message).toBe('REQUEST_TENANT_MISMATCH');
    expect((await prisma.crmTenant.findUnique({ where: { platformTenantId: A.tenantId } }))?.deletionRequestId).toBe(reqA); // A still locked by its own request
  });

  it('a failed purge reports FAILED, rolls back everything, and the same eventId retries for real', async () => {
    const ev = lifecycleEvent(A, 'tenant.purge_requested', reqA, -1000);
    const spy = jest.spyOn(lifecycle, 'purge').mockRejectedValueOnce(new Error('boom'));
    const failed = await post(ev);
    expect(failed.status).toBe(503); expect(failed.body).toMatchObject({ code: 'PURGE_FAILED', status: { status: 'FAILED', requestId: reqA } });
    expect(await tenantRows(A)).toMatchObject({ crmTenant: 1, careJob: 1 });
    expect(await prisma.platformEvent.findUnique({ where: { eventId: ev.eventId } })).toBeNull();
    spy.mockRestore();

    const ok = await post(signedEvent({ type: 'tenant.purge_requested', productCode: 'CUSTOMER_CARE_CRM', tenant: { platformTenantId: A.tenantId }, deletion: deletion(reqA, -1000) }, { eventId: ev.eventId }));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ result: 'APPLIED', requestId: reqA, platformTenantId: A.tenantId, productCode: 'CUSTOMER_CARE_CRM', status: 'COMPLETED', errorCode: null, errorMessage: null });
    expect(ok.body.completedAt).toEqual(expect.any(String));
  });

  it('purge removed only tenant A CRM data, kept the no-PII ledger and idempotency records', async () => {
    expect(await tenantRows(A)).toEqual({ crmTenant: 0, installation: 0, careJob: 0, zaloAccount: 0, session: 0 });
    expect(await prisma.optOut.count({ where: { installationId: A.inst } })).toBe(0);
    expect(await prisma.deliveryQuotaCounter.count({ where: { scopeId: A.account } })).toBe(0);
    expect(await tenantRows(B)).toMatchObject({ crmTenant: 1, installation: 1, careJob: 1, zaloAccount: 1 });
    expect(await tenantRows(C)).toMatchObject({ crmTenant: 1, installation: 1, careJob: 1, zaloAccount: 1 });
    const ledger = await prisma.crmTenantDeletion.findUnique({ where: { requestId: reqA } });
    expect(ledger).toMatchObject({ status: 'COMPLETED', purgeAttempts: 1 });
    const remaining = await prisma.auditLog.findMany({ where: { tenantId: A.tenantId } });
    expect(remaining.map((r) => r.action).sort()).toEqual(['PLATFORM_EVENT_TENANT_PURGE_REQUESTED', 'TENANT_PURGED']);
    expect(JSON.stringify(remaining)).not.toMatch(/MUST_NOT_LEAK|Khách QA|\+849/);
    expect(await prisma.systemSetting.count()).toBeGreaterThanOrEqual(0);
  });

  it('retrying a completed purge returns the same result with no further effect', async () => {
    const replay = await post(lifecycleEvent(A, 'tenant.purge_requested', reqA, -1000));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'COMPLETED', requestId: reqA });
    expect((await prisma.crmTenantDeletion.findUnique({ where: { requestId: reqA } }))?.purgeAttempts).toBe(1);
  });
});
