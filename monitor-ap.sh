#!/usr/bin/env bash
# Live monitor for pin-prov kiosk testing (portal WS + AP serial + tag DB).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
: "${AP_HOST:?Set AP_HOST to the ESP32 AP IP (e.g. export AP_HOST=192.168.4.1)}"
: "${TAG_MAC:?Set TAG_MAC to the tag MAC (e.g. export TAG_MAC=0011223344556677)}"
SERIAL="${AP_SERIAL:-}"
LOG="${MONITOR_LOG:-$ROOT/monitor.log}"

args=(--ap "$AP_HOST" --mac "$TAG_MAC")
if [[ -n "$SERIAL" ]]; then
  args+=(--serial "$SERIAL")
else
  args+=(--no-serial)
fi

exec python3 -u "$ROOT/monitor-pinprov.py" "${args[@]}" "$@" 2>&1 | tee -a "$LOG"
