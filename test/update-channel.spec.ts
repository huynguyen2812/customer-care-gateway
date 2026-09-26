import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Update-channel separation 0.2.x → 0.3.x (no unsafe auto-upgrade of 0.2.x installs).
 *
 * The 0.2.x updater cannot add DEVICE_KEY_ENC_KEY, so a 0.3 package installed by it can never be activated. Evidence here
 * runs the REAL 0.2.1 updater tool (test/fixtures/legacy-0.2.1/vcupdate.mjs, byte-identical copy of the installed
 * C:\Program Files\VETCLINIC CRM\app\0.2.1-pc\scripts\tools\vcupdate.mjs, sha256 below) and the new tool against manifests
 * served over HTTP on 127.0.0.1 (VC_UPDATE_ALLOW_LOCAL=1 — the same local-QA switch both tools implement). No real web.
 */
const ROOT = path.join(__dirname, '..');
const LEGACY_TOOL = path.join(__dirname, 'fixtures', 'legacy-0.2.1', 'vcupdate.mjs');
const NEW_TOOL = path.join(ROOT, 'packaging', 'windows', 'tools', 'vcupdate.mjs');
const LEGACY_SHA256 = '12b0aff9bc6af2a9a93c8493c98315aff03b95e5c250d65ac1a1bb75421711c6';

