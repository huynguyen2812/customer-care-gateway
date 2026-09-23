import { Injectable } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { canonicalJson, sha256 } from '../common/canonical';
import { ChannelAdapter, SendInput, SendResult } from './channel.adapter';
import { ChannelError } from './channel.errors';

@Injectable()
export class PersonalZaloAdapter implements ChannelAdapter {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService) {}
  async send(input: SendInput): Promise<SendResult> {
    const account = await this.prisma.zaloAccount.findUnique({ where: { installationId: input.installationId } });
    if (!account || account.channel !== 'PERSONAL_ZALO' || account.status !== 'CONNECTED' || !account.senderBaseUrl || !account.senderClientId || !account.credentialEnc) throw new ChannelError('CHANNEL_UNAVAILABLE', 'Personal Zalo sender is not configured');
    const url = new URL('/internal/v1/messages/send-known-contact', account.senderBaseUrl);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new ChannelError('CHANNEL_UNAVAILABLE', 'Sender must use HTTPS');
    const body = { content: input.content, externalReferenceId: input.externalReferenceId, phoneE164: input.phoneE164 };
    const raw = canonicalJson(body); const timestamp = Date.now().toString(); const nonce = randomUUID();
    const signingPayload = `POST\n/internal/v1/messages/send-known-contact\n${timestamp}\n${nonce}\n${sha256(raw)}`;
    const signature = createHmac('sha256', this.crypto.decrypt(account.credentialEnc)).update(signingPayload).digest('hex');
    let response: Response;
    try { response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-client-id': account.senderClientId, 'x-gateway-timestamp': timestamp, 'x-gateway-nonce': nonce, 'x-gateway-signature': signature }, body: raw, signal: AbortSignal.timeout(10_000) }); }
    catch { throw new ChannelError('CHANNEL_UNAVAILABLE', 'Personal Zalo sender unavailable'); }
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.ok && typeof payload.providerMessageId === 'string') return { providerMessageId: payload.providerMessageId };
    const code = String(payload.code || 'CHANNEL_UNAVAILABLE');
    if (response.status === 404) throw new ChannelError('RECIPIENT_NOT_FOUND', code);
    if (response.status === 429) throw new ChannelError('RATE_LIMITED', code);
    if ([409, 423].includes(response.status) && code === 'ACCOUNT_RESTRICTED') throw new ChannelError('ACCOUNT_RESTRICTED', code);
    throw new ChannelError('CHANNEL_UNAVAILABLE', code);
  }
}
