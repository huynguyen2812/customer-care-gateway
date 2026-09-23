import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import * as nodeHttp from 'node:http';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { FakePlatform, signedPlatformEvent } from './helpers/fake-platform';

/**
 * Gateway ↔ sender v2 (vòng 2): tự đăng ký account, resume chỉ khi sender xác nhận, health callback có ký.
 * Sender là bản giả test-only có kiểm chữ ký thật; không có tài khoản/QR/tin Zalo thật.
 * Hai tenant (A, B), mỗi tenant 2 account.
 */
const ORIGIN = 'http://crm.test';
const ISSUER = 'vetclinic.vn-platform-test';
const EVENTS_SECRET = randomBytes(32).toString('hex');
const SENDER_KEY = randomBytes(32).toString('base64url');
const OTHER_KEY = randomBytes(32).toString('base64url');
const CLIENT = 'gw-qa-r2';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sign = (key: string, method: string, path: string, ts: string, nonce: string, raw: string) => createHmac('sha256', key).update(`${method}\n${path}\n${ts}\n${nonce}\n${sha(raw)}`).digest('hex');

type Mode = 'ok' | 'down' | 'relogin' | 'unavailable' | 'timeout' | 'garbage' | 'slow';
class FakeSenderV2 {
  server!: nodeHttp.Server; base = '';
  registerMode: Mode = 'ok'; controlMode: Mode = 'ok';
  calls: { path: string; account: string }[] = []; badSignatures = 0;
  registered = new Set<string>(); paused = new Set<string>();
  async start() {
    this.server = nodeHttp.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
        const reply = (status: number, body: unknown, delay = 0) => setTimeout(() => { if (!res.writableEnded) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } }, delay);
        const path = new URL(req.url!, 'http://x').pathname;
        const ok = req.headers['x-gateway-client-id'] === CLIENT && req.headers['x-gateway-signature'] === sign(SENDER_KEY, req.method!, path, String(req.headers['x-gateway-timestamp']), String(req.headers['x-gateway-nonce']), raw);
        if (!ok) { this.badSignatures++; return reply(401, { code: 'UNAUTHORIZED' }); }
        const m = /^\/internal\/v1\/accounts\/([^/]+)\/(register|pause|resume|disconnect)$/.exec(path);
        if (!m || m[1] !== req.headers['x-gateway-account-id']) return reply(401, { code: 'UNAUTHORIZED' });
        const [, id, action] = m; this.calls.push({ path: action, account: id });
        if (action === 'register') {
          if (this.registerMode === 'down') return reply(503, { code: 'SENDER_NOT_CONFIGURED' });
          this.registered.add(id);
          return reply(200, { channelAccountId: id, status: 'PENDING_LOGIN', capabilities: { contractVersion: 2, qrLogin: true, recipientPreflight: true, idempotentSend: true, remoteControl: true } });
        }
        if (action === 'pause') { this.paused.add(id); return reply(200, { ok: true, paused: true }); }
        if (action === 'disconnect') return reply(200, { ok: true });
        const mode = this.controlMode;
        if (mode === 'relogin') return reply(409, { code: 'RELOGIN_REQUIRED' });
        if (mode === 'unavailable') return reply(409, { code: 'ACCOUNT_UNAVAILABLE' });
        if (mode === 'timeout') return reply(200, { ok: true, paused: false }, 1200);
        if (mode === 'garbage') return reply(200, { hello: 'world' });
        this.paused.delete(id);
        return reply(200, { ok: true, paused: false }, mode === 'slow' ? 250 : 0);
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  count(action: string, account?: string) { return this.calls.filter((c) => c.path === action && (!account || c.account === account)).length; }
  stop() { this.server.closeAllConnections(); return new Promise((r) => this.server.close(r)); }
}

