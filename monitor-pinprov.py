#!/usr/bin/env python3
"""Live pin-prov monitor: AP portal WebSocket + optional AP serial + tag DB poll."""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import re
import sys
import urllib.request

try:
    import serial
except ImportError:
    serial = None

try:
    import websockets
except ImportError:
    websockets = None

SERIAL_HINTS = re.compile(
    r"queue:|SDA In|CXD In|RADIO:|RQB|<RQB|blockrequest|block request|"
    r"<ADR|<XFC|<XTO|XFC|XTO|ACK|provision|Provision|ERR|programming|pin|"
    r"Failed CRC|couldn't find taginfo|Starting download|Image rejected|"
    r"Wrong checksum|Payload size|\[PIN\]",
    re.I,
)
WS_HINTS = re.compile(
    r"program|provision|pending|ERR|queue|RQB|XFC|pin|upload|timeout|kiosk",
    re.I,
)


def ts() -> str:
    return datetime.datetime.now().strftime("%H:%M:%S")


def fetch_tag(ap: str, mac: str) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://{ap}/get_db?mac={mac}", timeout=6) as r:
            data = json.loads(r.read().decode())
        tags = data.get("tags") or []
        return tags[0] if tags else None
    except Exception as e:
        print(f"[{ts()}] [DB] fetch failed: {e}", flush=True)
        return None


def tag_summary(tag: dict | None) -> str:
    if not tag:
        return "no tag record"
    return (
        f"state={tag.get('provisionState')} prog={tag.get('programming')} "
        f"pending={tag.get('pending')} ver={tag.get('ver')} "
        f"updates={tag.get('updatecount')} rssi={tag.get('RSSI')}"
    )


async def poll_db(ap: str, mac: str, interval: float) -> None:
    last = ""
    while True:
        tag = await asyncio.to_thread(fetch_tag, ap, mac)
        summary = tag_summary(tag)
        if summary != last:
            print(f"[{ts()}] [DB] {mac} {summary}", flush=True)
            last = summary
        await asyncio.sleep(interval)


async def watch_ws(ap: str, mac: str) -> None:
    if websockets is None:
        print(f"[{ts()}] [WS] websockets not installed", flush=True)
        return
    url = f"ws://{ap}/ws"
    while True:
        try:
            async with websockets.connect(url, ping_interval=None, open_timeout=8) as ws:
                print(f"[{ts()}] [WS] connected {url}", flush=True)
                async for msg in ws:
                    text = msg if isinstance(msg, str) else msg.decode("utf-8", errors="replace")
                    if not mac or mac in text or WS_HINTS.search(text):
                        print(f"[{ts()}] [WS] {text[:500]}", flush=True)
        except Exception as e:
            print(f"[{ts()}] [WS] disconnected: {e}", flush=True)
            await asyncio.sleep(3)


async def watch_serial(port: str, baud: int) -> None:
    if serial is None:
        print(f"[{ts()}] [SER] pyserial not installed", flush=True)
        return
    while True:
        try:
            with serial.Serial(port, baud, timeout=0.3) as ser:
                print(f"[{ts()}] [SER] open {port} @ {baud}", flush=True)
                while True:
                    chunk = ser.read(4096)
                    if not chunk:
                        await asyncio.sleep(0.05)
                        continue
                    for line in chunk.decode("utf-8", errors="replace").splitlines():
                        if SERIAL_HINTS.search(line):
                            print(f"[{ts()}] [SER] {line}", flush=True)
        except Exception as e:
            print(f"[{ts()}] [SER] error: {e}", flush=True)
            await asyncio.sleep(3)


async def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--ap", required=True, help="AP IP or hostname")
    p.add_argument("--mac", default="", help="Tag MAC to filter (optional)")
    p.add_argument("--serial", default="", help="USB serial port for AP debug output")
    p.add_argument("--baud", type=int, default=115200)
    p.add_argument("--no-serial", action="store_true")
    p.add_argument("--db-interval", type=float, default=15.0)
    args = p.parse_args()

    mac = args.mac.upper()
    print(f"[{ts()}] === PIN-PROV MONITOR ===", flush=True)
    print(f"[{ts()}] AP {args.ap}" + (f"  tag {mac}" if mac else ""), flush=True)
    if mac:
        tag = await asyncio.to_thread(fetch_tag, args.ap, mac)
        print(f"[{ts()}] [DB] baseline {tag_summary(tag)}", flush=True)
    print(f"[{ts()}] Go ahead — Program tag when ready.", flush=True)

    tasks = [
        asyncio.create_task(poll_db(args.ap, mac, args.db_interval)),
        asyncio.create_task(watch_ws(args.ap, mac)),
    ]
    if not args.no_serial and args.serial:
        tasks.append(asyncio.create_task(watch_serial(args.serial, args.baud)))
    elif not args.no_serial:
        print(f"[{ts()}] [SER] skipped (pass --serial or set AP_SERIAL)", flush=True)

    await asyncio.gather(*tasks)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(f"\n[{ts()}] monitor stopped", flush=True)
