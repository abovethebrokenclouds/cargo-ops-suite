# Builds the Cargo Ops toolbar panel (msfs-panel\) with the free MSFS SDK package tool and
# copies it into the simulator's Community folder. Windows PowerShell 5.1 or newer; no
# administrator rights needed (everything happens in your own user profile and your own
# Community folder).
#
# Usage (from the repository folder; scripts\build-msfs-panel.cmd does the same):
#   powershell -ExecutionPolicy Bypass -File scripts\build-msfs-panel.ps1
#   ... -Port 4312                 the connector runs on another port (--port 4312)
#   ... -SdkPath "C:\MSFS SDK"     the SDK is not found through MSFS_SDK / MSFS2024_SDK
#   ... -Community "D:\MSFS\Community"   copy there instead of the detected folder(s)
#   ... -Sim 2024                  only the MSFS 2024 install (2020 / 2024 / All)
#   ... -DetectOnly                show the Community folder(s) it would use, change nothing
#   ... -Remove                    delete the panel from the Community folder(s) again
#   ... -WhatIf                    show what would happen without doing it
#
# The SDK and the compiled package are never part of the repository: the SDK licence covers
# your own use of the tool on your PC. Steps: docs\SETUP_WINDOWS.md "Toolbar panel".

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$SdkPath,
  [string]$Community,
  [ValidateSet("All", "2020", "2024")]
  [string]$Sim = "All",
  [ValidateRange(1, 65535)]
  [int]$Port = 4311,
  [string]$BuildDir,
  [switch]$ForceSteam,
  [switch]$DetectOnly,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$PackageName = "cargo-ops-toolbar-panel"
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo "msfs-panel"
$sdkDocs2020 = "https://docs.flightsimulator.com/html/Introduction/SDK_Overview.htm"
$sdkDocs2024 = "https://docs.flightsimulator.com/msfs2024/html/1_Introduction/SDK_Overview.htm"

function Fail([string]$message, [int]$code) {
  Write-Host ""
  Write-Host $message -ForegroundColor Red
  Write-Host ""
  exit $code
}

# ---- Community folder detection ----
# UserCfg.opt holds a line `InstalledPackagesPath "D:\Path\To\Packages"`; Community is the
# folder of that name inside it. Locations per simulator and store (community-documented):
function Get-UserCfgCandidates {
  $local = $env:LOCALAPPDATA
  $roaming = $env:APPDATA
  return @(
    @{ Sim = "2020"; Store = "Microsoft Store"; Opt = (Join-Path $local "Packages\Microsoft.FlightSimulator_8wekyb3d8bbwe\LocalCache\UserCfg.opt") },
    @{ Sim = "2020"; Store = "Steam"; Opt = (Join-Path $roaming "Microsoft Flight Simulator\UserCfg.opt") },
    @{ Sim = "2024"; Store = "Microsoft Store"; Opt = (Join-Path $local "Packages\Microsoft.Limitless_8wekyb3d8bbwe\LocalCache\UserCfg.opt") },
    @{ Sim = "2024"; Store = "Steam"; Opt = (Join-Path $roaming "Microsoft Flight Simulator 2024\UserCfg.opt") }
  )
}

function Read-InstalledPackagesPath([string]$opt) {
  foreach ($line in (Get-Content -LiteralPath $opt -ErrorAction Stop)) {
    if ($line -match '^\s*InstalledPackagesPath\s+"([^"]+)"\s*$') { return $Matches[1] }
    if ($line -match '^\s*InstalledPackagesPath\s+(\S.*?)\s*$') { return $Matches[1] }
  }
  return $null
}

