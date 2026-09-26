#!/usr/bin/env node
/*
 * Release preflight for an OFFICIAL CRM PC release (run by release.ps1 unless -AllowDirty). Refuses to build when:
 *  - the CRM or Sender working tree is dirty; HEAD is detached; the upstream is not <allowed remote>/<branch>; or HEAD is not
 *    the commit of that branch ON THE REMOTE ITSELF (git ls-remote, not the possibly stale local tracking ref). Remote not
 *    reachable / not authenticated / branch missing ⇒ FAIL. Allowed remotes: CRM "origin", Sender "vetclinic";
 *  - the version is not x.y.z-pc, or a release folder for it already exists;
 *  - packaging/windows/platform-config-keys.json is missing/invalid: must be {"<keyId>": "<SPKI PEM>"} with Ed25519
 *    PUBLIC keys only, and no keyId that looks like a QA/test key (a release must never trust QA keys);
 *  - the Platform device API URL baked into VetclinicCrm.psm1 is not HTTPS on the expected production host/path
 *    (or differs from --expect-platform-url when given);
 *  - the update BaseUrl is not the 0.3+ channel https://vetclinic.vn/tai-ve/crm-pc/v3 (the legacy 0.2.x address is refused),
 *    or VetclinicCrm.psm1 does not default to <BaseUrl>/manifest.json. This official-release gate always rejects
 *    --allow-local-url; local URLs are available only to release.ps1 QA builds that use -AllowDirty and skip this gate;
 *  - the update signing private key does not match packaging/windows/update-public-key.pem.
 * Prints only public facts (commit ids, keyIds, key fingerprints, URLs). Never prints private key material.
 *
 * Usage: node release-preflight.cjs --crm <repo> --sender <repo> --out <OutDir> --version 0.3.0-pc --signing-key <pem>
 *        --base-url https://vetclinic.vn/tai-ve/crm-pc/v3 [--crm-remote origin] [--sender-remote vetclinic] [--expect-platform-url <url>] [--allow-local-url] [--keys <file>]
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROD_PLATFORM = { host: 'admin.vetclinic.vn', path: '/api/crm-pc/v1' };
const UPDATE_CHANNEL_BASE = 'https://vetclinic.vn/tai-ve/crm-pc/v3';
const LEGACY_UPDATE_BASE = 'https://vetclinic.vn/tai-ve/crm-pc';
const DEFAULT_REMOTES = { CRM: 'origin', Sender: 'vetclinic' };
const QA_KEY_ID = /(qa|test|demo|dev|local|crash|e2e|sample|fake|mock)/i;

/** Validates the Platform config public keys document. Returns { ok, errors, keys: [{ keyId, fingerprint }] }. */
function checkConfigKeys(text) {
  const errors = []; const keys = [];
  if (/PRIVATE KEY/.test(text)) return { ok: false, errors: ['platform-config-keys.json contains PRIVATE key material'], keys };
  let doc;
  try { doc = JSON.parse(text); } catch { return { ok: false, errors: ['platform-config-keys.json is not valid JSON'], keys }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Object.keys(doc).length) return { ok: false, errors: ['platform-config-keys.json must be a non-empty {"keyId": "PEM"} object'], keys };
  for (const [keyId, pem] of Object.entries(doc)) {
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(keyId)) { errors.push(`keyId "${keyId}" has an invalid format`); continue; }
    if (QA_KEY_ID.test(keyId)) { errors.push(`keyId "${keyId}" looks like a QA/test key — refused for a release`); continue; }
    try {
      const k = crypto.createPublicKey(String(pem));
      if (k.asymmetricKeyType !== 'ed25519') { errors.push(`keyId "${keyId}" is not an Ed25519 key`); continue; }
      keys.push({ keyId, fingerprint: crypto.createHash('sha256').update(k.export({ type: 'spki', format: 'der' })).digest('hex') });
    } catch { errors.push(`keyId "${keyId}" is not a valid SPKI public key`); }
  }
  return { ok: !errors.length && keys.length > 0, errors, keys };
}

/** Validates the Platform device API URL baked into the release. */
function checkPlatformUrl(url, expected) {
  const errors = [];
  let u; try { u = new URL(url); } catch { return { ok: false, errors: [`Platform URL "${url}" is not a URL`] }; }
  if (u.protocol !== 'https:') errors.push('Platform URL must be HTTPS');
  if (u.username || u.password || u.search || u.hash) errors.push('Platform URL must not carry credentials, query or fragment');
  if (u.hostname !== PROD_PLATFORM.host || u.pathname.replace(/\/$/, '') !== PROD_PLATFORM.path) errors.push(`Platform URL must be https://${PROD_PLATFORM.host}${PROD_PLATFORM.path}`);
  if (expected && expected.replace(/\/$/, '') !== url.replace(/\/$/, '')) errors.push(`Platform URL in the package (${url}) differs from the one Platform delivered (${expected})`);
  return { ok: !errors.length, errors };
}

function readPlatformUrl(crmRepo) {
  const psm = fs.readFileSync(path.join(crmRepo, 'packaging', 'windows', 'VetclinicCrm.psm1'), 'utf8');
  const m = psm.match(/\$script:PlatformDeviceApiUrl\s*=\s*'([^']+)'/);
  return m ? m[1] : null;
}

