# XOS 4.0 Build Report (draft)

Drafted by A47 (RRR-91) on main e40eddf, 2026-10-18, for the orchestrator to complete at release
(Section 21). The release has not happened: there is no production deploy, no v4.0.0 tag and no
published package. Figures are measured from the repository unless a source is named. The gate
detail is in [legal/qa/gate-status.md](legal/qa/gate-status.md).

## What was built

One backend, one API and one design system behind three shells:

- **Atlas** (`apps/atlas`): the org workspace. Every module in the sitemap (`apps/atlas/ia/sitemap.yaml`),
  the shell with command menu, peek, views, help and Aurora panels, settings, white label, partner
  console, imports, custom objects, reports and dashboards.
- **Gateway** (`apps/gateway`): the external portal for the eight role types (crew, staff, vendor,
  contractor, artist and representative, client, sponsor), token flows, account claim, public
  profiles and Explore.
- **Compass** (`apps/compass`): the Expo field app with offline sync, clock, scan, incidents,
  inspections, run of show, kiosk, Live Activity and account deletion.
- **Docs** (`apps/docs`): the API reference, guides and help center in en-US and es-US.
- **Platform**: Supabase Postgres 17 with 219 migrations, the Hono and Zod API with its generated
  OpenAPI 3.1 document, TypeScript and Python SDKs, CLI, MCP server, integrations, Edge Functions,
  the canon importer and the reliability stack in `infra/`.

## Final stack versions

From ADR 0001 (pinned; see the ADR for deviations).

| Tool or package   | Version                     |
| ----------------- | --------------------------- |
| Node.js           | 22.14.0 (engines >=22.12.0) |
| pnpm              | 10.15.1                     |
| Turborepo         | 2.11.7                      |
| TypeScript        | 6.0.3                       |
| Vitest            | 5.0.3                       |
| Playwright        | 1.64.0                      |
| Supabase CLI (CI) | 2.120.0                     |
| Postgres          | 17                          |
| Next.js           | 16.4.0                      |
| React             | 19.3.0                      |
| Hono              | 4.13.13                     |
| Zod               | 4.6.5                       |
| Expo              | 57.0.27                     |
| React Native      | 0.87.1                      |
| Tailwind CSS      | 4.3.3                       |

## ADR index

| ADR  | Title                                                             |
| ---- | ----------------------------------------------------------------- |
| 0001 | Stack and Pinned Versions                                         |
| 0002 | Schema Conventions                                                |
| 0003 | API Conventions                                                   |
| 0004 | Migration Ranges and Path Ownership                               |
| 0005 | Wave 1 Ownership Clarifications                                   |
| 0006 | Sitemap Interpretation Decisions                                  |
| 0007 | API Conventions Addendum                                          |
| 0008 | Identity and Access Rules                                         |
| 0009 | Design Tokens, Contrast and Themes                                |
| 0010 | Localization and Right-to-Left Layout                             |
| 0011 | Preview Data and Brand Slots                                      |
| 0012 | Canon Rulings                                                     |
| 0013 | Responsive and Cross-Engine Rules                                 |
| 0014 | Wave 1 Contract Freeze                                            |
| 0015 | Linear Tracking and Commit Sync                                   |
| 0016 | Domain Data Decisions                                             |
| 0017 | Atlas Shell Decisions                                             |
| 0018 | Pricing: Paid Plans, First Project Free, Plan Seed Numbering      |
| 0019 | Engagement and Marketplace Decisions                              |
| 0020 | Plan Packaging: Atlas in Every Plan, Aurora AI and Legend by Tier |
| 0021 | Conventions for Running Agents in Parallel                        |
| 0022 | Module Migration Ranges and Late Slots                            |
| 0023 | Corrections to the Frozen v1 Contract                             |
| 0024 | Integrations and Developer Surface                                |
| 0025 | Reliability and Operations                                        |
| 0026 | Workforce, Workflow and Wave 6 Decisions                          |
| 0027 | Performance Budgets and Delivery                                  |
| 0028 | Compass Launch Contracts                                          |
| 0029 | Individual Payees, Reporting Delivery and Party Notifications     |

