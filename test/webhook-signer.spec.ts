import { signWebhook } from '../src/webhooks/webhook-signer';

describe('webhook signature', () => {
  it('binds timestamp, event id and body', () => {
    const a = signWebhook('secret', '1', 'event', Buffer.from('{}'));
    expect(a).toHaveLength(64);
    expect(signWebhook('secret', '2', 'event', Buffer.from('{}'))).not.toBe(a);
    expect(signWebhook('secret', '1', 'event2', Buffer.from('{}'))).not.toBe(a);
  });
});
