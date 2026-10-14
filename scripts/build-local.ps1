# Builds everything the local Cargo Ops install needs, without starting it:
#   - connector dependencies (npm ci in connector\, only when node_modules is missing)
#   - the web app as a static SPA in dist\client (only when missing, or with -Rebuild)
#   - the connector (always; it is quick)
#
# Uses bun for the web build when it is installed (bun run build:local), otherwise
# npm: `npm install --no-package-lock` in the repo root, then `npx vite build` with
# CARGO_OPS_LOCAL=1. The repo's lockfile is bun.lock, so the npm path resolves the
# package.json version ranges itself.
#
# npm 10 (bundled with Node 22) crashes on this dependency tree while it resolves peer
# dependencies ("Cannot read properties of null (reading 'edgesOut')", a bug in npm's
# arborist that npm 11 fixed). With npm older than 11 the install therefore adds
# --legacy-peer-deps, which skips automatic peer installation; the peers it leaves out
# are test, lint and server-runtime packages the static SPA build does not use (the
# built dist\client is the same as with npm 11). The Windows CI launcher job runs both
# paths: Node 24 (npm 11) and Node 22 (npm 10).
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\build-local.ps1 [-Rebuild]

param([switch]$Rebuild)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$connector = Join-Path $repo "connector"
$shell = Join-Path $repo "dist\client\_shell.html"

function Run([string]$what, [scriptblock]$block) {
  Write-Host "==> $what"
  # Windows PowerShell 5.1 turns each stderr line of a native command (npm prints
  # "npm warn deprecated ..." there) into an error record when its output is redirected,
  # e.g. `start-cargo-ops.cmd > log.txt 2>&1`; under "Stop" the first warning would abort
  # the build. The exit code decides success instead.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $block } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) {
    Write-Host "$what failed (exit code $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

# Connector dependencies
if (-not (Test-Path (Join-Path $connector "node_modules"))) {
  Push-Location $connector
  try { Run "Installing connector dependencies (npm ci)" { npm ci } } finally { Pop-Location }
}

# Web app (static SPA)
if ($Rebuild -or -not (Test-Path $shell)) {
  Push-Location $repo
  try {
    $bun = Get-Command bun -ErrorAction SilentlyContinue
    if ($bun) {
      if (-not (Test-Path (Join-Path $repo "node_modules"))) {
        Run "Installing web dependencies (bun install)" { bun install --frozen-lockfile }
      }
      Run "Building the web app (bun run build:local)" { bun run build:local }
    } else {
      if (-not (Test-Path (Join-Path $repo "node_modules"))) {
        $npmArgs = @("install", "--no-package-lock", "--no-audit", "--no-fund")
        $npmVersion = ""
        try { $npmVersion = ([string](& npm --version)).Trim() } catch { $npmVersion = "" }
        $npmMajor = 0
        if (-not [int]::TryParse(($npmVersion -split "\.")[0], [ref]$npmMajor)) { $npmMajor = 0 }
        if ($npmMajor -lt 11) {
          # See the header: npm 10's peer resolution crashes on this tree.
          Write-Host "npm $npmVersion found (older than 11): installing with --legacy-peer-deps."
          $npmArgs += "--legacy-peer-deps"
        }
        Run "Installing web dependencies (npm $($npmArgs -join ' '))" { npm @npmArgs }
      }
      $env:CARGO_OPS_LOCAL = "1"
      try {
        Run "Building the web app (vite build, CARGO_OPS_LOCAL=1)" { npx vite build }
      } finally {
        Remove-Item Env:\CARGO_OPS_LOCAL -ErrorAction SilentlyContinue
      }
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "==> Web app already built (dist\client). Use -Rebuild after pulling changes."
}

# Connector
Push-Location $connector
try { Run "Building the connector (npm run build)" { npm run build } } finally { Pop-Location }

Write-Host "==> Build complete."
exit 0
