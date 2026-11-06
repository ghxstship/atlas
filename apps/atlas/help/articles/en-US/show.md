---
title: Run of show, day sheets and call sheets
summary: Build the running order of a show, run it live with cues, and publish day and call sheets.
kind: page
nodes:
  [
    show.run-of-show,
    show.day-sheets,
    show.call-sheets,
    show.show-day,
    show.segments,
    project.show,
    show,
  ]
order: 22
---

## Run of show

The run of show is the ordered list of segments and cues for a show. Build it ahead of time, then run it live: the current cue advances in real time for everyone watching, in Atlas and in Compass.

### Build the running order

- Add each cue with its planned time and length. When a time is still an estimate, check **Time to be confirmed**: Atlas shows **TBC · est.** with the estimate, Compass, Gateway and the PDF show **TBC**, and calendar subscriptions mark it tentative. Records offer the same box, **Start time to be confirmed**, beside **Starts**.
- Choose the pencil on a cue to edit it in place: label, time, length and one call for each department (Audio, Lighting, Video, Special Effects and Stage). **Esc** cancels.
- Use the arrows to move a cue one place, or **Move to position…** to put it anywhere after the last called cue in one step. Called cues keep their places, and the cues are renumbered 1, 2, 3 after a move.
- Choose a **Department** to see only that department's calls. Cues that have one are marked; the others say there is no call. The choice stays in the page address, so you can share it.
- Set a **Curfew** in the details when the show has a hard stop.

### Call the show

Choose **Run live**. If you may call cues, the showcaller console opens with the show clock, the time of day, how far the show runs behind or ahead of the plan and, when a curfew is set, the projected end against it.

- **Call next cue** calls the cue on standby, or else the next cue. **Go** calls the cue you selected.
- **Standby** puts the selected cue on standby; everyone following sees it within a second or two. **Previous cue** and **Next cue** move the standby, and **Jump to cue** picks any uncalled cue. Cues you jump past are marked **Skipped**.
- **Nudge −1 min** and **Nudge +1 min** move every remaining planned time.

With focus in the console, **J** and **K** move the standby, **S** stands by, **T** jumps, **[** and **]** nudge and **D** changes the department; **Space** on the cue list goes.

### Set Stream Deck Hotkey actions to F13 to F20

Give each Stream Deck key a **Hotkey** action: **F13** Go, **F14** Standby, **F15** Previous cue, **F16** Next cue, **F17** Nudge +1 min, **F18** Nudge −1 min, **F19** Jump to cue and **F20** Department. They work while the console has focus, even with single-key shortcuts turned off, and you can change them in **Me, Keyboard shortcuts**.

### Display screens

Put the running order on any TV or laptop with no sign-in. Open the running order, choose **Display screens**, pick the mode the screen opens in and when the link expires (by default the end of the day after the show), and copy the link and its 6-digit access code, shown only once. You need permission to edit the run of show.

- **Room clock** shows the local time, the running cue and its time left.
- **Presenter timer** counts the current cue down, or up when it has no duration.
- **Backstage** shows the cue on now, the next cue with its planned time, the three after it, and whether the show is running late.

When a cue runs past its duration the timer turns red and reads **Over by** the time, until the next cue is called. On the screen, keys 1, 2 and 3 switch modes, **Open in new window** pops the screen out to a second display, and **Fullscreen** fills the screen. The screen follows cues within a few seconds of them being called. Revoke the link to take it off every screen.

### Edit the running order as a grid

Choose **Edit as grid** to type the cues like a spreadsheet: Time, Duration, Label, Segment and TBC, in running order. Time takes shorthand such as 830p or 20:30, and +1 marks a cue after midnight; Duration takes 45, 45m or 1h30. Typing in the last row adds a cue, and **Move up** and **Move down** reorder. Called cues, and the cues before the last called one, keep their places. **Save** previews; **Apply** writes every row or none and renumbers the cues.

### Cue fields and colors

Add your own columns to cues in **Settings, Custom fields**: choose **Cues** as the table, then a type. A **Choice** field can give each option one of seven colors; the option's name always shows beside its color. For each cue field, choose who it is for: **Crew** sees it in Atlas, **Showcaller** shows it on showcaller links, and **Client** shows it in Gateway to a Client engaged on the project. Every new cue field starts with Crew. Person, Money and Email fields stay with the crew. Crew is a display choice: members still see every value their access allows.

