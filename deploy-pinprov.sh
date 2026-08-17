#!/usr/bin/env bash
# Build / flash pin-prov firmware.
#
# Tag FW iteration (preferred — skips slow AP build/flash):
#   ./deploy-pinprov.sh build-tag     build tag + J-Link flash
#
# Full stack (tag + AP build, then flash both):
#   ./deploy-pinprov.sh               same as: all
#   ./deploy-pinprov.sh build         build only, no flash
#   ./deploy-pinprov.sh flash-tag     flash last build
#   ./deploy-pinprov.sh flash-ap      AP firmware + LittleFS only
#
# Version: each tag build auto-increments SL_APPLICATION_VERSION in EFR32xG22_OEPL.slcp.
#   PINPROV_VERSION=N   use N and sync slcp (no auto +1)
#   PINPROV_NO_BUMP=1   build current slcp version unchanged
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=pinprov-paths.sh
source "$ROOT/pinprov-paths.sh"
pinprov_load_paths "$ROOT"

AP_ENV="${AP_ENV:-ESP32_S3_16_8_YELLOW_AP}"
OPENOCD_CFG="${OPENOCD_CFG:-$ROOT/openocd-jlink.cfg}"
LOG="$ROOT/deploy-pinprov.log"
TS="$(date +%Y%m%d-%H%M%S)"

log() { echo "[$TS] $*" | tee -a "$LOG"; }
err() { echo "[$TS] ERROR: $*" | tee -a "$LOG" >&2; }

require_firmware_paths() {
    require_tag_fw
    require_ap_dir
}

require_tag_fw() {
    if [[ ! -d "$TAG_FW/firmware" ]]; then
        err "Tag FW not found: $TAG_FW/firmware"
        err "Tried auto-discovery; set TAG_FW_ROOT or edit local-env.sh"
        exit 1
    fi
}

require_ap_dir() {
    if [[ ! -d "$AP_DIR/src" ]]; then
        err "AP not found: $AP_DIR/src"
        err "Tried auto-discovery; set AP_DIR or edit local-env.sh"
        exit 1
    fi
}

# Simplicity Studio exports firmware/out/ (Makefile + SDK). Not in git — seed once locally.
ensure_tag_fw_out_tree() {
    local out="$TAG_FW/firmware/out" seed=""
    if [[ -f "$out/EFR32xG22_OEPL.Makefile" ]]; then
        return 0
    fi
    for seed in \
        "$ROOT/../../art_projects/Tag_FW_EFR32xG22/firmware/out" \
        "$ROOT/../../art_projects/oepl-defcon-name-tag/Tag_FW_EFR32xG22/firmware/out"; do
        if [[ -f "$seed/EFR32xG22_OEPL.Makefile" ]]; then
            log "Seeding $out from existing build tree ($(dirname "$seed"))"
            mkdir -p "$TAG_FW/firmware"
            rsync -a "$seed/" "$out/"
            return 0
        fi
    done
    err "Missing $out (Simplicity Studio build export)."
    err "Open Tag_FW_EFR32xG22 in Simplicity Studio and build once, or copy firmware/out from a machine that has."
    exit 1
}

find_ap_port() {
    local p
    for p in /dev/cu.usbmodem* /dev/cu.usbserial-* /dev/cu.SLAB_USBtoUART /dev/cu.wchusbserial*; do
        [[ -e "$p" ]] || continue
        echo "$p"
        return 0
    done
    return 1
}

jlink_present() {
    command -v JLinkExe >/dev/null 2>&1
}

# Single source for pinprov build number: auto-bump SL_APPLICATION_VERSION in slcp each build.
read_slcp_version() {
    awk '/SL_APPLICATION_VERSION/ {gsub(/'"'"'|"|\}|\s/, "", $5); print $5; exit}' \
        "$TAG_FW/firmware/EFR32xG22_OEPL.slcp" 2>/dev/null || echo 55
}

write_slcp_version() {
    local ver="$1"
    local slcp="$TAG_FW/firmware/EFR32xG22_OEPL.slcp"
    [[ -f "$slcp" ]] || return 1
    sed -i '' "s/- {name: SL_APPLICATION_VERSION, value: '[0-9]*'}/- {name: SL_APPLICATION_VERSION, value: '${ver}'}/" "$slcp"
}

pinprov_version() {
    local cur next
    cur="$(read_slcp_version)"
    if [[ -n "${PINPROV_VERSION:-}" ]]; then
        next="$PINPROV_VERSION"
    elif [[ -n "${PINPROV_NO_BUMP:-}" ]]; then
        next="$cur"
    else
        next=$((cur + 1))
    fi
    if [[ "$next" != "$cur" ]] || [[ -n "${PINPROV_VERSION:-}" ]]; then
        write_slcp_version "$next" || true
    fi
    echo "$next"
}

