# Chart

Chart draws bar and line charts with one y-axis, thin marks, a legend for two or more series and a table view one click away.

- Series take `viz-cat-1` to `viz-cat-7` in order, never cycled; an eighth series folds into Other (`viz-other`).
- Every series also differs by a second encoding: line style and marker shape on lines, texture on alternate bars.
- Bars have 4 px rounded data ends anchored to the baseline and 2 px gaps; lines are 2 px with 9 px markers.
- Hover or focus any mark for a tooltip; text never wears the series color.
- A missing value is drawn as a gap, never as zero, and reads No value in the table.
