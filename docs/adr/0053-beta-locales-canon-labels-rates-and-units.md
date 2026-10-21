# ADR 0053: Beta Locales, Canon Label Translations, ECB Rates and Display Units

- Status: Proposed
- Date: 2026-10-21
- Decider: Orchestrator, on A97's proposal (RRR-142, finding A65-028, WP21)
- Amends: ADR 0037 (machine translation) sections 1 and 9

## Context

Section 15 asks for more than en-US and es-US. Finding A65-028 listed what was missing; A78 built names,
addresses and phones. This record covers the rest:

- fr-FR, de-DE, it-IT, pt-BR and ja-JP shipped marked Beta in the language picker (S15-07);
- canon labels translatable through `xpms.dim_locale` and translation tables, codes never translated (S15-05);
- ECB daily reference rates stored with their date, every converted figure showing its rate date (S15-11);
- a unit system that follows the project jurisdiction with a per-user override (S15-03);
- schedule times in the venue's zone, labeled, with a toggle to the viewer's zone (S15-16).

The owner decided that every translation goes through Google Translate (ADR 0037). Nobody hand-writes or
generates Beta copy, and the owner's Google Cloud credentials do not exist yet.

## Decision

### 1. Beta locales

- **Two kinds of locale.** `packages/i18n/src/locales.ts` has `launchLocales` (en-US, es-US) and `betaLocales`
  (the five). `locales` is both.
  - Launch catalogs stay complete and strict: the catalog tests and the translation check fail on a missing key.
  - A Beta catalog may be partial or absent. `getMessages` merges it over en-US key by key (`withFallback`), so
    every en-US key exists and a raw key never shows.
- **Loaded per locale.** Each Beta locale has its own generated module, `src/beta/<locale>.generated.ts`.
  - `@xos/i18n/load` (`loadMessages`) imports it the first time that locale is asked for.
  - The shells' request configuration awaits it, and the browser only receives the active locale's messages from
    the next-intl provider.
  - The Edge Function bundle never imports the loader, so it carries no Beta catalog. Compass hands i18next only
    the device locale and en-US.
- **Chosen, never guessed.** The cookie accepts a Beta locale; Accept-Language and the Compass device locale match
  launch locales only, because a Beta catalog can still read mostly English.
- **Marked Beta.** The Atlas account menu and the Gateway account panel label them "Français (Beta)". The word is
  part of the accessible name, so screen readers announce it. The language names are endonyms, protected from
  translation in `translation/terms.json`. The settings choices for `locale.language` say Beta too.
- **The pipeline (ADR 0037).**
  - The five are targets in `translation/config.json` with `partial: true` and the surfaces `catalogs` and
    `canon`. Help articles and guides stay English for them.
  - The offline check counts their missing keys instead of failing. It still checks everything a Beta catalog
    holds: valid ICU, no extra keys, no empty strings, protected words kept.
  - `glossary.csv` has a column per Beta language; only the never-translated product names are filled.
  - `translate.yml` checks the three Google repository variables first. Until the owner sets them, the run ends
    with a notice and touches nothing.
- **Docs site.** The docs site and help center keep the launch locales.

### 2. Canon label translations (migration 1541)

- **Registry.** `xpms.canon_vocabulary` lists 20 vocabularies (departments, disciplines, categories, phases,
  tiers, teams, roles, job titles, record kinds, classes, states and subtypes, worker classifications, grades, GL
  accounts, emergency codes, Standard Library enumerations, regions, cost center templates and counterparty
  types). Each names its canon table and its code and label columns.
- **Labels.** `xpms.canon_label` holds one label per vocabulary, code and locale (`xpms.dim_locale`). en-US is never
  stored there: the canon table holds it. A trigger refuses a code the vocabulary lacks.
- **One reader.** `xpms.canon_labels(vocabulary, locale)` returns every code with the locale's label, or en-US
  with `translated = false`. `xpms.canon_label_of` returns one label. `@xos/data/canon-labels` wraps them.
  - Atlas reads them for the canon browser's departments, disciplines, categories, phases and roles, and for the
    crew job titles.
- **Files to database.**
  - The canon importer writes `packages/i18n/canon/en-US/<vocabulary>.json` from the seed rows, and
    `canon:check` holds it.
  - The pipeline's `canon` surface (partial in every locale) writes `packages/i18n/canon/<locale>/`.
  - `pnpm --filter @xos/i18n canon:sql` prints the `xpms.put_canon_labels` statements for a new migration, and
    `test/canon.test.ts` fails until the migrations load what the files hold, as the settings registry does.
- **es-US seed.** es-US is seeded from labels the catalogs already held for canon codes: phases, record kinds,
  classes, states and subtypes, and worker classifications (178 labels). The other vocabularies wait for the
  owner's first `translate`.

