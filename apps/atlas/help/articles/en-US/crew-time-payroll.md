---
title: Crew, time and payroll
summary: Publish shifts, collect time from Compass, approve timesheets and export payroll.
kind: page
nodes:
  [
    crew,
    crew.schedule,
    crew.shifts,
    crew.swaps,
    crew.shortages,
    crew.positions,
    crew.time-entries,
    crew.timesheets,
    crew.rate-cards,
    crew.pay-periods,
    crew.payroll-exports,
    crew.time-off,
    crew.per-diems,
    crew.access-links,
    project.crew,
  ]
order: 51
---

## Shifts and schedule

Shifts open as a resource schedule in Atlas, with people down the side and time across. Publish shifts so crew can accept them in Compass. Swaps between crew members need approval.

XOS tells the person on a published shift when it is assigned to them and when its times move. Other changes, such as a new role, a cancellation or a return to Draft, are not announced, so the shift shows **Needs review** with the number of changes since the person was told. The shift's peek shows how and when they were last told (by notification, by accepting the shift, or by your mark) and what changed since. After you tell them, choose **Mark as communicated**; with **Review** set to **Needs review**, you can mark every listed shift at once.

Planners can plan a Draft shift from one line in the quick add field, such as "#stagehand @dana ~NWS-S01 Friday 8am-4pm": `#` names the role, `@` the person (leave it out for an open shift), `~` the scope and the date its call and end. Without an end time a shift runs eight hours.

## Time entries and timesheets

Crew clock in and out in Compass, inside the venue's geofence. A second clock-in on another device is refused. Supervisors approve timesheets; if hours change after approval, the approval is voided and the timesheet needs approving again.

## Rate cards and payroll

Rate cards set pay by role and rule. Run the payroll export for a pay period, post it, and the period closes. A closed period cannot be reopened. Pay rates are masked for people without payroll access.

## Per diems

Add per diems in Crew > Per Diems once a project is chosen: pick a member or a person engaged on the project, the first and last day, and the daily amount. Each day is recorded once per person, and external crew receive per diems only while their engagement is Active or Closing. Removing a per diem keeps its history.

## Shortages

Crew > Shortages lists what is not covered yet between two days, across every project you can read: open shifts, agency slots nobody on the roster holds, offers nobody has answered, Still coming? asks unanswered or declined, no-shows without a replacement, and unacknowledged labor lines of Approved or Sent purchase orders. Rows run by day, in each shift's own time zone, and each opens its shift or order. A range can be up to 62 days.

## Positions

Crew > Positions holds seats filled later, such as Stage Manager or Rigger 2. Hold shifts for a position from the shift form and assign records to it from the record. Nobody claims or is dragged onto a held shift. Filling the position gives its shifts to the holder and shows what was filled, skipped or warned about at the top of the page. Vacating returns shifts that have not started and removes only the assignments filling made. Someone asking to swap a held shift is refused. A new shift on a filled position goes to its holder.

## Still coming? and no-shows

Turn on Settings > Scheduling > Ask crew if they are still coming, and the worker of an accepted shift is asked once before it starts. They answer from email, push, Gateway Home or the shift itself until the shift starts. When someone can't make it, the shift reopens, or goes back to its agency, unless you turn that off. Mark no-show on a started shift when the worker did not arrive and has not clocked in. A later clock-in withdraws it.

## Scheduling warnings

Minimum rest and maximum daily and weekly hours on Settings > Scheduling are your organization's warnings, shown on the scheduling board, the shift record and swap and claim approval. They never refuse an assignment and they are not pay or state overtime rules. A shift's minutes count on the day it starts, and the week tag means the week starting on your payroll week start, which can differ from the ISO week the board's hours use.

## Break types

Settings > Time and Attendance defines breaks, each paid or unpaid. A paid break is worked time, so its minutes are not subtracted from hours and show as Paid break beside Break. Compass asks which break when there are two or more types. An organization with no types behaves as before.

## Crew access links

Some crew never open the app. A crew access link shows one worker their own shifts on one project in Gateway, without signing in, and lets them accept their own Published shift. Open Crew access links, choose Issue links, pick the project and the people, and choose how long the links last, 1 hour to 30 days.

Each person gets a link and a 6-digit code, shown once. Copy them or print a card now, because they are not shown again. A printed card never carries the code, so a card left in place opens nothing; send the code another way, so a lost card opens nothing.

A link closes when the person stops working on the project, when they delete their account, or when you revoke it. Five wrong codes lock it, and issuing again replaces it. A link shows no rate, no note and nobody else's shift, and nobody can punch or decline through one. A person has to have accepted something once, such as a membership, an engagement or a roster place, to be on a shift at all.
