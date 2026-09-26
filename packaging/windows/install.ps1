<#
.SYNOPSIS
  Cài VETCLINIC CRM (bản chạy trên PC). Chạy bằng quyền Administrator (bộ cài .exe gọi script này).

.DESCRIPTION
  1. Chép chương trình vào C:\Program Files\VETCLINIC CRM\app\<version>\ (bỏ qua khi -InPlace: bộ cài đã chép sẵn).
  2. Tạo C:\ProgramData\VETCLINIC CRM\ (ACL: SYSTEM + Administrators; tài khoản dịch vụ chỉ được đúng thư mục cần).
  3. Sinh secret bằng CSPRNG, bọc DPAPI (LocalMachine) — không in ra màn hình, không ghi log.
     Sinh KHÓA KHÔI PHỤC (khách tự giữ, không lưu trên máy) bọc khóa sao lưu + khóa dữ liệu; ghi ra -RecoveryOut một lần.
  4. PostgreSQL 17 riêng (127.0.0.1:55432, scram-sha-256, TimeZone UTC), 2 database/role riêng cho CRM và Sender.
  5. Cài mới: migration + tạo Gateway client Sender. Khôi phục (-RestoreFrom + env VC_RECOVERY_KEY): mở gói khóa trong
     bản sao lưu bằng khóa khôi phục, nạp lại dữ liệu, rồi migration (forward-only).
  6. 4 Windows Service (DB + API + Worker + Sender), tác vụ sao lưu hằng ngày, tác vụ kiểm tra cập nhật, khay hệ thống.
  Không mở cổng ra mạng: mọi dịch vụ chỉ nghe 127.0.0.1.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$StageDir,
  [switch]$InPlace,
  [string]$RecoveryOut = '',
  [string]$RestoreFrom = '',
  # The .exe installer passes the recovery key in a temp file (never on a command line); read then deleted at once.
  [string]$RecoveryKeyFile = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Cần chạy bằng quyền Administrator.' }
Import-Module (Join-Path $StageDir 'scripts\VetclinicCrm.psm1') -Force
$c = Get-VcConfig
$info = Get-Content -Raw (Join-Path $StageDir 'BUILD-INFO.json') | ConvertFrom-Json
$appDir = if ($InPlace) { (Resolve-Path $StageDir).Path } else { Join-Path $c.ProgramRoot "app\$($info.version)" }
New-Item -ItemType Directory -Force -Path $c.LogsDir | Out-Null
$logFile = Join-Path $c.LogsDir ("install-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
function Log($m) { $line = "[{0}] {1}" -f (Get-Date -Format 's'), $m; Write-Host $line; Add-Content -Path $logFile -Value $line -Encoding UTF8 }
function Run([string]$exe, [string[]]$a, [string]$what) {
  # PowerShell 5.1 turns every native stderr line into an error record; only the exit code decides failure.
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $exe @a 2>&1 | ForEach-Object { Add-Content -Path $logFile -Value "    $_" -Encoding UTF8 } } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { throw "$what thất bại (mã $LASTEXITCODE). Xem $logFile" }
}
<# Native command whose stdout we need (may contain secrets: never logged). #>
function Capture([string]$exe, [string[]]$a, [string]$stdin = $null) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = if ($null -ne $stdin) { $stdin | & $exe @a 2>$null } else { & $exe @a 2>$null }; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  return @{ code = $code; out = ($out -join "`n") }
}
function Set-Acl-Strict([string]$path) {
  Run 'icacls.exe' @($path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F') "ACL $path"
}
function With-Env([System.Collections.IDictionary]$vars, [scriptblock]$block) {
  $saved = @{}; foreach ($k in $vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $vars[$k], 'Process') }
  try { & $block } finally { foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') } }
}

$restoring = [bool]$RestoreFrom
Log ("VETCLINIC CRM PC — {0} phiên bản {1}" -f $(if ($restoring) { 'KHÔI PHỤC' } else { 'cài mới' }), $info.version)
foreach ($svc in @($c.DbService) + @($c.NodeServices.Values)) { if (Get-Service -Name $svc -ErrorAction SilentlyContinue) { throw "Dịch vụ $svc đã tồn tại. Dùng update.ps1 để cập nhật, hoặc uninstall.ps1 (giữ dữ liệu) trước." } }
foreach ($port in $c.PgPort, $c.CrmPort, $c.SenderPort) { if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw "Cổng $port đang bị dùng." } }
if (Test-Path (Join-Path $c.DbDir 'PG_VERSION')) { throw "Đã có dữ liệu trong $($c.DbDir). Không cài đè lên dữ liệu cũ; dùng update.ps1 hoặc gỡ và khôi phục từ bản sao lưu." }
if ($restoring -and -not (Test-Path $RestoreFrom)) { throw "Không thấy file sao lưu $RestoreFrom" }
if ($RecoveryKeyFile) {
  if (Test-Path $RecoveryKeyFile) { $env:VC_RECOVERY_KEY = (Get-Content -Raw $RecoveryKeyFile).Trim(); Remove-Item -Force $RecoveryKeyFile }
}
if ($restoring -and -not $env:VC_RECOVERY_KEY) { throw 'Khôi phục cần khóa khôi phục (biến môi trường VC_RECOVERY_KEY).' }

