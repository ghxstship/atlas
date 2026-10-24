# ADR 0026: Workforce, Workflow and Wave 6 Decisions

- Status: Accepted
- Date: 2026-10-16
- Decider: Orchestrator

## Context

A29 (workforce), A32 (Gateway and Compass follow-up), A33 (platform workflow), A34 (security fixes), A22 (security review) and A23 (accessibility review) each made decisions that later work relies on. This ADR records them, along with the sitemap additions those agents made.

## Decision

### Sitemap additions

These nodes are part of the Atlas sitemap (amending ADR 0006):

| Area            | Nodes                                                                   | Added by |
| --------------- | ----------------------------------------------------------------------- | -------- |
| Knowledge       | `knowledge.feed`, `handbook`, `forms`, `training`                       | A29      |
| Schedule        | `schedule.events`                                                       | A29      |
| People          | `people.groups`, `chat`, `recognition`, `help-desk`                     | A29      |
| Site operations | `site-ops`, with occupancy, weather, guest check-in, and lost and found | A29      |
| Top level       | `approvals`, `trash`                                                    | A33      |

Proposed record routes stay `?peek` routes until a page claims them: `assets.units.unit`, `logistics.shipment`, `hospitality.fulfillment`, `hospitality.beo`, `hospitality.accommodation-block` and `finance.settlements`. The shell resolves `?peek={recordKey}` on every Atlas route. Collection pages and saved views get the first claim; if nothing claims the key within 600 ms, the shell opens it.

### Workforce (A29)

1. Compass workforce screens live in `packages/workforce-native` as presentational components. Compass owns the copy and the data calls.
2. Weather thresholds are entered per project from its emergency plan, with a source note, because canon has no weather action metrics.
3. Help desk teams extend `support_tickets` with additive columns and read policies. A31's own columns are unchanged.
4. Group ownership lets only non-Viewer roles edit members (0810).

### Gateway and Compass (A32)

1. External PowerSync buckets select explicit base-table columns that equal an `api_external` view. A pgTAP source list mirrors `sync-rules.yaml`, and a test keeps the two identical.
2. Data that a sync rule cannot filter is marked `restOnly` and served only by the REST downloader. Today this covers artist set times and the kiosk roster.
3. Compass writes replay through allowlisted RPCs with ids minted on the device. Photos upload before their RPC.

### Platform workflow (A33)

1. Approval policies gate spend documents inside `private.approve_under_spend_authority`. Orgs without policies behave as before.
2. Thresholds compare only within the policy's currency. Documents in any other currency are always gated.
3. Trash is a view over soft-deleted rows, read with each viewer's own access. Its purge date is the deleted time plus the table's retention, the same rule the retention sweep uses.
4. Templates are versioned rows. Publishing freezes a version. Applying a template runs as the caller, so every guard applies.
5. State labels change display names only. The state machines keep the standard names.
6. An API key needs every scope group its operation's capabilities touch. A mixed operation, such as deciding a purchase order, needs both groups.

### Security (A22 and A34)

1. Every RPC in `private.sync_rpcs` is SECURITY DEFINER and authorizes the caller itself (0935, checked by pgTAP 0935 and 9906).
2. API key scopes are enforced in the database through `private.person_capability_reach` (0936).
3. The allowlists in pgTAP 9900 are security decisions: anon RPCs, owner-rights views and plain-true policies. Widening one needs a threat-model note.
4. Every upload is scanned before anyone but its uploader reads it. Content checks run first: checksum, type sniffing and zip limits. ClamAV runs behind the `VirusScanner` port. Public buckets cannot gate reads, so anything not Clean is removed (1041).
5. API rate limits are counted in Postgres per caller in fixed windows (1040). The in-process limiter is the fallback.
6. The session cookie is `__Host-xos-auth` over https. CSRF protection is the Origin check.
7. The OAuth 2.1 scheme stays in the frozen v1 document until the authorization server exists. Then per-operation scopes move to the API key scheme through an ADR 0023 correction.

### Accessibility (A23)

