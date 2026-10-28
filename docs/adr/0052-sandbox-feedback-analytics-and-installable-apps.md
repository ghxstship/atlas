# ADR 0052: Sandbox, Feedback, Consented Analytics and Installable Apps

- Status: Accepted
- Date: 2026-10-21
- Decider: A96 (RRR-141), within the work package; the owner steps at the end need the owner
- Amended: 2026-10-28, A146 (RRR-178): workflow funnels and regression alerts (section 6, migration 2340)
- Related: findings A65-022 and A65-023; Sections 4.10, 7.3, 11.7 and 11.14; ADR 0011, ADR 0027, ADR 0030, ADR 0033 (decisions 1 and 35); migrations 1034, 1270, 1361, 1367, 1530 to 1533 and 2340

## Context

The A65 requirements trace found four first-run and delivery features missing:

- a private Northwind Live sandbox each person can open from Help;
- a feedback widget that sends a message and an optional screenshot to the platform team;
- consent-gated product analytics for the workflow funnels of Sections 11.11 to 11.13;
- Atlas and Gateway as installable progressive web apps, with web push and an offline read cache.

Three facts shape the design. Production carries no demo tenant (ADR 0033 decision 1), so a sandbox cannot copy rows from one. The platform team had no signed-in identity: "the platform" meant the service role (`private.is_platform_operator`, 0643). And consent comes from A82's cookie banner and Global Privacy Control (finding A65-014), built alongside this work, so analytics read it through one seam.

## Decision

### 1. Sandboxes (1530)

- `app.open_my_sandbox` creates one private org per person on the Team plan, with the person as its only Owner, and fills it from the sandbox template.
- The template is `private.fill_sandbox`, a copy of the demo seed's core: the 0010 workspace and team, the 0107 projects with their scope tree and gate 1, ten of the 0108 records, and the 0230 time zone. It is written as the owner and dated from the day the sandbox opens, on the projects' America/New_York calendar. A drift test (`packages/data/test/a96-sandbox-template.test.ts`) keeps every name in it one the seed writes.
- A sandbox ends 14 days after it opens. `expires_at` is an instant, never a business date.
- **Plainly labelled.** The org is named Northwind Live Sandbox, and the Atlas shell shows a banner with the end instant on the sandbox's calendar.
- **Never billed.** No Stripe subscription link may be written for a sandbox.
- **No email or SMS.** Every Email and SMS delivery of a sandbox is recorded Suppressed, whether `private.notify` queues, defers or holds it. None joins a digest or a text summary, and scheduled report deliveries are recorded Failed. Push and in-app notifications still reach the owner's own devices.
- **Nobody else gets in.** Triggers refuse invitations, invite links, join requests, memberships of anyone but the owner, project shares, advance and document links, offers, integrations and webhooks.
- **Purge.** `private.purge_expired_sandboxes` runs hourly (`xos_purge_expired_sandboxes`). It deletes every row of the org through the sanctioned tenant purge (1270), children before parents, and refuses when a row outside the sandbox references it.
  - A failed purge records its reason on the sandbox for the platform team.
  - Storage objects cannot be deleted in SQL. Their names, found by A79's `private.org_storage_objects` (1351), go to `private.sandbox_leftover_objects` for a Storage API sweep.
  - A79's `private.purge_organization` (1351) serves deletions backed by a deletion certificate (a cancellation or a deletion request), and also clears storage through the Storage API. A sandbox has no certificate, so it runs its own loop over the same tenant purge. Moving sandboxes onto A79's pipeline needs a sandbox basis there, with no certificate email.

### 2. Feedback (1531)

- `app.feedback_submissions` holds the message and the page context the widget shows before sending: the path without its query string, the app and version, the locale and the window size.
- It may also hold a screenshot the person chose, uploaded through the support screenshot path (1034, bucket `support-screenshots`, owner-only). The widget never captures the page itself.
- A person sends at most 10 an hour. Feedback is kept two years.
- Platform staff are `private.is_platform_staff()`, which A90's operator console defines over `app.platform_operators` (1470).
  - Until that lands, 1531 creates a stand-in roster, `private.platform_staff`, written by the service role. It does so only when the function does not exist yet, so whichever lands first, A90's model is the one in force.
- Staff list and triage feedback at `/support/feedback` in Atlas. Anyone else gets 404. The list belongs in A90's console once it lands.
- Staff open a screenshot through a storage policy that requires its upload scan (1240) to be Clean.
- The design system's `FeedbackWidget` is used as is. It gains optional props for the screenshot field, the context it sends and an async send that can fail, and renders as before without them.

### 3. Product analytics (1532)

