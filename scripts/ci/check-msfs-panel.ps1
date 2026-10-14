# W-47 (PC-58 without the owner's PC and without the MSFS SDK): runs scripts\build-msfs-panel.ps1
# the way the owner does (a new Windows PowerShell 5.1 process with -ExecutionPolicy Bypass)
# against a FAKE profile and a FAKE package tool:
#   - fake %LOCALAPPDATA% / %APPDATA% with UserCfg.opt files for MSFS 2020 (Store) and MSFS 2024
#     (Steam, with Community and Community2024), plus a 2024 Store UserCfg.opt without the
#     InstalledPackagesPath line (must be skipped with a warning);
#   - -DetectOnly lists the detected Community folders and changes nothing;
#   - no SDK (no MSFS_SDK / MSFS2024_SDK, no -SdkPath): exit 2 with a clear message naming the free
#     SDK docs, with and without -WhatIf; an -SdkPath without the tool: exit 2;
#   - a stand-in fspackagetool.exe compiled here (writes a package with layout.json, manifest.json,
#     a dummy .spb and the html_ui files; it is NOT the SDK tool) proves the staging (-Port written
#     into config.js), the tool arguments, the install into Community, -WhatIf (nothing run or
#     copied), -Community, a 2024 SDK going to Community2024, and -Remove (a junction is removed
#     as a link, its target untouched).
# Nothing here proves that the real package tool accepts msfs-panel\ or that the simulator shows
# the panel: that is PC-58.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\check-msfs-panel.ps1

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script = Join-Path $repo "scripts\build-msfs-panel.ps1"
$package = "cargo-ops-toolbar-panel"

function Check([bool]$condition, [string]$message) {
  if (-not $condition) { throw "Assertion failed: $message" }
  Write-Host "[ci] ok - $message"
}

$base = $env:RUNNER_TEMP
if (-not $base) { $base = [IO.Path]::GetTempPath() }
$tmp = Join-Path $base "cargo-ops-msfs-panel-ci"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# ---- fake profile ----
$fakeLocal = Join-Path $tmp "LocalAppData"
$fakeRoaming = Join-Path $tmp "AppData"
$pk2020 = Join-Path $tmp "Packages2020"
$pk2024 = Join-Path $tmp "Packages 2024"
foreach ($d in @("$pk2020\Community", "$pk2024\Community", "$pk2024\Community2024")) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
$opt2020 = Join-Path $fakeLocal "Packages\Microsoft.FlightSimulator_8wekyb3d8bbwe\LocalCache\UserCfg.opt"
$opt2024 = Join-Path $fakeRoaming "Microsoft Flight Simulator 2024\UserCfg.opt"
$opt2024Store = Join-Path $fakeLocal "Packages\Microsoft.Limitless_8wekyb3d8bbwe\LocalCache\UserCfg.opt"
foreach ($o in @($opt2020, $opt2024, $opt2024Store)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $o) | Out-Null
}
Set-Content -Path $opt2020 -Encoding Ascii -Value @("Version 1", "{Graphics", "}", "InstalledPackagesPath `"$pk2020`"")
Set-Content -Path $opt2024 -Encoding Ascii -Value @("Version 1", "InstalledPackagesPath `"$pk2024`"", "")
Set-Content -Path $opt2024Store -Encoding Ascii -Value @("Version 1", "{Sound", "}")

# ---- the stand-in package tool (NOT the SDK tool) ----
$fakeSdk = Join-Path $tmp "FakeSDK"
$fakeSdk2024 = Join-Path $tmp "Fake MSFS 2024 SDK"
$toolSource = @"
using System;
using System.IO;
public static class FakePackageTool {
  static void CopyDir(string from, string to) {
    Directory.CreateDirectory(to);
    foreach (string f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true);
    foreach (string d in Directory.GetDirectories(from)) CopyDir(d, Path.Combine(to, Path.GetFileName(d)));
  }
  public static int Main(string[] args) {
    string project = Path.GetFullPath(args[0]);
    string dir = Path.GetDirectoryName(project);
    File.AppendAllText(Path.Combine(Path.GetDirectoryName(dir), "fake-tool-args.txt"), string.Join("|", args) + Environment.NewLine);
    if (!File.Exists(project)) { Console.Error.WriteLine("no project " + project); return 7; }
    string pkg = Path.Combine(dir, "Packages", "$package");
    Directory.CreateDirectory(Path.Combine(pkg, "InGamePanels"));
    File.WriteAllText(Path.Combine(pkg, "InGamePanels", "$package.spb"), "stand-in, not a real spb");
    File.WriteAllText(Path.Combine(pkg, "layout.json"), "{\"content\":[]}");
    File.WriteAllText(Path.Combine(pkg, "manifest.json"), "{}");
    CopyDir(Path.Combine(dir, "PackageSources", "html_ui"), Path.Combine(pkg, "html_ui"));
    Console.WriteLine("stand-in package tool wrote " + pkg);
    return 0;
  }
}
"@
$fakeExe = Join-Path $fakeSdk "Tools\bin\fspackagetool.exe"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $fakeExe) | Out-Null
Add-Type -TypeDefinition $toolSource -OutputAssembly $fakeExe -OutputType ConsoleApplication
New-Item -ItemType Directory -Force -Path (Join-Path $fakeSdk2024 "Tools\bin") | Out-Null
Copy-Item $fakeExe (Join-Path $fakeSdk2024 "Tools\bin\fspackagetool.exe")
$emptySdk = Join-Path $tmp "EmptySDK"
New-Item -ItemType Directory -Force -Path $emptySdk | Out-Null

