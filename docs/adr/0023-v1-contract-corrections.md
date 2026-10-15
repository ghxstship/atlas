# ADR 0023: Corrections to the Frozen v1 Contract

- Status: Proposed (amends ADR 0014)
- Date: 2026-10-15
- Decider: Orchestrator

## Context

ADR 0014 froze the OpenAPI v1 document at Wave 1 exit (1,307 operations), when most of the schema did not exist yet. The frozen request and response shapes were written from the spec, not from tables. Wave 3 module agents now find that their tables cannot fill those shapes faithfully:

- `created_by` and `updated_by` are required UUIDs in every tenant read shape, but the columns are NULL for seed, platform and system rows.
- Create bodies omit NOT NULL columns that have no default (`ProjectCreate` has no `project_key` or `time_zone`).
- Fields the contract requires are nullable columns, fields the contract names do not exist, and some resources have a different shape altogether (positions as a count instead of rows, validity in months instead of days, `role_type` instead of `pool_kind`).

Agents leave those operations without handlers, so the API cannot reach parity with the UI (Section 19.6). Changing a frozen operation is a breaking change, and Section 18 gate 20 forbids breaking changes within `/v1`. But v1 has never been released: `API_VERSION` is `1.0.0-draft.1`, no SDK has shipped and no third party depends on it.

## Decision

1. **Corrections while v1 is a draft.** While `API_VERSION` is a `1.0.0-draft.N` prerelease, a frozen operation or component may be corrected to match the implemented schema. Once 1.0.0 is released, the rule of ADR 0014 and Section 10.1 applies without exception: changes within `/v1` are additive only, and a breaking change needs `/v2`.
2. **Every correction is an entry.** A correction exists only as an entry in the machine-readable list: contract-wide entries in `packages/api/src/catalog/corrections.ts`, module entries in the module's own file `packages/api/src/catalog/modules/<module>.ts` (next to its additive operations, so parallel branches never edit a shared list, ADR 0021). Each entry carries an id, the draft it entered (`since`), the module, the resources and components it changes, what changes, why (naming the table, view or migration), and the edit itself. `CORRECTIONS`, exported from `@xos/api`, is the resolved list in the order applied.
3. **Edits are declarative.** `packages/api/src/catalog/correct.ts` provides the edits: field nullability, removal, rename, addition with its create and update placement, server-set and immutable fields, verb and action removal, actions with capabilities, and the default order (including a descending feed order). Edits never mutate the frozen definitions in `@xos/schemas`, which stay as frozen.
4. **Gate 20 enforces the list.** `packages/api/test/corrections.test.ts` keeps a digest of every operation and component of the frozen document (`packages/api/src/catalog/frozen-v1.digest.json`, cut once from commit 5d269b9 and never regenerated while v1 is a draft). It fails when:
   - the uncorrected frozen catalog no longer generates the frozen document, so any edit to a frozen source outside a correction fails;
   - the corrected document changes, adds or removes a frozen operation or component that no entry lists;
   - an entry changes nothing it lists;
   - an entry is dated later than the current draft, or any entry exists once `API_VERSION` is a release.
5. **Each draft that adds corrections bumps `API_VERSION`.** This ADR's corrections ship as `1.0.0-draft.2`. The info version tells SDK generators and reviewers that the draft changed shape.
6. **Proposing a correction.** A module agent adds an entry to its own module file in its own branch, with a reason, regenerates the document and the operation types, updates its handler contract tests where the shape changed, and lists the entry in its completion report. The orchestrator reviews every entry at merge (packages/api/README.md, "Correcting the frozen contract").
7. **At release.** Releasing 1.0.0 re-cuts the digest from the released document and empties the correction list; the entries stay recorded in this ADR's register. From then on gate 20 compares against the released document and accepts no corrections.

## Alternatives considered

- **Edit `@xos/schemas` directly.** It hides which frozen shapes changed and why, and gate 20 could not tell a correction from an accident.
- **Leave the operations document-only until v2.** API parity (Section 19.6) would fail for every built module, and v2 would be needed before v1 ever shipped.
- **Add new operations beside the wrong ones.** It doubles the surface with operations nobody can serve and leaves broken shapes in the published contract.

## Consequences

- Module agents can write handlers for operations their schema can now fill. The completion report of A04C lists them by module.
- The frozen digest is a second source of truth beside `openapi/v1.json`; both are generated, and neither is edited by hand.
- Corrections are visible in review as entries with reasons, not as diffs of a 4.8 MB document.
