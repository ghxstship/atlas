---
title: Credentials and the Access Grid
summary: Issue credentials by category, decide which zones each category opens, and read the scan log.
kind: page
nodes:
  [
    credentials,
    credentials.categories,
    credentials.issued,
    credentials.access-grid,
    credentials.scan-log,
    project.credentials,
  ]
order: 52
---

## Categories and credentials

A credential category, such as Crew or Artist, defines who a credential is for. Issue credentials from a category to people; each gets a printed number and a code to scan.

## Access Grid

The Access Grid is a matrix of categories against zones. Each cell says whether the category may enter the zone. Use the arrow keys to move between cells and **Space** to change one. The table view lists the same rules for screen readers.

## Scan log

Every scan at a zone is logged with the result: allowed or denied, and why. Scans made offline in Compass are checked again by the server when the device reconnects, and both answers are kept.

## Scan direction and overrides

Each scan is In or Out. Choose the direction at the scan desk, or on the gate in Compass, where it stays chosen for each zone. An Out scan is never refused, and it ends the person's time in the zone.

A denied In scan shows why: the badge is revoked, not valid yet or expired, has no access to the zone, or the scan was outside the access window. Denials recorded before this change show only that they were denied.

Someone who can issue credentials on the project, and who is not the badge holder, can let a denied person in within 15 minutes, with a reason. The log keeps the denial and adds an Overridden entry with who let them in and why. A revoked badge is never let in.

## Inside now

The scan log shows, for the chosen project, how many people each zone holds now: those scanned In in the last 24 hours who have not scanned Out, split by category and by team. It updates every 30 seconds. Use Pause updates to stop it.

## Required before issue

A category can require a training course or a certification. Add them in the category's Required before issue. Issuing that category to someone who does not hold each one now is refused. Members meet a course by passing it; anyone meets a certification once a verifier records it, which is how a pass desk records an in-person induction. A certification's holder can change only their consent to public verification, never its dates.

## Checks on the Issued page

The issue form lists what blocks a badge before you issue it: missing training, or a live badge of the same category for an overlapping window. Revoke the earlier badge first. Parking passes are exempt, because one person may hold passes for several vehicles. It also warns when the person holds another badge on the project, someone else on the project has the same name, or they are booked on another production at the same time.

Issued shows each badge's source and the same checks as chips. Choose Needs attention to see only flagged badges.
