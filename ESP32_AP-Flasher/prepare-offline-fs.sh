#!/usr/bin/env bash
# Stage LittleFS content for an offline-capable AP build.
# Run from ESP32_AP-Flasher/ before: pio run -t uploadfs
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
TAGTYPES_SRC="$REPO/resources/tagtypes"
TAGTYPES_DST="$ROOT/data/tagtypes"

echo "==> Gzip wwwroot -> data/www"
rm -rf "$ROOT/data/www"
cd "$ROOT"
python3 gzip_wwwfiles.py

echo "==> Copy tag type definitions -> data/tagtypes"
mkdir -p "$TAGTYPES_DST"
cp "$TAGTYPES_SRC"/*.json "$TAGTYPES_DST/"

echo "==> Offline bundle sizes"
du -sh "$ROOT/data/www" "$TAGTYPES_DST" "$ROOT/data/www/vendor" 2>/dev/null || true

echo "Done. Upload filesystem: pio run -e ESP32_S3_16_8_YELLOW_AP -t uploadfs"
echo "Optional: set \"offline\": 1 in /current/apconfig.json on the AP to block GitHub fallbacks."