# ---------- 1. program files ----------
if (-not $InPlace) {
  Log "Chép chương trình vào $appDir"
  New-Item -ItemType Directory -Force -Path $appDir | Out-Null
  & robocopy.exe $StageDir $appDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy thất bại ($LASTEXITCODE)" }
}
New-Item -ItemType Directory -Force -Path $c.ProgramRoot | Out-Null
Set-Content -Path (Join-Path $c.ProgramRoot 'current-version.txt') -Value $info.version -Encoding ASCII
$node = Join-Path $appDir 'node\node.exe'
$pgBin = Join-Path $appDir 'pgsql\bin'
$vcbak = Join-Path $appDir 'scripts\tools\vcbackup.mjs'

# ---------- 2. data folders ----------
Log "Tạo thư mục dữ liệu $($c.DataRoot)"
foreach ($d in $c.DataRoot, $c.DbDir, $c.SecretsDir, $c.LogsDir, $c.RunDir, $c.StatusDir, $c.SenderDir, (Join-Path $c.SenderDir 'uploads'), $c.BackupDir) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
Set-Acl-Strict $c.DataRoot
# status\ holds only non-sensitive JSON (backup/update/heartbeat) so the tray icon of any local user can read it.
Run 'icacls.exe' @($c.StatusDir, '/grant', '*S-1-5-32-545:(OI)(CI)RX') 'ACL status (Users đọc)'
Run 'icacls.exe' @($c.DataRoot, '/grant', '*S-1-5-32-545:(X)') 'ACL traverse (Users)'
if (-not (Test-Path (Join-Path $c.DataRoot 'settings.json'))) { Set-VcSettings @{} }

# ---------- 3. secrets (never printed) + recovery key ----------
Log 'Sinh secret (CSPRNG) và bọc DPAPI LocalMachine'
$s = @{
  PG_SUPERUSER_PASSWORD = New-VcRandom 24 'hex'; CRM_DB_PASSWORD = New-VcRandom 24 'hex'; SENDER_DB_PASSWORD = New-VcRandom 24 'hex'
  DATA_ENCRYPTION_KEY_BASE64 = New-VcRandom 32 'base64'; PHONE_HASH_PEPPER = New-VcRandom 32 'hex'; CRM_SESSION_SECRET = New-VcRandom 32 'hex'
  SENDER_JWT_SECRET = New-VcRandom 32 'hex'; SENDER_ENCRYPTION_KEY = New-VcRandom 32 'hex'
  GATEWAY_SENDER_ENC_KEY = New-VcRandom 32 'hex'; ZALO_SESSION_ENC_KEY = New-VcRandom 32 'hex'
  SENDER_V2_CLIENT_ID = 'vetclinic-crm-pc'; SENDER_V2_SIGNING_KEY = ''; BACKUP_KEY = New-VcRandom 32 'hex'; RECOVERY_WRAP = ''
  # Machine-only: protects the Platform device key. Deliberately NOT in the backup bundle (a restore elsewhere re-pairs).
  DEVICE_KEY_ENC_KEY = New-VcRandom 32 'hex'
}
# Keys that make old data readable. The Zalo session key is deliberately NOT included: a new PC re-logs in by QR.
$bundleKeys = 'BACKUP_KEY', 'DATA_ENCRYPTION_KEY_BASE64', 'PHONE_HASH_PEPPER', 'GATEWAY_SENDER_ENC_KEY', 'SENDER_ENCRYPTION_KEY', 'SENDER_V2_CLIENT_ID', 'SENDER_V2_SIGNING_KEY'
if ($restoring) {
  Log 'Mở gói khóa trong bản sao lưu bằng khóa khôi phục'
  $r = With-Env @{ VCBAK_RECOVERY_KEY = $env:VC_RECOVERY_KEY } { Capture $node @($vcbak, 'open-backup-keys', $RestoreFrom) }
  if ($r.code -ne 0) { throw 'Khóa khôi phục sai hoặc file sao lưu hỏng.' }
  $opened = $r.out | ConvertFrom-Json
  foreach ($k in $bundleKeys) { $s[$k] = [string]$opened.bundle.$k }
  $s.RECOVERY_WRAP = ($opened.wrap | ConvertTo-Json -Compress)   # same recovery key keeps working
  $opened = $null; $r = $null
}
Protect-VcSecrets $s $c.SecretsFile

