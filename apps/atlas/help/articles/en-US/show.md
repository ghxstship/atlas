---
title: Run of show, day sheets and call sheets
summary: Build the running order of a show, run it live with cues, and publish day and call sheets.
kind: page
nodes: [show.run-of-show, show.day-sheets, show.call-sheets, show.segments, project.show, show]
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

### Cue fields and colours

Add your own columns to cues in **Settings, Custom fields**: choose **Cues** as the table, then a type. A **Choice** field can give each option one of seven colours; the option's name always shows beside its colour. For each cue field, choose who it is for: **Crew** sees it in Atlas, **Showcaller** shows it on showcaller links, and **Client** shows it in Gateway to a Client engaged on the project. Every new cue field starts with Crew. Person, Money and Email fields stay with the crew. Crew is a display choice: members still see every value their access allows.

Fill the fields in the cue editor. The editor also holds the cue's **Segment** and its **Segment colour**, which colours the whole segment at once, the **Description**, and the **Script**, up to 20,000 characters. In live mode the running cue shows its segment colour and a **Script** you can open.

### Segment library

Keep blocks you run in many shows, such as a walk-in, an awards block or a sponsor moment, in **Show, Segment library**: each segment has a name, a colour, a description and cues with their department calls. To use one, open a running order and choose **Insert segment**: pick the segment, where it goes (after the last called cue) and, if you like, the time it starts. The copies are yours to edit in that running order.

When you change a library segment, it shows **Library updated**. Choose the shows to update under **Publish to shows**: in each, the segment's uncalled cues are replaced with the current version, and local edits to those cues, their custom field values included, are lost. Shows where a cue of the segment was called (**Has called cues**) or is an artist's set time (**Has set times**) are left as they are.

### Show channel

In live mode, the show channel sits beside the running cue: the project's crew chat, which Clients are never in. Choose **Open the show channel** the first time (it needs permission to edit the run of show) and the project's members join it; others choose **Join the show channel**. New messages appear as they are sent, and **M** moves to the message box from the console.

### Showcaller links

Let someone without an XOS account call the show. Open the running order, choose **Showcaller links**, name the showcaller, pick when the link expires (by default the end of the day after the show, at most 14 days) and copy the link and its 6-digit access code, shown only once. You need permission to edit the run of show and to call cues.

Anyone with the link and code can call cues and edit this running order until it expires: call, standby, nudge, move, add, edit and remove uncalled cues, and change department calls. They never reach another running order. A cue they call reads **Called by** their name **through a showcaller link**. A link works on up to 5 devices; **Sign out devices** makes every device enter the code again, **Regenerate** gives a new link and code, and **Revoke** stops it for good. On the link, **Open clock** pops out a room clock and presenter timer.

## Day sheets

A day sheet summarizes one day of a project: times, locations, contacts and notes. Publish it when it is ready; people see the latest published version.

## Call sheets

A call sheet tells each person when and where to report. It draws on the crew schedule, so changes to shifts appear on the next published version.
