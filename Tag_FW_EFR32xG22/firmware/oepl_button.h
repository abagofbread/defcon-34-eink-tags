#ifndef OEPL_BUTTON_H
#define OEPL_BUTTON_H

#include "oepl_hw_abstraction.h"

void oepl_button_init(void);
void oepl_button_notify_press(oepl_hw_gpio_channel_t channel);
void oepl_button_notify_release(oepl_hw_gpio_channel_t channel);
void oepl_button_process(void);

#endif
