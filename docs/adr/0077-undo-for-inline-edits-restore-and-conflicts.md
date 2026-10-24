# ADR 0077: Undo for Inline Edits, Restore from Activity, and the Mine-or-Theirs Dialog

- Status: Accepted
- Date: 2026-10-24
- Decider: A118 (RRR-163), trace rows S11.7-01, S11.7-02 and S11.7-10
- Migrations: 1770 to 1772

## Context

ADR 0044 gave Atlas a per-tab undo stack (`components/undo/undo-stack.ts`) with Cmd or Ctrl+Z, but only bulk edits and moving a record to Trash went on it. A record's properties, its kind's attributes, its state moves and checklist, budget cells, pastes and deletes, and invoice and settlement line deletes had no Cmd or Ctrl+Z; line deletes had no Undo at all. A record moved to Trash could be restored from the record or the Trash page, never from Activity, because moving to Trash emitted no event. And a stale save was refused (bulk edit, state moves) or silently overwrote the other person's change (record properties), without showing both values. Only budget lines (journey 33) offered a choice.

## Decisions

### 1. Every inline edit is a stack entry with its inverse

- `components/undo/entries.ts` defines the entry kinds: a property edit (undo writes the values before, expecting the values after; redo the reverse), a state change (undo moves back, compare-and-set on the new state), a delete to Trash (undo restores, redo deletes again) and a toggle. Each inverse goes back through the server, so an undo over a later change by someone else is refused and the entry stays (ADR 0044).
- Saves send only the fields that changed. An undo compares only those fields, not the whole row, so undoing an earlier edit still works after the person's own later edit of another field.
- Explicit saves (the record form, a state move, a line delete) show the shell's 8-second toast; budget cells and checklist items do not, because they are edited at spreadsheet speed. Budget pastes and deletes keep their own toast, which now acts on the stack entry.
- Moving a record back to Blocked or Deferred names the blocker or replan reason it had, and writes its own ledger entry ("Undid the last move.").

### 2. Saves carry the version they edited, and a conflict carries both values

- The rule is one for the bulk RPCs (1770) and for direct saves (`packages/data/src/versioned.ts`): a save carries the row's `updated_at` as the person loaded it and the values they started from. A matching version commits. A version that moved on is a conflict only for a field both people changed; someone else's change to another field merges. A version with nothing else expected refuses any later change.
- A bulk row may put `updated_at` in `expect`, never in `set`. A stale row's refusal (`bulk_stale`) carries `current`: the row's values now for the fields it set or expected, and its version, read only after the row function's own capability checks passed.
- Times compare by meaning (`private.bulk_same_value`, `sameFieldValue`), so a time read through the API never conflicts with the same instant in the row.
- Record properties and kind attributes keep their direct writes under row level security; the version check is compare-and-set on `updated_at`, retried when other saves land between the check and the write. Alternative: route the record form through `app.bulk_update_records`. Rejected, because the bulk row function invents a replan reason ("Changed in bulk.") for date changes and writes a bulk audit event for one edit.

### 3. The mine-or-theirs dialog is shared

- `components/undo/conflict-dialog.tsx` is the budget line dialog of journey 33 made shared. Its rows are only the fields both people changed to different values. Keeping mine saves again against the version that came back; taking theirs keeps their values for those fields, and the fields only the person changed still save. Closing the dialog takes theirs, so a dismissed conflict never writes. A conflict whose fields both people set alike needs no choice and saves at once.
- In bulk edit, stale rows are listed with both values in the change dialog: keeping mine expects each row's new version, taking theirs leaves those rows out of the change.
- While nothing is typed, the record and attribute forms follow the record as it changes (a live update, an undo); a form with typing keeps the values it started from, so its save meets the conflict.

### 4. Line deletes restore through Trash, and moving to Trash reaches Activity

- Invoice, settlement and budget lines were already soft deleted. A restored line keeps its number when it is free and otherwise moves to the end of its parent (1771), so a line added after the delete never blocks the restore.
- `app.restore_trash_item` (1031) failed every invoice line restore with permission denied, because its cascade updated child tables the caller may not update at all (the self-billing link tables). The cascade now skips tables without the update privilege (1772).
- `record.trashed`, `invoice_line.trashed`, `settlement_line.trashed` and `budget_line.trashed` are emitted when a row moves to Trash, with its project, so the Activity feed shows the deletion to the people who may read the project. Activity offers Restore on the newest such entry of a row still listed in `app.trash_items`, until its `purge_after`, through `app.restore_trash_item`, as the Trash page does.

## Consequences

- The four new event codes join the webhook catalog (additive).
- Shift, invoice and asset unit rows do not carry their `updated_at` to the bulk dialog yet, so their bulk changes are still checked only by their lifecycle RPCs; the RPCs accept a version as soon as those collections pass one.
- Work orders and day sheets (A119, A121) and Gateway (A122) are outside this decision.
