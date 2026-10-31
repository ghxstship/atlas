# ADR 0142: Run-of-Show Depth, Show Channels and Showcaller Links

- Status: Proposed (until the owner accepts the showcaller link rows of `legal/security/threat-model.md`)
- Date: 2026-10-31
- Decider: Owner, through the competitor parity audit approved on 2026-10-28 and the deferred-theme package B3
  (RRR-227), fast-forwarded on 2026-10-30
- Migrations: `2920_cue_rundown_depth.sql`, `2921_segment_library.sql`, `2922_show_channels.sql`,
  `2923_showcaller_links.sql`, `2924_showcaller_link_access.sql`, `2925_showcaller_link_channels.sql`
- Gaps closed: G-73 (user-defined cue columns with per-audience visibility, a script field, segment colours and a
  library of reusable segments), G-79 (show chat beside the running cue, with clients excluded) and G-80 (a
  showcaller portal with an access code per stage that edits the rundown live, cues departments and runs the clock)

## Context

P2 (ADR 0131) gave the running order TBC times, standby, one-step moves, nudges, department calls and a showcaller
console; P1 (ADR 0130) gave no-account read links and display screens; P3 imports rundowns. The parity audit found
three things production tools still do that XOS did not: Rundown Studio and Shoflo let a producer add their own
columns, colour-coded, and decide who sees each; LASSO's Global Elements Manager keeps reusable segments and pushes
changes to the shows that use them; ProductionOS puts a crew chat beside the running cue and lets an outside
showcaller run a stage with a password and no account.

## Decisions

### 1. Stage means one running order

ProductionOS's showcaller password covers a stage. In XOS a running order is one stage's show day: its
`scope_node_id` is the stage's Show node and its `show_date` the day. A showcaller link covers exactly one running
order and never a second. A link per scope node would reach every show day of the stage, so a leaked code would
reach more than the day it was given for. A multi-day stage needs one link per show day (owner step).

### 2. Showcaller links are their own table

`app.showcaller_links` is a table of its own, not a third `app.live_link_kind`. Live links (2780) only read;
showcaller links write. Keeping them apart keeps write-by-token out of P1's read path, its allowlist registries and
its `/live-links` API enum. The two share P1's secrets and limits: `private.share_token_hash` and `share_code_hash`,
`private.new_live_link_code`, the address subjects and failure limits, the refusal JSON, the display screen's default
expiry and 2782's channel registry with roles.

### 3. Writes run as anon under a trusted operation

A portal write runs as the anonymous caller under the trusted operation `showcaller_link`, with
`xos.showcaller_link_id` set. It does not switch to the link's creator, which would record the creator as having
called a cue they did not call. `private.guard_cue` stamps a call made under the operation with
`called_via_link_id` and no person; `cues_called_pair` now says a called cue has exactly one of `called_by` and
`called_via_link_id`. A v1 Cue can therefore have `called_at` set while `called_by` is null (the column stays out of
`v1.json`; contract-audit lists it as an extra column, as ADR 0131 decision 6 did for `start_tbc`). Each write adds
one `showcaller_link.write` audit event with the link, the operation and the cue.

The creator still answers for the link: every read and write checks, as the creator with the claims switched and
restored, that they are a member of the org holding `show.run_of_show.write` and `show.cue.call` on the project.

### 4. The P2 writes become private cores

`private.call_cue_in_run`, `standby_cue_in_run`, `move_cue_in_run`, `shift_cue_plan_in_run` and
`save_cue_calls_for_cue` hold the rule logic and take the locked running order. `app.call_cue`, `standby_cue`,
`move_cue`, `shift_cue_plan` and `save_cue_calls` keep their signatures, checks, refusals, comments and grants and
call them, as R10's `submit_advance_typed` calls `private.record_advance_answer`. P2's pgTAP suite runs unchanged.
`app.call_cue` now also locks the running order, so a member's call and a portal write serialize.

### 5. Scope is in the WHERE clause

Every portal write looks its cue up with `run_of_show_id = link.run_of_show_id` in the query. A miss answers one
`showcaller_link_scope` body, the same for another running order, project or org and for an id that does not exist,
and writes nothing but a rate event; 20 such answers by one grant in 10 minutes delete the grant. The portal edits,
moves and removes uncalled cues only, never removes an artist's set time, and never edits the running order itself,
its set times, the segment library or custom values. In a read-only org every write is refused before anything is
written: the 1063 trigger fires only for a person, and the portal has none.

### 6. Limits

