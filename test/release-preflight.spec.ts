import { generateKeyPairSync } from 'node:crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const preflight = require('../packaging/windows/tools/release-preflight.cjs');

/** Official-release preflight: never ship without the PRODUCTION Platform config keys, never trust a QA key. */
describe('release preflight (official CRM PC release)', () => {
  const ed = () => generateKeyPairSync('ed25519');
  const pub = (k = ed()) => k.publicKey.export({ type: 'spki', format: 'pem' }) as string;

  it('accepts an Ed25519 public key under a production-looking keyId and reports its fingerprint', () => {
    const r = preflight.checkConfigKeys(JSON.stringify({ 'crm-pc-config-2026-09': pub() }));
    expect(r.ok).toBe(true);
    expect(r.keys[0]).toMatchObject({ keyId: 'crm-pc-config-2026-09' });
    expect(r.keys[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses QA/test keys, private keys, non-Ed25519 keys, empty or malformed documents', () => {
    for (const id of ['crm-pc-qa', 'demo-key', 'crash-qa', 'test1', 'local-e2e', 'mock']) expect(preflight.checkConfigKeys(JSON.stringify({ [id]: pub() })).ok).toBe(false);
    const k = ed();
    expect(preflight.checkConfigKeys(JSON.stringify({ prod: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) })).errors[0]).toMatch(/PRIVATE/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
    expect(preflight.checkConfigKeys(JSON.stringify({ prod: rsa })).ok).toBe(false);
    expect(preflight.checkConfigKeys('{}').ok).toBe(false);
    expect(preflight.checkConfigKeys('not json').ok).toBe(false);
    expect(preflight.checkConfigKeys(JSON.stringify({ prod: 'not a pem' })).ok).toBe(false);
  });

  it('Platform URL: production HTTPS host/path only, and must equal the URL Platform delivered', () => {
    expect(preflight.checkPlatformUrl('https://admin.vetclinic.vn/api/crm-pc/v1').ok).toBe(true);
    expect(preflight.checkPlatformUrl('https://admin.vetclinic.vn/api/crm-pc/v1', 'https://admin.vetclinic.vn/api/crm-pc/v1/').ok).toBe(true);
    expect(preflight.checkPlatformUrl('http://admin.vetclinic.vn/api/crm-pc/v1').ok).toBe(false);
    expect(preflight.checkPlatformUrl('https://127.0.0.1:47198/api/crm-pc/v1').ok).toBe(false);
    expect(preflight.checkPlatformUrl('https://admin.vetclinic.vn/api/crm-pc/v1', 'https://platform.vetclinic.vn/api/crm-pc/v1').ok).toBe(false);
  });

  it('the packaged Platform config key is exactly the production key Platform delivered (keyId + SPKI fingerprint pinned)', () => {
    const text = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'packaging', 'windows', 'platform-config-keys.json'), 'utf8');
    const r = preflight.checkConfigKeys(text);
    expect(r.ok).toBe(true);
    // Platform production handoff 2026-09-26 (commit 9b08d06): keyId vetclinic-crm-pc-prod-20260926.
    expect(r.keys).toEqual([{ keyId: 'vetclinic-crm-pc-prod-20260926', fingerprint: '3697bd7600cf35c0c93a16a354323017a98c9580020e531be12c47ea874d7810' }]);
  });

  describe('run(): full gate on throwaway git repos (Codex review: cover repo/version/output/BaseUrl/signing-key branches)', () => {
    const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
    const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'safe.directory=*', '-c', 'user.email=qa@example.invalid', '-c', 'user.name=QA', ...a], { cwd, encoding: 'utf8' });
    const realRepo = path.join(__dirname, '..');
    let root = ''; let crm = ''; let sender = ''; let out = ''; let signing = '';
    /** A repo committed and pushed to its own bare upstream. */
    const pushedRepo = (name: string, files: Record<string, string>) => {
      const bare = path.join(root, `${name}.git`); const dir = path.join(root, name);
      g(root, 'init', '-q', '--bare', bare); g(root, 'init', '-q', dir);
      for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
      g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init'); g(dir, 'remote', 'add', 'origin', bare); g(dir, 'push', '-q', '-u', 'origin', 'HEAD');
      return dir;
    };
    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
      const upd = ed();
      signing = path.join(root, 'update-private.pem'); fs.writeFileSync(signing, upd.privateKey.export({ type: 'pkcs8', format: 'pem' }));
      const w = (f: string) => fs.readFileSync(path.join(realRepo, 'packaging', 'windows', f), 'utf8');
      crm = pushedRepo('crm', {
        'packaging/windows/VetclinicCrm.psm1': w('VetclinicCrm.psm1'),
        'packaging/windows/platform-config-keys.json': w('platform-config-keys.json'),
        'packaging/windows/update-public-key.pem': upd.publicKey.export({ type: 'spki', format: 'pem' }) as string,
      });
      sender = pushedRepo('sender', { 'README.md': 'sender\n' });
      out = path.join(root, 'out'); fs.mkdirSync(path.join(out, 'release'), { recursive: true });
    });
    afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } });
    const args = (o: Record<string, string | null> = {}, extra: string[] = []) => {
      const base: Record<string, string | null> = { crm, sender, out, version: '0.3.0-pc', 'signing-key': signing, 'base-url': 'https://vetclinic.vn/tai-ve/crm-pc/v3', 'expect-platform-url': 'https://admin.vetclinic.vn/api/crm-pc/v1', 'sender-remote': 'origin', ...o };
      return [...Object.entries(base).flatMap(([k, v]) => (v === null ? [] : [`--${k}`, v])), ...extra];
    };
    const errs = (a: string[]) => preflight.run(a).errors.join(' | ');

    it('PASS when everything is committed, pushed and correct (and reports public facts only)', () => {
      const r = preflight.run(args());
      expect(r).toMatchObject({ ok: true, errors: [] });
      expect(r.info.platformConfigKeys[0].keyId).toBe('vetclinic-crm-pc-prod-20260926');
      expect(JSON.stringify(r)).not.toMatch(/PRIVATE KEY/);
    });
    it('FAIL on a dirty tree, an unpushed commit, and a branch without upstream', () => {
      fs.writeFileSync(path.join(sender, 'dirty.txt'), 'x');
      expect(errs(args())).toMatch(/Sender: working tree has uncommitted changes/);
      g(sender, 'add', '-A'); g(sender, 'commit', '-q', '-m', 'local only');
      expect(errs(args())).toMatch(/Sender: HEAD .* differs from origin\/.* on the remote/);
      g(sender, 'push', '-q'); expect(preflight.run(args()).ok).toBe(true);
      g(sender, 'checkout', '-q', '-b', 'no-upstream');
      expect(errs(args())).toMatch(/Sender: branch no-upstream has no upstream/);
      g(sender, 'checkout', '-q', '-');
    });
    it('checks the REMOTE itself: a newer commit pushed elsewhere (local tracking ref stale) => FAIL; after pulling => PASS', () => {
      const other = path.join(root, 'sender-other'); g(root, 'clone', '-q', path.join(root, 'sender.git'), other);
      fs.writeFileSync(path.join(other, 'from-elsewhere.txt'), 'y'); g(other, 'add', '-A'); g(other, 'commit', '-q', '-m', 'pushed elsewhere'); g(other, 'push', '-q');
      // Local HEAD still equals the (stale) local tracking ref: the old @{u} check would have passed.
      expect(g(sender, 'rev-parse', 'HEAD').trim()).toBe(g(sender, 'rev-parse', '@{u}').trim());
      expect(errs(args())).toMatch(/Sender: HEAD .* differs from origin\/.* on the remote/);
      g(sender, 'pull', '-q', '--ff-only'); expect(preflight.run(args()).ok).toBe(true);
    });
    it('FAIL when the upstream is not the allowed remote, the remote is unreachable, the branch is gone from the remote, or HEAD is detached', () => {
      // Sender's allowed remote is "vetclinic" by default; this throwaway repo uses "origin".
      expect(errs(args({ 'sender-remote': null }))).toMatch(/Sender: upstream is origin\/.*, expected vetclinic\//);
      const branch = g(sender, 'symbolic-ref', '--short', 'HEAD').trim();
      const url = g(sender, 'remote', 'get-url', 'origin').trim();
      g(sender, 'remote', 'set-url', 'origin', path.join(root, 'does-not-exist.git'));
      const unreachable = errs(args());
      expect(unreachable).toMatch(/Sender: remote "origin" not reachable or not authenticated/);
      expect(unreachable).not.toContain('does-not-exist'); // never prints the remote URL
      g(sender, 'remote', 'set-url', 'origin', url);
      g(sender, 'checkout', '-q', '-b', 'gone'); g(sender, 'push', '-q', '-u', 'origin', 'gone');
      g(path.join(root, 'sender.git'), 'branch', '-D', 'gone'); // deleted on the remote, local tracking ref still there
      expect(errs(args())).toMatch(/Sender: branch gone does not exist on remote "origin"/);
      g(sender, 'checkout', '-q', branch);
      g(sender, 'checkout', '-q', '--detach');
      expect(errs(args())).toMatch(/Sender: HEAD is detached/);
      g(sender, 'checkout', '-q', branch);
      expect(preflight.run(args()).ok).toBe(true);
    });
    it('FAIL on a non-release version or an existing release folder', () => {
      expect(errs(args({ version: '0.3.0-dev' }))).toMatch(/must look like 1\.2\.3-pc/);
      fs.mkdirSync(path.join(out, 'release', '0.3.9-pc'));
      expect(errs(args({ version: '0.3.9-pc' }))).toMatch(/already exists/);
    });
    it('update channel: the legacy 0.2.x address and any non-v3 address are refused; the package must default to the v3 channel', () => {
      expect(errs(args({ 'base-url': 'https://vetclinic.vn/tai-ve/crm-pc' }))).toMatch(/LEGACY 0\.2\.x channel/);
      expect(errs(args({ 'base-url': 'https://vetclinic.vn/tai-ve/crm-pc/v4' }))).toMatch(/must be https:\/\/vetclinic\.vn\/tai-ve\/crm-pc\/v3/);
      const psm = path.join(crm, 'packaging', 'windows', 'VetclinicCrm.psm1'); const orig = fs.readFileSync(psm, 'utf8');
      fs.writeFileSync(psm, orig.replace("'https://vetclinic.vn/tai-ve/crm-pc/v3/manifest.json'", "'https://vetclinic.vn/tai-ve/crm-pc/manifest.json'")); g(crm, 'commit', '-q', '-am', 'legacy default'); g(crm, 'push', '-q');
      expect(errs(args())).toMatch(/default update URL must be https:\/\/vetclinic\.vn\/tai-ve\/crm-pc\/v3\/manifest\.json/);
      fs.writeFileSync(psm, orig); g(crm, 'commit', '-q', '-am', 'v3 default'); g(crm, 'push', '-q');
      expect(preflight.run(args()).ok).toBe(true);
    });
    it('FAIL on a non-HTTPS BaseUrl, any QA-only --allow-local-url flag, a missing BaseUrl, or a wrong expected Platform URL', () => {
      expect(errs(args({ 'base-url': 'http://127.0.0.1:8080/crm-pc' }))).toMatch(/BaseUrl must be HTTPS/);
      expect(errs(args({ 'base-url': 'http://127.0.0.1:8080/crm-pc' }, ['--allow-local-url']))).toMatch(/QA-only/);
      expect(errs(args({ 'base-url': null }))).toMatch(/BaseUrl missing/);
      expect(errs(args({ 'expect-platform-url': 'https://platform.vetclinic.vn/api/crm-pc/v1' }))).toMatch(/differs from the one Platform delivered/);
    });
    it('FAIL when the update signing key does not match the shipped public key, or is missing', () => {
      const other = path.join(root, 'other.pem'); fs.writeFileSync(other, ed().privateKey.export({ type: 'pkcs8', format: 'pem' }));
      expect(errs(args({ 'signing-key': other }))).toMatch(/does not match packaging\/windows\/update-public-key\.pem/);
      expect(errs(args({ 'signing-key': null }))).toMatch(/signing key not given/);
    });
    it('FAIL when platform-config-keys.json is missing (waiting for Platform)', () => {
      expect(errs(args({}, ['--keys', path.join(root, 'nope.json')]))).toMatch(/platform-config-keys\.json missing/);
    });
    it('release.ps1: -AllowDirty always needs a -dev/-qa version (no official-looking build that skips the preflight); an official release refuses a stage that is dirty or from other commits', () => {
      const ps = fs.readFileSync(path.join(realRepo, 'packaging', 'windows', 'release.ps1'), 'utf8');
      expect(ps).toContain("if ($AllowDirty -and $Version -notmatch '-(dev|qa)(\\.|$)') { throw");
      expect(ps).toContain('$official = -not $AllowDirty');
      expect(ps).toContain('if ($official -and $AllowLocalUrl) { throw');
      expect(ps).toContain('[bool]$biCheck.crmSourceDirty -or [bool]$biCheck.senderSourceDirty -or $biCheck.crmCommit -ne $heads[0] -or $biCheck.senderCommit -ne $heads[1]');
    });
    it('release.ps1 runs the preflight for every build without -AllowDirty and stops on failure', () => {
      const ps = fs.readFileSync(path.join(realRepo, 'packaging', 'windows', 'release.ps1'), 'utf8');
      const gate = ps.search(/if \(\$official\) \{\r?\n  \$pfArgs/); const build = ps.indexOf("if (-not $SkipBuild) {\r\n  & powershell.exe") >= 0 ? ps.indexOf("if (-not $SkipBuild) {\r\n  & powershell.exe") : ps.indexOf("if (-not $SkipBuild) {\n  & powershell.exe");
      expect(gate).toBeGreaterThan(0); expect(build).toBeGreaterThan(gate); // gate runs BEFORE build.ps1
      const block = ps.slice(gate, build);
      expect(block).toMatch(/tools\\release-preflight\.cjs/);
      expect(block).toMatch(/if \(\$LASTEXITCODE -ne 0\) \{ throw/);
      for (const a of ['--crm', '--sender', '--version', '--signing-key', '--base-url']) expect(block).toContain(`'${a}'`);
      expect(block).toMatch(/--expect-platform-url/);
    });
  });

  it('the release packaging currently bakes the production Platform URL', () => {
    const url = preflight.readPlatformUrl(require('node:path').join(__dirname, '..'));
    expect(preflight.checkPlatformUrl(url).ok).toBe(true);
  });
});
