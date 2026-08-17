#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OPENOCD="$ROOT/openocd-dist/bin/openocd"
OPENOCD_SCRIPTS="$ROOT/openocd-dist/share/openocd/scripts"
CFG="${OPENOCD_CFG:-$ROOT/openocd-jlink.cfg}"
FLASH_IMAGE_STAMP="$ROOT/firmware/.flash-image"
DUMP_DIR="$ROOT/dumps"
LOG="$ROOT/flash.log"
UART_LOG="${TAG_UART_LOG:-$ROOT/logs/uart-live.log}"
UART_PID_FILE="$ROOT/logs/tag-uart.pid"
UART_STARTED_BY_FLASH=0

tag_uart_running() {
    if [[ -f "$UART_PID_FILE" ]]; then
        local uart_pid
        uart_pid="$(cat "$UART_PID_FILE" 2>/dev/null || true)"
        if [[ -n "$uart_pid" ]] && kill -0 "$uart_pid" 2>/dev/null; then
            return 0
        fi
    fi
    pgrep -f "glasgow run uart" >/dev/null 2>&1
}

stop_tag_uart() {
  if tag_uart_running; then
    local uart_pid=""
    if [[ -f "$UART_PID_FILE" ]]; then
      uart_pid="$(cat "$UART_PID_FILE" 2>/dev/null || true)"
    fi
    if [[ -n "$uart_pid" ]]; then
      echo "Stopping tag UART (pid $uart_pid) for SWD flash..." | tee -a "$LOG"
      kill "$uart_pid" 2>/dev/null || true
      pkill -P "$uart_pid" 2>/dev/null || true
    else
      echo "Stopping tag UART (glasgow) for SWD flash..." | tee -a "$LOG"
      pkill -f "glasgow run uart" 2>/dev/null || true
    fi
    sleep 1
  fi
  rm -f "$UART_PID_FILE"
}

ensure_tag_uart() {
    if tag_uart_running; then
        local uart_pid=""
        uart_pid="$(cat "$UART_PID_FILE" 2>/dev/null || true)"
        if [[ -z "$uart_pid" ]]; then
            uart_pid="$(pgrep -f "glasgow run uart" | head -1 || true)"
        fi
        echo "Tag UART already running (pid ${uart_pid:-?}, log $UART_LOG)" | tee -a "$LOG"
        return 0
    fi
    command -v glasgow >/dev/null || {
        echo "Warning: glasgow not found — tag may be unpowered during flash" | tee -a "$LOG"
        return 0
    }
    mkdir -p "$(dirname "$UART_LOG")" "$(dirname "$UART_PID_FILE")"
    echo "Starting tag UART (Glasgow ${GLASGOW_VOLTAGE:-3.3}V power + monitor)..." | tee -a "$LOG"
    nohup "$ROOT/tag-uart.sh" "$UART_LOG" >>"$ROOT/logs/tag-uart-wrapper.log" 2>&1 &
    echo $! >"$UART_PID_FILE"
    UART_STARTED_BY_FLASH=1
    sleep 2
    if ! tag_uart_running; then
        echo "Warning: tag UART exited early — see $ROOT/logs/tag-uart-wrapper.log" | tee -a "$LOG"
        rm -f "$UART_PID_FILE"
    fi
}

restart_tag_uart_after_flash() {
    stop_tag_uart
    pkill -f "glasgow run uart" 2>/dev/null || true
    sleep 1
    ensure_tag_uart
}

show_uart_tail() {
    if [[ -f "$UART_LOG" ]]; then
        echo "--- UART tail ($UART_LOG) ---" | tee -a "$LOG"
        tail -n 40 "$UART_LOG" | tee -a "$LOG" || true
    fi
}

# J-Link: pinned device avoids the BG22 picker dialog every run.
JLINK="${JLINK:-JLinkExe}"
JLINK_DEVICE="${JLINK_DEVICE:-EFR32BG22CXXXF352}"
JLINK_SPEED="${JLINK_SPEED:-4000}"
FLASH_BACKEND="${FLASH_BACKEND:-jlink}"