- A link lasts at most 14 days; by default to the end of the day after the show in the project's zone (P1's
  display default), and a show day already past gets now plus one day. The create dialog warns when a chosen day
  ends before the show.
- A device grant lasts 48 hours or to the link's expiry, whichever is first; a link serves at most 5 devices.
- At most 5 live links per running order.
- 5 wrong codes lock the link; a locked link keeps serving devices that proved the code (P1 decision 5).
- Reads: 7200 an hour per grant (two a second, above the one-second ping debounce plus the 15-second and 60-second
  pulls and the reread after each write) and 40000 an hour per link. Writes: 1800 an hour per grant. A rate refusal
  shows a retry state, never a blank console.
- The pop-out clock takes its data from the portal through a BroadcastChannel and reads by itself only every 15
  seconds, only while no portal is open.
- The device grant cookie is HttpOnly, SameSite=Lax (as P1's; a Strict cookie would ask for the code again on every
  open from an email or a chat and spend a device grant) and scoped to the link's path; Secure on https. Cross-site
  writes are stopped by the proxy, the Origin check of server actions and the path scope.
- The links keep the default 7-year retention, not P1's 2 years: cues reference them through
  `called_via_link_id`, so a link must never be purged before the cues that name it.

### 7. Cue custom fields and their audiences

Cues become a custom field target (A117), with A117's guards; writing a cue's value also takes
`show.run_of_show.write` on its project. Each cue field has audiences: Crew (Atlas), Showcaller (the portal) and
Client (Gateway). Crew is presentation only: members read every value their access allows either way. Showcaller is
enforced by `api_public.showcaller_run` and Client by `api_external.cue_field_values`. Neither outside audience takes
a Person, Money or Email field. Every new cue field starts with Crew.

### 8. Colours are the themed categorical tokens

A custom field choice and a segment take one of `cat-1` to `cat-7`, the `color.viz.cat-*` tokens in light, dark and
sunlight. The label always shows beside the colour, so colour is never the only signal; a `Tag` swatch keeps its
border in forced colors. A segment's colour is one fact stored once, in `app.run_segment_colors`, keyed by the
segment's name in the running order: a cue added to the segment shows it, and a renamed segment has none until one
is set.

### 9. The segment library copies and publishes

A library segment is copied into a running order (`app.insert_library_segment`), after the last called cue, with its
cues and department calls; the copies are edited locally. When the library changes, `app.publish_library_segment`
replaces, in the running orders chosen, each older copy whose cues are all uncalled and none an artist's set time
(Global Elements Manager semantics): local edits to those cues, custom values included, are lost, and the UI says
so. Copies with a called cue (Called) or a set time (Linked) are left untouched; a copy with no live cue, or a run
without one, answers No Instance, so publishing never brings back what a member removed. The version is the
database's counter.

### 10. Clients are kept out of the show channel at three doors

A show channel is a Project group marked `show_channel`, at most one live per project, made only by
`app.open_show_channel`. Add: nobody engaged as Client on the project is added. Read:
`private.my_conversation_ids` drops the channel for a person who reaches the project as Client, so a member who
becomes one reads nothing more, and `app.my_conversations` stays within it. Notify: `app.send_chat_message` notifies
no Client-engaged member.

### 11. Out of scope

- Messaging from the portal: `app.chat_messages.author_membership_id` is NOT NULL, and an outside showcaller has no
  membership. This gives up the "message crew" part of ProductionOS's portal (owner step).
- Compass: it launches on REST sync (decision 51) and needs nothing here.
- The run-of-show PDF: template v2 stays as P2 shipped it.
- Custom fields on P1's display screens and view links; their allowlists are unchanged.
- Importing the new cue columns: P3's worker and edge bundle are unchanged.

### 12. API

Additive v1 operations: `showcallerLinks` (list, get, create, regenerate, revoke, signOutDevices),
`segmentLibrary` (CRUD, insertIntoRun, publish), `segmentLibraryCues`, `segmentLibraryCueCalls`,
`runSegmentInstances` (list, get), `cueFieldAudiences` (list, create, delete) and the Workforce groups actions
`openShowChannel`, `joinShowChannel` and `showChannelStatus`. The portal's open, read and writes stay token RPCs, not
API operations, as ADR 0130 decision 9 keeps P1's. No new capability codes.

## Consequences

- An outside showcaller can run a show from any browser with a link and a code, and every write is attributed to
  the link and audited.
- Producers define rundown columns and colours once, per audience, and keep reusable segments in step across shows.
- The crew talks beside the running cue without a Client reading along.
- The release that carries B3 waits for the owner to accept this ADR and the threat-model rows.
