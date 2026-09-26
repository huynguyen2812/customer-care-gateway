<#
  Gói chẩn đoán VETCLINIC CRM (gửi đội hỗ trợ). Chạy bằng người dùng thường, KHÔNG cần quyền quản trị.
  CHỈ gồm: phiên bản, trạng thái dịch vụ, sức khỏe DB/worker/Sender, số liệu hàng đợi, trạng thái sao lưu/cập nhật, thời gian
  đồng bộ cuối, mã lỗi (chỉ tên mã, đã đếm) trong log dịch vụ, thông tin máy cơ bản.
  KHÔNG gồm: secret, cookie/token, mật khẩu, khóa, dữ liệu khách, nội dung tin, file dump/backup, phiên Zalo, file log thô.
#>
param([string]$OutDir = [Environment]::GetFolderPath('Desktop'), [switch]$Open)
$ErrorActionPreference = 'SilentlyContinue'
$scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Split-Path -Parent $scripts
Import-Module (Join-Path $scripts 'VetclinicCrm.psm1') -Force
$c = Get-VcConfig
function Get-Json($url) { try { return Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 $url } catch { return @{ error = $_.Exception.GetType().Name } } }
function Read-Status($name) { $p = Join-Path $c.StatusDir $name; if (Test-Path $p) { try { return Get-Content -Raw $p | ConvertFrom-Json } catch { } }; return $null }

# Error codes only: UPPER_SNAKE tokens next to error words; anything that could be data (digits runs, emails, phones) is dropped.
$codes = @{}
foreach ($f in Get-ChildItem $c.LogsDir -Filter '*.log' -File) {
  try {
    $fs = [IO.File]::Open($f.FullName, 'Open', 'Read', 'ReadWrite'); $r = New-Object IO.StreamReader($fs); $t = $r.ReadToEnd(); $r.Close()
    foreach ($line in ($t -split "`n" | Where-Object { $_ -match '(?i)error|lỗi|fail|exception' })) {
      foreach ($m in [regex]::Matches($line, '\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b')) { $k = "$($f.BaseName):$($m.Value)"; $codes[$k] = 1 + [int]$codes[$k] }
    }
  } catch { }
}

$svc = [ordered]@{}
foreach ($n in @($c.DbService) + @($c.NodeServices.Values)) {
  $w = Get-CimInstance Win32_Service -Filter "Name='$n'"
  $svc[$n] = if ($w) { [ordered]@{ state = $w.State; startMode = $w.StartMode; delayed = $w.DelayedAutoStart; account = $w.StartName } } else { 'MISSING' }
}
$drive = Get-PSDrive -Name ($env:ProgramData.Substring(0, 1))
$report = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  build = (Get-Content -Raw (Join-Path $appDir 'BUILD-INFO.json') | ConvertFrom-Json)
  # [string] + -Raw: plain text only (Get-Content lines carry PSPath/PSDrive objects that serialize to megabytes).
  currentVersion = [string]((Get-Content -Raw (Join-Path $c.ProgramRoot 'current-version.txt') -ErrorAction SilentlyContinue) -replace '\s', '')
  services = $svc
  listening = @(Get-NetTCPConnection -State Listen -LocalPort $c.PgPort, $c.CrmPort, $c.SenderPort | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" })
  crmHealth = Get-Json "http://127.0.0.1:$($c.CrmPort)/api/v1/health"
  localStatus = Get-Json "http://127.0.0.1:$($c.CrmPort)/api/v1/local-status"
  senderHealth = Get-Json "http://127.0.0.1:$($c.SenderPort)/health"
  workerHeartbeat = Read-Status 'worker-heartbeat.json'
  lastBackup = Read-Status 'last-backup.json'
  update = @{ lastCheck = (Read-Status 'update-check.json'); lastRun = (Read-Status 'update-status.json') }
  errorCodes = $codes
  machine = [ordered]@{ os = (Get-CimInstance Win32_OperatingSystem).Caption; osBuild = [Environment]::OSVersion.Version.ToString(); cpus = [Environment]::ProcessorCount; memoryGB = [Math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1); dataDriveFreeGB = [Math]::Round($drive.Free / 1GB, 1) }
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tmp = Join-Path $env:TEMP "vetclinic-crm-diag-$stamp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $tmp 'diagnostics.json')
$zip = Join-Path $OutDir "VETCLINIC-CRM-chan-doan-$stamp.zip"
Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $zip -Force
Remove-Item -Recurse -Force $tmp
Write-Host "Đã tạo $zip"
if ($Open) { Start-Process explorer.exe "/select,`"$zip`"" }
