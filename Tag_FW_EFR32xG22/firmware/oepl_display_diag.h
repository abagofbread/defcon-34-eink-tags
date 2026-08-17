#ifndef OEPL_DISPLAY_DIAG_H
#define OEPL_DISPLAY_DIAG_H

#include "oepl_display.h"
#include "oepl_efr32_hwtypes.h"
#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

void oepl_display_diag_cache_params(const oepl_efr32xg22_displayparams_t* params);
void oepl_display_diag_log_boot(uint8_t oepl_hwid, const oepl_efr32xg22_displayparams_t* params);
void oepl_display_diag_log_show(const char* action, oepl_display_infoscreen_t screen, int img_idx);
void oepl_display_diag_log_provision(const char* event);
bool oepl_display_diag_userdata_suspicious(uint8_t oepl_hwid);
void oepl_display_diag_render_footer(uint8_t oepl_hwid);

#endif
