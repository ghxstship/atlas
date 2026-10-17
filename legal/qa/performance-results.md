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

| App     | Page                              | Before | Route JS (build, A41) | Lighthouse JS (A37) | Verdict              |
| ------- | --------------------------------- | ------ | --------------------- | ------------------- | -------------------- |
| Atlas   | /auth/sign-in                     | 481 KB | 164 KB                | 189 KB              | Pass                 |
| Atlas   | /demo-productions/home            | 717 KB | 243 KB                | 347 KB              | Over (cause 2)       |
| Atlas   | /demo-productions/projects        | 696 KB | 280 KB                | 309 KB              | Over (cause 2, 3)    |
| Atlas   | /demo-productions/p/NWS/overview  | 711 KB | 277 KB                | 321 KB              | Over (cause 2, 3)    |
| Atlas   | /demo-productions/inbox           | 632 KB | 241 KB                | 264 KB              | Over (cause 2)       |
| Atlas   | /demo-productions/crew/shifts     | 693 KB | 276 KB                | 305 KB              | Over (cause 2, 3)    |
| Atlas   | /demo-productions/finance/budgets | 712 KB | 312 KB                | 342 KB              | Over (cause 2, 3, 4) |
| Gateway | /auth/sign-in                     | 519 KB | 184 KB                | 208 KB              | Pass                 |
| Gateway | /home                             | 528 KB | 193 KB                | 217 KB              | Pass                 |
| Gateway | /explore                          | 530 KB | 195 KB                | 219 KB              | Pass                 |
| Gateway | /work                             | 519 KB | 192 KB                | 208 KB              | Pass                 |
| Gateway | /money                            | 519 KB | 192 KB                | 208 KB              | Pass                 |
| Docs    | /en-US                            | 466 KB | 150 KB                | 174 KB              | Pass                 |
| Docs    | /en-US/reference                  | 466 KB | 150 KB                | 174 KB              | Pass                 |
| Docs    | /en-US/guides/getting-started     | 466 KB | 150 KB                | 174 KB              | Pass                 |
| Docs    | /en-US/help                       | 466 KB | 150 KB                | 174 KB              | Pass                 |

What came out (A24-009): the two-locale message catalog (305 KB on every page), Zod and the YAML
parser through `@xos/ia` (61 KB), the help article bodies (20 KB), the visx chart library on pages
without a chart (15 KB), and the table code on Atlas Home (17 KB). The README section "Route
JavaScript budget" lists the two rules that keep them out.

What remains, with its cause:

1. **Framework and shell, on every page.** Next.js 16 with React 19 is 128 KB of every page, which
   leaves 72 KB for the app. The next-intl runtime with its ICU parser adds 7 KB; precompiling
   messages is the next reduction. Icons no longer count (A41, ADR 0027): `@xos/ui` `<Icon>` draws
   from one SVG sprite of the 207 registered icons (10 KB gzip), which the bundler emits under
   `/_next/static/media` with a content hash, so a browser fetches it once and caches it. That took
   15 to 19 KB off every page and brought Gateway under budget; its ceilings are gone.
2. **The Atlas shell (about 105 KB over the framework).** Command menu (cmdk), menus and dialogs
   (Radix), the sitemap the breadcrumbs and help read on the client (6 KB), the help index (4 KB),
   the help and Aurora panels (8 KB) and the `ui` catalog (4 KB). Signed-in Atlas pages cannot reach
   200 KB without a smaller shell.
3. **Tables.** List pages default to the table view, which needs TanStack Table and Virtual (17 KB).
4. **Charts.** Finance budgets draws a chart (visx, 15 KB) and its module set is the largest (13 KB).

## Lighthouse against the gate 10 budgets