describe('update channel separation (0.2.x legacy channel vs 0.3.x v3 channel)', () => {
  jest.setTimeout(120_000);
  let dir = ''; let pub = ''; let priv = ''; let server: http.Server; let base = '';
  const files = new Map<string, Buffer>();
  // Async on purpose: the test HTTP server lives in this process, a synchronous child would dead-lock it.
  const tool = (t: string, args: string[], env: Record<string, string> = {}) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [t, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, VC_UPDATE_ALLOW_LOCAL: '1', ...env } }, (err, stdout, stderr) => resolve({ status: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, stdout, stderr }));
  });
  /** Publishes a signed manifest (+ its package) at <urlPath>/manifest.json on the local test server. */
  function publish(urlPath: string, manifest: Record<string, unknown>) {
    const pkg = Buffer.from(`package ${manifest.version} ${urlPath}`);
    const body = Buffer.from(JSON.stringify({ ...manifest, packageUrl: `${base}${urlPath}/vetclinic-crm-${manifest.version}.zip`, packageSha256: createHash('sha256').update(pkg).digest('hex'), packageSize: pkg.length }));
    files.set(`${urlPath}/manifest.json`, body);
    files.set(`${urlPath}/manifest.json.sig`, Buffer.from(sign(null, body, fs.readFileSync(priv, 'utf8')).toString('base64')));
    files.set(`${urlPath}/vetclinic-crm-${manifest.version}.zip`, pkg);
  }
  /** What check-update.ps1 does before handing a package to update.ps1: fetch manifest + sig, verify, compare versions. */
  async function updaterDecision(t: string, manifestUrl: string, current: string, env: Record<string, string> = {}): Promise<{ install: boolean; version?: string; reason?: string }> {
    const mf = path.join(dir, `m-${Math.random().toString(36).slice(2)}.json`);
    for (const [u, out] of [[manifestUrl, mf], [`${manifestUrl}.sig`, `${mf}.sig`]]) { const r = await tool(t, ['fetch', u, out, '1048576'], env); if (r.status !== 0) return { install: false, reason: `FETCH ${r.stderr.trim()}` }; }
    const v = await tool(t, ['verify', pub, mf, `${mf}.sig`], env);
    if (v.status !== 0) return { install: false, reason: v.stderr.trim() };
    const m = JSON.parse(v.stdout);
    const n = await tool(t, ['newer', m.version, current], env);
    return n.status === 0 ? { install: true, version: m.version as string } : { install: false, reason: 'UP_TO_DATE' };
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-channel-'));
    const k = generateKeyPairSync('ed25519'); // test-only signing key (never the real update key)
    pub = path.join(dir, 'update-public-key.pem'); priv = path.join(dir, 'update-private.pem');
    fs.writeFileSync(pub, k.publicKey.export({ type: 'spki', format: 'pem' })); fs.writeFileSync(priv, k.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    server = http.createServer((req, res) => { const b = files.get(new URL(req.url!, 'http://x').pathname); if (!b) { res.writeHead(404).end(); return; } res.writeHead(200).end(b); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Legacy channel: what a 0.2.x release would publish. v3 channel: what release.ps1 now writes (official / QA).
    publish('/tai-ve/crm-pc', { product: 'VETCLINIC CRM PC', version: '0.2.3-pc', publishedAt: new Date().toISOString(), notes: '' });
    publish('/tai-ve/crm-pc/v3', { product: 'VETCLINIC CRM PC v3', channel: 'v3', version: '0.3.0-pc', publishedAt: new Date().toISOString(), notes: '' });
    publish('/qa/v3', { product: 'VETCLINIC CRM PC v3', channel: 'v3-qa', version: '0.3.1-qa', publishedAt: new Date().toISOString(), notes: '' });
    // Mistake scenario: someone publishes the 0.3 manifest at the LEGACY address.
    publish('/mistake/crm-pc', { product: 'VETCLINIC CRM PC v3', channel: 'v3', version: '0.3.0-pc', publishedAt: new Date().toISOString(), notes: '' });
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

  it('the legacy fixture is byte-identical to the installed 0.2.1 updater tool', () => {
    expect(createHash('sha256').update(fs.readFileSync(LEGACY_TOOL)).digest('hex')).toBe(LEGACY_SHA256);
  });

  it('control: the real 0.2.1 updater still installs a legacy-channel manifest (so the test would catch a broken setup)', async () => {
    expect(await updaterDecision(LEGACY_TOOL, `${base}/tai-ve/crm-pc/manifest.json`, '0.2.1-pc')).toEqual({ install: true, version: '0.2.3-pc' });
  });

  it('the real 0.2.1 updater REFUSES a 0.3 (v3) manifest — at the v3 address and even if published by mistake at the legacy address', async () => {
    for (const u of [`${base}/tai-ve/crm-pc/v3/manifest.json`, `${base}/mistake/crm-pc/manifest.json`]) {
      const d = await updaterDecision(LEGACY_TOOL, u, '0.2.1-pc');
      expect(d.install).toBe(false);
      expect(d.reason).toMatch(/MANIFEST_INVALID/);
    }
  });

  it('the new updater installs v3 manifests only: legacy-channel and QA-channel manifests are refused (QA only with VC_UPDATE_ALLOW_QA=1)', async () => {
    expect(await updaterDecision(NEW_TOOL, `${base}/tai-ve/crm-pc/v3/manifest.json`, '0.2.1-pc')).toEqual({ install: true, version: '0.3.0-pc' });
    expect((await updaterDecision(NEW_TOOL, `${base}/tai-ve/crm-pc/manifest.json`, '0.2.1-pc')).reason).toMatch(/MANIFEST_INVALID/);
    expect((await updaterDecision(NEW_TOOL, `${base}/qa/v3/manifest.json`, '0.3.0-pc')).reason).toMatch(/MANIFEST_INVALID/);
    expect(await updaterDecision(NEW_TOOL, `${base}/qa/v3/manifest.json`, '0.3.0-pc', { VC_UPDATE_ALLOW_QA: '1' })).toEqual({ install: true, version: '0.3.1-qa' });
  });

  it('release.ps1 writes the v3 product/channel (official "v3", QA "v3-qa") and never the legacy product', () => {
    const ps = fs.readFileSync(path.join(ROOT, 'packaging', 'windows', 'release.ps1'), 'utf8');
    expect(ps).toMatch(/product = 'VETCLINIC CRM PC v3'; channel = \$\(if \(\$official\) \{ 'v3' \} else \{ 'v3-qa' \}\)/);
    expect(ps).not.toMatch(/product = 'VETCLINIC CRM PC';/);
    const vc = fs.readFileSync(NEW_TOOL, 'utf8');
    expect(vc).toMatch(/export const MANIFEST_PRODUCT = 'VETCLINIC CRM PC v3';/);
  });

  const pwsh = process.platform === 'win32' ? 'powershell.exe' : null;
  (pwsh ? it : it.skip)('a 0.3 install (after the .exe upgrade) reads the v3 channel: empty or legacy updateManifestUrl ⇒ v3; a custom URL is kept', () => {
    const psm = path.join(ROOT, 'packaging', 'windows', 'VetclinicCrm.psm1');
    const cases: [string | null, string][] = [
      [null, 'https://vetclinic.vn/tai-ve/crm-pc/v3/manifest.json'],
      ['', 'https://vetclinic.vn/tai-ve/crm-pc/v3/manifest.json'],
      ['https://vetclinic.vn/tai-ve/crm-pc/manifest.json', 'https://vetclinic.vn/tai-ve/crm-pc/v3/manifest.json'],
      ['https://mirror.example.invalid/crm/manifest.json', 'https://mirror.example.invalid/crm/manifest.json'],
    ];
    for (const [setting, expected] of cases) {
      const pd = fs.mkdtempSync(path.join(dir, 'pd-')); const data = path.join(pd, 'VETCLINIC CRM'); fs.mkdirSync(data);
      if (setting !== null) fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ backupKeep: 14, updateManifestUrl: setting, updateCheck: true }));
      const out = execFileSync(pwsh!, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$env:ProgramData='${pd}'; Import-Module '${psm}' -Force; (Get-VcSettings).updateManifestUrl`], { encoding: 'utf8' }).trim();
      expect(out).toBe(expected);
    }
  });
});
