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

## Consequences

- The IP allow-list limit of ADR 0034 decision 5 applies to the Realtime socket as it does to PostgREST: a valid
  session token reaches it directly. The planned fix, routing all data access through the API, would need a
  server relay for live updates.
- Each subscribed change costs Realtime one row level security check per subscriber whose filter matches. Pages
  therefore filter by org, project or record, and only the tables above are published.
