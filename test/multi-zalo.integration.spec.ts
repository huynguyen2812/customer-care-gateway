import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import * as nodeHttp from 'node:http';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { CryptoService } from '../src/common/crypto.service';
import { dayKey } from '../src/common/day-key';
import { CareWorkerService } from '../src/worker/care-worker.service';
import { AccountSelectorService } from '../src/delivery/account-selector.service';
import { QuotaService } from '../src/delivery/quota.service';
import { ChannelRouterService } from '../src/channel/channel-router.service';
import { FakePlatform, signedPlatformEvent } from './helpers/fake-platform';

/**
 * Multi-Zalo-account delivery against a real PostgreSQL QA database.
 * Tenant A owns 3 accounts, tenant B owns 2, tenant C is a legacy tenant without a CrmTenant row.
 * The sender is a test-only fake implementing contract v2 (docs/multi-zalo-sender-contract.md):
 * it dedupes by deliveryAttemptId and records what it "delivered", so duplicate sends are countable.
 * No real Zalo account, QR, phone number or message is involved.
 */
const ORIGIN = 'http://crm.test';
const ISSUER = 'vetclinic.vn-platform-test';
const EVENTS_SECRET = randomBytes(32).toString('hex');
const SIGNING_KEY = randomBytes(32).toString('base64url');
const PHONE = '+84901234567';

type Mode = 'ok' | 'slow' | 'timeout' | 'unknown' | 'relogin' | 'notfound';

