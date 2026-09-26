// VETCLINIC CRM PC — update helper (Node.js built-ins only).
//
//   keygen <privatePemOut> <publicPemOut>      release side, once: the PRIVATE key never goes into the repo or installer
//   sign <privatePem> <manifest.json>          writes <manifest.json>.sig (base64 Ed25519 over the exact file bytes)
//   verify <publicPem> <manifest.json> <sig>   exit 0 + prints the manifest when the signature is valid
//   fetch <url> <out> [maxBytes]               HTTPS only (http://127.0.0.1 only with VC_UPDATE_ALLOW_LOCAL=1), no redirects to http
//   sha256 <file>
//   newer <candidate> <current>                exit 0 if candidate version > current (numeric dot parts, "-pc" suffix ignored)
//
// Manifest: {"product":"VETCLINIC CRM PC","version":"0.2.0-pc","packageUrl":"https://…/vetclinic-crm-0.2.0-pc.zip",
//            "packageSha256":"…","packageSize":123,"publishedAt":"…","notes":"…"}
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync, createWriteStream, existsSync, unlinkSync, renameSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const fail = (m, code = 1) => { process.stderr.write(`vcupdate: ${m}\n`); process.exit(code); };
const parts = (v) => String(v).replace(/-.*$/, '').split('.').map((x) => Number(x) || 0);
export function isNewer(a, b) { const x = parts(a); const y = parts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; }

function checkUrl(u) {
  const url = new URL(u);
  const local = process.env.VC_UPDATE_ALLOW_LOCAL === '1' && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Error('UPDATE_URL_NOT_HTTPS');
  if (url.username || url.password) throw new Error('UPDATE_URL_CREDENTIALS');
  return url;
}

const [cmd, ...a] = process.argv.slice(2);
try {
  if (cmd === 'keygen') {
    if (existsSync(a[0])) fail('private key file already exists');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(a[0], privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(a[1], publicKey.export({ type: 'spki', format: 'pem' }));
  } else if (cmd === 'sign') {
    const sig = sign(null, readFileSync(a[1]), createPrivateKey(readFileSync(a[0])));
    writeFileSync(`${a[1]}.sig`, sig.toString('base64'));
  } else if (cmd === 'verify') {
    const body = readFileSync(a[1]);
    const ok = verify(null, body, createPublicKey(readFileSync(a[0])), Buffer.from(readFileSync(a[2], 'utf8').trim(), 'base64'));
    if (!ok) fail('SIGNATURE_INVALID', 2);
    const m = JSON.parse(body.toString('utf8'));
    if (m.product !== 'VETCLINIC CRM PC' || !/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/.test(m.version) || !/^[0-9a-f]{64}$/.test(m.packageSha256) || !(m.packageSize > 0)) fail('MANIFEST_INVALID', 2);
    checkUrl(m.packageUrl);
    process.stdout.write(JSON.stringify(m));
  } else if (cmd === 'fetch') {
    const max = Number(a[2] || 5 * 1024 * 1024 * 1024);
    const res = await fetch(checkUrl(a[0]), { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
    if (res.url) checkUrl(res.url); // a redirect must stay on HTTPS
    if (!res.ok || !res.body) fail(`HTTP_${res.status}`);
    let n = 0; const tmp = `${a[1]}.part`;
    const counter = new TransformStream({ transform(chunk, ctl) { n += chunk.byteLength; if (n > max) ctl.error(new Error('TOO_LARGE')); else ctl.enqueue(chunk); } });
    try { await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(tmp)); }
    catch (e) { if (existsSync(tmp)) unlinkSync(tmp); throw e; }
    renameSync(tmp, a[1]);
    process.stdout.write(`${n}\n`);
  } else if (cmd === 'sha256') {
    const h = createHash('sha256'); await pipeline(createReadStream(a[0]), h); process.stdout.write(`${h.digest('hex')}\n`);
  } else if (cmd === 'newer') {
    process.exit(isNewer(a[0], a[1]) ? 0 : 3);
  } else fail('usage: keygen | sign | verify | fetch | sha256 | newer');
} catch (e) { fail(e.message); }
