<#
  Biểu tượng khay hệ thống VETCLINIC CRM (bản thử, PowerShell + WinForms). Chạy bằng người dùng đang đăng nhập, KHÔNG đọc
  secret: chỉ đọc trạng thái dịch vụ Windows, /api/v1/local-status (số liệu, không dữ liệu cá nhân), /health của Sender
  và các file trạng thái trong C:\ProgramData\VETCLINIC CRM\status. Thao tác cần quyền (sao lưu, khởi động lại, cập nhật)
  mở hộp thoại UAC.
#>
param([switch]$StatusOnly)   # -StatusOnly: print what the icon would show and exit (support / QA)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $scripts 'VetclinicCrm.psm1') -Force
$c = Get-VcConfig
$created = $false
$mutex = New-Object Threading.Mutex($true, 'Local\VetclinicCrmTray', [ref]$created)
if (-not $created) { exit 0 }

function Get-Json($url) { try { return Invoke-RestMethod -UseBasicParsing -TimeoutSec 4 $url } catch { return $null } }
function Read-Status($name) { $p = Join-Path $c.StatusDir $name; if (Test-Path $p) { try { return Get-Content -Raw $p | ConvertFrom-Json } catch { } }; return $null }
function Elevated([string]$script, [string]$extra = '') {
  Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $scripts $script)`" $extra"
}

function Get-State {
  $svc = @{}; foreach ($n in @($c.DbService) + @($c.NodeServices.Values)) { $s = Get-Service $n; $svc[$n] = if ($s) { "$($s.Status)" } else { 'Missing' } }
  $local = Get-Json "http://127.0.0.1:$($c.CrmPort)/api/v1/local-status"
  $sender = Get-Json "http://127.0.0.1:$($c.SenderPort)/health"
  $hb = Read-Status 'worker-heartbeat.json'
  $hbAge = if ($hb) { ((Get-Date).ToUniversalTime() - ([datetime]$hb.at).ToUniversalTime()).TotalSeconds } else { 9999 }
  $backup = Read-Status 'last-backup.json'
  $lines = @()
  $bad = @($svc.GetEnumerator() | Where-Object { $_.Value -ne 'Running' } | ForEach-Object { $_.Key })
  $level = 'ok'
  if ($bad.Count) { $level = 'error'; $lines += "Dịch vụ dừng: $($bad -join ', ')" }
  if (-not $local) { $level = 'error'; $lines += 'CRM không phản hồi' }
  if (-not $sender -or $sender.status -ne 'ok') { $level = 'error'; $lines += 'Sender Zalo không phản hồi' }
  if ($hbAge -gt 60) { $level = 'error'; $lines += 'Worker không hoạt động' }
  if ($local) {
    if ($local.setupRequired) { if ($level -eq 'ok') { $level = 'warn' }; $lines += 'Chưa thiết lập doanh nghiệp' }
    if ($local.emergencyStop) { if ($level -eq 'ok') { $level = 'warn' }; $lines += 'ĐANG DỪNG KHẨN CẤP' }
    if ($local.platform -and $local.platform.activationRequired) { if ($level -eq 'ok') { $level = 'warn' }; $lines += 'Chưa kích hoạt Platform - chưa gửi tin' }
    elseif ($local.platform -and -not $local.platform.allowed) { if ($level -eq 'ok') { $level = 'warn' }; $lines += "Platform: tạm dừng gửi ($($local.platform.reason))" }
    if ($local.zalo.total -eq 0 -or $local.zalo.connected -eq 0) { if ($level -eq 'ok') { $level = 'warn' }; $lines += 'Chưa có tài khoản Zalo kết nối' }
    elseif ($local.zalo.needLogin -gt 0) { if ($level -eq 'ok') { $level = 'warn' }; $lines += "$($local.zalo.needLogin) tài khoản Zalo cần đăng nhập" }
    if ($local.queue.deliveryUncertain -gt 0) { if ($level -eq 'ok') { $level = 'warn' }; $lines += "$($local.queue.deliveryUncertain) tin chưa rõ đã gửi" }
    $lines += "Hàng đợi: $($local.queue.queued) chờ, $($local.queue.processing) đang gửi, $($local.queue.sent24h) đã gửi 24h"
    if ($local.source.configured) { $lines += "Nguồn dữ liệu: $(if ($local.source.active) { 'bật' } else { 'tắt' }), đồng bộ $($local.source.lastSyncAt)" }
  }
  if (-not $backup) { if ($level -eq 'ok') { $level = 'warn' }; $lines += 'Chưa có bản sao lưu' }
  elseif (-not $backup.ok) { if ($level -eq 'ok') { $level = 'warn' }; $lines += 'Sao lưu gần nhất LỖI' }
  else { $lines += "Sao lưu gần nhất: $(([datetime]$backup.at).ToLocalTime().ToString('dd/MM HH:mm'))" }
  return @{ level = $level; lines = $lines }
}

if ($StatusOnly) { Get-State | ConvertTo-Json; $mutex.ReleaseMutex(); exit 0 }

$icon = New-Object Windows.Forms.NotifyIcon
$icon.Visible = $true
$menu = New-Object Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add('Đang kiểm tra…'); $statusItem.Enabled = $false
[void]$menu.Items.Add('-')
($menu.Items.Add('Mở VETCLINIC CRM')).add_Click({ Start-Process "http://127.0.0.1:$($c.CrmPort)/" })
($menu.Items.Add('Sao lưu ngay')).add_Click({ Elevated 'backup.ps1' })
($menu.Items.Add('Tạo gói chẩn đoán (gửi hỗ trợ)')).add_Click({ Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $scripts 'diag.ps1')`" -Open" })
($menu.Items.Add('Khởi động lại dịch vụ')).add_Click({ Elevated 'restart-services.ps1' "-ResultFile `"$(Join-Path $c.StatusDir 'restart-result.json')`"" })
($menu.Items.Add('Kiểm tra cập nhật')).add_Click({ Elevated 'check-update.ps1' })
($menu.Items.Add('Giấy phép và ghi công')).add_Click({ Start-Process "http://127.0.0.1:$($c.CrmPort)/#/giay-phep" })
[void]$menu.Items.Add('-')
($menu.Items.Add('Ẩn biểu tượng')).add_Click({ $icon.Visible = $false; [Windows.Forms.Application]::Exit() })
$icon.ContextMenuStrip = $menu
$icon.add_DoubleClick({ Start-Process "http://127.0.0.1:$($c.CrmPort)/" })

$last = ''
$refresh = {
  $st = Get-State
  $icon.Icon = switch ($st.level) { 'ok' { [Drawing.SystemIcons]::Information } 'warn' { [Drawing.SystemIcons]::Warning } default { [Drawing.SystemIcons]::Error } }
  $title = switch ($st.level) { 'ok' { 'VETCLINIC CRM: hoạt động bình thường' } 'warn' { 'VETCLINIC CRM: cần chú ý' } default { 'VETCLINIC CRM: có lỗi' } }
  $icon.Text = $title.Substring(0, [Math]::Min(63, $title.Length))
  $statusItem.Text = ($st.lines -join "`n")
  if ($st.level -ne $last -and $last) { $icon.ShowBalloonTip(5000, $title, (($st.lines | Select-Object -First 3) -join "`n"), [Windows.Forms.ToolTipIcon]::None) }
  Set-Variable -Scope 1 -Name last -Value $st.level
}
& $refresh
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 30000
$timer.add_Tick($refresh)
$timer.Start()
[Windows.Forms.Application]::Run()
$icon.Dispose(); $mutex.ReleaseMutex()