The denormalization register is `docs/adr/denormalization-register.md`.

## Database

Migration count by range (219 files):

| Range | Count | Range | Count |
| ----- | ----- | ----- | ----- |
| 00xx  | 1     | 06xx  | 15    |
| 01xx  | 12    | 07xx  | 22    |
| 02xx  | 8     | 08xx  | 15    |
| 03xx  | 24    | 09xx  | 37    |
| 04xx  | 27    | 10xx  | 26    |
| 05xx  | 13    | 11xx  | 19    |

Counted from the migration source: 611 `create table`, 1,172 `create function`, 271 `create view`
and 111 `create policy` statements (more policies are created in loops). The orchestrator should
replace these with catalog counts from a fresh `supabase db reset` at release. The A22
normalization review counted 481 `app`, 74 `private` and 92 `xpms` tables on d36918a.

## API

The OpenAPI document (`packages/api/openapi/v1.json`) documents 1,550 operations; 1,315 have
handlers (84.8 %). The modules with operations still unhandled are listed in gate 5 of the gate
status.

## Tests

| Suite                       | Count                                          | Where                           |
| --------------------------- | ---------------------------------------------- | ------------------------------- |
| Vitest files                | 290                                            | every workspace package         |
| pgTAP suites                | 186 (plus the RLS benchmark and shared worlds) | `supabase/tests`                |
| Playwright specs            | 63                                             | `apps/{atlas,gateway,docs}/e2e` |
| Maestro flows               | 17                                             | `apps/compass/.maestro/flows`   |
| Storybook axe and baselines | every story in 4 modes, 3 engines              | `packages/ui/test/visual`       |

Coverage: `packages/schemas`, `packages/data` and `packages/api` enforce 85 % lines in CI; every
other package with `--coverage` enforces its own threshold. The release report should copy the
per-package figures from the `checks` job.

## Journey coverage

From [legal/qa/journey-coverage.md](legal/qa/journey-coverage.md): 66 of 70 journeys covered, 2
partial (53, 57) and 2 missing (25, 58). Journey 25 needs VoiceOver and TalkBack on devices;
journey 58 is A45's.

## Gate table summary

| Status           | Count | Gates                                                                 |
| ---------------- | ----- | --------------------------------------------------------------------- |
| Pass             | 10    | 1, 2, 3, 13, 15, 18, 23, 25, 32, 33                                   |
| Partial          | 19    | 4, 5, 6, 8, 9, 10, 11, 12, 14, 16, 17, 20, 22, 24, 26, 28, 29, 30, 31 |
| Blocked on owner | 2     | 7, 21                                                                 |
| Fail             | 2     | 19 (no document templates or veraPDF), 27 (no cognitive load lint)    |

Section 20.1: no platform criterion is complete, because each must also pass in deployed staging;
items 5, 9 and 11 are blocked on the owner.

## Findings

| Source                                              | Findings | Open                                                                                 |
| --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| Security, A22 (`legal/security/findings`)           | 15       | None. A22-015 (OAuth authorization server) is Accepted under ADR 0026                |
| Accessibility, A23 (`legal/accessibility/findings`) | 17       | None. A23-014 is fixed with screen reader confirmation owed                          |
| QA, A24 (`legal/qa/findings`)                       | 10       | A24-009 (High): Atlas signed-in route JavaScript over budget, held by ceilings (A46) |
| QA, A38                                             | 7        | None                                                                                 |
| Simulator, SIM                                      | 7        | None                                                                                 |
| Gate audit, A47                                     | 1        | A47-001 (High): 455 Playbook field targets in `app` do not resolve                   |

Section 20.3 asks for zero open High or Critical findings: A24-009 and A47-001 are open and High.

