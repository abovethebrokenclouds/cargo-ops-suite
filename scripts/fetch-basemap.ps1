<#
.SYNOPSIS
  Download a local Protomaps basemap for Cargo Ops (Windows).

.DESCRIPTION
  1. Downloads the go-pmtiles CLI (BSD-3-Clause, github.com/protomaps/go-pmtiles) release
     for Windows into <Dir>\.bin.
  2. Runs `pmtiles extract` for a world z0-<MaxZoom> extract of the dated Protomaps daily
     build https://build.protomaps.com/YYYYMMDD.pmtiles into <Dir>\basemap.pmtiles, and
     optionally a regional extract (-Bbox) into <Dir>\region.pmtiles.

  The output is OpenStreetMap data (ODbL): the map must show "© OpenStreetMap contributors",
  which Cargo Ops does automatically for the local basemap. Never commit the .pmtiles files.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\fetch-basemap.ps1
  powershell -ExecutionPolicy Bypass -File scripts\fetch-basemap.ps1 -Bbox "-125,24,-66,50" -RegionMaxZoom 11
#>
param(
  [string]$Date = (Get-Date).ToUniversalTime().AddDays(-1).ToString("yyyyMMdd"),
  [string]$Dir = (Join-Path $env:LOCALAPPDATA "CargoOps\basemap"),
  [int]$MaxZoom = 7,
  [string]$Bbox = "",
  [int]$RegionMaxZoom = 11
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($Date -notmatch '^\d{8}$') { throw "-Date must be YYYYMMDD" }
$source = "https://build.protomaps.com/$Date.pmtiles"
$bin = Join-Path $Dir ".bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null

$pmtiles = Join-Path $bin "pmtiles.exe"
if (-not (Test-Path $pmtiles)) {
  Write-Host "Looking up the latest go-pmtiles release..."
  $headers = @{ "User-Agent" = "CargoOps-fetch-basemap" }
  # Optional and never needed on a PC: CI passes its own token only to avoid GitHub's
  # anonymous API rate limit on shared runner addresses.
  if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $env:GITHUB_TOKEN" }
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/protomaps/go-pmtiles/releases/latest" `
    -Headers $headers
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x86_64" }
  $asset = $release.assets | Where-Object { $_.name -like "*_Windows_$arch.zip" } | Select-Object -First 1
  if (-not $asset) { throw "No go-pmtiles release asset for Windows_$arch" }
  Write-Host "Downloading $($asset.browser_download_url)"
  $zip = Join-Path $env:TEMP $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip
  $unpack = Join-Path $env:TEMP "pmtiles-$([guid]::NewGuid())"
  Expand-Archive -Path $zip -DestinationPath $unpack -Force
  Move-Item -Force (Join-Path $unpack "pmtiles.exe") $pmtiles
  Remove-Item -Recurse -Force $unpack, $zip
}

Write-Host "World extract z0-$MaxZoom from $source"
$part = Join-Path $Dir "basemap.pmtiles.part"
& $pmtiles extract $source $part "--maxzoom=$MaxZoom"
if ($LASTEXITCODE -ne 0) { throw "pmtiles extract failed ($LASTEXITCODE). Is the build date $Date still published?" }
Move-Item -Force $part (Join-Path $Dir "basemap.pmtiles")

if ($Bbox) {
  Write-Host "Regional extract z0-$RegionMaxZoom for bbox $Bbox"
  $rpart = Join-Path $Dir "region.pmtiles.part"
  & $pmtiles extract $source $rpart "--bbox=$Bbox" "--maxzoom=$RegionMaxZoom"
  if ($LASTEXITCODE -ne 0) { throw "regional pmtiles extract failed ($LASTEXITCODE)" }
  Move-Item -Force $rpart (Join-Path $Dir "region.pmtiles")
}

Write-Host ""
Write-Host "Basemap folder: $Dir"
Get-ChildItem (Join-Path $Dir "*.pmtiles") | ForEach-Object {
  "{0,-20} {1,10:N1} MB" -f $_.Name, ($_.Length / 1MB)
}
Write-Host "Data (c) OpenStreetMap contributors (ODbL), Protomaps build $Date. Do not commit these files."
Write-Host "Start the connector with --basemap-dir `"$Dir`" if this is not <data-dir>\basemap."
