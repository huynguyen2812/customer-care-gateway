import { Injectable } from '@nestjs/common';
import { ZaloAccount } from '@prisma/client';
import { SendInput, SendOutcome } from './channel.adapter';
import { MockAdapter } from './mock.adapter';
import { PersonalZaloAdapter } from './personal-zalo.adapter';

/** MOCK is never a silent fallback: only an explicit MOCK account, and only outside production. */
export function mockAllowed(): boolean {
  return process.env.MOCK_ADAPTER_ENABLED === 'true' && process.env.NODE_ENV !== 'production';
}

@Injectable()
export class ChannelRouterService {
  constructor(private readonly mock: MockAdapter, private readonly personal: PersonalZaloAdapter) {}

  /**
   * Sends through the account the worker selected. The caller passes the tenant of the job; an
   * account of another tenant is refused before any network call.
   */
  async send(account: ZaloAccount, tenantId: string, input: SendInput): Promise<SendOutcome> {
    if (account.tenantId !== tenantId || account.id !== input.channelAccountId) return { kind: 'NOT_SENT', code: 'ACCOUNT_UNAVAILABLE' };
    if (account.revokedAt || account.paused) return { kind: 'NOT_SENT', code: 'ACCOUNT_PAUSED' };
    if (account.status !== 'CONNECTED') return { kind: 'NOT_SENT', code: account.status === 'RELOGIN_REQUIRED' ? 'RELOGIN_REQUIRED' : account.status === 'RESTRICTED' ? 'ACCOUNT_RESTRICTED' : 'ACCOUNT_UNAVAILABLE' };
    if (account.channel === 'MOCK') return mockAllowed() ? this.mock.send(account, input) : { kind: 'NOT_SENT', code: 'CHANNEL_NOT_SUPPORTED' };
    if (account.channel === 'PERSONAL_ZALO') return this.personal.send(account, input);
    return { kind: 'NOT_SENT', code: 'CHANNEL_NOT_SUPPORTED' }; // ZNS adapter not implemented yet
  }
}
