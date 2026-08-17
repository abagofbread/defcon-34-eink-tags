#include "oepl_fw_identity.h"

#include "oepl_hw_abstraction.h"
#include "oepl_nvm.h"
#include "oepl_pinprov_debug.h"

#ifndef PINPROV_BUILD_VERSION
#ifdef SL_APPLICATION_VERSION
#define PINPROV_BUILD_VERSION SL_APPLICATION_VERSION
#else
#define PINPROV_BUILD_VERSION 0
#endif
#endif

#ifndef PINPROV_FLAVOR
#define PINPROV_FLAVOR "pin-on-upload"
#endif

#ifndef PINPROV_VARIANT
#define PINPROV_VARIANT "SOLUM_AUTODETECT"
#endif

#define OEPL_FW_ID_STR2(x) #x
#define OEPL_FW_ID_STR(x) OEPL_FW_ID_STR2(x)

/*
 * Kept in flash for offline checks:
 *   strings firmware.s37 | grep OEPL_FW_ID
 */
__attribute__((used, section(".rodata")))
static const char oepl_fw_id_ro[] =
    OEPL_FW_ID_PREFIX
    "variant=" PINPROV_VARIANT
    ";pinprov=" OEPL_FW_ID_STR(PINPROV_BUILD_VERSION)
    ";defcon=" OEPL_FW_SUFFIX OEPL_FW_ID_STR(PINPROV_BUILD_VERSION)
    ";features=" PINPROV_FLAVOR;

const char *oepl_fw_identity_string(void)
{
  return oepl_fw_id_ro;
}

uint16_t oepl_fw_identity_version(void)
{
  return oepl_hw_get_swversion();
}

void oepl_fw_identity_print_defcon_banner(void)
{
  oepl_hw_debugprint(DBG_APP,
      "\n"
      "  ====================== DEFCON TAG ======================\n"
      " ____  _____ _____    ____ ___  _   _   _____ _____  \n"
      "|  _ \\| ____|  ___|  / ___/ _ \\| \\ | | |___ /|___ /  \n"
      "| | | |  _| | |_    | |  | | | |  \\| |   |_ \\  |_ \\  \n"
      "| |_| | |___|  _|   | |__| |_| | |\\  |  ___) |___) | \n"
      "|____/|_____|_|      \\____\\___/|_| \\_| |____/|____/  \n"
      "\n"
      "        >> HACK THE PLANET <<   pinprov v%u\n"
      "        [*] BADGE.SYS LOADED  [*] AWAITING RF UPLINK\n"
      "        > triple-tap tag for PIN provisioning\n"
      " a flag? Sure: flag{Y_S0_SERIAL_oiiaoiia} \n"
      "  ========================================================\n"
      "\n",
      (unsigned)oepl_hw_get_swversion());
  uint8_t dummy = 0; 
  oepl_nvm_setting_set(OEPL_CTF, &dummy, sizeof(dummy));
}

void oepl_fw_identity_print(void)
{
  oepl_fw_identity_print_defcon_banner();
  PINPROV_DBG("ID", "%s", oepl_fw_id_ro);
  oepl_hw_debugprint(DBG_APP,
                     "[APP] %s (swver=%u suffix=%s)\n",
                     oepl_fw_id_ro,
                     (unsigned)oepl_hw_get_swversion(),
                     oepl_hw_get_swsuffix());
}
