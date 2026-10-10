# Money

Money displays an amount with tabular numerals, or Unpriced when the amount is null.

- Null renders Unpriced, never $0.00 or an empty string. Aggregates of blanks are blank.
- Opportunities with no compensation pass `unpricedLabel: 'Rate on Request'`.
