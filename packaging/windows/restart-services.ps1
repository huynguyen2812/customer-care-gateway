<#
  Khởi động lại 4 dịch vụ VETCLINIC CRM theo đúng thứ tự (Node → [DB] → Sender, API, Worker) và ghi kết quả (không secret)
  ra JSON. Dùng từ khay hệ thống ("Khởi động lại dịch vụ") và trong kiểm thử khởi động lại.
#>
param([string]$ResultFile = (Join-Path $env:ProgramData 'VETCLINIC CRM\status\restart-result.json'), [switch]$StopDbToo)
$ErrorActionPreference = 'Stop'
$scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $scripts 'VetclinicCrm.psm1') -Force
$c = Get-VcConfig
$t0 = Get-Date
$order = @($c.NodeServices.api, $c.NodeServices.worker, $c.NodeServices.sender)
foreach ($n in $order) { Stop-Service -Name $n -Force }
if ($StopDbToo) { Stop-Service -Name $c.DbService -Force }
$stopped = @{}; foreach ($n in $order + @($c.DbService)) { $stopped[$n] = (Get-Service $n).Status.ToString() }
Start-Sleep -Seconds 3
if ($StopDbToo) { Start-Service -Name $c.DbService }
foreach ($n in @($c.NodeServices.sender, $c.NodeServices.api, $c.NodeServices.worker)) { Start-Service -Name $n }
$crm = Wait-VcHttp "http://127.0.0.1:$($c.CrmPort)/api/v1/health" 120
$sender = Wait-VcHttp "http://127.0.0.1:$($c.SenderPort)/health" 120
$status = @{}; foreach ($n in $order + @($c.DbService)) { $status[$n] = (Get-Service $n).Status.ToString() }
[ordered]@{ startedAt = $t0.ToString('o'); finishedAt = (Get-Date).ToString('o'); stopDbToo = [bool]$StopDbToo; statusWhileStopped = $stopped; statusAfter = $status; crmHealthy = $crm; senderHealthy = $sender } |
  ConvertTo-Json | Set-Content -Path $ResultFile -Encoding UTF8
