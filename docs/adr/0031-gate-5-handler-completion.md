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
| `onboardingItems.update`   | `onboarding-item-submission`          | `app.onboarding_items` (0730) grants insert of the engagement and requirement only and no column update but `deleted_at`. The document and submission time are written by `app.submit_onboarding_item`, which only the engaged party may call. The correction replaces the update with the action `onboardingItems.submit`, which calls it.                                                                                                                                                                                        |
| `shipments.transition`     | `shipment-carrier-and-window`         | `app.shipments` (0351, 0440) has no lifecycle column. A shipment's progress is recorded by its dock check-in, gate release and marshalling log entries (journey 20), which have their own operations. Building a shipment lifecycle would duplicate those facts (Section 3.15), so the transition and the `shipment_state` field are retired.                                                                                                                                                                                      |

### Tables built

| Table             | Migration | Operations                                                 | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | --------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.price_books` | 1170      | `priceBooks.list`, `.get`, `.create`, `.update`, `.delete` | Section 7.3 lists `price_books` under money and formats, and the v1 contract documents an org price book for selling items, read with `procurement.catalog.read` and written with `procurement.catalog.write`. No table backed it. The table holds the name and the currency (`currency_code`, correction `price-book-currency-code`); a name appears once per org among live books, and delete is soft. Prices within a book are left to a later additive resource, since the frozen contract has none. |

## Consequences

- The retired operations leave `/v1` while it is a draft, so the published document never offers an operation that every caller is refused.
- The resource coverage list (`packages/api/src/catalog/coverage.ts`) follows the retirements.