usage() {
    cat <<EOF
Usage: $(basename "$0") <command> [args]

Commands:
  flash [image.s37]   Program tag (default). Image: arg, FIRMWARE, or firmware/.flash-image
  flash-fresh         Dump userdata, flash FULL pinprov image, restore userdata
  check               Test debug connection (J-Link by default)
  dump                Dump 1 KiB userdata (0x0FE00000) to dumps/ (J-Link or OpenOCD)
  decode [userdata.bin]  Show panel type bytes from a userdata dump
  restore [userdata.bin]  Write userdata page (default: latest userdata_*.bin dump)
  fw-id [image.s37]   OEPL_FW_ID from image file + live tag
  fw-id-file [image]  OEPL_FW_ID from .s37 only
  fw-id-tag           OEPL_FW_ID from running tag via SWD

Environment:
  FLASH_BACKEND   jlink (default) or openocd
  JLINK_DEVICE    default: EFR32BG22CXXXF352 (BG22C222, 352 KiB — no picker)
  JLINK_SPEED     default: 4000
  OPENOCD_CFG     for openocd backend / dump
  FIRMWARE        optional image override

Run ./deploy-pinprov.sh build-tag before flash if tag source changed (tag-only; faster than full deploy).
EOF
}

require_jlink() {
    command -v "$JLINK" >/dev/null || { echo "Missing J-Link: $JLINK" >&2; exit 1; }
}

require_openocd() {
    [[ -x "$OPENOCD" ]] || { echo "Missing OpenOCD: $OPENOCD" >&2; exit 1; }
    [[ -f "$CFG" ]] || { echo "Missing config: $CFG" >&2; exit 1; }
}

run_openocd() {
    "$OPENOCD" -s "$OPENOCD_SCRIPTS" -f "$CFG" "$@"
}

run_jlink_script() {
    local script="$1"
    "$JLINK" \
        -NoGui 1 \
        -ExitOnError 1 \
        -If SWD \
        -Speed "$JLINK_SPEED" \
        -Device "$JLINK_DEVICE" \
        -AutoConnect 1 \
        -CommanderScript "$script"
}

pick_firmware() {
    if [[ -n "${1:-}" ]]; then
        echo "$1"
        return 0
    fi
    if [[ -n "${FIRMWARE:-}" ]]; then
        echo "$FIRMWARE"
        return 0
    fi
    if [[ -f "$FLASH_IMAGE_STAMP" ]]; then
        cat "$FLASH_IMAGE_STAMP"
        return 0
    fi
    echo "No image. Run: ./deploy-pinprov.sh build   (or FIRMWARE=... $0 flash)" >&2
    return 1
}

cmd_check() {
    local script
    echo "---- check $(date +%Y%m%d-%H%M%S) backend=$FLASH_BACKEND ----" | tee -a "$LOG"
    if [[ "$FLASH_BACKEND" == "openocd" ]]; then
        require_openocd
        run_openocd \
            -c "init" \
            -c "targets" \
            -c "efm32s2_dci_read_se_status" \
            -c "exit" 2>&1 | tee -a "$LOG"
        return 0
    fi
    require_jlink
    echo "J-Link device: $JLINK_DEVICE speed: $JLINK_SPEED" | tee -a "$LOG"
    script="$(mktemp "${TMPDIR:-/tmp}/jlink-check.XXXXXX")"
    cat > "$script" <<EOF
connect
exit
EOF
    run_jlink_script "$script" 2>&1 | tee -a "$LOG"
    rm -f "$script"
}

cmd_decode_userdata() {
    local f="${1:-}"
    if [[ -z "$f" ]]; then
        f="$(pick_userdata)" || exit 1
    fi
    [[ -f "$f" ]] || { echo "File not found: $f" >&2; exit 1; }
    [[ "$(wc -c <"$f" | tr -d ' ')" -eq 1024 ]] || {
        echo "Expected 1024-byte userdata dump: $f" >&2
        exit 1
    }
    python3 - "$f" <<'PY'
import struct, sys
path = sys.argv[1]
data = open(path, "rb").read(1024)
magic = data[0:2].hex()
ctrl = data[0x09]
color = data[0x0A]
xres = data[0x0B] | (data[0x0C] << 8)
yres = data[0x0D] | (data[0x0E] << 8)
tagtype = data[0x16]
labels = {
    0x21: 'M3 2.6" BW (STYPE_SIZE_026_FREEZER → OEPL 0x4E)',
    0x43: 'M3 2.6" BWR (STYPE_SIZE_026 → OEPL 0x4D)',
    0x75: 'M3 2.6" BWRY (STYPE_SIZE_26_BWRY → OEPL 0x4F)',
}
label = labels.get(tagtype, f'unknown tagtype 0x{tagtype:02X}')
print(f"File: {path}")
print(f"  magic @0x00: {magic}")
print(f"  ctrl @0x09: 0x{ctrl:02X}  color @0x0A: 0x{color:02X}")
print(f"  resolution: {xres}x{yres}")
print(f"  tagtype @0x16: 0x{tagtype:02X} — {label}")
if tagtype == 0x75:
    print("  NOTE: this dump is for a BWRY panel; do not restore onto a BW badge.")
elif tagtype == 0x21:
    print("  NOTE: this dump is for a BW 2.6\" panel.")
PY
}

