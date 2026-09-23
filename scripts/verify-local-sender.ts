import { createHash, createHmac, randomUUID } from 'node:crypto';
import { canonicalJson } from '../src/common/canonical';

const endpoint = 'http://127.0.0.1:3000/internal/v1/messages/send-known-contact';
const clientId = 'customer-care-gateway-local';
const signingKey = String(process.env.LOCAL_SENDER_SIGNING_KEY || '');
const body = canonicalJson({ content: 'DRY RUN - KHONG GUI', externalReferenceId: 'dry-run:no-send', phoneE164: '+84900000001' });

function headers(timestamp: string, nonce: string, signature?: string) {
  const canonical = `POST\n/internal/v1/messages/send-known-contact\n${timestamp}\n${nonce}\n${createHash('sha256').update(body).digest('hex')}`;
  return { 'content-type': 'application/json', 'x-gateway-client-id': clientId, 'x-gateway-timestamp': timestamp, 'x-gateway-nonce': nonce, 'x-gateway-signature': signature ?? createHmac('sha256', signingKey).update(canonical).digest('hex') };
}

async function main() {
  if (signingKey.length < 32) throw new Error('LOCAL_SENDER_SIGNING_KEY must be at least 32 characters');
  const timestamp = Date.now().toString(); const nonce = randomUUID();
  const first = await fetch(endpoint, { method: 'POST', headers: headers(timestamp, nonce), body });
  const firstPayload = await first.json() as Record<string, unknown>;
  const replay = await fetch(endpoint, { method: 'POST', headers: headers(timestamp, nonce), body });
  const badNonce = randomUUID();
  const bad = await fetch(endpoint, { method: 'POST', headers: headers(Date.now().toString(), badNonce, '0'.repeat(64)), body });
  const passed = first.status === 404 && firstPayload.code === 'RECIPIENT_NOT_FOUND' && replay.status === 401 && bad.status === 401;
  console.log(JSON.stringify({ authenticatedUnknownRecipient: first.status, unknownRecipientCode: firstPayload.code, replayStatus: replay.status, badSignatureStatus: bad.status, noMessageSent: true, passed }));
  if (!passed) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