### 3. ECB daily reference rates (migration 1542)

- **Worker.** The Edge Function `fx-rates-ecb` fetches
  `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml`, parses it (`ecb.ts`, Web APIs only) and calls
  `app.record_fx_reference_rates`.
- **Writes, idempotent per date.**
  - The rates go into `private.fx_reference_rates`, once for the platform.
  - They also go into every live org's `app.fx_rates`, as EUR to each currency with source `ECB`.
  - `effective_on` is the ECB publication date stated in the file, a CET business day, never a date taken from
    UTC.
  - A rerun for the same date writes nothing. An org's own rate for the same pair and day is never overwritten.
    Currencies XOS does not know are skipped and counted.
- **Failures recorded.** Every run lands in `private.fx_feed_runs`. A fetch, parse or database failure is
  recorded by `app.record_fx_feed_failure`, never dropped.
- **Schedule.** pg_cron job `xos_fx_rates_ecb` runs at `30 15,21 * * 1-5` (after the 16:00 CET publication in
  winter and summer, with an evening retry). It calls `private.request_fx_feed`, which posts to the function with
  the Vault secrets `xos_worker_key` and `xos_functions_url`. Without them it records a failed run saying so.
- **Honest conversions.**
  - `findFxRate` now also answers through EUR (ECB quotes everything against the euro). A cross rate's date is the
    older of its two legs, and the budget line says "through EUR".
  - A rate more than five days older than the business date it converts for is marked stale, with its age. ECB
    skips TARGET holidays, so a Thursday rate is the latest until the Tuesday after Easter.
  - The Cost centers rate table lists the latest rate of each pair, not every day.
  - `app.fx_feed_status` tells the page when ECB rates last arrived or that the feed is failing, and why.
  - Unpriced amounts stay unpriced.

### 4. Display units and the time zone toggle

- **`locale.units`** gains `jurisdiction`, its new default (migration 1540).
  - Resolution order: a system the org or person chose; otherwise the project's jurisdiction (project, then venue,
    through `xpms.jurisdiction_resolved`); otherwise the region of the person's locale. Imperial for the United
    States (and Liberia and Myanmar), metric otherwise.
  - Values stay stored in one unit and are converted only for display and input. `@xos/i18n/units` has no
    dependencies and is shared by Atlas, Gateway and Compass.
  - It applies to the weather board's wind, lightning distance and heat index (display and input, Atlas and
    Compass), GPS accuracy, floor areas and distances.
- **`me.time_zone_display`** is a new personal setting with the choices `event` (the default) and `viewer`.
  - Schedule times show in the event's zone (shift, record or project) or the person's own `locale.time_zone`
    (the device's in Compass), always with the zone abbreviation.
  - Atlas: schedule, records, run of show, call sheets, baselines, crew shifts. Gateway: engagement shifts,
    positions, punches, set times, cues, records, home and upcoming. Compass: today and schedule.
- Both settings carry `enforced_by` entries (ADR 0032).

## Alternatives considered

- **Statically importing Beta catalogs into `catalogs.generated.ts`.** Simpler, but every bundle that reads
  messages would carry all five once they fill, the Edge bundle and Compass included.
- **Negotiating Beta locales from Accept-Language.** A French browser would get French number formats around
  English text until the first translation run.
- **Canon translations in the app catalogs.** The spec asks for translation tables, and API and SQL readers need
  them too.
- **A global `fx_rates` row with a null org.** It would change a frozen API schema and the table's RLS, audit and
  uniqueness rules. Writing each org's copy keeps every existing reader and the org's own rates as they are.
- **Fetching ECB XML in SQL with pg_net.** No Edge deploy would be needed, but the request is asynchronous, the
  parsing could not be tested on a committed fixture, and failures would be harder to record.

## Consequences

- **Owner steps.**
  - Google Cloud credentials for the pipeline (ADR 0037, unchanged names): `GOOGLE_CLOUD_PROJECT`,
    `GOOGLE_TRANSLATE_GLOSSARY_BUCKET`, `GOOGLE_WORKLOAD_IDENTITY_PROVIDER` and `GOOGLE_TRANSLATE_SERVICE_ACCOUNT`.
    Then run `translate` for the Beta locales and the canon labels, and add the migration `canon:sql` prints.
  - Vault secret `xos_functions_url` for the ECB feed, beside the existing `xos_worker_key`.
- **Feed volume.** About 29 `fx_rates` rows per org per ECB business day, each audited.
- **Defaults change.** People who never chose units now follow the project's jurisdiction, so non-US projects show
  metric. Explicit choices are kept.
- **Still English for Beta locales:** Gateway job titles from `api_external` views, the email and push weather
  alert text (which carries no unit), and Compass's own language (device locale, launch locales only).
