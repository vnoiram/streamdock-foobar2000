[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$PluginRoot,
  [string]$Foobar2000ComponentRoot,
  [switch]$InstallComponent,
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

function Resolve-Foobar2000ComponentRoot {
  param([string]$Override)

  if ($Override) {
    return $Override
  }

  $candidates = @()
  if ($env:APPDATA) {
    $candidates += Join-Path $env:APPDATA "foobar2000\user-components"
  }
  if ($env:LOCALAPPDATA) {
    $candidates += Join-Path $env:LOCALAPPDATA "foobar2000\user-components"
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  if ($candidates.Count -gt 0) {
    return $candidates[0]
  }

  throw "Could not infer a foobar2000 user-components directory. Pass -Foobar2000ComponentRoot explicitly."
}

function Find-ComponentDll {
  param([string]$PackageParent)

  $roots = @(
    (Join-Path $PackageParent "component"),
    (Join-Path $PackageParent "foo_streamdock_control")
  )

  foreach ($root in $roots) {
    if (-not (Test-Path $root)) {
      continue
    }

    $dll = Get-ChildItem -Path $root -Recurse -File -Filter "foo_streamdock_control.dll" -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($dll) {
      return $dll.FullName
    }
  }

  return $null
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
$ComponentDll = Find-ComponentDll $PackageParent
$InstallRoot = Resolve-PluginRoot $PluginRoot
$Target = Join-Path $InstallRoot $PluginName
$ComponentInstallRoot = $null
$ComponentTarget = $null
if ($InstallComponent -and $ComponentDll) {
  $ComponentInstallRoot = Resolve-Foobar2000ComponentRoot $Foobar2000ComponentRoot
  $ComponentTarget = Join-Path (Join-Path $ComponentInstallRoot "foo_streamdock_control") "foo_streamdock_control.dll"
}

if ($DryRun) {
  Write-Host "Dry run: would install '$PackageDir' to '$Target'."
  if ($InstallComponent -and $ComponentDll) {
    Write-Host "Dry run: would copy '$ComponentDll' to '$ComponentTarget'."
  } elseif ($ComponentDll -and -not $InstallComponent) {
    Write-Host "Dry run: bundled component found at '$ComponentDll'; pass -InstallComponent to install it."
  } elseif ($InstallComponent) {
    Write-Host "Dry run: -InstallComponent was specified, but no bundled component DLL was found next to '$PackageDir'."
  }
  exit 0
}

if ($InstallComponent -and -not $ComponentDll) {
  throw "-InstallComponent was specified, but foo_streamdock_control.dll was not found next to '$PackageDir'."
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
if ($InstallComponent -and $ComponentDll -and $PSCmdlet.ShouldProcess($ComponentInstallRoot, "Create foobar2000 component root")) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ComponentTarget) | Out-Null
}
if ($InstallComponent -and $ComponentDll -and $PSCmdlet.ShouldProcess($ComponentTarget, "Install foobar2000 component")) {
  Copy-Item -Force $ComponentDll $ComponentTarget
}
if ($ComponentDll -and -not $InstallComponent) {
  Write-Host "Bundled component found at '$ComponentDll'. Pass -InstallComponent to install it."
}

Write-Host "Installed $PluginName to $Target"
