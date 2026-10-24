# @xos/testing

Shared test tooling for the XOS 4.0 quality gates (Section 18): the design QA audit, the form audit
behind "input kept after refusal", the spec budgets, Lighthouse CI, the k6 load scripts and shared
Playwright helpers. Proposed CI jobs for all of it are in `ci/proposed-jobs.yml`.

| Command                                                                  | What it does                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @xos/testing test`                                        | Unit tests, plus the repository audits: no raw design values, every Section 11.4 component exported, every form keeps typed input after a refusal                            |
| `pnpm --filter @xos/testing design:audit`                                | The design QA report (raw values, token usage, component inventory)                                                                                                          |
| `node --experimental-strip-types packages/testing/src/form-audit-cli.ts` | Lists any form that would lose typed input                                                                                                                                   |
| `pnpm --filter @xos/testing lighthouse [atlas\|gateway\|docs]`           | Lighthouse CI against running production builds                                                                                                                              |
| `pnpm --filter @xos/testing load:smoke`                                  | The three k6 scripts at smoke scale against the local stack                                                                                                                  |
| `pnpm --filter @xos/testing budget:js [--chunks]`                        | Route JavaScript of every key page from the production builds, against the 200 KB budget, and no Sentry SDK in any client chunk; `--chunks` lists each page's largest chunks |

## Design QA audit

Reads every source file under the Atlas, Gateway, docs and Compass app trees and the two component
libraries, and reports:

- raw colors (`#hex`, `rgb()`, `hsl()`, `oklch()`), Tailwind arbitrary lengths and durations
  (`w-[13px]`, `duration-[150ms]`) and inline style lengths, where a token belongs;
- `var(--name)` references that no token and no stylesheet defines;
- the Section 11.4 component inventory against `@xos/ui`'s exports, and what `@xos/ui-native` ships.

