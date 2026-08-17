#ifndef OEPL_PINPROV_DEBUG_H
#define OEPL_PINPROV_DEBUG_H

#include "oepl_hw_abstraction.h"

/* Optional UART tracing for PIN provisioning (picked up by monitor-pinprov.py). */
#define PINPROV_DBG(hyp, fmt, ...) \
  oepl_hw_debugprint(DBG_APP, "[PIN] " hyp " " fmt "\n", ##__VA_ARGS__)

#endif
