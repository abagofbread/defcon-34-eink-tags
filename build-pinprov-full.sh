#!/usr/bin/env bash
# Build SOLUM_AUTODETECT_pinprov_FULL_vNN.s37 (bootloader + app).
# Tries Simplicity Commander convert first; falls back to bincopy + S7 EOF
# (same method used for the working pinprov_FULL_v43 image).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=pinprov-paths.sh
source "$ROOT/pinprov-paths.sh"
pinprov_load_paths "$ROOT"
TAG_FW_ROOT="$TAG_FW"
BOOTLOADER_S37="${BOOTLOADER_S37:-$TAG_FW_ROOT/bootloader/variant_binaries/SOLUM_AUTODETECT.s37}"
FALLBACK_COMMANDER="/tmp/commander-dl/SimplicityCommander-Mac/Commander-cli.app/Contents/MacOS/commander-cli"
COMMANDER="${COMMANDER:-$FALLBACK_COMMANDER}"
if [[ ! -x "$COMMANDER" ]]; then
    COMMANDER="$ROOT/tools/Commander-cli.app/Contents/MacOS/commander-cli"
fi

APP="${1:-${PINPROV_FIRMWARE:-$ROOT/firmware/SOLUM_AUTODETECT_pinprov_v54.s37}}"

if [[ "$APP" =~ pinprov_v([0-9]+)\.s37$ ]]; then
    VER="${BASH_REMATCH[1]}"
else
    echo "Cannot infer version from app image name: $APP" >&2
    echo "Expected: .../SOLUM_AUTODETECT_pinprov_vNN.s37" >&2
    exit 1
fi

OUT="${PINPROV_FULL_FIRMWARE:-$ROOT/firmware/SOLUM_AUTODETECT_pinprov_FULL_v${VER}.s37}"

[[ -f "$BOOTLOADER_S37" ]] || { echo "Bootloader not found: $BOOTLOADER_S37" >&2; exit 1; }
[[ -f "$APP" ]] || { echo "App firmware not found: $APP" >&2; exit 1; }

build_with_commander() {
    echo "Commander:  $COMMANDER" >&2
    echo "Bootloader: $BOOTLOADER_S37" >&2
    echo "App:        $APP" >&2
    echo "Output:     $OUT" >&2
    "$COMMANDER" convert -o "$OUT" "$BOOTLOADER_S37" "$APP"
}

build_with_bincopy() {
    echo "Building FULL image with bincopy (bootloader + app + S7 EOF)..." >&2
    python3 -c "import bincopy" 2>/dev/null || pip3 install -q bincopy
    python3 - "$BOOTLOADER_S37" "$APP" "$OUT" <<'PY'
import bincopy, sys
bl_p, app_p, out_p = sys.argv[1:4]
bl = bincopy.BinFile(bl_p)
app = bincopy.BinFile(app_p)
merged = bincopy.BinFile()
merged.add_binary(bytes(bl[bl.minimum_address:bl.maximum_address + 1]), bl.minimum_address)
merged.add_binary(bytes(app[app.minimum_address:app.maximum_address + 1]), app.minimum_address, overwrite=True)
with open(out_p, "w", newline="\n") as f:
    f.write(merged.as_srec())
    f.write("S70500000000FA\n")
import os
size = os.path.getsize(out_p)
if size < 500000:
    raise SystemExit(f"output suspiciously small ({size} bytes): {out_p}")
print(f"Wrote {out_p} ({size} bytes)")
PY
}

if [[ -x "$COMMANDER" ]] && build_with_commander 2>/dev/null; then
    echo "Built with Commander." >&2
else
    echo "Commander not available or failed — using bincopy fallback." >&2
    build_with_bincopy
fi

ls -la "$OUT" >&2
tail -1 "$OUT" >&2
echo "Done." >&2
