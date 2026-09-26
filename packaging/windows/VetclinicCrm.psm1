# VETCLINIC CRM Standalone PC Edition — shared helpers for install / launch / uninstall / QA scripts.
# Never writes secret values to the console, logs or files other than the DPAPI-protected secrets file.
Set-StrictMode -Version 3
Add-Type -AssemblyName System.Security

$script:Product = 'VETCLINIC CRM'
$script:DataRoot = Join-Path $env:ProgramData 'VETCLINIC CRM'
$script:ProgramRoot = Join-Path $env:ProgramFiles 'VETCLINIC CRM'
$script:Entropy = [Text.Encoding]::UTF8.GetBytes('VETCLINIC-CRM-PC-secrets-v1')

function Get-VcConfig {
  [ordered]@{
    DataRoot = $script:DataRoot
    ProgramRoot = $script:ProgramRoot
    DbDir = Join-Path $script:DataRoot 'db'
    SecretsDir = Join-Path $script:DataRoot 'secrets'
    SecretsFile = Join-Path $script:DataRoot 'secrets\secrets.dpapi'
    LogsDir = Join-Path $script:DataRoot 'logs'
    RunDir = Join-Path $script:DataRoot 'run'
    # Non-sensitive status files (backup/update/worker heartbeat) readable by every local user (tray icon).
    StatusDir = Join-Path $script:DataRoot 'status'
    SenderDir = Join-Path $script:DataRoot 'sender'
    BackupDir = Join-Path $script:DataRoot 'backup'
    PgPort = 55432; CrmPort = 47100; SenderPort = 47110
    DbService = 'VetclinicCrmDb'
    NodeServices = [ordered]@{ api = 'VetclinicCrmApi'; worker = 'VetclinicCrmWorker'; sender = 'VetclinicCrmSender' }
    CrmDb = 'vetclinic_crm'; CrmUser = 'crm_app'; SenderDb = 'vetclinic_sender'; SenderUser = 'sender_app'; PgSuperUser = 'vcadmin'
  }
}

