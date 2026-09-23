import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ChannelAdapter, SendInput, SendResult } from './channel.adapter';

@Injectable()
export class MockAdapter implements ChannelAdapter {
  async send(_input: SendInput): Promise<SendResult> { return { providerMessageId: `mock_${randomUUID()}` }; }
}