## Performance against budgets

From [legal/qa/performance-results.md](legal/qa/performance-results.md) (A37, local, loaded
machine): LCP 511 to 948 ms, CLS at most 0.088, TBT 0 ms and accessibility 100 on all 16 measured
pages. Route JavaScript passes on Gateway, docs and Atlas sign-in; Atlas signed-in pages are 241 to
312 KB against 200 KB. k6 smoke: reads p95 17 to 18 ms, writes p95 44 ms, 0 % errors. The Section
5.1 objectives are decided by staging runs that have not happened.

## Deployed URLs and package versions

None yet. The Vercel project `atlas` points at the staging Supabase project `xos-atlas-staging`,
which has not received the current migrations. Every workspace package is version 0.0.0 and private;
nothing is published. Compass is not in TestFlight or Play internal testing.

## Canon

The importer validates every Section 2 count (`canon/import/test/model.test.ts`,
`generate.test.ts`). The canon generation and ratification state in effect is recorded in
`canon/rulings` and ADR 0012; the orchestrator re-verifies the counts against the Bible at release.

## Known gaps

1. Gate 19: no versioned templates or tagged PDF renders for the 12 Section 11.9 documents, and no
   veraPDF.
2. Gate 27: no cognitive load lint.
3. Gate 5: 235 documented operations without handlers, so API parity (Section 19.6) is incomplete.
4. Gate 14: A47-001.
5. Gate 10: A24-009, Atlas shell route JavaScript.
6. Gate 31: 108 Atlas sitemap nodes without a page help article.
7. Gates 6, 8, 16, 17, 22, 26 and 28 depend on CI jobs that are written but not merged, or not
   written (`legal/qa/gate-status.md`, proposed CI changes in the A47 report).
8. Gate 29: 49 migrations since the normalization review.
9. Gate 11: Compass build tooling advisories, CodeQL, Semgrep and database advisors.

## Owner decisions

| Decision                                                                                               | Unblocks                     | Console                                                                                       |
| ------------------------------------------------------------------------------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` repository secret and an eval budget                                               | Gate 21                      | https://github.com/ghxstship/atlas/settings/secrets/actions, https://console.anthropic.com    |
| Firefox and WebKit e2e legs in CI                                                                      | Gate 6                       | https://github.com/ghxstship/atlas/actions                                                    |
| macOS runner or self-hosted Mac for Maestro, Android emulator job                                      | Gates 7, 22, 26              | https://github.com/ghxstship/atlas/settings/actions/runners                                   |
| CodeQL default setup                                                                                   | Gate 11                      | https://github.com/ghxstship/atlas/settings/security_analysis                                 |
| Counsel review of FSL-1.1-Apache-2.0 (`sentry`), LGPL-3.0-or-later (sharp libvips) and `buffers` 0.1.1 | Gate 11                      | `pnpm --filter @xos/config licenses:check`                                                    |
| Database password for `supabase db push` to staging                                                    | Section 20.1                 | https://supabase.com/dashboard/project/fquuqnzlpobaawucczgq                                   |
| `legal/OWNER_INPUTS.md` Part A facts and counsel review                                                | Section 20.1 item 9          | `legal/OWNER_INPUTS.md`                                                                       |
| Canon rulings for `canon:check` and the Playbook to Bible diff                                         | Gate 14, Section 20.1 item 7 | Linear RRR-52                                                                                 |
| Paid reliability items (PITR, log drains, regional synthetics, PowerSync hosting)                      | Section 20.1 item 11         | https://supabase.com/dashboard, https://vercel.com/dashboard, https://dashboard.powersync.com |
| Upload virus scanner choice                                                                            | ADR 0026                     | `infra/runbooks/hosted-security-settings.md`                                                  |
| Apple and Google developer accounts for TestFlight and Play internal testing                           | Section 20.3                 | https://appstoreconnect.apple.com, https://play.google.com/console                            |
