# CurrencyInput

CurrencyInput is NULL-aware: a blank value is unpriced and is never coerced to 0.

- Empty shows the hint text Unpriced; 0 is a claim and must be typed.
- Right-aligned tabular numerals; currency code beside the field.
- The consumer stores `null` for blank and a number otherwise.
