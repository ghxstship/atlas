# ADR 0146: Day Sheets by Audience, Books, Named Calendar Feeds and the Wrap-up Report

- Status: Proposed
- Date: 2026-10-30
- Decider: Owner, through the competitor parity audit and its deferred themes approved on 2026-10-28 (package B7,
  RRR-231; gaps G-50, G-52, G-54 and G-267)
- Migrations: `2960_calendar_feed_filters.sql`, `2961_calendar_feed_configure.sql`, `2962_calendar_feed_cues.sql`,
  `2963_day_sheet_audience.sql`, `2964_document_books.sql`, `2965_project_debriefs.sql`
- Amends: ADR 0031 (decision 3, the document kinds), ADR 0040 (items 4 and 5)
- Cites: ADR 0131 (TBC starts, run of show version 2), ADR 0110 (Trash), ADR 0068 (denormalization register), ADR 0003
  (one org's record under its own brand), Section 4.7 (Aurora), EU AI Act Article 50

## Context

A touring production lives on a few printed and subscribed artifacts. Before this package a member had one unnamed
calendar feed per scope that served shifts, meetings, milestones and deadlines to everyone who could see them, with no
cues (G-50). A day sheet printed its notes for the whole crew; nobody could print the lighting crew's day (G-52). There
was no way to print a tour's documents as one book (G-54), and the wrap-up of a project was scattered over the final
cost report, the incident counts and the measurement summary, with no debrief and no summary for management (G-267).

## Decisions

1. **Named feeds with saved content, an audience and cues.** A member or project feed (`app.calendar_feeds`) and a
   person's own feed (`app.person_calendar_feeds`) take a name of 1 to 80 characters, unique per owner among live
   feeds, which names the subscribed calendar (`X-WR-CALNAME`). A feed's sources are a set of the fixed enum
   `app.calendar_feed_source` (Shifts, Meetings, Milestones, Deadlines, Cues), stored as a reviewed enum array:
   `app.person_calendar_feeds` has no `org_id`, so it cannot carry a tenant child table. NULL is the 4.0 set, so every
   existing feed, the 4.0 two-argument `app.create_calendar_feed` and the frozen `POST /calendar-feeds` serve exactly
   what they served. A project feed may follow one audience: named people (kept as their memberships of the feed's
   org, at most 50), one team, or one canon department; and one show department (`cue_call_kind`), which keeps only
   cues with that department's live call and carries its instruction. A member feed takes no cues and no audience. The
   owner's reach always applies first, so a filter never shows more than the owner may see. Cues are events of the
   project's live runs with a planned time in the window, for owners who read the run of show: titled "run · label",
   tentative while their start is to be confirmed (ADR 0131), with a sequence that follows the cue, its run and the
   filtered call. A person feed's cues are exactly `api_external.cues`, what Gateway shows. Only the RPCs write a
   feed's configuration (`app.configure_calendar_feed`, `app.configure_person_calendar_feed`), and every bad one is
   refused with its own rule.
2. **One audience rule, in SQL.** `private.schedule_audience_memberships` (a team's live members, or a department's
   through `private.audience_membership_ids` of 1365, or named people), `private.schedule_audience_shift` (the
   membership is in the set, or for a department the role is in it, open shifts included) and
   `private.schedule_audience_record` (assigned to, owned by or accountable to one of them) decide who a schedule is
   for. Calendar feeds and day sheets share them, so the two can never disagree. They read any org and record, so only
   definer functions and `service_role` may call them.
3. **Day sheet version 2 and the audience copy.** Version 2 prints the details, the notes, the day's calls (open shifts
   as Open), its meetings, milestones and deadlines (TBC and Canceled shown), and one cue table per run of that show
   date with department calls, each table with its own empty line. `app.day_sheet_schedule` returns the ids an
   audience may print (needs `show.run_of_show.read` on the project; a team of another org is not found; two audiences
   or an unknown department are refused). A template version may say it prints for an audience (`audiences: true`);
   `templateFor` then considers only such versions, so a filtered copy always renders version 2, as a size added by a
   later version does (ADR 0031, P5 amendment). An unfiltered sheet renders version 2 from `DAY_SHEET_V2_FROM`
   (2027-06-01T00:00:00Z), provisional under ADR 0131's rule: whoever cuts the release that carries B7 sets it to the
   day that release reaches production at 00:00Z, earlier or later. A sheet issued before it keeps version 1 unless a
   filtered copy is asked for.
