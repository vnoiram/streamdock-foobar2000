[CmdletBinding()]
param(
  [string]$SdkRoot = $env:FOOBAR2000_SDK_ROOT,
  [string]$Configuration = "Release",
  [string]$Platform = "x64",
  [string]$PlatformToolset = "v143"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).ProviderPath
$Project = Join-Path $Root "component/foo_streamdock_control/foo_streamdock_control.vcxproj"
$OutDir = Join-Path $Root "dist/component"
$BuildOutDir = Join-Path $Root "dist/component-build"

function Resolve-Foobar2000SdkRoot {
  param([string]$Root)

  $candidates = @()
  if ($Root) {
    $candidates += $Root
    $candidates += Get-ChildItem -Path $Root -Directory -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match 'SDK' -or $_.FullName -match 'foobar2000' } |
      ForEach-Object { $_.FullName }
  }

  foreach ($candidate in $candidates) {
    if (Test-Path (Join-Path $candidate "foobar2000/SDK/foobar2000.h")) {
      return (Resolve-Path $candidate).ProviderPath
    }
  }

  throw "Could not find foobar2000/SDK/foobar2000.h. Pass -SdkRoot or set FOOBAR2000_SDK_ROOT."
}

function Resolve-MSBuild {
  if ($env:MSBUILD_EXE -and (Test-Path $env:MSBUILD_EXE)) {
    return $env:MSBUILD_EXE
  }

  $candidates = @(
    "C:\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($installPath) {
      $candidate = Join-Path $installPath "MSBuild\Current\Bin\MSBuild.exe"
      if (Test-Path $candidate) {
        return $candidate
      }
    }
  }

  $cmd = Get-Command msbuild.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  throw "MSBuild.exe was not found. Install Visual Studio Build Tools with C++ workload."
}

function Resolve-VcVarsAll {
  $candidates = @(
    "C:\BuildTools\VC\Auxiliary\Build\vcvarsall.bat",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($installPath) {
      $candidate = Join-Path $installPath "VC\Auxiliary\Build\vcvarsall.bat"
      if (Test-Path $candidate) {
        return $candidate
      }
    }
  }

  throw "vcvarsall.bat was not found. Install Visual Studio Build Tools with C++ workload."
}

$ResolvedSdkRoot = Resolve-Foobar2000SdkRoot $SdkRoot
$MSBuild = Resolve-MSBuild
$VcVarsAll = Resolve-VcVarsAll
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path $BuildOutDir) {
  Remove-Item -Recurse -Force $BuildOutDir
}
New-Item -ItemType Directory -Force -Path $BuildOutDir | Out-Null

Get-ChildItem -Path $ResolvedSdkRoot -Recurse -File -Filter "*.vcxproj" |
  ForEach-Object {
    $content = Get-Content $_.FullName -Raw
    $updated = $content -replace '<PlatformToolset>v\d+</PlatformToolset>', "<PlatformToolset>$PlatformToolset</PlatformToolset>"
    if ($updated -ne $content) {
      Set-Content -Path $_.FullName -Value $updated -NoNewline
    }
  }

$PfcProject = Join-Path $ResolvedSdkRoot "pfc\pfc.vcxproj"
if (Test-Path $PfcProject) {
  $content = Get-Content $PfcProject -Raw
  $updated = [regex]::Replace(
    $content,
    '<ClCompile Include="pfc-fb2k-hooks\.cpp">.*?</ClCompile>',
    '<ClCompile Include="pfc-fb2k-hooks.cpp"><ExcludedFromBuild>true</ExcludedFromBuild></ClCompile>',
    [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if ($updated -ne $content) {
    Set-Content -Path $PfcProject -Value $updated -NoNewline
  }
}

$SharedProject = Join-Path $ResolvedSdkRoot "foobar2000\shared\shared.vcxproj"
if (Test-Path $SharedProject) {
  $content = Get-Content $SharedProject -Raw
  $updated = $content -replace '<ConfigurationType>DynamicLibrary</ConfigurationType>', '<ConfigurationType>StaticLibrary</ConfigurationType>'
  $updated = [regex]::Replace(
    $updated,
    '<ClCompile Include="filedialogs_vista\.cpp"\s*/>',
    '<ClCompile Include="filedialogs_vista.cpp"><ExcludedFromBuild>true</ExcludedFromBuild></ClCompile>')
  $updated = [regex]::Replace(
    $updated,
    '<ClCompile Include="filedialogs_vista\.cpp">.*?</ClCompile>',
    '<ClCompile Include="filedialogs_vista.cpp"><ExcludedFromBuild>true</ExcludedFromBuild></ClCompile>',
    [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if ($updated -eq $content) {
    throw "Could not patch $SharedProject for static component linking."
  }
  if ($updated -ne $content) {
    Set-Content -Path $SharedProject -Value $updated -NoNewline
  }
}

$SharedHeader = Join-Path $ResolvedSdkRoot "foobar2000\shared\shared.h"
if (Test-Path $SharedHeader) {
  $content = Get-Content $SharedHeader -Raw
  $updated = [regex]::Replace(
    $content,
    '#ifndef\s+SHARED_EXPORTS\s*#define\s+SHARED_EXPORT\s+__declspec\(dllimport\)\s+SHARED_API\s*#else\s*#define\s+SHARED_EXPORT\s+__declspec\(dllexport\)\s+SHARED_API\s*#endif',
    '#define SHARED_EXPORT SHARED_API',
    [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if ($updated -eq $content) {
    throw "Could not patch SHARED_EXPORT in $SharedHeader for static component linking."
  }
  Set-Content -Path $SharedHeader -Value $updated -NoNewline
}

$SdkProject = Join-Path $ResolvedSdkRoot "foobar2000\SDK\foobar2000_SDK.vcxproj"
if (Test-Path $SdkProject) {
  $SdkUtility = Join-Path (Split-Path -Parent $SdkProject) "utility.cpp"
  if (Test-Path $SdkUtility) {
    $content = Get-Content $SdkUtility -Raw
    $updated = [regex]::Replace(
      $content,
      'namespace pfc \{\s*/\*.*?void crashHook\(\) \{\s*uBugCheck\(\);\s*\}\s*\}\s*',
      '',
      [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($updated -ne $content) {
      Set-Content -Path $SdkUtility -Value $updated -NoNewline
    }
  }
}

$VcArch = if ($Platform -eq "Win32") { "x86" } else { "amd64" }
$MSBuildArgs = @(
  "`"$MSBuild`" `"$Project`"",
  "/nologo",
  "/m",
  "/verbosity:minimal",
  "/p:Configuration=$Configuration",
  "/p:Platform=$Platform",
  "/p:Foobar2000SdkRoot=$ResolvedSdkRoot",
  "/p:PlatformToolset=$PlatformToolset",
  "/p:OutDir=$BuildOutDir\"
) -join " "
$MSBuildCommand = "`"$VcVarsAll`" $VcArch && $MSBuildArgs"

& "C:\Windows\System32\cmd.exe" /s /c $MSBuildCommand
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$BuiltDll = Join-Path $BuildOutDir "foo_streamdock_control.dll"
if (-not (Test-Path $BuiltDll)) {
  throw "Build completed but '$BuiltDll' was not created."
}

$Dll = Join-Path $OutDir "foo_streamdock_control.dll"
Copy-Item -Force $BuiltDll $Dll
Remove-Item -Recurse -Force $BuildOutDir
Write-Host "Wrote $Dll"
