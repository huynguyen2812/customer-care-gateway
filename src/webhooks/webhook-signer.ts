import { createHmac } from 'node:crypto';
import { sha256 } from '../common/canonical';

export function signWebhook(secret: string, timestamp: string, eventId: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.${eventId}.${sha256(rawBody)}`).digest('hex');
}
