<#
.SYNOPSIS
  Build tái lập bản VETCLINIC CRM chạy trên PC (Standalone PC Edition) thành thư mục "stage".

.DESCRIPTION
  - Kiểm SHA-256 mọi công cụ bên thứ ba theo tools.lock.json (sai là dừng).
  - Sao chép mã nguồn đúng theo git (file được theo dõi + file mới chưa bị .gitignore), build sạch trong thư mục tạm
    bằng Node.js đóng gói kèm (không dùng Node của máy build), rồi chỉ giữ dependency production.
  - Không chứa secret nào: secret được sinh lúc cài (install.ps1).
  Kết quả: <OutDir>\app\<version>\{node, crm, sender, pgsql, winsw, scripts} + BUILD-INFO.json.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File build.ps1 -ToolsCache D:\DuAn\crm-standalone\tools-cache `
    -CrmRepo D:\DuAn\crm-standalone\customer-care-gateway -SenderRepo D:\DuAn\crm-standalone\vetclinic-zalo-sender `
    -OutDir D:\DuAn\crm-standalone\build
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$ToolsCache,
  [Parameter(Mandatory)] [string]$CrmRepo,
  [Parameter(Mandatory)] [string]$SenderRepo,
  [Parameter(Mandatory)] [string]$OutDir,
  [string]$Version = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Step($m) { Write-Host "==> $m" }
function Invoke-Checked([string]$exe, [string[]]$argList, [string]$cwd) {
  Push-Location $cwd
  try { & $exe @argList; if ($LASTEXITCODE -ne 0) { throw "$exe $($argList -join ' ') failed ($LASTEXITCODE)" } } finally { Pop-Location }
}
function Copy-GitTree([string]$repo, [string]$dest) {
  # -z + UTF-8: file names with Vietnamese characters must not be quoted/escaped by git.
  $prev = [Console]::OutputEncoding; [Console]::OutputEncoding = [Text.Encoding]::UTF8
  try { $raw = (git -c "safe.directory=*" -c core.quotepath=off -C $repo ls-files -z -co --exclude-standard) -join "`n" } finally { [Console]::OutputEncoding = $prev }
  if ($LASTEXITCODE -ne 0) { throw "git ls-files failed for $repo" }
  $files = $raw -split "[`0`n]" | Where-Object { $_ }
  foreach ($f in $files) {
    $src = Join-Path $repo $f
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { continue }
    $dst = Join-Path $dest $f
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst
  }
  return (git -c "safe.directory=*" -C $repo rev-parse HEAD)
}

# ---------- 1. tools ----------
$lock = Get-Content -Raw (Join-Path $here 'tools.lock.json') | ConvertFrom-Json
foreach ($name in 'node', 'postgresql', 'winsw') {
  $t = $lock.$name; $p = Join-Path $ToolsCache $t.file
  if (-not (Test-Path $p)) { throw "Missing tool $($t.file) in $ToolsCache (download from $($t.url))" }
  $h = (Get-FileHash -Algorithm SHA256 $p).Hash.ToLower()
  if ($h -ne $t.sha256) { throw "SHA-256 mismatch for $($t.file): $h" }
  Step "tool OK $($t.file)"
}

$crmPkg = Get-Content -Raw (Join-Path $CrmRepo 'package.json') | ConvertFrom-Json
if (-not $Version) { $Version = "$($crmPkg.version)-pc" }
$work = Join-Path $OutDir 'work'
$stage = Join-Path $OutDir "stage\app\$Version"
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $work, $stage | Out-Null

# ---------- 2. bundled Node.js (also used for the build itself) ----------
Step 'extract Node.js'
[IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $ToolsCache $lock.node.file), $work)
Move-Item (Join-Path $work ($lock.node.file -replace '\.zip$', '')) (Join-Path $stage 'node')
$nodeDir = Join-Path $stage 'node'
$env:PATH = "$nodeDir;$env:PATH"
$npm = Join-Path $nodeDir 'npm.cmd'
Step "node $(& (Join-Path $nodeDir 'node.exe') -v)"

