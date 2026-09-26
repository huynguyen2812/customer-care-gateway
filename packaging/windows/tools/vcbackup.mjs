// VETCLINIC CRM PC — encrypted backup container + recovery key (Node.js built-ins only).
//
// Keys never come from argv: the backup key / recovery key are read from env (VCBAK_KEY_HEX, VCBAK_RECOVERY_KEY).
//
//   recovery-init            stdin: JSON bundle of keys  → stdout: {"recoveryKey":"XXXX-…","wrap":{…}} (key shown ONCE)
//   recovery-open            env VCBAK_RECOVERY_KEY, stdin: wrap JSON → stdout: bundle JSON
//   open-backup-keys <in>    env VCBAK_RECOVERY_KEY → stdout: {bundle, wrap} from the backup header (restore on a new PC)
//   pack <out> <file>...     env VCBAK_KEY_HEX, VCBAK_WRAP (wrap JSON) → encrypted .vcbak
//   unpack <in> <outDir>     env VCBAK_KEY_HEX or VCBAK_RECOVERY_KEY → files; fails on any tampering
//   verify <in>              like unpack but writes nothing
//   header <in>              prints the public header (version, date, file names/sizes) — no secrets
//
// Container: "VCBAK1\n" | u32 headerLen | header JSON | chunks. Each chunk: u32 len | AES-256-GCM(ciphertext+tag).
// Nonce = 8-byte random prefix (header) || u32 index; AAD = sha256(header) || u32 index || u8 final.
// Recovery wrap: key = scrypt(normalized recovery key, salt, N=2^17, r=8, p=1) → AES-256-GCM(bundle JSON).
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, openSync, readSync, closeSync, statSync, writeSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const MAGIC = Buffer.from('VCBAK1\n');
const CHUNK = 4 * 1024 * 1024;
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

const fail = (m) => { process.stderr.write(`vcbackup: ${m}\n`); process.exit(1); };
const readStdin = async () => { const parts = []; for await (const c of process.stdin) parts.push(c); return Buffer.concat(parts).toString('utf8'); };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

function encodeRecoveryKey(bytes) {
  let bits = ''; for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = ''; for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out.match(/.{1,4}/g).join('-');
}
export function normalizeRecoveryKey(s) {
  const t = String(s || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{40}$/.test(t)) throw new Error('RECOVERY_KEY_FORMAT');
  return t;
}
function kek(recoveryKey, salt) { return scryptSync(normalizeRecoveryKey(recoveryKey), salt, 32, SCRYPT); }

function sealWrap(bundle, recoveryKey) {
  const salt = randomBytes(16); const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek(recoveryKey, salt), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(bundle), 'utf8'), c.final()]);
  return { v: 1, kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
function openWrap(wrap, recoveryKey) {
  if (!wrap || wrap.v !== 1 || wrap.kdf !== 'scrypt') throw new Error('RECOVERY_WRAP_INVALID');
  const d = createDecipheriv('aes-256-gcm', kek(recoveryKey, Buffer.from(wrap.salt, 'base64')), Buffer.from(wrap.iv, 'base64'));
  d.setAuthTag(Buffer.from(wrap.tag, 'base64'));
  try { return JSON.parse(Buffer.concat([d.update(Buffer.from(wrap.ct, 'base64')), d.final()]).toString('utf8')); }
  catch { throw new Error('RECOVERY_KEY_WRONG'); }
}

function backupKey() {
  if (process.env.VCBAK_KEY_HEX) {
    const k = Buffer.from(process.env.VCBAK_KEY_HEX, 'hex'); if (k.length !== 32) throw new Error('BACKUP_KEY_INVALID'); return k;
  }
  return null;
}

async function pack(out, files) {
  const key = backupKey(); if (!key) throw new Error('VCBAK_KEY_HEX required');
  const wrap = JSON.parse(process.env.VCBAK_WRAP || 'null'); if (!wrap) throw new Error('VCBAK_WRAP required');
  const header = Buffer.from(JSON.stringify({ v: 1, createdAt: new Date().toISOString(), noncePrefix: randomBytes(8).toString('base64'), chunk: CHUNK, files: files.map((f) => ({ name: basename(f), size: statSync(f).size })), wrap }));
  const hh = createHash('sha256').update(header).digest(); const prefix = Buffer.from(JSON.parse(header).noncePrefix, 'base64');
  const fd = openSync(out, 'wx');
  try {
    writeSync(fd, MAGIC); writeSync(fd, u32(header.length)); writeSync(fd, header);
    let index = 0; let pending = Buffer.alloc(0);
    const total = files.reduce((n, f) => n + statSync(f).size, 0); let seen = 0;
    const emit = (plain, final) => {
      const iv = Buffer.concat([prefix, u32(index)]); const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.concat([hh, u32(index), Buffer.from([final ? 1 : 0])]));
      const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
      writeSync(fd, u32(ct.length)); writeSync(fd, ct); index++;
    };
    for (const f of files) {
      for await (const part of createReadStream(f, { highWaterMark: CHUNK })) {
        pending = Buffer.concat([pending, part]); seen += part.length;
        while (pending.length >= CHUNK && !(seen === total && pending.length === CHUNK)) { emit(pending.subarray(0, CHUNK), false); pending = pending.subarray(CHUNK); }
      }
    }
    emit(pending, true);
  } finally { closeSync(fd); }
}

