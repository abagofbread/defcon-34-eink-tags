// -----------------------------------------------------------------------------
//                                   Includes
// -----------------------------------------------------------------------------
#include "oepl_flash_driver.h"
#include "oepl_nvm.h"
#include "oepl_hw_abstraction.h"
#include "oepl_efr32_hwtypes.h"
#include <spidrv.h>
#include "em_cmu.h"
#include "string.h"
#include "sl_udelay.h"

// -----------------------------------------------------------------------------
//                              Configuration values
// -----------------------------------------------------------------------------
#ifndef FLASH_DEBUG_PRINT
#define FLASH_DEBUG_PRINT 1
#endif

// -----------------------------------------------------------------------------
//                              Macros and Typedefs
// -----------------------------------------------------------------------------
#if FLASH_DEBUG_PRINT
#define DPRINTF(fmt_, ...) oepl_hw_debugprint(DBG_FLASH, (fmt_), ##__VA_ARGS__)
#else
#define DPRINTF(...)
#endif

// -----------------------------------------------------------------------------
//                          Static Function Declarations
// -----------------------------------------------------------------------------
static void init_flashdriver(void);
static bool setup_spi(void);
static void teardown_spi(void);
static void read_bytes(uint32_t address, uint8_t* buffer, size_t bytes);
static void write_enable(void);
static void wait_not_busy(void);
static uint32_t jedec_capacity_bytes(uint8_t capacity_code);

// -----------------------------------------------------------------------------
//                                Global Variables
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
//                                Static Variables
// -----------------------------------------------------------------------------
static const oepl_efr32xg22_tagconfig_t* cfg = NULL;
static SPIDRV_HandleData_t handledata;
static SPIDRV_Handle_t handle = &handledata;
static uint8_t read_session_depth = 0;
static bool read_session_spi_up = false;

// -----------------------------------------------------------------------------
//                          Public Function Definitions
// -----------------------------------------------------------------------------

bool oepl_flash_read_session_begin(void)
{
  init_flashdriver();

  if(cfg == NULL || cfg->flash == NULL) {
    return false;
  }

  if(read_session_depth == 0) {
    read_session_spi_up = setup_spi();
    if(!read_session_spi_up) {
      teardown_spi();
      return false;
    }
  } else if(!read_session_spi_up) {
    return false;
  }

  read_session_depth++;
  return true;
}

void oepl_flash_read_session_end(void)
{
  if(read_session_depth == 0) {
    return;
  }

  read_session_depth--;
  if(read_session_depth == 0 && read_session_spi_up) {
    teardown_spi();
    read_session_spi_up = false;
    oepl_hw_flash_deepsleep();
  }
}

uint32_t HAL_flashRead(uint32_t address, uint8_t *buffer, uint32_t num)
{
  init_flashdriver();

  if(cfg == NULL || cfg->flash == NULL) {
    oepl_hw_crash(DBG_FLASH, false, "Unknown flash configuration\n");
  }

  bool local_session = false;
  if(read_session_depth == 0 || !read_session_spi_up) {
    if(!setup_spi()) {
      teardown_spi();
      return 0;
    }
    local_session = true;
  }

  read_bytes(address, buffer, num);

  if(local_session) {
    teardown_spi();
  }

  return num;
}

// -----------------------------------------------------------------------------
//                          Static Function Definitions
// -----------------------------------------------------------------------------
static void init_flashdriver(void)
{
  if(cfg != NULL) {
    return;
  }

  cfg = oepl_efr32xg22_get_config();
}

static uint32_t jedec_capacity_bytes(uint8_t capacity_code)
{
  switch(capacity_code) {
    case 0x13: return 8UL * 1024UL * 1024UL;
    case 0x14: return 2UL * 1024UL * 1024UL;
    case 0x15: return 4UL * 1024UL * 1024UL;
    case 0x16: return 8UL * 1024UL * 1024UL;
    case 0x17: return 16UL * 1024UL * 1024UL;
    case 0x18: return 32UL * 1024UL * 1024UL;
    case 0x19: return 64UL * 1024UL * 1024UL;
    default: return 0;
  }
}

static void write_enable(void)
{
  GPIO_PinOutClear(cfg->flash->nCS.port, cfg->flash->nCS.pin);
  uint8_t cmd[] = {0x06};
  SPIDRV_MTransmitB(handle, cmd, sizeof(cmd));
  GPIO_PinOutSet(cfg->flash->nCS.port, cfg->flash->nCS.pin);
}

