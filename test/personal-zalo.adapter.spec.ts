import { createServer, Server } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { CryptoService } from '../src/common/crypto.service';
import { PersonalZaloAdapter } from '../src/channel/personal-zalo.adapter';
import { createHash } from 'node:crypto';

describe('PersonalZaloAdapter', () => {
  let server: Server; let baseUrl: string; const signingKey = randomBytes(32).toString('base64url'); const crypto = new CryptoService();
  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
    server = createServer((req, res) => {
      let raw = ''; req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
        const timestamp = String(req.headers['x-gateway-timestamp']); const nonce = String(req.headers['x-gateway-nonce']);
        const payload = `POST\n/internal/v1/messages/send-known-contact\n${timestamp}\n${nonce}\n${createHash('sha256').update(raw).digest('hex')}`;
        expect(req.headers['x-gateway-signature']).toBe(createHmac('sha256', signingKey).update(payload).digest('hex'));
        expect(JSON.parse(raw)).toEqual({ content: 'Xin chao Mit', externalReferenceId: 'appointment:1', phoneE164: '+84901234567' });
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"providerMessageId":"zalo-test-1"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  it('signs the exact canonical body sent to the internal sender', async () => {
    const prisma = { zaloAccount: { findUnique: jest.fn().mockResolvedValue({ channel: 'PERSONAL_ZALO', status: 'CONNECTED', senderBaseUrl: baseUrl, senderClientId: 'gateway-test', credentialEnc: crypto.encrypt(signingKey) }) } };
    const adapter = new PersonalZaloAdapter(prisma as any, crypto);
    await expect(adapter.send({ installationId: 'installation-1', externalReferenceId: 'appointment:1', recipientName: 'Khach', phoneE164: '+84901234567', templateCode: 'PC_APPT', content: 'Xin chao Mit' })).resolves.toEqual({ providerMessageId: 'zalo-test-1' });
  });
});
