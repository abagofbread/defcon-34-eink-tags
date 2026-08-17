#include "oepl_display_diag.h"

#include "oepl_hw_abstraction.h"
#include "oepl_efr32_hwtypes.h"
#include "oepl_drawing_capi.h"
#include "fonts/fonts.h"

#include "em_device.h"

#include <stdio.h>
#include <string.h>

#ifndef DISPLAY_DIAG_ON_SCREEN
#define DISPLAY_DIAG_ON_SCREEN 0
#endif

#define DPRINTF(fmt_, ...) oepl_hw_debugprint(DBG_DISPLAY, (fmt_), ##__VA_ARGS__)

static oepl_efr32xg22_displayparams_t cached_params;
static bool cached_params_valid;

static bool is_solum_autodetect(void)
{
  const oepl_efr32xg22_tagconfig_t* tagcfg = oepl_efr32xg22_get_config();
  return tagcfg != NULL && tagcfg->hwtype == SOLUM_AUTODETECT;
}

static const char* ctrl_name(oepl_efr32xg22_displaydriver_t ctrl)
{
  switch(ctrl) {
    case CTRL_MEMLCD: return "MEMLCD";
    case CTRL_UC8179: return "UC8179";
    case CTRL_UC8159: return "UC8159";
    case CTRL_EPDVAR26: return "EPDVAR26";
    case CTRL_EPDVAR29: return "EPDVAR29";
    case CTRL_EPDVAR43: return "EPDVAR43";
    case CTRL_SSD: return "SSD";
    case CTRL_DUALSSD: return "DUALSSD";
    case CTRL_IL91874: return "IL91874";
    case CTRL_GDEW0583Z83: return "GDEW0583Z83";
    case CTRL_UCBWRY: return "UCBWRY";
    case CTRL_JD: return "JD";
    case CTRL_INTERLEAVED: return "INTERLEAVED";
    case CTRL_DEVELOPMENT: return "DEVELOPMENT";
    default: return "?";
  }
}

static const char* infoscreen_name(oepl_display_infoscreen_t screen)
{
  switch(screen) {
    case INFOSCREEN_DEEPSLEEP: return "DEEPSLEEP";
    case INFOSCREEN_BOOT: return "BOOT";
    case INFOSCREEN_PROVISIONING: return "PROVISIONING";
    case INFOSCREEN_BOOT_FOUND_AP: return "BOOT_FOUND_AP";
    case INFOSCREEN_LONG_SCAN: return "LONG_SCAN";
    case INFOSCREEN_LOST_CONNECTION: return "LOST_CONNECTION";
    case INFOSCREEN_FWU: return "FWU";
    case INFOSCREEN_WAKEUP_BUTTON1: return "WAKEUP_BUTTON1";
    case INFOSCREEN_WAKEUP_BUTTON2: return "WAKEUP_BUTTON2";
    case INFOSCREEN_WAKEUP_GPIO: return "WAKEUP_GPIO";
    case INFOSCREEN_WAKEUP_NFC: return "WAKEUP_NFC";
    case INFOSCREEN_WAKEUP_RFWAKE: return "WAKEUP_RFWAKE";
    default: return "?";
  }
}

static void read_solum_userdata(uint8_t* ctrl, uint8_t* color, uint16_t* xres, uint16_t* yres, uint8_t* tagtype)
{
  *ctrl = *((uint8_t*) (USERDATA_BASE + 0x09));
  *color = *((uint8_t*) (USERDATA_BASE + 0x0A));
  *xres = *((uint8_t*) (USERDATA_BASE + 0x0B)) +
          (((uint16_t)(*((uint8_t*) (USERDATA_BASE + 0x0C)))) << 8);
  *yres = *((uint8_t*) (USERDATA_BASE + 0x0D)) +
          (((uint16_t)(*((uint8_t*) (USERDATA_BASE + 0x0E)))) << 8);
  *tagtype = *((uint8_t*) (USERDATA_BASE + 0x16));
}

void oepl_display_diag_cache_params(const oepl_efr32xg22_displayparams_t* params)
{
  if(params == NULL) {
    cached_params_valid = false;
    return;
  }
  cached_params = *params;
  cached_params_valid = true;
}

