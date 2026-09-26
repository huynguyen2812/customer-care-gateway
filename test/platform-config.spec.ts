import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { generateDeviceKeys, loadConfigKeys, openDeviceKey, verifyConfig } from '../src/standalone/platform/platform-crypto';
import { platformBaseUrl } from '../src/standalone/platform/platform-device.client';
import { licenceWindow } from '../src/standalone/platform/license-gate.service';
import { MIN_ONLINE_LEASE_MS } from '../src/standalone/platform/platform-device.contract';
import { syncIntervalMs } from '../src/standalone/platform/platform-sync.runtime';

const kp = generateKeyPairSync('ed25519');
const keys = loadConfigKeys(JSON.stringify({ k1: kp.publicKey.export({ type: 'spki', format: 'pem' }) }));
const DEVICE = '11111111-2222-3333-4444-555555555555';
const payload = (o: Record<string, unknown> = {}) => ({
  v: 1, type: 'CRM_PC_CONFIG', productCode: 'CUSTOMER_CARE_CRM', revision: 3, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  deviceId: DEVICE, deviceStatus: 'ACTIVE', platformInstallationId: 'i1', tenant: { id: 't1', name: 'PK' }, plan: { code: 'P', status: 'ACTIVE', validFrom: null, validUntil: null },
  sources: [{ product: 'PETCLINIC', allowedBranchIds: ['CN1'], maxBranches: 1 }], features: { appointmentReminder: true, debtReminder: false }, limits: { dailyQuota: 30 },
  reminderLeadMinutes: 1440, quietHours: { start: '21:00', end: '08:00', timezone: 'Asia/Ho_Chi_Minh' }, offlineGraceHours: 72, ...o,
});
const signed = (p: unknown, key = kp.privateKey, keyId = 'k1') => { const b = Buffer.from(JSON.stringify(p)); return { payload: b.toString('base64url'), signature: sign(null, b, key).toString('base64'), keyId }; };

describe('Platform signed configuration verifier', () => {
  it('offlineGraceHours: integers 0..72 are kept exactly (0 stays 0); anything else rejects the whole config (no default, no clamp)', () => {
    for (const h of [0, 1, 24, 72]) expect(verifyConfig(signed(payload({ offlineGraceHours: h, expiresAt: new Date(Date.now() + Math.max(MIN_ONLINE_LEASE_MS, h * 3600_000)).toISOString() })), DEVICE, keys).payload.offlineGraceHours).toBe(h);
    const missing = payload(); delete (missing as Record<string, unknown>).offlineGraceHours;
    expect(() => verifyConfig(signed(missing), DEVICE, keys)).toThrow('CONFIG_MALFORMED');
    for (const bad of [null, '24', '0', -1, 73, 500, 1.5, true, {}, []]) expect(() => verifyConfig(signed(payload({ offlineGraceHours: bad })), DEVICE, keys)).toThrow('CONFIG_MALFORMED');
    // NaN/Infinity cannot be carried by JSON (they serialise to null) and are rejected as null above.
    expect(JSON.parse(JSON.stringify({ x: Number.NaN })).x).toBeNull();
  });
  it('rejects forged, foreign, stale-in-time, future and malformed documents', () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    expect(() => verifyConfig(signed(payload(), other), DEVICE, keys)).toThrow('CONFIG_SIGNATURE_INVALID');
    expect(() => verifyConfig(signed(payload(), kp.privateKey, 'unknown'), DEVICE, keys)).toThrow('CONFIG_KEY_UNKNOWN');
    const tampered = signed(payload()); tampered.payload = Buffer.from(JSON.stringify(payload({ limits: { dailyQuota: 9999 } }))).toString('base64url');
    expect(() => verifyConfig(tampered, DEVICE, keys)).toThrow('CONFIG_SIGNATURE_INVALID');
    expect(() => verifyConfig(signed(payload({ deviceId: 'x' })), DEVICE, keys)).toThrow('CONFIG_WRONG_DEVICE');
    expect(() => verifyConfig(signed(payload({ productCode: 'B2B_SALE' })), DEVICE, keys)).toThrow('CONFIG_WRONG_PRODUCT');
    expect(() => verifyConfig(signed(payload({ expiresAt: new Date(Date.now() - 1).toISOString() })), DEVICE, keys)).toThrow('CONFIG_EXPIRED');
    expect(() => verifyConfig(signed(payload({ issuedAt: new Date(Date.now() + 3600_000).toISOString() })), DEVICE, keys)).toThrow('CONFIG_FROM_FUTURE');
    expect(() => verifyConfig(signed(payload({ sources: [{ product: 'PETCLINIC', allowedBranchIds: ['bad branch'], maxBranches: 1 }] })), DEVICE, keys)).toThrow('CONFIG_MALFORMED');
    expect(() => verifyConfig(signed(payload({ quietHours: { start: '25:00', end: '08:00', timezone: 'x' } })), DEVICE, keys)).toThrow('CONFIG_MALFORMED');
  });
  it('only Ed25519 config keys are accepted', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
    expect(() => loadConfigKeys(JSON.stringify({ k: rsa }))).toThrow('PLATFORM_CONFIG_KEYS_INVALID');
  });
});

describe('device key is bound to this machine', () => {
  afterEach(() => { delete process.env.DEVICE_KEY_ENC_KEY; });
  it('opens with the machine key and fails elsewhere (restore on another PC must re-pair)', () => {
    process.env.DEVICE_KEY_ENC_KEY = randomBytes(32).toString('hex');
    const k = generateDeviceKeys();
    expect(openDeviceKey(k.privateKeyEnc)).toContain('PRIVATE KEY');
    expect(k.privateKeyEnc).not.toContain('PRIVATE KEY');
    process.env.DEVICE_KEY_ENC_KEY = randomBytes(32).toString('hex');
    expect(() => openDeviceKey(k.privateKeyEnc)).toThrow('DEVICE_KEY_UNAVAILABLE');
    delete process.env.DEVICE_KEY_ENC_KEY;
    expect(() => generateDeviceKeys()).toThrow('DEVICE_KEY_UNAVAILABLE');
  });
});

