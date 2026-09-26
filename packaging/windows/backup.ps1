<#
.SYNOPSIS
  Sao lưu / kiểm tra / thử khôi phục VETCLINIC CRM (bản PC). Chạy bằng SYSTEM (tác vụ lịch hằng ngày) hoặc Administrator.

.DESCRIPTION
  (mặc định)          pg_dump 2 database → 1 file .vcbak mã hóa AES-256-GCM trong C:\ProgramData\VETCLINIC CRM\backup\
                      (+ chép ra thư mục ngoài nếu cấu hình), giữ N bản mới nhất, ghi backup\last-backup.json.
  -Verify <file>      giải mã toàn bộ + pg_restore --list từng dump (không đổi dữ liệu).
  -TestRestore <file> khôi phục vào database tạm vc_restore_test_*, đếm bảng chính, rồi xóa database tạm.
  File .vcbak kèm "gói khóa" chỉ mở được bằng KHÓA KHÔI PHỤC do khách giữ ⇒ dùng được khi PC hỏng (xem restore trong install.ps1).
#>
[CmdletBinding()]
param([string]$Verify, [string]$TestRestore)
$ErrorActionPreference = 'Stop'
$scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Split-Path -Parent $scripts
Import-Module (Join-Path $scripts 'VetclinicCrm.psm1') -Force
$c = Get-VcConfig
$settings = Get-VcSettings
$pgBin = Join-Path $appDir 'pgsql\bin'
$node = Join-Path $appDir 'node\node.exe'
$tool = Join-Path $scripts 'tools\vcbackup.mjs'
$log = Join-Path $c.LogsDir 'backup.log'
function Log($m) { Add-Content -Path $log -Encoding UTF8 -Value ("[{0}] {1}" -f (Get-Date -Format 's'), $m); Write-Host $m }
function Native([string]$exe, [string[]]$a) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & $exe @a 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $prev }
  return @{ code = $LASTEXITCODE; out = $out }
}

