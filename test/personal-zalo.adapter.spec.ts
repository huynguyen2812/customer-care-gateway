import { createServer, Server } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { CryptoService } from '../src/common/crypto.service';
import { PersonalZaloAdapter } from '../src/channel/personal-zalo.adapter';

/** Legacy v1 sender (current production sender) and v2 contract classification. */
describe('PersonalZaloAdapter', () => {
  let server: Server; let baseUrl: string; const signingKey = randomBytes(32).toString('base64url'); const crypto = new CryptoService();
  let reply: { status: number; body: unknown; delayMs?: number } = { status: 200, body: { providerMessageId: 'zalo-test-1' } };
  let lastBody: Record<string, unknown> = {};
  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
    process.env.SENDER_TIMEOUT_MS = '300';
    server = createServer((req, res) => {
      let raw = ''; req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
        const timestamp = String(req.headers['x-gateway-timestamp']); const nonce = String(req.headers['x-gateway-nonce']);
        const payload = `POST\n/internal/v1/messages/send-known-contact\n${timestamp}\n${nonce}\n${createHash('sha256').update(raw).digest('hex')}`;
        expect(req.headers['x-gateway-signature']).toBe(createHmac('sha256', signingKey).update(payload).digest('hex'));
        lastBody = JSON.parse(raw);
        setTimeout(() => { res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply.body)); }, reply.delayMs || 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  const account = (caps: Record<string, unknown> = {}, url = () => baseUrl) => ({ id: randomUUID(), tenantId: randomUUID(), channel: 'PERSONAL_ZALO', status: 'CONNECTED', senderBaseUrl: url(), senderClientId: 'gateway-test', credentialEnc: crypto.encrypt(signingKey), capabilities: caps }) as any;
  const input = (a: { id: string }) => ({ installationId: 'installation-1', channelAccountId: a.id, deliveryAttemptId: randomUUID(), externalReferenceId: 'appointment:1', recipientName: 'Khach', phoneE164: '+84901234567', templateCode: 'PC_APPT', content: 'Xin chao Mit' });

  it('signs the exact canonical body and sends the deliveryAttemptId as idempotency key', async () => {
    reply = { status: 200, body: { providerMessageId: 'zalo-test-1' } };
    const a = account(); const i = input(a);
    await expect(new PersonalZaloAdapter(crypto).send(a, i)).resolves.toEqual({ kind: 'SENT', providerMessageId: 'zalo-test-1' });
    expect(lastBody).toEqual({ content: 'Xin chao Mit', externalReferenceId: 'appointment:1', phoneE164: '+84901234567', deliveryAttemptId: i.deliveryAttemptId, idempotencyKey: i.deliveryAttemptId, channelAccountId: a.id });
  });
  it('legacy: only provably pre-send rejections are NOT_SENT; ambiguous codes are UNKNOWN', async () => {
    const adapter = new PersonalZaloAdapter(crypto); const a = account();
    const cases: [number, unknown, string][] = [
      [400, {}, 'NOT_SENT'], [401, {}, 'NOT_SENT'], [404, { code: 'RECIPIENT_NOT_FOUND' }, 'NOT_SENT'],
      [423, { code: 'ACCOUNT_RESTRICTED' }, 'UNKNOWN'], [429, { code: 'RATE_LIMITED' }, 'UNKNOWN'], [502, { code: 'SEND_FAILED' }, 'UNKNOWN'], [200, {}, 'UNKNOWN'],
    ];
    for (const [status, body, kind] of cases) { reply = { status, body }; expect((await adapter.send(a, input(a))).kind).toBe(kind); }
  });
  it('timeout is UNKNOWN (never a certain failure); refused connection is certain NOT_SENT', async () => {
    reply = { status: 200, body: { providerMessageId: 'late' }, delayMs: 800 };
    const adapter = new PersonalZaloAdapter(crypto);
    const a = account();
    expect(await adapter.send(a, input(a))).toEqual({ kind: 'UNKNOWN', code: 'SENDER_TIMEOUT' });
    const probe = createServer(); await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port; await new Promise<void>((r) => probe.close(() => r()));
    const dead = account({}, () => `http://127.0.0.1:${port}`); // nothing listens there any more
    expect(await adapter.send(dead, input(dead))).toMatchObject({ kind: 'NOT_SENT', code: 'SENDER_UNREACHABLE' });
  });
  it('v2 contract: explicit delivery field is trusted only when the account declares contractVersion 2', async () => {
    const adapter = new PersonalZaloAdapter(crypto);
    reply = { status: 423, body: { delivery: 'NOT_SENT', code: 'RELOGIN_REQUIRED' } };
    const v2 = account({ contractVersion: 2 }); const v1 = account();
    expect(await adapter.send(v2, input(v2))).toEqual({ kind: 'NOT_SENT', code: 'RELOGIN_REQUIRED', accountStatus: 'RELOGIN_REQUIRED' });
    expect((await adapter.send(v1, input(v1))).kind).toBe('UNKNOWN');
    reply = { status: 502, body: { delivery: 'UNKNOWN', code: 'ZALO_TIMEOUT' } };
    expect((await adapter.send(v2, input(v2))).kind).toBe('UNKNOWN');
  });
  it('QR login, preflight and remote control are refused without the sender capability (no fake QR)', async () => {
    const adapter = new PersonalZaloAdapter(crypto); const a = account();
    await expect(adapter.loginStart(a)).rejects.toThrow('SENDER_QR_NOT_SUPPORTED');
    expect(await adapter.recipientEligibility(a, '+84901234567')).toBe('UNKNOWN');
    expect(await adapter.control(a, 'disconnect')).toBe(false);
  });
});
