# DataTable

DataTable lists records in 36 px rows with tabular money and NULL-aware totals.

- Densities: `compact` 32 px, default 36 px, `comfortable` 44 px.
- A column with `wrap` wraps its text instead of widening the table; use it for long text such as descriptions or shared-field lists.
- A total that includes any unpriced line renders Unpriced; aggregates of blanks are blank.
- Production adds virtualization, column pinning, resize, grouping and keyboard grid navigation.
- Over its row limit (100 by default) a table renders its first screen itself, and TanStack Virtual loads when the table is first scrolled, pointed at or focused.