$s = Unprotect-VcSecrets $c.SecretsFile
$env:PGPASSWORD = $s.PG_SUPERUSER_PASSWORD
$env:VCBAK_KEY_HEX = $s.BACKUP_KEY
$wrap = $s.RECOVERY_WRAP
$s.Clear()
$tmp = Join-Path $c.BackupDir ('tmp-' + (New-VcRandom 6 'hex'))
$pgArgs = @('-h', '127.0.0.1', '-p', "$($c.PgPort)", '-U', $c.PgSuperUser)
try {
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  if ($Verify -or $TestRestore) {
    $file = if ($Verify) { $Verify } else { $TestRestore }
    $r = Native $node @($tool, 'unpack', $file, $tmp)
    if ($r.code -ne 0) { throw "Giải mã thất bại: $($r.out -join ' ')" }
    foreach ($d in 'crm.dump', 'sender.dump') {
      $l = Native (Join-Path $pgBin 'pg_restore.exe') @('--list', (Join-Path $tmp $d))
      if ($l.code -ne 0) { throw "$d không đọc được" }
    }
    if ($TestRestore) {
      $db = 'vc_restore_test_' + (Get-Date -Format 'yyyyMMddHHmmss')
      $x = Native (Join-Path $pgBin 'createdb.exe') ($pgArgs + @('-O', $c.CrmUser, $db)); if ($x.code -ne 0) { throw 'createdb thất bại' }
      try {
        $x = Native (Join-Path $pgBin 'pg_restore.exe') ($pgArgs + @('--no-owner', '--role', $c.CrmUser, '-d', $db, (Join-Path $tmp 'crm.dump'))); if ($x.code -ne 0) { throw "pg_restore thất bại: $($x.out | Select-Object -Last 3)" }
        # SQL through stdin: Windows PowerShell 5.1 strips the double quotes of native-command arguments.
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $counts = ('SELECT (SELECT count(*) FROM "CareJob") || '','' || (SELECT count(*) FROM "CrmTenant") || '','' || (SELECT count(*) FROM "LocalUser");' |
          & (Join-Path $pgBin 'psql.exe') @($pgArgs + @('-d', $db, '-v', 'ON_ERROR_STOP=1', '-tA', '-f', '-')) 2>&1 | ForEach-Object { "$_" } | Select-Object -First 1)
        $ErrorActionPreference = $prev
        if ($counts -notmatch '^\d+,\d+,\d+$') { throw "Không đọc được dữ liệu đã khôi phục: $counts" }
      } finally { Native (Join-Path $pgBin 'dropdb.exe') ($pgArgs + @('--if-exists', $db)) | Out-Null }
      Log "THỬ KHÔI PHỤC OK $(Split-Path -Leaf $file): CareJob,CrmTenant,LocalUser = $counts (database tạm đã xóa)"
    } else { Log "KIỂM TRA OK $(Split-Path -Leaf $file)" }
    return
  }

  if (-not $wrap) { throw 'Chưa có gói khóa khôi phục (RECOVERY_WRAP) — cài bản cũ? Chạy lại install để tạo khóa khôi phục.' }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  foreach ($pair in @(@($c.CrmDb, 'crm.dump'), @($c.SenderDb, 'sender.dump'))) {
    $x = Native (Join-Path $pgBin 'pg_dump.exe') ($pgArgs + @('-Fc', '-d', $pair[0], '-f', (Join-Path $tmp $pair[1])))
    if ($x.code -ne 0) { throw "pg_dump $($pair[0]) thất bại" }
  }
  $info = Get-Content -Raw (Join-Path $appDir 'BUILD-INFO.json') | ConvertFrom-Json
  @{ product = 'VETCLINIC CRM PC'; version = $info.version; createdAt = (Get-Date).ToUniversalTime().ToString('o'); databases = @($c.CrmDb, $c.SenderDb) } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $tmp 'manifest.json')
  $out = Join-Path $c.BackupDir "vetclinic-crm-$stamp.vcbak"
  $env:VCBAK_WRAP = $wrap
  $x = Native $node @($tool, 'pack', $out, (Join-Path $tmp 'manifest.json'), (Join-Path $tmp 'crm.dump'), (Join-Path $tmp 'sender.dump'))
  if ($x.code -ne 0) { throw "Mã hóa bản sao lưu thất bại: $($x.out -join ' ')" }
  $v = Native $node @($tool, 'verify', $out); if ($v.code -ne 0) { throw 'Bản sao lưu vừa tạo không kiểm tra được' }
  $size = (Get-Item $out).Length
  if ($settings.backupExtraDir) {
    try { New-Item -ItemType Directory -Force -Path $settings.backupExtraDir | Out-Null; Copy-Item $out $settings.backupExtraDir; Log "Đã chép ra $($settings.backupExtraDir)" }
    catch { Log "CẢNH BÁO: không chép được ra thư mục ngoài: $($_.Exception.Message)" }
  }
  $keep = [Math]::Max(1, [int]$settings.backupKeep)
  foreach ($dir in @($c.BackupDir) + @($settings.backupExtraDir | Where-Object { $_ })) {
    Get-ChildItem $dir -Filter 'vetclinic-crm-*.vcbak' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -Skip $keep | Remove-Item -Force
  }
  @{ at = (Get-Date).ToUniversalTime().ToString('o'); file = (Split-Path -Leaf $out); size = $size; ok = $true } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $c.StatusDir 'last-backup.json')
  Log "SAO LƯU OK $(Split-Path -Leaf $out) ($([Math]::Round($size / 1MB, 1)) MB, giữ $keep bản)"
} catch {
  Log "LỖI SAO LƯU: $($_.Exception.Message)"
  if (-not ($Verify -or $TestRestore)) { @{ at = (Get-Date).ToUniversalTime().ToString('o'); ok = $false; error = $_.Exception.Message } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $c.StatusDir 'last-backup.json') }
  exit 1
} finally {
  Remove-Item Env:PGPASSWORD, Env:VCBAK_KEY_HEX, Env:VCBAK_WRAP -ErrorAction SilentlyContinue
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
}
