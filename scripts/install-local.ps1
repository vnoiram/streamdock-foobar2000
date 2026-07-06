[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$PluginRoot,
  [switch]$NoBuild,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ScriptDir = (Resolve-Path $PSScriptRoot).ProviderPath

function Resolve-RepoRoot {
  $candidates = @(
    $ScriptDir,
    (Split-Path -Parent $ScriptDir)
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and
        (Test-Path (Join-Path $candidate "package.json")) -and
        (Test-Path (Join-Path $candidate "manifest.json"))) {
      return (Resolve-Path $candidate).ProviderPath
    }
  }

  return $null
}

function Get-SearchRoots {
  param([string]$RepoRoot)

  $roots = @($ScriptDir, (Split-Path -Parent $ScriptDir))
  if ($RepoRoot) {
    $roots += $RepoRoot
    $roots += Join-Path $RepoRoot "dist"
  }

  return $roots |
    Where-Object { $_ -and (Test-Path $_) } |
    ForEach-Object { (Resolve-Path $_).ProviderPath } |
    Select-Object -Unique
}

function Find-PackagedPlugin {
  param([string]$RepoRoot)

  foreach ($root in Get-SearchRoots $RepoRoot) {
    if ($root -like "*.sdPlugin" -and (Test-Path (Join-Path $root "manifest.json"))) {
      return $root
    }

    $plugin = Get-ChildItem -Path $root -Directory -Filter "*.sdPlugin" -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName "manifest.json") } |
      Select-Object -First 1
    if ($plugin) {
      return $plugin.FullName
    }
  }

  return $null
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

$RepoRoot = Resolve-RepoRoot
$PackageDir = Find-PackagedPlugin $RepoRoot

if (-not $PackageDir) {
  if ($NoBuild) {
    throw "No packaged .sdPlugin directory was found and -NoBuild was specified."
  }
  if (-not $RepoRoot) {
    throw "No packaged .sdPlugin directory was found. Run this from an extracted release zip, or run from the repository with npm available."
  }

  Set-Location $RepoRoot
  npm run package
  $PackageDir = Find-PackagedPlugin $RepoRoot
}

if (-not $PackageDir) {
  throw "Package directory was not found or created."
}

$PluginName = Split-Path -Leaf $PackageDir
$PackageParent = Split-Path -Parent $PackageDir
$ExtraHelperDir = Join-Path $PackageParent "helper"
$InstallRoot = Resolve-PluginRoot $PluginRoot
$Target = Join-Path $InstallRoot $PluginName

if ($DryRun) {
  Write-Host "Dry run: would install '$PackageDir' to '$Target'."
  if (Test-Path $ExtraHelperDir) {
    Write-Host "Dry run: would copy '$ExtraHelperDir' to '$Target\helper'."
  }
  exit 0
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
if ((Test-Path $ExtraHelperDir) -and $PSCmdlet.ShouldProcess((Join-Path $Target "helper"), "Install bundled helper")) {
  Copy-Item -Recurse -Force $ExtraHelperDir (Join-Path $Target "helper")
}

Write-Host "Installed $PluginName to $Target"
