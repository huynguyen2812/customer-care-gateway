import { Injectable } from '@nestjs/common';
import { ZaloAccount } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import { CryptoService } from '../common/crypto.service';
import { canonicalJson, sha256 } from '../common/canonical';
import { capabilitiesOf, ChannelAdapter, EligibilityResult, NotSentCode, SendInput, SendOutcome } from './channel.adapter';
import { ChannelError } from './channel.errors';

export type ControlResult = { kind: 'APPLIED' } | { kind: 'UNSUPPORTED' } | { kind: 'REJECTED'; status: number; code: string } | { kind: 'UNKNOWN'; code: string };

type SignedResponse = { ok: true; status: number; payload: Record<string, unknown> } | { ok: false; reachable: boolean; timedOut: boolean };

const CERTAIN_NETWORK_FAILURES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL']);
const V2_NOT_SENT: Record<string, { code: NotSentCode; accountStatus?: 'RELOGIN_REQUIRED' | 'RESTRICTED' | 'RATE_LIMITED' | 'DISCONNECTED' | 'PAUSED' }> = {
  ACCOUNT_UNAVAILABLE: { code: 'ACCOUNT_UNAVAILABLE', accountStatus: 'DISCONNECTED' },
  RELOGIN_REQUIRED: { code: 'RELOGIN_REQUIRED', accountStatus: 'RELOGIN_REQUIRED' },
  ACCOUNT_RESTRICTED: { code: 'ACCOUNT_RESTRICTED', accountStatus: 'RESTRICTED' },
  RATE_LIMITED: { code: 'RATE_LIMITED', accountStatus: 'RATE_LIMITED' },
  ACCOUNT_PAUSED: { code: 'ACCOUNT_PAUSED', accountStatus: 'PAUSED' },
  RECIPIENT_NOT_FOUND: { code: 'RECIPIENT_NOT_FOUND' },
  INVALID_REQUEST: { code: 'INVALID_REQUEST' },
};

/**
 * Talks to the private personal-Zalo sender of ONE account (each account row carries its own sender
 * URL, client id and encrypted signing key). Never looks an account up by installation: the worker
 * passes the account it selected. Credentials, cookies and full phone numbers are never logged.
 *
 * Contract v2 (docs/multi-zalo-sender-contract.md) makes the outcome explicit (`delivery`) and dedupes
 * by deliveryAttemptId. The current sender only implements the legacy v1 route, so v1 responses are
 * classified conservatively: anything that might have reached Zalo is UNKNOWN.
 */
@Injectable()
export class PersonalZaloAdapter implements ChannelAdapter {
  constructor(private readonly crypto: CryptoService) {}

  private timeoutMs(): number { return Math.min(Math.max(Number(process.env.SENDER_TIMEOUT_MS || 10_000), 200), 30_000); }

  private configured(account: ZaloAccount): boolean {
    return account.channel === 'PERSONAL_ZALO' && !!account.senderBaseUrl && !!account.senderClientId && !!account.credentialEnc;
  }

