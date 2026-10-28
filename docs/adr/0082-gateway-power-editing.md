# ADR 0082: Power Editing in Gateway

- Status: Accepted
- Date: 2026-10-24
- Decider: Orchestrator; built and recorded by A122 (RRR-166)
- Resolves: the Gateway parts of trace rows S11.7-01, S11.7-03, S11.7-04, S11.7-09 and S11.7-10 (finding A65-006),
  and A88's follow-up that Gateway lists do not update live

## Context

ADR 0044 gave Atlas live lists, selection, bulk edit, an undo stack and row menus. Gateway had none of them. Its
collections (`apps/gateway/components/page/collections.tsx`) opened rows and did nothing else, and every action
was one button on one row.

Gateway differs from Atlas in two ways that shape this:

- **An external person acts only on their own side.** They sign documents sent to them, submit their own
  timesheets and withdraw their own applications. They never change an org's property, so Atlas's "change a
  field" dialog does not apply.
- **External people read engagement data only through `api_external` (Section 8.7).** Some tables behind
  Gateway's lists are readable by them under row level security (their timesheets, their engagements' documents,
  their applications). Others are not: engagements, invoices and payments stay closed, because their rows carry
  internal columns.

## Decision

### 1. Bulk actions are the row's own actions, through 1451's driver

- A Gateway list offers the action its rows already offer: Sign on Documents, Submit on Timesheets, Withdraw on
  Applications. The bulk bar applies it to the selected rows it fits and says how many it leaves out.
- Migration 2160 adds three resources to `private.bulk_resources`: `my_timesheets`, `my_engagement_documents` and
  `my_applications`, with thin RPCs `app.bulk_update_my_*`. Each row function does three things:
  - it checks the person's reach the way the single action does (`private.engagement_scope`,
    `private.my_application_ids`);
  - it calls the single action's own RPC, so every rule of a single action holds in bulk;
  - rows outside the person's reach read as not found.
- `private.run_bulk` is reused unchanged. A118 redefines it in 1770 on its own branch, so redefining it here would
  silently drop one change or the other. A call is all or nothing, previews first, and refuses rows by name.
- Its audit event (`<resource>.bulk_update`, one per org) is fine here, because each org already sees each
  submission, signature and withdrawal. Saved and passed opportunities stay out of bulk: the org must never learn
  who saved its listing, and the driver writes to the org's ledger.

### 2. Undoing a submit recalls the timesheet

- A signature and a withdrawal are final. Their dialogs say so before they apply, and their outcome is a notice,
  not an undo entry.
- A submit is undone by a new rule: the person who submitted a timesheet may recall it while it is still Submitted
  (Submitted to Proposed, a transition that already existed). A recall always lands on draft. A worker cannot put
  back an approver's Rejected, so the inverse row of a submit from Rejected names Proposed. Compare-and-set refuses
  the undo once an approver decided.

### 3. One undo stack module for both shells

- `createUndoStack` moves from Atlas to `@xos/ui/undo`. Atlas's components import it from there; Atlas keeps
  `components/undo/undo-stack.ts` as a re-export for code that still names that path, such as A118's. Each app
  bundle holds its own stack.
- Gateway's frame answers Mod+Z and Mod+Shift+Z outside text fields. The shortcut registry lists both for
  Gateway, and an `UndoCenter` shows the 8-second Undo toast and the outcome notices.
- Explore's swipe actions that hide a row (Pass, Remove from Saved, removing a saved search) also go on the stack,
  so the keys work there too. Saved's Remove now removes by listing, which makes redo after undo safe.
- `UndoToast` now leaves Shift+Mod+Z to redo and Mod+Z inside a text field to the field. This fixes Atlas too. It
  tells a field by `:read-write` (editable inputs, text areas and content-editable elements), which costs a few
  bytes on Atlas's Projects page, then 5 bytes under its 200 KB budget.

### 4. Row menus

Right-click, Shift+F10 and the Context Menu key open a row's menu: Open, Copy link, Select and the list's action.
This is A88's `useRowMenu`, ported with Gateway copy.

### 5. Live updates: publication entries and a personal channel

- **Publication entries (2161).** These tables join `supabase_realtime`: `engagement_documents`, `timesheets`,
  `applications`, `offers`, `tax_forms`, `saved_opportunities` and `passed_opportunities`. Their row level
  security already confines an external person to their own rows, and Realtime applies it to every change with
  the subscriber's JWT. Gateway pages narrow each subscription to the person or to the engagements the page shows.
  Above 40 engagements the subscription goes unfiltered, and row level security alone confines it. Realtime's
  `realtime.messages` channel rules do not apply to `postgres_changes`; the table's policies are the rule there.
- **A personal channel for tables that stay closed.** Engagements, invoices and payments cannot be published to
  external people. A statement trigger on each pings the private channel `gateway:<person id>` of the people on
  the changed rows' side:
  - the engaged or paid person;
  - members of the engaged account (for money, only its Owners, Admins and Finance members);
  - an artist's representatives.
- **What a ping carries.** Each ping holds only the table's name. The page then rereads through its projection,
  which decides what the person sees. The audience may therefore be a superset of who reads the row without
  leaking anything. That avoids restating the Section 8.7 helpers in reverse, which would drift.
- **The channel rule.** A policy on `realtime.messages` lets each person receive only on their own channel:
  `realtime.topic()` must equal `gateway:<their person id>`. Nothing but the triggers sends on it.
  - Where A106's registry of channel rules (`private.realtime_channel_policies`, 2060) exists, the rule is
    registered there, so it is restored on every environment.
  - Otherwise 2161 creates it when Realtime's table exists, as 1453 did.
- **Pings never fail a write.** Without Realtime, or without a partition of `realtime.messages` for today, the
  ping is skipped.
- **The client.** Gateway ports Atlas's `/auth/realtime` route, hub loader and `LiveRefresh`. Its Content Security
  Policy allows the Realtime socket's origin. Channel pings are paced like the hub's batches (300 ms to gather, at
  most one reread every 2 s), and a rejoined channel rereads once.
- **`in` filters.** `useLive` keyed its topics by joining them with commas, which split an
  `engagement_id=in.(…)` filter of more than one engagement into broken topics. Topics are now joined by a line
  break, which no filter holds.

## Alternatives considered

- **A marks table** (`subject_table`, `subject_id`) published with row level security that asks each
  `api_external` view whether the caller sees the row. This gives an exact audience and uses one channel. It was
  rejected because it adds a table that grows with every changed invoice, payment and engagement, and its policy
  would run a heavy projection per change per subscriber.
- **One channel per engagement**, authorized by `private.engagement_scope`. This is exact and needs no audience
  query, but an account with many engagements would join dozens of channels, near Realtime's per-client limit.
- **Postgres changes on a private channel** with a channel rule. This adds no protection over row level security
  for published tables. It would also fail closed wherever the rule is missing.

## Consequences

- Gateway's tables select, take their action in bulk, open row menus, undo a submit with Mod+Z, and update live.
  List and card views (Explore, Messages) do not select, though A115's `RecordList` selection would allow it: Save
  and Pass stay one at a time (above), and a thread is marked read by opening it.
- The recall rule is new: a worker can take back a submitted timesheet until it is decided.
- Once A106 merges, its 2060 sorts before 2161, so the rule `xos_gateway_channel_read` lands in its registry wherever
  both run.