describe('Gateway ↔ sender v2: tự đăng ký, resume nhất quán, health callback', () => {
  const prisma = new PrismaClient();
  const platform = new FakePlatform(ISSUER);
  const sender = new FakeSenderV2();
  let app: INestApplication;
  const mk = (n: string) => ({ n, tenantId: randomUUID(), userId: randomUUID(), clientId: `crm_${randomUUID().slice(0, 12)}`, secret: randomBytes(24).toString('base64url'), acc: [] as string[] });
  const A = mk('A'); const B = mk('B');
  type S = { cookie: string; csrf: string };
  let sa: S; let sb: S;
  const http = () => request(app.getHttpServer());
  const write = (s: S, method: 'post' | 'patch', path: string, body: unknown = {}) => http()[method](`/api/v1/crm${path}`).set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send(body as object);
  const acc = (id: string) => prisma.zaloAccount.findUniqueOrThrow({ where: { id } });

  async function provision(t: typeof A) {
    const ev = signedPlatformEvent(EVENTS_SECRET, { action: 'UPSERT_INSTALLATION', tenant: { platformTenantId: t.tenantId, name: `Tenant ${t.n}` }, entitlement: { productCode: 'CUSTOMER_CARE_CRM', status: 'ACTIVE', planCode: 'CRM_BASIC', limits: { dailyQuotaMax: 80 } }, installation: { installationId: randomUUID(), clientId: t.clientId, clientSecret: t.secret, callbackBaseUrl: `${ORIGIN}/api/v1/crm` } });
    expect((await http().post('/api/v1/crm/platform/events').set(ev.headers).send(ev.raw)).status).toBe(200);
  }
  async function login(t: typeof A): Promise<S> {
    const state = randomBytes(32).toString('base64url');
    const code = platform.grant({ tenantId: t.tenantId, userId: t.userId, clientId: t.clientId });
    const res = await http().get(`/api/v1/crm/auth/platform/callback?code=${code}&installation=${t.clientId}&state=${state}`).set('Cookie', `vc_crm_sso_state=${state}`);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('vc_crm_session='))!.split(';')[0];
    return { cookie, csrf: (await http().get('/api/v1/crm/auth/me').set('Cookie', cookie)).body.csrfToken };
  }
  /** Callback health như sender v2 gửi. */
  function health(accountId: string, body: Record<string, unknown>, o: { key?: string; client?: string; ts?: number; nonce?: string; eventId?: string; headerAccount?: string; tamper?: boolean } = {}) {
    const raw = JSON.stringify(body); const path = `/api/v1/channel/accounts/${accountId}/health`;
    const ts = String(o.ts ?? Date.now()); const nonce = o.nonce ?? randomUUID(); const eventId = o.eventId ?? randomUUID();
    return http().post(path).set({ 'content-type': 'application/json', 'x-sender-client-id': o.client ?? CLIENT, 'x-sender-timestamp': ts, 'x-sender-nonce': nonce, 'x-sender-event-id': eventId, 'x-sender-account-id': o.headerAccount ?? accountId,
      'x-sender-signature': sign(o.key ?? SENDER_KEY, 'POST', path, ts, nonce, raw) }).send(o.tamper ? raw.replace('CONNECTED', 'RESTRICTED') : raw);
  }

  beforeAll(async () => {
    await platform.start(); await sender.start();
    for (const t of [A, B]) platform.credentials.set(t.clientId, { secret: t.secret, tenantId: t.tenantId });
    Object.assign(process.env, {
      PHONE_HASH_PEPPER: randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), WORKER_ENABLED: 'false', MOCK_ADAPTER_ENABLED: 'false', SENDER_TIMEOUT_MS: '400',
      CRM_SESSION_SECRET: randomBytes(32).toString('hex'), ADMIN_SESSION_SECRET: randomBytes(32).toString('hex'), CRM_PUBLIC_ORIGIN: ORIGIN,
      PLATFORM_API_BASE_URL: `${platform.base}/api`, PLATFORM_ALLOW_HTTP_LOCAL: 'true', PLATFORM_AUTH_ISSUER: ISSUER, PLATFORM_WEB_ORIGIN: 'http://platform.test',
      CRM_PLATFORM_EVENTS_SECRET: EVENTS_SECRET, CRM_ENTITLEMENT_RECHECK_SECONDS: '15',
      SENDER_V2_BASE_URL: sender.base, SENDER_V2_CLIENT_ID: CLIENT, SENDER_V2_SIGNING_KEY: SENDER_KEY,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ rawBody: true }); app.setGlobalPrefix('api/v1'); await app.init();
    await provision(A); await provision(B); sa = await login(A); sb = await login(B);
  });

  afterAll(async () => {
    const tenants = [A.tenantId, B.tenantId];
    await prisma.zaloAccount.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.crmTenant.deleteMany({ where: { platformTenantId: { in: tenants } } });
    await prisma.crmSsoTokenReplay.deleteMany({ where: { platformTenantId: { in: tenants } } });
    await prisma.platformEvent.deleteMany({ where: { platformTenantId: { in: tenants } } });
    await prisma.controlNonce.deleteMany({ where: { clientId: { startsWith: 'sender:' } } });
    await app.close(); await platform.stop(); await sender.stop(); await prisma.$disconnect();
  });

  // ─────────────── 1. Tự đăng ký ───────────────
  describe('1. tự đăng ký account với sender', () => {
    it('mỗi tenant tạo 2 account → Gateway tự đăng ký qua API có ký, lưu cấu hình gửi + capability v2', async () => {
      for (const [s, t] of [[sa, A], [sb, B]] as const) for (const name of ['Zalo 1', 'Zalo 2']) {
        const r = await write(s, 'post', '/zalo-accounts', { displayName: `${t.n} ${name}`, dailyQuota: 10 });
        expect(r.status).toBe(200); t.acc.push(r.body.id);
        expect(r.body.capabilities).toEqual({ qrLogin: true, recipientPreflight: true, idempotentSend: true, remoteControl: true });
        expect(r.body.status).toBe('PENDING_LOGIN'); expect(r.body.usable).toBe(false);
      }
      expect([...sender.registered].sort()).toEqual([...A.acc, ...B.acc].sort());
      expect(sender.badSignatures).toBe(0);
      const row = await acc(A.acc[0]);
      expect(row.senderClientId).toBe(CLIENT); expect(row.credentialEnc).not.toContain(SENDER_KEY);
      const listed = JSON.stringify((await http().get('/api/v1/crm/zalo-accounts').set('Cookie', sa.cookie)).body);
      expect(listed).not.toMatch(/senderBaseUrl|credentialEnc|senderClientId|gw-qa-r2/);
      expect(listed).not.toContain(SENDER_KEY);
    });
    it('đăng ký lại là idempotent; tenant A không đăng ký lại được account của B (404 như id lạ)', async () => {
      const again = await write(sa, 'post', `/zalo-accounts/${A.acc[0]}/sender/register`);
      expect(again.status).toBe(200); expect(again.body.registered).toBe(true);
      const foreign = await write(sa, 'post', `/zalo-accounts/${B.acc[0]}/sender/register`);
      const random = await write(sa, 'post', `/zalo-accounts/${randomUUID()}/sender/register`);
      expect(foreign.status).toBe(404); expect(foreign.body).toEqual(random.body);
      expect(sender.count('register', B.acc[0])).toBe(1);
    });
    it('sender chưa sẵn sàng → account vẫn tạo nhưng KHÔNG dùng được, không cho đăng nhập QR; thử lại khi sender sẵn sàng', async () => {
      sender.registerMode = 'down';
      const r = await write(sa, 'post', '/zalo-accounts', { displayName: 'A Zalo chờ', dailyQuota: 5 });
      expect(r.status).toBe(200); expect(r.body.usable).toBe(false); expect(r.body.unavailableReason).toBe('PENDING_LOGIN'); expect((await acc(r.body.id)).senderBaseUrl).toBeNull();
      expect(r.body.lastError).toMatch(/SENDER_REGISTRATION_PENDING/);
      const qr = await write(sa, 'post', `/zalo-accounts/${r.body.id}/login/start`);
      expect(qr.status).toBe(503); expect(qr.body.code).toBe('SENDER_REGISTRATION_PENDING');
      expect((await write(sa, 'post', `/zalo-accounts/${r.body.id}/sender/register`)).status).toBe(503);
      sender.registerMode = 'ok';
      expect((await write(sa, 'post', `/zalo-accounts/${r.body.id}/sender/register`)).status).toBe(200);
      const row = await acc(r.body.id); expect(row.senderBaseUrl).toBe(sender.base); expect(row.lastError).toBeNull();
      expect(row.status).toBe('PENDING_LOGIN'); // đăng ký ≠ kết nối
      await prisma.zaloAccount.delete({ where: { id: r.body.id } });
    });
  });

  // ─────────────── 2. Resume nhất quán ───────────────
  describe('2. resume chỉ khi sender xác nhận', () => {
    const id = () => A.acc[1];
    beforeAll(async () => { await prisma.zaloAccount.update({ where: { id: A.acc[1] }, data: { status: 'CONNECTED' } }); });
    beforeEach(async () => { sender.controlMode = 'ok'; await write(sa, 'post', `/zalo-accounts/${id()}/pause`); await prisma.zaloAccount.update({ where: { id: id() }, data: { status: 'CONNECTED' } }); });

    it('pause: Gateway khoá trước (kể cả khi sender lỗi) rồi báo sender', async () => {
      const row = await acc(id()); expect(row.paused).toBe(true); expect(sender.paused.has(id())).toBe(true);
    });
    it('mất phiên: sender 409 RELOGIN_REQUIRED → giữ pause, trạng thái RELOGIN_REQUIRED, báo đăng nhập lại', async () => {
      sender.controlMode = 'relogin';
      const r = await write(sa, 'post', `/zalo-accounts/${id()}/resume`);
      expect(r.status).toBe(409); expect(r.body.code).toBe('RELOGIN_REQUIRED'); expect(r.body.message).toMatch(/đăng nhập lại/);
      const row = await acc(id()); expect(row.paused).toBe(true); expect(row.status).toBe('RELOGIN_REQUIRED');
      const view = (await http().get(`/api/v1/crm/zalo-accounts/${id()}`).set('Cookie', sa.cookie)).body;
      expect(view.usable).toBe(false); expect(view.unavailableReason).toBe('PAUSED');
    });
    it('sender 409 ACCOUNT_UNAVAILABLE → giữ pause', async () => {
      sender.controlMode = 'unavailable';
      const r = await write(sa, 'post', `/zalo-accounts/${id()}/resume`);
      expect(r.status).toBe(409); expect(r.body.code).toBe('ACCOUNT_UNAVAILABLE'); expect((await acc(id())).paused).toBe(true);
    });
    it('timeout → 503, giữ pause', async () => {
      sender.controlMode = 'timeout';
      const r = await write(sa, 'post', `/zalo-accounts/${id()}/resume`);
      expect(r.status).toBe(503); expect(r.body.code).toBe('SENDER_UNAVAILABLE'); expect((await acc(id())).paused).toBe(true);
    });
    it('phản hồi không xác định (200 sai dạng) → 503, giữ pause', async () => {
      sender.controlMode = 'garbage';
      const r = await write(sa, 'post', `/zalo-accounts/${id()}/resume`);
      expect(r.status).toBe(503); expect((await acc(id())).paused).toBe(true);
    });
    it('trong lúc chờ sender, Gateway vẫn giữ pause (không có cửa sổ báo hoạt động sai)', async () => {
      sender.controlMode = 'slow';
      const pending = write(sa, 'post', `/zalo-accounts/${id()}/resume`);
      await new Promise((r) => setTimeout(r, 100));
      expect((await acc(id())).paused).toBe(true);
      expect((await pending).status).toBe(200);
      const row = await acc(id()); expect(row.paused).toBe(false); expect(row.status).toBe('CONNECTED');
    });
    it('hai yêu cầu resume đồng thời → sender chỉ được hỏi 1 lần, cả hai trả kết quả nhất quán', async () => {
      sender.controlMode = 'slow'; const before = sender.count('resume', id());
      const [r1, r2] = await Promise.all([write(sa, 'post', `/zalo-accounts/${id()}/resume`), write(sa, 'post', `/zalo-accounts/${id()}/resume`)]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      expect(r1.body.paused).toBe(false); expect(r2.body.paused).toBe(false);
      expect(sender.count('resume', id()) - before).toBe(1);
      expect((await acc(id())).paused).toBe(false);
    });
    it('tenant A không pause/resume/disconnect account của B', async () => {
      for (const action of ['pause', 'resume', 'disconnect']) expect((await write(sa, 'post', `/zalo-accounts/${B.acc[0]}/${action}`)).status).toBe(404);
      expect(sender.calls.filter((c) => c.account === B.acc[0] && c.path !== 'register')).toHaveLength(0);
    });
  });

  // ─────────────── 3. Health callback ───────────────
  describe('3. health callback có ký', () => {
    const t0 = Date.now();
    const at = (s: number) => new Date(t0 + s * 1000).toISOString();
    it('trạng thái hợp lệ được áp dụng theo đúng account; audit không lộ bí mật/số điện thoại', async () => {
      for (const [i, st] of (['CONNECTED', 'PAUSED', 'RESTRICTED', 'RELOGIN_REQUIRED', 'DISCONNECTED', 'CONNECTED'] as const).entries()) {
        const r = await health(B.acc[1], { status: st, reason: 'QA_EVENT', at: at(i + 1) });
        expect(r.status).toBe(200); expect(r.body.result).toBe('APPLIED');
        expect((await acc(B.acc[1])).status).toBe(st);
      }
      expect((await acc(B.acc[0])).status).toBe('PENDING_LOGIN'); // account khác không đổi
      const audits = await prisma.auditLog.findMany({ where: { tenantId: B.tenantId, action: 'ZALO_ACCOUNT_SENDER_HEALTH' } });
      expect(audits.length).toBeGreaterThanOrEqual(6); expect(audits.every((x) => x.targetId === B.acc[1])).toBe(true);
      expect(JSON.stringify(audits)).not.toMatch(/cookie|session|signature|09\d{8}|\+84\d{9}/i);
      expect(JSON.stringify(audits)).not.toContain(SENDER_KEY);
    });
    it('eventId lặp → idempotent (không áp dụng lại); nonce lặp → 401 replay', async () => {
      const eventId = randomUUID();
      const first = await health(B.acc[1], { status: 'RESTRICTED', reason: null, at: at(20) }, { eventId });
      expect(first.body.result).toBe('APPLIED');
      await prisma.zaloAccount.update({ where: { id: B.acc[1] }, data: { status: 'CONNECTED' } });
      const dup = await health(B.acc[1], { status: 'RESTRICTED', reason: null, at: at(20) }, { eventId });
      expect(dup.status).toBe(200); expect(dup.body.duplicate).toBe(true);
      expect((await acc(B.acc[1])).status).toBe('CONNECTED');
      expect(await prisma.senderHealthEvent.count({ where: { eventId } })).toBe(1);
      const nonce = randomUUID();
      expect((await health(B.acc[1], { status: 'CONNECTED', at: at(21) }, { nonce })).status).toBe(200);
      expect((await health(B.acc[1], { status: 'CONNECTED', at: at(22) }, { nonce })).status).toBe(401);
    });
    it('sự kiện đến trễ (cũ hơn) không ghi đè trạng thái mới', async () => {
      expect((await health(A.acc[0], { status: 'RELOGIN_REQUIRED', at: at(40) })).body.result).toBe('APPLIED');
      const late = await health(A.acc[0], { status: 'CONNECTED', at: at(35) });
      expect(late.body.result).toBe('STALE'); expect((await acc(A.acc[0])).status).toBe('RELOGIN_REQUIRED');
    });
    it('sai chữ ký / body bị sửa / timestamp cũ / header account khác path / id lạ → cùng 401', async () => {
      const bodies: request.Response[] = [];
      bodies.push(await health(A.acc[0], { status: 'CONNECTED', at: at(50) }, { key: OTHER_KEY }));
      bodies.push(await health(A.acc[0], { status: 'CONNECTED', at: at(50) }, { tamper: true }));
      bodies.push(await health(A.acc[0], { status: 'CONNECTED', at: at(50) }, { ts: Date.now() - 301_000 }));
      bodies.push(await health(A.acc[0], { status: 'CONNECTED', at: at(50) }, { headerAccount: A.acc[1] }));
      const rnd = randomUUID(); bodies.push(await health(rnd, { status: 'CONNECTED', at: at(50) }));
      expect(bodies.map((b) => b.status)).toEqual([401, 401, 401, 401, 401]);
      expect(new Set(bodies.map((b) => JSON.stringify(b.body))).size).toBe(1);
      expect((await acc(A.acc[0])).status).toBe('RELOGIN_REQUIRED');
    });
    it('account của tenant khác đăng ký bởi sender client khác → callback của client này bị từ chối', async () => {
      const crypto = app.get(require('../src/common/crypto.service').CryptoService);
      await prisma.zaloAccount.update({ where: { id: B.acc[0] }, data: { senderClientId: 'gw-qa-other', credentialEnc: crypto.encrypt(OTHER_KEY) } });
      const asClientA = await health(B.acc[0], { status: 'CONNECTED', at: at(60) });
      const claimOther = await health(B.acc[0], { status: 'CONNECTED', at: at(60) }, { client: 'gw-qa-other' });
      expect(asClientA.status).toBe(401); expect(claimOther.status).toBe(401);
      expect((await acc(B.acc[0])).status).toBe('PENDING_LOGIN');
      expect((await health(B.acc[0], { status: 'CONNECTED', at: at(61) }, { client: 'gw-qa-other', key: OTHER_KEY })).status).toBe(200);
    });
    it('trạng thái không hợp lệ → 400', async () => {
      expect((await health(A.acc[1], { status: 'HACKED', at: at(70) })).status).toBe(400);
      expect((await health(A.acc[1], { status: 'CONNECTED', at: 'not-a-date' })).status).toBe(400);
    });
    it('hai callback đồng thời cùng eventId → áp dụng đúng một lần', async () => {
      const eventId = randomUUID();
      const rs = await Promise.all([1, 2, 3].map(() => health(A.acc[1], { status: 'RESTRICTED', at: at(80) }, { eventId })));
      expect(rs.every((r) => r.status === 200)).toBe(true);
      expect(rs.filter((r) => r.body.duplicate !== true)).toHaveLength(1);
      expect(await prisma.senderHealthEvent.count({ where: { eventId } })).toBe(1);
    });
  });

  // ─────────────── 4. Health callback đồng thời — PostgreSQL thật, ép thứ tự commit bằng khoá dòng ───────────────
  describe('4. health callback đồng thời / đảo thứ tự', () => {
    const fresh: Record<string, string> = {};
    const base = Date.now() + 3_600_000; // mốc riêng, không đụng sự kiện ở các nhóm test khác
    const at = (s: number) => new Date(base + s * 1000).toISOString();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    /** Giữ khoá dòng account trong một transaction riêng; `inside` chạy trong transaction (vd. thu hồi). */
    function holdRow(id: string, ms: number, inside?: (tx: any) => Promise<unknown>) {
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ZaloAccount" WHERE "id" = ${id}::uuid FOR UPDATE`;
        if (inside) await inside(tx);
        await sleep(ms);
      }, { timeout: 20_000 });
    }
    const send = (id: string, body: Record<string, unknown>, o: { eventId?: string } = {}) => health(id, body, o).then((r) => r);
    beforeAll(async () => {
      for (const [k, s2, t] of [['a1', sa, A], ['a2', sa, A], ['b1', sb, B]] as const) {
        const r = await write(s2, 'post', '/zalo-accounts', { displayName: `${t.n} race ${k}`, dailyQuota: 5 });
        expect(r.status).toBe(200); fresh[k] = r.body.id;
      }
    });

    it('hai event khác eventId chạy đồng thời (10 lượt, thứ tự commit tuỳ PostgreSQL) → account luôn giữ event mới; event cũ commit sau → STALE', async () => {
      const id = fresh.a1; let staleCount = 0;
      for (let k = 0; k < 10; k++) {
        const t = 10 + k * 2;
        const lock = holdRow(id, 250); await sleep(60);
        const pair = [send(id, { status: 'CONNECTED', at: at(t) }), send(id, { status: 'RELOGIN_REQUIRED', at: at(t + 1) })];
        if (k % 2) pair.reverse();
        await lock;
        const [a, b] = await Promise.all(pair);
        const older = k % 2 ? b : a; const newer = k % 2 ? a : b;
        expect(newer.body.result).toBe('APPLIED'); expect(['APPLIED', 'STALE']).toContain(older.body.result);
        if (older.body.result === 'STALE') staleCount++;
        const row = await acc(id); expect(row.status).toBe('RELOGIN_REQUIRED'); expect(row.lastSenderEventAt!.toISOString()).toBe(at(t + 1));
      }
      // Ca xác định: event mới đã commit, event cũ đến/commit sau → STALE, không đổi account.
      expect((await send(id, { status: 'CONNECTED', at: at(28) })).body.result).toBe('STALE');
      expect((await acc(id)).status).toBe('RELOGIN_REQUIRED');
      console.log('[health-race] older event STALE in', staleCount, 'of 10 concurrent rounds');
    });
    it('đảo lại: event cũ gửi trước, event mới gửi sau, cùng chờ khoá → thứ tự thực thi bất kỳ, cuối cùng luôn là event mới', async () => {
      const id = fresh.a1;
      const lock = holdRow(id, 700);
      await sleep(100);
      const older = send(id, { status: 'DISCONNECTED', at: at(30) });
      await sleep(150);
      const newer = send(id, { status: 'CONNECTED', at: at(40) });
      await lock;
      const [o, n] = await Promise.all([older, newer]);
      expect(n.body.result).toBe('APPLIED'); expect(['APPLIED', 'STALE']).toContain(o.body.result);
      expect((await acc(id)).status).toBe('CONNECTED');
      // Event cũ DISCONNECTED đến sau khi đã CONNECTED mới hơn → STALE, không đổi.
      expect((await send(id, { status: 'DISCONNECTED', at: at(35) })).body.result).toBe('STALE');
      expect((await acc(id)).status).toBe('CONNECTED');
    });
    it('8 event ngẫu nhiên bắn đồng thời → account luôn mang trạng thái của event có occurredAt lớn nhất', async () => {
      const id = fresh.a2;
      const statuses = ['CONNECTED', 'DISCONNECTED', 'RELOGIN_REQUIRED', 'RESTRICTED'] as const;
      const evs = Array.from({ length: 8 }, (_, i) => ({ status: statuses[i % 4], at: at(100 + ((i * 7919) % 97)) }));
      const lock = holdRow(id, 400); await sleep(80);
      const rs = await Promise.all([...evs].sort(() => Math.random() - 0.5).map((e) => send(id, e)));
      await lock;
      expect(rs.map((r) => r.status + ':' + JSON.stringify(r.body).slice(0, 120)).filter((x) => !x.startsWith('200'))).toEqual([]);
      const newest = evs.reduce((m, e) => (e.at > m.at ? e : m));
      const row = await acc(id);
      expect(row.status).toBe(newest.status); expect(row.lastSenderEventAt!.toISOString()).toBe(newest.at);
      expect(rs.filter((r) => r.body.result === 'APPLIED').length).toBeGreaterThanOrEqual(1);
    });
    it('hai callback cùng eventId trong lúc dòng bị khoá → một bản ghi, một lần áp dụng', async () => {
      const id = fresh.a2; const eventId = randomUUID();
      const lock = holdRow(id, 500); await sleep(80);
      const rs = await Promise.all([1, 2, 3, 4].map(() => send(id, { status: 'RESTRICTED', at: at(500) }, { eventId })));
      await lock;
      expect(rs.every((r) => r.status === 200)).toBe(true);
      expect(rs.filter((r) => r.body.duplicate === true)).toHaveLength(3);
      expect(await prisma.senderHealthEvent.count({ where: { eventId } })).toBe(1);
      expect((await prisma.auditLog.count({ where: { targetId: id, action: 'ZALO_ACCOUNT_SENDER_HEALTH', metadata: { path: ['eventId'], equals: eventId } } }))).toBe(1);
    });
    it('event RELOGIN_REQUIRED mới, rồi PAUSED đến sau nhưng thời điểm cũ hơn → không che RELOGIN_REQUIRED', async () => {
      const id = fresh.a2;
      expect((await send(id, { status: 'RELOGIN_REQUIRED', at: at(600) })).body.result).toBe('APPLIED');
      expect((await send(id, { status: 'PAUSED', at: at(590) })).body.result).toMatch(/STALE|IGNORED/);
      expect((await send(id, { status: 'PAUSED', at: at(610) })).body.result).toBe('IGNORED'); // mới hơn nhưng account không CONNECTED
      expect((await acc(id)).status).toBe('RELOGIN_REQUIRED');
    });
    it('account bị thu hồi trong lúc callback đang chờ → callback IGNORED, account vẫn REVOKED', async () => {
      const id = fresh.a1;
      const lock = holdRow(id, 600, (tx) => tx.zaloAccount.update({ where: { id }, data: { status: 'REVOKED', revokedAt: new Date() } }));
      await sleep(100);
      const cb = send(id, { status: 'CONNECTED', at: at(900) });
      await lock;
      const r = await cb;
      expect(r.status).toBe(200); expect(r.body.result).toBe('IGNORED');
      const row = await acc(id); expect(row.status).toBe('REVOKED'); expect(row.lastSenderEventAt!.toISOString()).toBe(at(40));
    });
    it('callback cho account tenant A không tác động account tenant B', async () => {
      const before = await acc(fresh.b1);
      const rs = await Promise.all([send(fresh.a2, { status: 'CONNECTED', at: at(1000) }), send(fresh.a2, { status: 'RESTRICTED', at: at(1001) })]);
      expect(rs.every((r) => r.status === 200)).toBe(true);
      const after = await acc(fresh.b1);
      expect(after.status).toBe(before.status); expect(after.lastSenderEventAt).toEqual(before.lastSenderEventAt); expect(after.updatedAt).toEqual(before.updatedAt);
      const evs = await prisma.senderHealthEvent.findMany({ where: { zaloAccountId: fresh.a2 } });
      expect(evs.every((e) => e.tenantId === A.tenantId)).toBe(true);
      expect(await prisma.senderHealthEvent.count({ where: { zaloAccountId: fresh.b1 } })).toBe(0);
    });
  });
});
