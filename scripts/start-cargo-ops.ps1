# Cargo Ops launcher (Windows PowerShell 5.1 and PowerShell 7).
#
#   1. Checks that Node.js 22.13+ is installed (24 LTS recommended).
#   2. Installs the connector dependencies with `npm ci` on first run.
#   3. Builds the web app as a static SPA into dist\client if it is missing.
#   4. Builds the connector.
#   5. Starts it on http://127.0.0.1:4311 and opens the browser.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\start-cargo-ops.ps1 [connector args]
# Example: ... -File scripts\start-cargo-ops.ps1 --sim fake --loop
# Pass -NoOpen to keep the browser closed and -Rebuild to rebuild the web app.

# No param() block on purpose: connector flags such as --sim must reach the
# connector untouched instead of being parsed as PowerShell parameters.
$NoOpen = $false
$Rebuild = $false
$ConnectorArgs = @()
foreach ($arg in $args) {
  if ($arg -eq "-NoOpen") { $NoOpen = $true }
  elseif ($arg -eq "-Rebuild") { $Rebuild = $true }
  else { $ConnectorArgs += [string]$arg }
}

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$connector = Join-Path $repo "connector"
$web = Join-Path $repo "dist\client"

function Fail([string]$message) {
  Write-Host ""
  Write-Host $message -ForegroundColor Red
  Write-Host ""
  exit 1
}

# 1. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "Node.js was not found. Install Node.js 24 LTS from https://nodejs.org and run this again."
}
$version = (& node -p "process.versions.node").Trim()
$parts = $version.Split(".")
$major = [int]$parts[0]
$minor = [int]$parts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 13)) {
  Fail "Node.js $version is too old. Install Node.js 24 LTS from https://nodejs.org (22.13 or newer also works)."
}
Write-Host "Node.js $version found."

# 2 + 3. Dependencies and web build (shared with build-local.ps1)
$buildScript = Join-Path $PSScriptRoot "build-local.ps1"
if ($Rebuild) { & $buildScript -Rebuild } else { & $buildScript }
if ($LASTEXITCODE -ne 0) { Fail "Build failed (exit code $LASTEXITCODE)." }

# 5. Start the connector. It keeps running until you press Ctrl+C or close the window.
$main = Join-Path $connector "dist\connector\src\cli\main.js"
$runArgs = @("--disable-warning=ExperimentalWarning", $main, "--web", $web)
if (-not $NoOpen) { $runArgs += "--open" }
if ($ConnectorArgs.Count -gt 0) { $runArgs += $ConnectorArgs }

Write-Host ""
Write-Host "Starting Cargo Ops. Leave this window open while you fly; press Ctrl+C to stop."
# Run from the caller's folder (no Push-Location): relative paths you pass, such as
# --record connector\fixtures\my-flight.jsonl, then resolve from where you ran the
# script. The connector's own defaults are anchored to its install folder.
# Connector warnings go to stderr: let them through (see Run in build-local.ps1); the exit
# code is what counts.
$ErrorActionPreference = "Continue"
& node @runArgs
exit $LASTEXITCODE
