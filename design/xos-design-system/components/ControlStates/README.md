# ControlStates

ControlStates shows every interactive control in the seven required states: default, hover, focus, active, disabled, loading and error.

- Hover, focus and active are forced here with `is-hover`, `is-focus` and `is-active` so they can be reviewed and snapshot-tested; in product they come from the pointer and keyboard.
- Not applicable marks states a control does not have (a checkbox never loads).
- Visual regression should snapshot this page in dark, light, sunlight and RTL.