# ---------- 3. CRM ----------
Step 'build CRM'
$crmSrc = Join-Path $work 'crm-src'
$crmCommit = Copy-GitTree $CrmRepo $crmSrc
Invoke-Checked $npm @('ci', '--no-audit', '--no-fund') $crmSrc
Invoke-Checked $npm @('--prefix', 'web', 'ci', '--no-audit', '--no-fund') $crmSrc
Invoke-Checked $npm @('run', 'db:generate') $crmSrc
Invoke-Checked $npm @('run', 'build') $crmSrc
Invoke-Checked $npm @('run', 'build:web') $crmSrc
Invoke-Checked $npm @('prune', '--omit=dev', '--no-audit', '--no-fund') $crmSrc
$crm = Join-Path $stage 'crm'
New-Item -ItemType Directory -Force -Path $crm | Out-Null
foreach ($d in 'dist', 'public', 'prisma', 'node_modules') { Copy-Item -Recurse (Join-Path $crmSrc $d) (Join-Path $crm $d) }
Copy-Item (Join-Path $crmSrc 'package.json') $crm
# `prisma` (CLI, needed for migrate deploy at install/update) stays in production node_modules as a peer of @prisma/client.
if (-not (Test-Path (Join-Path $crm 'node_modules\prisma\build\index.js'))) { throw 'Prisma CLI missing from CRM node_modules' }

# ---------- 4. Sender (sender-only mode) ----------
Step 'build Sender'
$senderSrc = Join-Path $work 'sender-src'
$senderCommit = Copy-GitTree $SenderRepo $senderSrc
$sb = Join-Path $senderSrc 'backend'
Invoke-Checked $npm @('ci', '--no-audit', '--no-fund') $sb
$env:DATABASE_URL = 'postgresql://build:build@127.0.0.1:1/build'  # prisma.config.ts needs a value; nothing connects
Invoke-Checked (Join-Path $sb 'node_modules\.bin\prisma.cmd') @('generate') $sb
Invoke-Checked $npm @('run', 'build') $sb
Remove-Item Env:DATABASE_URL
Invoke-Checked $npm @('prune', '--omit=dev', '--no-audit', '--no-fund') $sb
$sender = Join-Path $stage 'sender'
New-Item -ItemType Directory -Force -Path (Join-Path $sender 'backend\scripts') | Out-Null
foreach ($d in 'dist', 'prisma', 'node_modules') { Copy-Item -Recurse (Join-Path $sb $d) (Join-Path $sender "backend\$d") }
Copy-Item (Join-Path $sb 'scripts\standalone-provision.mjs') (Join-Path $sender 'backend\scripts')
Copy-Item (Join-Path $sb 'package.json') (Join-Path $sender 'backend')
# Migration config for install/update: no dotenv, datasource from the process environment only.
if (-not (Test-Path (Join-Path $sender 'backend\node_modules\prisma\build\index.js'))) { throw 'Prisma CLI missing from Sender node_modules' }
@"
import { defineConfig, env } from 'prisma/config';
// Used only by install/update (migrate deploy). Paths are relative to this file.
export default defineConfig({ schema: 'prisma/schema.prisma', datasource: { url: env('DATABASE_URL') } });
"@ | Set-Content -Encoding UTF8 (Join-Path $sender 'backend\prisma.migrate.config.ts')
# Not needed at runtime (peers pulled in by prisma): TypeScript compiler and the engine download cache.
# (@prisma/studio-core must stay: the Prisma 7 CLI requires it at startup, even for migrate deploy.)
foreach ($junk in 'crm\node_modules\.cache', 'crm\node_modules\typescript', 'sender\backend\node_modules\typescript', 'sender\backend\node_modules\.cache') {
  $p = Join-Path $stage $junk; if (Test-Path $p) { Remove-Item -Recurse -Force $p }
}
Get-ChildItem $stage -Recurse -Filter '*.map' -File | Remove-Item -Force
# AGPL: giữ nguyên LICENSE/NOTICE/THIRD-PARTY-LICENSES và kèm mã nguồn tương ứng (conveying).
foreach ($f in 'LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md') { Copy-Item (Join-Path $senderSrc $f) $sender }
Step 'package Sender corresponding source'
$srcZip = Join-Path $sender 'sender-source.zip'
$srcOnly = Join-Path $work 'sender-source'
Copy-GitTree $SenderRepo $srcOnly | Out-Null
[IO.Compression.ZipFile]::CreateFromDirectory($srcOnly, $srcZip)

