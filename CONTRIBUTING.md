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
3. Write commit messages in Conventional Commits form, for example `feat(finance): add change order pricing`.
4. Run `pnpm verify` and `supabase test db` locally. Both must pass.
5. Open a pull request with the template filled in, referencing the issue or ADR.

## Rules every change follows

- Database first: authorization, tenancy, state transitions and money invariants are enforced in Postgres, with pgTAP tests.
- No unfinished work reaches `main`. The finish guard fails the build on unfinished-work markers, filler copy, test doubles in production paths and em dash characters.
- Generated files (database types, OpenAPI document, SDKs, navigation) are regenerated, never edited by hand.
- User-facing copy lives only in `packages/i18n` catalogs, in en-US and es-US.
- Canon values are read from the canon tables. They are never typed by hand.
- Every error path recovers, surfaces a typed error or returns a refusal. Empty catch blocks fail lint.

## Code of Conduct

Participation is governed by `CODE_OF_CONDUCT.md`.