describe('Platform URL comes only from release configuration, HTTPS only', () => {
  afterEach(() => { delete process.env.PLATFORM_DEVICE_API_URL; delete process.env.PLATFORM_DEVICE_ALLOW_INSECURE_LOCAL; });
  it('rejects missing, plain http, credentials and query strings; loopback http only with the dev flag', () => {
    expect(() => platformBaseUrl()).toThrow('PLATFORM_NOT_CONFIGURED');
    process.env.PLATFORM_DEVICE_API_URL = 'http://admin.vetclinic.vn/api'; expect(() => platformBaseUrl()).toThrow('PLATFORM_URL_INSECURE');
    process.env.PLATFORM_DEVICE_API_URL = 'https://u:p@admin.vetclinic.vn/api'; expect(() => platformBaseUrl()).toThrow('PLATFORM_URL_INSECURE');
    process.env.PLATFORM_DEVICE_API_URL = 'http://127.0.0.1:9/api'; expect(() => platformBaseUrl()).toThrow('PLATFORM_URL_INSECURE');
    process.env.PLATFORM_DEVICE_ALLOW_INSECURE_LOCAL = '1'; expect(platformBaseUrl().host).toBe('127.0.0.1:9');
    process.env.PLATFORM_DEVICE_API_URL = 'https://admin.vetclinic.vn/api/crm-pc/v1'; expect(platformBaseUrl().protocol).toBe('https:');
  });
});

describe('shared lease contract (expiresAt = min(issuedAt + max(5 min, grace h), plan ends))', () => {
  const t = Date.now(); const iso = (ms: number) => new Date(ms).toISOString();
  const doc = (grace: number, leaseMs: number, o: Record<string, unknown> = {}) => signed(payload({ offlineGraceHours: grace, issuedAt: iso(t), expiresAt: iso(t + leaseMs), ...o }));
  it('accepts a lease up to the formula, refuses a longer one (never trimmed) and a non-positive one', () => {
    expect(verifyConfig(doc(0, 5 * 60_000), DEVICE, keys).expiresAt.getTime()).toBe(t + 5 * 60_000);
    expect(verifyConfig(doc(0, 90_000), DEVICE, keys).expiresAt.getTime()).toBe(t + 90_000); // plan ends in 90 s
    expect(verifyConfig(doc(72, 72 * 3600_000), DEVICE, keys).expiresAt.getTime()).toBe(t + 72 * 3600_000);
    expect(() => verifyConfig(doc(0, 5 * 60_000 + 60_000), DEVICE, keys)).toThrow('CONFIG_LEASE_INVALID');
    expect(() => verifyConfig(doc(72, 73 * 3600_000), DEVICE, keys)).toThrow('CONFIG_LEASE_INVALID'); // no extra 60 min
    expect(() => verifyConfig(doc(1, 0, { issuedAt: iso(t + 1000), expiresAt: iso(t + 1000) }), DEVICE, keys)).toThrow('CONFIG_LEASE_INVALID');
  });
  it('a denial config (plan EXPIRED/SUSPENDED, plan.validUntil in the past, envelope still valid) is accepted', () => {
    for (const status of ['EXPIRED', 'SUSPENDED']) {
      const v = verifyConfig(doc(72, 72 * 3600_000, { plan: { code: 'P', status, validFrom: null, validUntil: iso(t - 3600_000) } }), DEVICE, keys);
      expect(v.payload.plan.status).toBe(status);
    }
  });
});

describe('licence window = min(signed expiresAt, signed plan.validUntil); nothing added by the PC', () => {
  const t0 = new Date('2026-09-26T00:00:00.000Z').getTime(); const H = 3600_000;
  const row = (expiresAt: number, validUntil: string | null = null, grace = 72) => ({ payload: payload({ issuedAt: new Date(t0).toISOString(), offlineGraceHours: grace, plan: { code: 'P', status: 'ACTIVE', validFrom: null, validUntil } }), expiresAt: new Date(expiresAt) });
  it('grace 0 at t0 ⇒ t0 + 5 min; grace 72 ⇒ t0 + 72 h exactly (no extra 60 min)', () => {
    expect(licenceWindow(row(t0 + 5 * 60_000, null, 0)).until.getTime()).toBe(t0 + 5 * 60_000);
    expect(licenceWindow(row(t0 + 72 * H)).until.getTime()).toBe(t0 + 72 * H);
  });
  it('plan end earlier than the envelope wins; an unparsable plan end fails closed', () => {
    expect(licenceWindow(row(t0 + 5 * 60_000, new Date(t0 + 90_000).toISOString(), 0)).until.getTime()).toBe(t0 + 90_000);
    expect(licenceWindow(row(t0 + 72 * H, 'not-a-date')).until.getTime()).toBe(0);
  });
});

describe('sync schedule', () => {
  it('defaults to 60 s and never exceeds 2 min (never below 15 s)', () => {
    expect(syncIntervalMs(undefined)).toBe(60_000);
    expect(syncIntervalMs('900')).toBe(120_000);
    expect(syncIntervalMs('5')).toBe(15_000);
    expect(syncIntervalMs('abc')).toBe(60_000);
    expect(syncIntervalMs('90')).toBe(90_000);
  });
});
