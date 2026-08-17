# Local flash tools (not in git)

**This directory stays on your machine only.** The private firmware repo contains AP + tag code only (Option B).

## Layout

Point `TAG_FW_ROOT` and `AP_DIR` at your firmware checkouts if they are not siblings:

```bash
export TAG_FW_ROOT=/path/to/Tag_FW_EFR32xG22
export AP_DIR=/path/to/ESP32_AP-Flasher
```

Optional: create `local-env.sh` here (gitignored) with `TAG_FW_ROOT` and `AP_DIR`.
Scripts also auto-discover `../../art_projects/oepl-defcon-name-tag/` and legacy `art_projects/` layouts.

| What | Default sibling path |
|------|----------------------|
| AP + portal | `../ESP32_AP-Flasher/` |
| EFR32 tag FW | `../Tag_FW_EFR32xG22/` |
| Flash tools (here) | local only |

## Prerequisites (install locally)

- **J-Link** + `JLinkExe` on `PATH` (tag flash via SWD)
- **Simplicity Studio** or Commander CLI (tag build)
- **PlatformIO** (AP build + USB upload)
- **Glasgow** (optional: tag UART power/monitor while flashing)
- **Python 3** + `pyserial`, `websockets` (optional: `monitor-pinprov.py`)

Bundled in this folder for convenience: `openocd-dist/`, `tools/Commander-cli.app/` — never commit these.

First tag build on a fresh monorepo clone seeds `firmware/out/` automatically from `art_projects/Tag_FW_EFR32xG22` if present (Simplicity Studio export; not in git).

## Build / flash

**Tag firmware only (most iteration):**

```bash
./deploy-pinprov.sh build-tag
```

**Full stack** (when portal or AP firmware changed):

```bash
./deploy-pinprov.sh          # build + flash both
./deploy-pinprov.sh flash-ap # AP + LittleFS only
```

## Live monitor

```bash
export AP_HOST=192.168.4.1
export TAG_MAC=YOURTAGMAC
export AP_SERIAL=/dev/cu.usbserial-XXXX   # optional
./monitor-ap.sh
```

## Local artifacts

Keep out of any git repo: `*.log`, `logs/`, `dumps/`, `firmware/*.s37`, `.cursor/`. See `.gitignore`.
