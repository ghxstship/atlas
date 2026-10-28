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

| App     | Page                              | Before | Route JS (build, A41) | Route JS (build, A46) | Route JS (build, A48) | Lighthouse JS (A37) | Verdict |
| ------- | --------------------------------- | ------ | --------------------- | --------------------- | --------------------- | ------------------- | ------- |
| Atlas   | /auth/sign-in                     | 481 KB | 164 KB                | 157 KB                | 156 KB                | 189 KB              | Pass    |
| Atlas   | /demo-productions/home            | 717 KB | 243 KB                | 180 KB                | 173 KB                | 347 KB              | Pass    |
| Atlas   | /demo-productions/projects        | 696 KB | 280 KB                | 219 KB                | 196 KB                | 309 KB              | Pass    |
| Atlas   | /demo-productions/p/NWS/overview  | 711 KB | 277 KB                | 200 KB                | 192 KB                | 321 KB              | Pass    |
| Atlas   | /demo-productions/inbox           | 632 KB | 241 KB                | 195 KB                | 184 KB                | 264 KB              | Pass    |
| Atlas   | /demo-productions/crew/shifts     | 693 KB | 276 KB                | 197 KB                | 188 KB                | 305 KB              | Pass    |
| Atlas   | /demo-productions/finance/budgets | 712 KB | 312 KB                | 195 KB                | 186 KB                | 342 KB              | Pass    |
| Gateway | /auth/sign-in                     | 519 KB | 184 KB                | 171 KB                | 171 KB                | 208 KB              | Pass    |
| Gateway | /home                             | 528 KB | 193 KB                | 193 KB                | 193 KB                | 217 KB              | Pass    |
| Gateway | /explore                          | 530 KB | 195 KB                | 194 KB                | 194 KB                | 219 KB              | Pass    |
| Gateway | /work                             | 519 KB | 192 KB                | 191 KB                | 191 KB                | 208 KB              | Pass    |
| Gateway | /money                            | 519 KB | 192 KB                | 191 KB                | 191 KB                | 208 KB              | Pass    |
| Docs    | /en-US                            | 466 KB | 150 KB                | 150 KB                | 150 KB                | 174 KB              | Pass    |
| Docs    | /en-US/reference                  | 466 KB | 150 KB                | 150 KB                | 150 KB                | 174 KB              | Pass    |
| Docs    | /en-US/guides/getting-started     | 466 KB | 150 KB                | 150 KB                | 150 KB                | 174 KB              | Pass    |
| Docs    | /en-US/help                       | 466 KB | 150 KB                | 150 KB                | 150 KB                | 174 KB              | Pass    |

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

### A48 (RRR-92, 2026-10-19): Projects under budget

All 16 key pages are now under 200 KB, and `packages/testing/bundle-ceilings.json` holds no
ceiling. Measured with `pnpm turbo run build --filter=@xos/atlas --filter=@xos/gateway
--filter=@xos/docs && pnpm --filter @xos/testing budget:js`, in gzip bytes against the
204,800-byte budget:

| Page                              | Before (A46 build) | After (A48 build) | Change  | Headroom |
| --------------------------------- | ------------------ | ----------------- | ------- | -------- |
| /auth/sign-in                     | 160,786            | 159,404           | -1,382  | 45,396   |
| /demo-productions/home            | 184,731            | 177,301           | -7,430  | 27,499   |
| /demo-productions/projects        | 224,466            | 201,135           | -23,331 | 3,665    |
| /demo-productions/p/NWS/overview  | 204,656            | 196,361           | -8,295  | 8,439    |
| /demo-productions/inbox           | 199,679            | 188,127           | -11,552 | 16,673   |
| /demo-productions/crew/shifts     | 201,651            | 192,134           | -9,517  | 12,666   |
| /demo-productions/finance/budgets | 199,506            | 190,314           | -9,192  | 14,486   |

Gateway and docs did not change. The steps, as measured on Projects and project overview:

| Step                                                                | Projects | Overview |
| ------------------------------------------------------------------- | -------- | -------- |
| DataTable lays out its own columns; TanStack Table loads for a drag | -11.4 KB | none     |
| Page skeleton as its own client module (loading boundaries)         | -2.9 KB  | none     |
| Org error boundary without next/link                                | -3.1 KB  | -3.1 KB  |
| Turbopack `minChunkSize` 200,000 (19 chunks to 13 per page)         | -3.3 KB  | -2.9 KB  |
| `@xos/ui` Skeleton in its own module                                | -0.4 KB  | -0.1 KB  |
| Client sitemap nodes shipped packed                                 | -2.2 KB  | -2.2 KB  |

