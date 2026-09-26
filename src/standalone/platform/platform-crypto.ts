import { createCipheriv, createDecipheriv, createHash, createPublicKey, generateKeyPairSync, KeyObject, randomBytes, sign, verify } from 'node:crypto';
import { CONFIG_TYPE, DesiredConfigPayload, LICENSED_SOURCES, MAX_CLOCK_SKEW_MS, MAX_OFFLINE_GRACE_HOURS, MIN_ONLINE_LEASE_MS, PRODUCT_CODE, SignedConfig } from './platform-device.contract';

/**
 * Machine-only key for the device private key (DEVICE_KEY_ENC_KEY, 32 bytes hex, from the DPAPI secret store).
 * It is NOT part of the backup key bundle: after a restore on another PC the device key cannot be opened and the
 * PC must be paired again (a copied backup never clones a licensed device).
 */
function machineKey(): Buffer {
  const k = Buffer.from(process.env.DEVICE_KEY_ENC_KEY || '', 'hex');
  if (k.length !== 32) throw new Error('DEVICE_KEY_UNAVAILABLE');
  return k;
}

export function generateDeviceKeys(): { publicKeyPem: string; privateKeyEnc: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', machineKey(), iv);
  c.setAAD(Buffer.from('vccrm-device-key-v1'));
  const ct = Buffer.concat([c.update(pem, 'utf8'), c.final()]);
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string, privateKeyEnc: `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}` };
}

