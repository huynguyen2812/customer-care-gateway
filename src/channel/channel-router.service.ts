import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ChannelAdapter, SendInput, SendResult } from './channel.adapter';
import { MockAdapter } from './mock.adapter';
import { PersonalZaloAdapter } from './personal-zalo.adapter';
import { ChannelError } from './channel.errors';

@Injectable()
export class ChannelRouterService implements ChannelAdapter {
  constructor(private readonly prisma: PrismaService, private readonly mock: MockAdapter, private readonly personal: PersonalZaloAdapter) {}
  async send(input: SendInput): Promise<SendResult> {
    const account = await this.prisma.zaloAccount.findUnique({ where: { installationId: input.installationId } });
    if (!account || account.channel === 'MOCK') return this.mock.send(input);
    if (account.channel === 'PERSONAL_ZALO') return this.personal.send(input);
    throw new ChannelError('CHANNEL_UNAVAILABLE', 'ZNS adapter is not implemented');
  }
}
