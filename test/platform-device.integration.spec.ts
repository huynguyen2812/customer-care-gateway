import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash, createHmac, generateKeyPairSync, KeyObject, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import * as nodeHttp from 'node:http';
import request = require('supertest');
import { StandaloneAppModule } from '../src/standalone/standalone-app.module';
import { CareWorkerService } from '../src/worker/care-worker.service';
import { PlatformDeviceService } from '../src/standalone/platform/platform-device.service';
import { LicenseGateService, licenseBypassEnabled, licensedSourceOf } from '../src/standalone/platform/license-gate.service';
import { TenantAccessService } from '../src/crm/tenant-access.service';
import { ChannelRouterService } from '../src/channel/channel-router.service';
import { redeemCanonical, requestCanonical } from '../src/standalone/platform/platform-device.contract';
import { signingKeyOf } from '../src/standalone/local-credentials.service';

/**
 * Platform Device Agent against a FAKE Platform (test-only HTTP server implementing the PROPOSED contract in
 * docs/standalone/platform-device-contract-v1.md) + a fake source system. Dedicated QA database; run with
 * `npm run test:platform`. No real Platform, no real Zalo (MOCK channel only). The test-only licence bypass is OFF here
 * (production behaviour) except inside the one test that proves how it is (and is not) enabled.
 */
const ORIGIN = 'http://127.0.0.1:47100';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
// Branch ids on the wire are Platform branch UUIDs (shared contract §6); a PETCLINIC local id like '812' is unmapped.
const CN1 = '0c0f0000-0000-4000-8000-0000000000c1', CN2 = '0c0f0000-0000-4000-8000-0000000000c2', CN9 = '0c0f0000-0000-4000-8000-0000000000c9', B1 = '0b0b0000-0000-4000-8000-0000000000b1';
const PHONE = '0901234567';
const CUSTOMER = 'Khách Nhắc Lịch';
// Platform grants per source: CN1/CN2 only to PETCLINIC, B1 only to B2B_SALE. The union bug would let either use all three.
const SOURCES = [{ product: 'PETCLINIC', allowedBranchIds: [CN1, CN2], maxBranches: 5 }, { product: 'B2B_SALE', allowedBranchIds: [B1], maxBranches: 5 }];

type Code = { tenantId: string; product: string; expiresAt: number; usedBy?: { deviceId: string; publicKey: string } };
type Device = { publicKey: string; status: 'ACTIVE' | 'REVOKED' | 'UNPAIRED'; installationId: string; tenantId: string };

class FakePlatform {
  server!: nodeHttp.Server; base = ''; keyId = 'qa-config-key-1';
  private configKey: KeyObject; publicPem: string;
  otherKey = generateKeyPairSync('ed25519');
  codes = new Map<string, Code>();
  devices = new Map<string, Device>();
  requestIdsByCode = new Map<string, string[]>();
  nonces = new Set<string>();
  heartbeats: any[] = [];
  rawRequests: string[] = [];
  down = false; dropNextRedeemAnswer = false; badSignNextRedeem = false; redeemDelayMs = 0; unpairDelayMs = 0;
  srcAppointments: unknown[] = [];
  /** Per-call redeem behaviour (consumed in order): delay before processing, drop the answer after processing, or answer an error. */
  redeemPlan: { delay?: number; drop?: boolean; error?: { status: number; code: string } }[] = [];
  /** Platform admin "create pairing code": refused while the business still has an ACTIVE primary PC (shared contract). */
  adminCreateCode() {
    if ([...this.devices.values()].some((d) => d.status === 'ACTIVE')) throw new Error('PRIMARY_PC_EXISTS');
    const c = `${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}`.toUpperCase();
    this.codes.set(c, { tenantId: 'tenant-qa', product: 'CUSTOMER_CARE_CRM', expiresAt: Date.now() + 10 * 60_000 });
    return c;
  }
  nextSync: ((deviceId: string, body: any) => { deviceStatus: string; config?: unknown }) | null = null;
  nextSyncError: { status: number; body: unknown } | null = null;
  /** Mirror of Platform's lease/renewal rules (crm-pc-device.service.ts) for the vector test. */
  lease: { grace: number; planValidUntil: number | null; planStatus: string; sources: unknown[] } | null = null;
  leaseState: { rev: number; issuedAt: number; expiresAt: number; policy: string; env: unknown } | null = null;
  lastEnvelope: unknown = null;
  leaseSync(deviceId: string, body: { currentRevision: number }) {
    const now = Date.now(); const L = this.lease!; const MIN_LEASE = 5 * 60_000;
    const usable = ['ACTIVE', 'TRIAL'].includes(L.planStatus) && (!L.planValidUntil || L.planValidUntil > now);
    const maxExp = now + Math.max(MIN_LEASE, L.grace * 3600_000);
    const ends = [L.planValidUntil].filter((e): e is number => !!e && e > now);
    const exp = usable && ends.length ? Math.min(maxExp, ...ends) : maxExp;
    const planStatus = usable ? L.planStatus : ['ACTIVE', 'TRIAL'].includes(L.planStatus) ? 'EXPIRED' : L.planStatus;
    const policy = JSON.stringify({ g: L.grace, planStatus, v: L.planValidUntil, s: L.sources });
    const st = this.leaseState;
    const window = Math.min(24 * 3600_000, (st ? st.expiresAt - st.issuedAt : Math.max(MIN_LEASE, L.grace * 3600_000)) / 3);
    const renew = !!st && st.expiresAt - now <= window && exp > st.expiresAt;
    if (!st || st.policy !== policy || renew || st.expiresAt <= now) {
      const rev = Math.max(body.currentRevision, st?.rev ?? 0) + 1;
      const env = this.sign(this.payload(deviceId, { revision: rev, issuedAt: new Date(now).toISOString(), expiresAt: new Date(exp).toISOString(), offlineGraceHours: L.grace, sources: L.sources,
        plan: { code: 'CRM_PC_BASIC', status: planStatus, validFrom: null, validUntil: L.planValidUntil ? new Date(L.planValidUntil).toISOString() : null } }));
      this.leaseState = { rev, issuedAt: now, expiresAt: exp, policy, env }; this.lastEnvelope = env;
    }
    return { deviceStatus: 'ACTIVE', ...(body.currentRevision < this.leaseState!.rev ? { config: this.leaseState!.env } : {}) };
  }
  redeemCalls = 0; authFailures = 0;
  constructor() { const kp = generateKeyPairSync('ed25519'); this.configKey = kp.privateKey; this.publicPem = kp.publicKey.export({ type: 'spki', format: 'pem' }) as string; }

  payload(deviceId: string, o: Record<string, any> = {}) {
    const d = this.devices.get(deviceId)!;
    // Default lease per the shared formula: grace 72 ⇒ expiresAt = issuedAt + 72 h.
    return {
      v: 1, type: 'CRM_PC_CONFIG', productCode: 'CUSTOMER_CARE_CRM', revision: 1, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
      deviceId, deviceStatus: 'ACTIVE', platformInstallationId: d?.installationId || 'inst-qa', tenant: { id: d?.tenantId || 'tenant-qa', name: 'Phòng khám Platform QA' },
      plan: { code: 'CRM_PC_BASIC', status: 'ACTIVE', validFrom: null, validUntil: new Date(Date.now() + 30 * 86400_000).toISOString() },
      sources: SOURCES, features: { appointmentReminder: true, debtReminder: false }, limits: { dailyQuota: 40 }, reminderLeadMinutes: 1440,
      quietHours: { start: '00:00', end: '00:00', timezone: 'Asia/Ho_Chi_Minh' }, offlineGraceHours: 72, ...o,
    };
  }
  sign(p: unknown, key: KeyObject = this.configKey, keyId = this.keyId) {
    const bytes = Buffer.from(JSON.stringify(p));
    return { payload: bytes.toString('base64url'), signature: sign(null, bytes, key).toString('base64'), keyId };
  }

