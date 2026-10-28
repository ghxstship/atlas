# ADR 0078: Bulk Edit of Projects, Work Orders, Punch and Documents, and Work Order Undo

- Status: Accepted
- Date: 2026-10-24
- Decider: A119 (RRR-164), trace rows S11.7-02, S11.7-03, S11.7-04 and S11.7-09
- Migrations: 2130 and 2131

## Context

ADR 0044 gave four tables (records, shifts, invoices and asset units) selection, a bulk bar, a transactional bulk RPC per resource (1451) and row menus. The Projects, Work orders, Punch lists, Recurring and Documents collections had none of them: their tables selected nothing, right-click did nothing, and a Draft work order deleted from its peek showed no Undo, though the row went to Trash.

Two things differ from the first four tables. Some changes apply only to some rows: a Complete or Canceled work order has no state to move to, and a Canceled project cannot leave its state. And punch items are Task records underneath (0410), so their state, owner and due time are the record's.

## Decisions

### 1. Four more resources on the 1451 driver

- `app.bulk_update_projects`, `bulk_update_work_orders`, `bulk_update_punch_items` and `bulk_update_documents` take `(p_rows, p_preview, p_reason)` and call `private.run_bulk`, so each keeps the 1451 rules: all or nothing, a preview that always undoes, refusals naming the row, the inverse rows that undo a call, and one `<resource>.bulk_update` audit event per org. The driver and its helpers are not redefined.
- Each row function runs with owner rights and checks the caller's capability on the row as the table's policies do, then lets the table's own guards and lifecycle RPCs decide:
  - Projects need `projects.project.write`. State goes through `app.transition_project` (`projects.settings.write`, the active project limit on reopening), the primary venue is set directly, and `archived_at` needs `projects.project.archive`. `archived_at` takes `true` to archive now, `null` to restore, or the time an undo puts back, so the bar never sends a client clock.
  - Work orders move through `app.transition_work_order` (`work.work_order.write`). Awarded stays with the award, which names a bid.
  - Punch items are addressed by punch item id. Each needs `work.punch_list.write` on its project and is then handed to `private.bulk_records_row` for its Task record, so the record's write rule, lifecycle and replan log apply. The inverse rows name the punch item.
  - Documents change scope: a project of the org or org-wide. Moving one needs `knowledge.document.write` where it is and where it goes, so no one moves a document out of reach of the people who could read it, or into a project they cannot write.
- Projects, work orders and punch items gain the audit trail records have (1451), so each row change and its undo reaches the field history.

### 2. The bar offers only the changes every selected row allows

- A `BulkField` may list the `rows` it applies to. The bar offers the field only when every selected row is listed. A row's menu offers what the whole selection allows when the row is in it, and what that row allows otherwise, because a change from the menu acts on the selection or on the row alone (`components/bulk/fields.ts`).
- The pages compute the list from the same rule tables the server uses: work order transitions without Awarded, project transitions, and record transitions without Blocked and Deferred (which need a blocker or a reason per record and stay single edits).
- Alternative: offer every change and let the preview refuse. Rejected, because selecting one Complete work order among Drafts would make every state change fail, and the person could not tell from the bar why.
- The database still checks every row; the list only keeps the bar from offering a change that cannot succeed.

### 3. Rows select by the id the RPC takes

- The tables of Projects, Work orders, Punch lists and Recurring key their rows by the database id their bulk RPC takes (the project, work order, punch item or record id), and label each row by its key in the menu, the checkboxes and refusals. Activating a row still opens the peek by key.
- Recurring uses the records resource with the same fields as every record collection (`recordBulkConfig` in `components/work/load.ts`). Documents go through the collection kit, whose rows gain an optional `label`: a document's key is where it belongs, so its title names it.
- Selection covers the table view of each collection, as on the first four tables.

### 4. A row's menu holds the row's own actions too

- `RowActions.more` adds the actions the row's peek offers after the changes. A Draft work order's menu offers Delete draft, shared with the peek.

### 5. Deleting a Draft work order can be undone

- Delete draft still moves the work order to Trash (a soft delete; the database refuses it for any other state), now only while the row is live. The delete goes on the session's undo stack: the shell shows its 8-second Undo toast, Undo or Cmd or Ctrl+Z restores the work order through `app.restore_trash_item`, as the Trash page does, and redo deletes it again.
- `app.restore_trash_item` (1031) restores the rows deleted with its subject by updating every referencing table with a `deleted_at`. The state ledgers of records and work orders have one but refuse every update, so restoring a record or a work order failed with permission denied. The walk now visits only referencing tables whose `deleted_at` the caller may update (2131). A118's 2122 makes the same function skip tables without the table-level update privilege; a column privilege check includes it, so whichever migration runs last keeps both fixes.

### 6. The Projects page stays in its route budget

- Projects sat 32 bytes under its 200 KB gzip budget, and selection with a row menu took it past. The views other than the default table (list, board, gallery, timeline, calendar) and the peek move to `components/projects/project-views.tsx`, loaded with next/dynamic when shown, as their @xos/ui components already were. The labels both use (gate, phase, state and dates) live in `project-labels.ts`.
- The Projects table's row menu comes through `useRowMenuOnDemand` (`components/menus/row-menu-on-demand.tsx`): the same `open` and `menu` as `useRowMenu`, with the code that builds the menu fetched on the first right-click. The page is about 1.2 KB under its budget; the budget is unchanged.
- Alternative: raise the budget. Rejected; the budget is a ceiling, not a target.

## Consequences

- No API operation changes: the bulk RPCs are Atlas paths, as in ADR 0044.
- A118's versioned bulk saves (2120) apply to these resources unchanged once both land; these pages do not send row versions yet, so a stale row is refused by the values it expected, as before.
- Purchase orders and vendors (A120), the Show, Places and Logistics collections (A121), Gateway (A122), and the list, board and calendar views (A115) are outside this decision.