# ---- run the script like the owner, in a child Windows PowerShell ----
$saved = @{ LOCALAPPDATA = $env:LOCALAPPDATA; APPDATA = $env:APPDATA; MSFS_SDK = $env:MSFS_SDK; MSFS2024_SDK = $env:MSFS2024_SDK }
$buildDir = Join-Path $tmp "build"
$argsLog = Join-Path $buildDir "fake-tool-args.txt"

function Invoke-Panel([string[]]$arguments, [string]$sdk = "", [string]$sdk2024 = "") {
  $env:LOCALAPPDATA = $fakeLocal
  $env:APPDATA = $fakeRoaming
  if ($sdk) { $env:MSFS_SDK = $sdk } else { Remove-Item Env:MSFS_SDK -ErrorAction SilentlyContinue }
  if ($sdk2024) { $env:MSFS2024_SDK = $sdk2024 } else { Remove-Item Env:MSFS2024_SDK -ErrorAction SilentlyContinue }
  try {
    Write-Host "[ci] build-msfs-panel.ps1 $($arguments -join ' ')  (MSFS_SDK='$sdk' MSFS2024_SDK='$sdk2024')"
    # Stderr lines must not become terminating errors here (Windows PowerShell 5.1 turns
    # redirected native stderr into error records).
    $ErrorActionPreference = "Continue"
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script @arguments 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
  } finally {
    foreach ($k in $saved.Keys) {
      if ($null -eq $saved[$k]) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue } else { Set-Item "Env:$k" $saved[$k] }
    }
  }
  Write-Host $out
  return @{ Code = $code; Out = $out }
}

$c2020 = Join-Path $pk2020 "Community\$package"
$c2024 = Join-Path $pk2024 "Community\$package"
$c2024new = Join-Path $pk2024 "Community2024\$package"

# 1. Detection only.
$r = Invoke-Panel @("-DetectOnly")
Check ($r.Code -eq 0) "-DetectOnly exits 0 without an SDK"
Check ($r.Out.Contains("$pk2020\Community")) "detects the MSFS 2020 Store Community folder from UserCfg.opt"
Check ($r.Out.Contains("$pk2024\Community")) "detects the MSFS 2024 Steam Community folder (path with a space)"
Check ($r.Out.Contains("$pk2024\Community2024")) "lists MSFS 2024's Community2024 folder too"
Check ($r.Out.Contains("has no InstalledPackagesPath line")) "skips a UserCfg.opt without InstalledPackagesPath, with a warning"
Check (-not (Test-Path $c2020) -and -not (Test-Path $c2024)) "-DetectOnly changes nothing"

$r = Invoke-Panel @("-DetectOnly", "-Sim", "2020")
Check ($r.Code -eq 0 -and $r.Out.Contains("$pk2020\Community") -and -not $r.Out.Contains($pk2024)) "-Sim 2020 limits detection to MSFS 2020"

# 2. No SDK: a clear error, with and without -WhatIf.
foreach ($whatIf in @($false, $true)) {
  $extra = @()
  if ($whatIf) { $extra = @("-WhatIf") }
  $r = Invoke-Panel $extra
  Check ($r.Code -eq 2) "no SDK $($extra -join ' '): exit 2"
  Check ($r.Out.Contains("MSFS SDK not found")) "no SDK $($extra -join ' '): says the SDK is missing"
  Check ($r.Out.Contains("https://docs.flightsimulator.com/html/Introduction/SDK_Overview.htm")) "no SDK: names the free SDK docs"
  Check ($r.Out.Contains("-SdkPath")) "no SDK: says how to pass the SDK folder"
}
$r = Invoke-Panel @("-SdkPath", $emptySdk)
Check ($r.Code -eq 2 -and $r.Out.Contains("fspackagetool.exe not found")) "an -SdkPath without Tools\bin\fspackagetool.exe: exit 2, clear message"

