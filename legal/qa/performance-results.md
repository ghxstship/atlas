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
batch-c 41fd86b9: Projects 202,395 (2,405 under), Inbox 202,273 (2,527 under), project overview
198,620 and Home 187,539. The drag code is in `favorites-reorder.tsx`, which loads on demand, so
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

### A144 (RRR-207, RRR-120, 2026-10-28): measured as Lighthouse measures, every signed-in route

The nightly failed gate 10 on script size for Atlas Projects, Inbox and project overview (207 to
212 KB against 204,800 bytes) while `budget:js` passed them at 198 KB. Local runs on the build
machine (Lighthouse CI 0.15.1, Lighthouse 12.6.1, desktop preset, one run per page, Chromium
headless shell 1248, `next start` on the stack of block 6483x with the demo seed) found three causes:

- **Compression level and headers.** `budget:js` gzipped at level 9 and counted no headers.
  `next start` gzips at zlib's default level, and Lighthouse's `transferSize` includes each
  response's headers and framing: about 400 bytes a script, 4 to 5 KB on a page of 10 to 13 chunks.
  `budget:js` now counts both and lands within 100 bytes of Lighthouse on every page that fetches
  nothing after hydration (Atlas sign-in: 163,570 against 163,481).
- **Modules fetched after hydration.** Every signed-in Atlas page fetches the shell's key handler
  once it hydrates (2,951 bytes). Crew Shifts fetched its quick add row, open on the page, with the
  chrono-node date parser (21 KB). Gateway Money fetches a 21 KB module the same way. No build
  manifest lists them; `budget:js -- --served` loads each key page in Chromium and counts them, in
  CI's journeys jobs.
- **Shell code on every page.** The client sitemap with its route matching (about 5 KB), the
  shell peek (2 KB), the ownership offer's actions with the step-up dialog (1 KB), and the
  not-found and loading boundaries (three chunks, 1.8 KB plus 1.2 KB of headers).

Script bytes as Lighthouse counts them (`resource-summary:script:size`), before (batch-c 4bf1cacf)
and after, against 204,800:

| Page                                    | Before  | After   | Change  | Headroom |
| --------------------------------------- | ------- | ------- | ------- | -------- |
| Atlas /auth/sign-in                     | 164,370 | 163,481 | -889    | 41,319   |
| Atlas /demo-productions/home            | 197,674 | 183,161 | -14,513 | 21,639   |
| Atlas /demo-productions/projects        | 211,670 | 200,417 | -11,253 | 4,383    |
| Atlas /demo-productions/p/NWS/overview  | 207,275 | 197,052 | -10,223 | 7,748    |
| Atlas /demo-productions/inbox           | 211,525 | 200,086 | -11,439 | 4,714    |
| Atlas /demo-productions/crew/shifts     | 225,006 | 199,843 | -25,163 | 4,957    |
| Atlas /demo-productions/finance/budgets | 200,508 | 190,390 | -10,118 | 14,410   |
| Gateway /auth/sign-in                   |         | 175,678 |         | 29,122   |
| Gateway /home                           |         | 182,587 |         | 22,213   |
| Gateway /explore                        |         | 195,711 |         | 9,089    |
| Gateway /work                           |         | 182,235 |         | 22,565   |
| Gateway /money                          |         | 202,123 |         | 2,677    |

What came out of every signed-in Atlas page, in gzip bytes of the shared shell and boundary
chunks (the org shell chunk went from 23,318 to 13,569, and three boundary chunks of 1,758 bytes
left with their headers):

| Change                                                                                                                                      | Bytes                 |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| The server shell hands over the first page's breadcrumbs and help node; the client sitemap and its matching load with the first interaction | ~5,800                |
| The shell peek loads with `?peek` (`shell-peek-gate.tsx`), its link helper without the sitemap                                              | ~2,200                |
| The ownership offer's actions and the step-up dialog load on the banner that shows them                                                     | ~1,000                |
| Not-found (root and org) and Projects-style loading boundaries render from `@xos/ui/static`                                                 | 1,758 and 3 responses |
| The quick add's date parser loads with the field's focus (Crew Shifts, record lists)                                                        | page                  |

