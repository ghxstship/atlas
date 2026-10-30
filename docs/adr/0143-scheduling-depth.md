# ADR 0143: Scheduling Depth: Day Types, Day Templates, the Anchor and Computed Clashes

- Status: Accepted
- Date: 2026-10-30
- Decider: Owner, through the competitor parity audit approved on 2026-10-28 (deferred theme "Scheduling depth",
  package B4, RRR-228; gaps G-38, G-41, G-42, G-43, G-44, G-45, G-46 and G-47)
- Migrations: `2930_project_days.sql`, `2931_schedule_grid.sql`, `2932_day_templates.sql`,
  `2933_day_template_rpcs.sql`, `2934_project_anchor.sql`, `2935_workload.sql`, `2936_schedule_clashes.sql`
- Builds on: ADR 0063 (crew scheduling, A132), ADR 0111 (reschedules push successors, A133 and P8), ADR 0131 (show
  calling, P2), ADR 0102 (project facts, R5)
- Cites: ADR 0103 (computed statuses), ADR 0110 (Trash), ADR 0068 (denormalization register), ADR 0044 (bulk edit),
  ADR 0022 (migration ranges)

## Context

Planners schedule tours and festivals by the shape of each day: a load-in, a show, a load-out and the travel between
cities. Before this package Atlas had no day types, no way to type a day's records or a running order quickly, no
reusable day, no plan that counted from a show day (`projects.anchor_on`, 1180, was read only by the v1 projects
handler), no workload view and no clash register. The competitor parity audit approved these as one theme.

## Decisions

1. **Project days are a table of their own.** `app.project_days` holds one row per segment: a date, one of seven types
   (`app.project_day_type`: Load In, Show, Load Out, Travel, Off, Rehearsal, Other) and its place in a split day, at
   most four per date (`project_day_split_limit`). A segment sits at a venue, at a Show node of the project (which
   gives the venue, `project_day_scope_kind`), or at a place named in words; its time zone is stored only when no venue
   applies (a check and `project_day_time_zone`), because venues carry their own (0301), and readers take the venue's
   zone, else the stored one, else the project's. A day never changes project; its date is an ordinary edit for
   schedule.timeline.write holders. Everywhere a day type shows, on the timeline, the calendar, the day sheet, Crew,
   Shifts and the portfolio timeline, it is text with an icon beside a categorical colour step (viz-cat-1 to 7),
   never colour alone; warning and danger tones stay for clash severity. A deleted day goes to Trash: its title column
   is its nullable label, and the Trash page shows a row without a title as Untitled (`trash.untitled`), so the table
   is registered rather than excluded. Bump-in and bump-out windows (B14, G-262) derive from these days and store no
   second load-in or load-out date.

2. **Day templates are separate tables.** v1 freezes `Template.template_kind` to `["Project"]` and
   `TemplateItem.item_kind` to `["Scope Node", "Record"]`, and the v1 template handlers read `app.templates` and
   `app.template_items`, so a Day kind there would leak through the list endpoints. `app.day_templates`,
   `app.day_template_items` (Record and Cue items, each at a minute from local midnight, -1440 to 2879, and 0 to 1440
   minutes long) and the append-only `app.day_template_applications` follow 1032's patterns. A Record item's title
   passes its kind's grammar (`day_template_title`); a Cue item carries only its segment's text, since B3 (G-73) owns
   the segment library and its colours. GET /templates never returns a day template.

