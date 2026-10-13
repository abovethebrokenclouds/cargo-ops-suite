#!/usr/bin/env bash
# Download a local Protomaps basemap for Cargo Ops (Linux/macOS; Windows: fetch-basemap.ps1).
#
#   scripts/fetch-basemap.sh [--date YYYYMMDD] [--dir <basemap dir>] [--maxzoom 7]
#                            [--bbox minLon,minLat,maxLon,maxLat --region-maxzoom 11]
#
# 1. downloads the go-pmtiles CLI (BSD-3-Clause, github.com/protomaps/go-pmtiles) release
#    for this OS into <dir>/.bin
# 2. `pmtiles extract` a world z0-<maxzoom> extract from the dated Protomaps daily build
#    https://build.protomaps.com/YYYYMMDD.pmtiles (range requests; only needed tiles move)
#    into <dir>/basemap.pmtiles, and optionally a regional extract into <dir>/region.pmtiles
#
# The output is OpenStreetMap data (ODbL): the map must show "© OpenStreetMap contributors",
# which Cargo Ops does automatically for the local basemap. Never commit the .pmtiles files.
set -euo pipefail

DATE="$(date -u -d 'yesterday' +%Y%m%d 2>/dev/null || date -u -v-1d +%Y%m%d)"
DIR="${XDG_CONFIG_HOME:-$HOME/.config}/cargo-ops/basemap"
MAXZOOM=7
BBOX=""
REGION_MAXZOOM=11

while [ $# -gt 0 ]; do
  case "$1" in
    --date) DATE="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --maxzoom) MAXZOOM="$2"; shift 2 ;;
    --bbox) BBOX="$2"; shift 2 ;;
    --region-maxzoom) REGION_MAXZOOM="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$DATE" =~ ^[0-9]{8}$ ]]; then echo "--date must be YYYYMMDD" >&2; exit 2; fi
SOURCE="https://build.protomaps.com/${DATE}.pmtiles"
mkdir -p "$DIR/.bin"

case "$(uname -s)" in
  Linux) OS="Linux" ;;
  Darwin) OS="Darwin" ;;
  *) echo "Unsupported OS; use scripts/fetch-basemap.ps1 on Windows" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH="x86_64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

PMTILES="$DIR/.bin/pmtiles"
if [ ! -x "$PMTILES" ]; then
  echo "Looking up the latest go-pmtiles release..."
  URL="$(curl -fsSL https://api.github.com/repos/protomaps/go-pmtiles/releases/latest \
    | grep -o "\"browser_download_url\": *\"[^\"]*_${OS}_${ARCH}[^\"]*\"" \
    | head -n1 | sed 's/.*"\(https[^"]*\)"/\1/')"
  if [ -z "$URL" ]; then echo "No go-pmtiles release asset for ${OS}_${ARCH}" >&2; exit 1; fi
  echo "Downloading $URL"
  TMP="$(mktemp -d)"
  curl -fL -o "$TMP/pmtiles-archive" "$URL"
  case "$URL" in
    *.zip) unzip -o -q "$TMP/pmtiles-archive" -d "$TMP" ;;
    *) tar -xzf "$TMP/pmtiles-archive" -C "$TMP" ;;
  esac
  mv "$TMP/pmtiles" "$PMTILES"
  chmod +x "$PMTILES"
  rm -rf "$TMP"
fi

echo "World extract z0-${MAXZOOM} from $SOURCE"
"$PMTILES" extract "$SOURCE" "$DIR/basemap.pmtiles.part" --maxzoom="$MAXZOOM"
mv "$DIR/basemap.pmtiles.part" "$DIR/basemap.pmtiles"

if [ -n "$BBOX" ]; then
  echo "Regional extract z0-${REGION_MAXZOOM} for bbox $BBOX"
  "$PMTILES" extract "$SOURCE" "$DIR/region.pmtiles.part" --bbox="$BBOX" --maxzoom="$REGION_MAXZOOM"
  mv "$DIR/region.pmtiles.part" "$DIR/region.pmtiles"
fi

echo
echo "Basemap folder: $DIR"
ls -lh "$DIR"/*.pmtiles
echo "Data © OpenStreetMap contributors (ODbL), Protomaps build ${DATE}. Do not commit these files."
echo "Start the connector with --basemap-dir \"$DIR\" if this is not <data-dir>/basemap."
