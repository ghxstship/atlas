# ADR 0063: Shift Templates, Members' Availability and the Crew Drag Board

- Status: Proposed
- Date: 2026-10-28
- Decider: A132 (RRR-194), for the orchestrator's review
- Addresses: trace rows S4.5.6-25 (Org settings 25 Scheduling) and S11.11-01 (the crew fill part); Section 11.13
- Migrations: 2250 and 2251 (range 2250 to 2259)

## Context

Section 4.5.6 item 25 lists shift templates, open-shift claiming, swap rules and availability under Scheduling. A76 (migration 1322) made claiming and swapping take effect; templates and availability had nothing behind them. Section 11.11 asks that crew fill be quick: planners staff a week from the people most likely to take each shift and see how much is staffed.

Availability calendars existed (0740) for Gateway people only: a person's own calendar, or one "kept for one org's bookings" (`org_id` set; ADR 0019 item 10, accepted as person-owned rows by ADR 0033 decision 69). Planners in the org could read one only through an application or an open engagement.

## Decision

1. **Templates are an org table, not a setting.** `app.shift_templates` holds a name (unique in the org, ignoring case), a canon role or none, call and wrap times without a date, a headcount of 1 to 50 and a scheduled break shorter than the shift. A wrap at or before the call ends the next day, so overnight load-outs need no second field. Members read them; holders of `org.scheduling.write` (owner and admin) write them, from a panel on Settings, Scheduling (`contributions/a132.tsx`). Trash keeps them recoverable; shifts already planned do not point back at a template, so removing one changes nothing planned.
2. **Planning from a template is one RPC.** `app.create_shifts_from_template(template, project, days)` needs `crew.shift.write` on the project and plans `headcount` open Draft shifts per day, at most 31 days, with the template's role and break, reading the times in the project's zone. It creates all of them or none. The shifts are ordinary open shifts: publishing, claiming and swapping keep the 1322 rules unchanged.
3. **Members' availability lives on the calendar they keep for the org.** No new table: a member's periods go on their `availability_calendars` row with `org_id` = the org, opened by `app.ensure_member_availability_calendar` (members only), and stated from Me, Work details. `private.availability_shared_with_me` (redefined from 0740) adds one clause: while the owner holds an active membership, the org's planners (`crew.shift.write` on any of its projects) read that calendar and its periods, whatever its visibility. A calendar kept for one org is that org's to see; visibility keeps governing general calendars and Gateway people's org calendars as before. Notes stay the owner's; planners read only period and kind (`api_external.availability`, `app.rank_shift_candidates`).
4. **The availability window is three org settings** (`packages/schemas/settings/a132.yaml`): `scheduling.availability_required` (off by default), `scheduling.availability_notice_days` (7) and `scheduling.availability_horizon_days` (28). While required, a member's periods that start inside the notice period are locked against adding, changing and removing (`availability_inside_notice`, trigger on `availability_blocks`); notes stay editable and the platform is not refused. The horizon is how far ahead members state it: `app.my_availability_status` lists the unstated days between the notice and the horizon for the member, and the ranking marks a member overdue when nothing is stated for a shift inside the horizon. The settings are organization-scoped only, since availability belongs to the member and the org, not to one project.
5. **Ranking is in the database.** `app.rank_shift_candidates(shift, week_start)` ranks the org's active members for one shift: free of an overlapping live shift first, then stated availability over the shift (Available covering it, then Tentative or partly stated, then not stated, then Unavailable), then whether they worked the role before, then the fewest scheduled minutes in the schedule's week. It needs `crew.shift.write` on the shift's project. Overlap is a ranking signal, not a refusal: the schedule already marks double bookings, and claims refuse them (1322).
6. **The drag board loads on demand.** On the resource schedule, planners get a board (`components/crew/scheduling-board.tsx`, through `lazy-scheduling.tsx` and next/dynamic) with the week's open shifts and the people ranked for the chosen shift. Dragging a person onto any open shift assigns them (the existing shift update, under `crew.shift.write`); from the keyboard, a planner chooses a shift and presses Assign on a person. Each assignment is announced in a live region, and the fill-rate meter (`role="meter"`, filled live shifts over live shifts) moves at once before the page rereads; live updates (ADR 0044) bring other planners' changes. Readers see the same meter, server-rendered. `/crew/shifts` is a key page, so none of the board ships with it.

## Consequences

- Section 4.5.6 item 25 is whole: templates, claiming, swaps and availability are each stored, edited from Settings, Scheduling and enforced.
- The crew fill target of Section 11.11 has its tool; a timed measurement belongs with the other timed journeys (gate 26).
- Compass still shows no availability editor; members state it in Atlas. A Compass screen can reuse `app.ensure_member_availability_calendar` and the blocks table as they are.
- A later package that wants templates to remember their shifts can add a nullable `shift_template_id` to `app.shifts` without changing anything here.
