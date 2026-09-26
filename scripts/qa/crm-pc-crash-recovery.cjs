#!/usr/bin/env node
/*
 * QA ONLY — real process-kill test of the PENDING activation recovery (CRM PC).
 *
 * - CRM runs as a CHILD PROCESS (`node dist/main.js`, built source) on 127.0.0.1:47102 against a dedicated, freshly
 *   created QA database `ccg_crash_qa` (QA container 127.0.0.1:55499). Refuses any other host/port/database.
 * - Platform is a FAKE in this harness (NOT the real Platform): shared-contract rules for redeem (10-min TTL from code
 *   creation even for retries, same binding ⇒ current answer, revoked device never revived, one primary PC), signed
 *   configs (Ed25519), signed unpair. The real Platform E2E is a separate step (task B2B).
 * - The crash: the fake Platform records the redeem (device bound) and HOLDS the answer; the harness then kills exactly the
 *   CRM child PID (never by process name; never port 47100), restarts CRM with the same database and QA secrets, and
 *   checks the recovery rules. No activation code, private key or secret is printed.
 *
 * Usage (from the repo root, after `npm run build`):  node scripts/qa/crm-pc-crash-recovery.cjs
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const DB_NAME = 'ccg_crash_qa';
const DB_URL = `postgresql://qa:qa_local_only@127.0.0.1:55499/${DB_NAME}`;
const CRM_PORT = 47102;
const ORIGIN = `http://127.0.0.1:${CRM_PORT}`;
const CN1 = '0c0f0000-0000-4000-8000-0000000000c1';
const LOG = path.join(os.tmpdir(), `crm-pc-crash-qa-${Date.now()}.log`);

const u = new URL(DB_URL);
if (u.hostname !== '127.0.0.1' || u.port !== '55499' || u.pathname !== `/${DB_NAME}` || CRM_PORT === 47100) { console.error('REFUSED: not the dedicated QA database/port'); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const mask = (id) => (id ? `${id.slice(0, 4)}…${id.slice(-4)}` : null);

// ---------------------------------------------------------------- fake Platform (QA) ----------------------------------
const cfgKey = crypto.generateKeyPairSync('ed25519');
const platform = { codes: new Map(), devices: new Map(), requestIds: new Map(), redeemCalls: 0, hold: false, held: [], recorded: 0, nonces: new Set() };
const newCode = () => { const c = crypto.randomBytes(6).toString('hex').toUpperCase().replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3'); platform.codes.set(c, { expiresAt: Date.now() + 10 * 60_000 }); return c; };
const adminCreateCode = () => { if ([...platform.devices.values()].some((d) => d.status === 'ACTIVE')) throw new Error('PRIMARY_PC_EXISTS'); return newCode(); };
const payload = (deviceId) => { const now = Date.now(); return { v: 1, type: 'CRM_PC_CONFIG', productCode: 'CUSTOMER_CARE_CRM', revision: 1, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 72 * 3600_000).toISOString(), deviceId, deviceStatus: 'ACTIVE', platformInstallationId: `inst-${deviceId.slice(0, 8)}`, tenant: { id: 'tenant-crash-qa', name: 'PK Crash QA' }, plan: { code: 'CRM_PC_BASIC', status: 'ACTIVE', validFrom: null, validUntil: new Date(now + 365 * 864e5).toISOString() }, sources: [{ product: 'PETCLINIC', allowedBranchIds: [CN1], maxBranches: 3 }], features: { appointmentReminder: true, debtReminder: false }, limits: { dailyQuota: 60 }, reminderLeadMinutes: 1440, quietHours: { start: '00:00', end: '00:00', timezone: 'Asia/Ho_Chi_Minh' }, offlineGraceHours: 72 }; };
const signCfg = (p) => { const b = Buffer.from(JSON.stringify(p)); return { payload: b.toString('base64url'), signature: crypto.sign(null, b, cfgKey.privateKey).toString('base64'), keyId: 'crash-qa' }; };
const canon = (a) => ['VCPDA1', ...a].join('\n');
const server = http.createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
  const send = (s, b) => { if (!res.writableEnded) { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); } };
  const url = new URL(req.url, 'http://x'); const body = raw ? JSON.parse(raw) : {};
  if (url.pathname.endsWith('/devices/redeem')) {
    platform.redeemCalls++;
    const { proof, ...rest } = body;
    if (!crypto.verify(null, Buffer.from(canon(['REDEEM', rest.requestId, rest.deviceId, rest.activationCode, rest.devicePublicKey.trim()])), rest.devicePublicKey, Buffer.from(String(proof), 'base64'))) return send(401, { code: 'DEVICE_PROOF_INVALID' });
    const c = platform.codes.get(body.activationCode); if (!c) return send(403, { code: 'ACTIVATION_CODE_INVALID' });
    if (c.usedBy && (c.usedBy.deviceId !== body.deviceId || c.usedBy.requestId !== body.requestId || c.usedBy.key !== body.devicePublicKey)) return send(409, { code: 'ACTIVATION_CODE_USED' });
    if (c.expiresAt <= Date.now()) return send(403, { code: 'ACTIVATION_CODE_EXPIRED' });
    if (c.usedBy && ['REVOKED', 'UNPAIRED'].includes(platform.devices.get(body.deviceId)?.status)) return send(403, { code: 'DEVICE_REVOKED' });
    platform.requestIds.set(body.activationCode, [...(platform.requestIds.get(body.activationCode) || []), body.requestId]);
    if (!c.usedBy) { c.usedBy = { deviceId: body.deviceId, requestId: body.requestId, key: body.devicePublicKey }; platform.devices.set(body.deviceId, { publicKey: body.devicePublicKey, status: 'ACTIVE' }); }
    platform.recorded++;
    if (platform.hold) { platform.held.push(res); return; } // bound on Platform; answer held until the CRM process is killed
    return send(200, { deviceId: body.deviceId, platformInstallationId: `inst-${body.deviceId.slice(0, 8)}`, config: signCfg(payload(body.deviceId)) });
  }
  const m = url.pathname.match(/\/devices\/([^/]+)\/(sync|unpair)$/);
  if (m) {
    const dev = platform.devices.get(m[1]); if (!dev) return send(401, { code: 'DEVICE_UNKNOWN' });
    const ts = String(req.headers['x-vc-timestamp']); const nonce = String(req.headers['x-vc-nonce']);
    const ok = Math.abs(Date.now() - Number(ts)) < 300_000 && !platform.nonces.has(nonce) && crypto.verify(null, Buffer.from(canon(['POST', url.pathname, ts, nonce, sha(raw)])), dev.publicKey, Buffer.from(String(req.headers['x-vc-signature']), 'base64'));
    if (!ok) return send(401, { code: 'DEVICE_AUTH_INVALID' }); platform.nonces.add(nonce);
    if (dev.status === 'REVOKED') return send(403, { code: 'DEVICE_REVOKED' });
    if (m[2] === 'unpair') { dev.status = 'UNPAIRED'; return send(200, { ok: true }); }
    return send(200, { deviceStatus: 'ACTIVE' });
  }
  send(404, {});
}); });

// ---------------------------------------------------------------- QA database -----------------------------------------
const psql = (...args) => execFileSync('docker', ['exec', 'crm-standalone-qa-pg', 'psql', '-U', 'qa', '-v', 'ON_ERROR_STOP=1', '-qAt', ...args], { encoding: 'utf8' }).trim();
function freshDatabase() {
  psql('-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`, '-c', `CREATE DATABASE ${DB_NAME}`);
  const prismaCli = path.join(REPO, 'node_modules', 'prisma', 'build', 'index.js'); // no shell, no npx
  for (let i = 0; i < 2; i++) {
    const out = execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], { cwd: REPO, env: { ...process.env, DATABASE_URL: DB_URL }, encoding: 'utf8' });
    if (i === 1) check('migrations on the fresh QA database: second deploy has nothing pending', /No pending migrations/.test(out));
  }
}
const regRow = () => { const r = psql('-d', DB_NAME, '-c', `SELECT status, "deviceId", "pendingRequestId", md5("devicePublicKey"), "activationMaybeBound", coalesce("activationError",''), coalesce(to_char("activationLockedUntil" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'') FROM "PlatformDeviceRegistration" WHERE id = 1`); if (!r) return null; const [status, deviceId, pendingRequestId, keyMd5, maybe, err, lease] = r.split('|'); return { status, deviceId, pendingRequestId: pendingRequestId || null, keyMd5, maybeBound: maybe === 't', error: err || null, lease: lease ? new Date(lease) : null }; };

// ---------------------------------------------------------------- CRM child process -----------------------------------
const secrets = { PHONE_HASH_PEPPER: crypto.randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY_BASE64: crypto.randomBytes(32).toString('base64'), CRM_SESSION_SECRET: crypto.randomBytes(32).toString('hex'), DEVICE_KEY_ENC_KEY: crypto.randomBytes(32).toString('hex') };
let crm = null;
async function startCrm(platformBase) {
  const log = fs.openSync(LOG, 'a');
  crm = spawn(process.execPath, ['dist/main.js'], { cwd: REPO, stdio: ['ignore', log, log], env: { ...process.env, ...secrets,
    DEPLOYMENT_MODE: 'standalone', PROCESS_ROLE: 'api', NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(CRM_PORT), CRM_PUBLIC_ORIGIN: ORIGIN, WORKER_ENABLED: 'false',
    DATABASE_URL: DB_URL, PLATFORM_DEVICE_API_URL: `${platformBase}/api/crm-pc/v1`, PLATFORM_DEVICE_ALLOW_INSECURE_LOCAL: '1',
    PLATFORM_CONFIG_PUBLIC_KEYS: JSON.stringify({ 'crash-qa': cfgKey.publicKey.export({ type: 'spki', format: 'pem' }) }) } });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${ORIGIN}/api/v1/health`)).ok) return crm.pid; } catch { /* starting */ } await sleep(500); }
  throw new Error('CRM child did not start');
}
async function killCrm() {
  const pid = crm.pid; const exited = new Promise((r) => crm.once('exit', (code, signal) => r({ code, signal })));
  process.kill(pid, 'SIGKILL'); // exactly this child PID (TerminateProcess on Windows); never by name
  const e = await exited; crm = null; return { pid, ...e };
}