# ---------- 4. PostgreSQL ----------
Log 'Khởi tạo PostgreSQL 17'
# initdb drops the Administrators group (restricted token), so the installing user itself needs temporary access to
# the data folder and the one-time password file (kept in the user's own TEMP, deleted right after).
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$pwFile = Join-Path $env:TEMP ('vccrm-pw-' + (New-VcRandom 8 'hex') + '.tmp')
Run 'icacls.exe' @($c.DbDir, '/grant', "*${me}:(OI)(CI)F") 'ACL db (tạm cho người cài)'
try {
  [IO.File]::WriteAllText($pwFile, $s.PG_SUPERUSER_PASSWORD)
  Run (Join-Path $pgBin 'initdb.exe') @('-D', $c.DbDir, '-U', $c.PgSuperUser, "--pwfile=$pwFile", '-E', 'UTF8', '--locale=C', '-A', 'scram-sha-256') 'initdb'
} finally {
  if (Test-Path $pwFile) { Remove-Item -Force $pwFile }
  Run 'icacls.exe' @($c.DbDir, '/remove:g', "*$me", '/T', '/C', '/Q') 'Thu hồi quyền tạm trên db'
}
Add-Content -Path (Join-Path $c.DbDir 'postgresql.conf') -Encoding ASCII -Value @"

