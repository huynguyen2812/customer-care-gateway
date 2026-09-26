<#
.SYNOPSIS
  Kiểm tra bản mới trên web VETCLINIC và cập nhật (tác vụ lịch SYSTEM: hằng ngày 03:15 + 15 phút sau khi mở máy).

.DESCRIPTION
  settings.json → updateManifestUrl (HTTPS). Tải manifest.json + manifest.json.sig, kiểm chữ ký Ed25519 bằng khóa công khai
  đi kèm bộ cài (scripts\update-public-key.pem), so phiên bản, tải gói, kiểm SHA-256 + kích thước, rồi gọi update.ps1.
  Web không phản hồi / chữ ký sai / hash sai ⇒ KHÔNG cập nhật, CRM vẫn chạy bình thường. -CheckOnly: chỉ báo có bản mới.
#>
[CmdletBinding()]
param([switch]$CheckOnly, [string]$ManifestUrl)
$ErrorActionPreference = 'Stop'
$scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Split-Path -Parent $scripts
Import-Module (Join-Path $scripts 'VetclinicCrm.psm1') -Force
$c = Get-VcConfig
$settings = Get-VcSettings
$node = Join-Path $appDir 'node\node.exe'
$tool = Join-Path $scripts 'tools\vcupdate.mjs'
$pub = Join-Path $scripts 'update-public-key.pem'
$log = Join-Path $c.LogsDir 'update-check.log'
function Log($m) { Add-Content -Path $log -Encoding UTF8 -Value ("[{0}] {1}" -f (Get-Date -Format 's'), $m); Write-Host $m }
function Status($state, $extra = @{}) { $o = @{ at = (Get-Date).ToUniversalTime().ToString('o'); state = $state } + $extra; $o | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $c.StatusDir 'update-check.json') }
function Tool([string[]]$a) { $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { $o = & $node $tool @a 2>&1 | ForEach-Object { "$_" }; return @{ code = $LASTEXITCODE; out = $o -join "`n" } } finally { $ErrorActionPreference = $prev } }

if (-not $ManifestUrl -and $settings.updateCheck -eq $false) { Log 'Tự kiểm tra cập nhật đang TẮT (settings.json → updateCheck).'; Status 'DISABLED'; exit 0 }
$url = if ($ManifestUrl) { $ManifestUrl } else { [string]$settings.updateManifestUrl }
if (-not $url) { Log 'Chưa cấu hình địa chỉ cập nhật (updateManifestUrl) — bỏ qua.'; Status 'NOT_CONFIGURED'; exit 0 }
if (-not (Test-Path $pub)) { Log 'Thiếu khóa công khai cập nhật — không cập nhật.'; Status 'NO_PUBLIC_KEY'; exit 1 }
$cur = (Get-Content (Join-Path $c.ProgramRoot 'current-version.txt')).Trim()
$work = Join-Path $c.RunDir 'update'
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
  $mf = Join-Path $work 'manifest.json'; $sig = "$mf.sig"
  foreach ($pair in @(@($url, $mf, 1048576), @("$url.sig", $sig, 4096))) {
    $r = Tool @('fetch', $pair[0], $pair[1], "$($pair[2])"); if ($r.code -ne 0) { throw "Không tải được $($pair[0]): $($r.out)" }
  }
  $v = Tool @('verify', $pub, $mf, $sig)
  if ($v.code -ne 0) { throw "Manifest không hợp lệ hoặc sai chữ ký: $($v.out)" }
  $m = $v.out | ConvertFrom-Json
  $n = Tool @('newer', $m.version, $cur)
  if ($n.code -ne 0) { Log "Đang dùng bản mới nhất ($cur)."; Status 'UP_TO_DATE' @{ current = $cur; latest = $m.version }; exit 0 }
  Log "Có bản mới $($m.version) (đang dùng $cur)"
  if ($CheckOnly) { Status 'AVAILABLE' @{ current = $cur; latest = $m.version; notes = [string]$m.notes }; exit 0 }
  $pkg = Join-Path $work 'package.zip'
  $r = Tool @('fetch', $m.packageUrl, $pkg, "$($m.packageSize)"); if ($r.code -ne 0) { throw "Tải gói thất bại: $($r.out)" }
  if ((Get-Item $pkg).Length -ne [long]$m.packageSize) { throw 'Kích thước gói không khớp manifest.' }
  $h = (Tool @('sha256', $pkg)).out.Trim()
  if ($h -ne $m.packageSha256) { throw 'SHA-256 của gói không khớp manifest — không cập nhật.' }
  Log 'Gói hợp lệ (chữ ký + SHA-256) — bắt đầu cập nhật'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'update.ps1') -Package $pkg
  if ($LASTEXITCODE -ne 0) { throw 'update.ps1 báo lỗi (xem update-*.log); bản cũ vẫn chạy.' }
  Status 'UPDATED' @{ from = $cur; to = $m.version }
} catch {
  Log "KHÔNG CẬP NHẬT: $($_.Exception.Message)"
  Status 'ERROR' @{ current = $cur; error = $_.Exception.Message }
  exit 1
} finally {
  if (Test-Path $work) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
}
