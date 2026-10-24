# ADR 0075: Selection, Record Menus and Hover Cards in Every View

- Status: Accepted
- Date: 2026-10-24
- Decider: A115 (RRR-160), trace rows S11.2-05, S11.7-03, S11.7-08 and S11.7-09
- Migrations: none

## Context

A88 (ADR 0044) gave `DataTable` selection, a row menu and hover cards. The list, board and calendar
views of the same collections had none of them: a record could be selected and changed in bulk in a
table but not in its list, and a key previewed in a table but not on a board card. `DataTable` had
no J and K, and the Inbox no selection. `packages/ui` serves Atlas and Gateway, so it cannot import
Atlas's bulk kit, menus or hover loader.

## Decisions

### 1. One set of selection gestures, kept in `packages/ui`

`useItemSelection` (`packages/ui/src/lib/selection.ts`) gives `RecordList`, `Board` and `Calendar`
DataTable's gestures: X and Shift+X on the focused item, Cmd or Ctrl+click and Shift+click, Cmd or
Ctrl+A, and Esc, which clears before it reaches the page. A selectable list row leads with a
checkbox, as a table row does. A board card and a calendar event are buttons, so they name their
state in text ("Selected") instead of `aria-selected`, which a button may not carry. Each view
announces the count of its own selected items in a status region, so lists that share one
selection (My Work's groups) never announce another group's rows.

The component only reports the selection (`selection: { selected, onChange }`); the page keeps it,
as with `DataTable`. Alternative: each view with its own copy of DataTable's logic. Rejected,
because the gestures would drift apart.

### 2. Views name their items in the DOM; the app decides what they show

Every DataTable row, RecordRow, Board card and Calendar event carries its id as `data-item`, and the
parts that name a record (key, title, owner, an event) carry `data-column`. Context menus arrive
through `onItemContextMenu(id, point, element)`. The app's `useHoverCards` reads the two attributes
by event delegation and asks the page for the card by id and column, so `packages/ui` knows nothing
of hover loading, and one hook serves tables, lists, boards and calendars.

Alternative: render props for every key, title and owner cell. Rejected: three components would
each grow several slots for one behavior, and the delegation that keeps hover cards off the
initial bundle (ADR 0027) would still be needed.

### 3. A card for rows off the record spine

`RecordPreview` carries a record's kind, state, owner and next date when it has them, and the design
system's `HoverCard` shows it. A shift, an invoice, an asset unit or a collection-kit row lacks some
of them, so the card then shows the key, title, state and one more line. Server pages compute
previews for client tables (`PeekTable` rows, `PeekCalendar` events), because a function cannot
cross from a server component. A key a page shows without its record (an Activity line, a
dependency on a record page) is read on demand by `recordCardAction`, as the viewer, and cached
for the session like person cards.

### 4. The same record menu everywhere, including the record page

`useRowMenu` serves every view, and a record page's title row opens the record's menu by
right-click, Shift+F10 or its menu button: Copy link and, for people who may change records, the
bulk kit's changes on that one record. Open, Open as a full page and Select would mean nothing on
the record's own page, so `onPage` leaves them out. The bulk kit runs there without its toolbar
(`useBulk(..., { toolbar: false })`): closing the change dialog clears the one-record selection.
The records bulk configuration is one function (`recordBulkConfig`) for record collections, My
Work and the record page.

### 5. The Inbox selects but never approves in bulk

The Inbox selects with X, Shift+X, a checkbox or a modified click, and Done and Snooze (E, H, or the
bar) act on every selected item at once, each through the same request as a single act. Approve and
Reject stay one item at a time: an approval is a judgment on its own document, and journey 57
already approves a queue at keyboard speed.

## Consequences

- Visual baselines change where a selectable list now leads with checkboxes (record collections,
  My Work, assets and finance lists for people who may change rows), on the Inbox items and on the
  record page's title row, which gains its menu button.
- Selection in Gateway and in collections without a bulk RPC is not covered here.
