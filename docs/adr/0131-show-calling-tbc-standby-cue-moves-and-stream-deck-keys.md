# ADR 0131: Show Calling: TBC Times, Standby, Cue Moves and Stream Deck Keys

- Status: Accepted
- Date: 2026-10-28
- Decider: Owner, through the competitor parity audit approved on 2026-10-28 (package P2, RRR-216; gaps G-40, G-74,
  G-75, G-77 and G-78)
- Migrations: `2790_start_tbc.sql`, `2791_calendar_feed_tbc.sql`, `2792_cue_standby_and_curfew.sql`,
  `2793_cue_move_and_nudge.sql`, `2794_cue_calls_save.sql`
- Amends: ADR 0040 item 5 (a TBC start is TENTATIVE)
- Cites: ADR 0103 (computed statuses), ADR 0068 (denormalization register), ADR 0110 (Trash), ADR 0031 (document
  template versions)

## Context

A stage manager runs a show from the running order (Section 4.2 Show, Section 4.3 item 9, journey 15). Before this
package the running order had no way to say that a time is still an estimate, it could not put the next cue on
standby, it reordered cues in three separate writes, nobody could nudge the remaining plan, the department calls stored
in `app.cue_calls` (1180) were shown nowhere, and the keyboard grammar stopped at F12, so a Stream Deck could not drive
the call. Atlas took the current cue by position and Compass by the latest call, so they could disagree.

## Decisions

1. **TBC is a flag beside a kept estimate.** `app.records.start_tbc` and `app.cues.start_tbc` default to false. The
   start time stays, so sorting, the timeline and scheduling keep using the estimate. A before trigger,
   `private.normalize_start_tbc`, clears the flag whenever the start column is NULL, so a writer that clears the time
   (the v1 API, an older client) never fails a check and never leaves a TBC without an estimate. Atlas is internal and
   shows "TBC · est. 7:30 PM"; Compass, Gateway and the run of show PDF show "TBC". `api_public.calendar_feed`
   returns a record with `start_tbc` and a start as `tentative`, which `@xos/data/ical` writes as
   `STATUS:TENTATIVE` at the estimate; Canceled still wins. This amends ADR 0040 item 5, where only Draft shifts and
   Proposed records were TENTATIVE. `api_external.cues`, `api_external.records` and `api_external.engagement_up_next`
   (`next_call_tbc`) append the flag, so Gateway's running order, set times, shared records and Up Next card never show
   a TBC time as firm.
2. **Standby is a stamped fact on the cue.** `app.cues.standby_at` holds when the caller put the cue on standby; the
   unique partial index `cues_standby_key` allows one uncalled standby per running order. `private.guard_cue` refuses
   a standby on a called cue (`cue_standby_called`) and, for a signed-in writer, a standby without `show.cue.call`
   (`cue_standby_capability`), and stamps the database time; clearing needs only the row's update policy.
   `app.standby_cue` moves the standby in one transaction. Go calls the standby cue. Skipped cues (uncalled cues
   before the latest called position) are computed, never stored.
3. **Moves and nudges are single-transaction definer functions.** `app.move_cue(cue, ordinal)` takes a 1-based place
   among the run's live cues, refuses a called cue (`cue_move_called`) and a place at or before the last called cue
   (`cue_move_before_called`), locks the run `for update` so concurrent moves serialize, parks only the rows whose
   position changes past the end and writes dense positions 1..n. Renumbering changes the cue numbers people see,
   since RunOfShowLive and the lists show the position. `app.shift_cue_plan(run, seconds)` moves the planned time of
   every live, uncalled, planned cue by up to an hour either way (`cue_shift_range`). A later cue bump extends this
   function rather than adding a second cue-shift function.
   - The showcaller may nudge: `app.shift_cue_plan` accepts `show.cue.call` as well as `show.run_of_show.write`. The
     registry's description of `show.cue.call` now says so ("Call cues live during a show: go, standby and nudging
     the remaining planned times"). The generator rewrites `0203_capability_seed.sql` for a fresh database, and
     `2793` updates the description where 0203 already ran, so no database drifts.
   - `app.save_cue_calls(cue, calls)` saves a cue's department calls in one transaction: a text value upserts the
     department's live call, NULL or blank soft-deletes it, departments left out are untouched, and a key that is not
     an `app.cue_call_kind` label is refused (`cue_call_kind`). The departments are read from the generated enum
     (`Constants.app.Enums.cue_call_kind`), never written out again.
