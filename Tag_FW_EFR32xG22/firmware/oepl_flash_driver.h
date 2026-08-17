#ifndef OEPL_FLASH_DRIVER_H
#define OEPL_FLASH_DRIVER_H

// -----------------------------------------------------------------------------
//                                   Includes
// -----------------------------------------------------------------------------
#include <stdint.h>
#include <stdbool.h>

// -----------------------------------------------------------------------------
//                              Macros and Typedefs
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
//                                Global Variables
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
//                          Public Function Declarations
// -----------------------------------------------------------------------------

// Function called by the Drawing module when it needs to read from a flash-
// stored image.
// Returns the amount of bytes read (0 on failure)
uint32_t HAL_flashRead(uint32_t address, uint8_t *buffer, uint32_t num);

// Hold SPI + Solum mux awake across multiple HAL_flashRead calls (e.g. zlib decode).
bool oepl_flash_read_session_begin(void);
void oepl_flash_read_session_end(void);

// Probe external SPI flash (wakes Solum I2C mux). Returns false if JEDEC is invalid.
bool oepl_flash_probe(uint32_t* jedec_id, uint32_t* capacity_bytes);

// Erase 4 KiB sectors covering [address, address+length). Requires flash awake.
bool oepl_flash_erase_range(uint32_t address, uint32_t length);

// Program bytes into erased flash. Requires flash awake; length may span pages.
bool oepl_flash_write_range(uint32_t address, const uint8_t* data, uint32_t length);

#endif