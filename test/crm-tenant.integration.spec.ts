import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign as rsaSign, KeyObject } from 'node:crypto';
import { AddressInfo } from 'node:net';
import * as nodeHttp from 'node:http';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { CryptoService } from '../src/common/crypto.service';
import { CareJobsService } from '../src/care-jobs/care-jobs.service';
import { TenantAccessService } from '../src/crm/tenant-access.service';
import { CareWorkerService } from '../src/worker/care-worker.service';
import { ChannelRouterService } from '../src/channel/channel-router.service';

/**
 * End-to-end CRM tenant boundary tests against a real PostgreSQL QA database and a fake Platform
 * HTTP server that implements the existing Platform contract (token-exchange, session-check, JWKS).
 * The fake is test-only; production code talks to the real Platform over the same HTTP contract.
 */
const ORIGIN = 'http://crm.test';
const ISSUER = 'vetclinic.vn-platform-test';
const EVENTS_SECRET = randomBytes(32).toString('hex');

type Grant = { tenantId: string; userId: string; clientId: string; productCode: string; roles?: string[]; crmRoles?: string[]; expiresAt: number; used: boolean; deny?: 'TENANT_SUSPENDED' | 'NO_ACCESS'; jti?: string; entitlementStatus?: string };

class FakePlatform {
  server!: nodeHttp.Server; base = '';
  private key!: KeyObject; kid = `kid-${randomUUID().slice(0, 8)}`;
  credentials = new Map<string, { secret: string; tenantId: string }>();
  grants = new Map<string, Grant>();
  sessionDecision = new Map<string, 'ACTIVE' | 'DENIED' | 'DOWN'>();
  calls = { exchange: 0, sessionCheck: 0 };

