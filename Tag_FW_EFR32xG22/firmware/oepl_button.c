#include "oepl_button.h"

#include "oepl_provision.h"
#include "oepl_hw_abstraction.h"

#include "sl_sleeptimer.h"

#define LONG_PRESS_MS 1500U

static oepl_hw_gpio_channel_t active_channel = BUTTON_1;
static bool press_active = false;
static uint32_t press_start_ticks = 0;
static bool long_press_handled = false;

void oepl_button_init(void)
{
  press_active = false;
  long_press_handled = false;
}

void oepl_button_notify_press(oepl_hw_gpio_channel_t channel)
{
  if (channel != BUTTON_1 && channel != BUTTON_2) {
    return;
  }
  active_channel = channel;
  press_active = true;
  press_start_ticks = sl_sleeptimer_get_tick_count();
  long_press_handled = false;
}

void oepl_button_notify_release(oepl_hw_gpio_channel_t channel)
{
  if (channel != BUTTON_1 && channel != BUTTON_2) {
    return;
  }
  if (!press_active || channel != active_channel) {
    return;
  }

  uint32_t held_ms = sl_sleeptimer_tick_to_ms(sl_sleeptimer_get_tick_count() - press_start_ticks);
  press_active = false;

  if (long_press_handled) {
    return;
  }

  if (held_ms >= LONG_PRESS_MS) {
    oepl_hw_reboot();
    return;
  }

  if (!oepl_provision_is_active()) {
    oepl_provision_on_button_press();
  }
}

void oepl_button_process(void)
{
  if (!press_active || long_press_handled) {
    return;
  }

  if (!oepl_hw_gpio_is_pressed(active_channel)) {
    return;
  }

  uint32_t held_ms = sl_sleeptimer_tick_to_ms(sl_sleeptimer_get_tick_count() - press_start_ticks);
  if (held_ms >= LONG_PRESS_MS) {
    long_press_handled = true;
    press_active = false;
    oepl_hw_reboot();
  }
}