verify_image_pinprov_version() {
    local image="$1" ver="$2" tmp id
    command -v arm-none-eabi-objcopy >/dev/null \
        || { err "arm-none-eabi-objcopy not found (ARM GCC toolchain)"; return 1; }
    tmp="$(mktemp "${TMPDIR:-/tmp}/pinprov-verify.XXXXXX.bin")"
    arm-none-eabi-objcopy -I srec -O binary "$image" "$tmp" 2>/dev/null \
        || { rm -f "$tmp"; err "cannot read s37 for version check: $image"; return 1; }
    id="$(strings "$tmp" 2>/dev/null | grep 'OEPL_FW_ID:' | sed -n 's/.*pinprov=\([0-9][0-9]*\).*/\1/p' | head -1)"
    rm -f "$tmp"
    if [[ "$id" != "$ver" ]]; then
        err "image version mismatch: expected pinprov=$ver in $image, got pinprov=${id:-<missing>}"
        return 1
    fi
    log "verified: pinprov=$ver in $(basename "$image")"
}

# .slcp defines do not auto-export into Simplicity Studio's project.mak — keep OEPL_FW_SUFFIX in sync.
sync_oepl_fw_suffix_mak() {
    local mak="$TAG_FW/firmware/out/EFR32xG22_OEPL.project.mak"
    local suffix
    [[ -f "$mak" ]] || return 0
    suffix="$(awk '/name: OEPL_FW_SUFFIX/{getline; gsub(/["'\'' ]/, "", $2); print $2; exit}' \
        "$TAG_FW/firmware/EFR32xG22_OEPL.slcp" 2>/dev/null || true)"
    [[ -n "$suffix" ]] || suffix=defcon
    if grep -q "OEPL_FW_SUFFIX=\"${suffix}\"" "$mak" 2>/dev/null; then
        return 0
    fi
    sed -i '' "s/-DOEPL_FW_SUFFIX=\"[^\"]*\"/-DOEPL_FW_SUFFIX=\"${suffix}\"/g" "$mak"
    log "synced OEPL_FW_SUFFIX=\"${suffix}\" into $(basename "$mak")"
}

step_build_tag() {
    local ver app full out_dir
    ver="$(pinprov_version)"
    log "=== build tag FW (pinprov v${ver}, slcp SL_APPLICATION_VERSION=${ver}) ==="
    ensure_tag_fw_out_tree
    sync_oepl_fw_suffix_mak
    cp "$TAG_FW/firmware/oepl_app.c" "$TAG_FW/firmware/out/oepl_app.c"
    cp "$TAG_FW/firmware/oepl_nvm.c" "$TAG_FW/firmware/out/oepl_nvm.c"
    cp "$TAG_FW/firmware/oepl_nvm.h" "$TAG_FW/firmware/out/oepl_nvm.h"
    cp "$TAG_FW/firmware/oepl_provision.c" "$TAG_FW/firmware/out/oepl_provision.c"
    cp "$TAG_FW/firmware/oepl_provision.h" "$TAG_FW/firmware/out/oepl_provision.h"
    cp "$TAG_FW/firmware/oepl_display.c" "$TAG_FW/firmware/out/oepl_display.c"
    cp "$TAG_FW/firmware/oepl_display.h" "$TAG_FW/firmware/out/oepl_display.h"
    cp "$TAG_FW/firmware/oepl_radio.c" "$TAG_FW/firmware/out/oepl_radio.c"
    cp "$TAG_FW/firmware/oepl_pinprov_debug.h" "$TAG_FW/firmware/out/oepl_pinprov_debug.h"
    cp "$TAG_FW/firmware/oepl_fw_identity.c" "$TAG_FW/firmware/out/oepl_fw_identity.c"
    cp "$TAG_FW/firmware/oepl_fw_identity.h" "$TAG_FW/firmware/out/oepl_fw_identity.h"
    cp "$TAG_FW/firmware/oepl_hw_abstraction.c" "$TAG_FW/firmware/out/oepl_hw_abstraction.c"
    cp "$TAG_FW/firmware/oepl_flash_driver.c" "$TAG_FW/firmware/out/oepl_flash_driver.c"
    cp "$TAG_FW/firmware/oepl_flash_driver.h" "$TAG_FW/firmware/out/oepl_flash_driver.h"
    cp "$TAG_FW/firmware/oepl_compression.cpp" "$TAG_FW/firmware/out/oepl_compression.cpp"
    cp "$TAG_FW/firmware/oepl_compression.hpp" "$TAG_FW/firmware/out/oepl_compression.hpp"
    cp "$TAG_FW/firmware/oepl_drawing.cpp" "$TAG_FW/firmware/out/oepl_drawing.cpp"
    cp "$TAG_FW/firmware/oepl_drawing.hpp" "$TAG_FW/firmware/out/oepl_drawing.hpp"
    cp "$TAG_FW/firmware/oepl_drawing_capi.h" "$TAG_FW/firmware/out/oepl_drawing_capi.h"
    cp "$TAG_FW/firmware/oepl_efr32_hwtypes.c" "$TAG_FW/firmware/out/oepl_efr32_hwtypes.c"
    cp "$TAG_FW/firmware/oepl_display_diag.c" "$TAG_FW/firmware/out/oepl_display_diag.c"
    cp "$TAG_FW/firmware/common/defcon34_logo.h" "$TAG_FW/firmware/out/common/defcon34_logo.h"
    out_dir="$TAG_FW/firmware/out/build/debug"
    # Makefile does not track PINPROV_VERSION in C_DEFS — drop stale identity objects.
    rm -f "$out_dir/oepl_fw_identity.o" "$out_dir/oepl_hw_abstraction.o" "$out_dir/EFR32xG22_OEPL.s37"
    make -f EFR32xG22_OEPL.Makefile -j4 -C "$TAG_FW/firmware/out" "PINPROV_VERSION=$ver"
    app="$ROOT/firmware/SOLUM_AUTODETECT_pinprov_v${ver}.s37"
    full="$ROOT/firmware/SOLUM_AUTODETECT_pinprov_FULL_v${ver}.s37"
    cp "$TAG_FW/firmware/out/build/debug/EFR32xG22_OEPL.s37" "$app"
    verify_image_pinprov_version "$app" "$ver"
    "$ROOT/build-pinprov-full.sh" "$app"
    [[ -f "$full" ]] || { err "FULL image missing after build: $full"; exit 1; }
    echo "$full" > "$ROOT/firmware/.flash-image"
    echo "$ver" > "$ROOT/firmware/.pinprov-version"
    log "tag build OK: app=$app FULL=$full ($(wc -c <"$full" | tr -d ' ') bytes)"
}

