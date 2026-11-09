# ADR 0119: Cue Calls Shown From the Realtime Row

- Status: Accepted
- Date: 2026-10-28
- Decider: A145 interaction latency and workflow timing (RRR-208)
- Migrations: none; amended by `6900_show_call_broadcast.sql`

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

## Amendment 2026-11-09: each call is broadcast to its running order

The follow-up this record left open (RRR-243). Migration 6900 sends each call from the database to the running order's
private channel `show:<run id>`, so it no longer waits for Realtime's change poll.

- A row trigger on `app.cues` (`t97_broadcast_cue_called`, and `t97_broadcast_cue_called_insert` for a cue inserted
  called) sends one `called` message with the cue's id and `called_at` through `realtime.send`, as the `cue.called`
  events fire (6243). Realtime reads `realtime.messages` from its replication stream, not by polling. Sending never fails
  the call: without Realtime, or without a partition of `realtime.messages` for today, the call goes on and devices hear
  it from the Postgres change or their 15-second pull.
- `private.show_channel_can_join(topic)` lets a signed-in person join `show:<run id>` when they can read the running
  order through its own read policies (`private.caller_reads_row`), and its cues with it. The rule
  `xos_show_channel_read` is a row of `private.realtime_channel_policies` (2060, 3782), for authenticated, receiving
  only. Only the database sends.
- Show mode (`LiveCues`, now `apps/atlas/components/show/live-cues.tsx`) joins the channel beside its Postgres change
  watch and hands either one's call to the same heard calls, whichever comes first. Decision 2 is unchanged: the reread
  stays the source of truth, and the Postgres change still drives it (ADR 0044).
- The journey is on again, with its body unchanged except that the second device also waits until it has joined the
  show channel. The `test.fixme` is gone.

Measured on 2026-11-09 on production builds (`next start`, as CI's journeys run) against a local stack, six calls per
run, the slowest deciding each run:

| Machine load (1 min average) | Runs | Calls | Median | p90    | Slowest |
| ---------------------------- | ---- | ----- | ------ | ------ | ------- |
| about 5                      | 6    | 36    | 117 ms | 128 ms | 133 ms  |
| about 14, ten busy loops     | 5    | 30    | 127 ms | 138 ms | 233 ms  |

The other device's socket now receives the call within about 2 ms of the caller's own answer, so what remains of the
span is the caller's call round trip (the server action and `app.call_cue`). Under `next dev` the same journey measured
903 ms for its slowest call, all of it the development server's own slower action; CI does not run journeys there.
