# ScrollRegion

ScrollRegion keeps wide data inside the page width. Content wider than its container scrolls horizontally inside a labeled region; the page itself never scrolls sideways, which satisfies WCAG 1.4.10 Reflow for two-dimensional content.

- DataTable, BudgetGrid, ReconciliationTable, AccessGridMatrix, RadioChannelTable, ShortcutEditor, ResourceSchedule, DiffViewer, CoordinateMatrix, OrgChart and Timeline are wrapped automatically. Use ScrollRegion directly for any other wide content.
- The region has `role="region"` and an accessible name taken from the wrapped component's label, caption or title (fallback: "Scrollable content").
- It joins the tab order only while its content actually overflows, measured with a ResizeObserver, so keyboard users can scroll it with the arrow keys and nobody else pays an extra tab stop.
- Focus shows the standard 2 px `focus-ring` outline. Scrolling is contained (`overscroll-behavior-x: contain`) so a horizontal swipe never navigates the browser back.
- Production: keep this wrapper around TanStack Table and Glide Data Grid surfaces; Glide's own canvas scroller replaces it inside the grid.
