# W-45 (PC-45 without the owner's PC): runs scripts\create-shortcut.ps1 the way the owner does
# (a new Windows PowerShell process with -ExecutionPolicy Bypass) and checks the .lnk files:
#   default        -> Start menu + desktop shortcuts to start-cargo-ops.cmd, app icon, no args
#   -Startup       -> shell:startup shortcut, minimised (WindowStyle 7), Arguments -NoOpen
#   -Remove        -> Start menu + desktop shortcuts gone, the Startup one untouched
#   -Startup -Remove -> Startup shortcut gone
# GitHub's Windows runner account is an administrator, so "no admin prompt" cannot be shown
# here; instead every shortcut must land inside the user's own profile, which needs no rights.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\check-shortcuts.ps1

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script = Join-Path $repo "scripts\create-shortcut.ps1"
$launcher = Join-Path $repo "scripts\start-cargo-ops.cmd"
$icon = Join-Path $repo "public\favicon.ico"

function Check([bool]$condition, [string]$message) {
  if (-not $condition) { throw "Assertion failed: $message" }
  Write-Host "[ci] ok - $message"
}

function Same([string]$a, [string]$b) {
  return [string]::Equals($a.TrimEnd([char]92), $b.TrimEnd([char]92), [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-CreateShortcut([string[]]$switches) {
  Write-Host "[ci] create-shortcut.ps1 $($switches -join ' ')"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script @switches
  if ($LASTEXITCODE -ne 0) { throw "create-shortcut.ps1 $($switches -join ' ') exited $LASTEXITCODE" }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "[ci] running elevated: $elevated (GitHub runner; the owner's PC will not be)"

$folders = [ordered]@{
  StartMenu = [Environment]::GetFolderPath("Programs")
  Desktop   = [Environment]::GetFolderPath("Desktop")
  Startup   = [Environment]::GetFolderPath("Startup")
}
foreach ($name in $folders.Keys) {
  $dir = $folders[$name]
  Check ($dir -ne "") "$name folder resolves ($dir)"
  Check ($dir.StartsWith($env:USERPROFILE, [StringComparison]::OrdinalIgnoreCase)) "$name folder is inside the user profile"
  if (-not (Test-Path $dir)) {
    Write-Host "[ci] note: $dir did not exist on the runner; creating it"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
}
$lnk = @{}
foreach ($name in $folders.Keys) { $lnk[$name] = Join-Path $folders[$name] "Cargo Ops.lnk" }

# Start from nothing.
foreach ($path in $lnk.Values) { if (Test-Path $path) { Remove-Item $path } }

$shell = New-Object -ComObject WScript.Shell
function Check-Shortcut([string]$path, [string]$arguments, [int]$style) {
  Check (Test-Path $path) "$path exists"
  $s = $shell.CreateShortcut($path)
  Check (Same $s.TargetPath $launcher) "target is start-cargo-ops.cmd ($($s.TargetPath))"
  Check (Same $s.WorkingDirectory $repo) "working directory is the repository ($($s.WorkingDirectory))"
  Check ($s.Arguments -eq $arguments) "arguments are '$arguments' ('$($s.Arguments)')"
  Check ($s.WindowStyle -eq $style) "window style $style ($($s.WindowStyle))"
  Check ($s.IconLocation -like "$icon,0") "icon is public\favicon.ico ($($s.IconLocation))"
}

Check (Test-Path $icon) "the app icon public\favicon.ico exists"

Invoke-CreateShortcut @()
Check-Shortcut $lnk.StartMenu "" 1
Check-Shortcut $lnk.Desktop "" 1
Check (-not (Test-Path $lnk.Startup)) "no Startup shortcut without -Startup"

Invoke-CreateShortcut @("-Startup")
Check-Shortcut $lnk.Startup "-NoOpen" 7

Invoke-CreateShortcut @("-Remove")
Check (-not (Test-Path $lnk.StartMenu)) "-Remove deletes the Start menu shortcut"
Check (-not (Test-Path $lnk.Desktop)) "-Remove deletes the desktop shortcut"
Check (Test-Path $lnk.Startup) "-Remove alone leaves the Startup shortcut"

Invoke-CreateShortcut @("-Startup", "-Remove")
Check (-not (Test-Path $lnk.Startup)) "-Startup -Remove deletes the Startup shortcut"

Write-Host "[ci] check-shortcuts: PASS"
