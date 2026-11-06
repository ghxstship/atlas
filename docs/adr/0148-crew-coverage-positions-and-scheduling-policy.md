# ADR 0148: Crew Coverage, Project Positions and Scheduling Policy

- Status: Accepted
- Date: 2026-11-06
- Decider: B9 (RRR-233), parity gaps G-118, G-119, G-121, G-123, G-127 and G-131, approved in the competitor parity triage
  of 2026-10-28
- Migrations: 2980 to 2989

## Context

Planners needed to know what is not covered yet, to ask crew whether they are still coming, to plan shifts and records
against a seat before anyone holds it, to record that someone did not arrive, to see rest and hour warnings before
assigning, to define breaks that are paid or unpaid, and to report on all of it. These sit beside the shift lifecycle
(0460) and API v1, which is frozen.

## Decisions

### 1. A no-show is an outcome record

`app.shift_no_shows` records it. It is not a `shift_state` value, so the frozen label and every lifecycle reader stay
unchanged. While a no-show is live the shift's worker, times and any state but Canceled refuse `shift_no_show_frozen`,
and that rule lives in one trigger. Its id is the client's, so Compass's offline replay and an external lead's retry are
recognized. A person who did not create the row and may not mark the shift gets 42501 on a replay, so an id is no
existence oracle.

### 2. Offers and reconfirmations are one fact table

`app.shift_responses` holds each ask of one person about one shift and its answer. It is the source for "Still coming?",
the shortages page and the invitation responses report. It is a fact table, not a lifecycle, so B9 declares no new
lifecycle; the shift lifecycle already allows Accepted to Published. Two invariants hold: a live shift has a Waiting Offer
exactly when it is Published with a worker person (a claim reaches Accepted in the transaction that placed the person),
and a Waiting Reconfirmation exists only on an Accepted shift. An ask that ends any other way than through the
notification (answered on the record or the API, No Answer from the job, Withdrawn by the trigger) retires its
notification, so it never falls into Gateway For Your Information or the Atlas Inbox, and its email link reads as used.
Someone who took the shift by a swap approved inside the window is not asked. Once a shift has started the ask cannot be
answered, so a late decline can never reopen a running shift.

### 3. A position is a project-scoped seat filled later

`app.project_positions` is filled by exactly one member or one roster entry. Filling resolves its open shifts to the
holder. Record assignments resolve to `app.record_assignments` for a member and stay on the position for a roster holder,
since records assign only to memberships (0310). Assigning a record to a position (`work.record.write`) is the
authorization that filling resolves, so a `crew.shift.write` filler needs no `work.record.write`, and
`api_external.position_records` extends title, kind, state and dates to holders and agency leads on that basis. Engaged
individual freelancers do not hold positions. Positions are distinct from `app.opportunity_positions` (0720) and from
Gateway's `engagement.positions` tab, which lists agency slots.

An unfilled position's shifts cannot go to a member or to another agency's staff. Within its own roster an agency's
placement stays R12's: the agency may place any accepted person of that roster on the slot, because Gateway's per-shift
placement depends on it. Filling covers shifts not yet ended; vacating covers shifts not yet started, and removes only the
assignments filling made. A position keeps its agency and project while a live shift or record assignment names it, and a
shift with waiting claims is not put on a position.

### 4. Break types are data on the Break Start punch

`app.punch_kind` keeps its four values. A paid break is worked time: its minutes go to
`app.time_entries.paid_break_minutes` and are never subtracted, so every formula that subtracts `break_minutes` (0340,
0461, 0463, 0940, 1384, 1385, 1386, 1398, 1399, 2271, 2751 `private.worker_minutes`) is correct unchanged. Corrections
(0340 `proposed_break_minutes`) change `break_minutes` only. Like `break_minutes`, the new column is a running tally of
punches and is not in the denormalization register.

### 5. Standard crew reports are code-defined

The five reports are definitions in `packages/data` over four new sources. An org saves its own editable copy; nothing is
seeded per org. Each source is an owner-rights view with its own row filter, so `app.report_run_rows` reads them as the
run's person.

### Names on crew lists

A definer read never widens a role check. A roster person's name comes only through `advancing.packet.read` (2637), so
`private.may_read_worker_name` gates every name on `app.crew_shortages` and the report sources, and the
`shift.reconfirm_declined` message omits a roster person's name for a creator without that capability.

## Also recorded

- The warnings are shown to planners in Atlas and to a person about themself; agency leads placing staff in Gateway do not
  see them in B9. They are org scheduling policies, never refusals and never pay rules. State overtime and state break and
  meal rules stay deferred (ADR 0033 decision 54, trace S14.5-05, ADR 0041), and `app.calculate_payroll_run` is untouched.
- `scheduling.max_daily_hours` is an assignment warning over scheduled shift minutes, off at 0. B4's
  `scheduling.workload_day_hours` is a heatmap threshold, a separate setting. Overlap stays A132's conflict flag.
- Week warnings use `payroll.week_start`; the board's `week_minutes` (2251) uses the ISO week. A shift's minutes count on
  the day it starts, in its own time zone.
- Reopening relies on the existing open-shift surfaces and 1322's claiming rule: no broadcast notification is added.
- Positions, break types, shortages and report sources have no v1 operations in this package. `paid_break_minutes` is not
  added to the `timeEntries` v1 shape, because hours are clock span less `break_minutes` either way. API v1 gains two
  additive actions (`shifts.markNoShow`, `shifts.reconfirm`) and one correction (`shift-swap-reason`).
- In Atlas a member answers "Still coming?" from push, the email link or the shift record; Needs You for it is Gateway
  only.
- The Staff journey's roster-staff tab set gains `engagement.positions` (ADR 0100 amendment), since that tab is where a
  roster holder reads their position's records.
- Compass's `shift_no_shows` and `break_types` are REST only (ADR 0033 decision 51). The device never holds a no-show's
  reason. External break types scope through `DownloadScope.engagedOrgIds`, because an engaged context has no `orgIds`.
- `app.rank_shift_candidates` order ignores these warnings, so prompt Section 4.5.6's "auto-fill suggestions that respect
  overtime and rest rules" is not met and trace S4.5.6-25 stays Partial.

## Consequences

Every behavior is off or empty by default. Migration 2988 exists only because this branch's stacked base runs A127's 2200
before R4's 2641 and R12's 2750; a merge train drops it, since the renumbered A127 already carries both clauses.