  async start() {
    this.server = nodeHttp.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', async () => {
        this.rawRequests.push(raw);
        const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (this.down) { req.socket.destroy(); return; }
        const url = new URL(req.url!, 'http://x');
        // ---- fake source system (connector) ----
        const src = url.pathname.match(/^\/src\/appointments\/([^/]+)\/revalidate$/);
        if (src) return send(200, { data: { appointmentId: decodeURIComponent(src[1]), eligible: true, reasonCode: 'ELIGIBLE' } });
        if (url.pathname === '/src/appointments') return send(200, { data: { items: this.srcAppointments, last: true } });
        const body = raw ? JSON.parse(raw) : {};
        if (url.pathname === '/api/crm-pc/v1/devices/redeem') {
          this.redeemCalls++;
          const plan = this.redeemPlan.shift() ?? {};
          if (this.redeemDelayMs || plan.delay) await new Promise((r) => setTimeout(r, plan.delay ?? this.redeemDelayMs));
          if (plan.error) return send(plan.error.status, { code: plan.error.code });
          const { proof, ...rest } = body;
          if (!verify(null, Buffer.from(redeemCanonical(rest)), body.devicePublicKey, Buffer.from(String(proof), 'base64'))) return send(401, { code: 'DEVICE_PROOF_INVALID' });
          const code = this.codes.get(body.activationCode);
          if (!code) return send(403, { code: 'ACTIVATION_CODE_INVALID' });
          if (code.product !== 'CUSTOMER_CARE_CRM') return send(403, { code: 'ACTIVATION_WRONG_PRODUCT' });
          if (code.usedBy && (code.usedBy.deviceId !== body.deviceId || code.usedBy.publicKey !== body.devicePublicKey)) return send(409, { code: 'ACTIVATION_CODE_USED' });
          // Retry only before the ORIGINAL expiry, even for the same binding; a revoked/unpaired device is never revived.
          if (code.expiresAt <= Date.now()) return send(403, { code: 'ACTIVATION_CODE_EXPIRED' });
          if (code.usedBy && ['REVOKED', 'UNPAIRED'].includes(this.devices.get(body.deviceId)?.status ?? '')) return send(403, { code: 'DEVICE_REVOKED' });
          this.requestIdsByCode.set(body.activationCode, [...(this.requestIdsByCode.get(body.activationCode) || []), body.requestId]);
          if (!code.usedBy) { code.usedBy = { deviceId: body.deviceId, publicKey: body.devicePublicKey }; this.devices.set(body.deviceId, { publicKey: body.devicePublicKey, status: 'ACTIVE', installationId: `inst-${body.deviceId.slice(0, 8)}`, tenantId: code.tenantId }); }
          const bad = this.badSignNextRedeem; this.badSignNextRedeem = false;
          const answer = { deviceId: body.deviceId, platformInstallationId: this.devices.get(body.deviceId)!.installationId, config: this.sign(this.payload(body.deviceId), bad ? this.otherKey.privateKey : this.configKey) };
          if (this.dropNextRedeemAnswer || plan.drop) { this.dropNextRedeemAnswer = false; req.socket.destroy(); return; } // processed, answer lost
          return send(200, answer);
        }
        const m = url.pathname.match(/^\/api\/crm-pc\/v1\/devices\/([^/]+)\/(sync|unpair)$/);
        if (m) {
          const dev = this.devices.get(m[1]);
          const ts = String(req.headers['x-vc-timestamp']); const nonce = String(req.headers['x-vc-nonce']);
          const ok = dev && req.headers['x-vc-device-id'] === m[1] && Math.abs(Date.now() - Number(ts)) < 300_000 && !this.nonces.has(nonce)
            && verify(null, Buffer.from(requestCanonical('POST', url.pathname, ts, nonce, sha(raw))), dev.publicKey, Buffer.from(String(req.headers['x-vc-signature']), 'base64'));
          if (!ok) { this.authFailures++; return send(401, { code: dev ? 'DEVICE_AUTH_INVALID' : 'DEVICE_UNKNOWN' }); }
          this.nonces.add(nonce);
          if (m[2] === 'unpair') {
            if (this.unpairDelayMs) await new Promise((r) => setTimeout(r, this.unpairDelayMs));
            if (dev!.status === 'REVOKED') return send(403, { code: 'DEVICE_REVOKED' });
            dev!.status = 'UNPAIRED'; return send(200, { ok: true });
          }
          this.heartbeats.push(body.heartbeat);
          if (dev!.status === 'REVOKED') return send(403, { code: 'DEVICE_REVOKED' });
          if (this.nextSyncError) return send(this.nextSyncError.status, this.nextSyncError.body);
          return send(200, this.nextSync ? this.nextSync(m[1], body) : { deviceStatus: 'ACTIVE' });
        }
        send(404, {});
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() { return new Promise((r) => this.server.close(r)); }
}

describe('Platform Device Agent (fake Platform): mandatory activation, atomic pairing, per-source scope, heartbeat, offline grace', () => {
  const prisma = new PrismaClient();
  const platform = new FakePlatform();
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  let owner = { cookie: '', csrf: '' };
  let credential = { clientId: '', clientSecret: '' };
  let tenantId = ''; let installationId = '';
  let firstCode = ''; let firstRequestId = '';
  const machineKey = randomBytes(32).toString('hex');

  const code = (o: Partial<Code> = {}) => { const c = `${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}`.toUpperCase(); platform.codes.set(c, { tenantId: 'tenant-qa', product: 'CUSTOMER_CARE_CRM', expiresAt: Date.now() + 10 * 60_000, ...o }); return c; };
  const post = (path: string, body: unknown = {}) => http().post(`/api/v1/crm/local/${path}`).set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN).send(body as object);
  const putConnector = (body: Record<string, unknown>) => http().put('/api/v1/crm/local/source-connector').set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).set('Origin', ORIGIN).send({ apiBaseUrl: `${platform.base}/src`, active: true, appointmentsEnabled: true, ...body });
  const status = async () => (await http().get('/api/v1/crm/local/platform').set('Cookie', owner.cookie)).body;
  const reg = () => prisma.platformDeviceRegistration.findUniqueOrThrow({ where: { id: 1 } });
  function signedJob(body: Record<string, unknown>) {
    const raw = JSON.stringify(body); const ts = String(Date.now()); const nonce = randomBytes(12).toString('hex');
    const sig = createHmac('sha256', signingKeyOf(credential.clientSecret)).update(`POST\n/api/v1/care-jobs\n${ts}\n${nonce}\n${sha(raw)}`).digest('hex');
    return http().post('/api/v1/care-jobs').set({ 'content-type': 'application/json', 'x-care-client-id': credential.clientId, 'x-care-timestamp': ts, 'x-care-nonce': nonce, 'x-care-signature': sig }).send(raw);
  }
  const job = (key: string, branchId: string | undefined, hours = -0.1) => ({ sourceProduct: 'EXTERNAL_CONNECTOR', externalReferenceId: `appointment:${key}`, eventType: 'APPOINTMENT_REMINDER', templateCode: 'APPT_REMINDER_V1', scheduledAt: new Date(Date.now() + hours * 3600_000).toISOString(), sourceAppointmentAt: new Date(Date.now() + 26 * 3600_000).toISOString(), sourceRevision: 'r1', idempotencyKey: `k-${key}`, consentStatus: 'GRANTED', recipient: { name: CUSTOMER, phone: PHONE }, templateVariables: { customerName: CUSTOMER, petName: 'Mướp', serviceName: 'Khám', appointmentTime: '09:00' }, ...(branchId ? { branchId } : {}) });
  /** A queued job written straight to the DB (as if created earlier / by another source installation). */
  const rawJob = (key: string, o: Record<string, unknown> = {}) => prisma.careJob.create({ data: { installationId, idempotencyKey: `raw-${key}`, requestHash: sha(key), externalReferenceId: `appointment:${key}`, sourceProduct: 'EXTERNAL_CONNECTOR', eventType: 'APPOINTMENT_REMINDER', recipientNameEnc: 'x', phoneEnc: 'x', phoneHash: sha(key), templateCode: 'APPT_REMINDER_V1', templateVariables: {}, scheduledAt: new Date(Date.now() + 3600_000), consentStatus: 'GRANTED', sourceRevision: 'r1', sourceAppointmentAt: new Date(Date.now() + 26 * 3600_000), ...o } as any });
  const runDue = async (key: string) => {
    await prisma.careJob.updateMany({ where: { externalReferenceId: `appointment:${key}` }, data: { scheduledAt: new Date(Date.now() - 60_000), nextAttemptAt: null } });
    await app.get(CareWorkerService).processNext();
    return prisma.careJob.findFirstOrThrow({ where: { externalReferenceId: `appointment:${key}` }, select: { status: true, failureCode: true } });
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      PHONE_HASH_PEPPER: randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), WORKER_ENABLED: 'false',
      CRM_SESSION_SECRET: randomBytes(32).toString('hex'), CRM_PUBLIC_ORIGIN: ORIGIN, MOCK_ADAPTER_ENABLED: 'true', DEVICE_KEY_ENC_KEY: machineKey,
      PLATFORM_DEVICE_ALLOW_INSECURE_LOCAL: '1', CARE_JOB_MAX_LATENESS_HOURS: '12',
    });
    delete process.env.PLATFORM_LICENSE_BYPASS;
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS qa_fail_source_update ON "SourceConnection"');
    await prisma.$executeRawUnsafe('TRUNCATE "PlatformDesiredConfiguration", "PlatformDeviceRegistration", "StandaloneInstance", "LocalUser", "CrmSession", "CrmTenant", "SourceConnection", "DeliveryAttempt", "DeliveryQuotaCounter", "WebhookDelivery", "CareJob", "ZaloRoutingRule", "ZaloAccount", "MessageTemplate", "ApiCredential", "RequestNonce", "OptOut", "AuditLog", "SystemSetting", "Installation" CASCADE');
    await platform.start();
    process.env.PLATFORM_DEVICE_API_URL = `${platform.base}/api/crm-pc/v1`;
    process.env.PLATFORM_CONFIG_PUBLIC_KEYS = JSON.stringify({ [platform.keyId]: platform.publicPem });
    const module = await Test.createTestingModule({ imports: [StandaloneAppModule] }).compile();
    app = module.createNestApplication({ rawBody: true }); app.setGlobalPrefix('api/v1'); await app.init();
    const setup = await http().post('/api/v1/crm/auth/local/setup').set('Origin', ORIGIN).send({ businessName: 'PK Platform QA', username: 'chu.platform', password: 'Mat-khau-platform-1' });
    credential = setup.body.apiCredential; tenantId = setup.body.tenant.id;
    const login = await http().post('/api/v1/crm/auth/local/login').set('Origin', ORIGIN).send({ username: 'chu.platform', password: 'Mat-khau-platform-1' });
    const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('vc_crm_session='))!.split(';')[0];
    owner = { cookie, csrf: (await http().get('/api/v1/crm/auth/me').set('Cookie', cookie)).body.csrfToken };
    installationId = (await prisma.installation.findFirstOrThrow({ where: { tenantId } })).id;
    await prisma.zaloAccount.create({ data: { tenantId, channel: 'MOCK', status: 'CONNECTED', isDefault: true, dailyQuota: 50, displayName: 'Mock' } });
  });
  afterAll(async () => {
    delete process.env.PLATFORM_LICENSE_BYPASS;
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS qa_fail_source_update ON "SourceConnection"').catch(() => undefined);
    await app?.close(); await platform.stop(); await prisma.$disconnect();
  });

  it('NOT activated (production default): no care job is created and nothing is sent; setup/users/API key/source config+preview/status keep working', async () => {
    const st = await status();
    expect(st).toMatchObject({ mode: 'NOT_ACTIVATED', allowed: false, reason: 'PLATFORM_ACTIVATION_REQUIRED', licenseBypass: false, device: null, platformConfigured: true });
    // Care job creation through the local API credential is refused (the credential itself is valid: 403, not 401).
    const pre = await signedJob(job('PRE', CN1, 48));
    expect(pre.status).toBe(403); expect(pre.body.message).toBe('PLATFORM_ACTIVATION_REQUIRED');
    // Local API Client ID/Secret: reveal once, list without secret, rotate (24 h transition), revoke — unchanged.
    const list = await http().get('/api/v1/crm/local/api-credentials').set('Cookie', owner.cookie);
    expect(JSON.stringify(list.body)).not.toContain(credential.clientSecret);
    expect(list.body.credentials[0]).toMatchObject({ clientId: credential.clientId, secretLast4: credential.clientSecret.slice(-4), status: 'ACTIVE' });
    const rotated = await post('api-credentials/rotate');
    expect(rotated.status).toBe(200);
    expect((await signedJob(job('PRE2', CN1, 48))).status).toBe(403); // old key still authenticates during the transition
    expect((await post(`api-credentials/${credential.clientId}/revoke`)).status).toBe(200);
    expect((await signedJob(job('PRE3', CN1, 48))).status).toBe(401);
    credential = { clientId: rotated.body.clientId, clientSecret: rotated.body.clientSecret };
    // Staff accounts.
    expect((await post('users', { username: 'le.tan.platform', displayName: 'Lễ tân', role: 'CRM_STAFF', password: 'Le-tan-mat-khau-1' })).status).toBe(200);
    // Source connector: configure and preview work; committing (creating reminders) is refused.
    expect((await putConnector({ sourceKind: 'PETCLINIC', allowedBranchIds: [CN1, CN2, CN9, B1] })).status).toBe(200);
    const preview = await post('source-connector/appointments/preview');
    expect(preview.status).toBe(200); expect(preview.body.dryRun).toBe(true);
    const commit = await post('source-connector/appointments/sync', { commit: true });
    expect(commit.status).toBe(403); expect(commit.body.code).toBe('PLATFORM_ACTIVATION_REQUIRED');
    expect(await prisma.careJob.count()).toBe(0);
    // A job already in the queue (e.g. restored) is HELD, never sent.
    await rawJob('HELD-NOTACT', { branchId: CN1 });
    expect(await runDue('HELD-NOTACT')).toEqual({ status: 'QUEUED', failureCode: 'PLATFORM_ACTIVATION_REQUIRED' });
    expect(await prisma.deliveryAttempt.count()).toBe(0);
    const tray = (await http().get('/api/v1/local-status')).body.platform;
    expect(tray).toMatchObject({ activationRequired: true, licenseBypass: false, allowed: false, reason: 'PLATFORM_ACTIVATION_REQUIRED' });
  });

  it('test-only bypass: only PLATFORM_LICENSE_BYPASS=1 in the process env AND a non-production NODE_ENV; flagged in UI/tray; never in release config', async () => {
    expect(licenseBypassEnabled({ PLATFORM_LICENSE_BYPASS: '1', NODE_ENV: 'production' })).toBe(false);
    expect(licenseBypassEnabled({ PLATFORM_LICENSE_BYPASS: 'true', NODE_ENV: 'test' })).toBe(false);
    expect(licenseBypassEnabled({ NODE_ENV: 'test' })).toBe(false);
    expect(licenseBypassEnabled({ PLATFORM_LICENSE_BYPASS: '1', NODE_ENV: 'test' })).toBe(true);
    // A request can never switch it on.
    const viaRequest = await http().get('/api/v1/crm/local/platform?PLATFORM_LICENSE_BYPASS=1').set('Cookie', owner.cookie).set('x-platform-license-bypass', '1');
    expect(viaRequest.body.mode).toBe('NOT_ACTIVATED');
    expect((await signedJob({ ...job('BYP-REQ', CN1, 48), PLATFORM_LICENSE_BYPASS: '1' })).body.message).toBe('PLATFORM_ACTIVATION_REQUIRED');
    process.env.PLATFORM_LICENSE_BYPASS = '1';
    try {
      expect(await status()).toMatchObject({ mode: 'BYPASS', allowed: true, licenseBypass: true });
      expect((await http().get('/api/v1/local-status')).body.platform).toMatchObject({ licenseBypass: true, allowed: true });
      const nodeEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
      try { expect((await app.get(LicenseGateService).evaluate()).deny).toBe('PLATFORM_ACTIVATION_REQUIRED'); } finally { process.env.NODE_ENV = nodeEnv; }
    } finally { delete process.env.PLATFORM_LICENSE_BYPASS; }
    // Release packaging never sets it (services run NODE_ENV=production).
    const dir = join(__dirname, '..', 'packaging', 'windows');
    for (const f of readdirSync(dir).filter((n) => /\.(ps1|psm1|iss|json)$/.test(n))) expect(readFileSync(join(dir, f), 'utf8')).not.toMatch(/PLATFORM_LICENSE_BYPASS\s*=/);
    expect(readFileSync(join(dir, 'VetclinicCrm.psm1'), 'utf8')).toMatch(/NODE_ENV = 'production'; DEPLOYMENT_MODE = 'standalone'/);
  });

  it('activation code: format, unknown, expired, wrong product are refused; nothing is stored', async () => {
    expect((await post('platform/activate', { activationCode: 'abc' })).body.code).toBe('ACTIVATION_CODE_FORMAT');
    expect((await post('platform/activate', { activationCode: 'ZZZZ-ZZZZ-ZZZZ' })).body.code).toBe('ACTIVATION_CODE_INVALID');
    expect((await post('platform/activate', { activationCode: code({ expiresAt: Date.now() - 1 }) })).body.code).toBe('ACTIVATION_CODE_EXPIRED');
    const wrong = await post('platform/activate', { activationCode: code({ product: 'B2B_SALE' }) });
    expect(wrong.status).toBe(403); expect(wrong.body.code).toBe('ACTIVATION_WRONG_PRODUCT');
    expect((await reg()).status).toBe('PENDING');
    expect((await reg()).activationLockedUntil).toBeNull();
    expect(await status()).toMatchObject({ mode: 'NOT_ACTIVATED', reason: 'PLATFORM_ACTIVATION_REQUIRED' });
    const dump = JSON.stringify([await reg(), await prisma.auditLog.findMany()]);
    for (const c of platform.codes.keys()) expect(dump).not.toContain(c);
  });

  it('first config with a bad signature ⇒ device NOT active, nothing applied; the same device/request is kept for retry', async () => {
    firstCode = code();
    platform.badSignNextRedeem = true;
    const r = await post('platform/activate', { activationCode: firstCode });
    expect(r.status).toBe(503); expect(r.body.code).toBe('CONFIG_SIGNATURE_INVALID');
    const row = await reg();
    expect(row).toMatchObject({ status: 'PENDING', everPaired: false, activationLockedUntil: null, lastConfigRevision: 0 });
    expect(row.pendingRequestId).toBeTruthy();
    firstRequestId = row.pendingRequestId!;
    expect(await prisma.platformDesiredConfiguration.count()).toBe(0);
    expect((await prisma.installation.findUniqueOrThrow({ where: { id: installationId } })).dailyQuota).toBe(30);
    expect(await prisma.auditLog.count({ where: { action: { in: ['PLATFORM_CONFIG_APPLIED', 'PLATFORM_DEVICE_PAIRED'] } } })).toBe(0);
    expect(await status()).toMatchObject({ mode: 'NOT_ACTIVATED', allowed: false });
    expect(JSON.stringify(row)).not.toContain(firstCode);
  });

  it('DB failure while applying the config ⇒ full rollback (registration, config, quota, plan, source scope); retry keeps requestId', async () => {
    const tenantBefore = await prisma.crmTenant.findUniqueOrThrow({ where: { platformTenantId: tenantId } });
    const connBefore = await prisma.sourceConnection.findFirstOrThrow();
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION qa_fail_source_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'qa injected failure'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER qa_fail_source_update BEFORE UPDATE ON "SourceConnection" FOR EACH ROW EXECUTE FUNCTION qa_fail_source_update()');
    try {
      const r = await post('platform/activate', { activationCode: firstCode });
      expect(r.status).toBe(503); expect(r.body.code).toBe('ACTIVATION_FAILED');
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS qa_fail_source_update ON "SourceConnection"');
    }
    const row = await reg();
    expect(row).toMatchObject({ status: 'PENDING', everPaired: false, pendingRequestId: firstRequestId, activationLockedUntil: null, lastConfigRevision: 0, pairedAt: null, offlineGraceUntil: null });
    expect(await prisma.platformDesiredConfiguration.count()).toBe(0);
    expect((await prisma.installation.findUniqueOrThrow({ where: { id: installationId } })).dailyQuota).toBe(30);
    const tenantAfter = await prisma.crmTenant.findUniqueOrThrow({ where: { platformTenantId: tenantId } });
    expect({ plan: tenantAfter.planCode, limits: tenantAfter.limits }).toEqual({ plan: tenantBefore.planCode, limits: tenantBefore.limits });
    expect((await prisma.sourceConnection.findFirstOrThrow()).allowedBranchIds).toEqual(connBefore.allowedBranchIds);
    expect(await prisma.auditLog.count({ where: { action: { in: ['PLATFORM_CONFIG_APPLIED', 'PLATFORM_DEVICE_PAIRED'] } } })).toBe(0);
    // Both redeem calls for this code carried the same idempotency key and the same device.
    expect(platform.requestIdsByCode.get(firstCode)).toEqual([firstRequestId, firstRequestId]);
    expect(platform.devices.size).toBe(1);
  });

  it('two concurrent activations: exactly one runs (the other gets ACTIVATION_IN_PROGRESS); retry after the failures succeeds with ONE device', async () => {
    platform.redeemDelayMs = 400;
    const [a, b] = await Promise.all([post('platform/activate', { activationCode: firstCode }), post('platform/activate', { activationCode: firstCode })]);
    platform.redeemDelayMs = 0;
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((x) => x.status === 409)!.body.code).toBe('ACTIVATION_IN_PROGRESS');
    const row = await reg();
    expect(row).toMatchObject({ status: 'ACTIVE', everPaired: true, pendingRequestId: null, pendingCodeHash: null, activationLockedUntil: null, lastConfigRevision: 1 });
    expect(platform.devices.size).toBe(1);
    expect(new Set(platform.requestIdsByCode.get(firstCode))).toEqual(new Set([firstRequestId]));
    expect(await prisma.platformDesiredConfiguration.count()).toBe(1);
    expect((await post('platform/activate', { activationCode: code() })).body.code).toBe('ALREADY_PAIRED');
    // Another machine with its own key presenting the same (used) code is refused by Platform.
    const other = generateKeyPairSync('ed25519'); const pub = other.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const base = { activationCode: firstCode, requestId: randomUUID(), deviceId: randomUUID(), devicePublicKey: pub, appVersion: 'x' };
    const r = await fetch(`${platform.base}/api/crm-pc/v1/devices/redeem`, { method: 'POST', body: JSON.stringify({ ...base, proof: sign(null, Buffer.from(redeemCanonical(base)), other.privateKey).toString('base64') }) });
    expect(r.status).toBe(409);
  });

  it('paired status shows business, plan, masked device, remaining offline time and branches; scope applied per source; secrets never stored in clear', async () => {
    const st = await status();
    expect(st).toMatchObject({ mode: 'MANAGED', allowed: true, licenseBypass: false, license: { businessName: 'Phòng khám Platform QA', planStatus: 'ACTIVE', dailyQuota: 40 } });
    expect(st.device.deviceIdMasked).toMatch(/^.{4}….{4}$/);
    expect(st.device.offlineRemainingHours).toBeGreaterThan(71);
    const r = await reg();
    expect(r.devicePrivateKeyEnc.startsWith('v1.')).toBe(true);
    const dump = JSON.stringify([r, await prisma.platformDesiredConfiguration.findMany(), await prisma.auditLog.findMany()]);
    for (const c of platform.codes.keys()) expect(dump).not.toContain(c);
    expect(dump).not.toContain('PRIVATE KEY');
    expect(dump).not.toContain(credential.clientSecret);
    expect((await prisma.installation.findUniqueOrThrow({ where: { id: installationId } })).dailyQuota).toBe(40);
    // PETCLINIC connector ∩ PETCLINIC entry only: B1 (granted to B2B_SALE, not to PETCLINIC) is removed, CN9 too.
    expect((await prisma.sourceConnection.findFirstOrThrow()).allowedBranchIds).toEqual([CN1, CN2]);
  });

  it('branch scope is checked per source entry (never a union), at creation, in the connector settings and right before sending', async () => {
    const access = app.get(TenantAccessService);
    // HTTP creation path: connector kind PETCLINIC.
    expect((await signedJob(job('P-B1', B1, 1))).body.message).toBe('BRANCH_NOT_LICENSED'); // B2B-only branch
    expect((await signedJob(job('P-CN9', CN9, 1))).body.message).toBe('BRANCH_NOT_LICENSED');
    expect((await signedJob(job('P-NOBR', undefined, 1))).body.message).toBe('BRANCH_REQUIRED');
    expect((await signedJob(job('P-CN1', CN1, 48))).status).toBe(201);
    expect((await prisma.careJob.findFirstOrThrow({ where: { externalReferenceId: 'appointment:P-CN1' } })).licenseSource).toBe('PETCLINIC');
    expect((await putConnector({ sourceKind: 'PETCLINIC', allowedBranchIds: [CN1, B1] })).body.code).toBe('BRANCH_NOT_LICENSED');
    // Gate contract { sourceProduct, branchId, eventType }.
    expect(await access.canCreateJobs(tenantId, { sourceProduct: 'PETCLINIC', branchId: B1 })).toEqual({ ok: false, code: 'BRANCH_NOT_LICENSED' });
    expect(await access.canCreateJobs(tenantId, { sourceProduct: 'B2B_SALE', branchId: CN1 })).toEqual({ ok: false, code: 'BRANCH_NOT_LICENSED' });
    expect(await access.canCreateJobs(tenantId, { sourceProduct: 'B2B_SALE', branchId: B1 })).toEqual({ ok: true });
    expect(await access.canCreateJobs(tenantId, { sourceProduct: 'EXTERNAL', branchId: CN1 })).toEqual({ ok: false, code: 'SOURCE_NOT_LICENSED' });
    expect(await access.canCreateJobs(tenantId, { branchId: CN1 })).toEqual({ ok: false, code: 'SOURCE_SCOPE_REQUIRED' });
    expect(await access.canCreateJobs(tenantId, { sourceProduct: 'B2B_SALE', branchId: B1, eventType: 'DEBT_REMINDER' })).toEqual({ ok: false, code: 'FEATURE_NOT_LICENSED' });
    // Explicit product mapping (never inferred from branch ids).
    expect(['PETCLINIC_OPERATING', 'PETCLINIC_ESSENTIAL', 'B2B_SALE', 'EXTERNAL_CONNECTOR'].map((p) => licensedSourceOf(p))).toEqual(['PETCLINIC', 'PETCLINIC', 'B2B_SALE', null]);
    expect(licensedSourceOf('EXTERNAL_CONNECTOR', 'B2B_SALE')).toBe('B2B_SALE');
    expect(licensedSourceOf('EXTERNAL_CONNECTOR', CN1)).toBeNull();
    // Same branch string "CN1" in two different source systems: decided by the job's source, before sending.
    const b2bInst = await prisma.installation.create({ data: { tenantId, sourceProduct: 'B2B_SALE', status: 'ACTIVE', scopes: ['care:job:create'] } });
    const pcInst = await prisma.installation.create({ data: { tenantId, sourceProduct: 'PETCLINIC_OPERATING', status: 'ACTIVE', scopes: ['care:job:create'] } });
    const decide = async (o: { installationId: string; sourceProduct: string; licenseSource: string | null; branchId: string }) => access.sendingDecision(tenantId, await access.jobScope({ ...o, eventType: 'APPOINTMENT_REMINDER' }));
    expect(await decide({ installationId: b2bInst.id, sourceProduct: 'B2B_SALE', licenseSource: null, branchId: CN1 })).toEqual({ action: 'CANCEL', code: 'BRANCH_NOT_LICENSED' });
    expect(await decide({ installationId: pcInst.id, sourceProduct: 'PETCLINIC_OPERATING', licenseSource: null, branchId: CN1 })).toEqual({ action: 'SEND' });
    expect(await decide({ installationId: pcInst.id, sourceProduct: 'PETCLINIC_OPERATING', licenseSource: null, branchId: B1 })).toEqual({ action: 'CANCEL', code: 'BRANCH_NOT_LICENSED' });
    expect(await decide({ installationId: b2bInst.id, sourceProduct: 'B2B_SALE', licenseSource: null, branchId: B1 })).toEqual({ action: 'SEND' });
    await prisma.installation.deleteMany({ where: { id: { in: [b2bInst.id, pcInst.id] } } });

    // Switch the connector to B2B_SALE: jobs queued under PETCLINIC end; B2B branches apply from now on.
    expect((await putConnector({ sourceKind: 'B2B_SALE', allowedBranchIds: [B1] })).status).toBe(200);
    expect(await prisma.careJob.findFirstOrThrow({ where: { externalReferenceId: 'appointment:P-CN1' }, select: { status: true, failureCode: true } })).toEqual({ status: 'CANCELLED', failureCode: 'SOURCE_KIND_CHANGED' });
    expect((await signedJob(job('B-CN1', CN1, 1))).body.message).toBe('BRANCH_NOT_LICENSED');
    expect((await signedJob(job('B-B1', B1, 48))).status).toBe(201);
    expect((await prisma.careJob.findFirstOrThrow({ where: { externalReferenceId: 'appointment:B-B1' } })).licenseSource).toBe('B2B_SALE');
    // Pre-send revalidation uses the source RECORDED on the job.
    await rawJob('REC-PC', { branchId: CN1, licenseSource: 'PETCLINIC' });
    expect(await runDue('REC-PC')).toEqual({ status: 'CANCELLED', failureCode: 'SOURCE_KIND_CHANGED' });
    await rawJob('REC-B2B-CN1', { branchId: CN1, licenseSource: 'B2B_SALE' });
    expect(await runDue('REC-B2B-CN1')).toEqual({ status: 'CANCELLED', failureCode: 'BRANCH_NOT_LICENSED' });
    // A job created before activation without a branch is cancelled at send time, never sent.
    await prisma.careJob.updateMany({ where: { externalReferenceId: 'appointment:B-B1' }, data: { status: 'CANCELLED' } });
    // Back to PETCLINIC for the remaining tests.
    expect((await putConnector({ sourceKind: 'PETCLINIC', allowedBranchIds: [CN1, CN2] })).status).toBe(200);
    await rawJob('OLD-NOBRANCH', { licenseSource: 'PETCLINIC' });
    expect(await runDue('OLD-NOBRANCH')).toEqual({ status: 'CANCELLED', failureCode: 'BRANCH_REQUIRED' });
    // A connector without a chosen kind (row migrated from 0013) resolves no source: its jobs are held, not guessed.
    await prisma.sourceConnection.updateMany({ data: { sourceKind: null } });
    await rawJob('NOKIND', { branchId: CN1 });
    expect(await runDue('NOKIND')).toEqual({ status: 'QUEUED', failureCode: 'SOURCE_SCOPE_REQUIRED' });
    expect((await signedJob(job('NOKIND2', CN1, 1))).body.message).toBe('SOURCE_SCOPE_REQUIRED');
    await prisma.sourceConnection.updateMany({ data: { sourceKind: 'PETCLINIC' } });
    await prisma.careJob.updateMany({ where: { externalReferenceId: 'appointment:NOKIND' }, data: { status: 'CANCELLED' } });
  });

  it('heartbeat carries only aggregate, redacted data', async () => {
    await app.get(PlatformDeviceService).sync('MANUAL');
    const hb = platform.heartbeats.at(-1);
    expect(Object.keys(hb).sort()).toEqual(['appVersion', 'buildCommit', 'deviceId', 'errorCodes', 'lastSourceSyncAt', 'queue', 'services']);
    const all = platform.rawRequests.join('\n');
    for (const leak of [PHONE, '+8490', CUSTOMER, 'Mướp', credential.clientSecret, credential.clientId, 'PRIVATE KEY', 'cookie', tenantId]) expect(all).not.toContain(leak);
    expect(platform.authFailures).toBe(0);
  });

  it('signed config: bad signature / other device / stale revision are rejected; same revision is idempotent; narrowing a source cancels its out-of-scope jobs', async () => {
    const svc = app.get(PlatformDeviceService);
    const { deviceId } = await reg();
    platform.nextSync = (id) => ({ deviceStatus: 'ACTIVE', config: platform.sign(platform.payload(id, { revision: 5, limits: { dailyQuota: 999 } }), platform.otherKey.privateKey) });
    await svc.sync('MANUAL');
    expect((await reg()).lastConfigRevision).toBe(1); expect((await reg()).lastSyncError).toBe('CONFIG_REJECTED');
    platform.nextSync = () => ({ deviceStatus: 'ACTIVE', config: platform.sign(platform.payload(randomUUID(), { revision: 6 })) });
    await svc.sync('MANUAL');
    expect((await reg()).lastConfigRevision).toBe(1);
    // Duplicate product entries are malformed (scope is never merged).
    platform.nextSync = (id) => ({ deviceStatus: 'ACTIVE', config: platform.sign(platform.payload(id, { revision: 7, sources: [SOURCES[0], { ...SOURCES[0], allowedBranchIds: [CN9] }] })) });
    await svc.sync('MANUAL');
    expect((await reg()).lastConfigRevision).toBe(1);
    // A job queued for CN2 while CN2 is licensed to PETCLINIC.
    expect((await signedJob(job('N-CN2', CN2, 48))).status).toBe(201);
    // Revision 2: PETCLINIC narrowed to CN1; CN2 now granted to B2B_SALE only.
    const r2 = platform.payload(deviceId, { revision: 2, sources: [{ product: 'PETCLINIC', allowedBranchIds: [CN1], maxBranches: 1 }, { product: 'B2B_SALE', allowedBranchIds: [B1, CN2], maxBranches: 5 }], limits: { dailyQuota: 5 }, quietHours: { start: '22:00', end: '06:00', timezone: 'Asia/Ho_Chi_Minh' } });
    const signed2 = platform.sign(r2);
    platform.nextSync = () => ({ deviceStatus: 'ACTIVE', config: signed2 });
    await svc.sync('MANUAL');
    expect((await reg()).lastConfigRevision).toBe(2);
    await svc.sync('MANUAL'); // same document again (lost ACK / resend) ⇒ idempotent
    expect(await prisma.platformDesiredConfiguration.count({ where: { deviceId, revision: 2 } })).toBe(1);
    expect((await reg()).lastSyncError).toBeNull();
    platform.nextSync = () => ({ deviceStatus: 'ACTIVE', config: platform.sign(platform.payload(deviceId, { revision: 1, limits: { dailyQuota: 700 } })) });
    await svc.sync('MANUAL'); // downgrade
    expect((await reg()).lastConfigRevision).toBe(2);
    const inst = await prisma.installation.findUniqueOrThrow({ where: { id: installationId } });
    expect({ q: inst.dailyQuota, s: inst.quietHoursStart, e: inst.quietHoursEnd }).toEqual({ q: 5, s: '22:00', e: '06:00' });
    // Per source: CN2 is still licensed (to B2B_SALE) but not to this PETCLINIC connector.
    expect((await prisma.sourceConnection.findFirstOrThrow()).allowedBranchIds).toEqual([CN1]);
    expect((await signedJob(job('CN2JOB', CN2, 1))).body.message).toBe('BRANCH_NOT_LICENSED');
    expect(await prisma.auditLog.count({ where: { action: 'PLATFORM_CONFIG_REJECTED' } })).toBeGreaterThanOrEqual(4);
    // Back to a quiet-hours-free config, then the job queued before narrowing is revalidated and cancelled (policy:
    // out-of-scope branch/feature/source ⇒ CANCEL; plan/offline/revoke ⇒ HOLD).
    platform.nextSync = (id) => ({ deviceStatus: 'ACTIVE', config: platform.sign(platform.payload(id, { revision: 3, sources: [{ product: 'PETCLINIC', allowedBranchIds: [CN1], maxBranches: 1 }, { product: 'B2B_SALE', allowedBranchIds: [B1, CN2], maxBranches: 5 }] })) });
    await svc.sync('MANUAL'); platform.nextSync = null;
    expect(await runDue('N-CN2')).toEqual({ status: 'CANCELLED', failureCode: 'BRANCH_NOT_LICENSED' });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Licence expiry — shared Platform contract: the PC enforces the signed expiresAt and plan.validUntil as they are;
  // only a NEW verified revision renews; Platform decides when (renewWindow = min(24 h, lease / 3)).
  // Vector tests fake only Date (jest modern timers with every timer API left real); worker tests run in real time and
  // simulate elapsed time by moving the latest config's expiry in the QA DB.
  // ---------------------------------------------------------------------------------------------------------------
  const PC_ONLY = [{ product: 'PETCLINIC', allowedBranchIds: [CN1], maxBranches: 1 }, { product: 'B2B_SALE', allowedBranchIds: [B1, CN2], maxBranches: 5 }];
  const latestRow = async () => prisma.platformDesiredConfiguration.findFirstOrThrow({ where: { deviceId: (await reg()).deviceId }, orderBy: { revision: 'desc' } });
  const shiftLatest = async (o: { expiresAt?: Date; planValidUntil?: string | null }) => {
    const r = await latestRow(); const p = r.payload as any;
    const payload = { ...p, ...(o.planValidUntil !== undefined ? { plan: { ...p.plan, validUntil: o.planValidUntil } } : {}) };
    await prisma.platformDesiredConfiguration.update({ where: { id: r.id }, data: { payload, ...(o.expiresAt ? { expiresAt: o.expiresAt } : {}) } });
  };
  /** Platform issues a new signed revision (lease per the shared formula unless overridden). */
  const pushConfig = async (o: Record<string, unknown> = {}) => {
    const { deviceId, lastConfigRevision } = await reg();
    const doc = platform.sign(platform.payload(deviceId, { revision: lastConfigRevision + 1, sources: PC_ONLY, ...o }));
    platform.nextSync = () => ({ deviceStatus: 'ACTIVE', config: doc });
    const res = await app.get(PlatformDeviceService).sync('MANUAL');
    platform.nextSync = null;
    return { res, doc };
  };
  const syncWith = async (config?: unknown) => { platform.nextSync = () => ({ deviceStatus: 'ACTIVE', ...(config ? { config } : {}) }); const r = await app.get(PlatformDeviceService).sync('MANUAL'); platform.nextSync = null; return r; };
  const gate = () => app.get(LicenseGateService);
  const licenceSnapshot = async () => { const r = await reg(); const d = await gate().evaluate(); return { rev: r.lastConfigRevision, status: r.status, lastValidatedAt: r.lastValidatedAt?.getTime(), column: r.offlineGraceUntil?.getTime(), until: d.window?.until.getTime(), deny: d.deny }; };
  const MIN = 60_000;
  const onlyDate = { doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] as any };

  it('lease vectors (fake clock): grace 0 ⇒ t0+5 min; t0+2 min no renewal; t0+3 min 20 s renewal; no config ⇒ blocked at/after expiry; plan 90 s caps it; denial after plan end; grace 72 ⇒ exactly 72 h', async () => {
    const t0 = Math.floor(Date.now() / 1000) * 1000;
    const svc = app.get(PlatformDeviceService);
    platform.lease = { grace: 0, planValidUntil: null, planStatus: 'ACTIVE', sources: PC_ONLY };
    platform.nextSync = (id, body) => platform.leaseSync(id, body);
    jest.useFakeTimers({ ...onlyDate, now: t0 });
    try {
      // t0: policy changed (grace 72 → 0) ⇒ Platform signs a new revision: expiresAt = t0 + 5 min.
      await svc.sync('MANUAL');
      let w = (await gate().evaluate()).window!;
      expect(w.configExpiresAt.getTime()).toBe(t0 + 5 * MIN);
      expect(w.until.getTime()).toBe(t0 + 5 * MIN);
      expect((await latestRow()).payload).toMatchObject({ offlineGraceHours: 0 });
      // t0 + 2 min: not yet in the renewal window (100 s) ⇒ 200 without config ⇒ nothing extended.
      jest.setSystemTime(t0 + 2 * MIN);
      const before = await licenceSnapshot();
      expect(await svc.sync('MANUAL')).toMatchObject({ ok: true, applied: null });
      expect(await licenceSnapshot()).toEqual(before);
      // t0 + 3 min 20 s: renewal window reached ⇒ new revision, expiry moves atomically to (t0 + 3:20) + 5 min.
      jest.setSystemTime(t0 + 200_000);
      expect(await svc.sync('MANUAL')).toMatchObject({ applied: 'APPLIED' });
      const renewed = await reg();
      expect(renewed.lastConfigRevision).toBe(before.rev + 1);
      w = (await gate().evaluate()).window!;
      const e1 = t0 + 200_000 + 5 * MIN;
      expect(w.until.getTime()).toBe(e1);
      // Platform unreachable from now on: the current licence is used up to its own expiry, then blocked.
      platform.down = true;
      jest.setSystemTime(e1 - 60_000);
      expect((await svc.sync('MANUAL')).ok).toBe(false);
      expect((await gate().evaluate()).deny).toBeNull();
      expect((await gate().evaluate({}, new Date(e1 - 1))).deny).toBeNull();
      expect((await gate().evaluate({}, new Date(e1))).deny).toBe('PLATFORM_CONFIG_EXPIRED');
      jest.setSystemTime(e1 + 10 * MIN);
      expect((await svc.sync('MANUAL')).ok).toBe(false);
      expect((await gate().evaluate()).deny).toBe('PLATFORM_CONFIG_EXPIRED');
      expect((await reg()).lastConfigRevision).toBe(renewed.lastConfigRevision);
      platform.down = false;
      // Plan ends in 90 s ⇒ the signed licence does not go past it.
      const now1 = e1 + 10 * MIN; const tE = now1 + 90_000;
      platform.lease = { ...platform.lease!, planValidUntil: tE };
      await svc.sync('MANUAL'); // expired ⇒ Platform re-issues; policy changed too
      w = (await gate().evaluate()).window!;
      expect(w.configExpiresAt.getTime()).toBe(tE);
      expect(w.until.getTime()).toBe(tE);
      expect((await gate().evaluate({}, new Date(tE - 1))).deny).toBeNull();
      expect((await gate().evaluate({}, new Date(tE))).deny).toBe('PLAN_EXPIRED');
      // After tE Platform answers with a signed DENIAL revision (plan EXPIRED, plan.validUntil = tE in the past, envelope in the future).
      jest.setSystemTime(tE + 30_000);
      expect(await svc.sync('MANUAL')).toMatchObject({ applied: 'APPLIED' });
      const denial = (await latestRow()).payload as any;
      expect(denial.plan).toMatchObject({ status: 'EXPIRED', validUntil: new Date(tE).toISOString() });
      expect(new Date(denial.expiresAt).getTime()).toBe(tE + 30_000 + 5 * MIN);
      expect(await gate().evaluate()).toMatchObject({ deny: 'PLAN_EXPIRED', permanent: false });
      expect((await reg()).status).toBe('ACTIVE');
      // Plan renewed, grace 72 ⇒ expiresAt exactly issuedAt + 72 h (no extra 60 min anywhere).
      const now2 = tE + 60_000; jest.setSystemTime(now2);
      platform.lease = { ...platform.lease!, grace: 72, planValidUntil: now2 + 30 * 86400_000 };
      await svc.sync('MANUAL');
      w = (await gate().evaluate()).window!;
      expect(w.until.getTime()).toBe(now2 + 72 * 3600_000);
      expect((await gate().evaluate({}, new Date(now2 + 72 * 3600_000 - 1))).deny).toBeNull();
      expect((await gate().evaluate({}, new Date(now2 + 72 * 3600_000))).deny).toBe('PLATFORM_CONFIG_EXPIRED');
      // Replay of the same revision (Platform resends the stored envelope after a lost ACK) ⇒ no extension.
      const snap = await licenceSnapshot();
      jest.setSystemTime(now2 + 3600_000);
      expect(await syncWith(platform.lastEnvelope)).toMatchObject({ applied: 'DUPLICATE' });
      expect(await licenceSnapshot()).toEqual(snap);
    } finally {
      jest.useRealTimers();
      platform.nextSync = null; platform.lease = null; platform.down = false;
    }
  });

  it('expiry: valid ⇒ sent (Sender called once); signed config expired ⇒ HOLD, Sender NOT called; 200 / replay / bad / too-long lease / stale / conflicting configs never renew; API key, history, preview keep working; new revision resumes', async () => {
    const send = jest.spyOn(app.get(ChannelRouterService), 'send');
    let lastDoc = (await pushConfig({ offlineGraceHours: 72 })).doc;
    expect((await gate().evaluate()).deny).toBeNull();
    expect((await signedJob(job('W-OK', CN1, 48))).status).toBe(201);
    expect(await runDue('W-OK')).toEqual({ status: 'SENT', failureCode: null });
    expect(send).toHaveBeenCalledTimes(1);
    send.mockClear();

    expect((await signedJob(job('W-EXP', CN1, 48))).status).toBe(201);
    await shiftLatest({ expiresAt: new Date(Date.now() - 1000) });
    expect(await status()).toMatchObject({ allowed: false, reason: 'PLATFORM_CONFIG_EXPIRED' });
    const attempts = await prisma.deliveryAttempt.count();
    expect(await runDue('W-EXP')).toEqual({ status: 'QUEUED', failureCode: 'PLATFORM_CONFIG_EXPIRED' });
    expect(send).not.toHaveBeenCalled();
    expect(await prisma.deliveryAttempt.count()).toBe(attempts);
    expect((await signedJob(job('W-EXP-NEW', CN1, 48))).body.message).toBe('PLATFORM_CONFIG_EXPIRED');
    // Local API Client ID/Secret (list/rotate/revoke), history, source preview keep working while blocked.
    const list = await http().get('/api/v1/crm/local/api-credentials').set('Cookie', owner.cookie);
    expect(list.status).toBe(200); expect(JSON.stringify(list.body)).not.toContain(credential.clientSecret);
    const rotated = await post('api-credentials/rotate'); expect(rotated.status).toBe(200);
    expect((await post(`api-credentials/${credential.clientId}/revoke`)).status).toBe(200);
    credential = { clientId: rotated.body.clientId, clientSecret: rotated.body.clientSecret };
    expect((await signedJob(job('W-EXP-KEY', CN1, 48))).body.message).toBe('PLATFORM_CONFIG_EXPIRED'); // new key authenticates: 403, not 401
    expect((await http().get('/api/v1/crm/jobs').set('Cookie', owner.cookie)).status).toBe(200);
    expect((await post('source-connector/appointments/preview')).status).toBe(200);

    const before = await licenceSnapshot();
    expect(await syncWith()).toMatchObject({ ok: true, applied: null }); // HTTP 200 / heartbeat ACK without config
    expect(await syncWith(lastDoc)).toMatchObject({ applied: 'DUPLICATE' }); // replay of the same revision
    const { deviceId, lastConfigRevision } = await reg();
    const next = lastConfigRevision + 1;
    await syncWith(platform.sign(platform.payload(deviceId, { revision: next, sources: PC_ONLY }), platform.otherKey.privateKey)); // bad signature
    await syncWith(platform.sign(platform.payload(deviceId, { revision: next, sources: PC_ONLY, offlineGraceHours: 0, expiresAt: new Date(Date.now() + 3600_000).toISOString() }))); // lease longer than the formula
    await syncWith(platform.sign(platform.payload(randomUUID(), { revision: next, sources: PC_ONLY }))); // other device
    await syncWith(platform.sign(platform.payload(deviceId, { revision: lastConfigRevision - 1, sources: PC_ONLY }))); // stale
    await syncWith(platform.sign(platform.payload(deviceId, { revision: lastConfigRevision, sources: PC_ONLY, limits: { dailyQuota: 1 } }))); // same revision, other payload
    expect(await licenceSnapshot()).toEqual(before);
    expect(await prisma.auditLog.count({ where: { action: 'PLATFORM_CONFIG_REJECTED', metadata: { path: ['code'], equals: 'CONFIG_LEASE_INVALID' } } })).toBe(1);
    expect(await runDue('W-EXP')).toEqual({ status: 'QUEUED', failureCode: 'PLATFORM_CONFIG_EXPIRED' });
    expect(send).not.toHaveBeenCalled();
    // A new valid signed revision restores sending; the held job goes out; the 12 h lateness rule is unchanged.
    lastDoc = (await pushConfig({ offlineGraceHours: 72 })).doc;
    expect((await reg()).lastValidatedAt!.getTime()).toBeGreaterThan(before.lastValidatedAt!);
    expect(await runDue('W-EXP')).toEqual({ status: 'SENT', failureCode: null });
    expect(send).toHaveBeenCalledTimes(1);
    await rawJob('W-LATE', { branchId: CN1, licenseSource: 'PETCLINIC' });
    await prisma.careJob.updateMany({ where: { externalReferenceId: 'appointment:W-LATE' }, data: { scheduledAt: new Date(Date.now() - 13 * 3600_000) } });
    await app.get(CareWorkerService).processNext();
    expect(await prisma.careJob.findFirstOrThrow({ where: { externalReferenceId: 'appointment:W-LATE' }, select: { status: true, failureCode: true } })).toEqual({ status: 'CANCELLED', failureCode: 'EXPIRED_WHILE_OFFLINE' });
    expect(send).toHaveBeenCalledTimes(1);
    send.mockRestore();
  });

  it('plan end reached before the envelope (offline) ⇒ PLAN_EXPIRED HOLD, Sender not called', async () => {
    const send = jest.spyOn(app.get(ChannelRouterService), 'send');
    await pushConfig({ offlineGraceHours: 72 });
    expect((await signedJob(job('W-PLAN', CN1, 48))).status).toBe(201);
    await shiftLatest({ planValidUntil: new Date(Date.now() - 1000).toISOString() });
    expect(await runDue('W-PLAN')).toEqual({ status: 'QUEUED', failureCode: 'PLAN_EXPIRED' });
    expect(send).not.toHaveBeenCalled();
    await pushConfig({ offlineGraceHours: 72 });
    expect(await runDue('W-PLAN')).toEqual({ status: 'SENT', failureCode: null });
    send.mockRestore();
  });

  it('revocation only on the exact answer 403 DEVICE_REVOKED: 401 DEVICE_UNKNOWN, another 403, a 403 without code, a 5xx or a network error neither revoke nor extend', async () => {
    const svc = app.get(PlatformDeviceService);
    const before = await licenceSnapshot();
    for (const [status, body] of [[401, { code: 'DEVICE_UNKNOWN' }], [403, { code: 'FORBIDDEN' }], [403, {}], [503, { code: 'DEVICE_REVOKED' }]] as const) {
      platform.nextSyncError = { status, body };
      expect((await svc.sync('MANUAL')).ok).toBe(false);
    }
    platform.nextSyncError = null;
    platform.down = true; expect((await svc.sync('MANUAL')).ok).toBe(false); platform.down = false;
    expect(await licenceSnapshot()).toEqual(before);
    expect((await reg()).status).toBe('ACTIVE');
    expect(await prisma.auditLog.count({ where: { action: 'PLATFORM_DEVICE_REVOKED' } })).toBe(0);
  });

  it('SUSPENDED / EXPIRED plan holds sending without deleting data; restored plan resumes safely', async () => {
    for (const [status, reason] of [['SUSPENDED', 'PLAN_SUSPENDED'], ['EXPIRED', 'PLAN_EXPIRED']] as const) {
      // Signed denial revision: envelope valid in the future, plan.validUntil already in the past — must still be applied.
      expect((await pushConfig({ plan: { code: 'CRM_PC_BASIC', status, validFrom: null, validUntil: new Date(Date.now() - 3600_000).toISOString() } })).res).toMatchObject({ applied: 'APPLIED' });
      expect(await gate().evaluate()).toMatchObject({ deny: reason, permanent: false });
      expect((await signedJob(job(`S-${status}`, CN1, 1))).body.message).toBe(reason);
      await rawJob(`H-${status}`, { branchId: CN1, licenseSource: 'PETCLINIC' });
      expect(await runDue(`H-${status}`)).toEqual({ status: 'QUEUED', failureCode: reason });
    }
    await pushConfig({});
    expect(await status()).toMatchObject({ allowed: true, license: { planStatus: 'ACTIVE' } });
    expect((await signedJob(job('RESUMED', CN1, 48))).status).toBe(201);
  });

  it('device revoked by Platform: sending stops, nothing is deleted, the PC never falls back (not even with the test bypass)', async () => {
    const svc = app.get(PlatformDeviceService);
    platform.devices.get((await reg()).deviceId)!.status = 'REVOKED';
    const jobs = await prisma.careJob.count();
    await svc.sync('MANUAL');
    expect((await reg()).status).toBe('REVOKED');
    expect((await signedJob(job('REV', CN1, 48))).body.message).toBe('DEVICE_REVOKED');
    process.env.PLATFORM_LICENSE_BYPASS = '1';
    try { expect(await status()).toMatchObject({ mode: 'MANAGED', allowed: false, reason: 'DEVICE_REVOKED', licenseBypass: false }); } finally { delete process.env.PLATFORM_LICENSE_BYPASS; }
    expect(await prisma.careJob.count()).toBe(jobs);
    expect(await prisma.auditLog.count({ where: { action: 'PLATFORM_DEVICE_REVOKED' } })).toBe(1);
  });

  it('lost ACK on redeem: re-entering the same code reuses the same device AND requestId (no second device on Platform)', async () => {
    const c = code();
    platform.dropNextRedeemAnswer = true;
    const first = await post('platform/activate', { activationCode: c });
    expect(first.status).toBe(503);
    const pending = await reg();
    expect(pending.status).toBe('PENDING');
    // A re-activation attempt after being paired never counts as "not activated" (and never as bypass).
    process.env.PLATFORM_LICENSE_BYPASS = '1';
    try { expect(await status()).toMatchObject({ mode: 'MANAGED', allowed: false, reason: 'PLATFORM_ACTIVATION_REQUIRED' }); } finally { delete process.env.PLATFORM_LICENSE_BYPASS; }
    const second = await post('platform/activate', { activationCode: c });
    expect(second.status).toBe(200);
    expect((await reg()).deviceId).toBe(pending.deviceId);
    expect(platform.requestIdsByCode.get(c)).toEqual([pending.pendingRequestId, pending.pendingRequestId]);
    expect([...platform.devices.keys()].filter((id) => id === pending.deviceId)).toHaveLength(1);
    expect(platform.codes.get(c)!.usedBy!.deviceId).toBe(pending.deviceId);
  });

  it('restore on another PC (different machine key): device must be paired again; unpair keeps sending stopped', async () => {
    const original = process.env.DEVICE_KEY_ENC_KEY;
    process.env.DEVICE_KEY_ENC_KEY = randomBytes(32).toString('hex');
    (app.get(LicenseGateService) as any).keyCheck = null; // gate caches the key check for 60 s per blob
    expect(await status()).toMatchObject({ allowed: false, reason: 'DEVICE_REPAIR_REQUIRED' });
    expect((await app.get(PlatformDeviceService).sync('MANUAL'))).toMatchObject({ ok: false, code: 'DEVICE_REPAIR_REQUIRED' });
    process.env.DEVICE_KEY_ENC_KEY = original;
    (app.get(LicenseGateService) as any).keyCheck = null;
    expect((await post('platform/unpair', { confirm: 'sai' })).body.code).toBe('CONFIRM_REQUIRED');
    expect((await post('platform/unpair', { confirm: 'NGAT GHEP NOI' })).status).toBe(200);
    expect(await status()).toMatchObject({ mode: 'MANAGED', allowed: false, reason: 'PLATFORM_UNPAIRED' });
    expect((await signedJob(job('AFTER-UNPAIR', CN1, 48))).body.message).toBe('PLATFORM_UNPAIRED');
  });

  it('local-status (tray) exposes only codes, never names/ids/secrets', async () => {
    const s = await http().get('/api/v1/local-status');
    expect(s.body.platform).toMatchObject({ managed: true, activationRequired: false, licenseBypass: false, status: 'UNPAIRED', allowed: false, reason: 'PLATFORM_UNPAIRED' });
    const raw = JSON.stringify(s.body);
    for (const leak of ['Phòng khám Platform QA', (await reg()).deviceId, credential.clientId, tenantId]) expect(raw).not.toContain(leak);
  });
  // ---------------------------------------------------------------------------------------------------------------
  // Recovery of an unfinished (PENDING) activation — UI/API flow. Fake Platform follows the shared contract: a used code
  // can be retried by the same binding only before its original expiry (10 min from creation); after that
  // ACTIVATION_CODE_EXPIRED; a revoked device gets DEVICE_REVOKED; one primary PC per business (admin must revoke an
  // orphan before a new code can be created).
  // ---------------------------------------------------------------------------------------------------------------
  const loginAs = async (username: string, password: string) => {
    const login = await http().post('/api/v1/crm/auth/local/login').set('Origin', ORIGIN).send({ username, password });
    const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('vc_crm_session='))!.split(';')[0];
    return { cookie, csrf: (await http().get('/api/v1/crm/auth/me').set('Cookie', cookie)).body.csrfToken as string };
  };
  const postAs = (who: { cookie: string; csrf: string }, path: string, body: unknown = {}) => http().post(`/api/v1/crm/local/${path}`).set('Cookie', who.cookie).set('x-csrf-token', who.csrf).set('Origin', ORIGIN).send(body as object);
  const pendingSnapshot = async () => { const r = await reg(); return { status: r.status, deviceId: r.deviceId, key: r.devicePublicKey, requestId: r.pendingRequestId, codeHash: r.pendingCodeHash, maybeBound: r.activationMaybeBound, error: r.activationError }; };
  /** Everything a reset must never touch: local API credentials, source connection, jobs, templates, customers' data. */
  const dataSnapshot = async () => JSON.stringify({
    creds: await prisma.apiCredential.findMany({ orderBy: { clientId: 'asc' }, select: { clientId: true, secretHash: true, signingKeyEnc: true, status: true } }),
    source: await prisma.sourceConnection.findMany({ select: { id: true, apiBaseUrl: true, allowedBranchIds: true, sourceKind: true, active: true } }),
    jobs: await prisma.careJob.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true, phoneEnc: true } }),
    templates: await prisma.messageTemplate.count(), zalo: await prisma.zaloAccount.count(), users: await prisma.localUser.count(),
  });
  let recoveryDevice = '';

  it('recovery 1: lost answer ⇒ PENDING "retry the same code"; other code, staff, cancelled confirm and network errors change nothing; concurrent reset is refused; retry within 10 min finishes with the SAME binding', async () => {
    const staff = await loginAs('le.tan.platform', 'Le-tan-mat-khau-1');
    const c = code();
    platform.dropNextRedeemAnswer = true;
    const first = await post('platform/activate', { activationCode: c });
    expect(first.status).toBe(503); expect(first.body.code).toBe('PLATFORM_UNREACHABLE');
    let st = await status();
    expect(st).toMatchObject({ allowed: false, reason: 'PLATFORM_ACTIVATION_REQUIRED', device: { status: 'PENDING' }, activation: { state: 'RETRY_SAME_CODE', lastError: 'PLATFORM_UNREACHABLE' } });
    expect(st.license).toBeNull();
    const pending = await pendingSnapshot();
    expect(pending.maybeBound).toBe(true);
    expect(JSON.stringify(await reg())).not.toContain(c); // the code itself is never stored
    expect((await signedJob(job('REC-PENDING', CN1, 48))).body.message).toBe('PLATFORM_ACTIVATION_REQUIRED');
    // Another code while the first may be bound: refused locally, no Platform call, binding untouched.
    const calls = platform.redeemCalls;
    const other = await post('platform/activate', { activationCode: code() });
    expect(other.status).toBe(409); expect(other.body.code).toBe('ACTIVATION_RETRY_SAME_CODE');
    expect(platform.redeemCalls).toBe(calls);
    // Staff (no crm.users.manage) is refused at the API for both actions.
    expect((await postAs(staff, 'platform/activate', { activationCode: c })).status).toBe(403);
    expect((await postAs(staff, 'platform/unpair', { confirm: 'NGAT GHEP NOI' })).status).toBe(403);
    // Cancelled / wrong confirmation changes nothing.
    expect((await post('platform/unpair', { confirm: '' })).body.code).toBe('CONFIRM_REQUIRED');
    expect((await post('platform/unpair', {})).body.code).toBe('CONFIRM_REQUIRED');
    // Network error on the retry: still PENDING with the same binding; never reset, never "revoked".
    platform.down = true;
    const down = await post('platform/activate', { activationCode: c });
    platform.down = false;
    expect(down.status).toBe(503);
    expect({ ...(await pendingSnapshot()), error: undefined }).toEqual({ ...pending, error: undefined });
    expect(await prisma.auditLog.count({ where: { action: 'PLATFORM_DEVICE_REVOKED' } })).toBe(1); // only the earlier genuine revoke
    // Retry vs reset at the same time: the retry holds the lease, the reset is refused (no half state).
    platform.redeemDelayMs = 400;
    const [retry, reset] = await Promise.all([post('platform/activate', { activationCode: c }), new Promise((r) => setTimeout(r, 120)).then(() => post('platform/unpair', { confirm: 'NGAT GHEP NOI' }))]);
    platform.redeemDelayMs = 0;
    expect(retry.status).toBe(200); expect(reset.status).toBe(409); expect(reset.body.code).toBe('ACTIVATION_IN_PROGRESS');
    const done = await reg();
    expect(done).toMatchObject({ status: 'ACTIVE', deviceId: pending.deviceId, devicePublicKey: pending.key, activationMaybeBound: false, activationError: null, pendingRequestId: null });
    expect(new Set(platform.requestIdsByCode.get(c))).toEqual(new Set([pending.requestId]));
    expect([...platform.devices.keys()].filter((id) => id === pending.deviceId)).toHaveLength(1);
    st = await status();
    expect(st).toMatchObject({ mode: 'MANAGED', allowed: true, activation: null });
    recoveryDevice = done.deviceId;
  });

  it('branch namespace: PETCLINIC/B2B branch ids must be Platform UUIDs; an unmapped local id (812) is blocked with BRANCH_MAPPING_REQUIRED at creation, in the connector and in the preview', async () => {
    expect(await app.get(TenantAccessService).canCreateJobs(tenantId, { sourceProduct: 'PETCLINIC', branchId: '812' })).toEqual({ ok: false, code: 'BRANCH_MAPPING_REQUIRED' });
    expect(await app.get(TenantAccessService).canCreateJobs(tenantId, { sourceProduct: 'B2B_SALE', branchId: 'KHO-HCM' })).toEqual({ ok: false, code: 'BRANCH_MAPPING_REQUIRED' });
    expect(await app.get(TenantAccessService).canCreateJobs(tenantId, { sourceProduct: 'EXTERNAL', branchId: CN1 })).toEqual({ ok: false, code: 'SOURCE_NOT_LICENSED' });
    expect((await signedJob(job('NS-812', '812', 48))).body.message).toBe('BRANCH_MAPPING_REQUIRED');
    expect((await putConnector({ sourceKind: 'PETCLINIC', allowedBranchIds: [CN1, '812'] })).body.code).toBe('BRANCH_MAPPING_REQUIRED');
    platform.srcAppointments = [
      { id: 'NS-A', appointmentAt: new Date(Date.now() + 2 * 86400_000).toISOString(), status: 'SCHEDULED', revision: 'r1', branchId: '812', customer: { name: 'Khách NS', phone: '0901234567' }, pet: { name: 'Mướp' }, serviceName: 'Khám', consent: { status: 'DEFAULT_ALLOWED', channel: 'ZALO', purpose: 'APPOINTMENT_REMINDER' } },
    ];
    await prisma.sourceConnection.updateMany({ data: { allowedBranchIds: [CN1, '812'] } }); // as configured before activation
    const preview = await post('source-connector/appointments/preview');
    platform.srcAppointments = [];
    expect(preview.status).toBe(200);
    expect(preview.body.skippedByReason).toEqual({ BRANCH_MAPPING_REQUIRED: 1 });
    await prisma.sourceConnection.updateMany({ data: { allowedBranchIds: [CN1] } });
  });

  it('recovery 2: code expired on a possibly-bound attempt ⇒ no endless retry; Platform admin revokes the orphan; confirmed local reset reports the Platform result separately; data untouched; nothing sent until a NEW identity is activated', async () => {
    const send = jest.spyOn(app.get(ChannelRouterService), 'send');
    // Start from ACTIVE: a normal confirmed unpair (Platform reachable ⇒ Platform confirms it).
    const normal = await post('platform/unpair', { confirm: 'NGAT GHEP NOI' });
    expect(normal.body.reset).toEqual({ local: 'UNPAIRED', platform: 'PLATFORM_UNPAIRED' });
    expect(platform.devices.get(recoveryDevice)!.status).toBe('UNPAIRED');
    // New activation, answer lost ⇒ bound on Platform, PENDING here.
    const c2 = platform.adminCreateCode();
    platform.dropNextRedeemAnswer = true;
    expect((await post('platform/activate', { activationCode: c2 })).status).toBe(503);
    const pending = await pendingSnapshot();
    expect(pending.deviceId).not.toBe(recoveryDevice);
    expect(platform.devices.get(pending.deviceId!)!.status).toBe('ACTIVE'); // orphan on Platform
    // The 10-minute code expires (original creation time; retries never extend it).
    platform.codes.get(c2)!.expiresAt = Date.now() - 1;
    const expired = await post('platform/activate', { activationCode: c2 });
    expect(expired.status).toBe(403); expect(expired.body.code).toBe('ACTIVATION_CODE_EXPIRED');
    expect((await status()).activation).toEqual({ state: 'RECOVERY_REQUIRED', lastError: 'ACTIVATION_CODE_EXPIRED' });
    const calls = platform.redeemCalls;
    const again = await post('platform/activate', { activationCode: c2 });
    expect(again.status).toBe(409); expect(again.body.code).toBe('ACTIVATION_RECOVERY_REQUIRED');
    expect(platform.redeemCalls).toBe(calls); // no endless retries against Platform
    expect({ ...(await pendingSnapshot()), error: undefined }).toEqual({ ...pending, error: undefined });
    // Platform will not issue a new code while the orphan holds the primary-PC slot.
    expect(() => platform.adminCreateCode()).toThrow('PRIMARY_PC_EXISTS');
    const before = await dataSnapshot();
    // Step 1 (Platform admin): revoke the orphan device record.
    platform.devices.get(pending.deviceId!)!.status = 'REVOKED';
    // Step 2 (owner): confirmed local reset. A concurrent activation attempt is refused while the reset holds the lease.
    platform.unpairDelayMs = 400;
    const [reset, racing] = await Promise.all([post('platform/unpair', { confirm: 'NGAT GHEP NOI' }), new Promise((r) => setTimeout(r, 120)).then(() => post('platform/activate', { activationCode: c2 }))]);
    platform.unpairDelayMs = 0;
    expect(reset.status).toBe(200);
    expect(reset.body.reset).toEqual({ local: 'UNPAIRED', platform: 'PLATFORM_ALREADY_REVOKED' });
    expect(racing.status).toBe(409); expect(racing.body.code).toBe('ACTIVATION_IN_PROGRESS');
    expect(await reg()).toMatchObject({ status: 'UNPAIRED', deviceId: pending.deviceId, pendingRequestId: null, pendingCodeHash: null, activationLockedUntil: null, activationMaybeBound: false });
    expect(await dataSnapshot()).toBe(before); // customers, sources, history, templates, local API Client ID/Secret untouched
    expect(await status()).toMatchObject({ allowed: false, reason: 'PLATFORM_UNPAIRED', activation: null });
    // Not re-activated yet ⇒ no job creation, nothing sent.
    expect((await signedJob(job('REC-RESET', CN1, 48))).body.message).toBe('PLATFORM_UNPAIRED');
    await rawJob('REC-RESET-Q', { branchId: CN1, licenseSource: 'PETCLINIC' });
    expect(await runDue('REC-RESET-Q')).toEqual({ status: 'QUEUED', failureCode: 'PLATFORM_UNPAIRED' });
    expect(send).not.toHaveBeenCalled();
    // Step 3: new code ⇒ NEW deviceId/key; the old record stays REVOKED on Platform, never revived.
    const c3 = platform.adminCreateCode();
    const again3 = await post('platform/activate', { activationCode: c3 });
    expect(again3.status).toBe(200);
    const fresh = await reg();
    expect(fresh.status).toBe('ACTIVE');
    expect(fresh.deviceId).not.toBe(pending.deviceId); expect(fresh.devicePublicKey).not.toBe(pending.key);
    expect(platform.devices.get(pending.deviceId!)!.status).toBe('REVOKED');
    expect((await signedJob(job('REC-AFTER', CN1, 48))).status).toBe(201);
    send.mockRestore();
  });

  it('recovery 3: the PC never claims a Platform result it did not get — unreachable ⇒ PLATFORM_NOT_CONFIRMED; an attempt that never reached Platform ⇒ PLATFORM_DEVICE_UNKNOWN', async () => {
    const onPlatform = (await reg()).deviceId;
    platform.down = true;
    const r1 = await post('platform/unpair', { confirm: 'NGAT GHEP NOI' });
    platform.down = false;
    expect(r1.body.reset).toEqual({ local: 'UNPAIRED', platform: 'PLATFORM_NOT_CONFIRMED' });
    expect(platform.devices.get(onPlatform)!.status).toBe('ACTIVE'); // still held on Platform: admin must revoke it
    expect(() => platform.adminCreateCode()).toThrow('PRIMARY_PC_EXISTS');
    platform.devices.get(onPlatform)!.status = 'REVOKED'; // Platform admin
    // Attempt lost before reaching Platform ⇒ PENDING (maybe bound), reset ⇒ Platform has no such device.
    const c4 = platform.adminCreateCode();
    platform.down = true;
    expect((await post('platform/activate', { activationCode: c4 })).status).toBe(503);
    platform.down = false;
    expect((await status()).activation).toMatchObject({ state: 'RETRY_SAME_CODE' });
    const r2 = await post('platform/unpair', { confirm: 'NGAT GHEP NOI' });
    expect(r2.body.reset).toEqual({ local: 'UNPAIRED', platform: 'PLATFORM_DEVICE_UNKNOWN' });
    // The same (still valid) code now activates a new identity.
    expect((await post('platform/activate', { activationCode: c4 })).status).toBe(200);
    expect(await status()).toMatchObject({ allowed: true, activation: null });
  });
  // ---------------------------------------------------------------------------------------------------------------
  // Crash safety (logic). The row a killed process leaves behind is the one written by claim() BEFORE the redeem call;
  // these tests capture it mid-flight and put it back after the (lost) answer, i.e. exactly what a kill would leave.
  // The real process-kill test is scripts/qa/crm-pc-crash-recovery.cjs (child process + QA DB).
  // ---------------------------------------------------------------------------------------------------------------
  const regRow = () => prisma.platformDeviceRegistration.findUniqueOrThrow({ where: { id: 1 } });
  const expireLease = () => prisma.platformDeviceRegistration.update({ where: { id: 1 }, data: { activationLockedUntil: new Date(Date.now() - 1000) } });

  it('crash 1: the binding is durably marked "maybe bound" BEFORE the request leaves; a crash-left row (lease expired) refuses another code without calling Platform; the same code finishes with the same binding', async () => {
    expect((await post('platform/unpair', { confirm: 'NGAT GHEP NOI' })).status).toBe(200);
    const c = platform.adminCreateCode();
    platform.redeemPlan = [{ delay: 600, drop: true }];
    const inFlight = post('platform/activate', { activationCode: c }).then((r) => r); // supertest sends only once then() is called
    await new Promise((r) => setTimeout(r, 250));
    const mid = await regRow(); // what a kill at this instant leaves in the database
    expect(mid).toMatchObject({ status: 'PENDING', activationMaybeBound: true, activationError: null });
    expect(mid.pendingRequestId).toBeTruthy(); expect(mid.pendingCodeHash).toBeTruthy();
    expect(mid.activationLockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect((await inFlight).status).toBe(503);
    // Restore the exact crash state (the catch block never ran), then let the lease expire.
    await prisma.platformDeviceRegistration.update({ where: { id: 1 }, data: { activationError: mid.activationError, activationMaybeBound: mid.activationMaybeBound, activationLockedUntil: mid.activationLockedUntil } });
    await expireLease();
    expect((await status()).activation).toMatchObject({ state: 'RETRY_SAME_CODE' });
    const calls = platform.redeemCalls;
    const other = await post('platform/activate', { activationCode: code() });
    expect(other.status).toBe(409); expect(other.body.code).toBe('ACTIVATION_RETRY_SAME_CODE');
    expect(platform.redeemCalls).toBe(calls); // refused before any Platform call
    const after = await regRow();
    expect({ req: after.pendingRequestId, hash: after.pendingCodeHash, dev: after.deviceId, key: after.devicePublicKey }).toEqual({ req: mid.pendingRequestId, hash: mid.pendingCodeHash, dev: mid.deviceId, key: mid.devicePublicKey });
    const same = await post('platform/activate', { activationCode: c });
    expect(same.status).toBe(200);
    expect(await regRow()).toMatchObject({ status: 'ACTIVE', deviceId: mid.deviceId, devicePublicKey: mid.devicePublicKey });
    expect(new Set(platform.requestIdsByCode.get(c))).toEqual(new Set([mid.pendingRequestId]));
    expect([...platform.devices.keys()].filter((id) => id === mid.deviceId)).toHaveLength(1);
  });

  it('crash 2: a PENDING row left by an older build (flag false but an outstanding pendingRequestId) is still treated as maybe bound', async () => {
    expect((await post('platform/unpair', { confirm: 'NGAT GHEP NOI' })).status).toBe(200);
    const c = platform.adminCreateCode();
    platform.redeemPlan = [{ drop: true }];
    expect((await post('platform/activate', { activationCode: c })).status).toBe(503);
    await prisma.platformDeviceRegistration.update({ where: { id: 1 }, data: { activationMaybeBound: false, activationError: null } }); // pre-fix row shape
    await expireLease();
    expect((await status()).activation).toMatchObject({ state: 'RETRY_SAME_CODE' });
    const before = await regRow();
    const other = await post('platform/activate', { activationCode: code() });
    expect(other.body.code).toBe('ACTIVATION_RETRY_SAME_CODE');
    expect((await regRow()).pendingRequestId).toBe(before.pendingRequestId);
    expect((await post('platform/activate', { activationCode: c })).status).toBe(200);
    expect((await regRow()).deviceId).toBe(before.deviceId);
  });

  it('crash 3: a clear refusal proves "not bound" only for the FIRST send of a request; a refusal to a retry keeps the binding (e.g. PLAN_NOT_ACTIVE, ACTIVATION_CODE_EXPIRED)', async () => {
    expect((await post('platform/unpair', { confirm: 'NGAT GHEP NOI' })).status).toBe(200);
    // First send refused before binding ⇒ the pending request is released and another code may be used.
    const bad = await post('platform/activate', { activationCode: 'ZZZZ-ZZZZ-ZZZZ' });
    expect(bad.body.code).toBe('ACTIVATION_CODE_INVALID');
    expect(await regRow()).toMatchObject({ status: 'PENDING', activationMaybeBound: false, pendingRequestId: null, pendingCodeHash: null });
    expect((await status()).activation).toMatchObject({ state: 'NOT_BOUND' });
    // Next: answer lost (maybe bound) ⇒ a refusal to the retry proves nothing about the first send.
    const c = platform.adminCreateCode();
    platform.redeemPlan = [{ drop: true }, { error: { status: 403, code: 'PLAN_NOT_ACTIVE' } }];
    expect((await post('platform/activate', { activationCode: c })).status).toBe(503);
    const pending = await regRow();
    const retried = await post('platform/activate', { activationCode: c });
    expect(retried.body.code).toBe('PLAN_NOT_ACTIVE');
    expect(await regRow()).toMatchObject({ activationMaybeBound: true, pendingRequestId: pending.pendingRequestId, deviceId: pending.deviceId });
    expect((await post('platform/activate', { activationCode: code() })).body.code).toBe('ACTIVATION_RETRY_SAME_CODE');
    // Code expired while the outcome is unknown ⇒ binding kept, recovery required (no automatic release).
    platform.codes.get(c)!.expiresAt = Date.now() - 1;
    expect((await post('platform/activate', { activationCode: c })).body.code).toBe('ACTIVATION_CODE_EXPIRED');
    expect(await regRow()).toMatchObject({ activationMaybeBound: true, pendingRequestId: pending.pendingRequestId, deviceId: pending.deviceId });
    expect((await status()).activation).toMatchObject({ state: 'RECOVERY_REQUIRED' });
    // Recovery path, then a fresh activation (Platform admin revokes the orphan first).
    platform.devices.get(pending.deviceId)!.status = 'REVOKED';
    expect((await post('platform/unpair', { confirm: 'NGAT GHEP NOI' })).body.reset).toEqual({ local: 'UNPAIRED', platform: 'PLATFORM_ALREADY_REVOKED' });
    expect((await signedJob(job('CRASH-3', CN1, 48))).body.message).toBe('PLATFORM_UNPAIRED');
    expect((await post('platform/activate', { activationCode: platform.adminCreateCode() })).status).toBe(200);
    expect((await regRow()).deviceId).not.toBe(pending.deviceId);
  });

  it('crash 4: late answers never overwrite a newer state — a late success after a confirmed reset stays UNPAIRED; a late failure after a retry finished stays ACTIVE', async () => {
    expect((await post('platform/unpair', { confirm: 'NGAT GHEP NOI' })).status).toBe(200);
    // (a) Late SUCCESS after the lease expired and the owner reset the pairing.
    const c1 = platform.adminCreateCode();
    platform.redeemPlan = [{ delay: 1200 }];
    const slow = post('platform/activate', { activationCode: c1 }).then((r) => r);
    await new Promise((r) => setTimeout(r, 250));
    await expireLease();
    const reset = await post('platform/unpair', { confirm: 'NGAT GHEP NOI' });
    expect(reset.status).toBe(200);
    const late = await slow;
    expect(late.status).toBe(409); expect(late.body.code).toBe('ACTIVATION_IN_PROGRESS');
    expect(await regRow()).toMatchObject({ status: 'UNPAIRED', pendingRequestId: null, activationLockedUntil: null });
    expect((await signedJob(job('CRASH-4A', CN1, 48))).body.message).toBe('PLATFORM_UNPAIRED');
    // Platform bound the late request: the admin revokes that orphan before a new code (documented recovery).
    for (const d of platform.devices.values()) if (d.status === 'ACTIVE') d.status = 'REVOKED';
    // (b) Late FAILURE of an old attempt after a same-code retry (new lease) already activated the device.
    const c2 = platform.adminCreateCode();
    platform.redeemPlan = [{ delay: 1200, drop: true }, {}];
    const old = post('platform/activate', { activationCode: c2 }).then((r) => r);
    await new Promise((r) => setTimeout(r, 250));
    await expireLease();
    const retry = await post('platform/activate', { activationCode: c2 });
    expect(retry.status).toBe(200);
    expect((await old).status).toBe(503);
    expect(await regRow()).toMatchObject({ status: 'ACTIVE', activationLockedUntil: null, activationError: null, activationMaybeBound: false });
    expect((await signedJob(job('CRASH-4B', CN1, 48))).status).toBe(201);
  });
});
