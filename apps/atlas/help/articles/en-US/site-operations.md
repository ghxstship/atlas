---
title: Site operations
summary: Count occupancy, watch the weather, check guests in at the door and log lost property.
kind: page
nodes: [site-ops, "site-ops.*"]
order: 35
---

## Occupancy

Set up a counter for each space you count at the doors. Its permitted load comes from a permit, the space capacity, or the occupant load factor. Atlas alerts at 90 percent of the permitted load.

## Weather

Record readings for wind gusts, lightning distance and heat index, and set thresholds from your emergency plan. When a threshold is crossed, the alert reaches the roles you named.

### Official feed

For a venue with a location in the US, turn on the official feed. Every 10 minutes from three days before the project to the day after it ends, it records wind and heat readings from the nearest National Weather Service station, stores the active warnings for the venue's location and the next hours of the forecast. Its readings meet your thresholds as on-site readings do, but a reading from the feed never lowers or clears an alert someone recorded on site, and never goes below the level of the latest reading recorded on site. A new Severe or Extreme warning reaches the people in the alert roles and the dispatchers once, even in quiet hours. Warnings are shown in English, as the National Weather Service issues them. Lightning stays a reading you record.

### Weather hold and all-clear

A dispatcher can call a weather hold. The message comes from your hold text, with the hazard, and you can change it before you send it. It reaches the people in the alert roles, the dispatchers and everyone inside the project's zones at once. The hold starts with the hazard or warning filled in when an alert is at Restrict or Evacuate or a Severe or Extreme warning is active, and the message starts again when you change either. Give the all-clear when it is over; it reaches the same people as they are then. Set the hold and all-clear texts under the thresholds. A hold called in Compass while offline is still sent however late it arrives, and says when it was called; an all-clear that reaches the server more than 10 minutes after it was given is not sent, so give it again.

## Guest check-in

The door list shows the guests approved on the Advancing guest list. Checking guests in needs scanning access on the project.

A guest's pass shows a code the door can scan, or type: the door list finds the guest by it, with their pass type, table and host. A pass that is not on the list says so. When a guest checks in, their host hears that they arrived.

## Lost and found

Log each item someone hands in, with its category. Describe it well enough to check a claim, record each claim, and record the return when the item goes back to its owner.

## Muster list

The muster list shows everyone placed in a zone now, by an entry scan or a clock-in inside a zone's geofence, and the guests checked in in the last 24 hours, at a door or in bulk. Rows are grouped by zone with the count of each, as a table or a list. Filter by project and zone, print it with the headings on every page, or export it as CSV, .xlsx or PDF. It reads itself again every 30 seconds; Pause updates stops it. It shows only the people you may see, and says which sources it leaves out: entry scans need the scan log, clock-ins the time entries, guests the guest list, and their doors and plus-ones guest check-in. Someone whose newer scan you cannot see may show in the last zone you can.
