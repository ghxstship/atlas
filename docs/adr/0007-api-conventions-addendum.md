# ADR 0007: API Conventions Addendum

- Status: Accepted (amends ADR 0003; part of the Wave 1 contract freeze)
- Date: 2026-10-08
- Decider: Orchestrator, on A04's proposal with the OpenAPI v1 draft

## Context

Drafting 1,304 operations exposed five conventions that ADR 0003 left open.

## Decision

1. **Org context comes from the credential.** An API key and an OAuth grant are bound to one organization. A session JWT carries the organization chosen in the context switcher. There is no org header or path segment, and `org_id` is never accepted in a request body.
2. **Paths.** Collections are flat, kebab-case, plural paths; parents are named by filter, not nesting. Actions are `POST /{collection}/{id}/{action}`. Lifecycle changes go through `POST /{collection}/{id}/transitions` with a compare-and-set `expected_state`. `DELETE` is a soft delete to Trash.
3. **Problem types.** `type` is the relative URI `/problems/{slug}` until the docs domain is fixed; it then becomes absolute without a version change, because the slug is the stable part.
4. **Vendor extensions.** `x-xos-table` names the source table on every operation. `x-xos-order` declares the default list order and whether the list is numerically coded.
5. **Unstated lifecycle values.** Lifecycles whose values the spec does not state are Title Case labels checked by pattern until the data agents' enums land. The contract then tightens to the generated database types.

## Consequences

- `@xos/resource-schemas` folds into `@xos/schemas` once A02's capability registry is on `main`: move `src/common` and `src/resources`, rename the dependency, regenerate.
- OAuth scopes and per-operation capabilities are filled from `packages/schemas/capabilities.yaml` after the fold.
- Resource fields are reconciled against generated database types and the Playbook column map (Section 18, gate 14) after A01, A02 and A03 land their tables.
- The oasdiff breaking-change check (gate 20) is wired into CI once a released baseline document exists.