- **First-party only.** An outside provider would be a new subprocessor and needs an owner decision.
- `app.product_events` holds when, which app, the event (Page Viewed, Workflow Started, Workflow Step or Workflow Completed), the route template, the workflow of Sections 11.11 to 11.13 (`private.product_workflows`), the step, and a random session key the browser keeps in sessionStorage.
- **No personal data.** An event holds no person, org, path or free text. The person is used only to cap events at 300 every 10 minutes, in a counter table kept for an hour and never joined to events.
- **One write path.** `app.record_product_events` is called by each app's `/api/product-events` route.
- **The consent seam.** The route asks one function, `productAnalyticsConsent` in each app's `lib/privacy/product-analytics.ts`, built on `productAnalyticsAllowed` in `@xos/data/product-analytics`. It answers yes only for a recorded yes to performance cookies with no Global Privacy Control signal.
  - The seam reads A82's consent cookie (`lib/privacy/consent.ts`): its performance choice, and a GPC signal sent now or recorded behind the decision, which always refuses. A visitor who never chose gets none.
  - The browser module loads only on a yes, and also stops itself when `navigator.globalPrivacyControl` is set.
- `app.product_funnel_hourly` gives platform staff events and distinct sessions per workflow step in hourly instants, not calendar days. Events are kept 13 months.

### 4. Installable apps

- **Manifests.** Each app has an `app/manifest.ts` with standalone display, scope `/` and start URL `/`.
  - Atlas has shortcuts to Inbox, My Work and Projects, which the entry route resolves with `?open=` to the org used last. Gateway has shortcuts to Work, Money and Explore.
  - Icons are the platform brand's slots in `packages/ui/src/brand/defaults`, imported as static assets, so replacing those files replaces the icons.
  - Colors come from `@xos/tokens`: the dark canvas for Atlas and the light canvas for Gateway. Each layout gives the browser toolbar the canvas color for each color scheme.
  - On an org's custom domain, Gateway's manifest wears the org's name and app icon (served on Gateway's own origin by `/brand/app-icon`), and the org's accent when it passes the contrast gate. The platform brand is the fallback.
- **The service worker** is one source in `@xos/ui/pwa`, served by each app at `/sw.js`. It is plain JavaScript, so ADR 0027's route budgets never count it. The runtime that registers it adds about 1 KB to the root layout and waits for load and an idle moment after hydration.
- **What the worker caches.**
  - It keeps a page loaded as a document only when the response names its signed-in person. The proxies set `x-xos-offline-key`, the first 128 bits of SHA-256 over the sign-in id.
  - Pages live in a cache per person, at most 30. The caches of everyone but the person last seen are deleted.
  - Client-side navigations ask it to keep the page, at most once every 10 seconds and once every 30 minutes per page.
  - Build files under `/_next/static` are cached by hash.
- **What it never touches:** anything but a GET, another origin, `/auth`, `/api`, token links, React Server Component requests, and every fetch the app makes itself. No mutation and no API response is ever cached.
- **Sign-out.** A POST to `/auth/sign-out`, or the sign-in page after a sign-out, deletes every page cache and unsubscribes the browser from push.
- **Offline,** a page navigation answers from the person's cache, else with the offline page at `/auth/offline`, precached at install. The offline page works without JavaScript.
- The Content Security Policy states `worker-src 'self'` and `manifest-src 'self'`, since `'strict-dynamic'` makes the browser ignore `'self'` in `script-src`.

### 5. Web push (1533)

- A `push_subscriptions` row is either an Expo device or a browser: an endpoint, the p256dh and auth keys, and the app it subscribed in. Rows stay per membership, so leaving an org stops its pushes (invariant 3).
- A browser belongs to one person at a time. Registering it, or syncing it on a visit, revokes anyone else's rows for the endpoint, and the browser unsubscribes when the endpoint is not the visitor's.
- A80's `app.claim_notification_deliveries` is not redefined. It lists a browser as a device with no token, so A80's quiet hours, preferences and per-device idempotency apply unchanged.
- The dispatcher (`dispatchPush`) reads the browser's keys through `app.web_push_devices` and sends with VAPID. Encryption follows RFC 8291 (aes128gcm) and RFC 8292 on Web Crypto alone, with no new dependency.
- It records the push service's answer with `app.record_web_push_tickets`:
  - 201 is Delivered, because push services give no receipt;
  - 404 and 410 revoke the browser;
  - 413 is Bounced;
  - 429 and server errors are retried.
- The Edge Function reads `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` with `XOS_WEB_PUSH_TRANSPORT=vapid`, and records pushes otherwise. The apps read the same `VAPID_PUBLIC_KEY`; unset, the setting says browser notifications are not set up yet. Tests generate every key at runtime.

### 6. Workflow funnels and regression alerts (A146, 2340)

- **One registry.** `packages/data/src/product-workflows.ts` names every workflow funnel: its app, owning team, steps
  and target completion rate. Every workflow event name comes from it.
  - A funnel is Workflow Started, Workflow Step 1 to n, then Workflow Completed.
  - Migration 2340 holds the same funnels in `private.product_funnels`, and a unit test keeps the two equal.
- **Signals.** Pages send `<workflow>:start`, `<workflow>:step<n>` or `<workflow>:done` in three ways:
  - a page view of a route template the registry lists, with no code in the page;
  - a `data-workflow` attribute (`workflowMarker`). On a link, button or form it signals when clicked or submitted.
    On any other element it signals when the element appears;
  - `emitWorkflow` from client code, usually through `signalOnSuccess` around a server action, so a refused submit
    never counts as a completion.
