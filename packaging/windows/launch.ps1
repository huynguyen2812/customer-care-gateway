<#
  Entry point of the VetclinicCrmApi / VetclinicCrmWorker / VetclinicCrmSender services (started by WinSW).
  Decrypts the DPAPI secrets into this process environment only, then runs node.exe in the foreground.
  Nothing secret is printed; stdout/stderr of node go to the WinSW log in C:\ProgramData\VETCLINIC CRM\logs.
#>
param([Parameter(Mandatory)][ValidateSet('api', 'worker', 'sender')][string]$Role)
$ErrorActionPreference = 'Stop'
$scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Split-Path -Parent $scripts
Import-Module (Join-Path $scripts 'VetclinicCrm.psm1') -Force
$c = Get-VcConfig
$secrets = Unprotect-VcSecrets $c.SecretsFile
foreach ($kv in (Get-VcServiceEnv $Role $secrets $appDir).GetEnumerator()) { [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, 'Process') }
$secrets.Clear()
$node = Join-Path $appDir 'node\node.exe'
if ($Role -eq 'sender') {
  Set-Location (Join-Path $appDir 'sender\backend')
  & $node 'dist/sender-main.js'
} else {
  Set-Location (Join-Path $appDir 'crm')
  & $node 'dist/main.js'
}
exit $LASTEXITCODE
