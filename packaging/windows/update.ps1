<#
.SYNOPSIS
  Cập nhật VETCLINIC CRM (bản PC) lên phiên bản mới. Administrator / SYSTEM.

.DESCRIPTION
  Nguồn bản mới: -Package <zip đã kiểm chữ ký + SHA-256 bởi check-update.ps1> hoặc -NewAppDir <thư mục đã chép bởi bộ cài .exe>.
  Trình tự an toàn:
   1. Bật dừng khẩn cấp; chờ hết tác vụ PROCESSING (tối đa 10 phút, quá thì HỦY cập nhật, không đụng gì).
   2. Sao lưu (backup.ps1). Sao lưu lỗi ⇒ HỦY cập nhật.
   3. Dừng 3 dịch vụ Node; migration forward-only bằng bản mới. Migration lỗi ⇒ chạy lại bản cũ, báo lỗi.
   4. Trỏ dịch vụ sang bản mới, khởi động, kiểm tra sức khỏe. Không khỏe ⇒ QUAY VỀ BẢN CŨ (chỉ chương trình;
      database KHÔNG bị rollback phá hủy — migration chỉ thêm, bản cũ vẫn chạy được trên schema mới).
   5. Trả dừng khẩn cấp về trạng thái trước đó; giữ lại bản cũ để quay về; ghi status\update-status.json.
#>
[CmdletBinding()]
param([string]$Package, [string]$NewAppDir, [int]$DrainMinutes = 10)
$ErrorActionPreference = 'Stop'
$scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $scripts 'VetclinicCrm.psm1') -Force
$c = Get-VcConfig
$log = Join-Path $c.LogsDir ("update-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
function Log($m) { $l = "[{0}] {1}" -f (Get-Date -Format 's'), $m; Add-Content -Path $log -Encoding UTF8 -Value $l; Write-Host $l }
function Status($state, $extra = @{}) { $o = @{ at = (Get-Date).ToUniversalTime().ToString('o'); state = $state } + $extra; $o | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $c.StatusDir 'update-status.json') }
function Native([string]$exe, [string[]]$a, [string]$stdin = $null) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = if ($null -ne $stdin) { $stdin | & $exe @a 2>&1 } else { & $exe @a 2>&1 }; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  $out | ForEach-Object { Add-Content -Path $log -Encoding UTF8 -Value "    $_" }
  return @{ code = $code; out = ($out | ForEach-Object { "$_" }) -join "`n" }
}
function With-Env([System.Collections.IDictionary]$vars, [scriptblock]$block) {
  $saved = @{}; foreach ($k in $vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $vars[$k], 'Process') }
  try { & $block } finally { foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') } }
}

$curVer = (Get-Content (Join-Path $c.ProgramRoot 'current-version.txt') -ErrorAction Stop).Trim()
$oldApp = Join-Path $c.ProgramRoot "app\$curVer"
if (-not (Test-Path $oldApp)) { throw "Không thấy bản đang chạy $oldApp" }

# ---------- 0. new app folder ----------
if ($Package) {
  $staging = Join-Path $c.ProgramRoot ('app\.staging-' + (New-VcRandom 4 'hex'))
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($Package, $staging)
  $newInfo = Get-Content -Raw (Join-Path $staging 'BUILD-INFO.json') | ConvertFrom-Json
  $NewAppDir = Join-Path $c.ProgramRoot "app\$($newInfo.version)"
  if (Test-Path $NewAppDir) { Remove-Item -Recurse -Force $staging; throw "Phiên bản $($newInfo.version) đã có sẵn." }
  Move-Item $staging $NewAppDir
}
if (-not $NewAppDir -or -not (Test-Path (Join-Path $NewAppDir 'BUILD-INFO.json'))) { throw 'Cần -Package hoặc -NewAppDir hợp lệ.' }
$newVer = (Get-Content -Raw (Join-Path $NewAppDir 'BUILD-INFO.json') | ConvertFrom-Json).version
if ($newVer -eq $curVer) { Log "Đang chạy $curVer rồi — không cần cập nhật."; exit 0 }
Log "Cập nhật $curVer → $newVer"
Status 'RUNNING' @{ from = $curVer; to = $newVer }

$s = Unprotect-VcSecrets $c.SecretsFile
# Secrets introduced by newer versions (e.g. DEVICE_KEY_ENC_KEY for the Platform device agent) are generated once here.
if (Add-VcMissingSecrets $s) { Protect-VcSecrets $s $c.SecretsFile; Log 'Đã bổ sung secret mới cho phiên bản này (không ghi giá trị).' }
$pgBin = Join-Path $oldApp 'pgsql\bin'
$psqlArgs = @('-h', '127.0.0.1', '-p', "$($c.PgPort)", '-U', $c.PgSuperUser, '-d', $c.CrmDb, '-v', 'ON_ERROR_STOP=1', '-tA', '-f', '-')
function Sql([string]$q) { With-Env @{ PGPASSWORD = $s.PG_SUPERUSER_PASSWORD } { Native (Join-Path $pgBin 'psql.exe') $psqlArgs $q } }

