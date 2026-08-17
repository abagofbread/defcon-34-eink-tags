#include "oepl_provision.h"

#include "oepl_pinprov_debug.h"
#include "oepl_nvm.h"
#include "oepl_radio.h"
#include "oepl_display.h"
#include "oepl_display_diag.h"
#include "oepl_hw_abstraction.h"
#include "oepl-proto.h"
#include "oepl-definitions.h"

#include "em_device.h"
#include "sl_sleeptimer.h"

#include <stdio.h>
#include <string.h>

#define DPRINTF(fmt_, ...) oepl_hw_debugprint(DBG_APP, (fmt_), ##__VA_ARGS__)

#define PROVISION_PIN_NVM_LEN (OEPL_PROVISION_PIN_LEN + 1)

static char provision_pin[PROVISION_PIN_NVM_LEN];
static bool pin_screen_active = false;
static bool upload_authorized = false;
static bool provisioned = true;
static bool updates_unlocked = false;
static bool user_image_uploaded = false;
static uint32_t pin_screen_start_ticks = 0;
static uint32_t pin_session_timeout_ms = 0;
static uint8_t triple_tap_count = 0;
static uint32_t triple_tap_first_ticks = 0;
static bool ap_found_shown_this_boot = false;

static bool provision_stored_image_is_showable(size_t *img_idx);

static void generate_pin(char *pin)
{
  uint8_t mac[8];
  oepl_radio_get_mac(mac);
  uint32_t seed = sl_sleeptimer_get_tick_count();
  for (int i = 0; i < 8; i++) {
    seed = seed * 31U + mac[i];
  }
  for (int i = 0; i < OEPL_PROVISION_PIN_LEN; i++) {
    seed = seed * 1103515245U + 12345U;
    pin[i] = (char)('0' + (seed % 10U));
  }
  pin[OEPL_PROVISION_PIN_LEN] = '\0';
  DPRINTF("provision PIN generated: %s\n", pin);
  PINPROV_DBG("H-A", "PIN_generated pin=%s", pin);
}

static bool pin_is_valid(const char *pin)
{
  if (pin == NULL) {
    return false;
  }
  for (int i = 0; i < OEPL_PROVISION_PIN_LEN; i++) {
    if (pin[i] < '0' || pin[i] > '9') {
      return false;
    }
  }
  return pin[OEPL_PROVISION_PIN_LEN] == '\0';
}

static void store_pin(void)
{
  oepl_nvm_setting_set(OEPL_PROVISION_PIN, provision_pin, PROVISION_PIN_NVM_LEN);
}

static void load_pin_from_nvm(void)
{
  generate_pin(provision_pin);
  store_pin();
  /*if (oepl_nvm_setting_get(OEPL_PROVISION_PIN, provision_pin, PROVISION_PIN_NVM_LEN) != NVM_SUCCESS ||
      !pin_is_valid(provision_pin)) {
    generate_pin(provision_pin);
    store_pin();
  } else {
    DPRINTF("provision PIN loaded: %s\n", provision_pin);
  }*/
  uint8_t ctf; 
  if (oepl_nvm_setting_get(OEPL_CTF, &ctf, sizeof(ctf)) != NVM_SUCCESS){
    DPRINTF("oh well");
    return;
  }
  if( ctf != 0 ){
    DPRINTF("You did it! Theres no more flags in this thing lol: flag{justrunstringsonitbro} ");
  }
}

static void end_pin_session(const char *reason)
{
  uint32_t elapsed_ms = 0;
  if (pin_screen_active) {
    elapsed_ms = sl_sleeptimer_tick_to_ms(sl_sleeptimer_get_tick_count() - pin_screen_start_ticks);
  }
  // #region agent log
  PINPROV_DBG("H1", "DBG1AC9CA end_pin reason=%s elapsed_ms=%lu timeout_ms=%lu prov=%d auth=%d img=%d",
              reason ? reason : "?",
              (unsigned long)elapsed_ms,
              (unsigned long)pin_session_timeout_ms,
              (int)provisioned,
              (int)upload_authorized,
              (int)user_image_uploaded);
  // #endregion
  pin_screen_active = false;
  upload_authorized = false;
  /* Invalidate PIN so a closed session cannot be reused without a new PIN UI. */
  memset(provision_pin, 0, sizeof(provision_pin));
  store_pin();
  uint8_t awaiting = 0;
  oepl_nvm_setting_set(OEPL_AWAITING_PIN_UI, &awaiting, sizeof(awaiting));
}