/** Fake sender v2: idempotent by deliveryAttemptId; `delivered` = messages that would have reached Zalo. */
class FakeSender {
  server!: nodeHttp.Server; base = '';
  mode = new Map<string, Mode>();
  eligibility = new Map<string, string>();
  delivered = new Map<string, { accountId: string; providerMessageId: string }>();
  calls: { accountId: string; deliveryAttemptId: string }[] = [];
  badSignatures = 0;
  async start() {
    this.server = nodeHttp.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
        const reply = (status: number, body: unknown, delay = 0) => setTimeout(() => { if (!res.writableEnded) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } }, delay);
        const path = new URL(req.url!, 'http://x').pathname;
        const expected = createHmac('sha256', SIGNING_KEY).update(`${req.method}\n${path}\n${req.headers['x-gateway-timestamp']}\n${req.headers['x-gateway-nonce']}\n${createHash('sha256').update(raw).digest('hex')}`).digest('hex');
        if (req.headers['x-gateway-signature'] !== expected) { this.badSignatures++; return reply(401, { code: 'BAD_SIGNATURE' }); }
        const accountId = String(req.headers['x-gateway-account-id']);
        if (path === '/internal/v1/messages/send-known-contact') {
          const body = JSON.parse(raw) as { deliveryAttemptId: string; channelAccountId: string };
          expect(body.channelAccountId).toBe(accountId);
          this.calls.push({ accountId, deliveryAttemptId: body.deliveryAttemptId });
          const mode = this.mode.get(accountId) || 'ok';
          if (mode === 'relogin') return reply(423, { delivery: 'NOT_SENT', code: 'RELOGIN_REQUIRED' });
          if (mode === 'notfound') return reply(404, { delivery: 'NOT_SENT', code: 'RECIPIENT_NOT_FOUND' });
          const prior = this.delivered.get(body.deliveryAttemptId);
          const msg = prior || { accountId, providerMessageId: `fake_${randomUUID().slice(0, 8)}` };
          if (!prior) this.delivered.set(body.deliveryAttemptId, msg); // idempotency: same attempt → same message
          if (mode === 'unknown') return reply(502, { delivery: 'UNKNOWN', code: 'ZALO_TIMEOUT' });
          return reply(200, { delivery: 'SENT', providerMessageId: msg.providerMessageId }, mode === 'timeout' ? 1500 : mode === 'slow' ? 150 : 0);
        }
        const m = /^\/internal\/v1\/accounts\/([^/]+)\/(recipient-eligibility|login\/start|login\/([^/]+)|pause|resume|disconnect)$/.exec(path);
        if (m && m[1] === accountId) {
          if (m[2] === 'recipient-eligibility') return reply(200, { result: this.eligibility.get(accountId) || 'ELIGIBLE_EXISTING_FRIEND' });
          if (m[2] === 'login/start') return reply(200, { loginId: `login_${randomUUID().slice(0, 12)}`, qrImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', expiresAt: new Date(Date.now() + 120_000).toISOString() });
          if (m[3]) return reply(200, { status: 'CONNECTED', displayName: 'Zalo QA', phoneMasked: '090****111' });
          return reply(200, { ok: true });
        }
        reply(404, {});
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  reset() { this.mode.clear(); this.eligibility.clear(); this.calls = []; }
  stop() { this.server.closeAllConnections(); return new Promise((r) => this.server.close(r)); }
}

describe('Multi Zalo accounts (routing, anti-duplicate, quota, isolation)', () => {
  const prisma = new PrismaClient();
  const platform = new FakePlatform(ISSUER);
  const sender = new FakeSender();
  const verifier = nodeHttp.createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ valid: !raw.includes('invalid') })); }); });
  let verifyUrl = '';
  let app: INestApplication; let crypto: CryptoService; let worker: CareWorkerService; let selector: AccountSelectorService; let quota: QuotaService;
  const mkTenant = (n: string) => ({ n, tenantId: randomUUID(), userId: randomUUID(), clientId: `crm_${randomUUID().slice(0, 12)}`, secret: randomBytes(24).toString('base64url'), inst: [] as string[], acc: [] as string[] });
  const A = mkTenant('A'); const B = mkTenant('B'); const C = mkTenant('C');
  const installationIds: string[] = [];
  const http = () => request(app.getHttpServer());
  type Session = { cookie: string; csrf: string };
  let ownerA: Session; let ownerB: Session; let viewerA: Session; let staffA: Session;

  async function provision(t: typeof A) {
    const ev = signedPlatformEvent(EVENTS_SECRET, { action: 'UPSERT_INSTALLATION', tenant: { platformTenantId: t.tenantId, name: `Tenant ${t.n}` }, entitlement: { productCode: 'CUSTOMER_CARE_CRM', status: 'ACTIVE', planCode: 'CRM_BASIC', limits: { dailyQuotaMax: 50 } }, installation: { installationId: randomUUID(), clientId: t.clientId, clientSecret: t.secret, callbackBaseUrl: `${ORIGIN}/api/v1/crm` } });
    expect((await http().post('/api/v1/crm/platform/events').set(ev.headers).send(ev.raw)).status).toBe(200);
  }
  async function login(t: typeof A, crmRoles?: string[]): Promise<Session> {
    const state = randomBytes(32).toString('base64url');
    const code = platform.grant({ tenantId: t.tenantId, userId: crmRoles ? randomUUID() : t.userId, clientId: t.clientId, crmRoles });
    const res = await http().get(`/api/v1/crm/auth/platform/callback?code=${code}&installation=${t.clientId}&state=${state}`).set('Cookie', `vc_crm_sso_state=${state}`);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('vc_crm_session='))!.split(';')[0];
    const me = await http().get('/api/v1/crm/auth/me').set('Cookie', cookie);
    return { cookie, csrf: me.body.csrfToken };
  }
  const get = (s: Session, path: string) => http().get(`/api/v1/crm${path}`).set('Cookie', s.cookie);
  const write = (s: Session, method: 'post' | 'patch' | 'put', path: string, body: unknown = {}) => http()[method](`/api/v1/crm${path}`).set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send(body as object);

  async function installation(t: typeof A, extra: Partial<Prisma.InstallationUncheckedCreateInput> = {}) {
    const inst = await prisma.installation.create({ data: { tenantId: t.tenantId, sourceProduct: 'PETCLINIC_ESSENTIAL', status: 'ACTIVE', scopes: ['care:job:create'], dailyQuota: 100, sourceVerifyUrl: verifyUrl, callbackSecretEnc: crypto.encrypt(randomBytes(32).toString('base64url')), quietHoursStart: '00:00', quietHoursEnd: '00:00', ...extra } });
    installationIds.push(inst.id); t.inst.push(inst.id);
    await prisma.messageTemplate.create({ data: { installationId: inst.id, code: 'QA_MZ', body: 'Nhắc lịch {{petName}}', allowedVariables: ['petName'] } });
    return inst.id;
  }
  /** Simulates a completed QR login (the real one is BLOCKED on the sender): CONNECTED + per-account sender config. */
  const connect = (id: string, caps: Record<string, unknown> = {}) => prisma.zaloAccount.update({ where: { id }, data: { status: 'CONNECTED', paused: false, senderBaseUrl: sender.base, senderClientId: 'gw-qa', credentialEnc: crypto.encrypt(SIGNING_KEY), capabilities: { contractVersion: 2, ...caps }, lastConnectedAt: new Date() } });
  let seq = 0;
  async function job(instId: string, o: { branchId?: string; eventType?: string; ref?: string; consent?: 'GRANTED' | 'WITHDRAWN'; selected?: string } = {}) {
    const inst = await prisma.installation.findUniqueOrThrow({ where: { id: instId } });
    const j = await prisma.careJob.create({ data: {
      installationId: instId, idempotencyKey: `mz-${++seq}-${randomUUID()}`, requestHash: createHash('sha256').update(randomUUID()).digest('hex'), externalReferenceId: o.ref || `appointment:MZ-${seq}`, sourceProduct: inst.sourceProduct,
      eventType: o.eventType || 'APPOINTMENT_REMINDER', recipientNameEnc: crypto.encrypt('Khách giả lập'), phoneEnc: crypto.encrypt(PHONE), phoneHash: crypto.phoneHash(PHONE), templateCode: 'QA_MZ', templateVariables: { petName: 'Mít' },
      scheduledAt: new Date(Date.now() + 3650 * 86400_000), consentStatus: o.consent || 'GRANTED', branchId: o.branchId ?? null, selectedZaloAccountId: o.selected ?? null } });
    return j.id;
  }
  /** Makes only this job due and lets `workers` workers compete for it. */
  async function run(jobId: string, workers = 1) {
    await prisma.careJob.update({ where: { id: jobId }, data: { scheduledAt: new Date(Date.now() - 1000), nextAttemptAt: null } });
    await Promise.all(Array.from({ length: workers }, (_, i) => worker.processNext(`mz-worker-${i}`)));
    return prisma.careJob.findUniqueOrThrow({ where: { id: jobId } });
  }
  const attempts = (jobId: string) => prisma.deliveryAttempt.findMany({ where: { careJobId: jobId }, orderBy: { attemptNumber: 'asc' } });
  const today = () => dayKey(new Date(), 'Asia/Ho_Chi_Minh');
  const setUsed = (scope: 'ACCOUNT' | 'TENANT' | 'INSTALLATION', scopeId: string, used: number) => prisma.deliveryQuotaCounter.upsert({ where: { scope_scopeId_day: { scope, scopeId, day: today() } }, create: { scope, scopeId, day: today(), used }, update: { used } });
  async function resetAccounts() {
    sender.reset();
    for (const id of [...A.acc, ...B.acc]) await connect(id);
    await prisma.deliveryQuotaCounter.deleteMany({ where: { scopeId: { in: [...A.acc, ...B.acc, A.tenantId, B.tenantId, ...installationIds] } } });
  }

  beforeAll(async () => {
    await platform.start(); await sender.start();
    await new Promise<void>((r) => verifier.listen(0, '127.0.0.1', r));
    verifyUrl = `http://127.0.0.1:${(verifier.address() as AddressInfo).port}/verify`;
    for (const t of [A, B]) platform.credentials.set(t.clientId, { secret: t.secret, tenantId: t.tenantId });
    Object.assign(process.env, {
      PHONE_HASH_PEPPER: randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), WORKER_ENABLED: 'false', MOCK_ADAPTER_ENABLED: 'false', SENDER_TIMEOUT_MS: '300',
      CRM_SESSION_SECRET: randomBytes(32).toString('hex'), ADMIN_SESSION_SECRET: randomBytes(32).toString('hex'), CRM_PUBLIC_ORIGIN: ORIGIN,
      PLATFORM_API_BASE_URL: `${platform.base}/api`, PLATFORM_ALLOW_HTTP_LOCAL: 'true', PLATFORM_AUTH_ISSUER: ISSUER, PLATFORM_WEB_ORIGIN: 'http://platform.test',
      CRM_PLATFORM_EVENTS_SECRET: EVENTS_SECRET, CRM_ENTITLEMENT_RECHECK_SECONDS: '15',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ rawBody: true }); app.setGlobalPrefix('api/v1'); await app.init();
    crypto = new CryptoService(); worker = app.get(CareWorkerService); selector = app.get(AccountSelectorService); quota = app.get(QuotaService);
    const due = await prisma.careJob.count({ where: { status: 'QUEUED', scheduledAt: { lte: new Date() }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] } });
    if (due) throw new Error(`QA database has ${due} unrelated due QUEUED jobs; use a clean QA database.`);
    await provision(A); await provision(B);
    ownerA = await login(A); ownerB = await login(B);
    viewerA = await login(A, ['CRM_VIEWER']); staffA = await login(A, ['CRM_STAFF']);
    await installation(A); await installation(A, { sourceProduct: 'B2B_SALE' }); await installation(B); await installation(C);
  });

  afterAll(async () => {
    const tenants = [A.tenantId, B.tenantId, C.tenantId];
    await prisma.webhookDelivery.deleteMany({ where: { installationId: { in: installationIds } } });
    await prisma.deliveryAttempt.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.careJob.deleteMany({ where: { installationId: { in: installationIds } } });
    await prisma.zaloRoutingRule.deleteMany({ where: { tenantId: { in: tenants } } });
    const accounts = (await prisma.zaloAccount.findMany({ where: { tenantId: { in: tenants } }, select: { id: true } })).map((a) => a.id);
    await prisma.deliveryQuotaCounter.deleteMany({ where: { scopeId: { in: [...accounts, ...tenants, ...installationIds] } } });
    await prisma.zaloAccount.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.optOut.deleteMany({ where: { installationId: { in: installationIds } } });
    await prisma.messageTemplate.deleteMany({ where: { installationId: { in: installationIds } } });
    await prisma.installation.deleteMany({ where: { id: { in: installationIds } } });
    await prisma.crmTenant.deleteMany({ where: { platformTenantId: { in: tenants } } });
    await prisma.crmSsoTokenReplay.deleteMany({ where: { platformTenantId: { in: tenants } } });
    await prisma.platformEvent.deleteMany({ where: { platformTenantId: { in: tenants } } });
    await app.close(); await platform.stop(); await sender.stop(); await new Promise((r) => verifier.close(r)); await prisma.$disconnect();
  });

  // ---------------- 1. CRM API: tenant ownership, IDOR, permissions ----------------
  describe('1. CRM account API', () => {
    it('tenant A creates 3 accounts, tenant B creates 2; the first becomes the default; lists never cross tenants', async () => {
      for (const [s, t, names] of [[ownerA, A, ['Zalo A1', 'Zalo A2', 'Zalo A3']], [ownerB, B, ['Zalo B1', 'Zalo B2']]] as const) {
        for (const displayName of names) {
          const r = await write(s, 'post', '/zalo-accounts', { displayName, dailyQuota: 10 });
          expect(r.status).toBe(200); expect(r.body.status).toBe('PENDING_LOGIN'); t.acc.push(r.body.id);
        }
      }
      const la = await get(ownerA, '/zalo-accounts'); const lb = await get(ownerB, '/zalo-accounts');
      expect(la.body.accounts.map((a: { id: string }) => a.id).sort()).toEqual([...A.acc].sort());
      expect(lb.body.accounts.map((a: { id: string }) => a.id).sort()).toEqual([...B.acc].sort());
      expect(la.body.accounts.filter((a: { isDefault: boolean }) => a.isDefault).map((a: { id: string }) => a.id)).toEqual([A.acc[0]]);
      expect(la.body.tenantDailyLimit).toBe(50);
      const audit = await prisma.auditLog.count({ where: { tenantId: A.tenantId, action: 'ZALO_ACCOUNT_CREATED' } });
      expect(audit).toBe(3);
    });

    it('responses never contain sender URL, client id, signing key, session or the full phone number', async () => {
      await connect(A.acc[0]);
      await prisma.zaloAccount.update({ where: { id: A.acc[0] }, data: { phoneEnc: crypto.encrypt(PHONE), phoneMasked: '090****567' } });
      const text = JSON.stringify((await get(ownerA, '/zalo-accounts')).body) + JSON.stringify((await get(ownerA, `/zalo-accounts/${A.acc[0]}`)).body);
      expect(text).toContain('090****567');
      expect(text).not.toMatch(/senderBaseUrl|senderClientId|credentialEnc|phoneEnc|gw-qa|127\.0\.0\.1|901234567|cookie/i);
      expect(text).not.toContain(SIGNING_KEY);
    });

    it('a foreign account id and a random id get the same 404 on every endpoint', async () => {
      const foreign = B.acc[0]; const random = randomUUID();
      const calls: [string, (id: string) => request.Test][] = [
        ['GET', (id) => get(ownerA, `/zalo-accounts/${id}`)],
        ['PATCH', (id) => write(ownerA, 'patch', `/zalo-accounts/${id}`, { displayName: 'Chiếm quyền' })],
        ['pause', (id) => write(ownerA, 'post', `/zalo-accounts/${id}/pause`)],
        ['resume', (id) => write(ownerA, 'post', `/zalo-accounts/${id}/resume`)],
        ['disconnect', (id) => write(ownerA, 'post', `/zalo-accounts/${id}/disconnect`)],
        ['login/start', (id) => write(ownerA, 'post', `/zalo-accounts/${id}/login/start`)],
        ['login/status', (id) => get(ownerA, `/zalo-accounts/${id}/login/status?loginId=login_abcdefgh`)],
      ];
      for (const [, call] of calls) {
        const f = await call(foreign); const r = await call(random); const bad = await call('not-a-uuid');
        expect(f.status).toBe(404); expect(r.status).toBe(404); expect(bad.status).toBe(404);
        expect(f.body).toEqual(r.body);
      }
      const b0 = await prisma.zaloAccount.findUniqueOrThrow({ where: { id: foreign } });
      expect(b0.displayName).toBe('Zalo B1'); expect(b0.paused).toBe(false); expect(b0.status).toBe('PENDING_LOGIN');
    });

    it('routing rules: foreign account/installation → 404, duplicates → 409, invalid branch → 400; valid set replaces atomically', async () => {
      expect((await write(ownerA, 'put', '/zalo-routing-rules', { rules: [{ zaloAccountId: B.acc[0] }] })).status).toBe(404);
      expect((await write(ownerA, 'put', '/zalo-routing-rules', { rules: [{ zaloAccountId: A.acc[1], installationId: B.inst[0] }] })).status).toBe(404);
      expect((await write(ownerA, 'put', '/zalo-routing-rules', { rules: [{ zaloAccountId: A.acc[1], installationId: A.inst[0] }, { zaloAccountId: A.acc[1], installationId: A.inst[0] }] })).status).toBe(409);
      expect((await write(ownerA, 'put', '/zalo-routing-rules', { rules: [{ zaloAccountId: A.acc[2], branchId: 'bad branch!' }] })).status).toBe(400);
      const ok = await write(ownerA, 'put', '/zalo-routing-rules', { rules: [
        { zaloAccountId: A.acc[1], installationId: A.inst[0] },
        { zaloAccountId: A.acc[2], branchId: 'CN-Q1' },
        { zaloAccountId: A.acc[1], installationId: A.inst[1], eventType: 'VACCINE_REMINDER' },
      ] });
      expect(ok.status).toBe(200); expect(ok.body).toHaveLength(3);
      expect((await get(ownerB, '/zalo-routing-rules')).body).toEqual([]);
      expect(await prisma.auditLog.count({ where: { tenantId: A.tenantId, action: 'ZALO_ROUTING_RULES_REPLACED' } })).toBe(1);
    });

    it('viewer and staff can read but not manage accounts or rules', async () => {
      for (const s of [viewerA, staffA]) {
        expect((await get(s, '/zalo-accounts')).status).toBe(s === staffA ? 200 : 403);
        expect((await write(s, 'post', `/zalo-accounts/${A.acc[0]}/pause`)).status).toBe(403);
        expect((await write(s, 'post', '/zalo-accounts', { displayName: 'Không được' })).status).toBe(403);
        expect((await write(s, 'put', '/zalo-routing-rules', { rules: [] })).status).toBe(403);
      }
    });

    it('sum of account quotas cannot exceed the tenant/plan limit', async () => {
      const r = await write(ownerA, 'post', '/zalo-accounts', { displayName: 'Quá hạn mức', dailyQuota: 30 });
      expect(r.status).toBe(403); expect(r.body.code).toBe('PLAN_LIMIT');
      expect((await write(ownerA, 'patch', `/zalo-accounts/${A.acc[0]}`, { dailyQuota: 40 })).status).toBe(403);
    });

    it('QR login: 501 when the sender lacks qrLogin (no fake QR); with the capability returns a QR only, never a session', async () => {
      const r = await write(ownerA, 'post', `/zalo-accounts/${A.acc[2]}/login/start`);
      expect(r.status).toBe(501); expect(r.body.code).toBe('SENDER_NOT_SUPPORTED');
      await connect(A.acc[2], { qrLogin: true }); await prisma.zaloAccount.update({ where: { id: A.acc[2] }, data: { status: 'PENDING_LOGIN' } });
      const s = await write(ownerA, 'post', `/zalo-accounts/${A.acc[2]}/login/start`);
      expect(s.status).toBe(200); expect(s.body.qrImage).toMatch(/^data:image\/png;base64,/);
      expect(Object.keys(s.body).sort()).toEqual(['expiresAt', 'loginId', 'qrImage']);
      expect((await prisma.zaloAccount.findUniqueOrThrow({ where: { id: A.acc[2] } })).status).toBe('CONNECTING');
      const st = await get(ownerA, `/zalo-accounts/${A.acc[2]}/login/status?loginId=${s.body.loginId}`);
      expect(st.status).toBe(200); expect(st.body.status).toBe('CONNECTED');
      expect((await prisma.zaloAccount.findUniqueOrThrow({ where: { id: A.acc[2] } })).status).toBe('CONNECTED');
    });

    it('pause/resume/disconnect change routing state and are audited', async () => {
      expect((await write(ownerA, 'post', `/zalo-accounts/${A.acc[1]}/pause`)).body.paused).toBe(true);
      expect((await get(ownerA, `/zalo-accounts/${A.acc[1]}`)).body.unavailableReason).toBe('PAUSED');
      expect((await write(ownerA, 'post', `/zalo-accounts/${A.acc[1]}/resume`)).body.paused).toBe(false);
      expect((await write(ownerA, 'post', `/zalo-accounts/${A.acc[1]}/disconnect`)).body.status).toBe('DISCONNECTED');
      const actions = (await prisma.auditLog.findMany({ where: { tenantId: A.tenantId, targetId: A.acc[1] }, select: { action: true } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['ZALO_ACCOUNT_PAUSED', 'ZALO_ACCOUNT_RESUMED', 'ZALO_ACCOUNT_DISCONNECTED']));
    });
  });

  // ---------------- 2. Routing ----------------
  describe('2. Routing', () => {
    beforeEach(resetAccounts);
    const inst = async (id: string) => prisma.installation.findUniqueOrThrow({ where: { id } });
    const pick = async (instId: string, o: { branchId?: string; eventType?: string } = {}) =>
      (await selector.candidates({ installationId: instId, branchId: o.branchId ?? null, eventType: o.eventType || 'APPOINTMENT_REMINDER' }, await inst(instId))).map((c) => c.account.id);

    it('branch rule > installation rule > tenant default; event-specific rule; unassigned accounts never used', async () => {
      expect((await pick(A.inst[0], { branchId: 'CN-Q1' }))[0]).toBe(A.acc[2]);
      expect(await pick(A.inst[0])).toEqual([A.acc[1], A.acc[0]]); // A3 has only a branch rule
      expect(await pick(A.inst[1])).toEqual([A.acc[0]]);
      expect((await pick(A.inst[1], { eventType: 'VACCINE_REMINDER' }))[0]).toBe(A.acc[1]);
      expect(await pick(A.inst[0], { branchId: 'CN-KHAC' })).toEqual([A.acc[1], A.acc[0]]);
    });

    it('paused, relogin, restricted, disconnected and quota-exhausted accounts are skipped', async () => {
      const cases: Prisma.ZaloAccountUpdateInput[] = [{ paused: true }, { status: 'RELOGIN_REQUIRED' }, { status: 'RESTRICTED' }, { status: 'DISCONNECTED' }, { status: 'RATE_LIMITED' }];
      for (const data of cases) {
        await prisma.zaloAccount.update({ where: { id: A.acc[2] }, data });
        expect((await pick(A.inst[0], { branchId: 'CN-Q1' }))[0]).toBe(A.acc[1]);
        await connect(A.acc[2]);
      }
      await setUsed('ACCOUNT', A.acc[2], 10);
      expect(await pick(A.inst[0], { branchId: 'CN-Q1' })).not.toContain(A.acc[2]);
    });

    it('tenant B accounts are never candidates for tenant A (and vice versa)', async () => {
      for (const i of A.inst) expect((await pick(i)).some((id) => B.acc.includes(id))).toBe(false);
      expect(await pick(B.inst[0])).toEqual([B.acc[0]]);
    });

    it('worker persists the selected account, audits it and sends through that account only', async () => {
      const id = await job(A.inst[0], { branchId: 'CN-Q1' });
      const j = await run(id);
      expect(j.status).toBe('SENT'); expect(j.selectedZaloAccountId).toBe(A.acc[2]); expect(j.selectedChannel).toBe('PERSONAL_ZALO');
      expect(sender.calls).toEqual([{ accountId: A.acc[2], deliveryAttemptId: (await attempts(id))[0].id }]);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { targetId: id, action: 'ZALO_ACCOUNT_SELECTED' } });
      expect(audit.metadata).toMatchObject({ zaloAccountId: A.acc[2], tier: 'BRANCH', reason: 'RULE' });
      expect(await quota.used('ACCOUNT', A.acc[2], today())).toBe(1);
      expect(await quota.used('TENANT', A.tenantId, today())).toBe(1);
    });

    it('sticky: a retry keeps the previously selected account while it stays usable', async () => {
      const id = await job(A.inst[0], { selected: A.acc[0] });
      const j = await run(id);
      expect(j.status).toBe('SENT'); expect(j.selectedZaloAccountId).toBe(A.acc[0]);
      expect(await prisma.auditLog.count({ where: { targetId: id, action: { in: ['ZALO_ACCOUNT_SELECTED', 'ZALO_ACCOUNT_RESELECTED'] } } })).toBe(0);
    });

    it('no eligible account → requeued NO_ELIGIBLE_ACCOUNT, nothing sent, never falls back to MOCK', async () => {
      for (const id of A.acc) await prisma.zaloAccount.update({ where: { id }, data: { paused: true } });
      const mock = await prisma.zaloAccount.create({ data: { tenantId: A.tenantId, channel: 'MOCK', status: 'CONNECTED', dailyQuota: 5, displayName: 'Mock không được dùng' } });
      await prisma.zaloRoutingRule.create({ data: { tenantId: A.tenantId, zaloAccountId: mock.id, installationId: A.inst[0], createdBy: 'test' } });
      const id = await job(A.inst[0]);
      const j = await run(id);
      expect(j.status).toBe('QUEUED'); expect(j.failureCode).toBe('NO_ELIGIBLE_ACCOUNT');
      expect(sender.calls).toHaveLength(0); expect(await attempts(id)).toHaveLength(0);
      await prisma.zaloRoutingRule.deleteMany({ where: { zaloAccountId: mock.id } }); await prisma.zaloAccount.delete({ where: { id: mock.id } });
      await prisma.careJob.update({ where: { id }, data: { status: 'CANCELLED' } });
    });

    it('ZNS account is refused with a clear code (not implemented), never silently sent', async () => {
      const zns = await prisma.zaloAccount.create({ data: { tenantId: C.tenantId, channel: 'ZNS', status: 'CONNECTED', dailyQuota: 5, displayName: 'ZNS QA', isDefault: true } });
      const cInst = C.inst[0];
      const c = await selector.candidates({ installationId: cInst, branchId: null, eventType: 'APPOINTMENT_REMINDER' }, await inst(cInst));
      expect(c).toHaveLength(0);
      const router = app.get(ChannelRouterService);
      expect(await router.send(zns, C.tenantId, { installationId: cInst, channelAccountId: zns.id, deliveryAttemptId: randomUUID(), externalReferenceId: 'x', recipientName: 'x', phoneE164: PHONE, templateCode: 'QA_MZ', content: 'x' })).toEqual({ kind: 'NOT_SENT', code: 'CHANNEL_NOT_SUPPORTED' });
      await prisma.zaloAccount.delete({ where: { id: zns.id } });
    });
  });

  // ---------------- 3. Anti-duplicate ----------------
  describe('3. Anti-duplicate', () => {
    beforeEach(resetAccounts);

    it('two workers competing for one job → exactly one sender call', async () => {
      sender.mode.set(A.acc[1], 'slow');
      const id = await job(A.inst[0]);
      const j = await run(id, 4);
      expect(j.status).toBe('SENT'); expect(sender.calls).toHaveLength(1); expect(await attempts(id)).toHaveLength(1);
    });

    it('timeout → UNKNOWN: no failover to another account, job parked DELIVERY_UNCERTAIN, quota kept, no webhook', async () => {
      sender.mode.set(A.acc[1], 'timeout');
      const id = await job(A.inst[0]);
      const j = await run(id);
      expect(j.status).toBe('FAILED'); expect(j.failureCode).toBe('DELIVERY_UNCERTAIN');
      expect(sender.calls.map((c) => c.accountId)).toEqual([A.acc[1]]);
      const [a] = await attempts(id); expect(a.status).toBe('UNKNOWN'); expect(a.outcomeCode).toBe('SENDER_TIMEOUT'); expect(a.quotaReleased).toBe(false);
      expect(await quota.used('ACCOUNT', A.acc[1], today())).toBe(1);
      expect(await prisma.webhookDelivery.count({ where: { careJobId: id } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { targetId: id, action: 'DELIVERY_UNCERTAIN' } })).toBe(1);
      // A later worker pass never resends a parked job.
      expect(await run(id)).toMatchObject({ status: 'FAILED' }); expect(sender.calls).toHaveLength(1);
    });

    it('UNKNOWN with an idempotent sender → retried with the SAME deliveryAttemptId on the SAME account; delivered once', async () => {
      await connect(A.acc[1], { idempotentSend: true });
      sender.mode.set(A.acc[1], 'unknown');
      const id = await job(A.inst[0]);
      let j = await run(id);
      expect(j.status).toBe('QUEUED'); expect(j.failureCode).toBe('DELIVERY_RETRY_SAME_ATTEMPT');
      sender.mode.set(A.acc[1], 'ok');
      j = await run(id);
      expect(j.status).toBe('SENT');
      const list = await attempts(id); expect(list).toHaveLength(1); expect(list[0].sendCount).toBe(2);
      expect(sender.calls).toHaveLength(2); expect(new Set(sender.calls.map((c) => c.deliveryAttemptId)).size).toBe(1);
      expect(new Set(sender.calls.map((c) => c.accountId))).toEqual(new Set([A.acc[1]]));
      expect(sender.delivered.get(list[0].id)!.providerMessageId).toBe(j.providerMessageId);
      expect(await quota.used('ACCOUNT', A.acc[1], today())).toBe(1);
    });

    it('certain NOT_SENT before send (relogin) → failover to the next account, quota released, account marked', async () => {
      sender.mode.set(A.acc[1], 'relogin');
      const id = await job(A.inst[0]);
      const j = await run(id);
      expect(j.status).toBe('SENT'); expect(j.selectedZaloAccountId).toBe(A.acc[0]);
      const [first, second] = await attempts(id);
      expect(first).toMatchObject({ zaloAccountId: A.acc[1], status: 'REJECTED_BEFORE_SEND', outcomeCode: 'RELOGIN_REQUIRED', quotaReleased: true });
      expect(second).toMatchObject({ zaloAccountId: A.acc[0], status: 'SENT' });
      expect((await prisma.zaloAccount.findUniqueOrThrow({ where: { id: A.acc[1] } })).status).toBe('RELOGIN_REQUIRED');
      expect(await quota.used('ACCOUNT', A.acc[1], today())).toBe(0);
      expect(await quota.used('TENANT', A.tenantId, today())).toBe(1);
      expect(await prisma.auditLog.count({ where: { targetId: id, action: { in: ['ZALO_ACCOUNT_REJECTED_BEFORE_SEND', 'ZALO_ACCOUNT_RESELECTED'] } } })).toBe(2);
    });

    it('recipient not found → terminal RECIPIENT_NOT_FOUND, no other account is tried', async () => {
      sender.mode.set(A.acc[1], 'notfound');
      const id = await job(A.inst[0]);
      expect((await run(id)).status).toBe('RECIPIENT_NOT_FOUND'); expect(sender.calls).toHaveLength(1);
    });

    it('an attempt that already has a providerMessageId is reconciled, never resent', async () => {
      const id = await job(A.inst[0], { selected: A.acc[1] });
      await prisma.deliveryAttempt.create({ data: { tenantId: A.tenantId, careJobId: id, installationId: A.inst[0], zaloAccountId: A.acc[1], attemptNumber: 1, requestHash: 'x'.repeat(64), status: 'SENT', providerMessageId: 'fake_prior', quotaScopes: [] } });
      const j = await run(id);
      expect(j.status).toBe('SENT'); expect(j.providerMessageId).toBe('fake_prior'); expect(sender.calls).toHaveLength(0);
    });

    it('worker restart with an IN_FLIGHT attempt → no resend without sender idempotency (parked)', async () => {
      const id = await job(A.inst[0], { selected: A.acc[1] });
      await prisma.deliveryAttempt.create({ data: { tenantId: A.tenantId, careJobId: id, installationId: A.inst[0], zaloAccountId: A.acc[1], attemptNumber: 1, requestHash: 'y'.repeat(64), status: 'IN_FLIGHT', sendCount: 1, quotaScopes: [] } });
      const j = await run(id);
      expect(j.status).toBe('FAILED'); expect(j.failureCode).toBe('DELIVERY_UNCERTAIN'); expect(sender.calls).toHaveLength(0);
      expect((await attempts(id))[0].outcomeCode).toBe('WORKER_RESTARTED_DURING_SEND');
    });

    it('worker restart with IN_FLIGHT + idempotent sender that already delivered → same attempt id, still one message', async () => {
      await connect(A.acc[1], { idempotentSend: true });
      const id = await job(A.inst[0], { selected: A.acc[1] });
      const a = await prisma.deliveryAttempt.create({ data: { tenantId: A.tenantId, careJobId: id, installationId: A.inst[0], zaloAccountId: A.acc[1], attemptNumber: 1, requestHash: 'z'.repeat(64), status: 'IN_FLIGHT', sendCount: 1, quotaScopes: [] } });
      sender.delivered.set(a.id, { accountId: A.acc[1], providerMessageId: 'fake_before_crash' });
      const j = await run(id);
      expect(j.status).toBe('SENT'); expect(j.providerMessageId).toBe('fake_before_crash');
      expect(sender.calls).toEqual([{ accountId: A.acc[1], deliveryAttemptId: a.id }]);
    });

    it('worker restart with a RESERVED attempt (send never started) → closed, quota released, new attempt sent', async () => {
      const id = await job(A.inst[0], { selected: A.acc[1] });
      const scopes = [{ scope: 'ACCOUNT', scopeId: A.acc[1], day: today(), limit: 10 }];
      await setUsed('ACCOUNT', A.acc[1], 1);
      await prisma.deliveryAttempt.create({ data: { tenantId: A.tenantId, careJobId: id, installationId: A.inst[0], zaloAccountId: A.acc[1], attemptNumber: 1, requestHash: 'r'.repeat(64), status: 'RESERVED', quotaScopes: scopes } });
      const j = await run(id);
      expect(j.status).toBe('SENT');
      const [first, second] = await attempts(id);
      expect(first).toMatchObject({ status: 'REJECTED_BEFORE_SEND', outcomeCode: 'WORKER_RESTARTED_BEFORE_SEND', quotaReleased: true });
      expect(second.status).toBe('SENT'); expect(sender.calls).toHaveLength(1);
      expect(await quota.used('ACCOUNT', A.acc[1], today())).toBe(1);
    });

    it('stale PROCESSING job (crashed worker) is recovered to QUEUED', async () => {
      const id = await job(A.inst[0]);
      await prisma.careJob.update({ where: { id }, data: { status: 'PROCESSING', lockedAt: new Date(Date.now() - 10 * 60_000), lockedBy: 'dead-worker' } });
      expect(await worker.recoverStale()).toBeGreaterThanOrEqual(1);
      expect((await prisma.careJob.findUniqueOrThrow({ where: { id } })).status).toBe('QUEUED');
      await prisma.careJob.update({ where: { id }, data: { status: 'CANCELLED' } });
    });

    it('database refuses a second SENT attempt and a second open attempt for the same job', async () => {
      const id = await job(A.inst[0]);
      const base = { tenantId: A.tenantId, careJobId: id, installationId: A.inst[0], zaloAccountId: A.acc[1], requestHash: 'd'.repeat(64), quotaScopes: [] };
      await prisma.deliveryAttempt.create({ data: { ...base, attemptNumber: 1, status: 'SENT', providerMessageId: 'm1' } });
      await expect(prisma.deliveryAttempt.create({ data: { ...base, attemptNumber: 2, status: 'SENT', providerMessageId: 'm2' } })).rejects.toThrow();
      await prisma.deliveryAttempt.create({ data: { ...base, attemptNumber: 3, status: 'UNKNOWN' } });
      await expect(prisma.deliveryAttempt.create({ data: { ...base, attemptNumber: 4, status: 'IN_FLIGHT' } })).rejects.toThrow();
      await expect(prisma.deliveryAttempt.create({ data: { ...base, tenantId: B.tenantId, attemptNumber: 5, status: 'REJECTED_BEFORE_SEND' } })).rejects.toThrow(); // composite FK: tenant must match account/installation
      await prisma.careJob.update({ where: { id }, data: { status: 'CANCELLED' } });
    });
  });

  // ---------------- 4. Quota ----------------
  describe('4. Quota', () => {
    beforeEach(resetAccounts);

    it('20 concurrent reservations on the last 5 units → exactly 5 succeed', async () => {
      const scope = { scope: 'ACCOUNT' as const, scopeId: randomUUID(), day: today(), limit: 5 };
      const results = await Promise.all(Array.from({ length: 20 }, () => prisma.$transaction((tx) => quota.reserveIn(tx, [scope]))));
      expect(results.filter((r) => r.ok)).toHaveLength(5);
      expect(await quota.used('ACCOUNT', scope.scopeId, scope.day)).toBe(5);
      await prisma.deliveryQuotaCounter.deleteMany({ where: { scopeId: scope.scopeId } });
    });

    it('a failed later scope rolls back earlier scopes in the same reservation', async () => {
      const ok = { scope: 'TENANT' as const, scopeId: randomUUID(), day: today(), limit: 5 };
      const full = { scope: 'ACCOUNT' as const, scopeId: randomUUID(), day: today(), limit: 0 };
      await prisma.$transaction(async (tx) => { const r = await quota.reserveIn(tx, [ok, full]); if (!r.ok) throw new Error('rollback'); }).catch(() => undefined);
      expect(await quota.used('TENANT', ok.scopeId, ok.day)).toBe(0);
    });

    it('account A exhausted while account B has room → sent via B', async () => {
      await setUsed('ACCOUNT', A.acc[1], 10);
      const id = await job(A.inst[0]);
      const j = await run(id);
      expect(j.status).toBe('SENT'); expect(j.selectedZaloAccountId).toBe(A.acc[0]); expect(sender.calls.map((c) => c.accountId)).toEqual([A.acc[0]]);
    });

    it('tenant total is never exceeded even with concurrent workers and free account quota', async () => {
      await prisma.crmTenant.update({ where: { platformTenantId: B.tenantId }, data: { tenantDailyQuota: 3 } });
      await connect(B.acc[1]);
      await write(ownerB, 'put', '/zalo-routing-rules', { rules: [{ zaloAccountId: B.acc[1], installationId: B.inst[0] }] });
      const ids = await Promise.all(Array.from({ length: 6 }, () => job(B.inst[0])));
      await prisma.careJob.updateMany({ where: { id: { in: ids } }, data: { scheduledAt: new Date(Date.now() - 1000), nextAttemptAt: null } });
      await Promise.all(Array.from({ length: 6 }, (_, i) => worker.processNext(`mz-q-${i}`)));
      const jobs = await prisma.careJob.findMany({ where: { id: { in: ids } } });
      expect(jobs.filter((j) => j.status === 'SENT')).toHaveLength(3);
      expect(jobs.filter((j) => j.status === 'QUEUED').every((j) => j.failureCode === 'DAILY_QUOTA')).toBe(true);
      expect(await quota.used('TENANT', B.tenantId, today())).toBe(3);
      expect(sender.calls).toHaveLength(3);
      await prisma.careJob.updateMany({ where: { id: { in: ids }, status: 'QUEUED' }, data: { status: 'CANCELLED' } });
      await prisma.crmTenant.update({ where: { platformTenantId: B.tenantId }, data: { tenantDailyQuota: null } });
    });

    it('plan limit caps the tenant limit even when the tenant cap is higher', async () => {
      await prisma.crmTenant.update({ where: { platformTenantId: B.tenantId }, data: { tenantDailyQuota: 500 } });
      expect((await quota.tenantLimit(B.tenantId)).limit).toBe(50);
      await prisma.crmTenant.update({ where: { platformTenantId: B.tenantId }, data: { tenantDailyQuota: 7 } });
      expect((await quota.tenantLimit(B.tenantId)).limit).toBe(7);
      await prisma.crmTenant.update({ where: { platformTenantId: B.tenantId }, data: { tenantDailyQuota: null } });
      expect((await quota.tenantLimit(C.tenantId)).limit).toBeNull(); // legacy tenant: installation/account caps only
    });

    it('the quota day follows the configured timezone (resets at local midnight)', async () => {
      expect(dayKey(new Date('2026-09-23T16:59:59Z'), 'Asia/Ho_Chi_Minh')).toBe('2026-09-23');
      expect(dayKey(new Date('2026-09-23T17:00:00Z'), 'Asia/Ho_Chi_Minh')).toBe('2026-09-24');
      expect(dayKey(new Date('2026-09-23T17:00:00Z'), 'UTC')).toBe('2026-09-23');
      const scopeId = randomUUID();
      const s1 = { scope: 'ACCOUNT' as const, scopeId, day: dayKey(new Date('2026-09-23T16:00:00Z'), 'Asia/Ho_Chi_Minh'), limit: 1 };
      const s2 = { ...s1, day: dayKey(new Date('2026-09-23T18:00:00Z'), 'Asia/Ho_Chi_Minh') };
      expect((await prisma.$transaction((tx) => quota.reserveIn(tx, [s1]))).ok).toBe(true);
      expect((await prisma.$transaction((tx) => quota.reserveIn(tx, [s1]))).ok).toBe(false);
      expect((await prisma.$transaction((tx) => quota.reserveIn(tx, [s2]))).ok).toBe(true);
      await prisma.deliveryQuotaCounter.deleteMany({ where: { scopeId } });
    });
  });

  // ---------------- 5. Compatibility & existing policy gates ----------------
  describe('5. Compatibility', () => {
    let cInst = ''; let legacy = '';
    beforeAll(async () => {
      cInst = C.inst[0];
      legacy = (await prisma.zaloAccount.create({ data: { tenantId: C.tenantId, installationId: cInst, channel: 'PERSONAL_ZALO', displayName: 'Legacy QA', dailyQuota: 20, status: 'CONNECTED' } })).id;
      await prisma.zaloRoutingRule.create({ data: { tenantId: C.tenantId, zaloAccountId: legacy, installationId: cInst, createdBy: 'migration:0007' } });
    });
    beforeEach(async () => { sender.reset(); await connect(legacy); });

    it('legacy tenant (no CrmTenant row) with a backfilled installation rule and a job without a selected account still sends', async () => {
      const id = await job(cInst);
      const j = await run(id);
      expect(j.status).toBe('SENT'); expect(j.selectedZaloAccountId).toBe(legacy);
      expect((await attempts(id))[0].quotaScopes).toEqual(expect.not.arrayContaining([expect.objectContaining({ scope: 'TENANT' })]));
    });

    it('consent withdrawn and opt-out stop the job before any account is touched', async () => {
      const a = await job(cInst, { consent: 'WITHDRAWN' });
      expect((await run(a)).status).toBe('OPTED_OUT');
      await prisma.optOut.create({ data: { installationId: cInst, phoneHash: crypto.phoneHash(PHONE), source: 'QA', reason: 'Giả lập' } });
      const b = await job(cInst);
      expect((await run(b)).status).toBe('OPTED_OUT');
      await prisma.optOut.deleteMany({ where: { installationId: cInst } });
      expect(sender.calls).toHaveLength(0);
    });

    it('source recheck invalid → CANCELLED; kill switch → held; quiet hours → held; nothing sent', async () => {
      const a = await job(cInst, { ref: 'appointment:invalid-1' });
      expect(await run(a)).toMatchObject({ status: 'CANCELLED', failureCode: 'SOURCE_NO_LONGER_VALID' });
      const prior = await prisma.systemSetting.findUnique({ where: { key: 'kill_switch' } });
      await prisma.systemSetting.upsert({ where: { key: 'kill_switch' }, create: { key: 'kill_switch', value: { enabled: true }, updatedBy: 'qa' }, update: { value: { enabled: true } } });
      const b = await job(cInst);
      try { expect(await run(b)).toMatchObject({ status: 'QUEUED', failureCode: 'SYSTEM_PAUSED' }); }
      finally {
        if (prior) await prisma.systemSetting.update({ where: { key: 'kill_switch' }, data: { value: prior.value as Prisma.InputJsonValue } });
        else await prisma.systemSetting.delete({ where: { key: 'kill_switch' } });
      }
      await prisma.installation.update({ where: { id: cInst }, data: { quietHoursStart: '00:01', quietHoursEnd: '00:00' } });
      const c = await job(cInst);
      expect(await run(c)).toMatchObject({ status: 'QUEUED', failureCode: 'QUIET_HOURS' });
      await prisma.installation.update({ where: { id: cInst }, data: { quietHoursStart: '00:00', quietHoursEnd: '00:00' } });
      expect(sender.calls).toHaveLength(0);
      await prisma.careJob.updateMany({ where: { id: { in: [b, c] } }, data: { status: 'CANCELLED' } });
    });

    it('the sender received only correctly signed requests throughout', () => { expect(sender.badSignatures).toBe(0); });
  });
});
