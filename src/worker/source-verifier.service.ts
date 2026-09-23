import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../common/canonical';
import { signWebhook } from '../webhooks/webhook-signer';

function assertSafeEndpoint(value: string): URL {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && loopback)) {
    throw new Error('Source verification endpoint must use HTTPS');
  }
  if (url.username || url.password) throw new Error('Credentials in callback URL are forbidden');
  return url;
}

@Injectable()
export class SourceVerifierService {
  async verify(urlValue: string, secret: string, payload: Record<string, unknown>): Promise<boolean> {
    const url = assertSafeEndpoint(urlValue);
    const raw = Buffer.from(canonicalJson(payload));
    const timestamp = Date.now().toString(); const eventId = randomUUID();
    const response = await fetch(url, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-care-event-id': eventId, 'x-care-timestamp': timestamp,
      'x-care-signature': signWebhook(secret, timestamp, eventId, raw),
    }, body: raw, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null) as { valid?: boolean } | null;
    return body?.valid === true;
  }
}

export { assertSafeEndpoint };