4. **F13 to F20 join the key grammar, and function keys ignore me.shortcuts_enabled.** The registry gains the `show`
   scope with two groups: the keyboard family (Space, fixed and owned by RunOfShowLive; J, K, S, T, ], [ and D) and
   the Stream Deck family (F13 to F20, which a Stream Deck Hotkey action sends). Single character-key shortcuts obey
   me.shortcuts_enabled; function keys do not, because WCAG 2.1.4 Character Key Shortcuts covers character keys only
   (`isCharacterKey` in the grammar, `showKeyAction` in the console). The console answers keys only while focus is in
   it and not in a field or a dialog, and leaves Space to RunOfShowLive, so one press makes one call.
5. **The show clock, overrun and curfew risk are computed (ADR 0103).** `@xos/data/show-timing` derives current,
   next, standby, skipped and complete (`cueProgress`) and the show clock, overrun, planned and projected end and
   curfew risk (`showClock`, near within `CURFEW_WARNING_SECONDS` = 600) from the cue rows; Atlas and Compass run the
   same functions. The overrun ignores the plan of a TBC next cue. `app.run_of_show.curfew_at` is an input, not a
   derived value. No foreign key, array or counted column is added, so the ADR 0068 lints (pgTAP 1282) need no
   register entry, and no column that names a row is added to a soft-deletable table, so Trash membership is
   unchanged (ADR 0110).
6. **The public API v1 is unchanged in this release.** `start_tbc`, `standby_at` and `curfew_at` are not exposed in
   `packages/api/openapi/v1.json`; exposing them is an additive follow-up. The normalizing trigger keeps v1 writers
   that change `planned_at` or `starts_at` safe. `scripts/contract-audit` lists the three columns as `extra_column`,
   which is expected.
7. **The department choice is per device in Compass and per URL in Atlas.** Compass keeps `showDepartment` in
   `CompassSettings` (SecureStore); a stored value that is no longer a department reads as all. Atlas holds it in the
   page address as `dept=<slug>`, so a link can be shared. It is not a server setting.

## Alternatives

- A TBC status on the record or a NULL time with a note. Rejected: the time would leave the timeline and the sort, and
  ICS has TENTATIVE for exactly this case.
- A standby column on the running order. Rejected: the guard and the unique index keep the fact with the cue it names,
  and Realtime on `app.cues` already reaches every follower.
- Swapping neighbours in the client (the old `moveCue`). Rejected: three writes, a half-moved list for followers and no
  move to an arbitrary place.
- Letting function keys follow me.shortcuts_enabled. Rejected: a show caller who turns off character keys to avoid
  accidents would lose the Stream Deck, and WCAG 2.1.4 does not ask for it.

## Consequences

- Journey 15 keeps its "Call next cue" button and status lines; the console adds Go for the selected cue.
- The run of show PDF ships version 2 from 2026-10-31 (ADR 0031 decision 3): TBC in Planned, a Department calls
  column and the curfew; a show dated earlier re-renders with version 1.
- The Live Activity and the home screen widgets show a TBC next cue as text with no countdown and never skip ahead to a
  later cue; showing its TBC label beside a running shift on the lock screen needs a Swift change, left for later.
- Later packages that redefine `private.guard_cue`, `api_public.calendar_feed`, `api_external.cues`,
  `api_external.records` or `api_external.engagement_up_next` start from the definitions in 2790 to 2792.
