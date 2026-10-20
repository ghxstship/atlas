# ADR 0037: Machine Translation Replaces the Native Spanish Reviewer

- Status: Accepted
- Date: 2026-10-20
- Decider: Owner (Julian Clarkson); built and recorded by A73 (RRR-118)
- Amends: ADR 0033 decision 27 (RRR-68)

## Context

ADR 0033 decision 27 planned to hire a native reviewer for the es-US copy. On 2026-10-20 the owner decided instead that Google Translate reviews the Spanish and produces every other translation. Until now every es-US string, help article and guide was written by hand, alongside its en-US source.

This ADR records what is translated, how the pipeline works, the API, model and glossary choices with their prices, and what the owner does to run it. The pipeline is in `packages/i18n` (`src/translation/`, `scripts/translate.ts`, `translation/`). The only step left is the owner's: authorize Google Cloud and run one command.

## Decision

### 1. Translated surfaces

| Surface                                                                                       | Where                                                                                                                            | Covered                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App copy for Atlas, Gateway and Compass, the `ui` design system strings and navigation labels | `packages/i18n/messages/<locale>/<namespace>.json`: 52 namespaces, 12,805 strings                                                | Yes, surface `catalogs`                                                                                                                                                  |
| Email templates                                                                               | `packages/email`. The React Email components hold the HTML, and all copy comes from the `email` namespace. Rich text is ICU tags | Yes, through `catalogs`                                                                                                                                                  |
| Generated documents and PDFs (ADR 0031)                                                       | The `documents` namespace                                                                                                        | Yes, through `catalogs`                                                                                                                                                  |
| Status page                                                                                   | The `status` namespace (`infra/status`)                                                                                          | Yes, through `catalogs`                                                                                                                                                  |
| Docs site and help center chrome, tips, tours and What's New                                  | The `docs` and `help` namespaces                                                                                                 | Yes, through `catalogs`                                                                                                                                                  |
| Help articles (in-app help and the public help center)                                        | `apps/atlas/help/articles/<locale>/*.md`: 36 articles                                                                            | Yes, surface `help` (front matter `title` and `summary`, and the body)                                                                                                   |
| Docs guides                                                                                   | `apps/docs/content/guides/<locale>/*.md`: 11 guides                                                                              | Yes, surface `guides`                                                                                                                                                    |
| Compass Live Activity                                                                         | `apps/compass/targets/ClockActivity`. The labels are passed in from the catalogs                                                 | Yes, through `catalogs`                                                                                                                                                  |
| Compass store listings                                                                        | A68 (RRR-113) writes the English App Store and Play listing files. They are not on main yet                                      | Not yet. Once A68's files land, add one `text` or `markdown` surface for them to `translation/config.json`. The pipeline writes nothing under `apps/compass` until then. |
| Compass iOS permission prompts                                                                | `NSCameraUsageDescription` and the other prompts in `apps/compass/app.json`, English only                                        | No. This is a gap: Expo `locales` files per language, then a surface entry                                                                                               |
| API reference operation descriptions                                                          | `packages/api/openapi/v1.json`, shown in English on both locales' pages                                                          | No. It is a developer reference, and the English contract is the source of truth                                                                                         |
| Pseudo-locales `en-XA` and `ar-XB`                                                            | `packages/i18n/messages/pseudo` (`ui` only) and `apps/*/i18n/pseudo.ts` at runtime                                               | Never. They are derived from en-US by rule, for gate 16                                                                                                                  |
| Seeded reference data                                                                         | Canon tables and seeds                                                                                                           | Nothing to translate. Canon values are English, display labels come from the catalogs, and `xpms.dim_locale` only lists locale codes                                     |

### 2. API and model

- **API:** Cloud Translation API v3 (Advanced): `POST https://translation.googleapis.com/v3/projects/{project}/locations/us-central1:translateText` with `mimeType: text/html`. Requests go through `fetch` to the REST endpoint. The location is `us-central1` because glossaries are hosted there.
- **Model: Translation LLM** (`general/translation-llm`). The reasons:
  - It is the only Google model that accepts **es-US** (Spanish, United States) as a target. NMT offers only generic `es`.
  - It supports glossaries. It is also the only model with contextual glossary translation (`contextualTranslationEnabled`), which inflects a glossary term to fit the sentence, for example "compuertas". The pipeline turns this on.
  - Its price is about the same as NMT.
