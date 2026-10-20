# Contributing to XOS

Thank you for helping build XOS. This guide covers how changes are proposed, reviewed and merged.

## Developer Certificate of Origin

Every commit must be signed off under the Developer Certificate of Origin 1.1 (the `DCO` file in the repository root). Sign off by adding a trailer to each commit message:

```text
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you. Pull requests with unsigned commits cannot merge.

## Workflow

1. Open an issue or reference an ADR in `docs/adr/` before starting non-trivial work.
2. Branch from `main`. Each change stays inside the paths its owner holds (ADR 0004).
3. Write commit messages in Conventional Commits form, for example `feat(finance): add change order pricing`. Name the Linear issue in a trailer: `Part of RRR-n` while work continues, `Fixes RRR-n` on the commit that completes it (ADR 0015).
4. Run `pnpm verify` and `supabase test db` locally. Both must pass.
5. Open a pull request with the template filled in, referencing the issue or ADR.

## Rules every change follows

- Database first: authorization, tenancy, state transitions and money invariants are enforced in Postgres, with pgTAP tests.
- No unfinished work reaches `main`. The finish guard fails the build on unfinished-work markers, filler copy, test doubles in production paths and em dash characters.
- Generated files (database types, OpenAPI document, SDKs, navigation) are regenerated, never edited by hand.
- User-facing copy lives only in `packages/i18n` catalogs, in en-US and es-US. See "Adding or changing strings" below.
- Canon values are read from the canon tables. They are never typed by hand.
- Every error path recovers, surfaces a typed error or returns a refusal. Empty catch blocks fail lint.

## Adding or changing strings

en-US is the source. Google Cloud Translation produces and reviews every other locale (ADR 0037), and the owner runs it.

1. **Add the en-US string.** Put it in `packages/i18n/messages/en-US/<namespace>.json`, as an ICU message: arguments in braces, plural and select for counts and choices, tags for rich text.
2. **Add the es-US string.** Put a Spanish version under the same key in `messages/es-US/<namespace>.json`, so the catalogs stay complete. Keep every argument, plural or select key and tag exactly as in en-US.
   - A project gate is a "compuerta", and a door or vehicle gate is a "puerta".
   - Product names (XOS, Atlas, Gateway, Compass, Aurora), plan names and canon codes stay as they are.
   - The full list is `packages/i18n/translation/terms.json`.
3. **Regenerate the catalogs.** Run `pnpm --filter @xos/i18n generate:catalogs` if you added a namespace file or changed a string that `packages/i18n/client-extracts.json` copies.
4. **Run `pnpm verify`.** The translation check in it fails on a missing key, a broken ICU structure, a lost protected word or a broken terminology rule.
   - It warns, without failing, when an es-US string is older than its en-US source.
   - The owner's next `pnpm --filter @xos/i18n translate` run replaces those warned strings with Google's version.
5. **Lock a deliberate wording.** If an es-US wording must survive machine translation, lock it with `pnpm --filter @xos/i18n translate:lock <key>` and commit `packages/i18n/translation/memory/es-US.json`.

Help articles (`apps/atlas/help/articles/<locale>/`) and docs guides (`apps/docs/content/guides/<locale>/`) follow the same rules, one Markdown file per locale.

## Code of Conduct

Participation is governed by `CODE_OF_CONDUCT.md`.
