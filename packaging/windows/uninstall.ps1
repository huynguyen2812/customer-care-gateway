<#
.SYNOPSIS
  Gỡ VETCLINIC CRM (bản PC). MẶC ĐỊNH GIỮ NGUYÊN DỮ LIỆU trong C:\ProgramData\VETCLINIC CRM\.

.DESCRIPTION
  Dừng và gỡ 4 dịch vụ, xóa C:\Program Files\VETCLINIC CRM\. Dữ liệu (database, secret, log, backup) chỉ bị xóa khi
  truyền -DeleteData VÀ gõ đúng -ConfirmText "XOA TOAN BO DU LIEU". Xóa secret mà không có bản backup + khóa khôi phục
  thì KHÔNG THỂ đọc lại dữ liệu cũ.
#>
[CmdletBinding()]
param([switch]$DeleteData, [string]$ConfirmText = '', [switch]$ServicesOnly)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Cần chạy bằng quyền Administrator.' }
$scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $scripts 'VetclinicCrm.psm1') -Force
$c = Get-VcConfig
if ($DeleteData -and $ConfirmText -ne 'XOA TOAN BO DU LIEU') { throw 'Muốn xóa dữ liệu phải truyền -ConfirmText "XOA TOAN BO DU LIEU". Không có gì bị gỡ.' }

$servicesDir = Join-Path $c.ProgramRoot 'services'
Unregister-VcTasks
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*VETCLINIC CRM*tray.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
foreach ($name in $c.NodeServices.Values) {
  if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
    Write-Host "Dừng và gỡ $name"
    Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
    $exe = Join-Path $servicesDir "$name.exe"
    if (Test-Path $exe) { & $exe uninstall | Out-Null } else { & sc.exe delete $name | Out-Null }
  }
}
if (Get-Service -Name $c.DbService -ErrorAction SilentlyContinue) {
  Write-Host "Dừng và gỡ $($c.DbService)"
  Stop-Service -Name $c.DbService -Force -ErrorAction SilentlyContinue
  & sc.exe delete $c.DbService | Out-Null
}
Start-Sleep -Seconds 2
$shortcut = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\VETCLINIC CRM.url'
if (Test-Path $shortcut) { Remove-Item -Force $shortcut }
if ($ServicesOnly) { Write-Host 'Đã gỡ dịch vụ và tác vụ (bộ cài .exe tự xóa file chương trình). Dữ liệu vẫn giữ.'; exit 0 }
# Không xóa khi script đang chạy từ chính thư mục chương trình: chép sang TEMP trước khi gọi, hoặc xóa phần còn lại sau.
if (Test-Path $c.ProgramRoot) {
  if ($scripts.StartsWith($c.ProgramRoot, [StringComparison]::OrdinalIgnoreCase)) { Write-Host "Còn thư mục $($c.ProgramRoot) (script đang chạy từ đó) — xóa tay sau khi đóng cửa sổ này." }
  else { Remove-Item -Recurse -Force $c.ProgramRoot }
}
if ($DeleteData) {
  Write-Host "XÓA DỮ LIỆU $($c.DataRoot)"
  Remove-Item -Recurse -Force $c.DataRoot
} else {
  Write-Host "Đã gỡ chương trình. Dữ liệu vẫn còn tại $($c.DataRoot) (database, secret, backup, log)."
}