| App     | Page                              | Performance | Accessibility | LCP    | CLS   | TBT  |
| ------- | --------------------------------- | ----------- | ------------- | ------ | ----- | ---- |
| Atlas   | /auth/sign-in                     | 90          | 100           | 685 ms | 0.000 | 0 ms |
| Atlas   | /demo-productions/home            | 99          | 100           | 835 ms | 0.000 | 0 ms |
| Atlas   | /demo-productions/projects        | 97          | 100           | 866 ms | 0.088 | 0 ms |
| Atlas   | /demo-productions/p/NWS/overview  | 99          | 100           | 837 ms | 0.038 | 0 ms |
| Atlas   | /demo-productions/inbox           | 99          | 100           | 846 ms | 0.000 | 0 ms |
| Atlas   | /demo-productions/crew/shifts     | 98          | 100           | 948 ms | 0.065 | 0 ms |
| Atlas   | /demo-productions/finance/budgets | 98          | 100           | 889 ms | 0.075 | 0 ms |
| Gateway | /auth/sign-in                     | 100         | 100           | 591 ms | 0.000 | 0 ms |
| Gateway | /home                             | 100         | 100           | 671 ms | 0.003 | 0 ms |
| Gateway | /explore                          | 100         | 100           | 632 ms | 0.000 | 0 ms |
| Gateway | /work                             | 100         | 100           | 677 ms | 0.000 | 0 ms |
| Gateway | /money                            | 100         | 100           | 671 ms | 0.000 | 0 ms |
| Docs    | /en-US                            | 100         | 100           | 511 ms | 0.000 | 0 ms |
| Docs    | /en-US/reference                  | 100         | 100           | 551 ms | 0.000 | 0 ms |
| Docs    | /en-US/guides/getting-started     | 100         | 100           | 510 ms | 0.000 | 0 ms |
| Docs    | /en-US/help                       | 100         | 100           | 511 ms | 0.000 | 0 ms |

LCP, CLS and TBT are inside budget on every page and accessibility scores 100 everywhere. LCP fell
on every page (Atlas signed-in 889 to 1409 ms before, 835 to 948 ms now). Atlas sign-in scored 90 on
this run with the same LCP and no blocking time; one desktop run on a loaded machine.

## API latency (A24-010)

Every API response now carries `Server-Timing` (`auth`, `rate`, `validate`, `handler`). Single
unloaded requests for the load member (load-99-1, Producer in the demo tenant), median of 30:

| Request                     | Before | After | After, by phase                           |
| --------------------------- | ------ | ----- | ----------------------------------------- |
| GET /me                     | 200 ms | 7 ms  | auth 0.3, rate limit 2.5, handler 2.6 ms  |
| GET /projects?limit=25      | 236 ms | 9 ms  | auth 0.3, rate limit 2.3, handler 5.2 ms  |
| GET /records?limit=50       | 347 ms | 16 ms | auth 0.3, rate limit 2.3, handler 11.1 ms |
| GET /notifications?limit=20 | 168 ms | 6 ms  | auth 0.2, rate limit 2.1, handler 2.3 ms  |

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

| Script           | Scale                       | Requests | Reads p50 / p95 (before)     | Writes p50 / p95 (before)                   | Result                             |
| ---------------- | --------------------------- | -------- | ---------------------------- | ------------------------------------------- | ---------------------------------- |
| api.js, platform | 20 users, two empty tenants | 2,024    | 9.4 / 17.2 ms (61 / 268 ms)  | no writes (no record to copy)               | Pass, 0 % errors                   |
| api.js, tenant   | 10 users, demo tenant       | 1,034    | 9.0 / 18.4 ms (107 / 513 ms) | create record 32.6 / 44.4 ms (113 / 623 ms) | Pass, 0 % errors                   |
| compass-show.js  | 25 devices                  | 1,385    | 3.8 / 5.8 ms                 | apply 6.5 / 20.3 ms; replay 2.1 / 2.8 ms    | Pass (A24's run; path not changed) |

Both API profiles now pass their Section 5.1 thresholds (reads p95 under 250 ms, writes p95 under
400 ms, p99 under 800 ms, errors under 1 %) with a wide margin, and served twice the requests in the
same 30 seconds.