4. **Books.** `app.document_books` holds a project's Tour Book (dated show days, both dates required) or Production
   Book (the whole project or a period) and `app.document_book_sections` its document kinds in order, written only by
   `app.save_document_book`. A book may hold day sheets and call sheets (published ones only), runs of show, BEOs,
   inspection and incident reports and, in a Production Book only, the final cost report and the wrap-up report.
   Purchase orders, invoices, change orders, credential badges and agreement certificates stay out: they are
   commercial or personal records whose readers are not the show crew a book is printed for, and their own downloads
   already serve those readers. Every document is loaded as the caller, exactly as its own route loads it; one the
   caller cannot open is left out and counted, and the cover lists what was left out. The cover is a versioned
   template of its own, keyed `<PROJECT>-BK-<first 8 of the book id>`. The PDF is built in two passes: pass 1 draws the
   cover, its contents with placeholder page numbers and every document into a counting PDF that is thrown away, to
   learn each one's page count; the contents' page column is fixed-width, so pass 2's real numbers cannot move a line.
   Pass 2 streams one `Document` root, the cover `Sect` with a `TOC` and one `TOCI` per document (dot leaders are
   artifacts), then one `Sect` per document on a new page, each with an outline item and footers that read "Page n of
   N" over the whole book. A book holds at most 100 documents and its cover (`MAX_BOOK_DOCUMENTS`, a batch's worth);
   the route answers 413 above it and the Books panel asks to narrow the dates. Books print on Letter and A4, and
   refuse a section that needs the viewer watermark. A deleted book is in Trash and comes back with Undo.
5. **The wrap-up report, the thirteenth record document.** `wrap-up-report` (its id is the project's) prints the
   debrief's state, the management summary, budget against actuals per currency as the final cost report computes it
   (or its no-baseline line), attendance and sustainability with carbon in kg CO2e, in the reader's units and never
   showing Unmeasured as 0, incident counts by severity and state, and the debrief points. Its record key is
   `<PROJECT>-WRAP`; its issue time is the debrief's completion, else the generation time. Each section is read only
   when the reader holds its capability (`app.my_capabilities_on_project` now also answers `finance.budget.read` and
   `projects.gate.read`): the budget needs `finance.budget.read` on the project and `finance.journal.read` across the
   org, because posted actuals are ledger rows; the measurements `projects.gate.read`; the incidents
   `safety.incident.read`. A section the reader may not read says "Not included". The debrief
   (`app.project_debriefs`, one live per project) and its points (`app.project_debrief_items`: area, Went Well, To
   Improve or Action, an owner for an Action only) are completed once and reopened when they need a change; while
   completed, every change to the points and the summary is refused, a restore from Trash included.
6. **The stored, AI-labelled management summary.** The summary lives in `app.project_debrief_summaries`, apart from
   the debrief, because it is drafted from budget, ledger, gate and incident facts: only readers of all of them read
   it. Aurora's `project_wrap_up` summary reads the debrief points and adds the final cost report, the incident counts
   and the measurement summary under their real relations (`app.budgets`, `app.incidents`,
   `app.project_measurement_summary`), each cited by the project's id, so the org's never-send list applies to each.
   "Use as management summary" only fills the box; nothing is stored until a person saves it (Section 4.7). A saved
   Aurora draft is linked to its `app.ai_requests` row, which must be the saver's own Answered `summaries` request about
   this project in this org, and flagged `ai_drafted`; the save stamps who saved it and when. The report prints
   "Drafted with Aurora and reviewed by <name> on <date>" from the flag, which outlives the purge of the request row
   by age, so the disclosure EU AI Act Article 50 asks for stays with the text. A summary saved without a request is
   the saver's own writing and prints "Written by".

## Alternatives considered

- **Junction tables for a feed's sources.** Rejected: a person feed has no org for a tenant child table, and the
  sources are five fixed values never joined on (the register lists the arrays).
- **Audience rules in TypeScript.** Rejected: the feed is served by a SQL token RPC, and two copies of the rule would
  drift; the day sheet reads the same SQL helpers.
- **Concatenating finished PDFs into a book.** Rejected: it cannot keep one structure tree, a real contents with page
  numbers or book-wide footers, and veraPDF checks the tree.
- **Keeping the summary on the debrief row.** Rejected: any project reader would read figures drafted from the ledger.

## Consequences

- `api_public.calendar_feed`, `app.create_calendar_feed`, `app.create_person_calendar_feed`,
  `app.my_capabilities_on_project` and `app.day_sheet_schedule` are owned by B7 from now on; a later package restates
  them from these definitions.
- The REST contract gains only additive operations: `calendarFeeds.configure` and `.configuration`, the same on
  `personCalendarFeeds`, `/project-debriefs` with `save`, `complete` and `reopen`, `/project-debrief-items`, and the
  `project_wrap_up` value of the summarize and preview kinds. The frozen `/calendar-feeds` operations and the
  `CalendarFeed` component are unchanged.
- veraPDF renders 12 more files: the wrap-up report on Letter and A4, and per locale day sheet version 2 unfiltered on
  Letter and filtered on A4, a Tour Book on Letter and a Production Book on A4.
- Group and tag filters on feeds, per-item internal visibility, query-block documents, per-area workspaces, a book's
  monthly calendar and routing appendix, debrief actions as tasks and defects and punch lists in the wrap-up stay out
  (triage defer entries; `app.punch_items` exists since 0410 and is left to a later package).
