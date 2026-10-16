# Performance results (Section 5.1, Section 18 gate 10)

A24, 2026-10-16, main d215afa plus this branch. Local measurements on the build machine: a full
Supabase stack (block 574) with the demo seed, production builds served by `next start`, Lighthouse
CI 0.15.1 (Lighthouse 12.6.1, desktop preset, one run per page) in Chromium 1243, and k6 2.3.0 from
the `grafana/k6:2.3.0` image. Laptop numbers show trends and regressions; the Section 5.1
objectives are decided by the staging runs described in `packages/testing/README.md`.

## Lighthouse against the gate 10 budgets

Budgets: LCP under 2.5 s, CLS under 0.1, INP under 200 ms (Total Blocking Time in the lab), route
JavaScript under 200 KB gzip. Accessibility must score 100.

| App     | Page                              | Performance | Accessibility            | LCP     | CLS   | TBT  | Route JS (gzip) | Verdict   |
| ------- | --------------------------------- | ----------- | ------------------------ | ------- | ----- | ---- | --------------- | --------- |
| Atlas   | /auth/sign-in                     | 100         | 100                      | 644 ms  | 0.000 | 0 ms | 481 KB          | Fail (JS) |
| Atlas   | /demo-productions/home            | 99          | 100                      | 889 ms  | 0.000 | 0 ms | 717 KB          | Fail (JS) |
| Atlas   | /demo-productions/projects        | 95          | 100                      | 1242 ms | 0.099 | 0 ms | 696 KB          | Fail (JS) |
| Atlas   | /demo-productions/p/NWS/overview  | 97          | 100                      | 1203 ms | 0.000 | 0 ms | 711 KB          | Fail (JS) |
| Atlas   | /demo-productions/inbox           | 98          | 100                      | 1121 ms | 0.000 | 0 ms | 632 KB          | Fail (JS) |
| Atlas   | /demo-productions/crew/shifts     | 95          | 100                      | 1409 ms | 0.065 | 0 ms | 693 KB          | Fail (JS) |
| Atlas   | /demo-productions/finance/budgets | 95          | 100                      | 1326 ms | 0.075 | 0 ms | 712 KB          | Fail (JS) |
| Gateway | /auth/sign-in                     | 100         | 100                      | 707 ms  | 0.000 | 0 ms | 519 KB          | Fail (JS) |
| Gateway | /home                             | 99          | 100                      | 965 ms  | 0.000 | 0 ms | 528 KB          | Fail (JS) |
| Gateway | /explore                          | 100         | 98, fixed on this branch | 742 ms  | 0.000 | 0 ms | 530 KB          | Fail (JS) |
| Gateway | /work                             | 99          | 100                      | 868 ms  | 0.000 | 0 ms | 519 KB          | Fail (JS) |
| Gateway | /money                            | 100         | 100                      | 663 ms  | 0.000 | 0 ms | 519 KB          | Fail (JS) |
| Docs    | /en-US                            | 90          | 100                      | 781 ms  | 0.000 | 0 ms | 466 KB          | Fail (JS) |
| Docs    | /en-US/reference                  | 100         | 100                      | 791 ms  | 0.000 | 0 ms | 466 KB          | Fail (JS) |
| Docs    | /en-US/guides/getting-started     | 100         | 100                      | 750 ms  | 0.000 | 0 ms | 466 KB          | Fail (JS) |
| Docs    | /en-US/help                       | 100         | 100                      | 708 ms  | 0.000 | 0 ms | 466 KB          | Fail (JS) |

LCP, CLS and TBT are inside budget on every page; Atlas Projects sits at the CLS edge (0.099).
Route JavaScript fails everywhere, mainly because the full two-locale message catalog ships to the
browser on every page (finding A24-009). Gateway Explore lost two accessibility points to heading
order (card titles were h3 under the page h1); the result count is now the h2, a cheap fix made here.

## k6 smoke (reduced scale)

Each run: 30 s, ramp to the smoke scale, then hold. Users come from
`packages/testing/load/fixtures/load-tenants.sql` (40 Producers in the demo tenant, 20 in two empty
load tenants).

| Script           | Scale                       | Requests | Reads p50 / p95 | Writes or sync p50 / p95                       | Result                                                                    |
| ---------------- | --------------------------- | -------- | --------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| api.js, platform | 20 users, two empty tenants | 1,524    | 61 / 268 ms     | no writes (no record to copy in empty tenants) | Read p95 over 250 ms                                                      |
| api.js, tenant   | 10 users, demo tenant       | 648      | 107 / 513 ms    | create record 113 / 623 ms                     | Read and write p95 over objective (A24-010)                               |
| compass-show.js  | 25 devices                  | 1,385    | 3.8 / 5.8 ms    | apply 6.5 / 20.3 ms; replay 2.1 / 2.8 ms       | Pass; 326 mutations applied once each, replays returned the stored result |

The Compass sync path through `app.apply_sync_mutation` is far inside its 5 s objective, including
the hot occupancy counter row every device writes. The API path is the risk: the database answers in
under 10 ms, and the per-request API runtime adds the rest (A24-010).
