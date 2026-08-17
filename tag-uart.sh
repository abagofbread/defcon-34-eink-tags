#!/usr/bin/env bash
# Capture tag UART debug output (115200 8N1).
# Tag TX: P0.25 silkscreen = PB02 = EUSART TX → Glasgow RX (not SWDIO).
#
# Prerequisites:
#   - Glasgow NOT running swd-openocd (one applet at a time)
#   - Tag powered, UART GND common with Glasgow
#
# Usage:
#   ./tag-uart.sh                         # print to terminal
#   ./tag-uart.sh logs/foo.log            # tee to file
#   ./tag-uart.sh tcp:127.0.0.1:9999      # TCP socket (IDE serial monitor)
#
# Glasgow >=2024 UART applet: --rx A1 (not --port/--pin-rx). Default RX is A0.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG="${1:-}"
PORT="${GLASGOW_PORT:-A}"
PIN_RX="${GLASGOW_PIN_RX:-1}"
BAUD="${TAG_UART_BAUD:-115200}"
VOLTAGE="${GLASGOW_VOLTAGE:-3.3}"
RX_PIN="${PORT}${PIN_RX}"

# Second arg or env: socket target; else tty to stdout
SOCKET_TARGET="${TAG_UART_SOCKET:-}"
if [[ -n "${2:-}" ]]; then
  SOCKET_TARGET="$2"
elif [[ "$LOG" == tcp:* || "$LOG" == socket:* ]]; then
  SOCKET_TARGET="$LOG"
  LOG=""
fi

if [[ -n "$LOG" && "$LOG" != tcp:* && "$LOG" != socket:* ]]; then
  mkdir -p "$(dirname "$LOG")"
fi

echo "Tag UART via Glasgow --rx ${RX_PIN} @ ${BAUD} baud (${VOLTAGE} V)"
echo "Wire tag TX (PB02) → Glasgow ${RX_PIN}, common GND."
if [[ -n "$SOCKET_TARGET" ]]; then
  echo "Socket: ${SOCKET_TARGET#socket:}"
else
  echo "Mode: tty (stdout)"
fi
echo "---"

run_uart() {
  if [[ -n "$SOCKET_TARGET" ]]; then
    local target="${SOCKET_TARGET#socket:}"
    glasgow run uart -V "$VOLTAGE" socket "$target"
  else
    glasgow run uart -V "$VOLTAGE" tty
  fi
}

if [[ -n "$LOG" ]]; then
  run_uart | tee -a "$LOG"
else
  run_uart
fi