cmd_dump_jlink() {
    local dump_bin="$1"
    local script
    # Keep Glasgow UART running: it supplies 3.3V; RX is not on SWD pins.
    script="$(mktemp "${TMPDIR:-/tmp}/jlink-dump.XXXXXX")"
    cat > "$script" <<EOF
connect
halt
savebin "$dump_bin", 0x0FE00000, 0x400
exit
EOF
    run_jlink_script "$script"
    rm -f "$script"
}

cmd_dump_openocd() {
    local dump_bin="$1"
    run_openocd \
        -c "init" \
        -c "reset init" \
        -c "halt" \
        -c "dump_image $dump_bin 0x0FE00000 0x400" \
        -c "shutdown"
}

cmd_dump() {
    command -v xxd >/dev/null || { echo "xxd is required" >&2; exit 1; }
    local ts dump_bin dump_hex
    ts="$(date +%Y%m%d-%H%M%S)"
    dump_bin="$DUMP_DIR/userdata_${ts}.bin"
    dump_hex="$DUMP_DIR/userdata_${ts}.hex"
    mkdir -p "$DUMP_DIR"
    echo "---- dump $ts backend=$FLASH_BACKEND ----" | tee -a "$LOG"
    ensure_tag_uart
    if [[ "$FLASH_BACKEND" == "openocd" ]]; then
        require_openocd
        cmd_dump_openocd "$dump_bin" 2>&1 | tee -a "$LOG"
    else
        require_jlink
        cmd_dump_jlink "$dump_bin" 2>&1 | tee -a "$LOG"
    fi
    [[ -f "$dump_bin" && "$(wc -c < "$dump_bin" | tr -d ' ')" -eq 1024 ]] || {
        echo "Userdata dump failed (expected 1024-byte file)." >&2
        exit 1
    }
    xxd -g 1 -c 16 "$dump_bin" > "$dump_hex"
    echo "Saved userdata:"
    echo "  binary: $dump_bin"
    echo "  hex:    $dump_hex"
    cmd_decode_userdata "$dump_bin"
}

pick_userdata() {
    if [[ -n "${USERDATA:-}" && -f "$USERDATA" ]]; then
        echo "$USERDATA"
        return 0
    fi
    if [[ -n "${1:-}" && -f "$1" ]]; then
        echo "$1"
        return 0
    fi
    local latest
    latest="$(ls -t "$DUMP_DIR"/userdata_*.bin 2>/dev/null | head -1 || true)"
    if [[ -n "$latest" && -f "$latest" ]]; then
        echo "$latest"
        return 0
    fi
    echo "No userdata dump. Set USERDATA=... or pass path." >&2
    return 1
}

cmd_restore_jlink() {
    local userdata_abs="$1"
    local script
    script="$(mktemp "${TMPDIR:-/tmp}/jlink-restore.XXXXXX")"
    cat > "$script" <<EOF
connect
halt
loadbin "$userdata_abs", 0x0FE00000
verifybin "$userdata_abs", 0x0FE00000
r
g
exit
EOF
    run_jlink_script "$script"
    rm -f "$script"
}

cmd_restore_openocd() {
    local userdata_abs="$1"
    run_openocd \
        -c "init" \
        -c "reset halt" \
        -c "flash write_image erase \"$userdata_abs\" 0x0FE00000 bin" \
        -c "verify_image \"$userdata_abs\" 0x0FE00000" \
        -c "reset" \
        -c "shutdown"
}

