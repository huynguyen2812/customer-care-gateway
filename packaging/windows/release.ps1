<#
.SYNOPSIS
  Phát hành một phiên bản bản PC: build tái lập → bộ cài .exe (Inno Setup) → gói cập nhật .zip + manifest ký Ed25519.

.DESCRIPTION
  Kết quả trong <OutDir>\release\<version>\ — tải cả thư mục này lên web VETCLINIC (HTTPS):
    VETCLINIC-CRM-Setup-<version>.exe   bộ cài cho khách tải về (chưa ký số)
    vetclinic-crm-<version>.zip         gói cho bộ tự cập nhật
    manifest.json + manifest.json.sig   updater tải từ <BaseUrl>/manifest.json (đặt URL này vào settings.json → updateManifestUrl)
    SHA256SUMS.txt                      để khách tự kiểm file đã tải
  Khóa bí mật ký cập nhật (-SigningKey) KHÔNG nằm trong repo/bộ cài; mất khóa ⇒ phải phát hành bộ cài mới với khóa công khai mới.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ToolsCache,
  [Parameter(Mandatory)][string]$CrmRepo,
  [Parameter(Mandatory)][string]$SenderRepo,
  [Parameter(Mandatory)][string]$OutDir,
  [Parameter(Mandatory)][string]$SigningKey,
  [Parameter(Mandatory)][string]$BaseUrl,
  [Parameter(Mandatory)][string]$Iscc,
  [string]$Version = '',
  [string]$Notes = '',
  # QA only: accept http://127.0.0.1 package URLs when verifying the signed manifest.
  [switch]$AllowLocalUrl,
  # Re-run the last steps on an existing stage / installer (e.g. after a manifest problem) without rebuilding.
  [switch]$SkipBuild,
  [switch]$SkipInstaller,
  # QA only: build from a working tree with uncommitted changes. The manifest then says dirty=true and the version
  # must carry a "-dev" or "-qa" suffix, so such a build can never pass as a traceable production release.
  [switch]$AllowDirty
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dirty = @($CrmRepo, $SenderRepo) | Where-Object { [bool](git -c "safe.directory=*" -C $_ status --porcelain) }
if ($dirty -and -not $AllowDirty) { throw "Không phát hành từ mã nguồn chưa commit: $($dirty -join ', '). Commit trước, hoặc dùng -AllowDirty cho bản thử." }
if ($dirty -and $Version -notmatch '-(dev|qa)(\.|$)') { throw 'Bản build từ mã nguồn chưa commit phải có hậu tố -dev hoặc -qa trong -Version.' }
if (-not $SkipBuild) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'build.ps1') -ToolsCache $ToolsCache -CrmRepo $CrmRepo -SenderRepo $SenderRepo -OutDir $OutDir -Version $Version
  if ($LASTEXITCODE -ne 0) { throw 'build.ps1 thất bại' }
}
$stageRoot = Join-Path $OutDir 'stage\app'
$stage = if ($Version) { Get-Item (Join-Path $stageRoot $Version) } else { Get-ChildItem $stageRoot -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }
$ver = (Get-Content -Raw (Join-Path $stage.FullName 'BUILD-INFO.json') | ConvertFrom-Json).version
$rel = Join-Path $OutDir "release\$ver"
if (-not $SkipInstaller -and (Test-Path $rel)) { Remove-Item -Recurse -Force $rel }
New-Item -ItemType Directory -Force -Path $rel | Out-Null
$node = Join-Path $stage.FullName 'node\node.exe'
$tool = Join-Path $here 'tools\vcupdate.mjs'
if ($AllowLocalUrl) { $env:VC_UPDATE_ALLOW_LOCAL = '1' }

if (-not $SkipInstaller) {
  Write-Host "==> installer $ver"
  & $Iscc /Q "/DVersion=$ver" "/DStageDir=$($stage.FullName)" "/O$rel" (Join-Path $here 'installer\vetclinic-crm.iss')
  if ($LASTEXITCODE -ne 0) { throw 'ISCC thất bại' }
}

Write-Host '==> update package'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = Join-Path $rel "vetclinic-crm-$ver.zip"
foreach ($old in @($zip) + @(Get-ChildItem $rel -Filter 'manifest.json*' | ForEach-Object FullName)) { if (Test-Path $old) { Remove-Item -Force $old } }
[IO.Compression.ZipFile]::CreateFromDirectory($stage.FullName, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
$sha = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
$bi = Get-Content -Raw (Join-Path $stage.FullName 'BUILD-INFO.json') | ConvertFrom-Json
$manifest = [ordered]@{
  product = 'VETCLINIC CRM PC'; version = $ver; packageUrl = "$($BaseUrl.TrimEnd('/'))/vetclinic-crm-$ver.zip"
  packageSha256 = $sha; packageSize = (Get-Item $zip).Length; publishedAt = (Get-Date).ToUniversalTime().ToString('o'); notes = $Notes
  # Build identity: lets anyone trace an installer/package back to the exact commits it was built from.
  build = [ordered]@{ crmCommit = $bi.crmCommit; senderCommit = $bi.senderCommit; builtAt = $bi.builtAt; dirty = ([bool]$bi.crmSourceDirty -or [bool]$bi.senderSourceDirty) }
}
$mf = Join-Path $rel 'manifest.json'
[IO.File]::WriteAllText($mf, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
& $node $tool sign $SigningKey $mf; if ($LASTEXITCODE -ne 0) { throw 'Ký manifest thất bại' }
$ErrorActionPreference = 'Continue'
$v = & $node $tool verify (Join-Path $here 'update-public-key.pem') $mf "$mf.sig" 2>&1 | ForEach-Object { "$_" }
$code = $LASTEXITCODE; $ErrorActionPreference = 'Stop'
if ($code -ne 0) { throw "Kiểm tra manifest thất bại: $v" }
Get-ChildItem $rel -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | ForEach-Object { "{0}  {1}" -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower(), $_.Name } | Set-Content -Encoding ASCII (Join-Path $rel 'SHA256SUMS.txt')
Get-ChildItem $rel | Select-Object Name, @{ n = 'MB'; e = { [Math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize | Out-String | Write-Host
Write-Host "==> release ready: $rel"
