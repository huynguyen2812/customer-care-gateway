export type SendInput = { installationId: string; externalReferenceId: string; recipientName: string; phoneE164: string; templateCode: string; content: string };
export type SendResult = { providerMessageId: string };
export interface ChannelAdapter { send(input: SendInput): Promise<SendResult>; }
