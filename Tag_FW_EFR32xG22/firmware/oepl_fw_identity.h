#ifndef OEPL_FW_IDENTITY_H
#define OEPL_FW_IDENTITY_H

#include <stdint.h>

/* Stable prefix for strings(1), OpenOCD find, and UART grep. */
#define OEPL_FW_ID_PREFIX "OEPL_FW_ID:"

const char *oepl_fw_identity_string(void);
uint16_t oepl_fw_identity_version(void);
void oepl_fw_identity_print_defcon_banner(void);
void oepl_fw_identity_print(void);

#endif
