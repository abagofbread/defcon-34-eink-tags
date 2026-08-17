#!/usr/bin/env python3
"""Encode + provision a BW test image to a pin-prov tag via the AP portal."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PIN_RE = re.compile(r"pin=(\d{6})", re.I)


def fetch_tag(ap: str, mac: str) -> dict | None:
    url = f"http://{ap}/get_db?mac={urllib.parse.quote(mac)}"
    with urllib.request.urlopen(url, timeout=8) as r:
        data = json.loads(r.read().decode())
    tags = data.get("tags") or []
    return tags[0] if tags else None


def start_provision(ap: str, mac: str) -> str:
    body = urllib.parse.urlencode({"mac": mac}).encode()
    req = urllib.request.Request(f"http://{ap}/start_provision", data=body, method="POST")
    with urllib.request.urlopen(req, timeout=8) as r:
        return r.read().decode()


def provision_upload(ap: str, mac: str, pin: str, raw_path: Path) -> tuple[int, str]:
    boundary = "----pinprovBoundary7MA4YWxk"
    raw = raw_path.read_bytes()
    parts: list[bytes] = []
    for name, value in (("mac", mac), ("pin", pin), ("unlock", "0")):
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n".encode()
        )
    parts.append(
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="kiosk.raw"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
        + raw
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        f"http://{ap}/provision_tag",
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def encode_raw(root: Path, out_path: Path) -> None:
    script = root / "encode-bw-test.mjs"
    subprocess.run(["node", str(script), str(out_path)], check=True, cwd=root)


def read_pin_from_serial(port: str, timeout_s: float) -> str | None:
    try:
        import serial
    except ImportError:
        return None
    deadline = time.time() + timeout_s
    buf = ""
    with serial.Serial(port, 115200, timeout=0.2) as ser:
        while time.time() < deadline:
            chunk = ser.read(4096)
            if not chunk:
                continue
            buf += chunk.decode("utf-8", errors="replace")
            m = PIN_RE.search(buf)
            if m:
                return m.group(1)
    return None


def wait_for_state(ap: str, mac: str, want: set[str], timeout_s: float) -> dict | None:
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        tag = fetch_tag(ap, mac)
        if tag:
            last = tag
            state = tag.get("provisionState")
            if state in want:
                return tag
        time.sleep(2)
    return last


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--ap", default=os.environ.get("AP_HOST", ""), help="AP IP (or set AP_HOST)")
    p.add_argument("--mac", default=os.environ.get("TAG_MAC", ""), help="tag MAC (or set TAG_MAC)")
    p.add_argument("--pin", default="", help="6-digit PIN if already visible on tag")
    p.add_argument("--serial", default=os.environ.get("AP_SERIAL", ""), help="optional serial (or set AP_SERIAL)")
    p.add_argument("--raw", default=str(ROOT / "dumps/bw-test-4e.raw"))
    p.add_argument("--skip-encode", action="store_true")
    args = p.parse_args()

    if not args.ap or not args.mac:
        print("Set --ap and --mac (or AP_HOST and TAG_MAC)", file=sys.stderr)
        return 1

    mac = args.mac.upper()
    raw_path = Path(args.raw)
    raw_path.parent.mkdir(parents=True, exist_ok=True)

    tag = fetch_tag(args.ap, mac)
    if not tag:
        print(f"Tag {mac} not on AP {args.ap}", file=sys.stderr)
        return 1
    print(
        f"baseline: hwType={tag.get('hwType')} state={tag.get('provisionState')} "
        f"ver={tag.get('ver')} rssi={tag.get('RSSI')}"
    )

    if not args.skip_encode:
        print("encoding BW test image...")
        encode_raw(ROOT, raw_path)

    pin = args.pin.strip()
    state = tag.get("provisionState")
    if not pin:
        if state != "pin_visible":
            print("requesting provision mode...")
            print(start_provision(args.ap, mac))
            tag = wait_for_state(args.ap, mac, {"pin_visible", "programming"}, 90)
            if tag:
                print(f"tag state: {tag.get('provisionState')} programming={tag.get('programming')}")
            if args.serial:
                print(f"watching serial {args.serial} for PIN (triple-tap tag if needed)...")
                pin = read_pin_from_serial(args.serial, 75) or ""
        if not pin:
            print("PIN not found — enter the 6 digits shown on the tag and re-run with --pin", file=sys.stderr)
            return 2

    print(f"uploading {raw_path} with pin={pin}...")
    code, body = provision_upload(args.ap, mac, pin, raw_path)
    print(f"upload response {code}: {body}")

    tag = wait_for_state(args.ap, mac, {"locked", "kiosk_idle", "pin_visible"}, 120)
    if tag:
        print(
            f"final: state={tag.get('provisionState')} pending={tag.get('pending')} "
            f"prog={tag.get('programming')} updates={tag.get('updatecount')}"
        )
    return 0 if code == 200 else 3


if __name__ == "__main__":
    raise SystemExit(main())
