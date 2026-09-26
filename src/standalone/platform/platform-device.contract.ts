/**
 * PROPOSED contract between VETCLINIC CRM PC (device agent) and Platform Admin (control plane).
 * Platform has not delivered its side yet: see docs/standalone/platform-device-contract-v1.md. Everything the PC
 * trusts comes from a document signed by the Platform config key; transport is HTTPS only (PC → Platform).
 */

export const DEVICE_SIGNATURE_PREFIX = 'VCPDA1';
export const CONFIG_TYPE = 'CRM_PC_CONFIG';
export const PRODUCT_CODE = 'CUSTOMER_CARE_CRM';
export const MAX_OFFLINE_GRACE_HOURS = 72;
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
/**
 * Lease (shared contract with Platform, 2026-09-26): Platform signs
 *   expiresAt = min(issuedAt + max(5 min, offlineGraceHours h), CRM plan end, source plan end)
 * and renews with a NEW revision once now >= expiresAt - min(24 h, (expiresAt - issuedAt) / 3) of the stored envelope.
 * The PC enforces the signed expiresAt and plan.validUntil as they are (no extra time of its own), rejects a document
 * whose lease is longer than the formula allows, and syncs at most every PLATFORM_SYNC_MAX_INTERVAL_MS.
 */
export const MIN_ONLINE_LEASE_MS = 5 * 60_000;
export const PLATFORM_SYNC_MAX_INTERVAL_MS = 2 * 60_000;

export type PlanStatus = 'ACTIVE' | 'TRIAL' | 'SUSPENDED' | 'EXPIRED' | 'TERMINATED';
export type DeviceStatus = 'ACTIVE' | 'REVOKED';
/** Platform source entries. Each one carries its own branch list; the PC never merges them. */
export const LICENSED_SOURCES = ['PETCLINIC', 'B2B_SALE', 'EXTERNAL'] as const;
export type LicensedSource = (typeof LICENSED_SOURCES)[number];

/** Payload of a signed desired configuration. No secrets, no customer data. */
export interface DesiredConfigPayload {
  v: 1;
  type: typeof CONFIG_TYPE;
  productCode: typeof PRODUCT_CODE;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  deviceId: string;
  deviceStatus: DeviceStatus;
  platformInstallationId: string;
  tenant: { id: string; name: string };
  plan: { code: string; status: PlanStatus; validFrom: string | null; validUntil: string | null };
  /** At most one entry per product. */
  sources: { product: LicensedSource; allowedBranchIds: string[]; maxBranches: number | null }[];
  features: { appointmentReminder: boolean; debtReminder: boolean };
  limits: { dailyQuota: number };
  reminderLeadMinutes: number;
  quietHours: { start: string; end: string; timezone: string };
  /** REQUIRED integer 0..72. Only feeds Platform's expiresAt formula; the PC adds no time of its own. Invalid ⇒ config rejected. */
  offlineGraceHours: number;
}

/** Wire form: payload is base64url(JSON bytes) so the signature covers the exact bytes. */
export interface SignedConfig { payload: string; signature: string; keyId: string }

export interface RedeemRequest {
  activationCode: string;
  requestId: string;         // idempotency: a retry after a lost answer re-sends the same requestId/deviceId/key
  deviceId: string;
  devicePublicKey: string;   // SPKI PEM, Ed25519
  appVersion: string;
  proof: string;             // Ed25519(deviceKey, canonical redeem string) — proves possession of the private key
}
export interface RedeemResponse { deviceId: string; platformInstallationId: string; config: SignedConfig }

/** Only aggregate, redacted health. Built by buildHeartbeat(); unit-tested to contain no PII/secret. */
export interface Heartbeat {
  deviceId: string;
  appVersion: string;
  buildCommit: string | null;
  services: { api: 'UP' | 'DOWN'; worker: 'UP' | 'DOWN' | 'UNKNOWN'; sender: 'UP' | 'DOWN' | 'UNKNOWN'; source: 'OK' | 'FAILED' | 'NOT_CONFIGURED' | 'DRY_RUN' | 'UNKNOWN' };
  lastSourceSyncAt: string | null;
  queue: { queued: number; processing: number; sent24h: number; failed24h: number; deliveryUncertain: number };
  errorCodes: string[];
}
export interface SyncRequest { currentRevision: number; heartbeat: Heartbeat }
export interface SyncResponse { deviceStatus: DeviceStatus; config?: SignedConfig }

export class PlatformError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(code); }
}

export function redeemCanonical(r: Omit<RedeemRequest, 'proof'>): string {
  return [DEVICE_SIGNATURE_PREFIX, 'REDEEM', r.requestId, r.deviceId, r.activationCode, r.devicePublicKey.trim()].join('\n');
}
export function requestCanonical(method: string, path: string, timestamp: string, nonce: string, bodySha256: string): string {
  return [DEVICE_SIGNATURE_PREFIX, method.toUpperCase(), path, timestamp, nonce, bodySha256].join('\n');
}

/** The only Platform operations the PC performs. HttpPlatformDeviceClient is the real one; tests use a fake server. */
export interface PlatformDeviceApi {
  redeem(req: RedeemRequest): Promise<RedeemResponse>;
  sync(deviceId: string, privateKeyPem: string, req: SyncRequest): Promise<SyncResponse>;
  unpair(deviceId: string, privateKeyPem: string): Promise<void>;
}
export const PLATFORM_DEVICE_API = 'PLATFORM_DEVICE_API';
