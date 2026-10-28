# TemplateDashboard

Dashboard is the template for Home, report dashboards and the partner console: a header with date range and scope picker, then tiles on the 12-column grid, resizable in grid units.

- Each tile spans whole columns (3 to 12 by default; `minSpan` raises the floor). Below md the grid is one column.
- With `resize`, a tile's inline-end handle widens or narrows it by drag or by the arrow keys (Home and End jump to the limits); a screen reader hears the new span, and `resize.onChange` receives every span to save. Atlas keeps them in the person's dashboard layout setting.
- The app supplies the handle and announcement copy, so the library ships no strings for it.
- Every figure drills through to its records in one click.