static void mark_user_image_uploaded(void)
{
  if (user_image_uploaded) {
    return;
  }
  user_image_uploaded = true;
  uint8_t flag = 1;
  oepl_nvm_setting_set(OEPL_USER_IMAGE_UPLOADED, &flag, sizeof(flag));
}

static void clear_user_image_uploaded_flag(void)
{
  if (!user_image_uploaded) {
    uint8_t flag = 0;
    oepl_nvm_setting_set(OEPL_USER_IMAGE_UPLOADED, &flag, sizeof(flag));
    return;
  }
  user_image_uploaded = false;
  uint8_t flag = 0;
  oepl_nvm_setting_set(OEPL_USER_IMAGE_UPLOADED, &flag, sizeof(flag));
}

static bool provision_slot_has_user_image(size_t slot, oepl_stored_image_hdr_t *meta)
{
  if (oepl_nvm_read_image_metadata(slot, meta) != NVM_SUCCESS || !meta->is_valid) {
    return false;
  }
  return meta->image_type == CUSTOM_IMAGE_NOCUSTOM ||
         meta->image_type == CUSTOM_IMAGE_KIOSK_USER;
}

static void sync_user_image_uploaded_flag(void)
{
  size_t img_idx;
  if (provision_stored_image_is_showable(&img_idx)) {
    mark_user_image_uploaded();
  } else {
    clear_user_image_uploaded_flag();
  }
}

static bool pending_boot_splash = false;

static void clear_stale_pin_ui_after_user_image(void)
{
  if (!user_image_uploaded || pin_screen_active) {
    return;
  }
  uint8_t awaiting = 0;
  if (oepl_nvm_setting_get(OEPL_AWAITING_PIN_UI, &awaiting, sizeof(awaiting)) == NVM_SUCCESS && awaiting != 0) {
    uint8_t cleared = 0;
    oepl_nvm_setting_set(OEPL_AWAITING_PIN_UI, &cleared, sizeof(cleared));
    DPRINTF("provision: cleared stale awaiting-PIN (reprovision needs triple-tap)\n");
  }
}

bool oepl_provision_init(void)
{
  upload_authorized = false;
  pin_screen_active = false;
  triple_tap_count = 0;
  triple_tap_first_ticks = 0;

  uint8_t stored_provisioned = 0;
  if (oepl_nvm_setting_get(OEPL_PROVISIONED, &stored_provisioned, sizeof(stored_provisioned)) == NVM_SUCCESS &&
      stored_provisioned != 0) {
    uint8_t stored_unlocked = 0;
    if (oepl_nvm_setting_get(OEPL_UPDATES_UNLOCKED, &stored_unlocked, sizeof(stored_unlocked)) == NVM_SUCCESS) {
      updates_unlocked = stored_unlocked != 0;
    }
    provisioned = true;
    load_pin_from_nvm();
    sync_user_image_uploaded_flag();
    clear_stale_pin_ui_after_user_image();
    DPRINTF("provision init: provisioned=1 unlocked=%d user_img=%d\n",
            updates_unlocked, user_image_uploaded);
    return true;
  }

  provisioned = false;
  updates_unlocked = false;
  load_pin_from_nvm();
  sync_user_image_uploaded_flag();
  clear_stale_pin_ui_after_user_image();
  DPRINTF("provision init: awaiting first provision user_img=%d\n", user_image_uploaded);
  return false;
}

bool oepl_provision_should_show_pin(void)
{
  if (pin_screen_active) {
    return true;
  }
  /* After a user image exists, reprovision requires an explicit triple-tap. */
  if (user_image_uploaded) {
    return false;
  }
  uint8_t awaiting = 0;
  if (oepl_nvm_setting_get(OEPL_AWAITING_PIN_UI, &awaiting, sizeof(awaiting)) != NVM_SUCCESS) {
    return false;
  }
  return awaiting != 0;
}

