# ADR 0031: Gate 5 Handler Completion: Retired Operations and New Tables

- Status: Proposed (amends ADR 0023)
- Date: 2026-10-19
- Decider: Orchestrator (proposed by A50, RRR-94)

## Context

Section 18 gate 5 requires a handler and a contract test for every documented operation. After Wave 6, 232 operations had no handler, mostly because their frozen v1 shape could not be filled faithfully from the schema. ADR 0023 lets a module agent correct a frozen shape while v1 is a draft. Some operations have no faithful shape at all: no table backs them, or no caller of the public API can write their table under row level security. For each of those, this ADR records whether the operation was retired through a correction or whether a table was built for it.

Corrections that only change a shape so a handler can serve it are entries in the module files under `packages/api/src/catalog/modules/` and are not repeated here.

## Decision

### Retired operations

| Operation                  | Correction                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moderationActions.create` | `moderation-action-platform-decision` | `app.moderation_actions` (0720) is append-only and written only by the platform: tenants have a read policy and no insert policy. A Digital Services Act decision belongs to the platform, never to the organization that posted the listing. Section 4.10 places the moderation queue in the internal platform operator console, which uses the platform operator session (`private.is_platform_operator`, 0643), not the public API. The Section coverage entry for abuse reports now lists `moderationActions.list` and `.get`. |

### Tables built

None yet.

## Consequences

- The retired operations leave `/v1` while it is a draft, so the published document never offers an operation that every caller is refused.
- The resource coverage list (`packages/api/src/catalog/coverage.ts`) follows the retirements.
