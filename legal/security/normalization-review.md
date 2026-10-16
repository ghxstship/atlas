---
title: Gate 29 Normalization Review
version: 1.0.0
status: Wave 6 review record
owner: A22 Security Review (RRR-41)
---

# Gate 29 Normalization Review

Section 18 gate 29 asks an independent agent to review every migration for Third Normal Form and to
file a finding for any violation not listed in `docs/adr/denormalization-register.md`. This is the
record of that review on main d36918a: 170 migrations, 481 `app` tables, 74 `private` tables and
92 `xpms` tables, with no materialized views.

## Method

1. **Arrays.** The catalog was queried for every array-typed column in `app` and `private`.
2. **JSON.** Every `json` and `jsonb` column was listed with its comment and judged against the ADR
   0002 exceptions: rich text documents, audit diffs and provider payloads.
3. **Stored derived values.** Columns named like totals, counts, balances, sums, scores or
   percentages were listed and checked for a ledger or source they restate, and for
   `attgenerated`.
4. **Restated columns.** Child tables that copy a parent column (`project_id` stamped from a parent)
   were checked against the register. `org_id` on every tenant table is the ADR 0002 convention,
   derived by trigger and never accepted from the caller, so it is not a violation.
5. **Closed lists.** Lifecycle and kind columns were checked to be enums or reference tables.

## Results

| Area                                    | Result                                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Register entries (9)                    | Each stamped `project_id` and `private.sync_scope_grants` is registered with a refresh rule and a measured reason |
| `app.usage_rollups`                     | Registered; written once per closed month                                                                         |
| Audit, event, payload and result JSON   | Within the ADR 0002 exceptions (audit diffs, webhook payloads, Stripe events, idempotency and sync results)       |
| `report_runs`, `export_jobs` row counts | Facts about a run at the time it ran, not derivable later; not violations                                         |
| Delivery `attempt_count`                | No attempts table exists, so the count is the only record of attempts; not a violation                            |
| `invite_links.use_count`                | Memberships do not record the link they came from, so the count is not derivable; not a violation                 |
| Occupancy running totals                | Registered with a refresh rule: [A22-007](findings/A22-007.md)                                                    |
| Forms, surveys and quizzes              | Quiz keys fixed in 1042; the rest registered: [A22-008](findings/A22-008.md)                                      |
| Scope and group arrays                  | Registered with a refresh rule: [A22-009](findings/A22-009.md)                                                    |

## Observations below the finding threshold

- `app.form_submissions.max_score` is computed from the template version's fields at submission
  time. It becomes derivable once A22-008 moves fields into rows. Fix it with A22-008.
- `infra/powersync/docker-compose.yaml` uses the floating image tag `postgres:17-alpine`. It is local
  development only, but pinning a digest matches the supply-chain rule.
