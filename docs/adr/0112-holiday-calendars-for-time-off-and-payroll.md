# ADR 0112: Holiday Calendars for Time Off and Payroll

- Status: Accepted
- Date: 2026-10-28
- Decider: A134 (RRR-196), Section 4.5.6 Payroll and Time Off (S4.5.6-26)
- Migrations: 2270, 2271

## Context

Section 4.5.6 puts pay periods, earning codes, time off policies and holiday calendars on Settings, Payroll and Time
Off, under `org.payroll.write`. Earning codes and time off policies have had tables and API resources since 0341, but
no settings panel, so Crew, Time Off pointed people at a page that could not edit them. Holiday calendars did not exist:
a time off request counted nothing but its dates, and `app.calculate_payroll_run` (latest in 1399) paid only worked
time. The specification named ADR 0069 for this record, but 0069 was taken by A109's Compass profile decision before
this package ran, so the decision is recorded here.

## Decisions

### 1. A calendar is a named set of dated holidays, applied to the org or to venues

`app.holiday_calendars` holds an org's calendars, each optionally for one ISO 3166-2 subdivision (`US-CA`), the code
venues already carry (1384). A calendar applies to the org (`applies_to_org`, at most one per subdivision and one with
none) or to the venues assigned to it (`app.holiday_calendar_venues`, one calendar per venue). `app.holidays` holds one
holiday a day per calendar, with the hours it pays; 0 observes the day unpaid. A calendar is not copied per year: a
holiday is a date, so next year's holidays are added as dates, and nothing has to roll over.

### 2. The calendar that governs work: venue, then subdivision, then org

`private.project_holiday_calendar_id(project)` answers which calendar governs work on a project: the calendar assigned
to its venue; else the org calendar for the subdivision whose wage-hour law governs the work
(`private.labor_subdivision`, the same answer overtime uses); else the org calendar with no subdivision. One rule
serves payroll everywhere, and a touring production's work in California follows California's calendar without a
venue assignment.

### 3. Time off counts on the org calendar with no subdivision

A time off request names a person and dates, never a place, so its day count (`app.time_off_day_count`, a computed
field PostgREST reads as a column) is every day from first to last less the holidays on the org calendar with no
subdivision. Weekends are not skipped: production crews work weekends, and the org has no workweek setting to say
otherwise. The count is derived when read, never stored, so a holiday added or removed later changes every request it
falls in. A request's `hours` stay what the person entered.

### 4. Holiday pay goes through an earning code marked holiday

`app.earning_codes.is_holiday` marks the code holiday pay is paid under; a code is never both overtime and holiday.
`app.calculate_payroll_run` now picks its regular code from codes that are neither, so adding `HOL`, which sorts before
`REG`, never moves regular hours onto it. For each person with worked time in the run, it pays the hours of each paid
holiday on the calendar that governs a project, inside the period of their approved timesheet for that project, once a
day however many projects share it, at the rate of the role they worked most, on the org's first holiday code. With a
paid holiday owed and no holiday code, the run refuses (`payroll_holiday_code_missing`) rather than dropping the pay.
Holiday hours are paid, not worked: they never count toward overtime, and work on a holiday earns no premium. State
break and meal rules stay deferred (decision 54).

### 5. Time off policies are written under org.payroll.write

0341 wrote time off policies under `org.time_attendance.write`, while the API catalog, the capability's description and
the settings page all name `org.payroll.write`. The write policy now asks for `org.payroll.write`. Owners and Admins
hold both, so no seeded role loses anything.

### 6. Settings panels write through row level security

The three panels are settings contributions (`apps/atlas/components/settings/contributions/a134.tsx`) whose server
actions write with the viewer's client, so row level security decides every change. Retiring soft deletes, so payroll
lines and requests that name a retired code or policy keep it. Retired calendars and removed holidays go to Trash, titled
by name, and their update policies let editors restore them (ADR 0110); a venue assignment has no title and is simply
assigned again. A unique conflict answers with the rule naming what is
taken (a code, name, day or venue), never as a concurrent edit. Holiday calendars stay off the v1 API: the contract is
frozen to additive changes, and nothing outside Atlas needs them yet.

## Consequences

- Holidays added in Settings change time off day counts at once and are paid by the next calculation of a Draft run.
- An org that adds a paid holiday must add a holiday earning code before calculating a run whose period holds it.
- A venue calendar replaces the org calendars for work at that venue; it does not add to them.
