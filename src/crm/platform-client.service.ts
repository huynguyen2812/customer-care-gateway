import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createPublicKey, KeyObject, verify as verifySignature } from 'node:crypto';
import { CRM_PRODUCT_CODE } from './crm.constants';

/** Consumer of the existing Platform contract (docs/integrations/platform-product-launcher-contract.md
 * and timekeeping-platform-provisioning-contract.md in the B2B/Platform repo). */
export type PlatformCredential = { clientId: string; clientSecret: string };
export type PlatformClaims = Record<string, unknown> & { sub: string; tenantId: string; productCode: string; jti: string; exp: number; iss: string; aud: string | string[] };
export type ExchangeResult = { claims: PlatformClaims; user: { id: string; fullName?: string; username?: string }; tenant: { id: string; name?: string } };
export type SessionCheckResult =
  | { kind: 'ACTIVE'; claims: PlatformClaims; expiresAt: Date; graceUntil: Date }
  | { kind: 'DENIED' }
  | { kind: 'UNAVAILABLE' };

export class PlatformDeniedError extends Error {
  constructor(readonly code: string) { super(code); }
}

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

@Injectable()
export class PlatformClientService {
  private jwks: { keys: Map<string, KeyObject>; fetchedAt: number } | null = null;

  private base(): string {
    const raw = (process.env.PLATFORM_API_BASE_URL || '').trim().replace(/\/$/, '');
    if (!raw) throw new ServiceUnavailableException('CRM_PLATFORM_NOT_CONFIGURED');
    this.assertTransport(raw);
    return raw;
  }

  private assertTransport(raw: string) {
    const url = new URL(raw);
    const localHttp = process.env.PLATFORM_ALLOW_HTTP_LOCAL === 'true' && process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) throw new ServiceUnavailableException('CRM_PLATFORM_INSECURE_URL');
  }

  issuer(): string { return process.env.PLATFORM_AUTH_ISSUER || 'vetclinic.vn-platform'; }

  private async post(path: string, credential: PlatformCredential, body: unknown): Promise<{ status: number; json: any }> {
    let res: Response;
    try {
      res = await fetch(`${this.base()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-installation-client-id': credential.clientId, 'x-installation-client-secret': credential.clientSecret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      return { status: 0, json: null };
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  /** POST /platform-auth/token-exchange — code is single-use; Platform re-checks full entitlement. */
  async exchange(credential: PlatformCredential, code: string): Promise<ExchangeResult> {
    const { status, json } = await this.post('/platform-auth/token-exchange', credential, { code });
    if (status === 0 || status >= 500) throw new ServiceUnavailableException('CRM_PLATFORM_UNAVAILABLE');
    if (status === 401) throw new PlatformDeniedError('CODE_INVALID');
    if (status === 403) throw new PlatformDeniedError('ACCESS_DENIED');
    if (status !== 200 && status !== 201) throw new PlatformDeniedError('EXCHANGE_FAILED');
    if (!json || typeof json.token !== 'string') throw new PlatformDeniedError('EXCHANGE_FAILED');
    const claims = await this.verifyJwt(json.token, CRM_PRODUCT_CODE).catch((error: unknown) => {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new PlatformDeniedError('ACCESS_DENIED');
    });
    return { claims, user: json.user || { id: claims.sub }, tenant: json.tenant || { id: claims.tenantId } };
  }

  /** POST /platform-auth/session-check — HTTP 200 DENIED is a decision; network/5xx is UNAVAILABLE;
   * 401/403 means the installation credential itself is rejected and must fail closed. */
  async sessionCheck(credential: PlatformCredential, platformUserId: string): Promise<SessionCheckResult> {
    const { status, json } = await this.post('/platform-auth/session-check', credential, { platformUserId });
    if (status === 0 || status >= 500) return { kind: 'UNAVAILABLE' };
    if (status !== 200 && status !== 201) return { kind: 'DENIED' };
    if (!json || json.decision !== 'ACTIVE' || json.active !== true || typeof json.snapshotToken !== 'string') return { kind: 'DENIED' };
    const claims = await this.verifyJwt(json.snapshotToken, CRM_PRODUCT_CODE).catch(() => null);
    if (!claims || claims.decision !== 'ACTIVE' || claims.sub !== platformUserId) return { kind: 'DENIED' };
    const graceUntil = typeof claims.graceUntil === 'number' ? new Date(claims.graceUntil * 1000) : new Date(claims.exp * 1000);
    return { kind: 'ACTIVE', claims, expiresAt: new Date(claims.exp * 1000), graceUntil };
  }

  private async key(kid: string): Promise<KeyObject> {
    const fresh = this.jwks && Date.now() - this.jwks.fetchedAt < 10 * 60_000;
    if (!fresh || !this.jwks!.keys.has(kid)) await this.loadJwks();
    const key = this.jwks?.keys.get(kid);
    if (!key) throw new UnauthorizedException('CRM_TOKEN_UNKNOWN_KEY');
    return key;
  }

  private async loadJwks() {
    const url = process.env.PLATFORM_JWKS_URL || `${this.base()}/platform-auth/.well-known/jwks.json`;
    this.assertTransport(url);
    let body: any;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(String(res.status));
      body = await res.json();
    } catch {
      throw new ServiceUnavailableException('CRM_PLATFORM_UNAVAILABLE');
    }
    const keys = new Map<string, KeyObject>();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
      try { keys.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' })); } catch { /* skip malformed */ }
    }
    this.jwks = { keys, fetchedAt: Date.now() };
  }

  /** RS256 only; checks kid, signature, iss, aud, exp/nbf and required claims. */
  async verifyJwt(token: string, audience: string): Promise<PlatformClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('CRM_TOKEN_INVALID');
    let header: Record<string, unknown>; let payload: Record<string, unknown>;
    try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); } catch { throw new UnauthorizedException('CRM_TOKEN_INVALID'); }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new UnauthorizedException('CRM_TOKEN_INVALID');
    const key = await this.key(header.kid);
    const ok = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new UnauthorizedException('CRM_TOKEN_INVALID');
    const now = Math.floor(Date.now() / 1000);
    const aud = payload.aud;
    const audOk = Array.isArray(aud) ? aud.includes(audience) : aud === audience;
    if (payload.iss !== this.issuer() || !audOk) throw new UnauthorizedException('CRM_TOKEN_INVALID');
    if (typeof payload.exp !== 'number' || payload.exp + 30 < now) throw new UnauthorizedException('CRM_TOKEN_EXPIRED');
    if (typeof payload.nbf === 'number' && payload.nbf - 30 > now) throw new UnauthorizedException('CRM_TOKEN_INVALID');
    if (typeof payload.sub !== 'string' || typeof payload.tenantId !== 'string' || payload.productCode !== audience || typeof payload.jti !== 'string') throw new UnauthorizedException('CRM_TOKEN_INVALID');
    return payload as PlatformClaims;
  }
}
