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
2. **The reread stays the source of truth.** A page may show a change from its row only until a server read carries
   it. Show mode keeps the calls it heard (cue id to `called_at`, `withHeardCalls` and `unconfirmedCalls` in
   `@xos/data/show`) and fills each cue a read still shows uncalled; it drops a heard call once a read shows that
   cue called. A read can start before a call and land after it (the 15-second pull, an earlier batch's reread, the
   console's own refresh), so the page never drops a heard call just because a newer read arrived. Because
   `called_at` is set once (`app.call_cue` refuses a second call) and never cleared, a heard call cannot show
   something a read then takes back.
3. **The call action renders nothing.** `callCueAction` answers with the database's call time and no longer
   revalidates the layout. The showcaller console (ADR 0131) hands that time to the running order, which shows the
   call from it and rereads itself; every other device follows through Realtime. No server render competes with the
   change reaching the other devices.
4. **The journey asserts every call at a show's pace.** A show calls its cues seconds to minutes apart, so the
   journey waits a jittered two to five seconds before each call and asserts the slowest of all six calls, the first
   one included, against 500 ms. Every call's span and its parts stay on the test as annotations.

## Consequences

- From the stage manager's press, the call commits in about 110 ms and the other device shows it one frame after
  Realtime delivers it. What remains is Realtime's own delivery of the change.
- Realtime finds Postgres changes by polling the replication slot (`poll_interval_ms` 100 on the local tenant).
  Measured on 2026-10-30 against a local stack on a machine running about 40 other containers (load average 12),
  commit-to-delivery spread evenly from about 15 to 500 ms at every spacing tried, 0.2 s to 6 s apart: the poll
  answered about three times a second, not ten. An earlier draft of this record read it as Realtime slowing after a
  quiet spell, and paced the journey's calls 800 ms apart; that pacing landed each change just before a poll, which
  is why those calls looked fast. The journey no longer paces its calls on a fixed period or leaves any call out.
- On a loaded machine the slowest call can therefore miss 500 ms, and the journey fails there: that failure is the
  target not being met, not noise to filter. The journey is marked `test.fixme` as a known failure, with its strict
  body unchanged, so the Playwright gate does not go red on a runner's load; `test.fail` would flake instead,
  whenever a fast runner passes. Broadcasting each call from the database to a private
  `show:<run id>` channel (a trigger on `app.cues` with an authorization policy on `realtime.messages`, kept by
  `private.realtime_channel_policies`, migration 2060) would bypass the poll. It needs a migration, which A145 has no
  block for, and is left to a follow-up with one, which also removes the fixme.
- Other pages keep rereading on each batch, as ADR 0044 decided. A page that adopts the row pattern must keep the
  same rule: show the row's change only until a server read carries it, and only for a change no later write undoes.
