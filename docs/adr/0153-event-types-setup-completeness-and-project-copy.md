# ADR 0153: Event Types, Setup Completeness and Copying a Past Project

- Status: Accepted
- Date: 2026-10-31
- Decider: Owner, through the competitor parity audit approved on 2026-10-28 (deferred theme "Event types and project
  setup", package B14, RRR-238; gaps G-250, G-252, G-262, G-266 and G-268), fast-forward approved on 2026-10-30
- Migrations: `3030_event_types.sql`, `3031_document_types_and_requirements.sql`, `3032_gate_setup_checks.sql`,
  `3033_project_site_windows.sql`, `3034_record_reviews.sql`, `3035_file_version_reviews.sql`,
  `3036_project_copy.sql`, `3037_roster_copy.sql`, `3038_project_intake.sql`
- Builds on: ADR 0143 (scheduling depth, B4: project days), ADR 0101 (the roster belongs to the party, R4), ADR 0104
  (the supply bridge and its site window, R7a), ADR 0111 (templates without dates, P8), A117 (required custom fields)
- Cites: ADR 0110 (Trash), ADR 0068 (denormalization register), ADR 0022 (migration ranges), ADR 0019 (api_external
  is read-only), ADR 0027 (code loaded on demand), ADR 0037 (es-US reviewed by machine translation)

## Context

Producers set up each event the same way: they pick what kind of event it is, start from the plan that kind uses,
collect the details and documents a gate needs, and copy last year's event. Atlas had templates, gate criteria and
A117 custom fields, but no notion of an event type, no check that a project's documents or details were in place
before a gate, no separate load-in and load-out around the show dates, no copy from a past project, and no way to make
a task wait for a review before it is done. The competitor parity audit approved these as one theme.

## Decisions

**D1. Show dates and bump windows.** `projects.starts_on` and `ends_on` are the show (event) dates: the first and last
show or event day. The frozen v1 Project schema already describes them as "First show day" and "Last show day"; their
column comments now say so (3033). Bump-in and bump-out are not stored (B4's ADR 0143 decision 1, ADR 0153 C1): they
are computed by `private.project_bump_windows` from the live Load In and Load Out days of `app.project_days`, from
00:00 of the first such day to 00:00 of the day after the last, each day at midnight in its own zone (the venue's, the
Show node's venue's, the stored zone, else the project's). R7a's `private.project_site_window` takes the bump-in start
before the earliest Build record and starts_on, and the bump-out end before the latest Strike record and the day after
ends_on. `app.project_site_window_warnings` lists a Load In day after the first show day, a Load Out day before the
last, overlapping windows, a window longer than 60 days and bump days without show dates; it never refuses a day,
because a touring project has load-ins between show days. If stored windows are ever wanted, the owner amends ADR
0143 first. The UI labels of the date fields are unchanged so existing journeys keep their flow; the help explains the
meaning. The intake saves its Load-in and Load-out ranges through B4's `app.save_project_days`, which needs
schedule.timeline.write.

**D2. Event types are org data.** `app.event_types` (read by the org, written with projects.template.write) picks a
template by scale (Intimate up to 500 people; Small 500 to 2,500; Medium 2,500 to 10,000; Large 10,000 to 50,000;
Major over 50,000) and audience band: among the type's live rules whose template is live and published, the most
specific of (scale, audience), (scale, any), (any, audience) and (any, any) wins, falling through to a less specific
rule when the specific template is unpublished; none means a blank project (`private.resolve_event_type_template`, with
`app.resolve_event_type_template` for invokers). The project stores its type, scale and audience as facts chosen at
intake. A type a live project names is archived, never deleted. The archive column is named `retired_at`, because
`archived_at` would read to the normalization lint (ADR 0068) as restating `projects.archived_at` through the new
foreign key.

**D3. Setup completeness is checked by the gate.** `app.pass_gate` keeps 0301's checks and then refuses
`gate_documents_missing` while a Required document type of the project's event type due by the gate has no live
project document of that type with a version, and `gate_fields_missing` while a field required for the type due by the
gate has no value. Recommended items never block; a project without an event type passes and refuses exactly as
before; deleted document types and fields are ignored. `app.project_setup_progress` shows the same rows to readers of
the project's documents only, so nobody sees a false Missing. The Overview's Setup card is server-rendered markup with
a native meter, so the key page carries no new JavaScript. This departs from the spec's on-demand loading on purpose: a
client-loaded card would add a module and a second request to a key page, while the server read runs in parallel with
the page's other reads and is skipped for a project without an event type.

**D4. Copying a past project is a direct copy of org-owned setup.** `app.copy_project_setup` copies the plan (Show and
Standing Venue nodes, open records with their parents and dependencies, B4's project days), pass categories and their
access grid at the target's venues, hotel blocks, budgets (as non-baseline copies; an Event cost center is cleared) and
advance forms (unsent), every instant moved by whole days on the wall clock of its zone. The preview and the commit
return the same rows; the preview runs in a block that the sentinel XB001 rolls back, as 1451's `private.run_bulk`
does, and before the project exists it runs against a stand-in project at the would-be venue and zone. Templates are
not widened; they gain only `requires_review` on Record items. Shifts, engagements, people, credentials, allocations,
submissions, advance recipients, roster facts and project offering rules and settings (2620, 2621) are never copied.
The roster belongs to the party (ADR 0101): only someone who manages both rosters reuses one, in Gateway, as Draft
entries each person still accepts (`app.copy_roster_from_engagement`); a locked target is refused before anything is
copied.

**D5. Reviews are a done-gate.** A record with `requires_review` reaches Complete only when the latest live, not
Canceled Approval record about it is decided Approved, on every path that changes its state (a trigger, so
`app.transition_record`, the bulk RPCs and direct writes alike). Invariant 18 is unchanged: any eligible approver
other than the requester may decide (`private.guard_record_approval`), so the UI offers Approve and Request changes to
the named reviewer and to other eligible approvers. A reviewer must be able to decide, so `app.request_record_review`
refuses one who could not (`approval_not_eligible`). Asking for changes needs a note and moves the record back to
Active only while it is still In Review; an approval leaves it In Review for the owner to complete. Requests and
decisions reuse approval.requested and approval.decided with the record's title and key; Inbox and Compass's push
actions decide them through `app.act_on_notification`. Turning the flag off needs projects.settings.write.

**D6. File review is per attachment version.** `app.attachment_version_reviews` is append-only; the latest review of
a version is its decision and a new version starts unreviewed. The uploader never reviews their own version (a new
rule, `sod_file_review_uploader`). A submittal is not Approved while a live file's current version stands at Changes
Requested. The vendor reads each Clean version of its own submittals' files with the decision and the comment through
`api_external.submittal_files`, an owner-rights view filtered by `private.vendor_side_open` like 2610's submittals,
because vendors cannot read `app.attachments` through row level security; it never shows who reviewed, the stored
object or any download path, and it leaves out Confidential and Restricted files. The comment column is
`review_comment`, a note meant for the vendor, which the external-access lint keeps apart from internal notes.

**D7. Capabilities reuse existing seeds.** projects.template.write configures event types, document types and
requirements; projects.project.create and projects.project.write run intake (setting a type on a project that has none
needs only the update policy, so a custom role that creates projects without projects.settings.write still completes
intake, ADR 0153 C3); projects.settings.write changes or clears a project's type and bands and turns Requires review
off; each copied part needs the read capability of its tables on the source and their write capabilities on the
target, checked before anything is written.

## Consequences

- An org has no event types, document types or requirements until it adds them, so existing projects and gates are
  unchanged. Requires review defaults to off.
- B4 and B14 share project days: whoever merges second keeps the windows computed, never stored.
- The v1 OpenAPI contract is not extended: `apply_template` keeps its signature and the v1 handlers select explicit
  columns. The webhook payload of project.updated gains the type and bands, additively.
- Every new soft-deletable table has a retention policy; event types and document types come back from Trash, and the
  configuration children and append-only facts are listed in `private.trash_excluded_tables` with their reasons.