# 3. -WhatIf with a (stand-in) SDK: nothing runs, nothing is copied.
$r = Invoke-Panel @("-BuildDir", $buildDir, "-WhatIf") $fakeSdk
Check ($r.Code -eq 0) "-WhatIf with an SDK exits 0"
Check ($r.Out -match "What if") "-WhatIf prints what it would do"
Check (-not (Test-Path $argsLog)) "-WhatIf does not run the package tool"
Check (-not (Test-Path $c2020) -and -not (Test-Path $c2024)) "-WhatIf installs nothing"

# 4. Build and install with -Port.
$r = Invoke-Panel @("-BuildDir", $buildDir, "-Port", "4399") $fakeSdk
Check ($r.Code -eq 0) "build with the stand-in tool exits 0"
$toolArgs = (Get-Content $argsLog | Select-Object -Last 1).Split("|")
Check ($toolArgs[0] -like "*\project\$package.xml") "the tool gets the staged project file ($($toolArgs[0]))"
Check ($toolArgs -contains "-nopause") "the tool runs with -nopause"
foreach ($dest in @($c2020, $c2024)) {
  Check (Test-Path (Join-Path $dest "layout.json")) "installed into $dest"
  $config = Get-Content -Raw (Join-Path $dest "html_ui\InGamePanels\CargoOpsPanel\config.js")
  Check ($config -match "port: 4399") "config.js in $dest carries -Port 4399"
}
Check (-not (Test-Path $c2024new)) "a 2020 SDK build goes to Community, not Community2024"
$repoConfig = Get-Content -Raw (Join-Path $repo "msfs-panel\PackageSources\html_ui\InGamePanels\CargoOpsPanel\config.js")
Check ($repoConfig -match "port: 4311") "the repository's config.js is untouched"

# 5. Rebuild replaces the installed copy (no stale files).
New-Item -ItemType File -Force -Path (Join-Path $c2020 "stale.txt") | Out-Null
$r = Invoke-Panel @("-BuildDir", $buildDir) $fakeSdk
Check ($r.Code -eq 0 -and -not (Test-Path (Join-Path $c2020 "stale.txt"))) "a rebuild replaces the installed folder"

# 6. -Remove (a junction is removed as a link only).
$target = Join-Path $tmp "linked-panel"
New-Item -ItemType Directory -Force -Path $target | Out-Null
Set-Content -Path (Join-Path $target "keep.txt") -Value "keep"
Remove-Item -Recurse -Force $c2024
cmd /c mklink /J "$c2024" "$target" | Out-Null
Check (Test-Path (Join-Path $c2024 "keep.txt")) "junction set up for the -Remove check"
$r = Invoke-Panel @("-Remove")
Check ($r.Code -eq 0) "-Remove exits 0 without an SDK"
Check (-not (Test-Path $c2020) -and -not (Test-Path $c2024)) "-Remove deletes the panel from every Community folder"
Check (Test-Path (Join-Path $target "keep.txt")) "-Remove deletes a junction as a link, never its target's files"

# 7. -Community and a 2024 SDK.
$custom = Join-Path $tmp "My Community"
New-Item -ItemType Directory -Force -Path $custom | Out-Null
$r = Invoke-Panel @("-BuildDir", $buildDir, "-Community", $custom) $fakeSdk
Check ($r.Code -eq 0 -and (Test-Path (Join-Path $custom "$package\layout.json"))) "-Community installs into the given folder"
Check (-not (Test-Path $c2020) -and -not (Test-Path $c2024)) "-Community installs nowhere else"
$r = Invoke-Panel @("-Community", (Join-Path $tmp "missing"))
Check ($r.Code -eq 3) "-Community with a missing folder: exit 3"

$r = Invoke-Panel @("-BuildDir", $buildDir) "" $fakeSdk2024
Check ($r.Code -eq 0) "build with a 2024 SDK (MSFS2024_SDK) exits 0"
Check (Test-Path (Join-Path $c2024new "layout.json")) "a 2024 SDK build goes to MSFS 2024's Community2024"
Check (-not (Test-Path $c2020)) "a 2024 SDK build is not installed for MSFS 2020"

Remove-Item -Recurse -Force $tmp
Write-Host "[ci] check-msfs-panel: PASS"
