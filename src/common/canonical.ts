import { createHash } from 'node:crypto';

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string { return JSON.stringify(sort(value)); }
export function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