cmd_restore() {
    local userdata userdata_abs
    userdata="$(pick_userdata "${1:-}")" || exit 1
    userdata_abs="$(cd "$(dirname "$userdata")" && pwd)/$(basename "$userdata")"
    [[ "$(wc -c < "$userdata_abs" | tr -d ' ')" -eq 1024 ]] || {
        echo "Expected 1024-byte userdata dump: $userdata_abs" >&2
        exit 1
    }
    echo "---- restore $(date +%Y%m%d-%H%M%S) ----" | tee -a "$LOG"
    echo "Source: $userdata_abs" | tee -a "$LOG"
    cmd_decode_userdata "$userdata_abs" | tee -a "$LOG"
    if [[ "$FLASH_BACKEND" == "openocd" ]]; then
        require_openocd
        cmd_restore_openocd "$userdata_abs" 2>&1 | tee -a "$LOG"
    else
        require_jlink
        cmd_restore_jlink "$userdata_abs" 2>&1 | tee -a "$LOG"
    fi
    echo "Userdata restore OK." | tee -a "$LOG"
}

cmd_fw_id_from_file() {
    local f="${1:-}"
    local tmp
    if [[ -z "$f" ]]; then
        f="$(pick_firmware)" || return 1
    fi
    [[ -f "$f" ]] || { echo "File not found: $f" >&2; return 1; }
    echo "Image: $f" | tee -a "$LOG"
    if strings "$f" 2>/dev/null | grep 'OEPL_FW_ID:' | head -1 | tee -a "$LOG"; then
        return 0
    fi
    if [[ "$f" == *.s37 || "$f" == *.srec ]]; then
        tmp="$(mktemp "${TMPDIR:-/tmp}/fw-id.XXXXXX.bin")"
        if arm-none-eabi-objcopy -I srec -O binary "$f" "$tmp" 2>/dev/null; then
            if strings "$tmp" 2>/dev/null | grep 'OEPL_FW_ID:' | head -1 | tee -a "$LOG"; then
                rm -f "$tmp"
                return 0
            fi
        fi
        rm -f "$tmp"
    fi
    echo "No OEPL_FW_ID string in image" | tee -a "$LOG"
    return 1
}

cmd_fw_id_tag_openocd() {
    local out
    out="$(run_openocd \
        -c "init" \
        -c "reset halt" \
        -c 'find 0x08006000 0x08090000 "OEPL_FW_ID:pinprov="' \
        -c 'mdw $_find_result 16' \
        -c "exit" 2>&1)" || true
    echo "$out" | tee -a "$LOG"
    echo "$out" | grep -q 'OEPL_FW_ID'
}

cmd_fw_id_tag_jlink() {
    local script out
    script="$(mktemp "${TMPDIR:-/tmp}/jlink-fw-id.XXXXXX")"
    cat > "$script" <<'EOF'
connect
mem32 0x08006000 64
exit
EOF
    out="$(run_jlink_script "$script" 2>&1)" || true
    rm -f "$script"
    echo "$out" | tee -a "$LOG"
    echo "$out" | grep -qi 'pinprov'
}

cmd_fw_id_tag() {
    echo "---- fw-id-tag $(date +%Y%m%d-%H%M%S) backend=$FLASH_BACKEND ----" | tee -a "$LOG"
    if [[ "$FLASH_BACKEND" == "openocd" ]]; then
        require_openocd
        cmd_fw_id_tag_openocd && return 0
    else
        require_jlink
        cmd_fw_id_tag_jlink && return 0
    fi
    echo "OEPL_FW_ID not found on tag" | tee -a "$LOG"
    return 1
}

cmd_fw_id() {
    echo "---- fw-id $(date +%Y%m%d-%H%M%S) ----" | tee -a "$LOG"
    echo "=== from file ===" | tee -a "$LOG"
    cmd_fw_id_from_file "${1:-}" || true
    echo | tee -a "$LOG"
    echo "=== from tag (SWD) ===" | tee -a "$LOG"
    cmd_fw_id_tag || true
}

cmd_flash_jlink() {
    local fw_abs="$1"
    local attempt script
    echo "Backend: J-Link ($JLINK_DEVICE @ ${JLINK_SPEED}kHz)" | tee -a "$LOG"
    stop_tag_uart
    for attempt in 1 2 3; do
        echo "Attempt $attempt/3..." | tee -a "$LOG"
        script="$(mktemp "${TMPDIR:-/tmp}/jlink-flash.XXXXXX")"
        cat > "$script" <<EOF
connect
loadfile "$fw_abs"
r
g
exit
EOF
        if run_jlink_script "$script" 2>&1 | tee -a "$LOG"; then
            rm -f "$script"
            echo "Flash OK (J-Link)." | tee -a "$LOG"
            return 0
        fi
        rm -f "$script"
        if [[ "$attempt" -lt 3 ]]; then
            echo "Failed — power-cycle tag (3.3V off 2s on), retry in 3s..." | tee -a "$LOG"
            sleep 3
        fi
    done
    return 1
}

