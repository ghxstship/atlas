# StatusHeatmap

StatusHeatmap crosses rows with columns, one state per cell: the recipients of an advance packet by its sections, the
people on a roster by readiness category, or the parties of a project by offering (R11, Section 11.11).

- Props: `label`, `corner`, `rows` (`{ id, label, sublabel }`), `cols` (`{ id, label }`), `cells` keyed
  `<row id>:<col id>` to `{ state, href, detail }`, `legend` (`{ state, icon, label }`), optional `selection` for a
  bulk action on rows, and `onCellSelect`.
- An ARIA grid with `useGridFocus`, like CoordinateMatrix: arrows move between cells, Home and End go to the row's
  ends (with Ctrl or Cmd, the grid's), and Enter or Space opens a cell (`onCellSelect`, else the cell's `href`).
- Every state shows its `StateIcon` and its label, never color alone. A row and column with no cell reads "not asked".
- The table is its own accessible alternative: row and column headers name every cell, and the legend lists each
  state once. Wide grids scroll inside a `ScrollRegion`, so a 375 px page never scrolls sideways.
- Atlas loads it through `components/lazy-ui/status-heatmap.tsx`, so key pages do not carry it.
