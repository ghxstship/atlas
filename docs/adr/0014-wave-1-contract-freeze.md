# ADR 0014: Wave 1 Contract Freeze

- Status: Accepted
- Date: 2026-10-09
- Decider: Orchestrator (Section 19.2, Wave 1 exit)

## Context

Section 19.2 ends Wave 1 by freezing the contract set. Every Wave 1 agent has merged to `main`: A01 canon, A02 platform data, A04 API contract, A05 design system foundations, A21 legal and the information architecture agent. On `main` at the time of this ADR, `pnpm verify` passes and `supabase test db` passes 529 tests in 10 files with every migration applied from empty.

## Decision

These artifacts are frozen. A change to any of them now needs a superseding ADR.

| Contract                 | Source of truth                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| Schema conventions       | ADR 0002, amended by ADR 0008                                                                          |
| API conventions          | ADR 0003, amended by ADR 0007                                                                          |
| Canon schema and rulings | `supabase/migrations/0100` to `0199`, `canon/rulings/owner-rulings.yaml`, ADR 0012                     |
| Playbook column map      | `canon/map/playbook-columns.yaml` (916 columns: 823 field, 93 computed)                                |
| Sitemaps                 | `apps/atlas/ia/sitemap.yaml`, `apps/gateway/ia/sitemap.yaml`, `apps/compass/ia/sitemap.yaml`, ADR 0006 |
| Permissions              | `packages/schemas/capabilities.yaml` (257 capabilities, 28 groups)                                     |
| Plans                    | `packages/schemas/plans.yaml`                                                                          |
| OpenAPI v1               | `packages/api/openapi/v1.json` (1,307 operations), generated from `packages/api` and `@xos/schemas`    |
| Tokens                   | `packages/tokens/xos.tokens.json` (169 tokens), equal to `design/tokens.json`, ADR 0009                |
| Component strings        | the `ui` namespace in `packages/i18n` (319 keys per locale), ADR 0010                                  |
| Component prop contracts | `design/xos-design-system/components/index.d.ts`                                                       |

Additive changes stay allowed without an ADR: new API operations within `/v1`, new capabilities, new i18n keys, new sitemap nodes that respect ADR 0006, and new tables in an agent's own migration range.

## Open owner decisions (do not block Wave 2)

1. Playbook to Bible differences that keep `canon:check` failing, held in `xpms.intake` and reported in `canon/reports/playbook-bible-diff.md`. The largest group is item prices: the Playbook prices about 890 items in each of the three grades that the Bible leaves unpriced. The rest are label casing, GL descriptions, cost centers, Landlord, three role codes and 32 enumeration labels.
2. Em dash substitution: 28 Bible values had em dashes, now stored with a spaced hyphen.
3. Canon values containing words the finish guard reserves: items whose names mark them as stand-ins awaiting real values (a real doctrine conflict) and non-alcoholic drink items whose names only resemble a reserved word (a false positive). See the `guard-reserved-word` findings in `canon/reports/doctrine-findings.md`.
4. Bible inconsistencies listed in `canon/reports/doctrine-findings.md`, including items and touchpoints naming "Show" or "Procurement" as a phase, and tab 27 labeling department 4000 as Build.
5. Whether Bible tab 27 roles are retired in favor of the Roles Library (D12).
6. Whether D13 covers item-level and counterparty GL accounts.
7. Canon relationships the files never state: unit dimensions, element tags, permits, metrics and GTINs, the discipline-to-team link, and price band confidence.
8. The CSMIA26 Production Template rows name a real activation (Section 3.14). They stay unpublished and readable only by `service_role`.
9. Plan prices for Core, Pro, Team and Enterprise, and the annual discount.
10. Legal owner inputs in `legal/OWNER_INPUTS.md`, which gate publishing `/legal`.
11. Native review of es-US navigation and component labels (Section 15).

## Wave 2 carry-overs

- The engagement contract's `engagement_resolved` reads `rc.standard_rate`; canon stores `standard_rate_minor`, so `agreed_rate` moves to minor units when A03 and A28 implement it.
- A03 extends `private.scope_org` and `private.is_assigned_to_scope` to projects and records (ADR 0008).
- The hand-written plan seed in `0201` duplicates the generated `0207`; the orchestrator removes it in its own correction range once Wave 2 starts.
- CI gains `canon:check` once the owner resolves decision 1, and the oasdiff gate once v1 has a released baseline.
