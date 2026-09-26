import { hashLocalPassword, passwordPolicyError, verifyLocalPassword } from '../src/standalone/local-password';
import { appointmentConsentAllowed, assertConnectorBaseUrl, normalizeSourceAppointment, receivableConsentAllowed } from '../src/standalone/source-connector.client';
import { maxLatenessMs } from '../src/standalone/deployment-mode';

describe('standalone: local password hashing', () => {
  it('hashes with a per-hash salt and verifies only the right password', async () => {
    const a = await hashLocalPassword('Mat-khau-rat-dai-1'); const b = await hashLocalPassword('Mat-khau-rat-dai-1');
    expect(a).toMatch(/^scrypt2\$32768\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await verifyLocalPassword('Mat-khau-rat-dai-1', a)).toBe(true);
    expect(await verifyLocalPassword('Mat-khau-rat-dai-2', a)).toBe(false);
    expect(await verifyLocalPassword('x', 'scrypt$legacy$abc')).toBe(false);
    expect(await verifyLocalPassword('x', 'scrypt2$1024$8$1$c2FsdA==$aGFzaA==')).toBe(false); // too-weak parameters refused
  });
  it('enforces the password policy', () => {
    expect(passwordPolicyError('short')).toBe('PASSWORD_LENGTH');
    expect(passwordPolicyError('12345678901')).toBe('PASSWORD_TOO_SIMPLE');
    expect(passwordPolicyError('abc-letan-123', 'letan')).toBe('PASSWORD_CONTAINS_USERNAME');
    expect(passwordPolicyError('Mat-khau-rat-dai-1', 'chu')).toBeNull();
  });
});

describe('standalone: consent policy (commit 5581357)', () => {
  const c = (status: string, channel = '', purpose = '') => ({ status, channel, purpose });
  it('appointment reminders over Zalo accept GRANTED and DEFAULT_ALLOWED only', () => {
    expect(appointmentConsentAllowed(c('DEFAULT_ALLOWED', 'ZALO', 'APPOINTMENT_REMINDER'))).toBe(true);
    expect(appointmentConsentAllowed(c('GRANTED'))).toBe(true);
    for (const s of ['REVOKED', 'WITHDRAWN', 'OPTED_OUT', 'UNKNOWN', '']) expect(appointmentConsentAllowed(c(s, 'ZALO', 'APPOINTMENT_REMINDER'))).toBe(false);
    expect(appointmentConsentAllowed(c('DEFAULT_ALLOWED', 'SMS', 'APPOINTMENT_REMINDER'))).toBe(false);
    expect(appointmentConsentAllowed(c('DEFAULT_ALLOWED', 'ZALO', 'MARKETING'))).toBe(false);
    expect(appointmentConsentAllowed(null)).toBe(false);
  });
  it('debt reminders never use the default', () => {
    expect(receivableConsentAllowed(c('GRANTED', 'ZALO', 'DEBT_REMINDER'))).toBe(true);
    expect(receivableConsentAllowed(c('DEFAULT_ALLOWED', 'ZALO', 'DEBT_REMINDER'))).toBe(false);
    expect(receivableConsentAllowed(c('GRANTED', 'ZALO', 'MARKETING'))).toBe(false);
  });
  it('normalizes source rows and drops malformed ones', () => {
    expect(normalizeSourceAppointment({ id: 'A 1', appointmentAt: new Date().toISOString() })).toBeNull();
    expect(normalizeSourceAppointment({ id: 'A1', appointmentAt: 'not a date' })).toBeNull();
    expect(normalizeSourceAppointment({ id: 'A1', appointmentAt: '2026-10-01T02:00:00Z', status: 'scheduled', consent: { status: 'default_allowed' } })?.consent?.status).toBe('DEFAULT_ALLOWED');
  });
});

describe('standalone: connector URL and lateness rules', () => {
  afterEach(() => { delete process.env.STANDALONE_ALLOW_HTTP_LAN_SOURCES; delete process.env.CARE_JOB_MAX_LATENESS_HOURS; });
  it('accepts HTTPS and loopback; LAN http only when explicitly allowed', () => {
    expect(() => assertConnectorBaseUrl('https://pk.example/api')).not.toThrow();
    expect(() => assertConnectorBaseUrl('http://127.0.0.1:9000/api')).not.toThrow();
    expect(() => assertConnectorBaseUrl('http://192.168.1.20/api')).toThrow('SOURCE_URL_INSECURE');
    process.env.STANDALONE_ALLOW_HTTP_LAN_SOURCES = 'true';
    expect(() => assertConnectorBaseUrl('http://192.168.1.20/api')).not.toThrow();
    expect(() => assertConnectorBaseUrl('http://8.8.8.8/api')).toThrow('SOURCE_URL_INSECURE');
    expect(() => assertConnectorBaseUrl('https://u:p@pk.example/api')).toThrow('SOURCE_URL_INVALID');
  });
  it('standalone defaults to 12 hours; the VPS edition keeps no limit unless configured', () => {
    expect(maxLatenessMs('standalone')).toBe(12 * 3600_000);
    expect(maxLatenessMs('platform')).toBeNull();
    process.env.CARE_JOB_MAX_LATENESS_HOURS = '6';
    expect(maxLatenessMs('platform')).toBe(6 * 3600_000);
    process.env.CARE_JOB_MAX_LATENESS_HOURS = '0';
    expect(maxLatenessMs('standalone')).toBeNull();
  });
});