function readHeader(file) {
  const fd = openSync(file, 'r');
  const m = Buffer.alloc(MAGIC.length); readSync(fd, m, 0, m.length, 0);
  if (!timingSafeEqual(m, MAGIC)) { closeSync(fd); throw new Error('NOT_A_VCBAK_FILE'); }
  const l = Buffer.alloc(4); readSync(fd, l, 0, 4, MAGIC.length);
  const header = Buffer.alloc(l.readUInt32BE()); readSync(fd, header, 0, header.length, MAGIC.length + 4);
  return { fd, header, offset: MAGIC.length + 4 + header.length, meta: JSON.parse(header.toString('utf8')) };
}

async function unpack(file, outDir) {
  const { fd, header, meta, offset: start } = readHeader(file); let offset = start;
  let key = backupKey();
  if (!key) { const bundle = openWrap(meta.wrap, process.env.VCBAK_RECOVERY_KEY); key = Buffer.from(bundle.BACKUP_KEY, 'hex'); }
  const hh = createHash('sha256').update(header).digest(); const prefix = Buffer.from(meta.noncePrefix, 'base64');
  const outs = outDir ? meta.files.map((f) => { if (!/^[A-Za-z0-9._-]+$/.test(f.name)) throw new Error('BAD_FILE_NAME'); mkdirSync(outDir, { recursive: true }); const p = join(outDir, f.name); if (existsSync(p)) throw new Error(`EXISTS ${f.name}`); return { ...f, fd: openSync(p, 'w'), left: f.size }; }) : meta.files.map((f) => ({ ...f, left: f.size }));
  const size = statSync(file).size; let index = 0; let finalSeen = false; let fileIdx = 0;
  try {
    while (offset < size) {
      if (finalSeen) throw new Error('TRAILING_DATA');
      const l = Buffer.alloc(4); readSync(fd, l, 0, 4, offset); const len = l.readUInt32BE();
      if (len < 16 || len > meta.chunk + 16) throw new Error('CORRUPT_CHUNK');
      const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, offset + 4); offset += 4 + len;
      const final = offset >= size;
      const d = createDecipheriv('aes-256-gcm', key, Buffer.concat([prefix, u32(index)]));
      d.setAAD(Buffer.concat([hh, u32(index), Buffer.from([final ? 1 : 0])])); d.setAuthTag(buf.subarray(len - 16));
      let plain; try { plain = Buffer.concat([d.update(buf.subarray(0, len - 16)), d.final()]); } catch { throw new Error(`INTEGRITY_FAILED chunk ${index}`); }
      finalSeen = final; index++;
      let p = 0;
      while (p < plain.length) {
        while (fileIdx < outs.length && outs[fileIdx].left === 0) fileIdx++;
        if (fileIdx >= outs.length) throw new Error('SIZE_MISMATCH');
        const o = outs[fileIdx]; const n = Math.min(o.left, plain.length - p);
        if (o.fd !== undefined) writeSync(o.fd, plain, p, n);
        o.left -= n; p += n;
      }
    }
    if (!finalSeen || outs.some((o) => o.left !== 0)) throw new Error('TRUNCATED');
  } finally { closeSync(fd); for (const o of outs) if (o.fd !== undefined) closeSync(o.fd); }
  return meta.files;
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'recovery-init') {
    const bundle = JSON.parse(await readStdin());
    const recoveryKey = encodeRecoveryKey(randomBytes(25));
    process.stdout.write(JSON.stringify({ recoveryKey, wrap: sealWrap(bundle, recoveryKey) }));
  } else if (cmd === 'recovery-open') {
    process.stdout.write(JSON.stringify(openWrap(JSON.parse(await readStdin()), process.env.VCBAK_RECOVERY_KEY)));
  } else if (cmd === 'open-backup-keys') {
    // Restore on a new PC: the key bundle inside the backup header, opened with the customer's recovery key.
    const { fd, meta } = readHeader(args[0]); closeSync(fd);
    process.stdout.write(JSON.stringify({ bundle: openWrap(meta.wrap, process.env.VCBAK_RECOVERY_KEY), wrap: meta.wrap }));
  } else if (cmd === 'pack') { await pack(args[0], args.slice(1)); process.stdout.write('OK\n'); }
  else if (cmd === 'unpack') { const f = await unpack(args[0], args[1]); process.stdout.write(`${JSON.stringify(f.map((x) => x.name))}\n`); }
  else if (cmd === 'verify') { const f = await unpack(args[0], null); process.stdout.write(`OK ${JSON.stringify(f)}\n`); }
  else if (cmd === 'header') { const { fd, meta } = readHeader(args[0]); closeSync(fd); process.stdout.write(`${JSON.stringify({ v: meta.v, createdAt: meta.createdAt, files: meta.files })}\n`); }
  else fail('usage: recovery-init | recovery-open | pack | unpack | verify | header');
} catch (e) { fail(e.message); }