void oepl_provision_begin_pin_display(void)
{
  generate_pin(provision_pin);
  store_pin();
  pin_screen_active = true;
  upload_authorized = false;
  pin_screen_start_ticks = sl_sleeptimer_get_tick_count();
  pin_session_timeout_ms = provisioned
      ? (OEPL_PROVISION_REPROVISION_TIMEOUT_S * 1000U)
      : (OEPL_PROVISION_FIRST_TIMEOUT_S * 1000U);
  triple_tap_count = 0;
  triple_tap_first_ticks = 0;
  uint8_t awaiting = 1;
  oepl_nvm_setting_set(OEPL_AWAITING_PIN_UI, &awaiting, sizeof(awaiting));
  // #region agent log
  PINPROV_DBG("H1", "DBG1AC9CA begin_pin timeout_ms=%lu prov=%d img=%d start_ticks=%lu",
              (unsigned long)pin_session_timeout_ms,
              (int)provisioned,
              (int)user_image_uploaded,
              (unsigned long)pin_screen_start_ticks);
  // #endregion
  oepl_display_diag_log_provision("PIN screen opened");
  oepl_display_show_infoscreen(INFOSCREEN_PROVISIONING);
  oepl_display_draw(NULL);
  oepl_radio_send_poll_with_reason(WAKEUP_REASON_TIMED);
}

bool oepl_provision_on_button_press(void)
{
  if (pin_screen_active) {
    return false;
  }

  uint32_t now = sl_sleeptimer_get_tick_count();
  if (triple_tap_count == 0 ||
      sl_sleeptimer_tick_to_ms(now - triple_tap_first_ticks) > OEPL_PROVISION_TRIPLE_TAP_WINDOW_MS) {
    triple_tap_count = 1;
    triple_tap_first_ticks = now;
    return false;
  }

  triple_tap_count++;
  if (triple_tap_count < OEPL_PROVISION_TRIPLE_TAP_COUNT) {
    return false;
  }

  triple_tap_count = 0;
  triple_tap_first_ticks = 0;
  PINPROV_DBG("H-A", "triple-tap -> PIN reprovision user_img=%d", user_image_uploaded);
  oepl_display_diag_log_provision("triple-tap -> PIN screen");
  oepl_provision_begin_pin_display();
  return true;
}

void oepl_provision_request_pin_ui(void)
{
  uint8_t awaiting = 1;
  oepl_nvm_setting_set(OEPL_AWAITING_PIN_UI, &awaiting, sizeof(awaiting));
}

bool oepl_provision_is_active(void)
{
  return pin_screen_active;
}

bool oepl_provision_is_provisioned(void)
{
  return provisioned;
}

bool oepl_provision_is_session_authorized(void)
{
  return upload_authorized;
}

static bool pin_bytes_match(const uint8_t pin_bytes[6])
{
  char pin[OEPL_PROVISION_PIN_LEN + 1];

  if (pin_bytes == NULL) {
    return false;
  }
  for (int i = 0; i < OEPL_PROVISION_PIN_LEN; i++) {
    pin[i] = (char)pin_bytes[i];
  }
  pin[OEPL_PROVISION_PIN_LEN] = '\0';
  return pin_is_valid(pin) && strncmp(pin, provision_pin, OEPL_PROVISION_PIN_LEN) == 0;
}

bool oepl_provision_verify_image_auth(const uint8_t pin_bytes[6])
{
  return pin_bytes_match(pin_bytes);
}

bool oepl_provision_authorize_session(const char *pin)
{
  uint8_t pin_bytes[OEPL_PROVISION_PIN_LEN];

  if (!pin_screen_active) {
    PINPROV_DBG("H-A", "authorize_session REJECT pin_screen=0");
    oepl_display_diag_log_provision("PIN rejected (no PIN screen)");
    return false;
  }
  if (pin == NULL || !pin_is_valid(pin)) {
    return false;
  }
  for (int i = 0; i < OEPL_PROVISION_PIN_LEN; i++) {
    pin_bytes[i] = (uint8_t)pin[i];
  }
  if (!pin_bytes_match(pin_bytes)) {
    PINPROV_DBG("H-A", "authorize_session REJECT pin_screen=%d", pin_screen_active);
    oepl_display_diag_log_provision("PIN rejected");
    return false;
  }
  upload_authorized = true;
  PINPROV_DBG("H-A", "authorize_session OK upload_auth=1 pin_screen=%d", pin_screen_active);
  oepl_display_diag_log_provision("PIN authorized");
  return true;
}