step_build_ap() {
    log "=== build AP (PlatformIO) ==="
    pio run -d "$AP_DIR" -e "$AP_ENV"
    log "AP build OK: $AP_DIR/.pio/build/$AP_ENV/firmware.bin"
}

step_flash_tag() {
    log "=== flash tag (J-Link) ==="
    if ! jlink_present; then
        err "tag flash failed: JLinkExe not in PATH (install SEGGER J-Link tools)"
        return 1
    fi
    if [[ ! -f "$ROOT/firmware/.flash-image" ]]; then
        err "tag flash failed: no build stamp — run: ./deploy-pinprov.sh build-tag (or build) first"
        return 1
    fi
    log "Image: $(cat "$ROOT/firmware/.flash-image")"
    log "Power tag via ./tag-uart.sh (auto-started by flash-tag.sh; J-Link will restart it after program)."
    if ! OPENOCD_CFG="$OPENOCD_CFG" "$ROOT/flash-tag.sh"; then
        err "tag flash failed — see $ROOT/flash.log"
        return 1
    fi
    log "tag flash OK"
}

step_flash_ap() {
    log "=== flash AP (USB upload) ==="
    local port
    if ! port="$(find_ap_port)"; then
        log "SKIP AP flash: no USB serial port found (/dev/cu.usbserial-*)"
        return 1
    fi
    log "Staging wwwroot -> LittleFS (kiosk-encode.js cache buster)..."
    (cd "$AP_DIR" && ./prepare-offline-fs.sh) >>"$LOG" 2>&1
    log "Uploading firmware to $port ..."
    pio run -d "$AP_DIR" -e "$AP_ENV" -t upload --upload-port "$port"
    log "Uploading LittleFS (www) to $port ..."
    pio run -d "$AP_DIR" -e "$AP_ENV" -t uploadfs --upload-port "$port"
    log "AP flash OK (firmware + www)"
}

step_monitor_hint() {
    log "=== done ==="
    log "Tag-only next time: ./deploy-pinprov.sh build-tag  (skips AP build/flash)"
    log "Monitor: python3 $ROOT/monitor-pinprov.py --serial \$(ls /dev/cu.usbserial-* 2>/dev/null | head -1)"
    log "Then: Show PIN on tag → Program from portal with matching PIN"
}

main() {
    local rc=0
    require_firmware_paths
    : > "$LOG"
    log "deploy-pinprov start"
    step_build_tag
    step_build_ap
    step_flash_tag || rc=1
    step_flash_ap || rc=1
    step_monitor_hint
    if [[ "$rc" -ne 0 ]]; then
        err "deploy finished with flash failure(s) — see $LOG and flash.log"
        exit 1
    fi
}

case "${1:-all}" in
    build-tag)
        require_tag_fw
        : > "$LOG"
        log "deploy-pinprov start (tag only)"
        step_build_tag
        step_flash_tag
        #step_monitor_hint
        log "build-tag OK"
        ;;
    build)
        require_firmware_paths
        : > "$LOG"
        log "deploy-pinprov start (build only, no flash)"
        step_build_tag
        step_build_ap
        log "build OK (flash separately: ./deploy-pinprov.sh flash-tag)"
        ;;
    flash-tag)
        require_tag_fw
        step_flash_tag
        ;;
    flash-ap)
        require_ap_dir
        step_flash_ap
        ;;
    all|*) main ;;
esac