cmd_flash_openocd() {
    local fw_abs="$1"
    local attempt
    echo "Backend: OpenOCD ($CFG)" | tee -a "$LOG"
    require_openocd
    for attempt in 1 2 3; do
        echo "Attempt $attempt/3..." | tee -a "$LOG"
        if run_openocd \
            -c "init" \
            -c "reset init" \
            -c "halt" \
            -c "program \"$fw_abs\" verify reset" \
            -c "shutdown" 2>&1 | tee -a "$LOG"; then
            echo "Flash OK (OpenOCD)." | tee -a "$LOG"
            return 0
        fi
        if [[ "$attempt" -lt 3 ]]; then
            echo "Failed — power-cycle tag (3.3V off 2s on), retry in 3s..." | tee -a "$LOG"
            sleep 3
        fi
    done
    return 1
}

cmd_flash() {
    local fw fw_abs
    ensure_tag_uart
    fw="$(pick_firmware "${1:-}")" || exit 1
    [[ -f "$fw" ]] || { echo "Firmware not found: $fw" >&2; exit 1; }

    fw_abs="$(cd "$(dirname "$fw")" && pwd)/$(basename "$fw")"

    echo "---- flash $(date +%Y%m%d-%H%M%S) ----" | tee -a "$LOG"
    echo "Image: $fw_abs" | tee -a "$LOG"

    if [[ "$FLASH_BACKEND" == "openocd" ]]; then
        cmd_flash_openocd "$fw_abs" || {
            echo "All attempts failed. Try: FLASH_BACKEND=jlink $0 flash" | tee -a "$LOG"
            return 1
        }
    else
        require_jlink
        cmd_flash_jlink "$fw_abs" || {
            echo "All attempts failed. See $LOG" | tee -a "$LOG"
            return 1
        }
    fi
    #restart_tag_uart_after_flash
    #sleep 5
    #show_uart_tail
}

cmd_flash_fresh() {
    local fw fw_abs
    ensure_tag_uart
    fw="$(pick_firmware "${1:-}")" || exit 1
    [[ -f "$fw" ]] || { echo "Firmware not found: $fw" >&2; exit 1; }
    if [[ "$fw" != *FULL* ]]; then
        local full="${fw/_pinprov_v/_pinprov_FULL_v}"
        if [[ -f "$full" ]]; then
            fw="$full"
        else
            echo "Warning: expected FULL image; flashing $fw (NVM may be preserved)" | tee -a "$LOG"
        fi
    fi
    echo "---- flash-fresh $(date +%Y%m%d-%H%M%S) ----" | tee -a "$LOG"
    echo "Fresh flash: dump userdata -> program -> restore userdata" | tee -a "$LOG"
    cmd_dump || true
    fw_abs="$(cd "$(dirname "$fw")" && pwd)/$(basename "$fw")"
    echo "Image: $fw_abs" | tee -a "$LOG"
    if [[ "$FLASH_BACKEND" == "openocd" ]]; then
        require_openocd
        cmd_flash_openocd "$fw_abs" || return 1
    else
        require_jlink
        cmd_flash_jlink "$fw_abs" || return 1
    fi
    cmd_restore || true
    echo "Fresh flash done. Re-upload kiosk image after boot (external flash slot may still hold old bytes until erased)." | tee -a "$LOG"
    restart_tag_uart_after_flash
    sleep 5
    show_uart_tail
}

case "${1:-flash}" in
    -h|--help|help) usage ;;
    check) cmd_check ;;
    dump) cmd_dump ;;
    decode) cmd_decode_userdata "${2:-}" ;;
    restore) cmd_restore "${2:-}" ;;
    fw-id) cmd_fw_id "${2:-}" ;;
    fw-id-file) cmd_fw_id_from_file "${2:-}" ;;
    fw-id-tag) cmd_fw_id_tag ;;
    flash) cmd_flash "${2:-}" ;;
    flash-fresh) cmd_flash_fresh "${2:-}" ;;
    "")
        cmd_flash
        ;;
    *)
        if [[ -f "$1" ]]; then
            cmd_flash "$1"
        else
            echo "Unknown command: $1" >&2
            usage
            exit 1
        fi
        ;;
esac