const char *oepl_provision_get_pin(void)
{
  return provision_pin;
}

void oepl_provision_fill_poll(struct AvailDataReq *req)
{
  if (req == NULL) {
    return;
  }
  if (pin_screen_active) {
    req->customMode = TAG_CUSTOM_MODE_PROVISIONING;
    memset(req->reserved, 0, sizeof(req->reserved));
    return;
  }
  if (!provisioned) {
    req->customMode = TAG_CUSTOM_MODE_KIOSK_UNPROVISIONED;
  } else if (!updates_unlocked) {
    req->customMode = TAG_CUSTOM_MODE_PROVISION_AUTHORIZED;
  } else {
    req->customMode = TAG_CUSTOM_MODE_NONE;
  }
  memset(req->reserved, 0, sizeof(req->reserved));
}

void oepl_provision_mark_provisioned(bool unlock_updates)
{
  uint8_t flag = 1;
  uint8_t unlocked = unlock_updates ? 1 : 0;
  oepl_nvm_setting_set(OEPL_PROVISIONED, &flag, sizeof(flag));
  oepl_nvm_setting_set(OEPL_UPDATES_UNLOCKED, &unlocked, sizeof(unlocked));
  provisioned = true;
  updates_unlocked = unlock_updates;
  PINPROV_DBG("H-C", "mark_provisioned unlock=%d", unlock_updates);
  end_pin_session("mark_provisioned");
}

bool oepl_provision_updates_allowed(void)
{
  if (upload_authorized) {
    return true;
  }
  if (provisioned) {
    return updates_unlocked;
  }
  return false;
}

bool oepl_provision_accepts_content_type(uint8_t dataType)
{
  if (!oepl_provision_is_session_authorized()) {
    return false;
  }

  switch (dataType) {
    case DATATYPE_IMG_RAW_1BPP:
    case DATATYPE_IMG_RAW_2BPP:
    case DATATYPE_IMG_ZLIB:
      return true;
    default:
      return false;
  }
}

static bool provision_stored_image_is_showable(size_t *img_idx)
{
  oepl_stored_image_hdr_t img_meta;

  if (provision_slot_has_user_image(OEPL_PROVISION_BULK_SLOT, &img_meta)) {
    *img_idx = OEPL_PROVISION_BULK_SLOT;
    DPRINTF("user image in bulk slot %u type=0x%02x size=%lu\n",
            (unsigned)*img_idx, img_meta.image_type, (unsigned long)img_meta.size);
    return true;
  }

  static const uint8_t user_image_types[] = {
    CUSTOM_IMAGE_NOCUSTOM,
    CUSTOM_IMAGE_KIOSK_USER,
  };

  for (size_t i = 0; i < sizeof(user_image_types); i++) {
    size_t seqno;
    if (oepl_nvm_get_image_by_type(user_image_types[i], img_idx, &seqno) != NVM_SUCCESS) {
      continue;
    }
    if (provision_slot_has_user_image(*img_idx, &img_meta)) {
      DPRINTF("user image in slot %u type=0x%02x size=%lu\n",
              (unsigned)*img_idx, img_meta.image_type, (unsigned long)img_meta.size);
      return true;
    }
    DPRINTF("provision image slot %u type=0x%02x not valid\n",
            (unsigned)*img_idx, img_meta.image_type);
  }
  return false;
}

bool oepl_provision_has_stored_image(void)
{
  /* Hot path: avoid NVM reads on every NFC FD glitch after provision. */
  if (user_image_uploaded) {
    return true;
  }
  size_t img_idx;
  return provision_stored_image_is_showable(&img_idx);
}