// ---------------------------------------------------------------- CRM HTTP helpers ------------------------------------
let session = { cookie: '', csrf: '' };
async function login() {
  const r = await fetch(`${ORIGIN}/api/v1/crm/auth/local/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ username: 'chu.crash', password: 'Mat-khau-crash-qa-1' }) });
  const cookie = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('vc_crm_session=')).split(';')[0];
  const me = await (await fetch(`${ORIGIN}/api/v1/crm/auth/me`, { headers: { cookie } })).json();
  session = { cookie, csrf: me.csrfToken };
}
const api = async (method, p, body) => { const r = await fetch(`${ORIGIN}/api/v1/crm/local/${p}`, { method, headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrf, origin: ORIGIN }, body: body === undefined ? undefined : JSON.stringify(body) }); let j = {}; try { j = await r.json(); } catch { /* empty */ } return { status: r.status, body: j }; };
let credential = null;
async function signedJob(key) {
  const signingKey = sha(credential.clientSecret);
  const raw = JSON.stringify({ sourceProduct: 'EXTERNAL_CONNECTOR', externalReferenceId: `appointment:${key}`, eventType: 'APPOINTMENT_REMINDER', templateCode: 'APPT_REMINDER_V1', scheduledAt: new Date(Date.now() + 48 * 3600_000).toISOString(), sourceAppointmentAt: new Date(Date.now() + 72 * 3600_000).toISOString(), sourceRevision: 'r1', idempotencyKey: `k-${key}`, consentStatus: 'GRANTED', recipient: { name: 'Khách QA', phone: '0901234567' }, templateVariables: {}, branchId: CN1 });
  const ts = String(Date.now()); const nonce = crypto.randomBytes(12).toString('hex');
  const sig = crypto.createHmac('sha256', signingKey).update(`POST\n/api/v1/care-jobs\n${ts}\n${nonce}\n${sha(raw)}`).digest('hex');
  const r = await fetch(`${ORIGIN}/api/v1/care-jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-care-client-id': credential.clientId, 'x-care-timestamp': ts, 'x-care-nonce': nonce, 'x-care-signature': sig }, body: raw });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function waitLeaseExpiry() { const row = regRow(); if (row?.lease) { const ms = row.lease.getTime() - Date.now() + 1500; if (ms > 0) { console.log(`      waiting ${Math.round(ms / 1000)} s for the 2-minute activation lease to expire…`); await sleep(ms); } } }
/** Starts an activation, waits until Platform has BOUND it (answer held), then kills the CRM child. */
async function crashDuringRedeem(code) {
  platform.hold = true; const before = platform.recorded;
  const pending = fetch(`${ORIGIN}/api/v1/crm/local/platform/activate`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrf, origin: ORIGIN }, body: JSON.stringify({ activationCode: code }) }).catch(() => 'CONNECTION_LOST');
  for (let i = 0; i < 100 && platform.recorded === before; i++) await sleep(100);
  const bound = platform.recorded > before;
  const killed = await killCrm();
  platform.hold = false; for (const r of platform.held.splice(0)) r.socket?.destroy();
  return { bound, killed, clientSaw: await pending };
}