/** Throws DEVICE_KEY_UNAVAILABLE when this machine cannot open the key (restored elsewhere / secret missing). */
export function openDeviceKey(enc: string): string {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('DEVICE_KEY_UNAVAILABLE');
  try {
    const d = createDecipheriv('aes-256-gcm', machineKey(), Buffer.from(iv, 'base64'));
    d.setAAD(Buffer.from('vccrm-device-key-v1'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch { throw new Error('DEVICE_KEY_UNAVAILABLE'); }
}

export function signWithDevice(privateKeyPem: string, data: string): string {
  return sign(null, Buffer.from(data, 'utf8'), privateKeyPem).toString('base64');
}

export const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Platform config-signing public keys shipped with the release (keyId → key). Never taken from the network/browser. */
export function loadConfigKeys(raw = process.env.PLATFORM_CONFIG_PUBLIC_KEYS || ''): Map<string, KeyObject> {
  const out = new Map<string, KeyObject>();
  if (!raw.trim()) return out;
  let parsed: Record<string, string>;
  try { parsed = JSON.parse(raw); } catch { throw new Error('PLATFORM_CONFIG_KEYS_INVALID'); }
  for (const [keyId, pem] of Object.entries(parsed)) {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('PLATFORM_CONFIG_KEYS_INVALID');
    out.set(keyId, key);
  }
  return out;
}

export function isValidOfflineGraceHours(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_OFFLINE_GRACE_HOURS;
}

export type VerifiedConfig ={ payload: DesiredConfigPayload; payloadHash: string; signed: SignedConfig; expiresAt: Date };

const ISO = (v: unknown) => typeof v === 'string' && !Number.isNaN(new Date(v).getTime());
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const BRANCH = /^[A-Za-z0-9._:-]{1,80}$/;

/**
 * Verifies a signed desired configuration for THIS device. Rejects: unknown key, bad signature, other device/product,
 * malformed fields, issued in the future, already expired. Revision ordering is checked by the caller against the DB.
 */
export function verifyConfig(signed: SignedConfig, deviceId: string, keys: Map<string, KeyObject>, now = new Date()): VerifiedConfig {
  const key = keys.get(String(signed?.keyId || ''));
  if (!key) throw new Error('CONFIG_KEY_UNKNOWN');
  let bytes: Buffer;
  try { bytes = Buffer.from(String(signed.payload), 'base64url'); } catch { throw new Error('CONFIG_MALFORMED'); }
  let ok = false;
  try { ok = verify(null, bytes, key, Buffer.from(String(signed.signature), 'base64')); } catch { ok = false; }
  if (!ok) throw new Error('CONFIG_SIGNATURE_INVALID');
  let p: DesiredConfigPayload;
  try { p = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('CONFIG_MALFORMED'); }
  if (p?.v !== 1 || p.type !== CONFIG_TYPE || p.productCode !== PRODUCT_CODE) throw new Error('CONFIG_WRONG_PRODUCT');
  if (p.deviceId !== deviceId) throw new Error('CONFIG_WRONG_DEVICE');
  if (!Number.isInteger(p.revision) || p.revision < 1) throw new Error('CONFIG_MALFORMED');
  if (!ISO(p.issuedAt) || !ISO(p.expiresAt)) throw new Error('CONFIG_MALFORMED');
  if (new Date(p.issuedAt).getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) throw new Error('CONFIG_FROM_FUTURE');
  const expiresAt = new Date(p.expiresAt);
  if (expiresAt <= now) throw new Error('CONFIG_EXPIRED');
  if (!['ACTIVE', 'REVOKED'].includes(p.deviceStatus) || !['ACTIVE', 'TRIAL', 'SUSPENDED', 'EXPIRED', 'TERMINATED'].includes(p.plan?.status)) throw new Error('CONFIG_MALFORMED');
  if (!p.tenant?.id || typeof p.tenant.name !== 'string' || !p.platformInstallationId) throw new Error('CONFIG_MALFORMED');
  if (!Array.isArray(p.sources) || p.sources.some((s) => !(LICENSED_SOURCES as readonly string[]).includes(s?.product) || !Array.isArray(s.allowedBranchIds) || s.allowedBranchIds.some((b) => !BRANCH.test(b))
    || !(s.maxBranches === null || s.maxBranches === undefined || (Number.isInteger(s.maxBranches) && s.maxBranches >= 0)))) throw new Error('CONFIG_MALFORMED');
  // One entry per source product: branch scope is never merged across sources.
  if (new Set(p.sources.map((s) => s.product)).size !== p.sources.length) throw new Error('CONFIG_MALFORMED');
  if (!(Number.isInteger(p.limits?.dailyQuota) && p.limits.dailyQuota >= 0 && p.limits.dailyQuota <= 10000)) throw new Error('CONFIG_MALFORMED');
  if (!HHMM.test(p.quietHours?.start || '') || !HHMM.test(p.quietHours?.end || '')) throw new Error('CONFIG_MALFORMED');
  if (!(Number.isInteger(p.reminderLeadMinutes) && p.reminderLeadMinutes >= 15 && p.reminderLeadMinutes <= 10080)) throw new Error('CONFIG_MALFORMED');
  if (typeof p.features?.appointmentReminder !== 'boolean' || typeof p.features?.debtReminder !== 'boolean') throw new Error('CONFIG_MALFORMED');
  // Required field: an integer number of hours in [0, 72]. 0 is kept as 0. Missing/null/string/NaN/negative/fraction/
  // over 72 ⇒ the whole config is rejected (never defaulted, never clamped upwards).
  if (!isValidOfflineGraceHours(p.offlineGraceHours)) throw new Error('CONFIG_MALFORMED');
  // Lease bound of the shared contract: expiresAt <= issuedAt + max(5 min, offlineGraceHours h) (1 s tolerance for
  // rounding). A longer lease than Platform may sign is refused, never trimmed. A denial config (plan SUSPENDED/EXPIRED,
  // plan.validUntil possibly in the past) is still accepted as long as its own envelope is valid.
  const leaseMs = expiresAt.getTime() - new Date(p.issuedAt).getTime();
  if (!(leaseMs > 0) || leaseMs > Math.max(MIN_ONLINE_LEASE_MS, p.offlineGraceHours * 3600_000) + 1000) throw new Error('CONFIG_LEASE_INVALID');
  if (p.plan.validUntil !== null && p.plan.validUntil !== undefined && !ISO(p.plan.validUntil)) throw new Error('CONFIG_MALFORMED');
  return { payload: p, payloadHash: sha256Hex(bytes), signed, expiresAt };
}
