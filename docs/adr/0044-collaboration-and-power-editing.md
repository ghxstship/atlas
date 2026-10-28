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
  - The hub holds the token before any channel joins. realtime-js composes a channel's join message
    when the channel subscribes, while it fetches the token asynchronously. A channel subscribed
    first would join as anon: Realtime would refuse its filters and its private rooms.
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

### 4. Field history from the audit ledger

- **The query.** `app.field_history` (migration 1452) answers who changed which field of a row, when, and from
  what to what, from `app.audit_events`.
- **Who may see it.** The ledger itself still needs `audit.log.read`. The history of one row answers only someone
  who can read that row. `private.caller_reads_row` reads the subject table's own read policies from the catalog
  and evaluates them for the caller: permissive policies OR'd, restrictive ones AND'd, as row level security does.
  The history therefore follows the row exactly, with no second copy of any rule.
- **Masking.** A field classified Restricted shows as masked, with neither value, unless the caller holds its read
  capability. Actor IP addresses and user agents never leave the ledger.
- **Where it shows.** Records (page and peek) and SOPs show it on the DiffViewer, with names, states and times
  worded for people. `app.asset_units` gains an audit trail; `private.field_history_subjects` lists the tables.

### 5. Live co-editing: Yjs over a private Realtime channel, persisted in Postgres

- **Tables.** `app.doc_snapshots` holds one Yjs document per row and field (an SOP's procedure, a document's notes);
  `app.doc_updates` holds the updates since its snapshot (migration 1453). Presence is Realtime presence and is
  never stored.
- **Transport.** Editors broadcast each update on the private channel `doc:<doc id>`, so edits reach the room as
  they are typed. They also append each update through `app.append_doc_update`, so a reconnecting editor reads
  what it missed and a new one loads the snapshot plus the updates. A slow pull (15 s) covers a missed broadcast.
- **Authorization.** Who may read or write a document follows its row: the table's own read and update policies,
  evaluated for the caller. `realtime.messages` policies apply the same checks to the channel: receiving needs read
  access, broadcasting needs write access, and presence needs read access.
- **Persistence.** When the person pauses (3 s), the editor folds the updates into a snapshot
  (`app.compact_doc`). For an SOP, compaction also writes the text into `sops.body` through the row's own
  triggers, so readers, search, field history and publishing see the current text.
- **Changes made elsewhere.** A text changed outside the editor (the form, the API) reseeds the document in a new
  generation. Editors on the old generation are refused, and they reload.
- **Seeding.** An empty document is seeded from the row's text with a fixed Yjs client id. Two editors who open it
  at once produce the same update, and Yjs keeps one copy.
- **Loading.** Yjs, Tiptap and the room load only when someone presses Edit together, never with the page.

### 6. The channel rules on every environment, and the public API (A106, RRR-151)

_Amended 2026-10-23._

- **The channel rules.** `realtime.messages` belongs to Supabase Realtime, which creates it in its own tenant
  migrations as `supabase_admin`. Migration 1453 created the `doc:<doc id>` policies only where the table already
  existed. A local stack has it, because the CLI runs Realtime's migrations before ours. A hosted project whose
  Realtime has not started yet does not, and a Realtime upgrade that recreates the table drops its policies.
  - Migration 2060 lists the channel policies in `private.realtime_channel_policies`.
  - `private.ensure_realtime_channel_policies()` creates any listed policy the table lacks. It never drops or changes
    one that exists, and it does nothing until the table exists.
  - It runs in the migration, in the deploy path after `supabase db push` (`infra/runbooks/production.md`), and
    every minute from pg_cron (`xos_ensure_realtime_channel_policies`).
  - Until a rule is back, a join to that channel is refused, so a missing rule fails closed: editors keep working
    through the 15-second pull.
  - A later channel rule is one more registry row. To change a rule, a migration updates its row and drops the
    policy, and the function recreates it.
- **Not an event trigger.** Realtime runs its DDL as `supabase_admin`, a superuser. An event trigger created by
  `postgres` (which supautils allows) does not fire for a superuser's DDL; this was checked on a local stack.
- **Not 1450.** Migration 1450's condition is the `supabase_realtime` publication. The Postgres image creates it
  when the cluster is initialized, before any migration runs, and Realtime never recreates it.
- **Bulk edit in v1.** ADR 0023 allows additive operations within `/v1`.
  - `records`, `shifts`, `invoices` and `assetUnits` each gain `bulkPreview` and `bulkUpdate`
    (`POST /<resource>/bulk-preview` and `/bulk-update`) over the 1451 RPCs, with the same rows, answer and limit of
    500 rows.
  - Each resource's `set` and `expect` accept only the fields that change in bulk, so a mistyped field is a 422
    rather than a row that silently does not change.
  - A refused row answers 200 with `committed: false` and the row in `refused`. The call itself was valid, and the
    frozen problem shape has no place for per-row rules. A refusal of the whole call (a duplicate row) is a 422.
- **Field history in v1.** The eight field history subjects (records, shifts, invoices, asset units, SOPs,
  documents, purchase orders and vendors) gain `fieldHistory` (`GET /<resource>/{id}/field-history`).
  - It answers one entry per audit event with its changed fields, newest first.
  - It reads `app.field_history_events` (migration 2061), which groups `app.field_history`'s rows into one row per
    event with its changes as a JSON array. `app.field_history` answers one row per changed field while its limit
    counts events, and PostgREST caps every answer at `max_rows` (1,000) without an error, so a long or busy
    history lost its oldest events, or the last event lost some of its changes. With one row per event, `limit`
    and `max_rows` count the same thing. Atlas's history tab reads it too.
  - It is a page whose `next_cursor` is always null: `limit` (at most 1,000 events) bounds it.
  - A row the caller cannot read answers 404.
- **Compare-and-set on instants.** A bulk row's `expect` was compared with the row as JSON, and a stored instant
  reads back as `+00:00`, so an integration that sent the same instant with `Z` was refused as `bulk_stale`.
  Migration 2062 makes `private.bulk_check_expect` treat two full ISO 8601 timestamps with an offset as equal when
  they name the same instant. A date alone, a timestamp without an offset and any other text still compare
  exactly.
- **Co-editing in v1.** v1 has no operation that writes a live document or joins its room.
  - Yjs updates travel over the private Realtime channel, and only a Yjs client can merge them; a REST write
    would bypass the merge.
  - An integration that changes a co-edited field writes the row instead (`sops.update` for an SOP's procedure).
    The next open reseeds the document in a new generation, as any change made outside the editor does.
  - `documents.notes` reads a document's notes as plain text, as last saved. Notes are the one co-edited field
    whose text lives only in the snapshots; an SOP's procedure is already in `sops.get`.

## Consequences

- The IP allow-list limit of ADR 0034 decision 5 applies to the Realtime socket as it does to PostgREST: a valid
  session token reaches it directly. The planned fix, routing all data access through the API, would need a
  server relay for live updates.
- Each subscribed change costs Realtime one row level security check per subscriber whose filter matches. Pages
  therefore filter by org, project or record, and only the tables above are published.
