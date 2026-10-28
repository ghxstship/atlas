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
    crew.time-entries,
    crew.timesheets,
    crew.rate-cards,
    crew.pay-periods,
    crew.payroll-exports,
    crew.time-off,
    crew.per-diems,
    project.crew,
  ]
order: 51
---

## Shifts and schedule

Shifts open as a resource schedule in Atlas, with people down the side and time across. Publish shifts so crew can accept them in Compass. Swaps between crew members need approval.

Planners can plan a Draft shift from one line in the quick add field, such as "#stagehand @dana ~NWS-S01 Friday 8am-4pm": `#` names the role, `@` the person (leave it out for an open shift), `~` the scope and the date its call and end. Without an end time a shift runs eight hours.

## Time entries and timesheets

Crew clock in and out in Compass, inside the venue's geofence. A second clock-in on another device is refused. Supervisors approve timesheets; if hours change after approval, the approval is voided and the timesheet needs approving again.

## Rate cards and payroll

Rate cards set pay by role and rule. Run the payroll export for a pay period, post it, and the period closes. A closed period cannot be reopened. Pay rates are masked for people without payroll access.

## Per diems

Add per diems in Crew > Per Diems once a project is chosen: pick a member or a person engaged on the project, the first and last day, and the daily amount. Each day is recorded once per person, and external crew receive per diems only while their engagement is Active or Closing. Removing a per diem keeps its history.
