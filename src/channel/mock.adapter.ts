import { Injectable } from '@nestjs/common';
import { ZaloAccount } from '@prisma/client';
import { ChannelAdapter, SendInput, SendOutcome } from './channel.adapter';

/** Test/local only (see ChannelRouterService.mockAllowed). Idempotent per deliveryAttemptId. */
@Injectable()
export class MockAdapter implements ChannelAdapter {
  private readonly sent = new Map<string, string>();
  async send(_account: ZaloAccount, input: SendInput): Promise<SendOutcome> {
    const existing = this.sent.get(input.deliveryAttemptId);
    if (existing) return { kind: 'SENT', providerMessageId: existing };
    const id = `mock_${input.deliveryAttemptId}`;
    this.sent.set(input.deliveryAttemptId, id);
    return { kind: 'SENT', providerMessageId: id };
  }
}