function New-VcRandom([int]$bytes = 32, [ValidateSet('hex', 'base64', 'base64url')][string]$format = 'hex') {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  switch ($format) {
    'hex' { return -join ($b | ForEach-Object { $_.ToString('x2') }) }
    'base64' { return [Convert]::ToBase64String($b) }
    'base64url' { return ([Convert]::ToBase64String($b)).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
  }
}

<# DPAPI LocalMachine: only this PC can decrypt; access is limited by the ACL on the secrets folder. #>
function Protect-VcSecrets([hashtable]$secrets, [string]$path) {
  $json = $secrets | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $script:Entropy, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  [IO.File]::WriteAllBytes($path, $enc)
  [Array]::Clear($bytes, 0, $bytes.Length)
}

function Unprotect-VcSecrets([string]$path) {
  $enc = [IO.File]::ReadAllBytes($path)
  $bytes = [Security.Cryptography.ProtectedData]::Unprotect($enc, $script:Entropy, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  $obj = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  [Array]::Clear($bytes, 0, $bytes.Length)
  $h = @{}; foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = [string]$p.Value }
  return $h
}

<# Environment for one Node service. Secrets go only into this process environment (inherited by node.exe). #>
function Get-VcServiceEnv([string]$role, [hashtable]$s, [string]$appDir) {
  $c = Get-VcConfig
  $pg = "127.0.0.1:$($c.PgPort)"
  if ($role -eq 'sender') {
    return [ordered]@{
      NODE_ENV = 'production'; SENDER_ONLY = 'true'; HOST = '127.0.0.1'; PORT = "$($c.SenderPort)"
      DATABASE_URL = "postgresql://$($c.SenderUser):$($s.SENDER_DB_PASSWORD)@$pg/$($c.SenderDb)"
      JWT_SECRET = $s.SENDER_JWT_SECRET; ENCRYPTION_KEY = $s.SENDER_ENCRYPTION_KEY
      GATEWAY_SENDER_ENC_KEY = $s.GATEWAY_SENDER_ENC_KEY; ZALO_SESSION_ENC_KEY = $s.ZALO_SESSION_ENC_KEY
      GATEWAY_HEALTH_CALLBACK_ENABLED = 'true'; UPLOAD_DIR = (Join-Path $c.SenderDir 'uploads')
      SENDER_LEGAL_DIR = (Join-Path $appDir 'sender'); APP_URL = "http://127.0.0.1:$($c.SenderPort)"
    }
  }
  $envs = [ordered]@{
    NODE_ENV = 'production'; DEPLOYMENT_MODE = 'standalone'; PROCESS_ROLE = $role; HOST = '127.0.0.1'; PORT = "$($c.CrmPort)"
    CRM_PUBLIC_ORIGIN = "http://127.0.0.1:$($c.CrmPort)"
    DATABASE_URL = "postgresql://$($c.CrmUser):$($s.CRM_DB_PASSWORD)@$pg/$($c.CrmDb)"
    DATA_ENCRYPTION_KEY_BASE64 = $s.DATA_ENCRYPTION_KEY_BASE64; PHONE_HASH_PEPPER = $s.PHONE_HASH_PEPPER
    CRM_SESSION_SECRET = $s.CRM_SESSION_SECRET
    SENDER_V2_BASE_URL = "http://127.0.0.1:$($c.SenderPort)"; SENDER_V2_CLIENT_ID = $s.SENDER_V2_CLIENT_ID; SENDER_V2_SIGNING_KEY = $s.SENDER_V2_SIGNING_KEY
    CARE_JOB_MAX_LATENESS_HOURS = '12'
    # Platform Device Agent: machine-only device-key secret (never in the backup bundle), release-controlled Platform
    # URL and Platform config-signing public keys (shipped file; absent ⇒ pairing disabled, so nothing can be sent).
    # PLATFORM_LICENSE_BYPASS is test-only and deliberately never written here (services also run NODE_ENV=production).
    DEVICE_KEY_ENC_KEY = $s['DEVICE_KEY_ENC_KEY']   # indexer: an older install without this secret must still start
    PLATFORM_DEVICE_API_URL = $script:PlatformDeviceApiUrl
    PLATFORM_CONFIG_PUBLIC_KEYS = (Get-VcPlatformConfigKeys $appDir)
    VC_BUILD_INFO_FILE = (Join-Path $appDir 'BUILD-INFO.json')
  }
  if ($role -eq 'worker') { $envs.WORKER_HEARTBEAT_FILE = (Join-Path $c.StatusDir 'worker-heartbeat.json') }
  return $envs
}

# PROPOSED Platform device API (docs/standalone/platform-device-contract-v1.md) — final URL to be confirmed by the
# Platform task before release. Release-controlled: not editable from the browser or settings.json.
$script:PlatformDeviceApiUrl = 'https://admin.vetclinic.vn/api/crm-pc/v1'

<# {"keyId":"PEM",...} from scripts\platform-config-keys.json shipped with the release; '' when not provided yet. #>
function Get-VcPlatformConfigKeys([string]$appDir) {
  $p = Join-Path $appDir 'scripts\platform-config-keys.json'
  if (-not (Test-Path $p)) { return '' }
  return ((Get-Content -Raw $p | ConvertFrom-Json) | ConvertTo-Json -Compress)
}

<# Adds secrets introduced by newer versions to an existing install (update path). Returns $true when changed. #>
function Add-VcMissingSecrets([hashtable]$s) {
  $changed = $false
  if (-not $s['DEVICE_KEY_ENC_KEY']) { $s['DEVICE_KEY_ENC_KEY'] = New-VcRandom 32 'hex'; $changed = $true }
  return $changed
}

# Official update location (chốt 2026-09-25). A file named manifest.json + manifest.json.sig must live here.
$script:DefaultUpdateUrl = 'https://vetclinic.vn/tai-ve/crm-pc/manifest.json'

<# Non-secret settings (C:\ProgramData\VETCLINIC CRM\settings.json), editable by Administrators only. #>
function Get-VcSettings {
  $defaults = [ordered]@{ backupKeep = 14; backupExtraDir = ''; backupTime = '02:30'; updateManifestUrl = $script:DefaultUpdateUrl; updateCheck = $true }
  $p = Join-Path $script:DataRoot 'settings.json'
  if (Test-Path $p) {
    try {
      $j = Get-Content -Raw $p | ConvertFrom-Json
      # An empty updateManifestUrl (written by 0.2.x installs) means "use the official default", not "disabled".
      foreach ($prop in $j.PSObject.Properties) { if ($prop.Name -eq 'updateManifestUrl' -and -not $prop.Value) { continue }; $defaults[$prop.Name] = $prop.Value }
    } catch { }
  }
  return [pscustomobject]$defaults
}
function Set-VcSettings([hashtable]$values) {
  $cur = [ordered]@{}; foreach ($p in (Get-VcSettings).PSObject.Properties) { $cur[$p.Name] = $p.Value }
  foreach ($k in $values.Keys) { $cur[$k] = $values[$k] }
  $cur | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $script:DataRoot 'settings.json')
}