  private async signed(account: ZaloAccount, method: 'GET' | 'POST', path: string, body: unknown): Promise<SignedResponse> {
    let url: URL;
    try { url = new URL(path, account.senderBaseUrl!); } catch { return { ok: false, reachable: false, timedOut: false }; }
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) return { ok: false, reachable: false, timedOut: false };
    const raw = method === 'GET' ? '' : canonicalJson(body); const timestamp = Date.now().toString(); const nonce = randomUUID();
    const signature = createHmac('sha256', this.crypto.decrypt(account.credentialEnc!)).update(`${method}\n${url.pathname}\n${timestamp}\n${nonce}\n${sha256(raw)}`).digest('hex');
    try {
      const res = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-gateway-client-id': account.senderClientId!, 'x-gateway-timestamp': timestamp, 'x-gateway-nonce': nonce, 'x-gateway-signature': signature, 'x-gateway-account-id': account.id }, body: method === 'GET' ? undefined : raw, signal: AbortSignal.timeout(this.timeoutMs()) });
      return { ok: true, status: res.status, payload: await res.json().catch(() => ({})) as Record<string, unknown> };
    } catch (error) {
      const e = error as { name?: string; cause?: { code?: string; errors?: { code?: string }[] } };
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      // Node wraps multi-address connect failures in AggregateError: every address must have been refused.
      const codes = e?.cause?.errors?.length ? e.cause.errors.map((x) => String(x?.code || '')) : [String(e?.cause?.code || '')];
      const neverConnected = codes.every((c) => CERTAIN_NETWORK_FAILURES.has(c));
      return { ok: false, reachable: !neverConnected, timedOut };
    }
  }

  async send(account: ZaloAccount, input: SendInput): Promise<SendOutcome> {
    if (!this.configured(account)) return { kind: 'NOT_SENT', code: 'CREDENTIAL_MISSING' };
    const caps = capabilitiesOf(account);
    const body = { content: input.content, externalReferenceId: input.externalReferenceId, phoneE164: input.phoneE164, deliveryAttemptId: input.deliveryAttemptId, idempotencyKey: input.deliveryAttemptId, channelAccountId: account.id };
    const r = await this.signed(account, 'POST', '/internal/v1/messages/send-known-contact', body);
    if (!r.ok) {
      // Connection never established → the request cannot have reached Zalo.
      if (!r.reachable && !r.timedOut) return { kind: 'NOT_SENT', code: 'SENDER_UNREACHABLE', accountStatus: 'DISCONNECTED' };
      return { kind: 'UNKNOWN', code: r.timedOut ? 'SENDER_TIMEOUT' : 'SENDER_CONNECTION_LOST' };
    }
    const { status, payload } = r;
    const code = String(payload.code || '');
    if ((caps.contractVersion ?? 1) >= 2 && typeof payload.delivery === 'string') {
      if (payload.delivery === 'SENT' && typeof payload.providerMessageId === 'string') return { kind: 'SENT', providerMessageId: payload.providerMessageId };
      if (payload.delivery === 'NOT_SENT') { const m = V2_NOT_SENT[code]; return m ? { kind: 'NOT_SENT', ...m } : { kind: 'UNKNOWN', code: code || 'NOT_SENT_UNMAPPED' }; }
      return { kind: 'UNKNOWN', code: code || 'DELIVERY_UNKNOWN' };
    }
    // ---- Legacy v1 sender (gateway-sender-routes.ts): classification by code path ----
    if (status >= 200 && status < 300) return typeof payload.providerMessageId === 'string' ? { kind: 'SENT', providerMessageId: payload.providerMessageId } : { kind: 'UNKNOWN', code: 'SENT_WITHOUT_MESSAGE_ID' };
    if (status === 400) return { kind: 'NOT_SENT', code: 'INVALID_REQUEST' };          // body validation before any send
    if (status === 401) return { kind: 'NOT_SENT', code: 'SENDER_AUTH_REJECTED' };     // signature/nonce check before any send
    if (status === 404 && code === 'RECIPIENT_NOT_FOUND') return { kind: 'NOT_SENT', code: 'RECIPIENT_NOT_FOUND' }; // known-friend lookup precedes send
    if (status === 503 && code === 'REPLAY_STORE_UNAVAILABLE') return { kind: 'NOT_SENT', code: 'SENDER_UNREACHABLE' };
    // 423 is returned both before sending and from inside the send call, 429/5xx may follow a send:
    // the legacy sender cannot prove the message was not delivered.
    return { kind: 'UNKNOWN', code: code || `HTTP_${status}` };
  }

  /** Contract v2 only: no send, no friend request, no conversation, no contact write. */
  async recipientEligibility(account: ZaloAccount, phoneE164: string): Promise<EligibilityResult> {
    if (!this.configured(account) || !capabilitiesOf(account).recipientPreflight) return 'UNKNOWN';
    const r = await this.signed(account, 'POST', `/internal/v1/accounts/${account.id}/recipient-eligibility`, { phoneE164 });
    if (!r.ok || r.status !== 200) return r.ok && r.status === 423 ? 'ACCOUNT_UNAVAILABLE' : 'UNKNOWN';
    const v = String(r.payload.result || '');
    return (['ELIGIBLE_EXISTING_FRIEND', 'ELIGIBLE_EXISTING_CONVERSATION', 'NOT_FOUND', 'ACCOUNT_UNAVAILABLE'] as const).find((x) => x === v) || 'UNKNOWN';
  }

  /** QR login via the sender (contract v2). Never returns cookies/session; only a QR image and expiry. */
  async loginStart(account: ZaloAccount): Promise<{ loginId: string; qrImage: string; expiresAt: string }> {
    if (!this.configured(account) || !capabilitiesOf(account).qrLogin) throw new ChannelError('NOT_SUPPORTED', 'SENDER_QR_NOT_SUPPORTED');
    const r = await this.signed(account, 'POST', `/internal/v1/accounts/${account.id}/login/start`, {});
    if (!r.ok || r.status !== 200 || typeof r.payload.loginId !== 'string' || typeof r.payload.qrImage !== 'string' || !String(r.payload.qrImage).startsWith('data:image/png;base64,')) throw new ChannelError('CHANNEL_UNAVAILABLE', 'SENDER_LOGIN_FAILED');
    return { loginId: r.payload.loginId, qrImage: String(r.payload.qrImage), expiresAt: String(r.payload.expiresAt || '') };
  }

  async loginStatus(account: ZaloAccount, loginId: string): Promise<{ status: 'PENDING' | 'SCANNED' | 'CONNECTED' | 'EXPIRED' | 'FAILED'; displayName?: string; phoneMasked?: string }> {
    if (!this.configured(account) || !capabilitiesOf(account).qrLogin) throw new ChannelError('NOT_SUPPORTED', 'SENDER_QR_NOT_SUPPORTED');
    const r = await this.signed(account, 'GET', `/internal/v1/accounts/${account.id}/login/${encodeURIComponent(loginId)}`, null);
    if (!r.ok || r.status !== 200) throw new ChannelError('CHANNEL_UNAVAILABLE', 'SENDER_LOGIN_STATUS_FAILED');
    const s = String(r.payload.status || '');
    const status = (['PENDING', 'SCANNED', 'CONNECTED', 'EXPIRED', 'FAILED'] as const).find((x) => x === s) || 'FAILED';
    const phone = typeof r.payload.phoneMasked === 'string' && /^\d{2,4}\*{2,}\d{2,4}$/.test(r.payload.phoneMasked) ? r.payload.phoneMasked : undefined;
    return { status, displayName: typeof r.payload.displayName === 'string' ? r.payload.displayName.slice(0, 160) : undefined, phoneMasked: phone };
  }

  /** pause | resume | disconnect on the sender (contract v2 `remoteControl`). Returns false when unsupported. */
  async control(account: ZaloAccount, action: 'pause' | 'resume' | 'disconnect'): Promise<boolean> {
    return (await this.controlDetailed(account, action)).kind === 'APPLIED';
  }

  /**
   * Như control() nhưng phân biệt APPLIED (sender xác nhận), REJECTED (lỗi nghiệp vụ có mã, ví dụ 409
   * RELOGIN_REQUIRED), UNSUPPORTED và UNKNOWN (timeout / không kết nối / phản hồi không hợp lệ).
   * Chỉ APPLIED mới được coi là sender đã đổi trạng thái.
   */
  async controlDetailed(account: ZaloAccount, action: 'pause' | 'resume' | 'disconnect'): Promise<ControlResult> {
    if (!this.configured(account) || !capabilitiesOf(account).remoteControl) return { kind: 'UNSUPPORTED' };
    const r = await this.signed(account, 'POST', `/internal/v1/accounts/${account.id}/${action}`, {});
    if (!r.ok) return { kind: 'UNKNOWN', code: r.timedOut ? 'SENDER_TIMEOUT' : 'SENDER_UNREACHABLE' };
    const expectPaused = action === 'pause' ? true : action === 'resume' ? false : undefined;
    if (r.status === 200 && r.payload.ok === true && (expectPaused === undefined || r.payload.paused === expectPaused)) return { kind: 'APPLIED' };
    if ((r.status === 409 || r.status === 404) && typeof r.payload.code === 'string') return { kind: 'REJECTED', status: r.status, code: String(r.payload.code).slice(0, 60) };
    return { kind: 'UNKNOWN', code: `HTTP_${r.status}` };
  }

  /**
   * Đăng ký channelAccountId với sender v2 bằng client/khoá cấu hình phía Gateway (env), idempotent.
   * Client/tenant phía sender suy ra từ chữ ký — không truyền được client khác.
   */
  async register(target: { accountId: string; baseUrl: string; clientId: string; signingKey: string }): Promise<{ ok: true; capabilities: Record<string, unknown> } | { ok: false; code: string }> {
    const temp = { id: target.accountId, channel: 'PERSONAL_ZALO', senderBaseUrl: target.baseUrl, senderClientId: target.clientId, credentialEnc: this.crypto.encrypt(target.signingKey), capabilities: {} } as unknown as ZaloAccount;
    const r = await this.signed(temp, 'POST', `/internal/v1/accounts/${target.accountId}/register`, {});
    if (!r.ok) return { ok: false, code: r.timedOut ? 'SENDER_TIMEOUT' : 'SENDER_UNREACHABLE' };
    const caps = r.payload.capabilities as Record<string, unknown> | undefined;
    if (r.status === 200 && r.payload.channelAccountId === target.accountId && caps && caps.contractVersion === 2) return { ok: true, capabilities: caps };
    return { ok: false, code: typeof r.payload.code === 'string' ? String(r.payload.code).slice(0, 60) : `HTTP_${r.status}` };
  }
}
