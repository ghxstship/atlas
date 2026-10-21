# ADR 0049: Compass Org Switching, Tenant Brand, Branded Builds, Widgets and Wallet Passes

- Status: Accepted
- Date: 2026-10-21
- Decider: A93 (RRR-138) took the decisions below to close parts 3 and 4 of finding A65-011 (work package WP11)

## Context

Finding A65-011 listed what Compass still lacked. Parts 3 and 4 are:

- the combined Today across orgs, with an org switcher and brand chips (Section 4.5.7);
- the tenant brand at runtime (Section 12 Mobile);
- per-tenant EAS profiles for Enterprise branded builds, and `eas.json` update profiles (Sections 12 and 13);
- resumable uploads (Section 13 Media);
- the next cue in the Live Activity, an Android ongoing notification and home screen widgets (Section 13 Platform features);
- Apple Wallet and Google Wallet passes for credentials and shift passes (Section 11.10 item 14, Section 11.13).

Compass previously read only a person's first membership. Its offline store held one scope. It had no brand lookup. `eas.json` had build profiles but no update channels, and the Live Activity showed only the clock.

## Decision

1. **One context per org.** `resolveIdentity` returns one context per org the person works in:
   - a member context for each membership, with that membership's roles, the project roles on that org's projects, and the org's projects;
   - an engaged context for each org that engages the person and where they are not a member.

   One context is active. Its identity, projects, settings and brand drive every screen, and the device remembers it. The active org's last project is remembered too.

2. **The device holds every org's rows, each under its own org's scope.**
   - `SyncSession` takes one `DownloadScope` per org. A row is stored when one of those scopes admits it.
   - When a membership ends, `narrow` drops that scope, and every row only that scope admitted goes.
   - Tables whose names start with an underscore are device-local: the outbox, `_uploads` and `_org_brands`. Downloads never write them and narrowing never purges them; sign-out wipes them.
   - The REST downloader merges a table's rows from the app tables and the `api_external` views before writing, so one source never removes the other's rows.
   - One-org screens read the active org only. A row's org is its `org_id`, else its project's org. Rows with no known org, such as canon rows and the outbox, show everywhere.
   - Every queued write carries `device_org_id`: the member org that was active when it was queued, or null for an engaged org. `app.apply_sync_mutation` runs it in that org even if the person switches before the queue drains.
   - `test/org-switching.test.ts` proves this against the SQLite store, across a restart.

3. **The combined Today puts each item on its own calendar.** This follows A71's rule (`@xos/data/calendar`):
   - a shift uses its own zone, then its project's zone;
   - a day sheet uses its project's zone;
   - an item with no project uses the person's own zone. That is their `locale.time_zone` personal setting when they set one, else the device's zone, never UTC.

   The groups list the active org first, then the rest by name. Each group carries the org's brand chip. The single-org Today's day sheet also stopped using the UTC date.

4. **The runtime brand.**
   - `app.my_org_brands` (migration 1500) returns `private.public_brand` for every org where the person is a member or is engaged. `app.org_brands` stays readable by members only, so an engaged freelancer sees only the public fields.
   - The active org's accent replaces `accent-default`, and `accent-text` where it also passes as body text. It applies only in the themes where it passes every pair in `@xos/tokens` `contrast-pairs.json`, the same check the token build and the theme editors run. A theme where the accent fails keeps the platform accent.
   - The header shows the active org's logo (light or dark for the theme) and brand name.
   - `@xos/ui-native` `ThemeOptions` gained `brandColors`.
   - Brands are cached in the encrypted store, so the brand still shows offline.

5. **EAS Update.**
   - Each build profile names its channel: `development`, `preview`, `production`, or `tenant-<slug>`.
   - `expo-updates` ships, with the `fingerprint` runtime version. An update therefore reaches only binaries built from the same native code, so it carries JavaScript and assets only. Rollouts are staged with `eas update --rollout-percentage`.
   - Updates are enabled in EAS builds only (or with `XOS_UPDATES=1`). Local and Maestro builds always run their embedded bundle.

