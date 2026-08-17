#!/usr/bin/env bash
# Resolve TAG_FW and AP_DIR for local deploy scripts.
# Optional override: create local-env.sh in this directory (gitignored).

pinprov_paths_root() {
    cd "$(dirname "${BASH_SOURCE[1]:-$0}")" && pwd
}

pinprov_try_tag_fw() {
    local dir="$1"
    [[ -d "$dir/firmware" ]]
}

pinprov_try_ap_dir() {
    local dir="$1"
    [[ -d "$dir/src" ]]
}

pinprov_resolve_tag_fw() {
    local root="$1" candidate
    if [[ -n "${TAG_FW_ROOT:-}" ]] && pinprov_try_tag_fw "$TAG_FW_ROOT"; then
        printf '%s' "$TAG_FW_ROOT"
        return 0
    fi
    for candidate in \
        "$root/Tag_FW_EFR32xG22" \
        "$root/../oepl-defcon-name-tag/Tag_FW_EFR32xG22" \
        "$root/../Tag_FW_EFR32xG22" \
        "$root/../../art_projects/oepl-defcon-name-tag/Tag_FW_EFR32xG22" \
        "$root/../../art_projects/Tag_FW_EFR32xG22"; do
        if pinprov_try_tag_fw "$candidate"; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

pinprov_resolve_ap_dir() {
    local root="$1" candidate
    if [[ -n "${AP_DIR:-}" ]] && pinprov_try_ap_dir "$AP_DIR"; then
        printf '%s' "$AP_DIR"
        return 0
    fi
    for candidate in \
        "$root/ESP32_AP-Flasher" \
        "$root/../oepl-defcon-name-tag/ESP32_AP-Flasher" \
        "$root/../ESP32_AP-Flasher" \
        "$root/../../art_projects/oepl-defcon-name-tag/ESP32_AP-Flasher" \
        "$root/../../art_projects/OpenEPaperLink/ESP32_AP-Flasher"; do
        if pinprov_try_ap_dir "$candidate"; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

pinprov_load_paths() {
    local root="$1"
    if [[ -f "$root/local-env.sh" ]]; then
        # shellcheck source=/dev/null
        source "$root/local-env.sh"
    fi
    if TAG_FW="$(pinprov_resolve_tag_fw "$root")"; then
        :
    else
        TAG_FW="${TAG_FW_ROOT:-$root/../Tag_FW_EFR32xG22}"
    fi
    if AP_DIR="$(pinprov_resolve_ap_dir "$root")"; then
        :
    else
        AP_DIR="${AP_DIR:-$root/../ESP32_AP-Flasher}"
    fi
    export TAG_FW AP_DIR
    if [[ -n "${TAG_FW_ROOT:-}" ]]; then
        export TAG_FW_ROOT="$TAG_FW"
    fi
}
