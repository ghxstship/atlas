# ADR 0083: Live Lists, a Realtime Dispatch Board, and Presence on Records

- Status: Proposed
- Date: 2026-10-27
- Decider: Orchestrator; built and recorded by A123 (RRR-168)
- Resolves: trace rows S11.7-10 (presence and live Atlas lists) and S11.11-01 (the dispatch board part); follows
  ADR 0044

## Context

ADR 0044 made Atlas lists and records for records, shifts, invoices, asset units and SOPs update live over one
Realtime channel per page, and gave co-edited documents presence inside the open editor. The other Atlas lists still
read only on navigation, the dispatch board re-rendered on the server every two seconds whether anything changed or
not (Section 11.11: a new incident visible to dispatch in under 2 s), and nobody could see who else had a record
open.

Two constraints from ADR 0044 still hold: the route JavaScript budget (Projects is a few dozen bytes under 200 KB),
and the page holds only the short-lived access token `/auth/realtime` hands it.

## Decision

### 1. Live lists: the page server component declares its tables

- Migration 2170 adds the tables behind the projects, procurement (purchase orders and their lines, receipts, RFQs),
  vendors, work orders, advancing (packets, submissions) and people (memberships, role assignments, requisitions,
  agreements) lists to the supabase_realtime publication. The logistics lists and the dispatch board follow tables
  published before (0440, 0470).
- `LiveList` (`apps/atlas/components/live/live-list.tsx`) is a server component the page renders with its tables. It
  resolves the org from the request's cached context and renders `LiveRefresh` narrowed to `org_id=eq.<org>`.
- It goes in `app/[org]/**/page.tsx`, not in the collection components, which other packages edit (A119 to A121).
- `apps/atlas/test/live-lists-presence.test.ts` fails when a page's `LiveList` names a table no migration
  publishes.

### 2. The dispatch board moves from polling to Realtime

- The board follows `incidents` and `dispatch_assignments` of the org with `LiveRefresh`.
- Its pacing is a 100 ms batch and at most two rereads a second, up to one every 4 s while changes keep coming.
  The default list pacing (a reread at most every 2 s) would miss the target.
- The interval refresher in `components/operations/peek.tsx` had no other user and is removed. A quiet board no
  longer rereads every two seconds.

### 3. Presence: one private channel per row, joined only by its readers

- **The channel.** A record page, peek or document joins `presence:<table>:<row id>` on the tab's live hub and
  tracks the person's id and name. Presence lives in Realtime's memory, never in the database (Section 7.3).
- **Who may join.** `private.presence_subjects` lists the tables that show presence: records, documents, SOPs,
  incidents, purchase orders, receipts, RFQs and vendors.
  - `private.presence_can_join(topic)` admits the caller only for a listed table and only when they can read the
    row. That is 1453's rule, through the table's own read policies (`private.caller_reads_row`).
  - Two policies on realtime.messages apply it: receiving needs it, and so does tracking presence. Nobody may
    broadcast on a presence channel.
  - A non-reader is refused at the join. The channel never tells them who is looking at a row, or that the row
    exists.
- **Every environment.** When 2060 (A106) has created `private.realtime_channel_policies`, the two policies are
  rows of it, so its pg_cron job recreates them if Realtime recreates its table. Without that registry they are
  created directly, as 1453 created the document channel policies.
- **The view.** `PresenceFor` (server) resolves the signed-in person and renders `RecordPresence`. That tiny client
  wrapper loads the room on demand (`components/shell/on-demand.ts`, ADR 0027). The room shows the others with the
  `AvatarStack` of `packages/ui` and a count ("1 other person here"). It shows nothing while the person is alone,
  offline or refused. A person with two tabs open counts once, and the viewer is never listed.
- **Where it shows.** On the work record page and its peeks (`RecordBody`). On the document and SOP pages and peeks.
  On the incident record. On the purchase order, receipt, RFQ and vendor pages and peeks.

## Consequences

- The listed pages update without a reload. The dispatch board updates within its pacing of a change instead of
  polling, and costs nothing while quiet.
- Each newly published table adds Realtime work per change, filtered per subscriber by row level security, as for
  1450's tables. Deletes are soft (an update of `deleted_at`), so Realtime can still check them against the read
  policy.
- Presence adds one private channel per open record to the tab's existing socket. The room code loads after the
  page, so no key page carries it.
- Gateway's lists are A122's. Presence on more record kinds is one row in `private.presence_subjects` and one
  `PresenceFor` in the page.

## Verification

- pgTAP `supabase/tests/2170_live_lists_and_presence.test.sql` covers publication membership and row level
  security on every new table. It also covers the join rule: a Manager and a project's Field member may join a
  record's channel, while a Member outside the project, a Viewer in no project and another org may not. The
  realtime.messages policies are applied as Realtime applies them: a non-reader receives nothing and cannot track
  presence, and nobody broadcasts.
- `apps/atlas/test/live-lists-presence.test.ts` checks the pages' tables against the publication, the presence
  tables against the registry, and the presence list (one entry per person, the viewer left out).
- `apps/atlas/e2e/a123-live-presence.spec.ts` uses two browser contexts each time. Two people see each other on a
  record page and on an SOP peek, and the avatar goes when one leaves. The dispatch board shows a newly reported
  incident without a reload, and the RFQ list shows another person's new RFQ.