static void wait_not_busy(void)
{
  uint8_t status_cmd[] = {0x05, 0xFF};
  while((status_cmd[1] & 0x01) != 0) {
    GPIO_PinOutClear(cfg->flash->nCS.port, cfg->flash->nCS.pin);
    SPIDRV_MTransferB(handle, status_cmd, status_cmd, 2);
    GPIO_PinOutSet(cfg->flash->nCS.port, cfg->flash->nCS.pin);
    status_cmd[0] = 0x05;
  }
}

static bool setup_spi(void)
{
  oepl_hw_flash_wake();
  CMU_ClockEnable(cmuClock_GPIO, true);
  CMU_ClockEnable(cmuClock_USART0, true);

  SPIDRV_Init_t spi_init = SPIDRV_MASTER_DEFAULT;
  spi_init.port = cfg->flash->usart;
  spi_init.portTx = cfg->flash->MOSI.port;
  spi_init.pinTx = cfg->flash->MOSI.pin;
  spi_init.portRx = cfg->flash->MISO.port;
  spi_init.pinRx = cfg->flash->MISO.pin;
  spi_init.portClk = cfg->flash->SCK.port;
  spi_init.pinClk = cfg->flash->SCK.pin;
  spi_init.bitRate = 4000000;
  spi_init.csControl = spidrvCsControlApplication;

  if(cfg->flash->EN.port != gpioPortInvalid) {
    GPIO_PinModeSet(cfg->flash->EN.port, cfg->flash->EN.pin, gpioModePushPull, cfg->flash->EN.idle_state ? 0 : 1);
  }

  GPIO_PinModeSet(cfg->flash->nCS.port, cfg->flash->nCS.pin, gpioModePushPull, 1);
  SPIDRV_Init(handle, &spi_init);

  // Wake the flash
  // If it's an MX25 in deep sleep, use CS assert to wake it
  // Wake up flash in case the device is in deep power down mode already.
  GPIO_PinOutClear(cfg->flash->nCS.port, cfg->flash->nCS.pin);
  sl_udelay_wait(20);                  // wait for tCRDP=20us
  GPIO_PinOutSet(cfg->flash->nCS.port, cfg->flash->nCS.pin);
  sl_udelay_wait(35);                  // wait for tRDP=35us

  // If it's another SFDP flash, issue the standard wakeup call
  GPIO_PinOutClear(cfg->flash->nCS.port, cfg->flash->nCS.pin);
  uint8_t powerup[] = {0xAB};
  SPIDRV_MTransmitB(handle, powerup, sizeof(powerup));
  GPIO_PinOutSet(cfg->flash->nCS.port, cfg->flash->nCS.pin);
  sl_udelay_wait(3);

  // Sanity checks before reading from flash:
  // Check the JEDEC ID can be read
  uint8_t jedec_id[4] = {0x9F, 0x00, 0x00, 0x00};
  for(uint8_t attempt = 0; attempt < 20 && jedec_id[1] == 0; attempt++) {
    GPIO_PinOutClear(cfg->flash->nCS.port, cfg->flash->nCS.pin);
    SPIDRV_MTransferB(handle, jedec_id, jedec_id, 4);
    GPIO_PinOutSet(cfg->flash->nCS.port, cfg->flash->nCS.pin);
    jedec_id[0] = 0x9F;
    if(jedec_id[1] == 0) {
      sl_udelay_wait(1000);
    }
  }

  if(jedec_id[1] == 0) {
    DPRINTF("JEDEC read failed\n");
    return false;
  }

  wait_not_busy();
  return true;
}

bool oepl_flash_probe(uint32_t* jedec_id, uint32_t* capacity_bytes)
{
  init_flashdriver();
  if(cfg == NULL || cfg->flash == NULL) {
    return false;
  }

  if(!setup_spi()) {
    teardown_spi();
    return false;
  }

  uint8_t jedec[4] = {0x9F, 0x00, 0x00, 0x00};
  GPIO_PinOutClear(cfg->flash->nCS.port, cfg->flash->nCS.pin);
  SPIDRV_MTransferB(handle, jedec, jedec, 4);
  GPIO_PinOutSet(cfg->flash->nCS.port, cfg->flash->nCS.pin);
  teardown_spi();

  uint32_t id = ((uint32_t)jedec[1] << 16) | ((uint32_t)jedec[2] << 8) | jedec[3];
  uint32_t cap = jedec_capacity_bytes(jedec[3]);
  if(id == 0 || id == 0xFFFFFFUL) {
    DPRINTF("Invalid JEDEC %06lx\n", id);
    return false;
  }
  if(cap == 0) {
    cap = 8UL * 1024UL * 1024UL;
    DPRINTF("Unknown JEDEC cap %02x, assuming %luB\n", jedec[3], cap);
  }

  DPRINTF("JEDEC %06lx capacity %luB\n", id, cap);
  if(jedec_id != NULL) {
    *jedec_id = id;
  }
  if(capacity_bytes != NULL) {
    *capacity_bytes = cap;
  }
  return true;
}