- **Consent unchanged.** The browser module that turns signals into events is the one section 3 describes. It loads
  only on a yes to performance cookies, stops under Global Privacy Control and posts to the app's own
  `/api/product-events`, which asks the consent seam again.
  - The registry loads with that module. Pages carry only `@xos/data/workflow-signal`, a few hundred bytes with no
    registry, so the key pages' route budgets hold.
  - Without consent a signal reaches nothing.
- **A completion needs its start.** A step or completion counts only once the same browser session started the
  workflow (kept in sessionStorage beside the session key). A return visit to a finished packet or an empty queue
  is not a completion.
- **Funnel computation.** `private.product_funnel_stages` counts distinct sessions per hourly bucket, as
  `app.product_funnel_hourly` does, and sums them over the window. It reads the events through the workflow index,
  so only the window is scanned.
- **The regression check.** `xos_check_product_funnels` runs at 23 minutes past each hour. For each funnel it compares
  the 24 hours before the last hour boundary with the target and with the 7 days before.
  - A funnel regresses when, with at least `min_started_sessions` (20) started sessions, its rate is below the target
    or more than `regression_drop` (a quarter) below its own 7-day rate.
  - A regression raises one alert per workflow in `app.product_funnel_alerts` for its owning team, refreshes it while
    the regression lasts, and resolves it once the funnel recovers with enough sessions.
  - A quiet hour keeps an alert open rather than calling the funnel healthy.
- **Where the alert goes.** The operator console shows funnels and alerts at `/funnels`, for every operator role
  (`tenants.read`, as A137's platform metrics). An operator acknowledges an alert there, and the console ledger
  records it (`funnel_alert.acknowledge`).
  - `private.notify` reaches org members and parties only, and platform staff are neither, so the console is the
    platform team's channel. No outside alerting service is used.
- **Owning teams** are names in the registry and the migration (Projects, Work, Schedule and so on); the console
  shows and groups alerts by them. Renaming a team, or moving a workflow to another, is a registry and migration
  change.
- **Targets.** The spec's measured targets (time and tap counts, `private.product_workflows.target`) are checked by
  the journeys of gate 26. A funnel's target is a completion rate, a starting value the owner may tune from
  production data.
- **Compass** workflows have funnels and targets but send no events yet. The native app has no cookie banner, so it
  needs its own analytics consent choice (with Global Privacy Control's native equivalent) before it may send any.

## Owner steps

1. **VAPID keys.**
   - Generate a P-256 key pair once.
   - Set `VAPID_PUBLIC_KEY` (`<87 base64url characters>`), `VAPID_PRIVATE_KEY` (`<43 base64url characters>`), `VAPID_SUBJECT` (`mailto:` or `https:` contact) and `XOS_WEB_PUSH_TRANSPORT=vapid` as Edge Function secrets of the production project.
   - Set the same `VAPID_PUBLIC_KEY` on the Atlas and Gateway Vercel projects.
   - Never commit the keys. Rotating them invalidates every browser subscription.
2. **Analytics provider decision.** None is needed for first-party analytics. An outside provider would be a new subprocessor and needs the owner's decision and a `legal/subprocessors.md` entry.
3. **Push services review.** Browsers deliver through their vendor's push service (Google, Apple, Mozilla, Microsoft), which carries only an encrypted payload. Counsel decides whether `legal/subprocessors.md` lists them, as it lists Expo for Compass.
4. **Platform staff.** Name the people who triage feedback: A90's roster once it lands, or rows in `private.platform_staff` until then.
5. **App icons.** When the platform marks are set, replace the brand slots. A 1024 px PNG app icon serves iOS home screens better than the SVG slot.
6. **Funnel targets and teams.** Review the starting completion targets and owning teams in `private.product_funnels` (2340) and the registry once production funnels have a few weeks of data.
7. **Compass analytics consent.** Decide whether Compass asks for analytics consent, so its eight workflows can send funnel events.

## Consequences

- The sandbox purge reads the catalog and visits every org-scoped table: about 15 seconds locally, run hourly at most five at a time.
- The Atlas org layout reads one more indexed row per page (the sandbox end instant).
- External parties with no membership still have no push device row, as with Compass. A person-level browser subscription is a follow-up.
  - Update (A101, RRR-147): Gateway browsers and Compass devices register for the person too (ADR 0056, migrations 1670 and 1671).
- Explicit funnel events (Workflow Started, Step, Completed) are recorded when a workflow emits them. Instrumenting each Section 11.11 to 11.13 workflow is a follow-up for its owning module; page views give the route funnel meanwhile.
  - Update (A146, RRR-178): every Atlas and Gateway workflow emits them (section 6); Compass waits on its consent choice.
- The hourly funnel check reads 8 days of one workflow's events per funnel through the workflow index, 26 times an hour.
