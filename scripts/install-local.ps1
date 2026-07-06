[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$PluginRoot,
  [switch]$NoBuild,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).ProviderPath
Set-Location $Root

function Get-PluginDirectoryName {
  $manifest = Get-Content "manifest.json" -Raw | ConvertFrom-Json
  return "$($manifest.Name -replace '[^a-z0-9_-]+', '-' -replace '(^-+|-+$)', '' | ForEach-Object { $_.ToLowerInvariant() }).sdPlugin"
}

function Resolve-PluginRoot {
  param([string]$Override)

  if ($Override) {
    return $Override
  }

  $candidates = @()
  if ($env:APPDATA) {
    $candidates += Join-Path $env:APPDATA "HotSpot\StreamDock\Plugins"
    $candidates += Join-Path $env:APPDATA "HotSpot\StreamDock\plugins"
    $candidates += Join-Path $env:APPDATA "StreamDock\Plugins"
    $candidates += Join-Path $env:APPDATA "StreamDock\plugins"
    $candidates += Join-Path $env:APPDATA "Mirabox\StreamDock\Plugins"
  }
  if ($env:LOCALAPPDATA) {
    $candidates += Join-Path $env:LOCALAPPDATA "StreamDock\Plugins"
    $candidates += Join-Path $env:LOCALAPPDATA "StreamDock\plugins"
    $candidates += Join-Path $env:LOCALAPPDATA "Mirabox\StreamDock\Plugins"
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  if ($candidates.Count -gt 0) {
    return $candidates[0]
  }

  throw "Could not infer a Stream Dock plugin directory. Pass -PluginRoot explicitly."
}

$PluginName = Get-PluginDirectoryName
$PackageDir = Join-Path $Root "dist\$PluginName"
$InstallRoot = Resolve-PluginRoot $PluginRoot
$Target = Join-Path $InstallRoot $PluginName

if ($DryRun) {
  Write-Host "Dry run: would install '$PackageDir' to '$Target'."
  if (-not (Test-Path $PackageDir) -and -not $NoBuild) {
    Write-Host "Dry run: package is missing; a real run would execute 'npm run package' first."
  }
  exit 0
}

if (-not (Test-Path $PackageDir)) {
  if ($NoBuild) {
    throw "Package directory '$PackageDir' does not exist and -NoBuild was specified."
  }
  npm run package
}

if (-not (Test-Path $PackageDir)) {
  throw "Package directory '$PackageDir' was not created."
}

if ($PSCmdlet.ShouldProcess($InstallRoot, "Create Stream Dock plugin root")) {
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
}
if ((Test-Path $Target) -and $PSCmdlet.ShouldProcess($Target, "Remove existing plugin")) {
  Remove-Item -Recurse -Force $Target
}
if ($PSCmdlet.ShouldProcess($Target, "Install plugin")) {
  Copy-Item -Recurse -Force $PackageDir $Target
}

Write-Host "Installed $PluginName to $Target"