  async start() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
    this.server = nodeHttp.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
        const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.url === '/api/platform-auth/.well-known/jwks.json') return send(200, { keys: [{ ...jwk, kid: this.kid, alg: 'RS256', use: 'sig' }] });
        const cred = this.credentials.get(String(req.headers['x-installation-client-id']));
        if (!cred || cred.secret !== req.headers['x-installation-client-secret']) return send(401, { message: 'bad installation' });
        const body = raw ? JSON.parse(raw) : {};
        if (req.url === '/api/platform-auth/token-exchange') {
          this.calls.exchange++;
          const g = this.grants.get(body.code);
          if (!g || g.used || g.expiresAt < Date.now()) return send(401, { message: 'Mã ủy quyền không hợp lệ.' });
          g.used = true;
          if (g.clientId !== req.headers['x-installation-client-id']) return send(403, { message: 'wrong installation' });
          if (g.deny) return send(403, { message: g.deny });
          const claims: Record<string, unknown> = { iss: ISSUER, aud: g.productCode, sub: g.userId, tenantId: g.tenantId, productCode: g.productCode, entitlementStatus: g.entitlementStatus || 'ACTIVE', roles: g.roles || ['ADMIN'], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, jti: g.jti || randomUUID() };
          if (g.crmRoles) claims.crmRoles = g.crmRoles;
          return send(200, { token: this.jwt(claims), claims, user: { id: g.userId, fullName: 'Người dùng QA', username: 'qa' }, tenant: { id: g.tenantId, name: 'Tenant QA' } });
        }
        if (req.url === '/api/platform-auth/session-check') {
          this.calls.sessionCheck++;
          const decision = this.sessionDecision.get(body.platformUserId) || 'ACTIVE';
          if (decision === 'DOWN') return send(503, { message: 'down' });
          const now = Math.floor(Date.now() / 1000);
          const claims = { iss: ISSUER, aud: 'CUSTOMER_CARE_CRM', sub: body.platformUserId, tenantId: cred.tenantId, productCode: 'CUSTOMER_CARE_CRM', decision, roles: ['TENANT_ADMIN'], iat: now, exp: now + 60, graceUntil: now + 360, jti: randomUUID() };
          return send(200, { active: decision === 'ACTIVE', decision, snapshotToken: this.jwt(claims) });
        }
        return send(404, {});
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  jwt(claims: Record<string, unknown>) {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: this.kid, typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${p}.${rsaSign('RSA-SHA256', Buffer.from(`${h}.${p}`), this.key).toString('base64url')}`;
  }
  grant(g: Omit<Grant, 'used' | 'expiresAt' | 'productCode'> & Partial<Pick<Grant, 'expiresAt' | 'productCode'>>): string {
    const code = randomBytes(24).toString('base64url');
    this.grants.set(code, { productCode: 'CUSTOMER_CARE_CRM', expiresAt: Date.now() + 60_000, used: false, ...g });
    return code;
  }
  stop() { return new Promise((r) => this.server.close(r)); }
}

function signedEvent(body: Record<string, unknown>, opts: { eventId?: string; timestamp?: number; secret?: string; tamper?: boolean } = {}) {
  const eventId = opts.eventId || randomUUID();
  const timestamp = String(opts.timestamp ?? Date.now());
  const raw = JSON.stringify({ version: 1, eventId, ...body });
  const sig = createHmac('sha256', opts.secret || EVENTS_SECRET).update(`${timestamp}.${eventId}.${createHash('sha256').update(raw).digest('hex')}`).digest('hex');
  return { eventId, raw: opts.tamper ? raw.replace('"version":1', '"version":2') : raw, headers: { 'content-type': 'application/json', 'x-platform-provisioning-id': eventId, 'x-platform-provisioning-timestamp': timestamp, 'x-platform-provisioning-signature': sig } };
}

describe('VETCLINIC CRM tenant boundary (Platform SSO, isolation, permissions, entitlement)', () => {
  const prisma = new PrismaClient();
  const platform = new FakePlatform();
  let app: INestApplication; let crypto: CryptoService;
  const A = { tenantId: randomUUID(), userId: randomUUID(), clientId: `crm_${randomUUID().slice(0, 12)}`, secret: randomBytes(24).toString('base64url'), inst: '', template: '', job: '', jobSent: '', optOutPhone: '+84900000111' };
  const B = { tenantId: randomUUID(), userId: randomUUID(), clientId: `crm_${randomUUID().slice(0, 12)}`, secret: randomBytes(24).toString('base64url'), inst: '', template: '', job: '', jobSent: '', optOutPhone: '+84900000222' };
  const createdInstallations: string[] = [];
  let dueJob = '';

  const http = () => request(app.getHttpServer());

  async function provision(t: typeof A, extra: Record<string, unknown> = {}) {
    const ev = signedEvent({ action: 'UPSERT_INSTALLATION', tenant: { platformTenantId: t.tenantId, name: `Tenant ${t === A ? 'A' : 'B'}` }, entitlement: { productCode: 'CUSTOMER_CARE_CRM', status: 'ACTIVE', planCode: 'CRM_BASIC', limits: { dailyQuotaMax: 50 } }, installation: { installationId: randomUUID(), clientId: t.clientId, clientSecret: t.secret, callbackBaseUrl: `${ORIGIN}/api/v1/crm` }, ...extra });
    return http().post('/api/v1/crm/platform/events').set(ev.headers).send(ev.raw);
  }

  async function login(t: typeof A, grant: Partial<Grant> = {}) {
    const state = randomBytes(32).toString('base64url');
    const code = platform.grant({ tenantId: t.tenantId, userId: t.userId, clientId: t.clientId, ...grant });
    const res = await http().get(`/api/v1/crm/auth/platform/callback?code=${code}&installation=${t.clientId}&state=${state}`).set('Cookie', `vc_crm_sso_state=${state}`);
    const cookie = (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('vc_crm_session='));
    if (!cookie) return { res, cookie: '', csrf: '' };
    const me = await http().get('/api/v1/crm/auth/me').set('Cookie', cookie.split(';')[0]);
    return { res, cookie: cookie.split(';')[0], csrf: me.body.csrfToken as string, me: me.body };
  }

  beforeAll(async () => {
    await platform.start();
    platform.credentials.set(A.clientId, { secret: A.secret, tenantId: A.tenantId });
    platform.credentials.set(B.clientId, { secret: B.secret, tenantId: B.tenantId });
    Object.assign(process.env, {
      PHONE_HASH_PEPPER: randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), WORKER_ENABLED: 'false',
      CRM_SESSION_SECRET: randomBytes(32).toString('hex'), ADMIN_SESSION_SECRET: randomBytes(32).toString('hex'), CRM_PUBLIC_ORIGIN: ORIGIN,
      PLATFORM_API_BASE_URL: `${platform.base}/api`, PLATFORM_ALLOW_HTTP_LOCAL: 'true', PLATFORM_AUTH_ISSUER: ISSUER, PLATFORM_WEB_ORIGIN: 'http://platform.test',
      CRM_PLATFORM_EVENTS_SECRET: EVENTS_SECRET, CRM_ENTITLEMENT_RECHECK_SECONDS: '15',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ rawBody: true }); app.setGlobalPrefix('api/v1'); await app.init();
    crypto = new CryptoService();
    expect((await provision(A)).status).toBe(200);
    expect((await provision(B)).status).toBe(200);
    for (const t of [A, B]) {
      const inst = await prisma.installation.create({ data: { tenantId: t.tenantId, sourceProduct: 'PETCLINIC_OPERATING', status: 'ACTIVE', scopes: ['care:job:create'], dailyQuota: 20 } });
      t.inst = inst.id; createdInstallations.push(inst.id);
      t.template = (await prisma.messageTemplate.create({ data: { installationId: inst.id, code: 'QA_TEMPLATE', body: 'Chào {{ownerName}}', allowedVariables: ['ownerName'] } })).id;
      const mk = (status: 'QUEUED' | 'SENT', i: number, phone: string, failureReason?: string) => prisma.careJob.create({ data: {
        installationId: inst.id, idempotencyKey: `qa-${i}-${randomUUID()}`, requestHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), externalReferenceId: `appointment:QA-${i}`, sourceProduct: 'PETCLINIC_OPERATING',
        eventType: 'APPOINTMENT_REMINDER', recipientNameEnc: crypto.encrypt(`Khách ${t === A ? 'A' : 'B'} ${i}`), phoneEnc: crypto.encrypt(phone), phoneHash: crypto.phoneHash(phone), templateCode: 'QA_TEMPLATE',
        templateVariables: {}, scheduledAt: new Date(Date.now() + 3600_000), consentStatus: 'GRANTED', status, sentAt: status === 'SENT' ? new Date() : null, failureReason: failureReason ?? null } });
      t.job = (await mk('QUEUED', 1, '+84900000001', 'Lỗi gửi tới 0900000001')).id;
      t.jobSent = (await mk('SENT', 2, t.optOutPhone)).id;
      await prisma.optOut.create({ data: { installationId: inst.id, phoneHash: crypto.phoneHash(t.optOutPhone), source: 'QA', reason: 'Dữ liệu giả lập' } });
      await prisma.auditLog.create({ data: { installationId: inst.id, tenantId: t.tenantId, actorType: 'PLATFORM_ADMIN', actorId: 'qa', action: 'PETCLINIC_CONNECTION_CONFIGURED', result: 'SUCCESS', metadata: { apiToken: 'TOKEN_MUST_NOT_LEAK', note: 'gọi 0900000001' } } });
    }
  });

  afterAll(async () => {
    await prisma.careJob.deleteMany({ where: { installationId: { in: createdInstallations } } });
    await prisma.installation.deleteMany({ where: { id: { in: createdInstallations } } });
    await prisma.crmTenant.deleteMany({ where: { platformTenantId: { in: [A.tenantId, B.tenantId] } } });
    await prisma.crmSsoTokenReplay.deleteMany({ where: { platformTenantId: { in: [A.tenantId, B.tenantId] } } });
    await prisma.platformEvent.deleteMany({ where: { platformTenantId: { in: [A.tenantId, B.tenantId] } } });
    await app.close(); await platform.stop(); await prisma.$disconnect();
  });

  // ---------------- A. Authentication / SSO ----------------
  describe('A. SSO', () => {
    it('valid code creates an HttpOnly session scoped to the token tenant', async () => {
      const s = await login(A);
      expect(s.res.status).toBe(302); expect(s.res.headers.location).toBe('/#/tong-quan');
      const set = (s.res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('vc_crm_session='))!;
      expect(set).toMatch(/HttpOnly/i); expect(set).toMatch(/SameSite=Lax/i);
      expect(s.me.tenant.id).toBe(A.tenantId); expect(s.me.roles).toEqual(['CRM_OWNER']);
      expect(JSON.stringify(s.me)).not.toMatch(/secret|TOKEN_MUST_NOT_LEAK/i);
    });
    it('expired code is rejected', async () => {
      const s = await login(A, { expiresAt: Date.now() - 1000 });
      expect(s.res.headers.location).toBe('/#loi=CODE_INVALID'); expect(s.cookie).toBe('');
    });
    it('used code cannot be exchanged twice', async () => {
      const state = randomBytes(32).toString('base64url');
      const code = platform.grant({ tenantId: A.tenantId, userId: A.userId, clientId: A.clientId });
      const first = await http().get(`/api/v1/crm/auth/platform/callback?code=${code}&installation=${A.clientId}&state=${state}`).set('Cookie', `vc_crm_sso_state=${state}`);
      const second = await http().get(`/api/v1/crm/auth/platform/callback?code=${code}&installation=${A.clientId}&state=${state}`).set('Cookie', `vc_crm_sso_state=${state}`);
      expect(first.headers.location).toBe('/#/tong-quan'); expect(second.headers.location).toBe('/#loi=CODE_INVALID');
    });
    it('state mismatch (login CSRF) is rejected before any exchange', async () => {
      const before = platform.calls.exchange;
      const code = platform.grant({ tenantId: A.tenantId, userId: A.userId, clientId: A.clientId });
      const res = await http().get(`/api/v1/crm/auth/platform/callback?code=${code}&installation=${A.clientId}&state=${randomBytes(32).toString('base64url')}`).set('Cookie', `vc_crm_sso_state=${randomBytes(32).toString('base64url')}`);
      expect(res.headers.location).toBe('/#loi=STATE_INVALID'); expect(platform.calls.exchange).toBe(before);
    });
    it('redirect URI mismatch is rejected', async () => {
      await prisma.crmTenant.update({ where: { platformTenantId: A.tenantId }, data: { callbackBaseUrl: 'https://evil.test/api/v1/crm' } });
      const s = await login(A);
      await prisma.crmTenant.update({ where: { platformTenantId: A.tenantId }, data: { callbackBaseUrl: `${ORIGIN}/api/v1/crm` } });
      expect(s.res.headers.location).toBe('/#loi=REDIRECT_MISMATCH');
    });
    it('wrong product code (token for another product) is rejected', async () => {
      const s = await login(A, { productCode: 'PETCLINIC_ESSENTIAL' });
      expect(s.res.headers.location).toBe('/#loi=ACCESS_DENIED'); expect(s.cookie).toBe('');
    });
    it('code presented through another tenant installation is rejected', async () => {
      const state = randomBytes(32).toString('base64url');
      const code = platform.grant({ tenantId: A.tenantId, userId: A.userId, clientId: A.clientId });
      const res = await http().get(`/api/v1/crm/auth/platform/callback?code=${code}&installation=${B.clientId}&state=${state}`).set('Cookie', `vc_crm_sso_state=${state}`);
      expect(res.headers.location).toBe('/#loi=ACCESS_DENIED');
    });
    it('suspended tenant and user without UserProductAccess are rejected by Platform', async () => {
      expect((await login(A, { deny: 'TENANT_SUSPENDED' })).res.headers.location).toBe('/#loi=ACCESS_DENIED');
      expect((await login(A, { deny: 'NO_ACCESS' })).res.headers.location).toBe('/#loi=ACCESS_DENIED');
    });
    it('expired entitlement in the token or in the local cache is rejected', async () => {
      expect((await login(A, { entitlementStatus: 'EXPIRED' })).res.headers.location).toBe('/#loi=ENTITLEMENT_INACTIVE');
      await prisma.crmTenant.update({ where: { platformTenantId: A.tenantId }, data: { entitlementExpiresAt: new Date(Date.now() - 1000) } });
      const s = await login(A);
      await prisma.crmTenant.update({ where: { platformTenantId: A.tenantId }, data: { entitlementExpiresAt: null } });
      expect(s.res.headers.location).toBe('/#loi=ENTITLEMENT_INACTIVE');
    });
    it('token replay (same jti) is rejected', async () => {
      const jti = randomUUID();
      expect((await login(A, { jti })).res.headers.location).toBe('/#/tong-quan');
      expect((await login(A, { jti })).res.headers.location).toBe('/#loi=CODE_INVALID');
    });
    it('unknown installation clientId is rejected', async () => {
      const state = randomBytes(32).toString('base64url');
      const res = await http().get(`/api/v1/crm/auth/platform/callback?code=${randomBytes(24).toString('base64url')}&installation=crm_unknown&state=${state}`).set('Cookie', `vc_crm_sso_state=${state}`);
      expect(res.headers.location).toBe('/#loi=ACCESS_DENIED');
    });
    it('logout revokes the session server-side; a revoked session is refused', async () => {
      const s = await login(A);
      expect((await http().post('/api/v1/crm/auth/logout').set('Cookie', s.cookie).set('x-csrf-token', s.csrf)).status).toBe(200);
      const me = await http().get('/api/v1/crm/auth/me').set('Cookie', s.cookie);
      expect(me.status).toBe(401);
    });
    it('mutations require the session CSRF token and a same-origin Origin', async () => {
      const s = await login(A);
      const noCsrf = await http().patch(`/api/v1/crm/templates/${A.template}`).set('Cookie', s.cookie).send({ active: false });
      const wrong = await http().patch(`/api/v1/crm/templates/${A.template}`).set('Cookie', s.cookie).set('x-csrf-token', 'x'.repeat(43)).send({ active: false });
      const otherSession = await login(A);
      const foreignCsrf = await http().patch(`/api/v1/crm/templates/${A.template}`).set('Cookie', s.cookie).set('x-csrf-token', otherSession.csrf).send({ active: false });
      const crossOrigin = await http().patch(`/api/v1/crm/templates/${A.template}`).set('Cookie', s.cookie).set('x-csrf-token', s.csrf).set('Origin', 'https://evil.test').send({ active: false });
      expect([noCsrf.status, wrong.status, foreignCsrf.status, crossOrigin.status]).toEqual([403, 403, 403, 403]);
      expect(noCsrf.body.code).toBe('CSRF_INVALID');
    });
    it('no session → 401; admin console endpoints do not accept CRM sessions', async () => {
      expect((await http().get('/api/v1/crm/overview')).status).toBe(401);
      const s = await login(A);
      expect((await http().get('/api/v1/admin/overview').set('Cookie', s.cookie)).status).toBe(401);
      expect((await http().post('/api/v1/admin/kill-switch').set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send({ enabled: true })).status).toBe(401);
    });
  });

  // ---------------- B. Tenant isolation + IDOR ----------------
  describe('B. Tenant isolation / IDOR', () => {
    let a: Awaited<ReturnType<typeof login>>; let b: Awaited<ReturnType<typeof login>>;
    beforeAll(async () => { a = await login(A); b = await login(B); });
    const get = (s: typeof a, path: string) => http().get(`/api/v1/crm${path}`).set('Cookie', s.cookie);
    const write = (s: typeof a, method: 'post' | 'patch' | 'delete', path: string, body: unknown = {}) => http()[method](`/api/v1/crm${path}`).set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send(body as object);

    it('overview/installations/templates/jobs/zalo/audit only contain tenant A data', async () => {
      const ov = await get(a, '/overview'); expect(ov.status).toBe(200); expect(ov.body.counts.connections).toBe(1); expect(ov.body.counts.queued).toBe(1); expect(ov.body.counts.optedOut).toBe(1);
      const inst = await get(a, '/installations'); expect(inst.body.map((i: any) => i.id)).toEqual([A.inst]);
      const tpl = await get(a, '/templates'); expect(tpl.body.map((t: any) => t.id)).toEqual([A.template]);
      const jobs = await get(a, '/jobs?pageSize=100'); expect(jobs.body.items.map((j: any) => j.id).sort()).toEqual([A.job, A.jobSent].sort()); expect(jobs.body.total).toBe(2);
      expect((await get(a, '/zalo-accounts')).body.accounts).toEqual([]);
      const audit = await get(a, '/audit?pageSize=100'); expect(audit.body.items.every((x: any) => x.installationId === null || x.installationId === A.inst)).toBe(true);
      expect(JSON.stringify(audit.body)).not.toContain(B.inst);
    });
    it('filtering by a foreign installationId returns nothing (no cross-tenant query)', async () => {
      expect((await get(a, `/jobs?installationId=${B.inst}`)).body.total).toBe(0);
      expect((await get(a, `/audit?installationId=${B.inst}`)).body.total).toBe(0);
    });
    it('reading B resources by ID returns the same 404 as a random ID (no existence oracle)', async () => {
      const random = randomUUID();
      for (const path of [`/installations/${B.inst}`, `/jobs/${B.job}`]) {
        const foreign = await get(a, path); const missing = await get(a, path.replace(/[0-9a-f-]{36}$/, random));
        expect(foreign.status).toBe(404); expect(foreign.body).toEqual(missing.body);
      }
    });
    it('customers: A cannot read B customer; list and stats only count A', async () => {
      const bList = await get(b, '/customers'); const bId = bList.body.items[0].id;
      const aList = await get(a, '/customers'); expect(aList.body.stats.total).toBe(2);
      expect(aList.body.items.map((c: any) => c.id)).not.toContain(bId);
      expect(JSON.stringify(aList.body)).not.toMatch(/Khách B/);
      expect((await get(a, `/customers/${bId}`)).status).toBe(404);
      expect(aList.body.items.every((c: any) => /^\d{4}\*\*\*\d{3}$/.test(c.maskedPhone))).toBe(true);
    });
    it('A cannot modify B template, cancel B job (single or bulk), remove B opt-out, or change B settings', async () => {
      expect((await write(a, 'patch', `/templates/${B.template}`, { active: false })).status).toBe(404);
      expect((await write(a, 'post', '/templates', { installationId: B.inst, code: 'HACK', body: 'x', allowedVariables: [] })).status).toBe(404);
      expect((await write(a, 'post', `/jobs/${B.job}/cancel`)).status).toBe(404);
      const bulk = await write(a, 'post', '/jobs/cancel', { ids: [B.job, A.jobSent] });
      expect(bulk.body.results.find((r: any) => r.id === B.job)).toEqual({ id: B.job, cancelled: false, reason: 'NOT_FOUND' });
      expect((await prisma.careJob.findUnique({ where: { id: B.job } }))!.status).toBe('QUEUED');
      const bOpt = (await get(b, '/opt-outs')).body.items[0].id;
      expect((await write(a, 'delete', `/opt-outs/${bOpt}`, { reason: 'Thử xóa chéo tenant' })).status).toBe(404);
      expect(await prisma.optOut.count({ where: { installationId: B.inst } })).toBe(1);
      expect((await write(a, 'patch', '/settings', { installations: [{ id: B.inst, dailyQuota: 1 }] })).status).toBe(404);
      expect((await prisma.installation.findUnique({ where: { id: B.inst } }))!.dailyQuota).toBe(20);
      expect((await write(a, 'post', `/installations/${B.inst}/petclinic/preview`)).status).toBe(404);
    });
    it('A can cancel its own queued job and the audit is attributed to the CRM user', async () => {
      const r = await write(a, 'post', `/jobs/${A.job}/cancel`); expect(r.body).toEqual({ id: A.job, cancelled: true });
      const log = await prisma.auditLog.findFirst({ where: { targetId: A.job, action: 'CARE_JOB_CANCELLED' } });
      expect(log).toMatchObject({ actorType: 'CRM_USER', actorId: A.userId, tenantId: A.tenantId });
    });
    it('server-side redaction: no token/secret in audit, phones masked in job errors', async () => {
      const audit = await get(a, '/audit?pageSize=100'); const text = JSON.stringify(audit.body);
      expect(text).not.toContain('TOKEN_MUST_NOT_LEAK'); expect(text).not.toContain('0900000001'); expect(text).toContain('[đã ẩn]');
      const job = await get(a, `/jobs/${A.job}`); expect(job.body.failureReason).toContain('0900***001');
      const inst = await get(a, `/installations/${A.inst}`); expect(JSON.stringify(inst.body)).not.toMatch(/apiTokenEnc|credentialEnc|callbackSecret/);
    });
    it('opt-out removal requires a reason and is audited', async () => {
      const id = (await get(a, '/opt-outs')).body.items[0].id;
      expect((await write(a, 'delete', `/opt-outs/${id}`, { reason: '' })).status).toBe(400);
      expect((await write(a, 'delete', `/opt-outs/${id}`, { reason: 'Khách yêu cầu nhận lại tin' })).status).toBe(200);
      expect(await prisma.auditLog.count({ where: { tenantId: A.tenantId, action: 'OPT_OUT_REMOVED', actorId: A.userId } })).toBe(1);
    });
  });

  // ---------------- C. Permissions ----------------
  describe('C. Permissions', () => {
    it('viewer can read but not modify', async () => {
      const v = await login(A, { crmRoles: ['CRM_VIEWER'] });
      expect(v.me.roles).toEqual(['CRM_VIEWER']);
      expect((await http().get('/api/v1/crm/jobs').set('Cookie', v.cookie)).status).toBe(200);
      expect((await http().patch(`/api/v1/crm/templates/${A.template}`).set('Cookie', v.cookie).set('x-csrf-token', v.csrf).send({ active: false })).status).toBe(403);
      expect((await http().post(`/api/v1/crm/jobs/${A.jobSent}/cancel`).set('Cookie', v.cookie).set('x-csrf-token', v.csrf)).status).toBe(403);
      expect((await http().get('/api/v1/crm/audit').set('Cookie', v.cookie)).status).toBe(403);
    });
    it('staff (Platform STAFF) may cancel jobs but not manage templates, settings or audit', async () => {
      const s = await login(A, { roles: ['STAFF'] });
      expect(s.me.roles).toEqual(['CRM_STAFF']);
      expect((await http().post(`/api/v1/crm/jobs/${A.jobSent}/cancel`).set('Cookie', s.cookie).set('x-csrf-token', s.csrf)).status).toBe(200);
      expect((await http().patch(`/api/v1/crm/templates/${A.template}`).set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send({ active: false })).status).toBe(403);
      expect((await http().patch('/api/v1/crm/settings').set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send({ autoSendPaused: true })).status).toBe(403);
      expect((await http().get('/api/v1/crm/audit').set('Cookie', s.cookie)).status).toBe(403);
    });
    it('CRM_ADMIN manages settings but cannot replace source credentials; owner can (own tenant only)', async () => {
      const adm = await login(A, { crmRoles: ['CRM_ADMIN'] });
      expect((await http().post(`/api/v1/crm/installations/${A.inst}/petclinic`).set('Cookie', adm.cookie).set('x-csrf-token', adm.csrf).send({})).status).toBe(403);
      const own = await login(A);
      const r = await http().post(`/api/v1/crm/installations/${A.inst}/petclinic`).set('Cookie', own.cookie).set('x-csrf-token', own.csrf).send({ apiBaseUrl: 'not-a-url' });
      expect(r.status).toBe(400); // owner is authorised; request fails only on input validation
    });
    it('unknown crmRoles never elevate privileges', async () => {
      const s = await login(A, { crmRoles: ['CRM_OWNER', 'PLATFORM_SUPERADMIN'], roles: [] });
      expect(s.me.roles).toEqual(['CRM_VIEWER']);
    });
  });

  // ---------------- D. Settings, entitlement lifecycle and webhooks ----------------
  describe('D. Settings / entitlement / webhooks', () => {
    it('settings: pause holds sending, quota cannot exceed plan, quiet hours validated', async () => {
      const o = await login(A);
      const patch = (body: unknown) => http().patch('/api/v1/crm/settings').set('Cookie', o.cookie).set('x-csrf-token', o.csrf).send(body as object);
      expect((await patch({ installations: [{ id: A.inst, dailyQuota: 51 }] })).status).toBe(403);
      expect((await patch({ installations: [{ id: A.inst, dailyQuota: 40 }] })).status).toBe(200);
      expect((await patch({ installations: [{ id: A.inst, quietHoursStart: '25:00' }] })).status).toBe(400);
      expect((await patch({ installations: [{ id: A.inst, quietHoursStart: '08:00', quietHoursEnd: '08:00' }] })).status).toBe(400);
      expect((await patch({ autoSendPaused: true })).status).toBe(200);
      expect(await app.get(TenantAccessService).sendingDecision(A.tenantId)).toEqual({ action: 'HOLD', code: 'TENANT_PAUSED' });
      expect((await patch({ autoSendPaused: false })).status).toBe(200);
      expect(await app.get(TenantAccessService).sendingDecision(A.tenantId)).toEqual({ action: 'SEND' });
    });
    it('webhook: bad signature, tampered body and stale timestamp are rejected', async () => {
      const bad = signedEvent({ type: 'subscription.suspended', tenant: { platformTenantId: A.tenantId } }, { secret: 'x'.repeat(40) });
      const tampered = signedEvent({ type: 'subscription.suspended', tenant: { platformTenantId: A.tenantId } }, { tamper: true });
      const stale = signedEvent({ type: 'subscription.suspended', tenant: { platformTenantId: A.tenantId } }, { timestamp: Date.now() - 10 * 60_000 });
      for (const ev of [bad, tampered, stale]) expect((await http().post('/api/v1/crm/platform/events').set(ev.headers).send(ev.raw)).status).toBe(401);
      expect((await prisma.crmTenant.findUnique({ where: { platformTenantId: A.tenantId } }))!.entitlementStatus).toBe('ACTIVE');
    });
    it('suspension revokes sessions, blocks new jobs and holds the queue; redelivery is idempotent', async () => {
      const o = await login(A);
      const ev = signedEvent({ type: 'subscription.suspended', tenant: { platformTenantId: A.tenantId }, occurredAt: new Date().toISOString() });
      const first = await http().post('/api/v1/crm/platform/events').set(ev.headers).send(ev.raw);
      const again = await http().post('/api/v1/crm/platform/events').set(ev.headers).send(ev.raw);
      expect(first.body.result).toBe('APPLIED'); expect(again.body.duplicate).toBe(true);
      expect(await prisma.platformEvent.count({ where: { eventId: ev.eventId } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { metadata: { path: ['eventId'], equals: ev.eventId } } })).toBe(1);
      expect((await http().get('/api/v1/crm/overview').set('Cookie', o.cookie)).status).toBe(401);
      expect((await login(A)).res.headers.location).toBe('/#loi=ENTITLEMENT_INACTIVE');
      expect(await app.get(TenantAccessService).sendingDecision(A.tenantId)).toEqual({ action: 'HOLD', code: 'ENTITLEMENT_SUSPENDED' });
      const jobs = new CareJobsService(prisma as any, crypto, app.get(TenantAccessService));
      await expect(jobs.create({ installationId: A.inst, tenantId: A.tenantId, sourceProduct: 'PETCLINIC_OPERATING', scopes: ['care:job:create'] } as any, { sourceProduct: 'PETCLINIC_OPERATING' })).rejects.toThrow('ENTITLEMENT_SUSPENDED');
      // Real worker path: a due job of a suspended tenant is held, and the channel is never called.
      const send = jest.spyOn(app.get(ChannelRouterService), 'send');
      dueJob = (await prisma.careJob.create({ data: { installationId: A.inst, idempotencyKey: `due-${randomUUID()}`, requestHash: 'f'.repeat(64), externalReferenceId: 'appointment:QA-DUE', sourceProduct: 'PETCLINIC_OPERATING', eventType: 'APPOINTMENT_REMINDER', recipientNameEnc: crypto.encrypt('Khách A due'), phoneEnc: crypto.encrypt('+84900000333'), phoneHash: crypto.phoneHash('+84900000333'), templateCode: 'QA_TEMPLATE', templateVariables: {}, scheduledAt: new Date(Date.now() - 60_000), consentStatus: 'GRANTED' } })).id;
      expect(await app.get(CareWorkerService).processNext('qa-worker')).toBe(true);
      expect(await prisma.careJob.findUnique({ where: { id: dueJob } })).toMatchObject({ status: 'QUEUED', failureCode: 'ENTITLEMENT_SUSPENDED' });
      expect(send).not.toHaveBeenCalled(); send.mockRestore();
    });
    it('an older event delivered late does not roll the entitlement back', async () => {
      const old = signedEvent({ type: 'subscription.activated', tenant: { platformTenantId: A.tenantId }, occurredAt: new Date(Date.now() - 3600_000).toISOString() });
      expect((await http().post('/api/v1/crm/platform/events').set(old.headers).send(old.raw)).body.result).toBe('IGNORED_STALE');
      expect((await prisma.crmTenant.findUnique({ where: { platformTenantId: A.tenantId } }))!.entitlementStatus).toBe('SUSPENDED');
    });
    it('reactivation restores access; expiry cancels queued sending', async () => {
      const act = signedEvent({ type: 'subscription.activated', tenant: { platformTenantId: A.tenantId }, entitlement: { status: 'ACTIVE' }, occurredAt: new Date().toISOString() });
      expect((await http().post('/api/v1/crm/platform/events').set(act.headers).send(act.raw)).body.result).toBe('APPLIED');
      expect((await login(A)).res.headers.location).toBe('/#/tong-quan');
      const exp = signedEvent({ type: 'subscription.expired', tenant: { platformTenantId: A.tenantId }, occurredAt: new Date(Date.now() + 1000).toISOString() });
      await http().post('/api/v1/crm/platform/events').set(exp.headers).send(exp.raw);
      expect(await app.get(TenantAccessService).sendingDecision(A.tenantId)).toEqual({ action: 'CANCEL', code: 'ENTITLEMENT_EXPIRED' });
      await prisma.careJob.update({ where: { id: dueJob }, data: { nextAttemptAt: null } });
      expect(await app.get(CareWorkerService).processNext('qa-worker')).toBe(true);
      expect(await prisma.careJob.findUnique({ where: { id: dueJob } })).toMatchObject({ status: 'CANCELLED', failureCode: 'ENTITLEMENT_EXPIRED' });
      const again = signedEvent({ type: 'subscription.activated', tenant: { platformTenantId: A.tenantId }, entitlement: { status: 'ACTIVE' }, occurredAt: new Date(Date.now() + 2000).toISOString() });
      await http().post('/api/v1/crm/platform/events').set(again.headers).send(again.raw);
    });
    it('user_product_access.revoked ends only that user’s sessions', async () => {
      const a = await login(A); const b = await login(B);
      const ev = signedEvent({ type: 'user_product_access.revoked', tenant: { platformTenantId: A.tenantId }, user: { platformUserId: A.userId } });
      await http().post('/api/v1/crm/platform/events').set(ev.headers).send(ev.raw);
      expect((await http().get('/api/v1/crm/overview').set('Cookie', a.cookie)).status).toBe(401);
      expect((await http().get('/api/v1/crm/overview').set('Cookie', b.cookie)).status).toBe(200);
    });
    it('periodic Platform session-check: DENIED revokes; outage uses grace only after an ACTIVE check', async () => {
      const s = await login(B);
      const session = await prisma.crmSession.findFirstOrThrow({ where: { platformUserId: B.userId, revokedAt: null }, orderBy: { issuedAt: 'desc' } });
      await prisma.crmSession.update({ where: { id: session.id }, data: { lastCheckedAt: new Date(Date.now() - 60_000) } });
      platform.sessionDecision.set(B.userId, 'ACTIVE');
      expect((await http().get('/api/v1/crm/overview').set('Cookie', s.cookie)).status).toBe(200); // ACTIVE → grace recorded
      await prisma.crmSession.update({ where: { id: session.id }, data: { lastCheckedAt: new Date(Date.now() - 60_000) } });
      platform.sessionDecision.set(B.userId, 'DOWN');
      expect((await http().get('/api/v1/crm/overview').set('Cookie', s.cookie)).status).toBe(200); // within grace
      await prisma.crmSession.update({ where: { id: session.id }, data: { lastCheckedAt: new Date(Date.now() - 60_000), checkGraceUntil: new Date(Date.now() - 1000) } });
      expect((await http().get('/api/v1/crm/overview').set('Cookie', s.cookie)).status).toBe(503); // grace over → fail closed
      platform.sessionDecision.set(B.userId, 'DENIED');
      expect((await http().get('/api/v1/crm/overview').set('Cookie', s.cookie)).status).toBe(401);
      expect((await prisma.crmSession.findUnique({ where: { id: session.id } }))!.revokeReason).toBe('ACCESS_REVOKED');
      platform.sessionDecision.delete(B.userId);
    });
    it('installation.revoked from Platform ends every session of the tenant and blocks login', async () => {
      const b = await login(B);
      const ev = signedEvent({ action: 'REVOKE_INSTALLATION', tenant: { platformTenantId: B.tenantId }, installation: { clientId: B.clientId } });
      expect((await http().post('/api/v1/crm/platform/events').set(ev.headers).send(ev.raw)).body.result).toBe('APPLIED');
      expect((await http().get('/api/v1/crm/overview').set('Cookie', b.cookie)).status).toBe(401);
      expect((await login(B)).res.headers.location).toBe('/#loi=ACCESS_DENIED');
      expect((await prisma.crmTenant.findUnique({ where: { platformTenantId: B.tenantId } }))!.platformClientSecretEnc).toBeNull();
    });
  });
});
