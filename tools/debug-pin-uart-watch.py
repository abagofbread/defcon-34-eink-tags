#!/usr/bin/env python3
"""Tail tag UART log and mirror DBG1AC9CA lines into the debug NDJSON log."""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UART = ROOT / "logs" / "uart-live.log"
OUT = ROOT / ".cursor" / "debug-1ac9ca.log"
MARKER = "DBG1AC9CA"
HYP_RE = re.compile(r"\[PIN\]\s+(H\w+)\s+")


def emit(line: str) -> None:
    m = HYP_RE.search(line)
    hyp = m.group(1) if m else "H?"
    payload = {
        "sessionId": "1ac9ca",
        "timestamp": int(time.time() * 1000),
        "location": "uart-live.log",
        "message": line.strip(),
        "hypothesisId": hyp,
        "data": {"raw": line.strip()},
        "runId": "pre-fix",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload) + "\n")
    print(payload["message"], flush=True)


def main() -> None:
    UART.parent.mkdir(parents=True, exist_ok=True)
    UART.touch(exist_ok=True)
    with UART.open("r", encoding="utf-8", errors="replace") as f:
        f.seek(0, 2)
        while True:
            line = f.readline()
            if not line:
                time.sleep(0.2)
                continue
            if MARKER in line or "[PIN]" in line:
                emit(line)


if __name__ == "__main__":
    main()