// ---------------------------------------------------------------- scenario ---------------------------------------------
(async () => {
  let exitCode = 1;
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const platformBase = `http://127.0.0.1:${server.address().port}`;
    freshDatabase();
    const pid1 = await startCrm(platformBase);
    const setup = await fetch(`${ORIGIN}/api/v1/crm/auth/local/setup`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ businessName: 'PK Crash QA', username: 'chu.crash', password: 'Mat-khau-crash-qa-1' }) });
    credential = (await setup.json()).apiCredential;
    await login();
    check('CRM child started as a separate process', !!pid1, `pid ${pid1}`);

    // ---- Scenario 1: kill after Platform bound the device, code still valid ----
    const c1 = adminCreateCode();
    const k1 = await crashDuringRedeem(c1);
    check('S1 Platform recorded the redeem (device bound) before the kill', k1.bound);
    check('S1 exactly the CRM child PID was killed', k1.killed.pid === pid1 && (k1.killed.signal === 'SIGKILL' || k1.killed.code !== 0), `pid ${k1.killed.pid}, signal ${k1.killed.signal}, code ${k1.killed.code}`);
    const r1 = regRow();
    check('S1 row left by the killed process: PENDING, maybe bound, request + binding persisted', r1?.status === 'PENDING' && r1.maybeBound && !!r1.pendingRequestId && !r1.error, `device ${mask(r1?.deviceId)}`);
    const pid2 = await startCrm(platformBase); await login();
    check('S1 CRM restarted with the same database and QA keys (new PID)', pid2 !== pid1, `pid ${pid2}`);
    const early = await api('POST', 'platform/activate', { activationCode: newCode() });
    check('S1 while the old lease is still held: another code ⇒ 409 ACTIVATION_IN_PROGRESS', early.status === 409 && early.body.code === 'ACTIVATION_IN_PROGRESS');
    await waitLeaseExpiry();
    const st1 = (await api('GET', 'platform')).body;
    check('S1 after restart + lease expiry: status "retry the same code", not activated', st1.activation?.state === 'RETRY_SAME_CODE' && st1.allowed === false);
    const calls1 = platform.redeemCalls;
    const other = await api('POST', 'platform/activate', { activationCode: newCode() });
    check('S1 a DIFFERENT code is refused (ACTIVATION_RETRY_SAME_CODE) without calling Platform', other.status === 409 && other.body.code === 'ACTIVATION_RETRY_SAME_CODE' && platform.redeemCalls === calls1);
    const r1b = regRow();
    check('S1 binding unchanged after the refused code (requestId, deviceId, key)', r1b.pendingRequestId === r1.pendingRequestId && r1b.deviceId === r1.deviceId && r1b.keyMd5 === r1.keyMd5);
    const same = await api('POST', 'platform/activate', { activationCode: c1 });
    const r1c = regRow();
    check('S1 the SAME code (still valid) completes: ACTIVE with the same deviceId/key', same.status === 200 && r1c.status === 'ACTIVE' && r1c.deviceId === r1.deviceId && r1c.keyMd5 === r1.keyMd5);
    check('S1 one device on Platform; every redeem of the code used the same requestId', platform.devices.size === 1 && new Set(platform.requestIds.get(c1)).size === 1 && platform.requestIds.get(c1)[0] === r1.pendingRequestId);

    // ---- Scenario 2: kill after binding, then the code expires ⇒ confirmed recovery ----
    const un = await api('POST', 'platform/unpair', { confirm: 'NGAT GHEP NOI' });
    check('S2 start: confirmed unpair of the active PC (Platform confirms)', un.status === 200 && un.body.reset?.platform === 'PLATFORM_UNPAIRED');
    const c3 = adminCreateCode();
    const k3 = await crashDuringRedeem(c3);
    check('S2 Platform bound the device, then the CRM child was killed', k3.bound && k3.killed.pid === pid2, `pid ${k3.killed.pid}`);
    const r3 = regRow();
    check('S2 row left by the killed process: PENDING, maybe bound', r3.status === 'PENDING' && r3.maybeBound && !!r3.pendingRequestId, `device ${mask(r3.deviceId)}`);
    const pid3 = await startCrm(platformBase); await login();
    platform.codes.get(c3).expiresAt = Date.now() - 1; // the 10-minute code lifetime is over (Platform side)
    await waitLeaseExpiry();
    const exp = await api('POST', 'platform/activate', { activationCode: c3 });
    const r3b = regRow();
    check('S2 expired code after an unknown outcome: 403 ACTIVATION_CODE_EXPIRED and the binding is NOT released', exp.status === 403 && exp.body.code === 'ACTIVATION_CODE_EXPIRED' && r3b.maybeBound && r3b.pendingRequestId === r3.pendingRequestId && r3b.deviceId === r3.deviceId);
    const calls3 = platform.redeemCalls;
    const again = await api('POST', 'platform/activate', { activationCode: c3 });
    const other3 = await api('POST', 'platform/activate', { activationCode: newCode() });
    check('S2 no endless retry: same code ⇒ ACTIVATION_RECOVERY_REQUIRED, other code ⇒ ACTIVATION_RETRY_SAME_CODE, no Platform call', again.body.code === 'ACTIVATION_RECOVERY_REQUIRED' && other3.body.code === 'ACTIVATION_RETRY_SAME_CODE' && platform.redeemCalls === calls3);
    let blocked = false; try { adminCreateCode(); } catch { blocked = true; }
    check('S2 Platform refuses a new code while the orphan device holds the primary-PC slot', blocked);
    platform.devices.get(r3.deviceId).status = 'REVOKED'; // step 1: Platform admin revokes the orphan
    const cancel = await api('POST', 'platform/unpair', { confirm: '' });
    check('S2 cancelled/wrong confirmation changes nothing', cancel.body.code === 'CONFIRM_REQUIRED' && regRow().status === 'PENDING');
    const rec = await api('POST', 'platform/unpair', { confirm: 'NGAT GHEP NOI' });
    check('S2 confirmed local reset reports the Platform result separately (already revoked)', rec.status === 200 && rec.body.reset?.local === 'UNPAIRED' && rec.body.reset?.platform === 'PLATFORM_ALREADY_REVOKED');
    const job = await signedJob('CRASH-QA-UNPAIRED');
    check('S2 not re-activated yet ⇒ care job creation refused (local API key still valid)', job.status === 403 && job.body.message === 'PLATFORM_UNPAIRED');
    const c4 = adminCreateCode();
    const fresh = await api('POST', 'platform/activate', { activationCode: c4 });
    const r4 = regRow();
    check('S2 new code ⇒ ACTIVE with a NEW deviceId/key; the old device stays REVOKED', fresh.status === 200 && r4.status === 'ACTIVE' && r4.deviceId !== r3.deviceId && r4.keyMd5 !== r3.keyMd5 && platform.devices.get(r3.deviceId).status === 'REVOKED');
    await api('PUT', 'source-connector', { sourceKind: 'PETCLINIC', apiBaseUrl: `${platformBase}/src`, allowedBranchIds: [CN1], active: true });
    const job2 = await signedJob('CRASH-QA-ACTIVE');
    check('S2 after re-activation a care job can be created again (licensed branch)', job2.status === 201);
    check('logs contain no activation code', ![c1, c3, c4].some((c) => fs.readFileSync(LOG, 'utf8').includes(c)));
    exitCode = results.every((r) => r.ok) ? 0 : 1;
    void pid3;
  } catch (e) {
    console.error('HARNESS ERROR:', e && e.message ? e.message : e);
  } finally {
    if (crm) { try { await killCrm(); } catch { /* already gone */ } }
    server.close();
    try { psql('-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME}`); } catch { /* keep going */ }
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed. CRM log: ${LOG}`);
    process.exit(exitCode);
  }
})();