- **Prices**, from Google's pricing page on 2026-10-20 (also in `translation/config.json`):
  - Translation LLM costs USD 10 per million input characters and USD 10 per million output characters.
  - NMT costs USD 20 per million characters, with the first 500,000 characters a month free.
  - Adaptive Translation costs USD 25 per million in each direction.
  - Creating a glossary is free. Every character in a request is billed, including HTML markup and text marked not to translate.
- **Limits:** a request can carry 30,000 characters, and Translation LLM allows 900 requests a minute. The pipeline sends at most 100 segments or 5,000 code points per request, which is Google's recommended size, with 4 requests in flight.
- **To switch to NMT:** set `google.model` to `general/nmt`, set the target's `google` code to `es` (and rename the glossary column to match), and update the prices.

### 3. Authentication

- **Application Default Credentials only.** No JSON key and no API key is created, stored or read.
  - Locally, the owner runs `gcloud auth application-default login`. The pipeline gets a token from `gcloud auth application-default print-access-token`.
  - In GitHub Actions, `google-github-actions/auth` v3.0.0 exchanges the workflow's OIDC token through Workload Identity Federation and impersonates the translation service account. With `token_format: access_token`, it passes a short-lived token as `GOOGLE_OAUTH_ACCESS_TOKEN`.
- **The `x-goog-user-project` header** names `GOOGLE_CLOUD_PROJECT` on every call, so usage is billed to that project.
- **Why not the official client:** `@google-cloud/translate` brings gRPC and google-gax, and `google-auth-library` would be a new dependency. The gcloud CLI is already needed for the ADC login. So the transport is about 100 lines of `fetch` with no new dependency.
- RRR-118 mentioned a service account key or an API key. This ADR replaces both with ADC and Workload Identity Federation.

### 4. Protecting what must not change

- **Segments.** A message is split into segments of HTML.
  - Each run of text at one level of an ICU message is one segment.
  - Each plural, select or selectordinal branch is translated on its own.
  - Simple arguments (`{name}`, `{n, number}`, `{d, date, short}`), `#` and protected words go to Google inside `<span translate="no">`.
  - Rich text tags (`<b>`, `<termsLink>`) become spans whose children are translated in place.
- **Reassembly.** The argument headers, branch keys and spacing are copied from the en-US source, so only literal text changes. ICU syntax characters in translated text are escaped.
- **Markdown.** Each prose line, table cell and translated front matter value is a segment. Code spans, URLs, images and escapes are frozen. Link text, bold and italic are translated, and the markup and link targets are restored. Fenced code is copied unchanged.
- **Tidying.** Em dashes are replaced (the finish guard refuses them, and ADR 0033 decision 26 accepts the substitution). Non-breaking and doubled spaces are removed, and so are gaps Google leaves next to a frozen span.
- **Validation.** A translation is written only when all of these hold:
  - Its spans all came back, each exactly once.
  - Its ICU structure matches en-US: the same arguments with the same types and styles, the same select keys, the same plural exact keys and offset, plural categories that the source or the target locale uses, and the same tags.
  - Every protected word is kept.
  - Every terminology rule holds.
- **Failures.** A failed translation keeps the current value. A failed string that had no value gets the en-US text, marked `fallback` in the memory so the next run retries it.

### 5. Glossary and do-not-translate list