$killBefore = $null; $switched = $false
try {
  # ---------- 1. emergency stop + drain ----------
  $killBefore = (Sql "SELECT value::text FROM ""SystemSetting"" WHERE key = 'kill_switch';").out.Trim()
  $r = Sql "INSERT INTO ""SystemSetting"" (key, value, ""updatedBy"", ""updatedAt"") VALUES ('kill_switch', '{""enabled"":true,""reason"":""UPDATE""}', 'updater', NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, ""updatedBy"" = 'updater', ""updatedAt"" = NOW();"
  if ($r.code -ne 0) { throw 'Không bật được dừng khẩn cấp.' }
  Log 'Đã bật dừng khẩn cấp; chờ hết tác vụ đang gửi (PROCESSING)'
  $deadline = (Get-Date).AddMinutes($DrainMinutes)
  do {
    $n = [int]((Sql "SELECT count(*) FROM ""CareJob"" WHERE status = 'PROCESSING';").out.Trim())
    if ($n -eq 0) { break }
    Start-Sleep -Seconds 15
  } while ((Get-Date) -lt $deadline)
  if ($n -ne 0) { throw "Còn $n tác vụ đang gửi sau $DrainMinutes phút — hủy cập nhật, không thay đổi gì." }

  # ---------- 2. backup ----------
  Log 'Sao lưu trước khi cập nhật'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $oldApp 'scripts\backup.ps1') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Sao lưu thất bại — hủy cập nhật.' }

  # ---------- 3. stop + migrate ----------
  foreach ($name in $c.NodeServices.Values) { Stop-Service -Name $name -Force }
  Log 'Migration CRM + Sender (forward-only) bằng bản mới'
  $node = Join-Path $NewAppDir 'node\node.exe'
  $m1 = With-Env (Get-VcServiceEnv 'api' $s $NewAppDir) { Push-Location (Join-Path $NewAppDir 'crm'); try { Native $node @('node_modules\prisma\build\index.js', 'migrate', 'deploy', '--schema', 'prisma\schema.prisma') } finally { Pop-Location } }
  $m2 = if ($m1.code -eq 0) { With-Env (Get-VcServiceEnv 'sender' $s $NewAppDir) { Push-Location (Join-Path $NewAppDir 'sender\backend'); try { Native $node @('node_modules\prisma\build\index.js', 'migrate', 'deploy', '--config', 'prisma.migrate.config.ts') } finally { Pop-Location } } } else { @{ code = 1 } }
  if ($m1.code -ne 0 -or $m2.code -ne 0) {
    foreach ($name in $c.NodeServices.Values) { Start-Service -Name $name }
    throw 'Migration thất bại — đã chạy lại bản cũ.'
  }

  # ---------- 4. switch + health, rollback binaries on failure ----------
  foreach ($role in $c.NodeServices.Keys) { Write-VcServiceXml $role $NewAppDir }
  $switched = $true
  foreach ($name in $c.NodeServices.Values) { Start-Service -Name $name }
  $healthy = (Wait-VcHttp "http://127.0.0.1:$($c.CrmPort)/api/v1/health" 120) -and (Wait-VcHttp "http://127.0.0.1:$($c.SenderPort)/health" 120)
  if (-not $healthy) {
    Log 'Bản mới không khỏe — QUAY VỀ bản cũ (database giữ nguyên)'
    foreach ($name in $c.NodeServices.Values) { Stop-Service -Name $name -Force -ErrorAction SilentlyContinue }
    foreach ($role in $c.NodeServices.Keys) { Write-VcServiceXml $role $oldApp }
    $switched = $false
    foreach ($name in $c.NodeServices.Values) { Start-Service -Name $name }
    $back = (Wait-VcHttp "http://127.0.0.1:$($c.CrmPort)/api/v1/health" 120)
    throw ("Cập nhật thất bại, đã quay về {0} (khỏe={1})." -f $curVer, $back)
  }
  Set-Content -Path (Join-Path $c.ProgramRoot 'current-version.txt') -Value $newVer -Encoding ASCII
  Register-VcTasks $NewAppDir
  # Keep the previous version for manual rollback; remove older ones.
  Get-ChildItem (Join-Path $c.ProgramRoot 'app') -Directory | Where-Object { $_.Name -notin @($newVer, $curVer) -and -not $_.Name.StartsWith('.') } | Remove-Item -Recurse -Force
  Log "CẬP NHẬT OK → $newVer"
  Status 'OK' @{ from = $curVer; to = $newVer }
} catch {
  Log "LỖI: $($_.Exception.Message)"
  Status 'FAILED' @{ from = $curVer; to = $newVer; error = $_.Exception.Message }
  $failed = $true
} finally {
  # Restore the emergency stop exactly as it was before the update.
  if ($null -ne $killBefore) {
    if ($killBefore) { Sql ("UPDATE ""SystemSetting"" SET value = '{0}'::jsonb, ""updatedBy"" = 'updater', ""updatedAt"" = NOW() WHERE key = 'kill_switch';" -f $killBefore.Replace("'", "''")) | Out-Null }
    else { Sql "DELETE FROM ""SystemSetting"" WHERE key = 'kill_switch' AND ""updatedBy"" = 'updater';" | Out-Null }
  }
  $s.Clear()
}
if ($failed) { exit 1 }