bool oepl_display_diag_userdata_suspicious(uint8_t oepl_hwid)
{
  if(!is_solum_autodetect()) {
    return false;
  }

  uint8_t ctrl, color, tagtype;
  uint16_t xres, yres;
  read_solum_userdata(&ctrl, &color, &xres, &yres, &tagtype);

  if(oepl_hwid == 0) {
    return true;
  }
  if(tagtype == 0x00 || tagtype == 0xFF) {
    return true;
  }
  if(ctrl == 0x00 || ctrl == 0xFF) {
    return true;
  }
  if(xres == 0 || yres == 0 || xres == 0xFFFF || yres == 0xFFFF) {
    return true;
  }
  return false;
}

void oepl_display_diag_log_boot(uint8_t oepl_hwid, const oepl_efr32xg22_displayparams_t* params)
{
  const oepl_efr32xg22_tagconfig_t* tagcfg = oepl_efr32xg22_get_config();
  uint8_t btl_id = 0;
  if(tagcfg != NULL) {
    btl_id = tagcfg->hwtype;
  }

  DPRINTF("=== display boot diag ===\n");
  DPRINTF("bootloader hwtype 0x%02x oepl hwid 0x%02x\n", btl_id, oepl_hwid);

  if(is_solum_autodetect()) {
    uint8_t ctrl, color, tagtype;
    uint16_t xres, yres;
    read_solum_userdata(&ctrl, &color, &xres, &yres, &tagtype);
    DPRINTF("userdata @0x%08lx:\n", (unsigned long)USERDATA_BASE);
    DPRINTF("  09 ctrl=0x%02x 0A color=0x%02x 0B-0C xres=%u 0D-0E yres=%u\n",
            ctrl, color, xres, yres);
    DPRINTF("  12 capa0=0x%02x 13 capa1=0x%02x 16 tagtype=0x%02x\n",
            *((uint8_t*) (USERDATA_BASE + 0x12)),
            *((uint8_t*) (USERDATA_BASE + 0x13)),
            tagtype);
    if(oepl_display_diag_userdata_suspicious(oepl_hwid)) {
      DPRINTF("WARNING: userdata looks erased or invalid — restore from dump after chip erase\n");
    }
  }

  if(params != NULL) {
    DPRINTF("resolved driver %s colors=%u%s%s res=%ux%u work=%ux%u off=%u,%u\n",
            ctrl_name(params->ctrl),
            (unsigned)(params->have_fourthcolor ? 4 : params->have_thirdcolor ? 3 : 2),
            params->swapXY ? " swapXY" : "",
            params->mirrorX ? " mirrorX" : "",
            (unsigned)params->xres, (unsigned)params->yres,
            (unsigned)params->xres_working, (unsigned)params->yres_working,
            (unsigned)params->xoffset, (unsigned)params->yoffset);
    if(params->mirrorY) {
      DPRINTF("mirrorY enabled\n");
    }
  } else {
    DPRINTF("ERROR: no display params\n");
  }
}

void oepl_display_diag_log_show(const char* action, oepl_display_infoscreen_t screen, int img_idx)
{
  if(img_idx >= 0) {
    DPRINTF("%s image slot %d\n", action, img_idx);
  } else {
    DPRINTF("%s infoscreen %s\n", action, infoscreen_name(screen));
  }
}

void oepl_display_diag_log_provision(const char* event)
{
  DPRINTF("provision: %s\n", event);
}

void oepl_display_diag_render_footer(uint8_t oepl_hwid)
{
#if DISPLAY_DIAG_ON_SCREEN
  if(!cached_params_valid) {
    return;
  }
  if(!is_solum_autodetect()) {
    return;
  }

  uint8_t ctrl, color, tagtype;
  uint16_t ud_xres, ud_yres;
  read_solum_userdata(&ctrl, &color, &ud_xres, &ud_yres, &tagtype);

  const oepl_efr32xg22_displayparams_t* p = &cached_params;
  uint16_t y = (uint16_t)p->yres_working;
  if(y > 14) {
    y -= 12;
  }

  C_epdSetFont(&FreeSans9pt7b);
  if(oepl_display_diag_userdata_suspicious(oepl_hwid)) {
    C_epdPrintf(2, y, COLOR_RED, ROTATE_0,
                "UD? 09:%02X 16:%02X %s %ux%u",
                ctrl, tagtype, ctrl_name(p->ctrl),
                (unsigned)p->xres_working, (unsigned)p->yres_working);
  } else {
    C_epdPrintf(2, y, COLOR_BLACK, ROTATE_0,
                "UD 09:%02X 16:%02X %s %ux%u",
                ctrl, tagtype, ctrl_name(p->ctrl),
                (unsigned)p->xres_working, (unsigned)p->yres_working);
  }
#else
  (void)oepl_hwid;
#endif
}
