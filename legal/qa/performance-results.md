# Performance results (Section 5.1, Section 18 gate 10)

A37, 2026-10-17, after the fixes for A24-009, A24-010 and A24-004 (RRR-81). Local measurements on
the build machine, which other agents were loading at the same time (load average 20 to 69): a full
Supabase stack (block 576) with the demo seed, production builds served by `next start`, Lighthouse
CI 0.15.1 (Lighthouse 12.6.1, desktop preset, one run per page) in Chromium 1243, and k6 2.3.0 from
the `grafana/k6:2.3.0` image. Laptop numbers show trends and regressions; the Section 5.1
objectives are decided by the staging runs described in `packages/testing/README.md`. A24's first
measurements (main d215afa) are kept in the "Before" columns.

## Route JavaScript

Two measurements of the same budget (200 KB gzip):

- **Route JS (build)**: `pnpm --filter @xos/testing budget:js`, from the production build's
  manifests: the scripts the route itself loads. CI can run it on every pull request (proposed job
  `route-js-budget`). Pages still over budget hold a ceiling in `packages/testing/bundle-ceilings.json`.
- **Lighthouse JS**: `resource-summary:script:size`, every script fetched during the trace. On Atlas
  signed-in pages it adds 60 to 85 KB that Next.js prefetches for the sidebar links in the viewport,
  which belong to the routes those links open.

| App     | Page                              | Before | Route JS (build, A41) | Route JS (build, A46) | Lighthouse JS (A37) | Verdict                |
| ------- | --------------------------------- | ------ | --------------------- | --------------------- | ------------------- | ---------------------- |
| Atlas   | /auth/sign-in                     | 481 KB | 164 KB                | 157 KB                | 189 KB              | Pass                   |
| Atlas   | /demo-productions/home            | 717 KB | 243 KB                | 180 KB                | 347 KB              | Pass                   |
| Atlas   | /demo-productions/projects        | 696 KB | 280 KB                | 219 KB                | 309 KB              | Over (cause 3)         |
| Atlas   | /demo-productions/p/NWS/overview  | 711 KB | 277 KB                | 200 KB                | 321 KB              | Pass (174 bytes under) |
| Atlas   | /demo-productions/inbox           | 632 KB | 241 KB                | 195 KB                | 264 KB              | Pass                   |
| Atlas   | /demo-productions/crew/shifts     | 693 KB | 276 KB                | 197 KB                | 305 KB              | Pass                   |
| Atlas   | /demo-productions/finance/budgets | 712 KB | 312 KB                | 195 KB                | 342 KB              | Pass                   |
| Gateway | /auth/sign-in                     | 519 KB | 184 KB                | 171 KB                | 208 KB              | Pass                   |
| Gateway | /home                             | 528 KB | 193 KB                | 193 KB                | 217 KB              | Pass                   |
| Gateway | /explore                          | 530 KB | 195 KB                | 194 KB                | 219 KB              | Pass                   |
| Gateway | /work                             | 519 KB | 192 KB                | 191 KB                | 208 KB              | Pass                   |
| Gateway | /money                            | 519 KB | 192 KB                | 191 KB                | 208 KB              | Pass                   |
| Docs    | /en-US                            | 466 KB | 150 KB                | 150 KB                | 174 KB              | Pass                   |
| Docs    | /en-US/reference                  | 466 KB | 150 KB                | 150 KB                | 174 KB              | Pass                   |
| Docs    | /en-US/guides/getting-started     | 466 KB | 150 KB                | 150 KB                | 174 KB              | Pass                   |
| Docs    | /en-US/help                       | 466 KB | 150 KB                | 150 KB                | 174 KB              | Pass                   |

What came out (A24-009): the two-locale message catalog (305 KB on every page), Zod and the YAML
parser through `@xos/ia` (61 KB), the help article bodies (20 KB), the visx chart library on pages
without a chart (15 KB), and the table code on Atlas Home (17 KB). The README section "Route
JavaScript budget" lists the two rules that keep them out.

What A46 took out (RRR-90, ADR 0027 amendment of 2026-10-18):

- **Shell overlays:** the command menu, help and Aurora panels, session dialog, record peek and Radix menus now load on first use.
- **Messages:** they are precompiled, so the ICU parser no longer ships.
- **`@xos/ui` modules:** split one export per file.
- **Conditional components:** views, sheets, forms and peeks a page renders only in some states now go through `next/dynamic`.

Six of the seven Atlas signed-in key pages are now under 200 KB.

What remains, with its cause:

1. **Framework, on every page.** Next.js 16 with React 19 is 128 KB of every page, which leaves 72 KB for the app.
2. **Project overview is at the limit.** It is 204,626 bytes against a 204,800-byte budget. Any addition to that page needs an equal cut.
3. **Projects (219 KB, ceiling 225,464 bytes).** Its default table view needs TanStack Table and Virtual (22 KB). `@xos/ui` DataTable registers every TanStack feature (resizing, pinning, ordering, cell selection, expanding, pagination). Registering only the features each table uses is the next reduction. It is a design-system change for every table, so it is tracked under A24-009 and not done in A46.