What the source maps showed (`XOS_SOURCEMAPS=1`): the 22 KB table chunk was TanStack Virtual
(6.6 KB), TanStack Table core with its store and React bindings (about 11 KB) and DataTable itself
(2.8 KB). Tree shaking already worked: of the features DataTable did not register, only about
1.5 KB remained (the auto-reset hooks the core row model calls, which pull `sortFns` and small
parts of the pagination, expanding and cell selection utilities). Registering fewer features could
not close the gap, so DataTable no longer runs TanStack Table to lay out a table: it computes widths
and pinned offsets itself, as the sizing and pinning features do, and loads TanStack Table when a
pointer first enters a resize handle or a handle takes focus. TanStack Virtual stays in the default
view. The rest came from duplicated or shell code every signed-in page loads.

What remains, with its cause:

1. **Framework, on every page.** Next.js 16 with React 19 is 128 KB of every page, which leaves 72 KB for the app.
2. **Projects has 3.7 KB of headroom.** The largest remaining parts of the page are TanStack Virtual (6.6 KB, needed when a list passes 100 rows) and the collection view switcher (Radix toggle group, 6 KB).
3. **Root boundaries duplicate the design-system basics.** The root error and not-found boundaries sit above the org layout, so each carries its own copy of Button, Icon and Kbd (about 5 KB on every page). Turbopack does not share modules between sibling boundaries.

### A113 (RRR-158, 2026-10-27): favorites that move and recent projects, within the shell's room

Batch-c at 39c1088a left Projects 24 bytes under the budget. The first A113 build put it 1,212
bytes over, all of it shell code every signed-in page loads. Measured the same way, in gzip bytes:

| Page                             | batch-c 39c1088a | A113    | Change | Headroom |
| -------------------------------- | ---------------- | ------- | ------ | -------- |
| /demo-productions/projects       | 204,776          | 204,256 | -520   | 544      |
| /demo-productions/p/NWS/overview | 198,099          | 197,821 | -278   | 6,979    |
| /demo-productions/inbox          | 201,769          | 201,249 | -520   | 3,551    |
| /demo-productions/home           | 185,575          | 185,054 | -521   | 19,746   |

- The Favorites render as the plain sidebar list; the list that moves (`favorites-reorder.tsx`, with
  pinning) loads when the pointer or focus first reaches them.
- The read of the recent projects after a project opens lives in the project frame
  (`project-opened.tsx`); the shell only takes the links it sends, and shares no module with it.
- A module that both the shell and a chunk loaded later import cannot be merged into the shell's
  module: importing the Sidebar's classes into the lazy list cost about 300 bytes, so they are
  passed in as props instead.
- The platform system banners (A90) show nothing until a fetch made once the page is idle returns
  one, so their code now loads after the page (`deferred-system-banners.tsx`), about 1 KB.

After the review fixes (the favorites drag by their move button with pointer events), merged with
batch-c 8ca5ac3d: Projects 202,299 (2,501 under), Inbox 202,188 (2,612 under), project overview
198,424 and Home 186,115. The drag code is in `favorites-reorder.tsx`, which loads on demand, so
the shell carries none of it.

## Lighthouse against the gate 10 budgets

| App     | Page                              | Before | Route JS (build, A41) | Route JS (build, A46) | Lighthouse JS (A37) | Verdict                                                |
| ------- | --------------------------------- | ------ | --------------------- | --------------------- | ------------------- | ------------------------------------------------------ |
| Atlas   | /auth/sign-in                     | 90     | 100                   | 157 KB                | 685 ms              | Pass                                                   |
| Atlas   | /demo-productions/home            | 99     | 100                   | 180 KB                | 835 ms              | Pass                                                   |
| Atlas   | /demo-productions/projects        | 97     | 100                   | 219 KB                | 866 ms              | Pass (route JS 196 KB after A48; Lighthouse not rerun) |
| Atlas   | /demo-productions/p/NWS/overview  | 99     | 100                   | 200 KB                | 837 ms              | Pass (route JS 192 KB after A48)                       |
| Atlas   | /demo-productions/inbox           | 99     | 100                   | 195 KB                | 846 ms              | Pass                                                   |
| Atlas   | /demo-productions/crew/shifts     | 98     | 100                   | 197 KB                | 948 ms              | Pass                                                   |
| Atlas   | /demo-productions/finance/budgets | 98     | 100                   | 195 KB                | 889 ms              | Pass                                                   |
| Gateway | /auth/sign-in                     | 100    | 100                   | 171 KB                | 591 ms              | Pass                                                   |
| Gateway | /home                             | 100    | 100                   | 193 KB                | 671 ms              | Pass                                                   |
| Gateway | /explore                          | 100    | 100                   | 194 KB                | 632 ms              | Pass                                                   |
| Gateway | /work                             | 100    | 100                   | 191 KB                | 677 ms              | Pass                                                   |
| Gateway | /money                            | 100    | 100                   | 191 KB                | 671 ms              | Pass                                                   |
| Docs    | /en-US                            | 100    | 100                   | 150 KB                | 511 ms              | Pass                                                   |
| Docs    | /en-US/reference                  | 100    | 100                   | 150 KB                | 551 ms              | Pass                                                   |
| Docs    | /en-US/guides/getting-started     | 100    | 100                   | 150 KB                | 510 ms              | Pass                                                   |
| Docs    | /en-US/help                       | 100    | 100                   | 150 KB                | 511 ms              | Pass                                                   |

