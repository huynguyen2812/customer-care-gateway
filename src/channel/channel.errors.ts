export class ChannelError extends Error {
  constructor(public readonly code: 'ACCOUNT_RESTRICTED' | 'RECIPIENT_NOT_FOUND' | 'RATE_LIMITED' | 'CHANNEL_UNAVAILABLE' | 'NOT_SUPPORTED', message: string) { super(message); }
}
