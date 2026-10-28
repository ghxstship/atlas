# ADR 0119: Cue Calls Shown From the Realtime Row

- Status: Accepted
- Date: 2026-10-28
- Decider: A145 interaction latency and workflow timing (RRR-208)
- Migrations: none

## Context

Section 11.11 sets the Show target: "Cue sync to every connected device in under 500 ms". A145's timed journey
(`apps/atlas/e2e/a145-workflow-timing.spec.ts`) measures it inside two browser contexts on one show run, from the
stage manager's press of Call next cue to the first frame that shows the cue on the other device.

Before this decision, the span was about 450 to 870 ms on the local stack:

- the call action wrote the cue, then rerendered the whole layout (`revalidatePath`), so the caller saw the call
  after 200 to 470 ms;
- the other device heard the change through Realtime (ADR 0044), waited for its 30 ms batch, then reread the whole
  page with `router.refresh()`, about 300 ms more, before anything changed on screen.

The changes Realtime delivers already carry the row, checked against row level security with the subscriber's own
token (ADR 0044, item 1). A cue is called once: `called_at` is set by `app.call_cue` and never changes again
(`0412_show_schedule_operations.sql`).

## Decisions

1. **A live change carries its row.** `@xos/data/live` hands a watcher's listener the row of an INSERT or UPDATE as
   Realtime sent it (`LiveChange.row`), the latest one when a batch holds several changes to the same row. A DELETE
   and a `RESYNC` carry none. Nothing new reaches the browser: the hub passes on what the socket already received.
2. **The reread stays the source of truth.** A page may show a change from its row only until its next server read
   lands. Show mode keeps the calls it heard (cue id to `called_at`) beside the server's progress they were heard
   against, and drops them as soon as a newer server read arrives. Because a call never changes once made, a heard
   call cannot show something the reread then takes back.
3. **The call action renders nothing.** `callCueAction` answers with the database's call time and no longer
   revalidates the layout. The caller's page shows the call from that time and rereads itself; every other device
   follows through Realtime. No server render competes with the change reaching the other devices.

## Consequences

- On the local stack the running cue sequence now syncs in about 200 to 230 ms: about 110 ms to the call's
  commit, about 70 ms for Realtime to deliver it, and one frame to show it. The journey asserts the median of the
  sequence's calls under 500 ms and keeps every call on the test as an annotation.
- The first call after a quiet spell of a few seconds still takes up to about 650 ms. Realtime finds Postgres changes
  by polling, and it polls less often while nothing changes, so the change waits in the database for up to half a
  second. The application cannot shorten that wait. Broadcasting each call from the database to a private
  `show:<run id>` channel (a trigger on `app.cues` with an authorization policy on `realtime.messages`) would
  bypass the poll; it needs a migration and is left to a follow-up. Until then the journey keeps that call's span
  and its parts, unasserted.
- Other pages keep rereading on each batch, as ADR 0044 decided. A page that adopts the row pattern must keep the
  same rule: show it only until the next server read.