# ---------- 5. PostgreSQL (only what the server needs) ----------
Step 'extract PostgreSQL'
$pgTmp = Join-Path $work 'pg'
$zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $ToolsCache $lock.postgresql.file))
try {
  foreach ($e in $zip.Entries) {
    if ($e.FullName -notmatch '^pgsql/(bin|lib|share)/' -or $e.FullName.EndsWith('/')) { continue }
    if ($e.FullName -match '^pgsql/bin/(pgAdmin|stackbuilder)' -or $e.FullName -match '\.pdb$') { continue }
    $dst = Join-Path $pgTmp $e.FullName
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dst, $true)
  }
} finally { $zip.Dispose() }
Move-Item (Join-Path $pgTmp 'pgsql') (Join-Path $stage 'pgsql')

# ---------- 6. WinSW + scripts ----------
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'winsw'), (Join-Path $stage 'scripts') | Out-Null
Copy-Item (Join-Path $ToolsCache $lock.winsw.file) (Join-Path $stage 'winsw\WinSW-x64.exe')
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'scripts\tools') | Out-Null
foreach ($f in 'tools\vcbackup.mjs', 'tools\vcupdate.mjs') { Copy-Item (Join-Path $here $f) (Join-Path $stage "scripts\$f") }
Copy-Item (Join-Path $here 'update-public-key.pem') (Join-Path $stage 'scripts')
# Platform config-signing PUBLIC keys ({"keyId":"PEM"}), delivered by the Platform task. Without it pairing is disabled.
$pk = Join-Path $here 'platform-config-keys.json'
if (Test-Path $pk) { Copy-Item $pk (Join-Path $stage 'scripts') } else { Step 'NOTE: platform-config-keys.json not provided — Platform pairing disabled in this build' }
foreach ($f in 'install.ps1', 'uninstall.ps1', 'update.ps1', 'check-update.ps1', 'backup.ps1', 'restart-services.ps1', 'tray.ps1', 'diag.ps1', 'launch.ps1', 'VetclinicCrm.psm1', 'README.md') {
  $p = Join-Path $here $f
  # Windows PowerShell 5.1 reads BOM-less scripts as ANSI: Vietnamese text would break parsing.
  if ($f -match '\.ps(m)?1$') { $b = [IO.File]::ReadAllBytes($p); if ($b.Length -lt 3 -or $b[0] -ne 0xEF -or $b[1] -ne 0xBB -or $b[2] -ne 0xBF) { throw "$f must be saved as UTF-8 with BOM" } }
  Copy-Item $p (Join-Path $stage 'scripts')
}

$info = [ordered]@{
  product = 'VETCLINIC CRM Standalone PC Edition'; version = $Version; builtAt = (Get-Date).ToUniversalTime().ToString('o')
  crmCommit = $crmCommit; senderCommit = $senderCommit
  crmSourceDirty = [bool](git -c "safe.directory=*" -C $CrmRepo status --porcelain); senderSourceDirty = [bool](git -c "safe.directory=*" -C $SenderRepo status --porcelain)
  tools = @{ node = $lock.node.file; postgresql = $lock.postgresql.file; winsw = $lock.winsw.file }
}
$info | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $stage 'BUILD-INFO.json')
Remove-Item -Recurse -Force $work
Step "stage ready: $stage"