# SDK flavour: a 2024 SDK builds MSFS 2024 packages, which MSFS 2024 reads from Community2024;
# a 2020 SDK builds packages both simulators read from Community (SDK docs, "The Community
# Folders"). Unknown (no SDK yet, e.g. -DetectOnly / -Remove) lists both.
function Get-CommunityTargets([string]$flavour) {
  $targets = @()
  foreach ($c in (Get-UserCfgCandidates)) {
    if ($Sim -ne "All" -and $Sim -ne $c.Sim) { continue }
    if ($flavour -eq "2024" -and $c.Sim -ne "2024") { continue }
    if (-not (Test-Path -LiteralPath $c.Opt -PathType Leaf)) { continue }
    $packages = Read-InstalledPackagesPath $c.Opt
    if (-not $packages) {
      Write-Host "  $($c.Opt) has no InstalledPackagesPath line; skipped." -ForegroundColor Yellow
      continue
    }
    if (-not (Test-Path -LiteralPath $packages -PathType Container)) {
      Write-Host "  MSFS $($c.Sim) ($($c.Store)): packages folder $packages does not exist; skipped." -ForegroundColor Yellow
      continue
    }
    $folders = @("Community")
    if ($c.Sim -eq "2024" -and $flavour -ne "2020") {
      if ($flavour -eq "2024") { $folders = @("Community2024") } else { $folders = @("Community", "Community2024") }
    }
    foreach ($name in $folders) {
      $dir = Join-Path $packages $name
      if ($name -eq "Community2024" -and -not (Test-Path -LiteralPath $dir -PathType Container)) {
        if ($flavour -ne "2024") { continue }
        $dir = Join-Path $packages "Community"
      }
      $targets += [pscustomobject]@{ Sim = $c.Sim; Store = $c.Store; Community = $dir; Opt = $c.Opt }
    }
  }
  # One entry per folder (both stores can point at the same place).
  $seen = @{}
  $unique = @()
  foreach ($t in $targets) {
    $key = $t.Community.TrimEnd([char]92).ToLowerInvariant()
    if (-not $seen.ContainsKey($key)) { $seen[$key] = $true; $unique += $t }
  }
  return , $unique
}

function Get-SdkRoot {
  if ($SdkPath) { return @{ Root = $SdkPath; From = "-SdkPath" } }
  if ($env:MSFS_SDK) { return @{ Root = $env:MSFS_SDK; From = "MSFS_SDK" } }
  if ($env:MSFS2024_SDK) { return @{ Root = $env:MSFS2024_SDK; From = "MSFS2024_SDK" } }
  return $null
}

function Get-SdkFlavour($sdk) {
  if ($sdk.From -eq "MSFS2024_SDK" -or $sdk.Root -match "2024") { return "2024" }
  return "2020"
}

# Delete our package folder only. A junction or symlink (packages linked during development)
# is removed as a link, never by deleting what it points to.
function Remove-PanelFolder([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) {
    Write-Host "  nothing to remove in $(Split-Path -Parent $dir)"
    return
  }
  if (-not $PSCmdlet.ShouldProcess($dir, "Remove the Cargo Ops toolbar panel")) { return }
  $item = Get-Item -LiteralPath $dir -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    [IO.Directory]::Delete($dir)
  } else {
    Remove-Item -LiteralPath $dir -Recurse -Force
  }
  Write-Host "  removed $dir"
}

Write-Host "Cargo Ops toolbar panel"

# ---- target folders ----
$sdk = Get-SdkRoot
$flavour = ""
if ($sdk -and -not $Remove -and -not $DetectOnly) { $flavour = Get-SdkFlavour $sdk }

if ($Community) {
  if (-not (Test-Path -LiteralPath $Community -PathType Container)) {
    Fail "Community folder not found: $Community" 3
  }
  $targets = @([pscustomobject]@{ Sim = "?"; Store = "-Community"; Community = (Resolve-Path -LiteralPath $Community).Path; Opt = "" })
} else {
  $targets = Get-CommunityTargets $flavour
}