6. **Enterprise branded builds.**
   - `scripts/tenant-profile.ts` writes three things for a tenant:
     - `tenants/<slug>.json`, the build definition: name, bundle identifier, Android package, scheme, accent, icon, splash, listing, EAS project and custom domains;
     - the App Store listing;
     - the `tenant-<slug>` build and submit profiles.
   - `app.config.ts` applies the definition when `XOS_TENANT` is set: the tenant's App Group, its splash through `expo-splash-screen`, its EAS project, and universal links for its domains.
   - A68's release guard now covers tenant profiles. It also stops a tenant build while the tenant's EAS project, icon, splash or listing is missing. The store preflight takes a submit profile.
   - The Swift code reads the App Group from the running bundle (`group.` plus the app's bundle identifier), so a tenant build never shares the platform build's group.
   - A branded build wears its accent before sign-in and opens on its own org until the person picks another.

7. **Resumable uploads use TUS against Supabase Storage.**
   - Files go up in 6 MB chunks. The upload URL and confirmed offset are saved after every chunk, in the encrypted store's `_uploads` table.
   - A dropped connection is transient for the outbox. The next attempt asks the server for its offset and sends only what is missing.
   - Supabase keeps an unfinished upload for 24 hours. A saved upload older than 23 hours, or for a file of another size, starts over.
   - An object that already exists (409) counts as done, as before.
   - A file a queued write names is copied from the caches into the app's documents when the write is queued, and deleted after its upload. This survives the system clearing its caches.
   - We wrote our own TUS client (about 150 lines) rather than adding `tus-js-client`, so it runs against a fake server in the tests. It was also checked against the local stack: a 13 MB upload cut after its first chunk resumed and stored every byte.

8. **Compass outside the app.**
   - The clock Live Activity carries the next cue beside the shift timer. While clocked out, a cue within two hours starts the activity on its own: a `cue` state with no punch buttons, which also serves people who do not clock in. The new `ContentState` fields are optional, so an activity started by an earlier build still decodes.
   - Two WidgetKit widgets join the `ClockActivity` extension (`@bacons/apple-targets`, already in use, supports SDK 57):
     - Today: today's shifts across the person's orgs, then the next cue;
     - Next Cue: for the home screen and the Lock Screen.
   - Compass writes the widgets' content as JSON into the App Group, already formatted on each item's calendar and in the person's language. It clears the JSON at sign-out.
   - On Android, the running shift or a close cue stays in the tray as an ongoing notification (`expo-notifications`, sticky, low importance). It is removed when there is nothing to show and at sign-out.
   - Android home screen widgets are not built. This Mac has no Android SDK to verify an `AppWidgetProvider`, and we did not ship unverified Kotlin behind a flag. They are a follow-up.

9. **Wallet passes are signed behind a seam.**
   - `app.my_wallet_pass` (migration 1501) returns what a pass shows, for the person's own credential or own shift only.
   - The `wallet-pass` Edge Function reads it with the caller's token. It answers with a `.pkpass`, or a Save to Google Wallet link.
   - In `@xos/platform`:
     - The Apple signer writes the CMS SignedData of the manifest with Web Crypto: SHA-256, the Pass Type ID certificate and the WWDR intermediate, and signed attributes. No crypto library is added to the Edge runtime.
     - The Google signer writes an RS256 JWT.
     - Both read their keys from Edge Function secrets. Until the secrets are set, the function answers 503 `wallet_not_configured`, and Compass says so.
   - The badge pass's QR is the badge's own `XOSCR1` payload, so gates scan it.
   - Pass colors are the org's accent when white labels pass on it, else the platform token.
   - iOS shows Apple's own `PKAddPassButton` (new `compass-wallet` module), as Apple's guidelines ask. Android shows a Compass button for Google Wallet.
   - Tests use fake signers built at run time. A certificate made at run time proves the CMS signature with Web Crypto and OpenSSL.

## Owner steps

- **Apple Wallet.**
  - Register a Pass Type ID, `pass.<reverse domain>`, and create its certificate.
  - Set the `wallet-pass` secrets `APPLE_PASS_TYPE_ID`, `APPLE_TEAM_ID` (`<10 characters>`), `APPLE_PASS_CERT_PEM`, `APPLE_PASS_KEY_PEM` (PKCS #8 or PKCS #1) and `APPLE_WWDR_CERT_PEM`.
- **Google Wallet.**
  - Create a Google Wallet issuer and a service account it authorizes.
  - Set `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_WALLET_PRIVATE_KEY_PEM`.
- **App Group.** Register `group.pro.ghxstship.compass` for `pro.ghxstship.compass` and `pro.ghxstship.compass.clock-activity` (already in the store runbook). Each tenant build registers `group.<its bundle id>`.
- **EAS.** The platform project is `7a96bb1f-c266-4df1-a072-b03bbc3d567e` (runbook). Each tenant needs its own EAS project; its id replaces `OWNER_EAS_PROJECT_ID` in `tenants/<slug>.json`.
- **Store credentials.** These are unchanged from the store runbook. Each tenant fills `submit.tenant-<slug>`, plus its icon, splash and listing.

## Consequences

- One-org screens stay as they were for a person in one org. A person in several orgs sees the switcher in the header, and Today combined.
- `@xos/sync`'s `SyncSession` API is additive: `scope` still returns the first scope, and `scopes` and `admitsAny` are new.
- The pass and widget art is placeholder: a solid accent icon on passes, and system symbols in widgets. Branded pass art from the org's logo is a follow-up.
- The widget gallery names and descriptions are English. Native localization of the extension is a follow-up.
