# Creates Windows shortcuts to the Cargo Ops launcher (scripts\start-cargo-ops.cmd).
# No administrator rights needed: everything goes into your own user profile.
#
# Usage (from the repository folder):
#   powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1               # Start menu + desktop
#   powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1 -StartMenu    # Start menu only
#   powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1 -Desktop      # desktop only
#   powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1 -Startup      # start with Windows
#                                                                                      # (runs with -NoOpen)
#   powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1 -Remove       # delete them again
#
# -Startup puts a shortcut into shell:startup (your user's Startup folder) that starts the
# connector minimised with -NoOpen, so it is running when you open the browser or the
# installed app. Combine switches as you like, e.g. -StartMenu -Startup.

param(
  [switch]$StartMenu,
  [switch]$Desktop,
  [switch]$Startup,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot "start-cargo-ops.cmd"
$icon = Join-Path $repo "public\favicon.ico"
if (-not (Test-Path $launcher)) {
  Write-Host "Launcher not found: $launcher" -ForegroundColor Red
  exit 1
}
if (-not ($StartMenu -or $Desktop -or $Startup)) {
  $StartMenu = $true
  $Desktop = $true
}

$targets = @()
if ($StartMenu) {
  $targets += @{ Dir = [Environment]::GetFolderPath("Programs"); Args = ""; Style = 1 }
}
if ($Desktop) {
  $targets += @{ Dir = [Environment]::GetFolderPath("Desktop"); Args = ""; Style = 1 }
}
if ($Startup) {
  # 7 = minimised window.
  $targets += @{ Dir = [Environment]::GetFolderPath("Startup"); Args = "-NoOpen"; Style = 7 }
}

$shell = New-Object -ComObject WScript.Shell
foreach ($t in $targets) {
  $path = Join-Path $t.Dir "Cargo Ops.lnk"
  if ($Remove) {
    if (Test-Path $path) {
      Remove-Item $path
      Write-Host "Removed $path"
    }
    continue
  }
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $launcher
  $lnk.Arguments = $t.Args
  $lnk.WorkingDirectory = $repo
  $lnk.WindowStyle = $t.Style
  $lnk.Description = "Start the Cargo Ops connector on http://127.0.0.1:4311"
  if (Test-Path $icon) { $lnk.IconLocation = "$icon,0" }
  $lnk.Save()
  Write-Host "Created $path"
}