LCP, CLS and TBT are inside budget on every page and accessibility scores 100 everywhere. LCP fell
on every page (Atlas signed-in 889 to 1409 ms before, 835 to 948 ms now). Atlas sign-in scored 90 on
this run with the same LCP and no blocking time; one desktop run on a loaded machine.

### A75 (RRR-120, 2026-10-20): the 2026-10-19 nightly failures

The nightly failed gate 10 on Total Blocking Time 253 ms on Atlas Home, CLS 0.199 on Atlas
Projects, 202 to 215 KB of script on four pages and accessibility 0.98 on Gateway Explore. Local
runs used the same CLI and settings on a loaded machine (load average 50 to 500), three rounds per
app before and after.

**The runner measured signed-out requests.** It sent the session as an extra Cookie header, and
Chrome sends its own cookie jar instead once a page sets a cookie (Atlas sets `xos-last-org` on every
org page). Server actions, redirects and prefetches then ran signed out: every saved-views and
help-state load failed, and Gateway /work and /money were measured as the sign-in page. The runner
now puts the session in the browser's cookie jar (`packages/testing/src/lighthouse-session.cjs`).
That exposed two more pages over budget on a first visit, Home and Crew shifts, which loaded the
whole help panel to offer a tour or a tip.

| Page                                   | Measure       | Before             | After  | Cause and fix                                                              |
| -------------------------------------- | ------------- | ------------------ | ------ | -------------------------------------------------------------------------- |
| Atlas /demo-productions/projects       | CLS           | 0.088 (CI 0.199)   | 0.000  | A failed saved-views load put an alert in the page header; now in the menu |
| Atlas /demo-productions/projects       | Script        | 202 KB             | 195 KB | SegmentedControl without Radix's toggle group                              |
| Atlas /demo-productions/p/NWS/overview | Script        | 215 KB             | 190 KB | Project tabs prefetch on intent (18 KB); SegmentedControl                  |
| Atlas /demo-productions/home           | Script        | 213 KB (tour card) | 187 KB | The tour card no longer loads the help drawer                              |
| Atlas /demo-productions/crew/shifts    | Script        | 222 KB (tour, tip) | 189 KB | Same; SegmentedControl                                                     |
| Atlas /demo-productions/home           | TBT, 4x CPU   | 141 ms             | 89 ms  | Server-formatted alert dates and activity times; cached Intl formatters    |
| Gateway /explore                       | Accessibility | 0.98               | 1      | heading-order: the Filters disclosure is an h2                             |
| Gateway /explore                       | Script        | 203 KB             | 183 KB | Precompiled messages, deferred shell overlays and session dialog           |
| Gateway /home                          | Script        | 202 KB             | 171 KB | Same                                                                       |
| Gateway /work                          | Script        | 201 KB             | 171 KB | Same (measured signed in for the first time)                               |
| Gateway /money                         | Script        | 221 KB             | 190 KB | Same (measured signed in for the first time)                               |

Lighthouse script is `resource-summary:script:size`. TBT is the median of five Lighthouse runs per
build with `cpuSlowdownMultiplier` 4, the base and this branch alternating; at the preset's 1x both
measure 0 to 80 ms here, so the CI runner is roughly four times slower than this machine. Route
JavaScript (`budget:js`, gzip) after the changes: Atlas 156 to 189 KB, Gateway 163 to 179 KB, docs
142 KB on every key page.

Journey 46's WebKit failure (Gateway `expectAccessible` on the Atlas change-order peek) was the
same tokens at 0.3 to 0.8 opacity during the peek's 80 ms reduced-motion fade, scanned before it
ended: the drawer's text read #5c5d5f and #414347 on #131417. The same nodes pass at rest. Gateway's
helper now waits for the resting state as Atlas's does (finding A24-008).

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