The cut to the shared shell is about 11 KB in Lighthouse's terms (11.3 KB on Projects, 11.4 KB on
Inbox, 10.2 KB on project overview), short of the 15 KB follow-up 12 asked for. The rest of the
org shell chunk (13.6 KB) is the frame, AppShell, Sidebar, Breadcrumbs, TabBar, the help and Aurora
entry points, the undo center and the system banners, all rendered or listening on every page. Two
larger moves were measured and left out: shipping the en-US `ui` catalog (3 to 4 KB) or the client
sitemap through the page payload instead of a script would pass the script budget by moving bytes
from an immutable, cached chunk into every full page load.

#### Every signed-in route

`pnpm --filter @xos/testing lighthouse atlas gateway` visits every signed-in route in the generated
sitemaps (`packages/testing/src/lighthouse-routes.ts`): 253 Atlas routes (248 as the
Owner, 5 partner console pages as the partner's Owner) and 52 Gateway routes (46 as the crew
member, 6 vendor engagement tabs as the vendor), plus both sign-in pages signed out. 308 pages,
every one within its budgets on the final run, read from the reports (lhci asserted 302 of them;
see "Pages that ended elsewhere" below):

| App     | Pages | Accessibility | Performance | LCP          | CLS            | TBT        | Script             |
| ------- | ----- | ------------- | ----------- | ------------ | -------------- | ---------- | ------------------ |
| Atlas   | 255   | 1 on every    | 0.94 to 1   | 581–1,487 ms | 0.000 to 0.029 | 0 to 16 ms | 163,481 to 270,930 |
| Gateway | 53    | 1 on every    | 1           | 470–723 ms   | 0.000 to 0.003 | 0 to 6 ms  | 175,684 to 219,050 |

Left out, as no seeded person can open them: Atlas `/{org}/settings/partner` (an org that is a
partner agency) and `/{org}/me/developer` (an org that allows personal tokens); Gateway's
`/settings/developer`, the company settings (they need the person acting for the account) and 20
engagement tabs of role types the seed has no engagement for (client, artist, sponsor).

The first run failed accessibility (0.98 to 0.99) on 10 pages, all `heading-order` and, on boards,
`aria-allowed-role`: Board cards were `article role="button"` and its column titles h3 under the
page's h1; More fields headed a form at h3 under the page title (Atlas profile, privacy,
preferences and modules settings, Gateway profile and privacy); a record's Move to and Gateway's
saved opportunities skipped from h1 to h3. Each now takes the next level.

187 Atlas routes and 6 Gateway routes measured over 204,800 bytes of script (in Lighthouse or the build manifests). Each holds a ceiling in
`packages/testing/bundle-ceilings.json` (measured plus 3 KB) that the nightly and `budget:js`
assert and that only moves down; no key page holds one. By route family:

| Family                         | Routes | Script (bytes)  | Cause                                                                                                    |
| ------------------------------ | ------ | --------------- | -------------------------------------------------------------------------------------------------------- |
| Atlas settings and Me          | 56     | 209,120–264,232 | The settings form kit (fields and validation, 33 KB); under Me also second-factor enrolment (26 KB)      |
| Atlas module collections       | 113    | 205,730–270,937 | The collection kit beyond the table: collaboration menu, export, record list, drawer forms (28 to 35 KB) |
| Atlas reports, Home tabs       | 13     | 209,343–226,709 | Report tables; Home's tiles with the views and export menus                                              |
| Atlas other lists              | 5      | 207,724–247,590 | The same collection kit, open on My Work, By Phase, a record, a custom object, client orgs               |
| Gateway Money, Work, Documents | 6      | 217,870–219,049 | The list table and its filters on top of the shell                                                       |

