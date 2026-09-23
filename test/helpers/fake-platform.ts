import { generateKeyPairSync, randomBytes, randomUUID, sign as rsaSign, KeyObject, createHash, createHmac } from 'node:crypto';
import { AddressInfo } from 'node:net';
import * as nodeHttp from 'node:http';

/** Test-only fake of the Platform contract (token-exchange, session-check, JWKS). Never used in production. */
export class FakePlatform {
  server!: nodeHttp.Server; base = '';
  private key!: KeyObject; kid = `kid-${randomUUID().slice(0, 8)}`;
  credentials = new Map<string, { secret: string; tenantId: string }>();
  grants = new Map<string, { tenantId: string; userId: string; clientId: string; roles?: string[]; crmRoles?: string[]; used: boolean }>();
  constructor(readonly issuer: string) {}
  async start() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
    this.server = nodeHttp.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
        const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.url === '/api/platform-auth/.well-known/jwks.json') return send(200, { keys: [{ ...jwk, kid: this.kid, alg: 'RS256', use: 'sig' }] });
        const cred = this.credentials.get(String(req.headers['x-installation-client-id']));
        if (!cred || cred.secret !== req.headers['x-installation-client-secret']) return send(401, {});
        const body = raw ? JSON.parse(raw) : {};
        const now = Math.floor(Date.now() / 1000);
        if (req.url === '/api/platform-auth/token-exchange') {
          const g = this.grants.get(body.code);
          if (!g || g.used || g.clientId !== req.headers['x-installation-client-id']) return send(401, {});
          g.used = true;
          const claims: Record<string, unknown> = { iss: this.issuer, aud: 'CUSTOMER_CARE_CRM', sub: g.userId, tenantId: g.tenantId, productCode: 'CUSTOMER_CARE_CRM', entitlementStatus: 'ACTIVE', roles: g.roles || ['ADMIN'], iat: now, exp: now + 120, jti: randomUUID() };
          if (g.crmRoles) claims.crmRoles = g.crmRoles;
          return send(200, { token: this.jwt(claims), user: { id: g.userId, fullName: 'QA', username: 'qa' }, tenant: { id: g.tenantId } });
        }
        if (req.url === '/api/platform-auth/session-check') {
          const claims = { iss: this.issuer, aud: 'CUSTOMER_CARE_CRM', sub: body.platformUserId, tenantId: cred.tenantId, productCode: 'CUSTOMER_CARE_CRM', decision: 'ACTIVE', roles: ['TENANT_ADMIN'], iat: now, exp: now + 60, graceUntil: now + 360, jti: randomUUID() };
          return send(200, { active: true, decision: 'ACTIVE', snapshotToken: this.jwt(claims) });
        }
        send(404, {});
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
  grant(g: { tenantId: string; userId: string; clientId: string; roles?: string[]; crmRoles?: string[] }) { const code = randomBytes(24).toString('base64url'); this.grants.set(code, { ...g, used: false }); return code; }
  stop() { return new Promise((r) => this.server.close(r)); }
}

export function signedPlatformEvent(secret: string, body: Record<string, unknown>) {
  const eventId = randomUUID(); const timestamp = String(Date.now());
  const raw = JSON.stringify({ version: 1, eventId, ...body });
  const sig = createHmac('sha256', secret).update(`${timestamp}.${eventId}.${createHash('sha256').update(raw).digest('hex')}`).digest('hex');
  return { raw, headers: { 'content-type': 'application/json', 'x-platform-provisioning-id': eventId, 'x-platform-provisioning-timestamp': timestamp, 'x-platform-provisioning-signature': sig } };
}