- **`translation/glossary.csv`** is an equivalent term set: a header row of Google language codes (`en,es-US`) plus Google's optional `description` column.
  - It starts from the help glossary article and the renderings the es-US catalogs already use consistently: project gate is compuerta, phase is fase, baseline is línea base, engagement is contratación, timesheet is hoja de horas, venue is recinto, and so on.
  - It also has identity rows for the product names.
  - Matching is case-sensitive (Google's default), so the singular, plural and capitalized forms are separate rows. "Shift" is lowercase only, because Shift is also a keyboard key.
- **`translate:glossary`** (owner-run) uploads the file.
  - It copies the file to `gs://<GOOGLE_TRANSLATE_GLOSSARY_BUCKET>/glossaries/` and creates the glossary `xos-glossary-<first 8 hex of its SHA-256>`.
  - The glossary version is therefore part of the resource name and of the cache key, and a changed file creates a new glossary instead of changing one in use.
  - `--prune` deletes the older ones.
- **`translation/terms.json`** holds the do-not-translate list and the checked rules.
  - **Terms:** XOS, Atlas, Gateway, Compass, Aurora, Legend, URID, GHXSTSHIP, ATLVS, and third-party names such as Stripe, Google Play and QuickBooks.
  - **Plan names:** Core, Pro and Enterprise are protected everywhere. Team and Access are protected only where they name a plan. The es-US catalogs already say "plan Team".
  - **Patterns:** canon codes (`NWL-12`, `CC-VENUE`), identifiers (`yes_no`), dotted names (`reports.report.export`), URLs and paths. Example email addresses are masked for Google but not checked, because a person may localize them.
  - **Rules:** a project gate is a "compuerta" in es-US. The 16 physical-gate keys keep "puerta" and are sent to Google without the glossary. A door is never a "compuerta".
  - `packages/i18n/test/terminology.test.ts` reads the same physical-gate keys.

### 6. Commands

| Command (`pnpm --filter @xos/i18n ...`) | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `translate`                             | In every target locale, fills missing strings and files and re-translates stale ones (en-US changed since the last translation). Never touches a locked string. Writes `docs/i18n/translate-<locale>.md`                                                                                                                                                                                                                                                                                                                                                   |
| `translate:review`                      | For es-US (or `--locale`), translates every en-US string and file fresh and compares Google's version with the current one, after normalizing case, punctuation and whitespace. Writes `docs/i18n/review/<locale>/` (a summary and one file per catalog namespace or surface). Applies Google's version unless `--no-apply`. Keeps the current version when it is locked, when it uses a glossary term that Google's version drops, or when Google's version fails validation. Replaces a current version that breaks structure, protected words or a rule |
| `translate:all`                         | `translate:glossary` (a no-op when that version exists), `translate`, then `translate:review`. The owner's first run                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `translate:glossary`                    | Uploads `glossary.csv`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `translate:check`                       | The offline check (section 8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `translate:lock <key...>`               | Locks strings a person edited (`--unlock` releases them). Keys are catalog keys (`email.common.greeting`) or `<surface>/<file>` (`help/gates.md`)                                                                                                                                                                                                                                                                                                                                                                                                          |

- **`--dry-run`** works with every network command. It plans the work and prints strings, segments, cached segments, characters and an estimated cost per locale. It touches neither the network nor any file.
- **Generated files.** After they write, the commands regenerate the files that copy translated text: `src/catalogs.generated.ts` and `src/extracts.generated.ts`, and Atlas's help modules (`apps/atlas/test/help.test.ts` with `XOS_WRITE_GENERATED=1`).
- **Test expectations.** Both reports list the tests (`apps/*/test`, `apps/*/e2e`, `packages/*/test`, `infra/*/test`) that quote a Spanish string the run changed, so the expectations can be updated in the same commit.

### 7. Translation memory

- **Files:** one committed file per target locale, `packages/i18n/translation/memory/<locale>.json`. It does not exist until the first run.
  - `entries` maps each key or `<surface>/<file>` to `"<google|human|fallback> <en-US source hash>[ locked]"`. The source hash is the first 16 hex of SHA-256.
  - `segments` maps `"<engine>:<segment hash>"` to Google's output. The engine is a hash of the model, the glossary version and the contextual glossary switch.
- **What it gives:** the cache is keyed by source text, target locale and glossary version. Reruns and CI never call the API for an unchanged string. A new model or glossary makes every segment a miss, and the older segments are pruned on the next write.
- **Size:** about 1.6 MB per locale after a full run.

### 8. The offline check in `pnpm verify`

`packages/i18n/test/translation/repository.test.ts` runs the check on the real files, with no network. It is part of `pnpm --filter @xos/i18n test`, so it runs in `pnpm verify` and in the CI `checks` job. `packages/i18n/turbo.json` adds the help articles and guides to the test task's inputs.

- **Errors:**
  - A target misses a namespace, key or file, or has an extra or empty one.
  - A message is not valid ICU, or its structure differs from en-US.
  - A protected word is lost, or a terminology rule is broken.
  - A markdown file's untranslated front matter or code differs from en-US. Translated trailing comments in code are allowed.
- **Warnings:**
  - A target is stale against the memory's source hash.
  - A locked string's source changed.
  - A target is a fallback.
  - The memory names a key that no longer exists.
- **Why stale is a warning:** contributors change en-US and es-US by hand in the same commit and cannot call Google, so stale strings are expected between owner runs. The next `translate` run re-translates them. Setting `check.stale` to `"error"` in `translation/config.json` (or `translate:check --strict`) makes them blocking, for example on a release branch.
- **Result on 2026-10-20:** the check passes on the current catalogs: 0 errors and 0 warnings. All 12,852 es-US strings and files are "unreviewed", meaning no memory entry yet, until the first review. One gap was fixed deterministically: the es-US credentials help article now names Compass, as en-US does.

### 9. Adding a locale

1. Add `{ "locale": "fr-FR", "google": "fr" }` to `targets` in `packages/i18n/translation/config.json`. Use the code Google's language list gives for the model.
2. Add a `fr` column to `glossary.csv`, then run `translate:glossary`.
3. Run `pnpm --filter @xos/i18n translate --locale fr-FR`. It writes every catalog, help article and guide, and the memory.

Shipping the locale in the apps is a separate change: `src/locales.ts`, `LOCALES` in `scripts/generate-catalogs.ts`, the catalog map in `src/index.ts`, the apps' locale negotiation, `HELP_LOCALES`, the API's `SUPPORTED_LOCALES` and the `locale.language` setting choices. A full fill of one new locale costs about the same as the es-US review below.

### 10. Cost of the first run (dry runs on 2026-10-20)

| Run                     | Strings and files                               | Segments                                 | Characters billed                          | Estimated cost |
| ----------------------- | ----------------------------------------------- | ---------------------------------------- | ------------------------------------------ | -------------- |
| First es-US `translate` | 0 missing or stale (12,852 unreviewed)          | 0                                        | 0                                          | USD 0.00       |
| First es-US `review`    | 12,852 (12,805 strings, 47 articles and guides) | 13,758, of which 9,780 distinct are sent | 443,525 (351,199 of text, the rest markup) | USD 9.76       |

The estimate counts input and output at USD 10 per million each, with output assumed 1.2 times the input. Later runs send only new or changed segments.

## Alternatives considered

- **A native reviewer (ADR 0033 decision 27):** replaced by the owner's decision.
- **NMT:** it has a free tier, but it has no es-US target, and its glossary matching does not inflect terms.
- **Adaptive Translation:** it costs 2.5 times as much and needs example sentence pairs to steer it. The glossary and the rules give the control this product needs.
- **The official Node client, or a service account key or API key:** heavier, or long-lived secrets. ADC with Workload Identity Federation needs neither.
- **Translating whole plural messages with the structure masked:** Google sees more context, but the structure can come back changed. Translating per branch keeps the ICU structure exact, and validation still checks it.

## Consequences

- **Wording changes.** The first owner `translate:review` will change much of the es-US wording. The review report shows every change, with the reason for each kept string.
- **Tests may need updating.** A few tests assert Spanish strings, for example `packages/email/test/email.test.ts` and `infra/status/test/render.test.ts`. The report lists the ones a run changed. Update those expectations, or lock the key.
- **Register.** The current es-US copy mixes "tú" and "usted". The Translation LLM takes no style instruction, so after the review the register is whatever Google chooses. A rule in `terms.json` can enforce one later if the owner wants.
- **Controls for wrong translations.** Google can be wrong about a domain term. The controls are the glossary, the checked rules and locks. Anyone may hand-edit a string and run `translate:lock` on it.
- **Owner actions,** with exact names in `infra/runbooks/production.md`, section Machine translation:
  - Create or choose the Google Cloud project, with billing and the Cloud Translation API.
  - Create the glossary bucket and grant the IAM roles.
  - Run `gcloud auth application-default login`.
  - For CI, set up the Workload Identity Federation provider and the service account.
  - Run `pnpm --filter @xos/i18n translate:all`, review the result, and commit it.

## Amends

- **ADR 0033 decision 27:** a native reviewer is no longer hired. Google Cloud Translation reviews es-US and produces every other translation, under this ADR. A project gate is still a "compuerta".
- **ADR 0001, CI actions:** adds `google-github-actions/auth` v3.0.0 (`7c6bc770dae815cd3e89ee6cdf493a5fab2cc093`). This applies when the orchestrator adds the manual translation workflow from `infra/ci/README.md`, section 7.
