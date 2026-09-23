export class ChannelError extends Error {
  constructor(public readonly code: 'ACCOUNT_RESTRICTED' | 'RECIPIENT_NOT_FOUND' | 'RATE_LIMITED' | 'CHANNEL_UNAVAILABLE', message: string) { super(message); }
}