if ($targets.Count -eq 0) {
  Fail ("No Community folder found (looked for UserCfg.opt of MSFS 2020 and 2024, Microsoft Store and Steam).`n" +
    "Start the simulator once, or pass the folder yourself: -Community `"D:\Path\To\Community`".") 3
}
Write-Host "Community folder(s):"
foreach ($t in $targets) { Write-Host "  MSFS $($t.Sim) ($($t.Store)): $($t.Community)" }

if ($DetectOnly) { exit 0 }

if ($Remove) {
  foreach ($t in $targets) { Remove-PanelFolder (Join-Path $t.Community $PackageName) }
  Write-Host "Done. Restart the simulator to drop the toolbar button."
  exit 0
}

# ---- SDK ----
if (-not $sdk) {
  Fail ("MSFS SDK not found: neither -SdkPath nor the MSFS_SDK / MSFS2024_SDK environment variable is set.`n" +
    "Install the free Microsoft Flight Simulator SDK: in the simulator turn on Developer Mode`n" +
    "(Options > General > Developers), then Help > SDK Installer. Details:`n" +
    "  $sdkDocs2020`n  $sdkDocs2024`n" +
    "Then open a NEW Command Prompt and run this again, or pass -SdkPath `"C:\MSFS SDK`".") 2
}
$tool = Join-Path $sdk.Root "Tools\bin\fspackagetool.exe"
if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
  Fail ("fspackagetool.exe not found at $tool (SDK from $($sdk.From)).`n" +
    "Reinstall the free MSFS SDK or pass -SdkPath with the SDK folder. Details:`n  $sdkDocs2020`n  $sdkDocs2024") 2
}
Write-Host "SDK: $($sdk.Root) (from $($sdk.From); builds MSFS $flavour packages)"

# ---- stage a copy with the port written into config.js ----
if (-not $BuildDir) { $BuildDir = Join-Path $env:LOCALAPPDATA "CargoOps\msfs-panel-build" }
$stage = Join-Path $BuildDir "project"
$project = Join-Path $stage "$PackageName.xml"
if ($PSCmdlet.ShouldProcess($stage, "Copy msfs-panel and set port $Port")) {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  foreach ($name in @("$PackageName.xml", "PackageDefinitions", "PackageSources")) {
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination $stage -Recurse -Force
  }
  $config = Join-Path $stage "PackageSources\html_ui\InGamePanels\CargoOpsPanel\config.js"
  $text = [IO.File]::ReadAllText($config)
  $text = [regex]::Replace($text, "port:\s*\d+", "port: $Port")
  [IO.File]::WriteAllText($config, $text, (New-Object Text.UTF8Encoding($false)))
}

# ---- build ----
$toolArgs = @($project, "-nopause")
if ($ForceSteam) { $toolArgs += "-forcesteam" }
$built = Join-Path $stage "Packages\$PackageName"
if ($PSCmdlet.ShouldProcess($project, "Run fspackagetool.exe $($toolArgs[1..($toolArgs.Count - 1)] -join ' ')")) {
  Write-Host "Building with $tool (the package tool may start the simulator in the background; this can take a few minutes)"
  & $tool @toolArgs
  if ($LASTEXITCODE -ne 0) { Fail "fspackagetool.exe failed (exit $LASTEXITCODE). See the messages above." 4 }
  if (-not (Test-Path -LiteralPath (Join-Path $built "layout.json"))) {
    $found = Get-ChildItem -LiteralPath $stage -Recurse -Filter layout.json -ErrorAction SilentlyContinue |
      Where-Object { $_.Directory.Name -eq $PackageName } | Select-Object -First 1
    if (-not $found) { Fail "The package tool finished but no $PackageName\layout.json was written under $stage." 4 }
    $built = $found.Directory.FullName
  }
  foreach ($need in @("manifest.json", "html_ui\InGamePanels\CargoOpsPanel\CargoOpsPanel.html")) {
    if (-not (Test-Path -LiteralPath (Join-Path $built $need))) { Fail "The built package lacks $need ($built)." 4 }
  }
  if (-not (Get-ChildItem -LiteralPath (Join-Path $built "InGamePanels") -Filter *.spb -ErrorAction SilentlyContinue)) {
    Fail "The built package has no InGamePanels\*.spb ($built)." 4
  }
  Write-Host "Built $built"
}

# ---- install ----
foreach ($t in $targets) {
  $dest = Join-Path $t.Community $PackageName
  Remove-PanelFolder $dest
  if ($PSCmdlet.ShouldProcess($dest, "Copy the built panel")) {
    Copy-Item -LiteralPath $built -Destination $dest -Recurse -Force
    Write-Host "  installed $dest"
  }
}
Write-Host ""
Write-Host "Done. Start Cargo Ops (scripts\start-cargo-ops.cmd), then the simulator: the Cargo Ops"
Write-Host "button appears in the toolbar (enable it in the toolbar's edit view if it is hidden)."
exit 0