A value that is data rather than design (an org's brand color) opts out on its own line or the line
above with `design-audit-allow: <reason>`.

## Lighthouse CI

Budgets come from Section 18, gate 10 (`src/budgets.ts`): LCP under 2.5 s, CLS under 0.1, Total
Blocking Time under 200 ms as the lab stand-in for INP, route JavaScript under 200 KB, and an
accessibility score of 100. Signed-in pages get a demo session in the browser's cookie jar before
each page (`src/lighthouse-session.cjs`, a puppeteer script lhci runs), so server actions,
redirects and prefetches run signed in, as in a real browser. An extra Cookie header would not do:
Chrome drops it for its own jar once a page sets a cookie. Start each app with `next start` first
(Atlas on 3006, Gateway on 3127, docs on 3014), then:

```sh
SUPABASE_URL=http://127.0.0.1:57421 SUPABASE_ANON_KEY=<publishable key> \
CHROME_PATH=<a Chromium build> pnpm --filter @xos/testing lighthouse
```

Reports and `summary.json` land in `node_modules/.cache/lighthouse/<app>/`.

## Route JavaScript budget

`budget:js` checks the same 200 KB budget without a browser or a database, so CI can run it on
every pull request (job `route-js-budget` in `ci/proposed-jobs.yml`). After `next build` of Atlas,
Gateway and docs it reads each build's manifests, adds the root chunks to every chunk the key page's
segments list, and gzips each chunk once: the scripts a cold load fetches, which is what
Lighthouse's `resource-summary:script:size` counts, within a few kilobytes.

The same command then scans every script under `apps/<app>/.next/static` for the Sentry SDK
(`src/client-chunk-audit.ts`) and fails if one carries it: browsers report errors through the
same-origin reporter in `@xos/infra/observability/browser`, and Sentry stays on the server
(ADR 0025).

A page still over budget has a ceiling in `bundle-ceilings.json`, set 3 KB above its measured size,
with the cause recorded in `legal/qa/performance-results.md`. The check fails when a page grows past
its ceiling. Lower a ceiling when a page shrinks; never raise one to make a change pass.

Two rules keep pages small:

- A `"use client"` barrel such as `apps/<app>/components/ui.tsx` ships every export that any page
  uses to every page that imports it. Heavy components (charts, tables, editors, maps) get their own
  boundary file, as `apps/gateway/components/ui-chart.tsx` does.
- A small hook or helper that lives in a module with heavy components drags them along. Give it its
  own module (`apps/atlas/components/home/alert-text.ts`, `components/activity/describe.ts`).

## Test clock (late evening and month boundaries)

The database runs in UTC, so its date is a day ahead of New York from 20:00 every evening, and on
the last evening of a month it is already next month. Product dates follow the project's or the
org's calendar (migration 1305), and tests must too. `clock/` runs pgTAP and the journeys with the
wall clock at any instant, for example 23:30 in New York on 31 October (`2026-11-01T03:30:00Z`):

- `clock/pg-clock.sh at <supabase_db_container> <UTC instant>` restarts a local stack's Postgres
  with libfaketime preloaded at that instant (`off` restores the real clock) and prints the offset.
  Postgres's `now()` cannot be set from SQL; the script explains how the library is loaded.
- `NODE_OPTIONS="--require $PWD/packages/testing/clock/node-clock.cjs" E2E_CLOCK_OFFSET_MS=<offset>`
  shifts `Date` in the Next servers and the Playwright runner by the same amount, and the journeys'
  `engine-test.ts` moves each browser context's clock with Playwright's clock API.
- `E2E_TIMEZONE=America/New_York` runs the browsers in that zone. Keep the servers in UTC, as
  production is.

Prefer offsets into the past for journeys: the auth server and PostgREST keep the real clock, and a
future offset longer than the token lifetime makes clients refresh without end. pgTAP has no such
limit. `supabase db reset` recreates the container; reset to an early migration
(`--version 0207`), set the clock, then `supabase migration up`, so partitions and other "now"
defaults are made at the faked time.

The core-screen baselines (gate 9) always run on this clock, at one fixed instant:
`ci/visual-clock.sh` does the reset, migrates, seeds at that instant and prints
`E2E_CLOCK_OFFSET_MS`, and the visual configs refuse to run without it (`apps/<app>/e2e/visual`).

## Load tests (k6)

The scripts cover the Section 5.1 targets and assert its objectives as k6 thresholds:

| Script                 | Profile                 | Full scale                                                            | Smoke scale | Thresholds                                                          |
| ---------------------- | ----------------------- | --------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `load/api.js`          | `LOAD_PROFILE=platform` | 10,000 virtual users across every load tenant                         | 20          | reads p95 < 250 ms, writes p95 < 400 ms, p99 < 800 ms, errors < 1 % |
| `load/api.js`          | `LOAD_PROFILE=tenant`   | 500 virtual users in one tenant                                       | 10          | same                                                                |
| `load/compass-show.js` |                         | 1,000 devices replaying through `app.apply_sync_mutation`, plus reads | 25          | sync p95 < 5 s, replay p95 < 5 s, reads p95 < 250 ms                |

They run through the pinned image `grafana/k6:2.3.0`, so nothing is installed on the host.

### Smoke, locally

```sh
SUPABASE_ANON_KEY=<publishable key of your stack> \
SUPABASE_URL=http://host.docker.internal:<api port> ATLAS_URL=http://host.docker.internal:3006 \
  sh packages/testing/load/run.sh smoke
```

A smoke run refuses any target that is not local. Summaries land in `node_modules/.cache/k6/`.

### Full scale, against staging (owner only)

Never run load against production. Full scale runs against the staging project only, from a load
generator outside the developer laptop (k6 Cloud or a machine sized for 10,000 virtual users: about
8 vCPU and 16 GB), and only with the owner's approval, since it consumes staging quota.

1. Seed the load tenants once, with a staging-only password (never a real one):
   `psql "$STAGING_DB_URL" -v tenants=20 -v users=500 -v password="'<load password>'" -f packages/testing/load/fixtures/load-tenants.sql`.
   The public API limits each caller to 600 requests a minute, so virtual users spread across
   these 10,000 accounts.
2. Build the user lists:
   `psql "$STAGING_DB_URL" -Atc "select string_agg(email, ',') from auth.users where email like 'load-%@load.example.test'"`
   for the platform run, or `like 'load-1-%'` for the tenant run.
3. Run each profile, naming the staging host so the guard lets it through:

   ```sh
   LOAD_MODE=full LOAD_CONFIRM_STAGING=<atlas staging host> \
   ATLAS_URL=https://<atlas staging host> SUPABASE_URL=https://<project ref>.supabase.co \
   SUPABASE_ANON_KEY=<staging publishable key> LOAD_PASSWORD=<load password> \
   LOAD_USERS=<list from step 2> LOAD_DURATION=15m \
     sh packages/testing/load/run.sh full api-platform
   ```

   then `api-tenant` and `compass-show` the same way. The Compass run needs an open occupancy
   counter on a project the load users can count on (`safety.incident.write`).

4. Compare `node_modules/.cache/k6/*-full.json` with the thresholds; any breach is a release blocker under
   Section 5.1 and goes to A26 (reliability) as a finding.

## Compass Maestro (gate 7)

The flows live in `apps/compass/.maestro` (sign-in, clock in and out, offline clock with queue drain,
incident report, inspection walk, gate scan, run of show, kiosk, external crew and vendor, sunlight
and sign-out). Running them needs a JDK for Maestro and, for iOS, Xcode with CocoaPods. Neither is
installed on the build machine, and system software is not installed for this. The CI jobs that
would run them, on a macOS runner for iOS and an Android emulator on Linux, are `maestro-ios` and
`maestro-android` in `ci/proposed-jobs.yml`; adding them is the owner's decision because macOS
minutes cost money.
