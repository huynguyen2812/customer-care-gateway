export function normalizeVietnamPhone(input: unknown): string {
  if (typeof input !== 'string') throw new Error('recipient.phone is required');
  let value = input.trim().replace(/[\s().-]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (value.startsWith('0')) value = `+84${value.slice(1)}`;
  if (value.startsWith('84')) value = `+${value}`;
  if (!/^\+84\d{9,10}$/.test(value)) throw new Error('recipient.phone must be a valid Vietnam E.164 number');
  return value;
}

export function maskPhone(phoneE164: string): string {
  return phoneE164.length < 8 ? '***' : `${phoneE164.slice(0, 5)}***${phoneE164.slice(-3)}`;
}
