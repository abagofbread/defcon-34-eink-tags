#ifndef OEPL_PROVISION_H
#define OEPL_PROVISION_H

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

struct AvailDataReq;

#define OEPL_PROVISION_PIN_LEN 6
#define OEPL_PROVISION_FIRST_TIMEOUT_S 300
#define OEPL_PROVISION_REPROVISION_TIMEOUT_S 300
#define OEPL_PROVISION_TRIPLE_TAP_COUNT 3
#define OEPL_PROVISION_TRIPLE_TAP_WINDOW_MS 800
#define OEPL_PROVISION_FAST_POLL_S 5

/* Physical bulk-flash slot for provisioned user image (NOCUSTOM). Always erased on provision. */
#define OEPL_PROVISION_BULK_SLOT 0

bool oepl_provision_init(void);
bool oepl_provision_should_show_pin(void);
void oepl_provision_begin_pin_display(void);
bool oepl_provision_on_button_press(void);
void oepl_provision_request_pin_ui(void);
bool oepl_provision_is_active(void);
bool oepl_provision_is_provisioned(void);
bool oepl_provision_is_session_authorized(void);
bool oepl_provision_authorize_session(const char *pin);
bool oepl_provision_verify_image_auth(const uint8_t pin_bytes[6]);
void oepl_provision_fill_poll(struct AvailDataReq *req);
void oepl_provision_process(void);
void oepl_provision_mark_provisioned(bool unlock_updates);
bool oepl_provision_updates_allowed(void);
bool oepl_provision_accepts_content_type(uint8_t dataType);
const char *oepl_provision_get_pin(void);
void oepl_provision_show_user_image(void);
bool oepl_provision_has_stored_image(void);
void oepl_provision_on_image_downloaded(size_t img_idx);
bool oepl_provision_wants_fast_poll(void);
bool oepl_provision_should_show_ap_found(void);
void oepl_provision_on_radio_connected(void);
void oepl_provision_on_radio_disconnected(void);

void oepl_provision_on_stored_image_bad(size_t img_idx);
bool oepl_provision_handle_pending_display(void);

#endif
