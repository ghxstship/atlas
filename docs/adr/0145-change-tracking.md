# ADR 0145: Change Tracking Is Computed From the Ledger Against One Instant per Person

- Status: Accepted
- Date: 2026-10-30
- Decider: B6 (RRR-230), gaps G-120, G-65, G-249 and G-179, approved by the owner on 2026-10-28 with the parity audit
- Migrations: 2950, 2951, 2952, 2953

## Context

Four parity gaps ask the same question in four places. A coordinator wants to know whether the person on a shift was told of its changes (G-120). A traveller wants their whole stay with what moved since they last looked marked (G-65). A person opening Home > Today wants what others changed on their work since their last visit (G-249). A show caller wants one project's show day on one page, with what changed since they last looked (G-179). Field history (ADR 0044, ADR 0090) already records every change of a subject row in the audit ledger, `app.audit_events` (0501).

## Decisions

### 1. Diffs are computed, never stored

"What changed" always comes from the audit ledger, compared with one instant per person, and names fields, never values. Two kinds of instant are stored and nothing else:

- seen marks (`app.seen_marks`): when a person last looked at Today (scope: the org), an engagement's itinerary (scope: the engagement) or a project's Show day (scope: the project);
- communication marks (`app.communication_marks`): when a coordinator says they told the person on a shift.

`private.audit_field_changes` reads one row's events strictly after an instant, its own and its 1:1 extension rows' (`private.field_history_extensions`, 2240, for every subject that has them), without one actor's. `private.audit_changes_since` turns them into added, changed or removed with the distinct fields: removed wins over changed, a row both added and removed returns nothing, and a restore (deleted_at back to null) is a change of `deleted_at`. `app.changes_since` answers for up to 200 rows the caller reads (their own read policies, `private.caller_reads_row`), leaving out the caller's own changes; rows without an event after the instant are left out before the read check, through `audit_events_subject_idx`. A column signed-in people cannot select and a Restricted column never appear: Restricted columns never reach a diff (0501), and the column privilege check drops the rest, so no caller ever sees a Restricted field name and there is no unmasking path.

Alternative: store a per-row "changed since" flag or a snapshot per viewer. Rejected: it multiplies writes by viewers, goes stale when access changes, and duplicates the ledger.

### 2. A visit is a 30-minute window

The baseline a page compares against moves forward only when a visit starts 30 minutes or more after the previous visit started (`private.effective_seen_baseline`). `app.seen_baseline` reads it without recording, so a server render shows what the visit will commit; `app.record_visit` records the visit, and the pages call it after mount (a client VisitMarker), never during a render or a prefetch. Mark all as seen (`app.mark_seen`) moves the baseline to now. A refresh therefore never clears the highlights, and nothing that changed during the previous visit is lost. The marks are personal UI state: the person reads only their own, writes go only through the three functions, rows go after 90 days without a visit and when the person is deleted, and they have no audit trail. An itinerary's marks belong to external parties and sit under the producing org: the guard asks that the scope be open to the person (`private.seen_scope_open`), not that they be a member.

### 3. An assignee counts as told at the latest of three instants

`private.last_told` takes the latest of a live communication mark, the assignee's own acceptance of the shift (0460), and a notification of a telling kind about the shift that reached them: not archived when it was created (In App on), or with a delivery Sent or Delivered. 1394 already tells the worker when a published shift is assigned to them (`shift.assigned`) or its times move (`shift.changed`), so only the changes XOS does not announce need review: the role, the scope node, the record, the zone, the scheduled break, a cancellation and a return to Draft (`private.communication_fields`). One update may save several fields at once, so an event at exactly the told instant counts as told, except that `shift.changed` tells only the times (`timing_only`): a role saved in the same update as a new start still needs review. The registry is three tables of rows (`private.communication_subjects`, `communication_fields`, `communication_telling_kinds`), never arrays, so the Section 3.15 lint holds; it admits roster entries or record assignments later.

`app.communication_status` answers for up to 500 shifts the caller reads and writes (`crew.shift.write`): who is on each, when and how they were told, the communicable fields others changed since, and Needs review. `app.mark_communicated` is all or nothing and stamps the org and project from the shift. Communication marks are an append-only ledger with an audit trail, one event per mark.

Known limits:

- A Published shift soft-deleted from the trash (`trashShift`) leaves Needs review, which covers live shifts only.
- The person a reassigned shift was taken from is never told: 1394 has no kind for it.
- A deleted shift cannot be marked as communicated.
- A room assignment or travel segment whose person moves away from a visible person after the baseline does not appear as removed on that person's itinerary.

### 4. External viewers get their own view's column names only

`api_external.itinerary_changes` (2952) lists, per Itinerary seen mark of the caller whose engagement is still open to them, the travel, lodging and set-time rows that changed since the baseline, naming only the columns of `api_external.travel`, `api_external.lodging` (the block as `hotel`) and the set's label, planned time and length. A fare or currency change marks nothing; a cue call marks nothing. Set times come from the engagement's own `app.engagement_cues`, not from `is_my_set` across the project, so a principal with two artist engagements on one project sees each set under its own engagement. Gateway and Compass build the itinerary with one pure builder (`@xos/data/itinerary`). Compass downloads the view over REST (decision 51, no PowerSync rule), so the marks read offline; opening Travel and lodging online records a visit and hides changes at or before the baseline it returns.

### 5. Audit trails on travel, rooms and cues

Travel segments, room assignments and cues get an audit trail and become field history subjects (2950), so the itinerary and the Show day can say what moved. Each cue call now adds one ledger event (`cues.update`); the owner checks the volume after the first production show day. If P8 (2852) reaches the base first, its `install_audit_trail('app.cues')` already made the trail and 2950's call recreates the same trigger.

### 6. Seen marks and diffs have no v1 operation

As recent views (1440) have none, seen marks and the diffs computed from them are first-party UI state with no v1 operation. Needs review and Mark as communicated are additive v1 actions on shifts (`shifts.communicationStatus`, at most 100 ids in its query since they travel in the URL, and `shifts.markCommunicated`, at most 500 in its body), both needing `crew.shift.write`.

### 7. Today and Show day are dashboards

Home > Today and Show > Show day stand on the 12-column Dashboard template (A129) and keep the viewer's spans in `me.dashboard_layout.today` and `me.dashboard_layout.show_day` (2953). The Show day page reads its day in a fixed number of queries and refreshes live on cues, running orders, travel segments and room assignments (the last by org, since a room assignment has no project of its own). Its project list holds the projects whose running orders the viewer reads; a project with none has no show day to show.

### 8. The Compass role table is unchanged

Section 4.5.7's role table stands: artist principals keep the itinerary in Gateway, and Compass travel and lodging stays with Crew and Staff, which includes people on a roster (R8 gives them role type crew).

## Consequences

- Every surface that shows "changed since" reads the same ledger through the same functions, so the four answers agree.
- The ledger grows by one event per cue call, travel segment edit and room assignment edit.
- Notification index `notifications_subject_recipient_idx` (2951) builds on every partition of `app.notifications`.