// Never prompts (no credential dialog), never fetches/pushes/changes anything; errors name the remote, never its URL.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo' };
function git(repo, ...args) { return execFileSync('git', ['-c', 'safe.directory=*', '-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim(); }
function readUpdateDefault(crmRepo) {
  const psm = fs.readFileSync(path.join(crmRepo, 'packaging', 'windows', 'VetclinicCrm.psm1'), 'utf8');
  const m = psm.match(/\$script:DefaultUpdateUrl\s*=\s*'([^']+)'/);
  return m ? m[1] : null;
}
function checkRepo(label, repo, remote) {
  const errors = [];
  if (git(repo, 'status', '--porcelain')) errors.push(`${label}: working tree has uncommitted changes`);
  const head = git(repo, 'rev-parse', 'HEAD');
  let branch = null;
  try { branch = git(repo, 'symbolic-ref', '--short', 'HEAD'); } catch { errors.push(`${label}: HEAD is detached (release from a branch)`); }
  if (branch) {
    let upstream = null;
    try { upstream = git(repo, 'rev-parse', '--abbrev-ref', '@{u}'); } catch { errors.push(`${label}: branch ${branch} has no upstream (push it to "${remote}" first)`); }
    if (upstream && upstream !== `${remote}/${branch}`) errors.push(`${label}: upstream is ${upstream}, expected ${remote}/${branch}`);
    // The remote itself, not the local tracking ref (which may be stale).
    let remoteSha = null;
    try {
      const out = git(repo, 'ls-remote', '--exit-code', remote, `refs/heads/${branch}`);
      remoteSha = (out.split(/\s+/)[0] || '').trim() || null;
    } catch (e) {
      errors.push(e && e.status === 2 ? `${label}: branch ${branch} does not exist on remote "${remote}"` : `${label}: remote "${remote}" not reachable or not authenticated (git ls-remote failed)`);
    }
    if (remoteSha && remoteSha !== head) errors.push(`${label}: HEAD ${head.slice(0, 7)} differs from ${remote}/${branch} on the remote (${remoteSha.slice(0, 7)}) — push, or pull the newer commit, then re-run`);
  }
  return { ok: !errors.length, errors, head };
}

function checkSigningKey(privatePath, publicPemPath) {
  try {
    const priv = crypto.createPrivateKey(fs.readFileSync(privatePath));
    const derived = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
    const shipped = crypto.createPublicKey(fs.readFileSync(publicPemPath)).export({ type: 'spki', format: 'der' });
    return derived.equals(shipped) ? { ok: true, errors: [] } : { ok: false, errors: ['update signing key does not match packaging/windows/update-public-key.pem'] };
  } catch { return { ok: false, errors: ['update signing key or update-public-key.pem cannot be read'] }; }
}

function run(argv) {
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const crm = path.resolve(arg('crm') || '.');
  const sender = arg('sender') ? path.resolve(arg('sender')) : null;
  const version = arg('version') || '';
  const errors = []; const info = {};
  if (argv.includes('--allow-local-url')) errors.push('--allow-local-url is QA-only and cannot pass the official release preflight');
  if (!/^\d+\.\d+\.\d+-pc$/.test(version)) errors.push(`version "${version}" must look like 1.2.3-pc for an official release`);
  const out = arg('out'); if (out && version && fs.existsSync(path.join(out, 'release', version))) errors.push(`release folder for ${version} already exists — use a new version`);
  const remotes = { CRM: arg('crm-remote') || DEFAULT_REMOTES.CRM, Sender: arg('sender-remote') || DEFAULT_REMOTES.Sender };
  for (const [label, repo] of [['CRM', crm], ['Sender', sender]]) { if (!repo) { errors.push(`${label} repo not given`); continue; } const r = checkRepo(label, repo, remotes[label]); errors.push(...r.errors); info[`${label.toLowerCase()}Commit`] = r.head; }
  const keysFile = arg('keys') || path.join(crm, 'packaging', 'windows', 'platform-config-keys.json');
  if (!fs.existsSync(keysFile)) errors.push('platform-config-keys.json missing — waiting for the production keyId + public key from Platform');
  else { const k = checkConfigKeys(fs.readFileSync(keysFile, 'utf8')); errors.push(...k.errors); info.platformConfigKeys = k.keys; }
  const url = readPlatformUrl(crm); info.platformUrl = url;
  if (!url) errors.push('Platform URL not found in VetclinicCrm.psm1'); else errors.push(...checkPlatformUrl(url, arg('expect-platform-url')).errors);
  const base = (arg('base-url') || '').replace(/\/+$/, '');
  try {
    const b = new URL(base);
    if (b.protocol !== 'https:') errors.push('update BaseUrl must be HTTPS');
    if (base === LEGACY_UPDATE_BASE) errors.push(`update BaseUrl ${base} is the LEGACY 0.2.x channel — 0.3+ must be published under ${UPDATE_CHANNEL_BASE}`);
    else if (base !== UPDATE_CHANNEL_BASE) errors.push(`update BaseUrl must be ${UPDATE_CHANNEL_BASE}`);
    const def = readUpdateDefault(crm);
    if (def !== `${UPDATE_CHANNEL_BASE}/manifest.json`) errors.push(`VetclinicCrm.psm1 default update URL must be ${UPDATE_CHANNEL_BASE}/manifest.json`);
    info.updateChannel = base;
  } catch { errors.push('update BaseUrl missing/invalid'); }
  if (arg('signing-key')) errors.push(...checkSigningKey(arg('signing-key'), path.join(crm, 'packaging', 'windows', 'update-public-key.pem')).errors);
  else errors.push('update signing key not given');
  return { ok: !errors.length, errors, info };
}

module.exports = { checkConfigKeys, checkPlatformUrl, readPlatformUrl, readUpdateDefault, checkRepo, run, QA_KEY_ID, PROD_PLATFORM, UPDATE_CHANNEL_BASE, LEGACY_UPDATE_BASE, DEFAULT_REMOTES };

if (require.main === module) {
  const r = run(process.argv.slice(2));
  console.log(JSON.stringify({ preflight: r.ok ? 'PASS' : 'FAIL', ...r.info, errors: r.errors }, null, 2));
  process.exit(r.ok ? 0 : 1);
}