<# WinSW definition for one Node service, pointing at a given app version folder (install / update / rollback). #>
function Write-VcServiceXml([string]$role, [string]$appDir) {
  $c = Get-VcConfig
  $name = $c.NodeServices[$role]
  $labels = @{ api = 'API va giao dien'; worker = 'hang doi gui tin'; sender = 'Zalo Sender (AGPL-3.0)' }
  $launch = Join-Path $appDir 'scripts\launch.ps1'
  @"
<service>
  <id>$name</id>
  <name>VETCLINIC CRM - $($labels[$role])</name>
  <description>VETCLINIC CRM ban chay tren PC ($role). Chi nghe 127.0.0.1.</description>
  <executable>%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe</executable>
  <arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$launch" -Role $role</arguments>
  <depend>$($c.DbService)</depend>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <stoptimeout>15 sec</stoptimeout>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="60 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>$($c.LogsDir)</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
</service>
"@ | Set-Content -Path (Join-Path $c.ProgramRoot "services\$name.xml") -Encoding UTF8
}

$script:TaskFolder = '\VETCLINIC CRM\'
$script:TrayLink = 'Microsoft\Windows\Start Menu\Programs\StartUp\VETCLINIC CRM (khay).lnk'

<# Daily backup + update check (SYSTEM) and the tray icon for every user at logon. Re-run on update. #>
function Register-VcTasks([string]$appDir) {
  $s = Get-VcSettings
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
  $backup = New-ScheduledTaskAction -Execute $ps -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $appDir 'scripts\backup.ps1'))
  Register-ScheduledTask -TaskPath $script:TaskFolder -TaskName 'Sao luu hang ngay' -Action $backup -Principal $principal -Settings $set -Trigger (New-ScheduledTaskTrigger -Daily -At $s.backupTime) -Force | Out-Null
  $update = New-ScheduledTaskAction -Execute $ps -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $appDir 'scripts\check-update.ps1'))
  $t1 = New-ScheduledTaskTrigger -Daily -At '03:15'; $t2 = New-ScheduledTaskTrigger -AtStartup; $t2.Delay = 'PT15M'
  Register-ScheduledTask -TaskPath $script:TaskFolder -TaskName 'Kiem tra cap nhat' -Action $update -Principal $principal -Settings $set -Trigger @($t1, $t2) -Force | Out-Null
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut((Join-Path $env:ProgramData $script:TrayLink))
  $lnk.TargetPath = $ps
  $lnk.Arguments = ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $appDir 'scripts\tray.ps1'))
  $lnk.WindowStyle = 7; $lnk.Description = 'VETCLINIC CRM - trang thai'; $lnk.Save()
}

function Unregister-VcTasks {
  foreach ($t in 'Sao luu hang ngay', 'Kiem tra cap nhat') { Unregister-ScheduledTask -TaskPath $script:TaskFolder -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }
  $p = Join-Path $env:ProgramData $script:TrayLink
  if (Test-Path $p) { Remove-Item -Force $p }
}

function Wait-VcHttp([string]$url, [int]$seconds = 90) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 $url; if ($r.StatusCode -eq 200) { return $true } } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}

Export-ModuleMember -Function Get-VcConfig, New-VcRandom, Protect-VcSecrets, Unprotect-VcSecrets, Get-VcServiceEnv, Wait-VcHttp, Get-VcSettings, Set-VcSettings, Write-VcServiceXml, Register-VcTasks, Unregister-VcTasks, Get-VcPlatformConfigKeys, Add-VcMissingSecrets
