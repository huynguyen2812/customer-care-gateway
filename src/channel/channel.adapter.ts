import { ZaloAccount } from '@prisma/client';

export type SendInput = {
  installationId: string;
  channelAccountId: string;
  /** Stable per attempt; sent to the sender as idempotency key. Retrying the same attempt reuses it. */
  deliveryAttemptId: string;
  externalReferenceId: string;
  recipientName: string;
  phoneE164: string;
  templateCode: string;
  content: string;
};

/**
 * SENT      — provider accepted the message (providerMessageId present).
 * NOT_SENT  — certainly not sent (rejected before any send path); quota may be released and, for
 *             account-level causes, another account may be tried.
 * UNKNOWN   — outcome not known (timeout, 5xx, ambiguous legacy code). Never fail over; only retry
 *             the same attempt on the same account when the sender dedupes by deliveryAttemptId.
 */
export type SendOutcome =
  | { kind: 'SENT'; providerMessageId: string }
  | { kind: 'NOT_SENT'; code: NotSentCode; accountStatus?: 'RELOGIN_REQUIRED' | 'RESTRICTED' | 'RATE_LIMITED' | 'DISCONNECTED' | 'PAUSED' }
  | { kind: 'UNKNOWN'; code: string };

export type NotSentCode =
  | 'ACCOUNT_UNAVAILABLE' | 'RELOGIN_REQUIRED' | 'ACCOUNT_RESTRICTED' | 'RATE_LIMITED' | 'ACCOUNT_PAUSED'
  | 'CREDENTIAL_MISSING' | 'CHANNEL_NOT_SUPPORTED' | 'RECIPIENT_NOT_FOUND' | 'INVALID_REQUEST' | 'SENDER_AUTH_REJECTED' | 'SENDER_UNREACHABLE';

/** Account-level causes that allow choosing another account after a certain non-send. */
export const ACCOUNT_LEVEL_NOT_SENT: NotSentCode[] = ['ACCOUNT_UNAVAILABLE', 'RELOGIN_REQUIRED', 'ACCOUNT_RESTRICTED', 'RATE_LIMITED', 'ACCOUNT_PAUSED', 'CREDENTIAL_MISSING', 'CHANNEL_NOT_SUPPORTED', 'SENDER_AUTH_REJECTED', 'SENDER_UNREACHABLE'];

export type EligibilityResult = 'ELIGIBLE_EXISTING_FRIEND' | 'ELIGIBLE_EXISTING_CONVERSATION' | 'NOT_FOUND' | 'ACCOUNT_UNAVAILABLE' | 'UNKNOWN';

export type SenderCapabilities = { contractVersion?: number; idempotentSend?: boolean; recipientPreflight?: boolean; qrLogin?: boolean; remoteControl?: boolean };
export function capabilitiesOf(account: Pick<ZaloAccount, 'capabilities'>): SenderCapabilities {
  const c = (account.capabilities || {}) as Record<string, unknown>;
  return { contractVersion: typeof c.contractVersion === 'number' ? c.contractVersion : 1, idempotentSend: c.idempotentSend === true, recipientPreflight: c.recipientPreflight === true, qrLogin: c.qrLogin === true, remoteControl: c.remoteControl === true };
}

export interface ChannelAdapter {
  send(account: ZaloAccount, input: SendInput): Promise<SendOutcome>;
}