## Lighthouse against the gate 10 budgets

| App     | Page                              | Before | Route JS (build, A41) | Route JS (build, A46) | Lighthouse JS (A37) | Verdict                |
| ------- | --------------------------------- | ------ | --------------------- | --------------------- | ------------------- | ---------------------- |
| Atlas   | /auth/sign-in                     | 90     | 100                   | 157 KB                | 685 ms              | Pass                   |
| Atlas   | /demo-productions/home            | 99     | 100                   | 180 KB                | 835 ms              | Pass                   |
| Atlas   | /demo-productions/projects        | 97     | 100                   | 219 KB                | 866 ms              | Over (cause 3)         |
| Atlas   | /demo-productions/p/NWS/overview  | 99     | 100                   | 200 KB                | 837 ms              | Pass (174 bytes under) |
| Atlas   | /demo-productions/inbox           | 99     | 100                   | 195 KB                | 846 ms              | Pass                   |
| Atlas   | /demo-productions/crew/shifts     | 98     | 100                   | 197 KB                | 948 ms              | Pass                   |
| Atlas   | /demo-productions/finance/budgets | 98     | 100                   | 195 KB                | 889 ms              | Pass                   |
| Gateway | /auth/sign-in                     | 100    | 100                   | 171 KB                | 591 ms              | Pass                   |
| Gateway | /home                             | 100    | 100                   | 193 KB                | 671 ms              | Pass                   |
| Gateway | /explore                          | 100    | 100                   | 194 KB                | 632 ms              | Pass                   |
| Gateway | /work                             | 100    | 100                   | 191 KB                | 677 ms              | Pass                   |
| Gateway | /money                            | 100    | 100                   | 191 KB                | 671 ms              | Pass                   |
| Docs    | /en-US                            | 100    | 100                   | 150 KB                | 511 ms              | Pass                   |
| Docs    | /en-US/reference                  | 100    | 100                   | 150 KB                | 551 ms              | Pass                   |
| Docs    | /en-US/guides/getting-started     | 100    | 100                   | 150 KB                | 510 ms              | Pass                   |
| Docs    | /en-US/help                       | 100    | 100                   | 150 KB                | 511 ms              | Pass                   |

LCP, CLS and TBT are inside budget on every page and accessibility scores 100 everywhere. LCP fell
on every page (Atlas signed-in 889 to 1409 ms before, 835 to 948 ms now). Atlas sign-in scored 90 on
this run with the same LCP and no blocking time; one desktop run on a loaded machine.

## API latency (A24-010)

Every API response now carries `Server-Timing` (`auth`, `rate`, `validate`, `handler`). Single
unloaded requests for the load member (load-99-1, Producer in the demo tenant), median of 30:

| Request | Before | After | After, by phase |
| --- | --- | --- | --- | --- | --- | --- |
| GET /me | 200 ms | 7 ms | auth 0.3, rate limit 2.5, handler 2.6 ms |
| GET /projects?limit=25 | 236 ms | 9 ms | auth 0.3, rate limit 2.3, handler 5.2 ms |
| GET /records?limit=50 | 347 ms | 16 ms | auth 0.3, rate limit 2.3, handler 11.1 ms |
| GET /notifications?limit=20 | 168 ms | 6 ms | auth 0.2, rate limit 2.1, handler 2.3 ms |

Before the fix, credential resolution took 36 to 41 ms of every request: a round trip to Supabase
Auth (`getUser`) and the person and membership reads. Sessions are now verified against the
project's JWKS in the process, and the identity is reused for 30 seconds. `records.list` lost 40 ms
of handler time: the `record_display_key` computed column re-evaluated the projects read policy once
per row. The Postgres rate limiter costs 2 to 3 ms and stays a write per request; batching it would
trade exactness across instances for 2 ms, so it is left as it is.

## k6 smoke (reduced scale)

Each run: 30 s, ramp to the smoke scale, then hold. Users come from
`packages/testing/load/fixtures/load-tenants.sql` (40 Producers in the demo tenant, 20 in two empty
load tenants).

| Script | Scale | Requests | Reads p50 / p95 (before) | Writes p50 / p95 (before) | Result |
| --- | --- | --- | --- | --- | --- | --- |
| api.js, platform | 20 users, two empty tenants | 2,024 | 9.4 / 17.2 ms (61 / 268 ms) | no writes (no record to copy) | Pass, 0 % errors |
| api.js, tenant | 10 users, demo tenant | 1,034 | 9.0 / 18.4 ms (107 / 513 ms) | create record 32.6 / 44.4 ms (113 / 623 ms) | Pass, 0 % errors |
| compass-show.js | 25 devices | 1,385 | 3.8 / 5.8 ms | apply 6.5 / 20.3 ms; replay 2.1 / 2.8 ms | Pass (A24's run; path not changed) |

Both API profiles now pass their Section 5.1 thresholds (reads p95 under 250 ms, writes p95 under
400 ms, p99 under 800 ms, errors under 1 %) with a wide margin, and served twice the requests in the
same 30 seconds.