The module collections are the project tabs and the Schedule, Work, Show, Advancing, Places, Canon,
Knowledge, Vendors, Procurement, Finance, People, Assets, Logistics, Hospitality, Safety, Site Ops
and Crew pages.

Splitting the collection kit and the settings form kit the way A46 and A48 split the Projects
table is each module's follow-up; the ceilings keep them from growing until then.

#### Pages that ended elsewhere (review, 2026-10-30)

lhci 0.15.1 matches each `assertMatrix` entry against a report's `finalUrl`, and a report that no
entry matches is not asserted at all. Every Atlas owner run holds more than one script budget, so
its entries are exact URLs. Six of the 308 pages redirected and went unasserted: Atlas
`/demo-productions/p/NWS` (to `/p/NWS/overview`) and the saved view `/views/<id>` (to
`/projects?view=table&archive=active&sort=name`); Gateway `/work`, `/money`, `/settings` and
`/work/engagements/<key>` (to `/work/upcoming`, `/money/overview`, `/settings/profile` and the
engagement's overview). Read against the budgets, all six were inside them at their landing URLs
(accessibility 1, LCP 683 to 796 ms, CLS at most 0.0002, TBT 0, script 182,241 to 204,256 bytes,
Gateway Settings 544 bytes under). The same blind spot would have hidden a run that lost its session:
the CLI signed in once per person and put that session back before every page, and with a one-hour
JWT and refresh-token rotation, a run past the hour (Atlas takes about one) would have sent every
later page to sign in, unasserted.

The CLI (`packages/testing/src/lighthouse-landing.ts`) now:

- asks the server where each page lands, with the person's cookies and redirects not followed,
  and visits the landing path (the project's overview is visited once, from its own route);
- stops the run when a signed-in page answers with a redirect to `/auth/`, or off the app;
- signs each person in afresh for every 40 pages, about 7 minutes of Lighthouse;
- fails when lhci does, and also when any page's summary is over a budget (accessibility below 1
  included, as lhci asserts) or its final URL is not the one it asked for.

Rescoring the 308 local reports with the new verdict fails exactly those six (and only for having
ended elsewhere); the nightly measures their landing paths from now on. The redirect, sign-in and
batching rules are unit tested with a fake server (`packages/testing/test/lighthouse-landing.test.ts`).

#### Follow-up 12's shell cut: 11 KB of the 15 KB asked

The cut above is about 11 KB in Lighthouse's terms, short of the "at least 15 KB" of follow-up 12.
On the 2026-10-28 build the org shell chunk is 13,516 gzip bytes and the root chunk 22,362. Taking
each remaining shell module out of the org chunk and gzipping again shows what each would give:
the Undo and plain toasts 334 bytes, the help tour list 328, the help model's article search 298,
the Banner 163 and the count badge 127; everything left is rendered or listening on every page. The
remaining 4 KB would take a dozen such moves or one of two larger ones this package left out: the
en-US `ui` catalog (4,198 bytes of the root chunk) shipped in the page payload, which moves bytes
from a cached chunk into every full load (ADR 0027), or the shell's key handler (about 3 KB, fetched
after hydration on every signed-in page) loaded on the first key, which would let a page's first
key reach the browser's default before the shell could claim it. Follow-up 12 stays Partial on that
clause until the owner accepts the 11 KB or schedules the catalog split. This branch also carries
A125's region shortcuts and A143's region boundaries, so the next `route-js-budget` and served
measure in CI give the shell's figures as merged.

#### 10,000 rows at 60 fps

`pnpm --filter @xos/ui test:visual frame-timing` (after `storybook:build`) scrolls the 10,000-row
DataTable story 48 px a frame for 240 frames in Chromium: p95 16.70 ms, max 16.80 ms, no missed
frame, in each of three runs. The budget is 16.7 ms plus 1 ms for timestamp rounding. With the CPU
slowed tenfold (CDP `Emulation.setCPUThrottlingRate`) the same scroll measures p95 50.1 ms and fails,
so the check sees a slow table.

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