The cue editor has tabs. **Cue** holds the label, the time, the length, the **Segment** and its **Segment color**, which colors the whole segment at once and follows the segment you type. **Words** holds the **Description** and the **Script**, up to 20,000 characters. **Calls** holds the five department calls, and **Fields** your cue fields, when your organization has any. What you type stays while you move between tabs, and one **Save** saves the cue; **Fields** saves on its own. In live mode the running cue shows its segment color and a **Script** you can open.

### Segment library

Keep blocks you run in many shows, such as a walk-in, an awards block or a sponsor moment, in **Show, Segment library**: each segment has a name, a color, a description and cues with their department calls. To use one, open a running order and choose **Insert segment**: pick the segment, where it goes (after the last called cue) and, if you like, the time it starts. The copies are yours to edit in that running order.

When you change a library segment, it shows **Library updated**. Choose **Publish to shows** and pick the running orders to update, at most 50 at a time; the ones out of date are already picked. In each, the segment's uncalled cues are replaced with the current version, and local edits to those cues, their custom field values included, are lost. Shows where a cue of the segment was called (**Has called cues**) or is an artist's set time (**Has set times**) are left as they are. The segment lists what happened in each after you publish.

### Show channel

In live mode, the show channel sits beside the running cue: the project's crew chat, which Clients are never in. Choose **Open the show channel** the first time (it needs permission to edit the run of show) and the project's members join it; others choose **Join the show channel**. New messages appear as they are sent, and **M** moves to the message box from the console.

### Showcaller links

Let someone without an XOS account call the show. Open the running order, choose **Showcaller links**, name the showcaller, pick when the link expires (by default the end of the day after the show, at most 14 days) and copy the link and its 6-digit access code, shown only once. You need permission to edit the run of show and to call cues.

Anyone with the link and code can call cues and edit this running order until it expires: call, standby, nudge, move, add, edit and remove uncalled cues, and change department calls. They never reach another running order. A cue they call reads **Called by** their name **through a showcaller link**. A link works on up to 5 devices; **Sign out devices** makes every device enter the code again, **Regenerate** gives a new link and code, and **Revoke** stops it for good. On the link, **Open clock** pops out a room clock and presenter timer.

## Day sheets

A day sheet summarizes one day of a project: times, locations, contacts and notes. Publish it when it is ready; people see the latest published version.

The day sheet PDF lists the day's notes, its calls, its meetings, milestones and deadlines, and the cues of that show date. **Download for…** prints a copy for one team or one department: only their calls and the records assigned to, owned by or accountable to them, never more than you can see. Pick a show department to keep only the cues with that department's call, and choose Letter or A4.

### Books

A book prints a project's show documents as one PDF with a cover and contents. Open the project's **Documents** tab and choose **New book**:

- A **Tour Book** covers dated show days: day sheets, call sheets, runs of show, banquet event orders, inspections and incidents, in day order.
- A **Production Book** covers the whole project or a period and can also hold the final cost report and the wrap-up report.

Day sheets and call sheets go in once they are published, and records you cannot open are left out; the cover says how many. A book holds up to 100 documents: narrow its dates to download a longer one. Deleting a book moves it to Trash, and **Undo** brings it back.

## Call sheets

A call sheet tells each person when and where to report. It draws on the crew schedule, so changes to shifts appear on the next published version.

## Local contacts

A day sheet lists the local contacts for its day: the venue's contacts, the project's contacts for every day, and that day's. Add a member of the org, whose current name and directory work phone always show, or type a contact with a business phone and email. Shared contacts also reach the people engaged or rostered on the project in Gateway and Compass; a member's work phone never leaves the org. Manage a venue's own contacts from its peek in Places > Venues.

## Show day

Show day puts one project's show day on one page. Pick the project and the day, or step a day back or forward. **Sets by stage** lists each artist's set with its time and length, what has been called and what is up next. **Run of show** shows how many cues each running order has called and the next one. **Arrivals** lists who lands that day, in the arrival's own time zone, and **Hotels** who sleeps where that night and who checks in or out; both need access to hospitality. Anything changed since you last looked carries a tag naming what changed, and **Mark all as seen** clears the tags. The page updates live as cues are called. From a project's Show tab, **Open show day** opens today's.