3. **Grid saves and day-template applications are invoker RPCs, all or nothing.** `app.save_day_grid`,
   `app.save_cue_grid` and `app.apply_day_template` run as the caller, so row level security and every guard decide
   what they write, and follow `private.run_bulk` (1451): each row in its own subtransaction, refusals on their rows
   with 1451's codes (`bulk_stale` by compare and set on the loaded values, `reschedule_locked` for a baseline-locked
   window, `cue_called`), and a preview that runs the same writes and undoes them with the XB001 sentinel. The preview
   therefore equals the commit by construction. New records are created as quick add creates them (XYZ Z for a Time
   kind, else Y, basis Declared, the project's zone, under its Engagement Root node). An invoker cannot read the
   private schema, so `app.my_schedule_capabilities_on_project` names which scheduling capabilities the caller holds
   on a project, as `app.operations_project_capabilities` (0441) does for logistics; it shapes controls and the 42501
   checks, and decides no write. Time shorthand (8a-10:30a, 830p, 20 h, mediodía) lives in `@xos/ui/quick-add`, and
   only the lazily loaded grids use it, so SpreadsheetGrid, which `/finance/budgets` renders, carries no parser.

4. **Only `app.move_project_anchor` moves the plan.** A plain update of `anchor_on`, from v1 PATCH /projects or the
   Set anchor control, moves nothing, and no trigger is added. A move seeds P8's planner (2850) with every live, dated
   record that is not Complete, Canceled, pinned (`records.anchor_pinned`) or locked into a baseline, moved rigidly by
   whole days of the project's wall clock; their successors outside that set are seeded as `app.shift_records` seeds
   them, and `private.plan_reschedule('day')` refuses a cycle and a locked one it would push (`reschedule_locked`); a
   pinned one it would push refuses `anchor_pinned_pushed`. Running orders (show date and curfew) and their cues,
   project days and unpublished day and call sheets move by the same days, one row at a time in the order that keeps
   every unique index true; published sheets stay (`anchor_sheet_collision`), and a called cue means the show has
   started (`anchor_show_started`). Shifts never move, because moving booked people could create double bookings
   nobody sees: they are listed for crew.shift.read holders, and booked dock slots for logistics.shipment.read
   holders, so the definer function shows nothing its caller cannot read. Work orders, travel segments, engagement
   dates and roster arrival windows never move and are not listed. The toast's Move back runs a reverse move of the
   plan as it then stands; it is not an exact restore.

5. **Workload, conflicts and clashes are computed at read time.** `app.workload` sums shift minutes (split at local
   midnight in each shift's zone) and task estimates (spread over a record's local days, shared by its assignees,
   else carried by its owner) as the caller; `app.schedule_clashes` returns candidate facts. Nothing is stored, and no
   acknowledgement state is kept (ADR 0103). SQL returns facts; packages/data applies the org's thresholds:
   `isOver` reads `scheduling.workload_day_hours` (default 10), and `classifyClash` reads
   `scheduling.changeover_minutes` (default 15) and `scheduling.travel_buffer_minutes` (default 120) and rates each
   rule: person on two shifts a Clash, a Warning while either is Draft; a shift during travel, an artist on two stages
   and a running order past curfew a Clash; a supplier on two productions or at two docks a Warning; a changeover under
   the minimum a Warning and an overlap a Clash; travel within the buffer of a call a Warning and past it a Clash. A
   TBC input lowers any of them to at most a Warning. B9 (G-121) defines no second setting with the meaning of
   `scheduling.workload_day_hours`.

6. **Visibility is the caller's row level security.** A clash or a workload hour shows only to someone who reads the
   rows it comes from, so a clash between two projects shows only to someone who reads both. R5's requested travel
   dates are Confidential: `app.travel_request_clashes` reads them only for hospitality.fulfillment.read holders, logs
   by R5's rules (2657: a project_facts.viewed row and an audit event for each person whose date is returned, a
   project_facts.counted row for each other person compared, and one project-level counted event), and its rows are
   shown in their own panel, never cached, listed with the other clashes or exported. Shifts count only for
   crew.shift.read holders and cues only for show.run_of_show.read holders.

7. **Heatmap joins views.yaml as a view type with a table alternative.** `heatmap` is saved as `Heatmap`
   (app.view_type, 2935) and needs two dimensions and measures. `Charts/Heatmap` is a native table with text in every
   cell, keyed `'<row>:<col>'`. R11's planned `XOS/StatusHeatmap` (G-176) composes it or sits beside it, and R11 adds
   no second views.yaml type.

8. **Out of scope.** AI one-tap fixes, rider-against-stage checks, role-based assignment, project-level threshold
   overrides, day types in Compass, Gateway and the iCal feed, and any map (S5-29 stays deferred). Resource lanes add
   only the reverse drag of A132's board (an open shift onto a person's lane), through `assignShiftAction` and its
   ranking; the keyboard path stays the board's, and an overlapping shift stays a warning (ADR 0063 item 5).

## Consequences

- The denormalization register lists `app.project_days.project_id`, `time_zone` and `venue_id` and
  `app.day_template_applications.project_id` as own values; the application counts are facts kept as applied.
- Default retention covers the four new tables; project days, day templates and their items are in Trash.
- `@xos/data/schedule-day-tones` draws day types without the generated enum constants, so client code that only
  shows them stays small; the portfolio's clash counts and segments load only in its Timeline view, after paint.
- New visual baselines (the Storybook stories, Crew, Shifts and the Schedule pages) are taken through the visual
  workflow, apart from the known baseline failures of batch-c.
