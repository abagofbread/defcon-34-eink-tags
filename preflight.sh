#!/usr/bin/env bash
# Preflight gate before commit / push. Prints a PASS/FAIL/WARN/SKIP checklist.
# Does not modify firmware sources. Exit 1 if any check FAILs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
WARN=0
SKIP=0
BLOCKERS=0

pass() { printf '  [PASS] %s\n' "$*"; PASS=$((PASS + 1)); }
fail() { printf '  [FAIL] %s\n' "$*"; FAIL=$((FAIL + 1)); BLOCKERS=$((BLOCKERS + 1)); }
warn() { printf '  [WARN] %s\n' "$*"; WARN=$((WARN + 1)); }
skip() { printf '  [SKIP] %s\n' "$*"; SKIP=$((SKIP + 1)); }

is_firmware_path() {
    case "$1" in
        Tag_FW_EFR32xG22/*|ESP32_AP-Flasher/*|oepl-proto.h|oepl-definitions.h) return 0 ;;
        *) return 1 ;;
    esac
}

# Files that would be committed (respects .gitignore). Works before git init
# by using an ephemeral git dir against this work tree.
would_commit_list() {
    if [[ -d "$ROOT/.git" ]]; then
        git -C "$ROOT" ls-files --cached --others --exclude-standard
        return
    fi
    local tmp
    tmp="$(mktemp -d)"
    git init -q "$tmp"
    git --git-dir="$tmp/.git" --work-tree="$ROOT" ls-files --others --exclude-standard
    rm -rf "$tmp"
}

echo "Preflight checklist"
echo "==================="
echo

echo "Required files"
if [[ -f "$ROOT/README.md" ]]; then
    pass "README.md exists"
    readme_body="$(grep -vE '^[[:space:]]*(#|$)' "$ROOT/README.md" || true)"
    if [[ ${#readme_body} -lt 80 ]]; then
        warn "README.md looks like a stub — write the body before making the repo public"
    fi
else
    fail "README.md missing"
fi

if [[ -f "$ROOT/LICENSE" ]] && grep -q "Attribution-NonCommercial-ShareAlike 4.0" "$ROOT/LICENSE"; then
    pass "LICENSE is CC BY-NC-SA 4.0"
else
    fail "LICENSE missing or not CC BY-NC-SA 4.0"
fi

if [[ -f "$ROOT/.gitignore" ]]; then
    pass ".gitignore exists"
else
    fail ".gitignore missing"
fi

if [[ -f "$ROOT/local-env.sh.example" ]]; then
    pass "local-env.sh.example exists"
else
    warn "local-env.sh.example missing (optional)"
fi

echo
echo "Firmware sources (in-tree copy)"
if [[ -d "$ROOT/Tag_FW_EFR32xG22/firmware" ]]; then
    pass "Tag_FW_EFR32xG22/firmware present"
else
    fail "Tag_FW_EFR32xG22/firmware missing"
fi
if [[ -d "$ROOT/ESP32_AP-Flasher/src" ]]; then
    pass "ESP32_AP-Flasher/src present"
else
    fail "ESP32_AP-Flasher/src missing"
fi
if [[ -f "$ROOT/oepl-proto.h" ]]; then
    pass "oepl-proto.h present"
else
    fail "oepl-proto.h missing"
fi
if [[ -f "$ROOT/oepl-definitions.h" ]]; then
    pass "oepl-definitions.h present"
else
    fail "oepl-definitions.h missing"
fi

nested_git="$(find "$ROOT/Tag_FW_EFR32xG22" "$ROOT/ESP32_AP-Flasher" -name .git -print 2>/dev/null || true)"
if [[ -z "$nested_git" ]]; then
    pass "No nested .git under firmware trees"
else
    fail "Nested .git found (would create extra repos): $nested_git"
fi

echo
echo "Would-be commit set (gitignore)"
COMMIT_LIST="$(mktemp)"
would_commit_list | sed '/^$/d' >"$COMMIT_LIST"
commit_count="$(wc -l <"$COMMIT_LIST" | tr -d ' ')"
echo "  $commit_count files would be committed"

blocked=0
while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    case "$f" in
        local-env.sh|\
        *.s37|\
        *.log|\
        mono_crash.*|\
        openocd-dist/*|\
        openocd-efm32-series2/*|\
        tools/Commander-cli.app/*|\
        tools/SimplicityCommander-Mac/*|\
        logs/*|\
        dumps/*|\
        .cursor/*|\
        .pio/*|\
        */.pio/*|\
        */out/*|\
        */.git|\
        */.git/*)
            fail "Would commit blocked path: $f"
            blocked=1
            ;;
    esac
done <"$COMMIT_LIST"
if [[ "$blocked" -eq 0 ]]; then
    pass "No blocked binaries / local artifacts in commit set"
fi

if grep -qx 'local-env.sh' "$COMMIT_LIST"; then
    fail "local-env.sh is not gitignored"
fi

echo
echo "Machine paths in tooling (firmware trees WARN only)"
home_re="$(printf '/%s/|/%s/[a-zA-Z]' 'Users' 'home')"
tooling_hits=0
firmware_hits=0
while IFS= read -r -d '' file; do
    rel="${file#"$ROOT"/}"
    [[ "$rel" == local-env.sh ]] && continue
    if grep -nE "$home_re" "$file" >/dev/null 2>&1; then
        hits="$(grep -nE "$home_re" "$file" | head -3 || true)"
        if is_firmware_path "$rel"; then
            warn "Absolute home path in firmware (not rewritten): $rel"
            firmware_hits=$((firmware_hits + 1))
        else
            fail "Absolute home path in tooling: $rel"
            printf '%s\n' "$hits" | sed 's/^/           /'
            tooling_hits=$((tooling_hits + 1))
        fi
    fi
done < <(find "$ROOT" \( \
    -path "$ROOT/.git" -o \
    -path "$ROOT/openocd-dist" -o \
    -path "$ROOT/openocd-efm32-series2" -o \
    -path "$ROOT/tools/SimplicityCommander-Mac" -o \
    -path "$ROOT/tools/Commander-cli.app" -o \
    -path "$ROOT/.cursor" -o \
    -path "$ROOT/logs" -o \
    -path "$ROOT/dumps" -o \
    -path "$ROOT/.pio" \
    \) -prune -o -type f \( -name '*.sh' -o -name '*.py' -o -name '*.mjs' -o -name '*.cfg' -o -name '*.md' -o -name '*.example' \) -print0)

if [[ "$tooling_hits" -eq 0 ]]; then
    pass "No /Users or /home paths in tooling files"
fi
if [[ "$firmware_hits" -eq 0 ]]; then
    pass "No absolute home paths in firmware trees"
fi

echo
echo "Secrets scan (commit set, text files)"
secret_hits=0
secret_re='BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-'
while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    [[ -f "$ROOT/$f" ]] || continue
    if file -b --mime-encoding "$ROOT/$f" 2>/dev/null | grep -qi binary; then
        continue
    fi
    if grep -nE "$secret_re" "$ROOT/$f" >/dev/null 2>&1; then
        fail "Possible secret in $f"
        secret_hits=$((secret_hits + 1))
    fi
done <"$COMMIT_LIST"
if [[ "$secret_hits" -eq 0 ]]; then
    pass "No private-key / token patterns in commit set"
fi
rm -f "$COMMIT_LIST"

echo
echo "Optional tools"
if command -v shellcheck >/dev/null 2>&1; then
    sh_fail=0
    for s in "$ROOT"/*.sh; do
        [[ -f "$s" ]] || continue
        if ! shellcheck -e SC1091 "$s"; then
            sh_fail=1
        fi
    done
    if [[ "$sh_fail" -eq 0 ]]; then
        pass "shellcheck clean on root *.sh"
    else
        fail "shellcheck reported issues"
    fi
else
    skip "shellcheck not installed"
fi

if command -v git >/dev/null 2>&1; then
    pass "git is available"
    if [[ -d "$ROOT/.git" ]]; then
        pass "git repo initialized"
    else
        warn "git repo not initialized yet (run git init after a green preflight)"
    fi
else
    skip "git not installed"
fi

echo
echo "Human checks (not auto-passable)"
echo "  [    ] Finish writing README.md"
echo "  [    ] First GitHub repo stays private until you explicitly make it public"
echo "  [    ] No real tag MACs / serial device names in the tooling staged diff"
echo

echo "Summary: $PASS pass, $FAIL fail, $WARN warn, $SKIP skip"
if [[ "$BLOCKERS" -gt 0 ]]; then
    echo "Preflight FAILED — do not commit or push."
    exit 1
fi
echo "Preflight PASSED."
exit 0
