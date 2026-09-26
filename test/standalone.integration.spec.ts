import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import * as nodeHttp from 'node:http';
import request = require('supertest');
import { StandaloneAppModule } from '../src/standalone/standalone-app.module';
import { CareWorkerService } from '../src/worker/care-worker.service';
import { connectorCanonical, CONNECTOR_SIGNATURE_PREFIX } from '../src/standalone/source-connector.client';
import { signingKeyOf } from '../src/standalone/local-credentials.service';
import { SourceConnectorService } from '../src/standalone/source-connector.service';

/**
 * Standalone PC edition against a dedicated QA database (the PC holds exactly one business, so this
 * suite wipes its own database first). Run with `npm run test:standalone`.
 */
const ORIGIN = 'http://127.0.0.1:47100';
const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');

type Appt = Record<string, any>;

/** Fake customer system implementing "VETCLINIC Source Connector v1", verifying every CRM signature. */
class FakeSource {
  server!: nodeHttp.Server; base = '';
  signingKeys = new Map<string, string>();
  appointments: Appt[] = [];
  receivables: Record<string, any>[] = [];
  eligible = new Map<string, boolean>();
  down = false;
  seenNonces = new Set<string>();
  calls: string[] = [];
  rejected = 0;
  async start() {
    this.server = nodeHttp.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
        const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (this.down) { req.socket.destroy(); return; }
        const clientId = String(req.headers['x-care-client-id'] || ''); const ts = String(req.headers['x-care-timestamp'] || '');
        const nonce = String(req.headers['x-care-nonce'] || ''); const sig = String(req.headers['x-care-signature'] || '');
        const key = this.signingKeys.get(clientId);
        const expected = key ? createHmac('sha256', key).update(connectorCanonical(req.method!, req.url!, ts, nonce, raw)).digest('hex') : '';
        if (!key || sig !== expected || Math.abs(Date.now() - Number(ts)) > 300_000 || this.seenNonces.has(nonce)) { this.rejected++; return send(401, {}); }
        this.seenNonces.add(nonce);
        const url = new URL(req.url!, 'http://x'); this.calls.push(`${req.method} ${url.pathname}`);
        if (req.method === 'GET' && url.pathname === '/connector/v1/appointments') return send(200, { data: { items: this.appointments, page: 0, totalPages: 1, last: true } });
        if (req.method === 'GET' && url.pathname === '/connector/v1/receivables') return send(200, { data: { items: this.receivables, page: 0, totalPages: 1, last: true } });
        const m = url.pathname.match(/^\/connector\/v1\/(appointments|receivables)\/([^/]+)\/revalidate$/);
        if (req.method === 'POST' && m) {
          const id = decodeURIComponent(m[2]); const ok = this.eligible.get(`${m[1]}:${id}`) === true;
          return send(200, { data: m[1] === 'appointments' ? { appointmentId: id, eligible: ok, reasonCode: ok ? 'ELIGIBLE' : 'CANCELLED' } : { receivableId: id, eligible: ok, reasonCode: ok ? 'ELIGIBLE' : 'PAID', remainingAmount: ok ? 500000 : 0 } });
        }
        return send(404, {});
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/connector/v1`;
  }
  stop() { return new Promise((r) => this.server.close(r)); }
}

function appt(id: string, overrides: Appt = {}): Appt {
  return { id, appointmentAt: new Date(Date.now() + 2 * 86400_000).toISOString(), status: 'SCHEDULED', revision: 'r1', branchId: 'CN1', customer: { name: `Khách ${id}`, phone: '0901234567' }, pet: { name: 'Mướp' }, serviceName: 'Tiêm phòng', consent: { status: 'DEFAULT_ALLOWED', channel: 'ZALO', purpose: 'APPOINTMENT_REMINDER' }, ...overrides };
}

describe('Standalone PC edition: local accounts, self-issued credential, source connector, worker rules', () => {
  const prisma = new PrismaClient();
  const source = new FakeSource();
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  let owner = { cookie: '', csrf: '' };
  let credential = { clientId: '', clientSecret: '' };
  let tenantId = '';
  let installationId = '';

  async function login(username: string, password: string) {
    const res = await http().post('/api/v1/crm/auth/local/login').set('Origin', ORIGIN).send({ username, password });
    const cookie = (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('vc_crm_session='))?.split(';')[0] || '';
    if (!cookie) return { res, cookie: '', csrf: '' };
    const me = await http().get('/api/v1/crm/auth/me').set('Cookie', cookie);
    return { res, cookie, csrf: me.body.csrfToken as string };
  }

  function signedCareJob(secret: string, body: Record<string, unknown>, opts: { path?: string; tamper?: boolean; key?: string } = {}) {
    const raw = JSON.stringify(body); const ts = String(Date.now()); const nonce = randomBytes(12).toString('hex');
    const path = opts.path || '/api/v1/care-jobs';
    const key = opts.key ?? signingKeyOf(secret);
    const sig = createHmac('sha256', key).update(`POST\n${path}\n${ts}\n${nonce}\n${sha256(opts.tamper ? `${raw} ` : raw)}`).digest('hex');
    return { raw, headers: { 'content-type': 'application/json', 'x-care-timestamp': ts, 'x-care-nonce': nonce, 'x-care-signature': sig } };
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      PHONE_HASH_PEPPER: randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), WORKER_ENABLED: 'false',
      CRM_SESSION_SECRET: randomBytes(32).toString('hex'), ADMIN_SESSION_SECRET: randomBytes(32).toString('hex'), CRM_PUBLIC_ORIGIN: ORIGIN,
      CRM_ENTITLEMENT_RECHECK_SECONDS: '15', MOCK_ADAPTER_ENABLED: 'true',
      // This suite covers the edition without Platform: the test-only licence bypass (never in a release; NODE_ENV=test)
      // stands in for an activated PC. Mandatory activation itself is covered by platform-device.integration.spec.ts.
      PLATFORM_LICENSE_BYPASS: '1',
    });
    delete process.env.CARE_JOB_MAX_LATENESS_HOURS;
    // Dedicated database: wipe everything the edition owns.
    await prisma.$executeRawUnsafe('TRUNCATE "PlatformDesiredConfiguration", "PlatformDeviceRegistration", "StandaloneInstance", "LocalUser", "CrmSession", "CrmTenant", "SourceConnection", "DeliveryAttempt", "DeliveryQuotaCounter", "WebhookDelivery", "CareJob", "ZaloRoutingRule", "ZaloAccount", "MessageTemplate", "ApiCredential", "RequestNonce", "OptOut", "AuditLog", "SystemSetting", "Installation" CASCADE');
    await source.start();
    const module = await Test.createTestingModule({ imports: [StandaloneAppModule] }).compile();
    app = module.createNestApplication({ rawBody: true }); app.setGlobalPrefix('api/v1'); await app.init();
  });

  afterAll(async () => { delete process.env.PLATFORM_LICENSE_BYPASS; await app?.close(); await source.stop(); await prisma.$disconnect(); });

  it('reports first-run setup and exposes no Platform / operator routes', async () => {
    expect((await http().get('/api/v1/crm/auth/local/status')).body).toEqual({ mode: 'standalone', setupRequired: true, businessName: null });
    expect((await http().get('/api/v1/crm/auth/start')).status).toBe(404);
    expect((await http().get('/api/v1/crm/auth/platform/callback')).status).toBe(404);
    expect((await http().post('/api/v1/crm/platform/events').send({})).status).toBe(404);
    expect((await http().post('/api/v1/admin/login').send({})).status).toBe(404);
    expect((await http().post('/api/v1/installations').send({})).status).toBe(404);
  });

  it('rejects weak setup input and cross-origin setup', async () => {
    const weak = await http().post('/api/v1/crm/auth/local/setup').set('Origin', ORIGIN).send({ businessName: 'PK', username: 'chu', password: '1234567890' });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('PASSWORD_TOO_SIMPLE');
    const cross = await http().post('/api/v1/crm/auth/local/setup').set('Origin', 'http://evil.test').send({ businessName: 'PK', username: 'chu', password: 'Mat-khau-rat-dai-1' });
    expect(cross.status).toBe(403);
    expect(await prisma.standaloneInstance.count()).toBe(0);
  });

  it('first-run setup creates the business, owner, connector installation, templates and a one-time credential', async () => {
    const res = await http().post('/api/v1/crm/auth/local/setup').set('Origin', ORIGIN).send({ businessName: 'Phòng khám Mướp', username: 'Chu.PhongKham', displayName: 'Chủ PK', password: 'Mat-khau-rat-dai-1' });
    expect(res.status).toBe(200);
    expect(res.body.apiCredential.clientId).toMatch(/^vccrm_/);
    expect(res.body.apiCredential.clientSecret.length).toBeGreaterThanOrEqual(40);
    credential = res.body.apiCredential; tenantId = res.body.tenant.id;
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('vc_crm_session='))!;
    expect(cookie).toMatch(/HttpOnly/i); expect(cookie).toMatch(/SameSite=Strict/i);
    const row = await prisma.apiCredential.findUniqueOrThrow({ where: { clientId: credential.clientId } });
    // Stored: encrypted signing key + fingerprint only; neither the secret nor the signing key in clear.
    expect(row.signingKeyEnc).toBeTruthy();
    expect(row.secretHash).toBe(sha256(signingKeyOf(credential.clientSecret)));
    expect(JSON.stringify(row)).not.toContain(credential.clientSecret);
    expect(JSON.stringify(row)).not.toContain(signingKeyOf(credential.clientSecret));
    const inst = await prisma.installation.findFirstOrThrow({ where: { tenantId } });
    installationId = inst.id;
    expect(inst.sourceProduct).toBe('EXTERNAL_CONNECTOR');
    expect((await prisma.messageTemplate.findMany({ where: { installationId } })).map((t) => t.code).sort()).toEqual(['APPT_REMINDER_V1', 'DEBT_REMINDER_V1']);
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(credential.clientSecret);
    owner = await login('chu.phongkham', 'Mat-khau-rat-dai-1');
    expect(owner.cookie).toBeTruthy();
  });

  it('allows setup only once per PC (one business per PC)', async () => {
    const again = await http().post('/api/v1/crm/auth/local/setup').set('Origin', ORIGIN).send({ businessName: 'Khác', username: 'khac', password: 'Mat-khau-rat-dai-2' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_SET_UP');
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "StandaloneInstance" (id, "tenantId") VALUES (2, '${randomUUID()}')`)).rejects.toThrow();
    expect((await http().get('/api/v1/crm/auth/local/status')).body).toEqual({ mode: 'standalone', setupRequired: false, businessName: 'Phòng khám Mướp' });
  });

  it('owner session: me, permissions, CSRF on mutations', async () => {
    const me = await http().get('/api/v1/crm/auth/me').set('Cookie', owner.cookie);
    expect(me.status).toBe(200);
    expect(me.body.mode).toBe('standalone');
    expect(me.body.tenant).toEqual({ id: tenantId, name: 'Phòng khám Mướp' });
    expect(me.body.roles).toEqual(['CRM_OWNER']);
    expect(me.body.permissions).toContain('crm.users.manage');
    expect(me.body.platformAccountUrl).toBeNull();
    const noCsrf = await http().post('/api/v1/crm/local/users').set('Cookie', owner.cookie).set('Origin', ORIGIN).send({});
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF_INVALID');
    const wrongOrigin = await http().post('/api/v1/crm/local/users').set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', 'http://evil.test').send({});
    expect(wrongOrigin.status).toBe(403);
    expect((await http().get('/api/v1/crm/overview').set('Cookie', 'vc_crm_session=forged')).status).toBe(401);
  });

  it('login failures give one generic answer and lock the account after 5 attempts', async () => {
    const created = await http().post('/api/v1/crm/local/users').set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN).send({ username: 'le.tan', displayName: 'Lễ tân', role: 'CRM_STAFF', password: 'Le-tan-mat-khau-1' });
    expect(created.status).toBe(200);
    const unknown = await login('khong.co', 'bat-ky-mat-khau');
    const wrong = await login('le.tan', 'sai-mat-khau-123');
    expect(unknown.res.status).toBe(401); expect(wrong.res.status).toBe(401);
    expect(unknown.res.body.code).toBe('LOGIN_FAILED'); expect(wrong.res.body.code).toBe('LOGIN_FAILED');
    for (let i = 0; i < 4; i++) await login('le.tan', 'sai-mat-khau-123');
    const lockedOut = await login('le.tan', 'Le-tan-mat-khau-1');
    expect(lockedOut.res.status).toBe(401);
    expect((await prisma.localUser.findUniqueOrThrow({ where: { username: 'le.tan' } })).lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // Owner resets the password: unlocks and the new password works.
    const id = created.body.id as string;
    const reset = await http().patch(`/api/v1/crm/local/users/${id}`).set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN).send({ password: 'Le-tan-mat-khau-2' });
    expect(reset.status).toBe(200);
    expect((await login('le.tan', 'Le-tan-mat-khau-2')).cookie).toBeTruthy();
  });

  it('staff are limited by role; owner cannot be demoted; disabling a user ends its sessions at once', async () => {
    const staff = await login('le.tan', 'Le-tan-mat-khau-2');
    expect((await http().get('/api/v1/crm/local/users').set('Cookie', staff.cookie)).status).toBe(403);
    expect((await http().post('/api/v1/crm/local/api-credentials/rotate').set('Cookie', staff.cookie).set('x-csrf-token', staff.csrf).set('Origin', ORIGIN)).status).toBe(403);
    expect((await http().get('/api/v1/crm/overview').set('Cookie', staff.cookie)).status).toBe(200);
    const asOwner = await http().post('/api/v1/crm/local/users').set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN).send({ username: 'chu2', role: 'CRM_OWNER', password: 'Mat-khau-rat-dai-9' });
    expect(asOwner.status).toBe(400);
    const ownerRow = await prisma.localUser.findUniqueOrThrow({ where: { username: 'chu.phongkham' } });
    expect((await http().patch(`/api/v1/crm/local/users/${ownerRow.id}`).set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN).send({ active: false })).status).toBe(403);
    const staffRow = await prisma.localUser.findUniqueOrThrow({ where: { username: 'le.tan' } });
    expect((await http().patch(`/api/v1/crm/local/users/${staffRow.id}`).set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN).send({ active: false })).status).toBe(200);
    expect((await http().get('/api/v1/crm/overview').set('Cookie', staff.cookie)).status).toBe(401);
    expect((await login('le.tan', 'Le-tan-mat-khau-2')).res.status).toBe(401);
  });

  it('changing the password ends every other session of that user', async () => {
    const other = await login('chu.phongkham', 'Mat-khau-rat-dai-1');
    const res = await http().post('/api/v1/crm/auth/local/change-password').set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN).send({ currentPassword: 'Mat-khau-rat-dai-1', newPassword: 'Mat-khau-moi-dai-7' });
    expect(res.status).toBe(200);
    expect((await http().get('/api/v1/crm/overview').set('Cookie', other.cookie)).status).toBe(401);
    expect((await http().get('/api/v1/crm/overview').set('Cookie', owner.cookie)).status).toBe(401);
    owner = await login('chu.phongkham', 'Mat-khau-moi-dai-7');
    expect(owner.cookie).toBeTruthy();
  });

  it('external systems call the care-job API with the self-issued credential (HMAC, nonce, rotation, revoke)', async () => {
    const body = { sourceProduct: 'EXTERNAL_CONNECTOR', externalReferenceId: 'appointment:EXT-1', eventType: 'APPOINTMENT_REMINDER', templateCode: 'APPT_REMINDER_V1', scheduledAt: new Date(Date.now() + 3600_000).toISOString(), idempotencyKey: 'ext-1', consentStatus: 'GRANTED', recipient: { name: 'Khách EXT', phone: '0901234568' }, templateVariables: { customerName: 'Khách EXT' } };
    const ok = signedCareJob(credential.clientSecret, body);
    const first = await http().post('/api/v1/care-jobs').set({ ...ok.headers, 'x-care-client-id': credential.clientId }).send(ok.raw);
    expect(first.status).toBe(201);
    expect(first.body.replay).toBe(false);
    // Replay of the same nonce, tampered body, and signing with the stored fingerprint are all rejected.
    expect((await http().post('/api/v1/care-jobs').set({ ...ok.headers, 'x-care-client-id': credential.clientId }).send(ok.raw)).status).toBe(401);
    const tampered = signedCareJob(credential.clientSecret, body, { tamper: true });
    expect((await http().post('/api/v1/care-jobs').set({ ...tampered.headers, 'x-care-client-id': credential.clientId }).send(tampered.raw)).status).toBe(401);
    const fp = (await prisma.apiCredential.findUniqueOrThrow({ where: { clientId: credential.clientId } })).secretHash;
    const withFingerprint = signedCareJob('', body, { key: fp });
    expect((await http().post('/api/v1/care-jobs').set({ ...withFingerprint.headers, 'x-care-client-id': credential.clientId }).send(withFingerprint.raw)).status).toBe(401);
    // Tenant comes from the credential: a foreign tenantId in the body is refused.
    const foreign = signedCareJob(credential.clientSecret, { ...body, idempotencyKey: 'ext-2', tenantId: randomUUID() });
    expect((await http().post('/api/v1/care-jobs').set({ ...foreign.headers, 'x-care-client-id': credential.clientId }).send(foreign.raw)).status).toBe(403);

    const rotated = await http().post('/api/v1/crm/local/api-credentials/rotate').set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN);
    expect(rotated.status).toBe(200);
    const oldStill = signedCareJob(credential.clientSecret, { ...body, idempotencyKey: 'ext-3' });
    expect((await http().post('/api/v1/care-jobs').set({ ...oldStill.headers, 'x-care-client-id': credential.clientId }).send(oldStill.raw)).status).toBe(201);
    const next = signedCareJob(rotated.body.clientSecret, { ...body, idempotencyKey: 'ext-4' });
    expect((await http().post('/api/v1/care-jobs').set({ ...next.headers, 'x-care-client-id': rotated.body.clientId }).send(next.raw)).status).toBe(201);
    const list = await http().get('/api/v1/crm/local/api-credentials').set('Cookie', owner.cookie);
    expect(JSON.stringify(list.body)).not.toContain(rotated.body.clientSecret);
    expect(list.body.credentials.map((c: any) => c.status).sort()).toEqual(['ACTIVE', 'ROTATING_OUT']);
    const revoke = await http().post(`/api/v1/crm/local/api-credentials/${credential.clientId}/revoke`).set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN);
    expect(revoke.status).toBe(200);
    const afterRevoke = signedCareJob(credential.clientSecret, { ...body, idempotencyKey: 'ext-5' });
    expect((await http().post('/api/v1/care-jobs').set({ ...afterRevoke.headers, 'x-care-client-id': credential.clientId }).send(afterRevoke.raw)).status).toBe(401);
    credential = { clientId: rotated.body.clientId, clientSecret: rotated.body.clientSecret };
    source.signingKeys.set(credential.clientId, signingKeyOf(credential.clientSecret));
    await prisma.careJob.updateMany({ where: { installationId, externalReferenceId: 'appointment:EXT-1' }, data: { status: 'CANCELLED' } });
  });

  it('source connector: rejects insecure URLs, dry-run creates nothing, consent policy is applied', async () => {
    const put = (body: Record<string, unknown>) => http().put('/api/v1/crm/local/source-connector').set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN).send(body);
    expect((await put({ apiBaseUrl: 'http://10.0.0.5/connector/v1', allowedBranchIds: ['CN1'], active: true })).status).toBe(400);
    expect((await put({ apiBaseUrl: 'https://user:pw@example.test/x', allowedBranchIds: ['CN1'], active: true })).status).toBe(400);
    expect((await put({ apiBaseUrl: source.base, allowedBranchIds: [], active: true })).status).toBe(400);
    expect((await put({ apiBaseUrl: source.base, allowedBranchIds: ['CN1'], active: true })).body.code).toBe('SOURCE_KIND_REQUIRED');
    const cfg = await put({ sourceKind: 'PETCLINIC', apiBaseUrl: source.base, allowedBranchIds: ['CN1'], active: true, receivablesEnabled: true, reminderLeadMinutes: 1440 });
    expect(cfg.status).toBe(200);
    source.appointments = [
      appt('A1'),
      appt('A2', { consent: { status: 'GRANTED', channel: 'ZALO', purpose: 'APPOINTMENT_REMINDER' } }),
      appt('A3', { consent: { status: 'REVOKED', channel: 'ZALO', purpose: 'APPOINTMENT_REMINDER' } }),
      appt('A4', { consent: { status: 'OPTED_OUT' } }),
      appt('A5', { consent: { status: 'DEFAULT_ALLOWED', channel: 'SMS', purpose: 'APPOINTMENT_REMINDER' } }),
      appt('A6', { consent: { status: 'DEFAULT_ALLOWED', channel: 'ZALO', purpose: 'MARKETING' } }),
      appt('A7', { consent: undefined }),
      appt('A8', { branchId: 'CN9' }),
      appt('A9', { status: 'CANCELLED' }),
    ];
    const before = await prisma.careJob.count();
    const preview = await http().post('/api/v1/crm/local/source-connector/appointments/preview').set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN).send({});
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ dryRun: true, scanned: 9, eligible: 2, created: 0 });
    expect(preview.body.skippedByReason).toEqual({ CONSENT_BLOCKED: 4, CONSENT_MISSING: 1, BRANCH_NOT_APPROVED: 1, STATUS_INELIGIBLE: 1 });
    expect(await prisma.careJob.count()).toBe(before);
    expect(source.rejected).toBe(0);
  });

  it('source connector: commit is idempotent and a reschedule cancels the old reminder', async () => {
    const sync = () => http().post('/api/v1/crm/local/source-connector/appointments/sync').set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN).send({});
    const first = await sync();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ dryRun: false, eligible: 2, created: 2 });
    expect((await sync()).body.created).toBe(0);
    const a1 = await prisma.careJob.findFirstOrThrow({ where: { externalReferenceId: 'appointment:A1', status: 'QUEUED' } });
    expect(a1.sourceRevision).toBe('r1');
    expect(a1.scheduledAt.getTime()).toBe(new Date(source.appointments[0].appointmentAt).getTime() - 1440 * 60_000);
    source.appointments[0] = appt('A1', { appointmentAt: new Date(Date.now() + 3 * 86400_000).toISOString(), revision: 'r2' });
    const third = await sync();
    expect(third.body.created).toBe(1);
    expect((await prisma.careJob.findUniqueOrThrow({ where: { id: a1.id } })).failureCode).toBe('SOURCE_RESCHEDULED');
    // Revoked consent later cancels the queued reminder.
    source.appointments[1] = appt('A2', { consent: { status: 'WITHDRAWN' } });
    await sync();
    expect(await prisma.careJob.count({ where: { externalReferenceId: 'appointment:A2', status: 'QUEUED' } })).toBe(0);
  });

  it('receivables need explicit GRANTED consent and are queued at most once per day', async () => {
    source.receivables = [
      { id: 'R1', documentCode: 'HD001', customer: { name: 'Khách nợ', phone: '0907654321' }, remainingAmount: 500000, dueAt: '2026-09-30', branchId: 'CN1', revision: 'v1', consent: { status: 'GRANTED', channel: 'ZALO', purpose: 'DEBT_REMINDER' } },
      { id: 'R2', documentCode: 'HD002', customer: { name: 'Khách mặc định', phone: '0907654322' }, remainingAmount: 200000, dueAt: null, branchId: 'CN1', revision: 'v1', consent: { status: 'DEFAULT_ALLOWED', channel: 'ZALO', purpose: 'DEBT_REMINDER' } },
    ];
    const list = await http().get('/api/v1/crm/local/source-connector/receivables').set('Cookie', owner.cookie);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: any) => [i.id, i.eligible, i.ineligibleReason])).toEqual([['R1', true, null], ['R2', false, 'CONSENT_NOT_GRANTED']]);
    expect(JSON.stringify(list.body)).not.toContain('0907654321');
    const q = (id: string) => http().post(`/api/v1/crm/local/source-connector/receivables/${id}/queue`).set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN);
    expect((await q('R2')).status).toBe(403);
    const one = await q('R1'); const two = await q('R1');
    expect(one.status).toBe(200); expect({ status: two.status, body: two.body }).toMatchObject({ status: 200, body: { replay: true } }); expect(two.body.id).toBe(one.body.id);
  });

  it('worker: revalidates with the source right before sending; unreachable source never sends', async () => {
    await prisma.installation.update({ where: { id: installationId }, data: { quietHoursStart: '00:00', quietHoursEnd: '00:00' } });
    await prisma.zaloAccount.create({ data: { tenantId, channel: 'MOCK', status: 'CONNECTED', isDefault: true, dailyQuota: 50, displayName: 'Mock QA' } });
    await prisma.careJob.updateMany({ where: { installationId, status: 'QUEUED' }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
    const worker = app.get(CareWorkerService);
    const drain = async () => { for (let i = 0; i < 20 && (await worker.processNext()); i++) { /* one job per claim */ } };

    source.down = true;
    await drain();
    expect(await prisma.careJob.count({ where: { installationId, status: 'SENT' } })).toBe(0);
    expect(await prisma.careJob.count({ where: { installationId, status: 'QUEUED', failureCode: 'SOURCE_VERIFY_UNAVAILABLE' } })).toBeGreaterThan(0);

    source.down = false;
    source.eligible.set('appointments:A1', true);
    source.eligible.set('receivables:R1', false);
    await prisma.careJob.updateMany({ where: { installationId, status: 'QUEUED' }, data: { nextAttemptAt: null } });
    await drain();
    const byRef = async (ref: string) => (await prisma.careJob.findFirstOrThrow({ where: { installationId, externalReferenceId: ref }, orderBy: { createdAt: 'desc' } }));
    expect((await byRef('appointment:A1')).status).toBe('SENT');
    expect((await byRef('receivable:R1')).status).toBe('CANCELLED');
    expect((await byRef('receivable:R1')).failureCode).toBe('SOURCE_NO_LONGER_VALID');
    expect(source.calls.filter((c) => c.endsWith('/revalidate')).length).toBeGreaterThanOrEqual(2);
  });

  it('worker: a reminder later than 12 hours is cancelled (EXPIRED_WHILE_OFFLINE); under 12 hours still goes out', async () => {
    const worker = app.get(CareWorkerService);
    const base = { installationId, sourceProduct: 'EXTERNAL_CONNECTOR' as const, eventType: 'APPOINTMENT_REMINDER', templateCode: 'APPT_REMINDER_V1', templateVariables: { customerName: 'Khách trễ', petName: 'Mướp', serviceName: 'Khám', appointmentTime: '09:00 26/09/2026' }, consentStatus: 'GRANTED' as const, requestHash: sha256(randomUUID()), sourceRevision: 'r1' };
    const { CryptoService } = await import('../src/common/crypto.service');
    const c = new CryptoService();
    const mk = (id: string, hoursLate: number) => prisma.careJob.create({ data: { ...base, idempotencyKey: `late-${id}`, externalReferenceId: `appointment:${id}`, recipientNameEnc: c.encrypt('Khách trễ'), phoneEnc: c.encrypt('+84901230000'), phoneHash: c.phoneHash('+84901230000'), scheduledAt: new Date(Date.now() - hoursLate * 3600_000), sourceAppointmentAt: new Date(Date.now() + 3600_000) } });
    const late = await mk('LATE13', 13);
    const fresh = await mk('LATE11', 11);
    source.eligible.set('appointments:LATE11', true);
    source.eligible.set('appointments:LATE13', true);
    for (let i = 0; i < 5 && (await worker.processNext()); i++) { /* drain */ }
    const l = await prisma.careJob.findUniqueOrThrow({ where: { id: late.id } });
    expect(l.status).toBe('CANCELLED'); expect(l.failureCode).toBe('EXPIRED_WHILE_OFFLINE');
    expect(await prisma.deliveryAttempt.count({ where: { careJobId: late.id } })).toBe(0);
    expect(source.calls).not.toContain('POST /connector/v1/appointments/LATE13/revalidate');
    expect(await prisma.careJob.findUniqueOrThrow({ where: { id: fresh.id }, select: { status: true, failureCode: true } })).toEqual({ status: "SENT", failureCode: null });
    expect(await prisma.auditLog.count({ where: { action: 'CARE_JOB_EXPIRED', targetId: late.id } })).toBe(1);
  });

  it('local emergency stop holds every job without sending', async () => {
    const set = (enabled: boolean) => http().put('/api/v1/crm/local/emergency-stop').set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN).send({ enabled, reason: 'QA' });
    expect((await set(true)).status).toBe(200);
    const { CryptoService } = await import('../src/common/crypto.service');
    const c = new CryptoService();
    const job = await prisma.careJob.create({ data: { installationId, sourceProduct: 'EXTERNAL_CONNECTOR', eventType: 'APPOINTMENT_REMINDER', templateCode: 'APPT_REMINDER_V1', templateVariables: {}, consentStatus: 'GRANTED', requestHash: sha256(randomUUID()), idempotencyKey: 'kill-1', externalReferenceId: 'appointment:KILL', recipientNameEnc: c.encrypt('K'), phoneEnc: c.encrypt('+84901230001'), phoneHash: c.phoneHash('+84901230001'), scheduledAt: new Date(Date.now() - 60_000), sourceAppointmentAt: new Date(Date.now() + 3600_000), sourceRevision: 'r1' } });
    source.eligible.set('appointments:KILL', true);
    await app.get(CareWorkerService).processNext();
    const held = await prisma.careJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(held.status).toBe('QUEUED'); expect(held.failureCode).toBe('SYSTEM_PAUSED');
    expect((await http().get('/api/v1/crm/local/emergency-stop').set('Cookie', owner.cookie)).body.enabled).toBe(true);
    expect((await set(false)).status).toBe(200);
  });

  it('data of a foreign tenant row in the same database is not reachable through the CRM API', async () => {
    const foreignTenant = randomUUID();
    const inst = await prisma.installation.create({ data: { tenantId: foreignTenant, sourceProduct: 'B2B_SALE', status: 'ACTIVE', scopes: [] } });
    const { CryptoService } = await import('../src/common/crypto.service');
    const c = new CryptoService();
    const job = await prisma.careJob.create({ data: { installationId: inst.id, sourceProduct: 'B2B_SALE', eventType: 'DEBT_REMINDER', templateCode: 'X', templateVariables: {}, consentStatus: 'GRANTED', requestHash: sha256(randomUUID()), idempotencyKey: 'foreign', externalReferenceId: 'x', recipientNameEnc: c.encrypt('F'), phoneEnc: c.encrypt('+84901230002'), phoneHash: c.phoneHash('+84901230002'), scheduledAt: new Date(Date.now() + 86400_000), status: 'CANCELLED' } });
    expect((await http().get(`/api/v1/crm/jobs/${job.id}`).set('Cookie', owner.cookie)).status).toBe(404);
    expect((await http().get(`/api/v1/crm/installations/${inst.id}`).set('Cookie', owner.cookie)).status).toBe(404);
    const insts = await http().get('/api/v1/crm/installations').set('Cookie', owner.cookie);
    expect(insts.body.map((i: any) => i.id)).toEqual([installationId]);
  });

  it('local-status (tray/diagnostics) is unauthenticated but counts-only, and legal/sender falls back when Sender is down', async () => {
    const res = await http().get('/api/v1/local-status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'standalone', setupRequired: false, emergencyStop: false, source: { configured: true, active: true } });
    expect(typeof res.body.queue.queued).toBe('number');
    expect(res.body.zalo.total).toBeGreaterThanOrEqual(1);
    const raw = JSON.stringify(res.body);
    for (const leak of ['0901234567', '+8490', 'Khách', 'Mướp', credential.clientId, tenantId]) expect(raw).not.toContain(leak);
    process.env.SENDER_V2_BASE_URL = 'http://127.0.0.1:1';
    const legal = await http().get('/api/v1/legal/sender');
    expect(legal.status).toBe(200);
    expect(legal.text).toContain('AGPL');
  });

  it('signature canonical string is domain-separated from the inbound care-job signature', () => {
    expect(connectorCanonical('get', '/a?b=1', '1', 'n', '').startsWith(`${CONNECTOR_SIGNATURE_PREFIX}\nGET\n/a?b=1\n`)).toBe(true);
    expect(app.get(SourceConnectorService)).toBeDefined();
  });
});