bool oepl_flash_erase_range(uint32_t address, uint32_t length)
{
  init_flashdriver();
  if(cfg == NULL || cfg->flash == NULL || length == 0) {
    return false;
  }

  if(!setup_spi()) {
    teardown_spi();
    return false;
  }

  const uint32_t sector = 4096;
  address &= ~(sector - 1);
  for(uint32_t offset = 0; offset < length; offset += sector) {
    uint32_t addr = address + offset;
    write_enable();
    GPIO_PinOutClear(cfg->flash->nCS.port, cfg->flash->nCS.pin);
    uint8_t erase_cmd[] = {0x20, (uint8_t)(addr >> 16), (uint8_t)(addr >> 8), (uint8_t)addr};
    SPIDRV_MTransmitB(handle, erase_cmd, sizeof(erase_cmd));
    GPIO_PinOutSet(cfg->flash->nCS.port, cfg->flash->nCS.pin);
    wait_not_busy();
  }

  teardown_spi();
  return true;
}

bool oepl_flash_write_range(uint32_t address, const uint8_t* data, uint32_t length)
{
  init_flashdriver();
  if(cfg == NULL || cfg->flash == NULL || data == NULL || length == 0) {
    return false;
  }

  if(!setup_spi()) {
    teardown_spi();
    return false;
  }

  uint32_t written = 0;
  while(written < length) {
    uint32_t page_remain = 256U - (address % 256U);
    uint32_t chunk = length - written;
    if(chunk > page_remain) {
      chunk = page_remain;
    }

    write_enable();
    GPIO_PinOutClear(cfg->flash->nCS.port, cfg->flash->nCS.pin);
    uint8_t prog_cmd[] = {0x02, (uint8_t)(address >> 16), (uint8_t)(address >> 8), (uint8_t)address};
    SPIDRV_MTransmitB(handle, prog_cmd, sizeof(prog_cmd));
    SPIDRV_MTransmitB(handle, (uint8_t*)(data + written), chunk);
    GPIO_PinOutSet(cfg->flash->nCS.port, cfg->flash->nCS.pin);
    wait_not_busy();

    address += chunk;
    written += chunk;
  }

  teardown_spi();
  return true;
}

static void teardown_spi(void)
{
  GPIO_PinModeSet(cfg->flash->nCS.port, cfg->flash->nCS.pin, gpioModeInputPull, 1);
  SPIDRV_DeInit(handle);

  if(cfg->flash->EN.port != gpioPortInvalid) {
    GPIO_PinModeSet(cfg->flash->EN.port, cfg->flash->EN.pin, gpioModeInputPull, cfg->flash->EN.idle_state);
    GPIO_PinModeSet(cfg->flash->nCS.port, cfg->flash->nCS.pin, gpioModeInput, 1);
  }
}

static void read_bytes(uint32_t address, uint8_t* buffer, size_t bytes)
{
  uint8_t* buffer_ptr = buffer;

  // Chunk the transfer in 2k blocks, as the EFR32 DMA maxes out at 2k
  for(size_t i = 0; i < bytes / 2048; i++) {
    GPIO_PinOutClear(cfg->flash->nCS.port, cfg->flash->nCS.pin);
    uint8_t readcmd[] = {0x03, address >> 16, address >> 8, address};
    SPIDRV_MTransmitB(handle, readcmd, sizeof(readcmd));
    SPIDRV_MReceiveB(handle, buffer_ptr, 2048);
    GPIO_PinOutSet(cfg->flash->nCS.port, cfg->flash->nCS.pin);
    address += 2048;
    buffer_ptr += 2048;
  }
  
  if((size_t)(buffer_ptr - buffer) < bytes) {
    GPIO_PinOutClear(cfg->flash->nCS.port, cfg->flash->nCS.pin);
    uint8_t readcmd[] = {0x03, address >> 16, address >> 8, address};
    SPIDRV_MTransmitB(handle, readcmd, sizeof(readcmd));
    SPIDRV_MReceiveB(handle, buffer_ptr, bytes - (buffer_ptr - buffer));
    GPIO_PinOutSet(cfg->flash->nCS.port, cfg->flash->nCS.pin);
  }
}