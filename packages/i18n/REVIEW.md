# Translation review record

Section 15 of the build spec says each locale becomes general only after a native reviewer signs it off, and that
the sign-off is recorded here. ADR 0006 and ADR 0014 (open decision 11) point to this file for the es-US review.
`test/review.test.ts` fails when a shipped locale is missing from the table below.

## Status

| Locale | Role                              | Review state                       | Reviewer | Signed off | Notes                                                                                                                                                                                                |
| ------ | --------------------------------- | ---------------------------------- | -------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| en-US  | Source locale (Section 15)        | Source, reviewed with each change  | n/a      | n/a        | The source of every message. Copy rules: Section 3.6 (American English, no em dashes) and the vocabulary checks in `test/terminology.test.ts`.                                                       |
| es-US  | Launch locale (Section 15)        | Awaiting native review             | None yet | No         | Owner decision 27 (ADR 0033, RRR-68): a native reviewer is to be hired. A project gate is "compuerta" and a physical door or gate is "puerta" (ADR 0034 item 3), held by `test/terminology.test.ts`. |
| fr-FR  | Beta locale (Section 15)          | Beta, awaiting machine translation | None     | No         | Shipped marked Beta in the language picker (ADR 0053). Its catalog is written by the Google Translate pipeline (ADR 0037) on the owner's first run; until then every key reads en-US.                |
| de-DE  | Beta locale (Section 15)          | Beta, awaiting machine translation | None     | No         | As fr-FR.                                                                                                                                                                                            |
| it-IT  | Beta locale (Section 15)          | Beta, awaiting machine translation | None     | No         | As fr-FR.                                                                                                                                                                                            |
| pt-BR  | Beta locale (Section 15)          | Beta, awaiting machine translation | None     | No         | As fr-FR. Google's language code is `pt`, which is Brazilian Portuguese.                                                                                                                             |
| ja-JP  | Beta locale (Section 15)          | Beta, awaiting machine translation | None     | No         | As fr-FR.                                                                                                                                                                                            |
| en-XA  | Pseudo-locale for CI (Section 15) | Generated, never reviewed          | n/a      | n/a        | Accented and 40 percent longer, generated into `messages/pseudo`.                                                                                                                                    |
| ar-XB  | Pseudo-locale for CI (Section 15) | Generated, never reviewed          | n/a      | n/a        | Right to left, generated into `messages/pseudo`.                                                                                                                                                     |

## How to record a sign-off

1. The reviewer reads every namespace of the locale in `messages/<locale>/` and the help articles of the shells.
2. Fixes land as ordinary changes to the catalogs.
3. The reviewer's name, the date and the commit reviewed go in the table above, and the review state becomes
   "Signed off". A Beta locale then loses its Beta mark in the language picker: move it from `betaLocales` to
   `launchLocales` in `src/locales.ts` and drop `partial` from its target in `translation/config.json`, so the
   catalog tests hold it complete and strict (ADR 0053).
