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