# --- VETCLINIC CRM PC ---
listen_addresses = '127.0.0.1'
port = $($c.PgPort)
password_encryption = scram-sha-256
# Prisma stores UTC in timestamp-without-time-zone columns: the server must run in UTC (CRM refuses to start otherwise).
timezone = 'UTC'
log_timezone = 'UTC'
logging_collector = on
log_filename = 'postgresql-%a.log'
log_truncate_on_rotation = on
log_rotation_age = 1d
"@
Set-Content -Path (Join-Path $c.DbDir 'pg_hba.conf') -Encoding ASCII -Value @"
# VETCLINIC CRM PC: TCP from this machine only, scram-sha-256 password required.
host    all    all    127.0.0.1/32    scram-sha-256
"@
Run 'icacls.exe' @($c.DbDir, '/grant', '*S-1-5-20:(OI)(CI)F') 'ACL db (NetworkService)'
Run (Join-Path $pgBin 'pg_ctl.exe') @('register', '-N', $c.DbService, '-D', $c.DbDir, '-S', 'auto', '-U', 'NT AUTHORITY\NetworkService', '-w') 'Đăng ký dịch vụ PostgreSQL'
Run 'sc.exe' @('description', $c.DbService, 'VETCLINIC CRM - co so du lieu (PostgreSQL 17, chi 127.0.0.1)') 'Mô tả dịch vụ DB'
Start-Service $c.DbService
$env:PGPASSWORD = $s.PG_SUPERUSER_PASSWORD
try {
  $ready = $false
  for ($i = 0; $i -lt 60 -and -not $ready; $i++) { & (Join-Path $pgBin 'pg_isready.exe') -h 127.0.0.1 -p $c.PgPort -q; $ready = $LASTEXITCODE -eq 0; if (-not $ready) { Start-Sleep 1 } }
  if (-not $ready) { throw 'PostgreSQL không sẵn sàng.' }
  Log 'Tạo database/role riêng cho CRM và Sender'
  $sql = @"
CREATE ROLE $($c.CrmUser) LOGIN PASSWORD '$($s.CRM_DB_PASSWORD)';
CREATE ROLE $($c.SenderUser) LOGIN PASSWORD '$($s.SENDER_DB_PASSWORD)';
CREATE DATABASE $($c.CrmDb) OWNER $($c.CrmUser) ENCODING 'UTF8' TEMPLATE template0;
CREATE DATABASE $($c.SenderDb) OWNER $($c.SenderUser) ENCODING 'UTF8' TEMPLATE template0;
REVOKE CONNECT ON DATABASE $($c.CrmDb) FROM PUBLIC;
REVOKE CONNECT ON DATABASE $($c.SenderDb) FROM PUBLIC;
"@
  # SQL via stdin: passwords never appear on a command line.
  $x = Capture (Join-Path $pgBin 'psql.exe') @('-h', '127.0.0.1', '-p', "$($c.PgPort)", '-U', $c.PgSuperUser, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-') $sql
  if ($x.code -ne 0) { throw 'Tạo database thất bại.' }
  if ($restoring) {
    Log "Nạp dữ liệu từ $(Split-Path -Leaf $RestoreFrom)"
    $tmp = Join-Path $c.BackupDir ('restore-' + (New-VcRandom 6 'hex'))
    try {
      $r = With-Env @{ VCBAK_KEY_HEX = $s.BACKUP_KEY } { Capture $node @($vcbak, 'unpack', $RestoreFrom, $tmp) }
      if ($r.code -ne 0) { throw 'Giải mã bản sao lưu thất bại.' }
      foreach ($pair in @(@($c.CrmDb, $c.CrmUser, 'crm.dump'), @($c.SenderDb, $c.SenderUser, 'sender.dump'))) {
        Run (Join-Path $pgBin 'pg_restore.exe') @('-h', '127.0.0.1', '-p', "$($c.PgPort)", '-U', $c.PgSuperUser, '--no-owner', '--role', $pair[1], '--exit-on-error', '-d', $pair[0], (Join-Path $tmp $pair[2])) "Nạp $($pair[0])"
      }
    } finally { if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp } }
  }
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }

# ---------- 5. migrations + sender client ----------
Log 'Migration CRM (forward-only)'
With-Env (Get-VcServiceEnv 'api' $s $appDir) { Push-Location (Join-Path $appDir 'crm'); try { Run $node @('node_modules\prisma\build\index.js', 'migrate', 'deploy', '--schema', 'prisma\schema.prisma') 'Migration CRM' } finally { Pop-Location } }
Log 'Migration Sender (forward-only)'
With-Env (Get-VcServiceEnv 'sender' $s $appDir) { Push-Location (Join-Path $appDir 'sender\backend'); try { Run $node @('node_modules\prisma\build\index.js', 'migrate', 'deploy', '--config', 'prisma.migrate.config.ts') 'Migration Sender' } finally { Pop-Location } }
if (-not $restoring) {
  Log 'Tạo Gateway client nội bộ cho Sender'
  $r = With-Env (Get-VcServiceEnv 'sender' $s $appDir) {
    Push-Location (Join-Path $appDir 'sender\backend')
    try { Capture $node @('scripts/standalone-provision.mjs', $s.SENDER_V2_CLIENT_ID, "http://127.0.0.1:$($c.CrmPort)/api/v1/channel/accounts/:id/health") } finally { Pop-Location }
  }
  if ($r.code -ne 0) { throw "Tạo Sender client thất bại (mã $($r.code))" }
  $s.SENDER_V2_SIGNING_KEY = (($r.out -split "`n") | Where-Object { $_ -like '{*' } | Select-Object -Last 1 | ConvertFrom-Json).signingKey
  if (-not $s.SENDER_V2_SIGNING_KEY) { throw 'Không nhận được khóa ký Sender.' }

  Log 'Tạo khóa khôi phục (khách tự giữ — không lưu trên máy)'
  $bundle = @{}; foreach ($k in $bundleKeys) { $bundle[$k] = $s[$k] }
  $r = Capture $node @($vcbak, 'recovery-init') ($bundle | ConvertTo-Json -Compress)
  $bundle.Clear()
  if ($r.code -ne 0) { throw 'Tạo khóa khôi phục thất bại.' }
  $rec = $r.out | ConvertFrom-Json
  $s.RECOVERY_WRAP = ($rec.wrap | ConvertTo-Json -Compress)
  $kit = @"
VETCLINIC CRM — KHÓA KHÔI PHỤC
================================
Khóa: $($rec.recoveryKey)
Tạo lúc: $(Get-Date -Format 'dd/MM/yyyy HH:mm')   Máy: $env:COMPUTERNAME

- In ra giấy hoặc chép vào nơi an toàn NGOÀI máy này, rồi XÓA file này.
- Khi máy hỏng: cài VETCLINIC CRM trên máy mới, chọn Khôi phục, nhập khóa này + file sao lưu (.vcbak).
- VETCLINIC KHÔNG giữ bản sao khóa này. Mất khóa + hỏng máy = KHÔNG khôi phục được dữ liệu.
"@
  if ($RecoveryOut) {
    Set-Content -Path $RecoveryOut -Value $kit -Encoding UTF8
    Run 'icacls.exe' @($RecoveryOut, '/inheritance:r', '/grant:r', "*${me}:F", '*S-1-5-18:F') 'ACL file khóa khôi phục'
    Log "Đã ghi khóa khôi phục (một lần) cho người cài"
  } else {
    Write-Host ''; Write-Host $kit; Write-Host ''   # interactive manual install only; not written to the log file
  }
  $rec = $null; $kit = $null; $r = $null
}
Protect-VcSecrets $s $c.SecretsFile
$s.Clear()