void oepl_provision_show_user_image(void)
{
  // #region agent log
  if (pin_screen_active) {
    PINPROV_DBG("H2", "DBG1AC9CA show_user_image WHILE_PIN_ACTIVE auth=%d",
                (int)upload_authorized);
  }
  // #endregion
  size_t img_idx = 0;
  if (provision_stored_image_is_showable(&img_idx)) {
    DPRINTF("show provision image slot %u\n", (unsigned)img_idx);
    oepl_display_diag_log_provision("show provision image");
    oepl_display_show_image(img_idx);
  } else {
    DPRINTF("no provision image, showing boot splash\n");
    oepl_display_diag_log_provision("show boot splash");
    oepl_display_show_infoscreen(INFOSCREEN_BOOT);
  }
}

bool oepl_provision_should_show_ap_found(void)
{
  return !user_image_uploaded && !oepl_provision_has_stored_image();
}

void oepl_provision_on_radio_connected(void)
{
  if (oepl_provision_is_active()) {
    oepl_display_show_infoscreen(INFOSCREEN_PROVISIONING);
    return;
  }
  /* Kiosk: keep boot splash; skip stock AP Found infoscreen. */
  if (oepl_provision_should_show_ap_found()) {
    ap_found_shown_this_boot = true;
  }
}

void oepl_provision_on_radio_disconnected(void)
{
  /* Kiosk: skip stock LONG_SCAN infoscreen while unprovisioned. */
}

void oepl_provision_on_stored_image_bad(size_t img_idx)
{
  DPRINTF("provision: stored image bad, erasing slot %u\n", (unsigned)img_idx);
  oepl_nvm_erase_image(img_idx);
  clear_user_image_uploaded_flag();
  pending_boot_splash = true;
}

bool oepl_provision_handle_pending_display(void)
{
  if(!pending_boot_splash) {
    return false;
  }
  pending_boot_splash = false;
  oepl_display_show_infoscreen(INFOSCREEN_BOOT);
  return true;
}

void oepl_provision_on_image_downloaded(size_t img_idx)
{
  oepl_stored_image_hdr_t meta;
  if (oepl_nvm_read_image_metadata(img_idx, &meta) != NVM_SUCCESS || !meta.is_valid) {
    PINPROV_DBG("H-C", "on_image_downloaded REJECT slot=%u invalid", (unsigned)img_idx);
    DPRINTF("provision: slot %u not valid after download\n", (unsigned)img_idx);
    return;
  }

  // #region agent log
  PINPROV_DBG("H3", "DBG1AC9CA on_image_downloaded slot=%u pin_active=%d",
              (unsigned)img_idx, (int)pin_screen_active);
  // #endregion
  end_pin_session("on_image_downloaded");

  size_t show_idx = img_idx;
  if (!provision_stored_image_is_showable(&show_idx)) {
    show_idx = img_idx;
  }

  PINPROV_DBG("H-C", "provision_show_download slot=%u type=0x%02x",
              (unsigned)show_idx, meta.image_type);
  DPRINTF("provision: show downloaded image slot %u type=0x%02x\n",
          (unsigned)show_idx, meta.image_type);
  oepl_display_diag_log_provision("show downloaded image");
  oepl_display_show_image(show_idx);
  mark_user_image_uploaded();
}

bool oepl_provision_wants_fast_poll(void)
{
  /* Only during PIN UI or an in-progress authorized upload — not idle. */
  return pin_screen_active || upload_authorized;
}

void oepl_provision_process(void)
{
  if (!pin_screen_active) {
    return;
  }

  uint32_t elapsed_ms = sl_sleeptimer_tick_to_ms(sl_sleeptimer_get_tick_count() - pin_screen_start_ticks);
  if (elapsed_ms >= pin_session_timeout_ms) {
    // #region agent log
    PINPROV_DBG("H1", "DBG1AC9CA process_timeout elapsed_ms=%lu timeout_ms=%lu",
                (unsigned long)elapsed_ms,
                (unsigned long)pin_session_timeout_ms);
    // #endregion
    end_pin_session("process_timeout");
    oepl_provision_show_user_image();
  }
}
