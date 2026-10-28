# ADR 0111: A Timeline Reschedule Pushes Successors by What It Adds

- Status: Accepted
- Date: 2026-10-28
- Decider: A133 (RRR-195), Section 11.11 (S11.11-01, timeline drag with a dependency preview)
- Migrations: 2260

## Context

Section 11.11 asks for a reschedule by drag on the timeline that shows, before anything is written, which successors
move and whether the critical path changes, in fewer than three interactions. Records carry their own dates
(`starts_at`, `ends_at`, `due_at`); dependencies (`app.record_dependencies`, migration 0310) carry a type and a lag
but have never moved anything. Dates in a project are read on the project's calendar, and some schedules already
break a dependency before anyone drags a bar. Timeline windows locked into a baseline (`record_timeline`,
`baseline_locked_at`, migration 0412) are meant to stay put.

## Decisions

### 1. One function, two modes

`app.reschedule_record(record, start days, end days, commit, reason)` computes the change. Preview mode returns the
record and every record it moves, with old and new dates and the latest baseline window, and writes nothing. Commit
mode runs the same computation under a per-project lock and writes every moved record in one transaction. The pgTAP
suite holds the two equal, so what the preview showed is what lands. It needs `schedule.timeline.write` on the
project.

### 2. Whole days of the project's calendar

Moves and resizes are whole days, applied on the project's wall clock (`private.add_local_days`), so a 10:00 start
stays at 10:00 across a daylight saving change. The timeline draws days, so a drag is a count of days.

### 3. Push only, and only by what the change adds

A successor moves only when the change makes one of its dependencies tighter than it was, and then by the fewest
whole days that restore the gap it had. A dependency already broken before the change keeps its gap rather than
being repaired by an unrelated drag, and moving a record earlier never pulls a successor with it. Pushes run round by
round through the whole downstream chain; Finish to Start, Start to Start, Finish to Finish and Start to Finish each
compare the predecessor's start or finish plus lag with the successor's start or finish.

### 4. What is refused

A cycle downstream of the record (the insert guard keeps cycles out, and the function checks again), a move of a
record that is Complete or of a Timeline window locked into a baseline, or a change that would push one; a window
that would end before it starts; a resize of a record with one date; and an undated record. Preview and commit
refuse the same way. Canceled records neither move nor hold others back. Baselines are never written.

### 5. The browser estimates; the server decides

`@xos/ui` Timeline works out the same push rule on its day grid from the drawn dependencies while a bar is dragged,
and reports the critical path (rows with no float to the last finish) before and after. When the pointer or keys
rest, Atlas asks the function for its preview, which also sees dependencies to records the view filters out, and that
answer replaces the estimate. Apply calls commit mode.

## Consequences

- A drag and Apply, or arrows and Enter, reschedule a record and its chain; the preview names the successors that
  move, whether the critical path changes and how far the last finish moves.
- The critical path is computed in the browser from the drawn rows; no column stores it (Section 3.15).
- A schedule with broken dependencies stays as broken as it was after a reschedule; repairing it is a separate edit.
