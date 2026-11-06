# ADR 0153: Event Types, Setup Completeness and Copying a Past Project

- Status: Accepted
- Date: 2026-10-31
- Decider: Owner, through the competitor parity audit approved on 2026-10-28 (deferred theme "Event types and project
  setup", package B14, RRR-238; gaps G-250, G-252, G-262, G-266 and G-268), fast-forward approved on 2026-10-30
- Migrations: `6260_event_types.sql`, `6261_document_types_and_requirements.sql`, `6262_gate_setup_checks.sql`,
  `6263_project_site_windows.sql`, `6264_record_reviews.sql`, `6265_file_version_reviews.sql`,
  `6266_project_copy.sql`, `6267_roster_copy.sql`, `6268_project_intake.sql`
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
column comments now say so (6263). Bump-in and bump-out are not stored (B4's ADR 0143 decision 1, ADR 0153 C1): they
are computed by `private.project_bump_windows` from the live Load In and Load Out days of `app.project_days`, from
00:00 of the first such day to 00:00 of the day after the last, each day at midnight in its own zone (the venue's, the
Show node's venue's, the stored zone, else the project's). R7a's `private.project_site_window` takes the bump-in start
before the earliest Build record and starts_on, and the bump-out end before the latest Strike record and the day after
ends_on. `app.project_site_window_warnings` lists a Load In day after the first Show day at its venue, a Load Out day
before the last Show day there, load-in and load-out dates that overlap at a venue, more than 60 dates of load-in or
load-out and bump days without show dates. Each day is judged at its venue (its own, else its Show node's) against the
Show days at that venue, and against starts_on and ends_on only when the project has no Show day there, so a tour that
loads in before each stop raises nothing; it never refuses a day. The windows themselves stay project-wide. If stored windows are ever wanted, the owner amends ADR
0143 first. The UI labels of the date fields are unchanged so existing journeys keep their flow; the help explains the
meaning. The intake saves its Load-in and Load-out ranges through B4's `app.save_project_days`, which needs
schedule.timeline.write, and refuses at intake a load-in that ends after the first show day
(`project_bump_in_after_show`) or a load-out that starts before the last (`project_bump_out_before_show`); B4's day
editor only warns.

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
before; deleted document types and fields are ignored. The gate and `app.project_setup_progress` read one rule,
`private.project_setup_item_met`, which counts a typed document whatever its classification; the view lists rows only
to readers of the project's documents, so a reader never sees a Missing the gate would not refuse, even for a
Restricted document they cannot open. The gate's refusal names the missing items after "missing: "; the Gates page
lists them from the progress view rather than splitting the message, since a label may hold a comma. The Overview's Setup card is server-rendered markup with
a native meter, so the key page carries no new JavaScript. This departs from the spec's on-demand loading on purpose: a
client-loaded card would add a module and a second request to a key page, while the server read runs in parallel with
the page's other reads and is skipped for a project without an event type.

**D4. Copying a past project is a direct copy of org-owned setup.** `app.copy_project_setup` copies the plan (Show and
Standing Venue nodes, open records with their parents and dependencies, B4's project days), pass categories and their
access grid at the target's venues, hotel blocks, budgets (as non-baseline copies; an Event cost center is cleared) and
advance forms (unsent), every instant moved by whole days on the wall clock of its zone. Each part needs the capabilities the target
table's write policy asks for; the plan also needs schedule.timeline.read on the source and schedule.timeline.write on
the target, so project days and dependencies are never left out in silence. A project in another org, as source or
target, reads as "project not found", so a copy never tells whether it exists. The preview and the commit
return the same rows; the preview runs in a block that the sentinel XB001 rolls back, as 1451's `private.run_bulk`
does, and before the project exists it runs against a stand-in project at the would-be venue and zone. Templates are
not widened; they gain only `requires_review` on Record items. Shifts, engagements, roster entries and travel parties,
people, credentials, allocations, submissions, advance recipients, roster facts, Approval records, record extension
rows, record and file reviews, hotel assignments and project offering rules and settings (2620, 2621) are never
copied.
The roster belongs to the party (ADR 0101): only someone who manages both rosters reuses one, in Gateway, as Draft
entries each person still accepts (`app.copy_roster_from_engagement`); a locked target is refused before anything is
copied.

**D5. Reviews are a done-gate.** A record with `requires_review` reaches Complete only when the latest live, not
Canceled Approval record about it is decided Approved, on every path that changes its state (a trigger, so
`app.transition_record`, the bulk RPCs and direct writes alike). Invariant 18 is unchanged: any eligible approver
other than the requester may decide (`private.guard_record_approval`, not restated), so the UI offers Approve and
Request changes to the named reviewer and to other eligible approvers. A review names its reviewer, who must be able to
decide (`approval_not_eligible`). Only an independent decision about the work as it stands counts: the record's owner
never reviews it or decides its review (a new built-in rule, `sod_record_review_owner`), and the gate counts an
Approved review only when its approver is neither the owner nor the person completing the record, it is in the
record's project, and it was decided after the record last entered Active. So an Approval record inserted by hand with
a borrowed requester does not complete its approver's own work, and a reopened record, or one whose later Rejected
review was deleted, needs a new review. The gate reads an approval's subject and decision time, which 0311's write
policy would let any project editor update, so a new trigger keeps both fixed (`approval_subject_immutable`,
`approval_decided`): a decided review is never moved onto another record or re-dated past a reopen.
The review's subject is in its own project: `app.decide_record_review` refuses another project's record (42501), so a
writer in one project cannot move a record in another or read its title back from approval.decided, and an undecided
Approval record in another project does not hold a review open (`record_review_open`). A review is only asked of someone
who can decide it: `private.can_decide_record_review` follows `private.project_ids_with` for a named person, and
`app.eligible_record_reviewers` gives the picker that list. An Approval record cannot carry the flag
(`records_review_not_approval`, `template_items_review_not_approval`), because the gate would then block its own
decision, and it cannot be completed undecided (`record_review_undecided`), which would leave the reviewed record stuck.
Asking for changes needs a note and moves the record back to Active only while it is still In Review; an approval leaves it In Review for the owner to complete. Requests and
decisions reuse approval.requested and approval.decided about the review's Approval record, with the reviewed record's
title and key; Inbox and Compass's push actions decide them through `app.act_on_notification`, restated from A127's
5200 so its accept, decline and reply actions stay. Email one-tap links are not offered for record reviews
(`private.notification_link_actions` is not restated). Turning the flag off needs projects.settings.write. Saving a project as a
template leaves out the Approval records of open reviews, since each would come back in every new project about a
record that is not there; an Approval record with no subject is still a plan item.

**D6. File review is per attachment version.** `app.attachment_version_reviews` is append-only; the latest review of
a version is its decision and a new version starts unreviewed. The uploader never reviews their own version (a new
rule, `sod_file_review_uploader`). A submittal is not Approved while a live file's current version stands at Changes
Requested. The vendor reads each Clean version of its own submittals' files with the decision and the comment through
`api_external.submittal_files`, an owner-rights view filtered by `private.vendor_side_open` like 2610's submittals,
because vendors cannot read `app.attachments` through row level security; it never shows who reviewed, the stored
object or any download path, and it lists only files classified Public or Internal (1380). It gives each version's id,
number, file name, media type, size, upload time, whether it is current, and the latest decision, comment and time. The comment column is
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
- The staged intake pages the Details step at seven visible controls and gives load-in and load-out their own step,
  rather than folding them in More fields, which remounts its children and folds nothing out of the count. ProjectFields'
  own More fields (jurisdiction, currency, tier, region) is inherited and stays. The single screen stays for an org with
  no event types and no project custom fields.
- A record or day in the source project's zone lands in the target's on copy, so 18:00 stays 18:00; one with its own
  other zone keeps it.

### Merge hazards for the orchestrator

These are numbers on batch-c and train 8 as of 2026-11-06; nothing here acts on them.

- B14 sorts after R9's set (R4, R5, R6, R7a), P8, B4 and A127, wherever they land. B4 is on neither batch-c nor train 8.
- `app.act_on_notification`: the latest is `5861_approval_links_signed_out.sql` (it restates 5200, and adds
  subject_approvals, approval.reminder and `private.is_subject_step_approver`), and R11's 2744 adds roster_entry.invited
  accept and decline. 6264 restates it from 5200 (5200), so at renumbering it must be their union plus the app.records
  branch, or it silently removes them. R11's 2744 is on neither batch-c nor train 8: whichever of B14 and R11 lands
  second restates the union. `private.notification_link_actions` (5861) stays unrestated by B14.
- `app.apply_template` and `app.create_template_from_project`: P8's 6121 is 6121 on train 8. `private.project_site_window`:
  4683 is 4683. `private.emit_project_update` (0401), `app.pass_gate` (0301) and `app.transition_submittal` (0492) have
  not moved. 5940 redefines `app.person_names` with the same signature.
- 6267 restores two definitions the stacked branches overwrote: `private.party_org_ids` (2641 dropped A127's open offers
  from 5200) and `api_external.engagement_up_next` (6110 dropped R8's roster readers from 4701). At renumbering each must
  be the union with the latest definition on the train.
- The notification seed pointer is 6059 on batch-c and 6129 on train 8: regenerate with `generate:notifications`.
- `create-project.tsx`: batch-c split out `create-project-fields.tsx`, and train 7 moved the dialog behind a static button
  whose first click loads it. The wizard lands behind that button and replaces DrawerFields behind it;
  `project-fields.tsx` still exists on batch-c.
- 5180 adds `archived_at` to app.records and app.documents. At renumbering, 6266's Plan loops and size count must leave
  out archived records, and `private.project_setup_item_met` and the view's `documents_count` must leave out archived
  documents, or an archived Site Plan passes a gate.
- 5945 adds `accommodation_blocks.budget_line_id`. The copy leaves it NULL, because a source budget line must not cross
  projects.
- 4731 changes `issue_roster_invitation` to a 4-argument form with a default, so 6267's 3-argument call still binds.
- The value lists of `setup.ts`, `project-copy.ts`, `attachments.ts` and `work.ts` move to `@xos/data/enums` on the train.
- The train takes the larger edge ceiling on batch-c: notification-dispatch 222 against the branch's 196, org-lifecycle
  262 against 228, sms-webhook 179 against 157, subprocessor-notices 136 against 120.
- No name collision: `app.event_types`, `document_types`, `event_type_templates`, `project_copies`,
  `attachment_version_reviews`, `project_setup_progress` and `project_site_windows` do not exist on batch-c.
