#!/usr/bin/env node
/*
 * QA ONLY — reproducible fingerprints of the CRM PC source and build, for the Platform (task B2B) E2E rerun.
 *
 * SOURCE = src/**\/*.ts, prisma/schema.prisma, prisma/migrations/**\/*.sql, web/src/**\/*.{ts,tsx,css}, package.json,
 *          package-lock.json. Text is normalised CRLF→LF before hashing (so a Windows autocrlf checkout and an LF checkout
 *          give the same value).
 * DIST   = dist/**\/*.js (backend build, excluding .map/.d.ts) and public/** (web build), hashed as raw bytes.
 * Each set: sha256 over the sorted lines "<sha256(file)>  <relative/path>\n". Paths use "/".
 * --verify-build: recompiles src with the repo's tsconfig IN MEMORY (nothing written) and compares every emitted .js with
 *                 dist/ byte for byte (after CRLF→LF), proving dist matches the current source.
 *
 * Usage (repo root): node scripts/qa/crm-pc-fingerprint.cjs [--verify-build]
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const lf = (b) => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
function walk(dir, keep) {
  const out = [];
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(rel, keep));
    else if (keep(rel)) out.push(rel);
  }
  return out;
}
function digest(files, normalise) {
  const lines = files.sort().map((f) => `${sha(normalise ? lf(fs.readFileSync(path.join(REPO, f))) : fs.readFileSync(path.join(REPO, f)))}  ${f}\n`);
  return { count: files.length, sha256: sha(lines.join('')) };
}

const sourceFiles = [
  ...walk('src', (f) => f.endsWith('.ts')),
  'prisma/schema.prisma',
  ...walk('prisma/migrations', (f) => f.endsWith('.sql')),
  ...walk('web/src', (f) => /\.(ts|tsx|css)$/.test(f)),
  'package.json', 'package-lock.json',
];
const distJs = walk('dist', (f) => f.endsWith('.js'));
const webDist = walk('public', () => true);
const result = {
  source: digest(sourceFiles, true),
  backendSourceOnly: digest(walk('src', (f) => f.endsWith('.ts')), true),
  distBackendJs: digest(distJs, false),
  distWeb: digest(webDist, false),
};

if (process.argv.includes('--verify-build')) {
  const ts = require(path.join(REPO, 'node_modules', 'typescript'));
  const cfgPath = path.join(REPO, 'tsconfig.json');
  const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, REPO);
  const emitted = new Map();
  // In-memory emit: incremental/tsBuildInfo are build-cache options only and do not change the emitted JavaScript.
  const program = ts.createProgram(cfg.fileNames, { ...cfg.options, sourceMap: false, declaration: false, noEmit: false, incremental: false, tsBuildInfoFile: undefined });
  const emit = program.emit(undefined, (file, text) => { if (file.endsWith('.js')) emitted.set(path.relative(REPO, file).split(path.sep).join('/'), text); });
  const diag = ts.getPreEmitDiagnostics(program).concat(emit.diagnostics).filter((d) => d.category === ts.DiagnosticCategory.Error);
  let same = 0; const differ = []; const missing = [];
  for (const [rel, text] of emitted) {
    const onDisk = path.join(REPO, rel);
    if (!fs.existsSync(onDisk)) { missing.push(rel); continue; }
    const a = text.replace(/\r\n/g, '\n').replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n').trimEnd();
    const b = fs.readFileSync(onDisk, 'utf8').replace(/\r\n/g, '\n').replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n').trimEnd();
    if (a === b) same++; else differ.push(rel);
  }
  const extra = distJs.filter((f) => !emitted.has(f));
  result.verifyBuild = { tsErrors: diag.length, emitted: emitted.size, identical: same, differ, missingInDist: missing, extraInDist: extra, ok: diag.length === 0 && same === emitted.size && !extra.length };
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.verifyBuild && !result.verifyBuild.ok ? 1 : 0);
