param(
  [string]$ComponentDll
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

npm run package
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

function Resolve-ComponentDll {
  param([string]$Override)

  if ($Override) {
    if (-not (Test-Path $Override)) {
      throw "Component DLL was not found: $Override"
    }
    return (Resolve-Path $Override).ProviderPath
  }

  $candidate = Get-ChildItem -Path @("dist", "component") -Recurse -File -Filter "foo_streamdock_control.dll" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($candidate) {
    return $candidate.FullName
  }

  throw "foo_streamdock_control.dll was not found. Build the foobar2000 component first, or pass -ComponentDll <path>."
}

$ResolvedComponentDll = Resolve-ComponentDll $ComponentDll
$ComponentDist = Join-Path $Root "dist/component"
New-Item -ItemType Directory -Force -Path $ComponentDist | Out-Null
$TargetComponentDll = Join-Path $ComponentDist "foo_streamdock_control.dll"
if ($ResolvedComponentDll -ne (Join-Path (Resolve-Path $ComponentDist).ProviderPath "foo_streamdock_control.dll")) {
  Copy-Item -Force $ResolvedComponentDll $TargetComponentDll
}
$ComponentPackage = Join-Path $ComponentDist "foo_streamdock_control.fb2k-component"
if (Test-Path $ComponentPackage) { Remove-Item $ComponentPackage -Force }
$ComponentPackageZip = Join-Path $ComponentDist "foo_streamdock_control.fb2k-component.zip"
if (Test-Path $ComponentPackageZip) { Remove-Item $ComponentPackageZip -Force }
Compress-Archive -Path $TargetComponentDll -DestinationPath $ComponentPackageZip
Move-Item -Force $ComponentPackageZip $ComponentPackage

$Manifest = Get-Content "manifest.json" -Raw | ConvertFrom-Json
$ReleaseDir = Join-Path $Root "dist/release"
New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null
$Zip = Join-Path $ReleaseDir "streamdock-foobar2000-$($Manifest.Version).zip"
if (Test-Path $Zip) { Remove-Item $Zip -Force }

Compress-Archive -Path @(
  "dist/stream-dock-foobar2000.sdPlugin",
  "dist/component",
  "scripts/install-local.ps1"
) -DestinationPath $Zip

Write-Host "Wrote $Zip"