The accessibility sweep runs outside `pnpm verify`, through `pnpm test:a11y` in Atlas and Gateway against a seeded local stack. Open findings are registered by signature in each sweep's `known.ts`. An entry that stops reproducing fails the sweep, so a fixed finding must also be removed from the list. Gate 8 is release-ready when the sweep is clean and `known.ts` is empty. Human VoiceOver, NVDA and TalkBack passes are still required before the ACRs are published.

## Consequences

- **Production virus scanner:** waits on the owner. Until one runs, attachments stay in Scanning, and field and onboarding files are visible only to their uploader.
- **Message translation:** the workforce chat stores each message's language, but translation waits on a provider.
- **Report runs:** queued runs wait on a `report.run` worker, which A35 is building.

## Amendment (2026-10-23): reporting and blocking (ADR 0033 decision 57)

ADR 0033 decision 57 (2026-10-23) asks for a minimal report and block for user-generated content in Compass before App Store submission, as App Store Review Guideline 1.2 requires: a way to report offensive content and a timely response to reports, and a way to block abusive users. Track compass-trust (RRR-137) built it in migrations 1630 and 1631.

1. **What can be reported.** A feed post of any kind (polls and recognition posts included), a comment on a feed post, and a chat message, direct or in a group: the content one member writes for others to read. In Compass that is the Feed, a conversation and Recognition, where each item by someone else carries a three-dot button; a shout-out is reported as its feed post. Compass shows no comments yet, so a comment is reportable from the database only, for Atlas to offer later. Lost and found entries and help desk requests are operational records that site staff and help desk teams already manage, and are not reportable.

2. **The org's moderators decide, within 24 hours.** The moderators are the members holding `org.communication.write` across the org, Owners and Admins by default: the people who already hide any feed post (0801). A report keeps a snapshot of the text, because moderators are rarely in the conversation, and falls due 24 hours after it arrives. Each moderator is notified at once (`content_report.filed`, a safety notice, so it never waits for a digest), and again once if the report is still open after 24 hours (`content_report.overdue`, an hourly job). Atlas lists the reports at People, Reported Content (sitemap addition `people.moderation`, Owners and Admins), the one due first at the top. Nobody decides about their own content, and the author of a reported item is never told about the report or who filed it.

3. **A90's statement of reasons, not a second moderation system.** A decision takes the parts A90's console uses for listings (1473): the action (Removed or No Action), the ground (`app.moderation_ground`), the rule relied on, the facts and the statement sent to the people involved. Removal hides a post as a moderator's hide does, or deletes a comment or a message. One decision decides every open report on the item; the reporters hear the outcome (`content_report.decided`) and, on removal, the author gets the statement (`content.removed`). Decisions are append-only, and their notices name the org, never the moderator.

4. **Not the platform's console.** A90's console moderates public marketplace listings, which GHXSTSHIP hosts for everyone. Workspace posts and messages are the org's data, processed for it, so they go to the org's own moderators and platform operators never read them.

5. **Blocking reuses A52's blocks.** A person block (1206) already hid profiles both ways. It now also hides, from the blocker only, the blocked person's posts, comments on posts, shout-outs and messages in every conversation, through restrictive read policies, so Compass, Atlas and the API agree and lifting the block shows everything again. Notifications about that content leave the blocker's Inbox and their email, text and push deliveries are recorded Suppressed. A post that requires acknowledgment stays visible: it is an instruction from the org. The blocked person is not told and still sees the blocker's content, and the block still ends no membership or work (Section 4.4.4). Compass blocks from the same three dots, through `app.block_member`, and lists and lifts blocks at Settings, Blocked People (sitemap `settings.profile-privacy`).

6. **Online only.** Reporting and blocking need the server's answer, so Compass sends them at once and says when it is offline instead of queueing them.

### Follow-ups

- An appeal of an org moderator's decision, as A90 offers for listings, is not built; the statement names the rule and the people involved can raise it with the org.
- Atlas has no report button on its own feed and chat pages; the App Store requirement is Compass's.
- The notification kind seed moved to 1639 for the four new kinds; the 2026-10-23 notification decisions (1620 to 1629) may move it too, and the later seed must carry both sets of kinds.
