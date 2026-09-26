import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt N=2^15, r=8, p=1 (~32 MiB per hash). OWASP currently suggests N=2^17; 2^15 is a deliberate
// trade-off for low-end clinic PCs. Parameters are stored with each hash so they can be raised later.
const N = 32768; const R = 8; const P = 1; const KEYLEN = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, key) => (e ? reject(e) : resolve(key))));
}

/** Format: scrypt2$N$r$p$saltB64$hashB64 */
export async function hashLocalPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt2$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyLocalPassword(password: string, encoded: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = encoded.split('$');
  if (alg !== 'scrypt2' || !salt || !hash) return false;
  const nn = Number(n); const rr = Number(r); const pp = Number(p);
  if (![nn, rr, pp].every(Number.isInteger) || nn < 16384 || nn > 1 << 20 || rr < 1 || rr > 16 || pp < 1 || pp > 4) return false;
  const expected = Buffer.from(hash, 'base64');
  if (expected.length !== KEYLEN) return false;
  const key = await derive(password, Buffer.from(salt, 'base64'), nn, rr, pp);
  return timingSafeEqual(key, expected);
}

/** Hash used to spend the same time on unknown usernames (no user-enumeration by timing). */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> { return (dummy ??= hashLocalPassword(randomBytes(12).toString('hex'))); }

/** Policy: 10–200 characters, not only digits, not equal to the username. */
export function passwordPolicyError(password: unknown, username = ''): string | null {
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) return 'PASSWORD_LENGTH';
  if (/^\d+$/.test(password)) return 'PASSWORD_TOO_SIMPLE';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'PASSWORD_CONTAINS_USERNAME';
  return null;
}
