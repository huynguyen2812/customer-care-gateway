// Server-side redaction for anything the CRM returns to a browser. The UI adds its own masking,
// but correctness must not depend on it.

const SENSITIVE_KEY = /secret|token|password|passwd|cookie|signature|signing|credential|api[_-]?key|session|imei|authorization|private|key$/i;
const PHONE_LIKE = /(?:\+?84|0)\d{8,10}/g;

export function maskPhone(value?: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  const local = digits.startsWith('84') && digits.length >= 11 ? `0${digits.slice(2)}` : digits;
  if (local.length < 7) return '***';
  return `${local.slice(0, 4)}***${local.slice(-3)}`;
}

export function redactText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.replace(PHONE_LIKE, (m) => maskPhone(m) || '***');
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[…]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[đã ẩn]' : redact(v, depth + 1)]));
  }
  return value;
}