# ---------- 6. Windows services (WinSW) ----------
$servicesDir = Join-Path $c.ProgramRoot 'services'
New-Item -ItemType Directory -Force -Path $servicesDir | Out-Null
foreach ($role in $c.NodeServices.Keys) {
  $name = $c.NodeServices[$role]
  Copy-Item (Join-Path $appDir 'winsw\WinSW-x64.exe') (Join-Path $servicesDir "$name.exe") -Force
  Write-VcServiceXml $role $appDir
  Run (Join-Path $servicesDir "$name.exe") @('install') "Đăng ký dịch vụ $name"
  # Virtual service account (NT SERVICE\<name>): no password, no admin rights.
  Run 'sc.exe' @('config', $name, 'obj=', "NT SERVICE\$name") "Tài khoản dịch vụ $name"
  Run 'icacls.exe' @($c.SecretsDir, '/grant', "NT SERVICE\${name}:(OI)(CI)R") "ACL secrets $name"
  Run 'icacls.exe' @($c.LogsDir, '/grant', "NT SERVICE\${name}:(OI)(CI)M") "ACL logs $name"
  Run 'icacls.exe' @($c.DataRoot, '/grant', "NT SERVICE\${name}:(X)") "ACL traverse $name"
}
Run 'icacls.exe' @($c.StatusDir, '/grant', "NT SERVICE\$($c.NodeServices.worker):(OI)(CI)M") 'ACL status (worker)'
Run 'icacls.exe' @($c.SenderDir, '/grant', "NT SERVICE\$($c.NodeServices.sender):(OI)(CI)M") 'ACL sender'

Log 'Khởi động dịch vụ'
foreach ($name in $c.NodeServices.Values) { Start-Service $name }
$okCrm = Wait-VcHttp "http://127.0.0.1:$($c.CrmPort)/api/v1/health" 120
$okSender = Wait-VcHttp "http://127.0.0.1:$($c.SenderPort)/health" 120
Log ("Sức khỏe: CRM={0}, Sender={1}" -f $okCrm, $okSender)

# ---------- 7. scheduled tasks, tray, shortcuts ----------
Register-VcTasks $appDir
$shortcut = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\VETCLINIC CRM.url'
"[InternetShortcut]`r`nURL=http://127.0.0.1:$($c.CrmPort)/`r`n" | Set-Content -Path $shortcut -Encoding ASCII
Log ("Xong. Mở http://127.0.0.1:{0}/ {1}" -f $c.CrmPort, $(if ($restoring) { 'và đăng nhập bằng tài khoản cũ; kênh Zalo cần quét QR lại.' } else { 'để thiết lập doanh nghiệp lần đầu.' }))
if (-not ($okCrm -and $okSender)) { Log 'CẢNH BÁO: có dịch vụ chưa phản hồi; xem log trong thư mục logs.'; exit 2 }
