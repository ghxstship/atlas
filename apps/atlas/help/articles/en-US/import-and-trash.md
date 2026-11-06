---
title: Import, Trash and custom objects
summary: Bring records in from a spreadsheet, restore deleted items, and work with your org's own record types.
kind: page
nodes: [import, trash, custom-object]
order: 38
---

## Import

1. Upload a spreadsheet and choose what it imports into.
2. Confirm how its columns map.
3. Review problems and possible duplicates, then commit.

You can undo the whole batch for 7 days.

Instead of a file you can paste rows copied from Excel, Google Sheets or Shoflo, header row first. A preview shows the first rows as they will be read. While you map the columns, each one shows its first values, and a preview lays the first rows out by your choices.

## Import a rundown

Open a running order and choose Import cues, or choose Run of show cues on the import page and pick the running order. The rows become cues of that running order only.

- A cue number such as 12, Q12 or CUE-07 sets the cue's position. Fractions such as 12.5 are refused.
- Rows without a cue number are added after the highest cue, in the order of the sheet, once the numbered rows are in.
- Times such as 19:30 or 7:30 PM are read on the show date, in the project's time zone. Durations are minutes, m:ss or h:mm:ss.
- Importing the same rundown again updates the cues it matches, by cue number or, without one, by cue and time. It never adds them twice, and it never changes a cue that was already called.
- Two rows with the same cue number in one sheet are refused as repeats.

## Import a guest list

Open a project's guest list and choose Import guests, or choose Guest list on the import page and pick the project.

- Every imported guest is added as Requested. An import never approves, declines or checks in a guest.
- A guest already on the list under the same name for the same show is updated instead of added. A similar name, or the same name for another show, waits for you to decide: merge into the guest on the list, or keep them separate. Nothing merges on its own.
- A merge keeps the guest's name and show.
- Neither the person who uploaded the list nor the person who committed it may approve or decline those guests. Another reviewer decides them.

Undo removes the cues and guests the batch added and restores the ones it changed, for 7 days. A cue called or a guest decided or checked in after the import is kept, and the batch says why.

## Trash

Deleted items stay in Trash until their retention period ends, when they are purged for good. Restore an item to bring it back, with anything deleted together with it.

## Custom objects

An Admin defines custom objects in settings. Each one gets its own list of records, with the same views, filters and API access as any other collection.

## Importing freelancers

The Freelancers and crew to invite target sends each row an invitation into a Talent pool. It never creates a person or a profile. Choose how the file writes amounts, such as 1,234.56 or 1.234,56, and the pool for rows that name none. A rate can name its currency and how it is paid, such as 1.250,50 € per day, and needs the payroll capability.

Email inside the pool is the exact match: a pending invitation is updated with no new email, and an expired one is sent again. In duplicate review, Merged skips the row because the person is already invited or in a pool, and Keep separate sends a new invitation. Someone who declined in the last 12 months is skipped, and an organization sends at most 2,000 invitation emails in 24 hours. Undo keeps invitations already answered.
