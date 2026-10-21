# ADR 0044: Collaboration and Power Editing

- Status: Accepted
- Date: 2026-10-21
- Decider: Orchestrator; built and recorded by A88 (RRR-133)
- Resolves: finding A65-006 (work package WP6), trace rows S11.7-01 to S11.7-04, S11.7-08 to S11.7-10, S4.10-04 and S5-27

## Context

A65-006 found the interaction model of Section 11.7 missing from the product. Lists and records did not update
live, and show mode polled every two seconds against a 500 ms cue sync target (Section 11.11). There was no
multi-select, no bulk edit, no undo stack, no context menu and no field history. Rich text co-editing over Yjs
existed only as a component no app rendered.

Two constraints shape every decision here:

- **The route JavaScript budget (ADR 0027).** Every key page must stay under 200 KB, and Projects was at 192 KB.
- **Session cookies are httpOnly.** No browser Supabase client exists in Atlas, so page scripts never hold a
  session token.

## Decision

### 1. Live updates: one Realtime channel per page, authorized by the person's own token

- **The hub.** `@xos/data/live` keeps one Realtime socket per tab and one channel per page. It multiplexes every
  `postgres_changes` binding the page's components ask for. Components declare tables with `useLive` (`@xos/ui`),
  and Atlas pages use `LiveRefresh` or `useLiveRefresh` (`apps/atlas/components/live`). A batch of changes runs
  `router.refresh()` in a transition: the page rereads through its normal server path, and client state survives.
- **Authorization.** Realtime checks each change against row level security with the subscriber's JWT, so a
  change reaches only people who could read the row. Pages subscribe narrowed to their org, project or record
  (`org_id=eq.<id>`), never to a whole table.
- **The token.** `/auth/realtime` gives the page the session's short-lived access token, and only that. It is
  same-origin only: no CORS headers, and `Sec-Fetch-Site` is checked. The refresh token never leaves the httpOnly
  cookie. The page keeps the access token in memory and asks again a minute before it expires.
  - This is a deliberate, narrow exception to "page scripts never hold a token".
  - A script running in the page could already act as the person through same-origin requests. What changes is
    that it could copy a token valid for at most the access token lifetime (one hour by default).
  - The Content Security Policy now allows exactly one more connection: the Supabase Realtime socket's origin.
- **No refetch loops.** The hub throttles, and pacing is per watcher:
  - batches gather for 300 ms and arrive at most every 2 s;
  - while changes keep arriving back to back, the interval doubles up to 30 s;
  - a hidden tab holds its batch until it is visible again;
  - more than 100 pending changes collapse into one `RESYNC`.
  - A page whose own render wrote a watched row could therefore never refetch faster than every 30 s.
  - Show mode paces itself at 30 ms batches and 200 ms to 1 s intervals, to meet the 500 ms cue sync target. A
    15-second pull covers a dropped channel; it replaced the 2-second poll.
- **Reconnects.** Reconnects back off from 1 s to 30 s with jitter of half either way, so tabs never retry in step.
  After a dropped channel comes back, the page rereads once (`RESYNC`). With no watcher left for a minute, the
  socket closes.
- **Edits in progress.** A refresh never runs while a form on the page holds unsaved input. A refresh would
  re-render the form's hidden `expectedUpdatedAt` with someone else's newer save, defeating the stale-save check.
  Holding the refresh keeps the rule that no change is lost silently.
- **Loading on demand.** The shell carries only the loader. The hub and the Realtime client load the first time a
  page watches something, once the browser is idle.
- **Tables.** Migration 1450 adds to the publication only the tables behind live pages: `records`, `shifts`,
  `invoices`, `asset_units` and `sops`. `cues` and `run_of_show` were already there (0412).

### 2. Bulk edit: one transactional RPC per resource, all or nothing

- **The driver.** `private.run_bulk` (migration 1451) takes rows as JSON (`{id, set, expect}`) and calls the
  resource's row function on each, each row in its own subtransaction. A refusal is caught and reported against
  its row, with the rule and sentence the database gave. Any refusal undoes every change, so the answer either
  commits every row or none.
- **Preview.** A preview runs the same work, triggers and capability checks included, and always undoes it. The
  counts it shows (rows that change, rows that already hold the value, refused rows) are exactly what applying
  would do.
- **Capability on every row.** Row functions run with owner rights, as every RPC here does, so they check the
  caller's capability on each row the way the table's policies do. State changes go through the lifecycle RPCs
  (`transition_record`, `transition_shift`, `approve_invoice`, `transition_asset`). Every rule a single edit meets
  applies in bulk too: separation of duties and spend authority for approvals, blockers for Blocked, retirement
  approval for assets.
  - An invoice approval that needs another approver under spend authority is refused in bulk, so the call stays
    all or nothing.
- **Compare-and-set.** `expect` refuses a row whose current value differs from what the caller saw
  (`bulk_stale`).
- **Audit.** A committed call writes one `<resource>.bulk_update` event per org to the audit ledger, with the
  row count, the fields and the reason. Row changes reach the ledger through each table's audit trail;
  `app.records` gains one in 1451.
- **Resources.** Records (state, owner, accountable party, due time, phase), shifts (state, person), invoices
  (approve, dispute, cancel) and asset units (state, home venue, condition). Adding a resource is one row
  function, one `private.bulk_resources` row and one thin `app.bulk_update_<resource>` RPC.
- **Selection.** DataTable selects rows with a checkbox column, Cmd or Ctrl+click, Shift+click ranges, X and
  Shift+X, and Cmd or Ctrl+A, and Esc clears. `useBulk` (`apps/atlas/components/bulk`) loads the bar and its
  dialog with the first selection.

### 3. Undo, context menus and hover cards

- **Undo.** The session's undo stack (`apps/atlas/components/undo`) holds the tab's last 50 reversible actions.
  The registry's `undo` (Mod+Z) and `redo` (Mod+Shift+Z) shortcuts drive it; inside a text field the keys stay
  the field's own.
  - Every entry undoes through the server. A bulk change sends its inverse rows back through the same RPC, with
    `expect` set to the values it wrote, so an undo never overwrites a later change by someone else. Trash undoes
    by restoring the record.
  - A refused undo leaves the entry where it was and says why.
  - The shell shows the latest action's Undo toast for 8 seconds. Trash keeps its own toast, the A71 one that
    stays visible, and points it at the same stack entry.
- **Context menus.** Right-click, Shift+F10 or the Context Menu key on a DataTable row opens the row's actions:
  open, open as a page, copy link, select, and the bulk properties for that row. `ContextMenu` gains a point mode
  (`at`). The page opens it, so Radix's menu code loads on the first right-click instead of in the route.
- **Hover cards.** Hovering a record key, or focusing it, for 400 ms shows the record's title, state, owner and
  next date. An owner shows the person's role, membership and open records, read as the viewer. Cards load on
  the first hover and describe their cell while they show.
- **Shortcuts.** `undo`, `redo`, `list.select-range` (Shift+X), `list.select-all` (Mod+A) and `list.menu`
  (Shift+F10) are registered in `packages/schemas/shortcuts.yaml`. The list keys are fixed, because DataTable
  owns them. X obeys `singleKeyShortcutsEnabled()`.

## Consequences

- The IP allow-list limit of ADR 0034 decision 5 applies to the Realtime socket as it does to PostgREST: a valid
  session token reaches it directly. The planned fix, routing all data access through the API, would need a
  server relay for live updates.
- Each subscribed change costs Realtime one row level security check per subscriber whose filter matches. Pages
  therefore filter by org, project or record, and only the tables above are published.
