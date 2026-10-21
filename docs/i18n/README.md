# Translation reports

Google Cloud Translation produces and reviews every locale other than en-US (ADR 0037). This folder holds the reports its runs write. The owner runs it; setup and steps are in `infra/runbooks/production.md`, section Machine translation.

| File                        | Written by                                 | Holds                                                                                                                                                                                |
| --------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `review/<locale>/README.md` | `pnpm --filter @xos/i18n translate:review` | The summary of the last review: strings and files compared, how many differ per catalog namespace or surface, the decisions, and the tests whose expectations quote a changed string |
| `review/<locale>/<name>.md` | `translate:review`                         | Every string of one catalog namespace (or every file of the help or guides surface) whose wording differs: en-US, the previous version, Google's version and the decision            |
| `translate-<locale>.md`     | `pnpm --filter @xos/i18n translate`        | The last translate run: counts, strings that failed and kept their value, locked strings whose en-US changed, and tests to update                                                    |

## Status on 2026-10-21 (A97, ADR 0053)

- **Five Beta locales are targets:** fr-FR, de-DE, it-IT, pt-BR and ja-JP, partial and translated on the `catalogs` and `canon` surfaces only. Their catalogs are empty until the owner's first run, and every key reads en-US meanwhile.
- **Canon labels are a surface:** `packages/i18n/canon/<locale>/`, partial in every locale. es-US holds 178 of 930 labels, copied from the catalogs; a migration loads them (`pnpm --filter @xos/i18n canon:sql`).
- **Dry run of the first `translate`** (2026-10-21, no network):
  - es-US: 752 canon labels to translate, 10,822 characters, about USD 0.24.
  - Each Beta locale: 14,102 catalog strings and 930 canon labels, 10,663 distinct segments, 435,597 characters billed, about USD 9.58. All five come to about USD 48.

## Status on 2026-10-20

- **The pipeline is in place:** `packages/i18n/src/translation/`, `packages/i18n/scripts/translate.ts` and `packages/i18n/translation/`.
- **The owner has not run it yet**, so no review report exists and there is no translation memory (`packages/i18n/translation/memory/`).
- **The offline check passes** on the current catalogs, help articles and guides: 0 errors and 0 warnings. All 12,852 es-US strings and files are unreviewed until the first review.
- **Dry runs, before any run:**
  - The first es-US `translate` has nothing to do: no string is missing or stale.
  - The first es-US `translate:review` compares 12,852 strings and files. It sends 9,780 distinct segments and bills 443,525 characters (351,199 of them text), at an estimated USD 9.76 on the Translation LLM.
