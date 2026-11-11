---
title: Schedule
summary: Plan records on the timeline with dependencies, track milestones, and baseline the plan to see every slip.
kind: page
nodes:
  [
    schedule.timeline,
    schedule.calendar,
    schedule.milestones,
    schedule.baselines,
    project.schedule,
    schedule,
    schedule.events,
    schedule.days,
    schedule.workload,
    schedule.clashes,
  ]
order: 20
---

## Timeline

The timeline shows records with start and end dates as bars, with their dependencies. Drag a bar or edit its dates in the peek. A record that moves pushes the records that depend on it, and every change is logged as a replan with its reason.

## Calendar

The calendar shows the same records by day, week or month, with an agenda list for the keyboard and screen readers.

## Milestones

Milestones are the dates the project is measured against. They appear on the timeline and in gate readiness.

## Baselines

A baseline freezes the plan at a point in time. Compare the current plan with any baseline to see which records slipped and by how much.

## Days

Schedule, Days marks what each project day is for: **Load In**, **Show**, **Load Out**, **Travel**, **Off**, **Rehearsal** or **Other**. Each day reads as text with an icon beside its colour, on the timeline, the calendar, the day sheet, Crew, Shifts and the portfolio timeline.

- Choose **Add day**, or open a day, to set its type, a label, where it happens (a venue, one of the project's shows, or a place in words), its time zone and its team.
- **Split day** adds a part, up to four, such as a load-out in the morning and travel to the next city in the afternoon. A part at a venue reads in the venue's time zone.
- Removing a part moves it to Trash; **Undo** brings it back.

## Edit a day as a grid

Open a day and choose **Edit as grid** to type its records like a spreadsheet: Time, Title, Kind, Owner and TBC. Tab and Shift+Tab move across cells, Enter saves a cell and moves down, and typing in the last row adds a record.

- Time takes shorthand on the project's clock: 8, 8a, 830p, 8:30 pm, 20:30, noon, or a range such as 8a-10:30a. An end before the start is the next day. Phrases such as "tomorrow 9am" work too.
- **Save** shows how many records are new, changed and refused, with each refusal on its cell. **Apply** writes every row or none.

## Day templates

Save a day's records and cues as a template with **Save day as template**; times are kept from local midnight. On another day, **Apply day template** lays the template beside what the day already holds, by time: new items are marked **New**, items already on the day are marked **Already on this day** and unticked, and overlaps are counted. Untick what you do not want and apply; **Undo** moves what was added to Trash. Templates are listed and edited on Projects, Templates.

## The anchor

The project Schedule tab shows the project's **Anchor**, the day the plan counts from, usually the show day. The timeline draws it, and its table lists each record's offset, such as D−3 for three days before.

- **Set anchor** sets the first anchor; it moves nothing.
- **Move anchor** previews what moves and what stays: dated records move by whole days on the project's clock, with the running orders, cues, day types and unpublished sheets. Records pinned to their dates, complete or locked into a baseline stay, published sheets stay, and shifts never move: reschedule booked people on Crew, Shifts. **Move back** in the toast moves the plan back.
- On a record, **Stays on its dates when the anchor moves** pins it.

## Workload

Schedule, Workload shows hours per person per day for a week, from shifts and estimated tasks, as a heatmap or a table. Each cell shows its hours as text; a day over the organization's limit (10 hours unless changed under Settings, Scheduling) shows **Over 10 h** with an icon. A shift past midnight counts on each day in its own time zone. Open a cell to see its shift hours, task hours and tasks with no estimate.

## Clashes

Schedule, Clashes lists people on two shifts at once, shifts during a person's travel, suppliers on two productions at different venues, artists on two stages, short changeovers, travel too close to a call and running orders past curfew. Each is a **Clash** or a **Warning**, says what clashes, and links to where it is fixed; nothing is fixed for you. A time to be confirmed lowers a clash to a warning. You see a clash only when you can read both of its sides.

Hospitality leads can also choose **Check travel requests** to compare requested travel dates with each person's calls. Each check is recorded in the person's access log.

Related: [Work](help:work), [Views and saved views](help:saved-views).
