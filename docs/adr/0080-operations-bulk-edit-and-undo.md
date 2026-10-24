# ADR 0080: Operations Bulk Edit, Undo for Their Deletes and Day Sheet Drafts

- Status: Accepted
- Date: 2026-10-24
- Decider: A121 (RRR-167), trace rows S11.7-01, S11.7-02, S11.7-03, S11.7-04, S11.7-09 and S4.7-05
- Migrations: 1800 and 1801

## Context

ADR 0044 gave four tables selection, a bulk bar, a transactional bulk RPC per resource (1451) and row menus, and A119 (ADR 0078) took them to Projects, Work orders, Punch, Recurring and Documents. The Show, Places, Logistics, Hospitality and Advancing collections still had none of them: their tables selected nothing and right-click did nothing.

Their deletes were uneven too. A logistics or hospitality delete from a record's peek showed an Undo toast inside the peek, but the delete also navigated back to the list, which unmounted the peek and the toast with it, and none of them reached the session's undo stack (Cmd or Ctrl+Z). Day sheet and call sheet deletes were already soft deletes but offered no Undo at all.

Finding A65-020 left drafting of day sheets and emails without an entry point: no editor existed for either when A95 added "Draft with Aurora".

## Decisions

### 1. Six more resources on the 1451 driver

- `app.bulk_update_shipments`, `bulk_update_dock_slots`, `bulk_update_fulfillments`, `bulk_update_beos`, `bulk_update_accommodation_blocks` and `bulk_update_guest_list_entries` take `(p_rows, p_preview, p_reason)` and call `private.run_bulk`, so each keeps the 1451 rules: all or nothing, a preview that always undoes, refusals naming the row, the inverse rows that undo a call, and one `<resource>.bulk_update` audit event per org. The driver and its helpers are not redefined.
- Each row function runs with owner rights and checks the caller's capability on the row as the table's policies do, then lets the table's guards and lifecycle RPCs decide:
  - Shipments (direction, carrier, freight type) need `logistics.shipment.write`; the freight type still comes from the canon Freight Type enumeration and the carrier from the same org.
  - Dock slots, the dock and yard bookings, change dock zone with `logistics.dock_slot.write`. The overlap rule and the freeze of a checked-in slot still refuse a move.
  - Fulfillments move through `app.transition_fulfillment`, with the reason and the lifecycle rules, and change supplier, with `hospitality.fulfillment.write`.
  - Room blocks change hotel with `hospitality.accommodation.write`.
  - BEOs are approved in bulk ("approve 20 in 60 s", Section 11.11). Each needs `hospitality.beo.write` as the update policy does, and the BEO guard still asks for `hospitality.beo.approve`, refuses the author and stamps the approval once.
  - Guest list entries are approved, declined or checked in with `advancing.rider.write`; the guest list guard still asks for `advancing.submission.review` on a decision and refuses the person who requested the guest.
- BEO approvals and guest decisions move one way, as invoice approvals do in 1451. Their bulk change commits like any other, and its undo is refused by the same guard a single edit meets (`beo_approved`, `guest_entry_transition`); the stack keeps the entry and says why, as ADR 0044 decides for any refused undo.
- The six tables gain the audit trail records have (1451), so each row change and its undo reaches the field history. Until now only their creation and a few stamps emitted events.
- Packets, riders and reconciliation runs have no property that changes in bulk: a packet's state follows its sending, a rider's its lines and a run's its results. Running orders, day and call sheets, venues, spaces, place documents and permits have none either: their names, days and bodies are edited one at a time, and publishing a sheet is stamped once. Those tables get the row menu but no selection, since `useBulk` selects only where a property can change.

### 2. Every table of these collections opens a row menu

- `OperationsTable` (logistics and hospitality), the advancing `PeekTable`, the places kit `PeekTable` (Places and Permits), the run of show table and the new sheets table open a row's menu by right-click, Shift+F10 or the Context Menu key, through `useRowMenu`.
- The menu offers what the row's peek offers: open it, open its full page and copy its link where the collection has full pages, select it and change its bulk properties where it has any, and the row's own actions after those (A119's `RowActions.more`): Move to Trash on shipments, fulfillments, BEOs and room blocks, Cancel slot on dock slots, Delete on unpublished sheets, and Start live mode on a running order with cues.
- The dock schedule and the day and call sheets gain a table view, which Section 11.15 offers for every collection, so their rows have somewhere to select and open a menu. The sitemap lists it; their other views are unchanged.

### 3. Logistics and hospitality deletes join the undo stack and keep their toast

- `ActionButton` with `undo` pushes the delete onto the session's undo stack (`components/logistics-hospitality/undo.ts`): Undo restores the row through the same restore action, and redo moves it to Trash again.
- A delete that leaves the page (`doneHref`, every delete from a record) hands its toast to the shell's undo center, which shows the same sentence for 8 seconds and outlives the closed peek. A delete that stays on the page keeps its own toast (`UndoNotice`), whose Undo acts on the same stack entry. A row menu's Move to Trash uses the shell's toast too.
- Alternative: keep the peek's toast and stop navigating after a delete. Rejected, because the peek would keep showing a record that is in Trash.

### 4. Sheet deletes can be undone

- Deleting a day or call sheet still sets `deleted_at`; it now goes on the undo stack with the shell's 8-second Undo toast, and Undo restores it (`restoreSheet`). A sheet saved for the same project day in between is refused by the one-sheet-a-day index, so the undo reports a conflict instead of hiding the newer sheet.

### 5. Drafting a day sheet with Aurora; no email composer in 4.0

- The day sheet editor gets "Draft with Aurora" (`DraftEntry`, kind `day_sheet`), which `aurora.draft` already served. The draft reads the sheet and its project, as the request would, and fills the body; Save day sheet is the write. The body field takes its name so the draft can fill it.
- Atlas 4.0 has no screen where outbound email text is written: notification, invitation and reminder emails are system templates, advance packet links are shared by the coordinator, and the project inbox files or discards inbound mail without replying. Drafting an email therefore has no entry point; the `email` kind stays an API feature (recorded in ADR 0051).

## Consequences

- No API operation changes: the bulk RPCs are Atlas paths, as in ADR 0044 and ADR 0078.
- A118's versioned bulk saves (1770) apply to these resources once both land; these pages do not send row versions yet, so a stale row is refused by the values it expected.
- `RowActions.more` is A119's hunk, copied verbatim so the two branches merge cleanly.
- The list, board and calendar views of these collections (A115) and Gateway (A122) are outside this decision.
