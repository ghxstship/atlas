# ADR 0038: Rating Prompts and Fixed Record Keys

- Status: Accepted
- Date: 2026-10-20
- Decider: Owner (Julian Clarkson); built and recorded by A76 (RRR-121)
- Amends: the A65-001 deferrals of `gateway.ratings_enabled` and `numbering.record_key_format`

## Context

A65-001 found registered settings that nothing applied. A76 wired them, but deferred two that needed an owner decision:

- **`gateway.ratings_enabled`** ("Ratings: ask both sides to rate each other"). Turning ratings off for both sides would hide reviews. The FTC rule on consumer reviews and testimonials (16 CFR Part 465) bans suppressing reviews, and Section 14.9 already says ratings are never edited, withdrawn or suppressed.
- **`numbering.record_key_format`**. Section 4.5.1 fixes record keys as `{projectKey}-{sequence}`. Keys live in URLs, QR codes, offline Compass data and API v1 (ADR 0030 names records by them).

## Decision

### 1. Ratings are always on; the setting only prompts

- Nothing lets an org hide, remove or filter ratings. Both sides keep rating every completed engagement, and ratings release as ADR 0019 decision 6 says.
- `gateway.ratings_enabled` keeps its key, so no stored value moves. It now means one thing: whether the org's own members are prompted to rate the people it engages. Its label is "Prompt members to rate parties".
  - With prompts on (the default), the Ratings page lists the completed engagements waiting for the org's rating, and each such engagement shows Rate the party as its next step.
  - With prompts off, those two prompts go. Members can still rate from the engagement.
- Turning prompts off never hides or removes a rating, and never changes what a rated party or a marketplace viewer sees. No view, policy or function in the database reads the setting.
- Moderation follows policy only: abuse and personal data. It applies whatever the score, and never to remove an honest low rating.
- Counsel confirms this reading of 16 CFR Part 465 before launch. That confirmation belongs here and in the release checklist, not in the product.

Where it lives:

- The registry entry is in `packages/schemas/settings/a30.yaml`, with new label and help text.
- Atlas reads it through `ratingPromptsOn` and `engagementsToRate` in `apps/atlas/lib/shell/org-settings.ts`, on the Ratings page and in the engagement list.
- pgTAP 1329 proves the result: with prompts off, the org, the rated party's account and a marketplace viewer still see every rating, and members can still rate.

### 2. Record keys stay fixed for launch

- Record keys are fixed. URLs, QR codes, offline Compass data and API v1 depend on them.
- `numbering.record_key_format` stays in the registry and the database, deferred, and marked `hidden: true` with no pages, so no settings screen offers it.
- Migration 1329 refuses any value for it, saved or locked at any scope, with `setting_fixed`. A value stored earlier does nothing and can still be cleared.
- A future change would apply only to new records. Old keys would keep resolving permanently and would never be reused.
- The numbers an org customizes are the invoice prefix (`org.invoice_number_prefix`) and the document number padding (`numbering.document_number_padding`). The padding's help text says so.

## Consequences

- The settings guard (`packages/schemas/test/settings/enforcement.test.ts`) now lists `gateway.ratings_enabled` as enforced, with its consumer and two tests. The deferred list keeps `numbering.record_key_format`.
- The registry gains `hidden`: a deferred setting on no screen. The loader refuses a hidden setting that names a page or is not deferred.
- The Atlas help article on opportunities states that ratings are always on and that moderation is policy-only.

## Alternatives considered

- **Renaming the key** to something like `gateway.rating_prompts`. This would move stored values and audit history to a new key, for a name only Admins and the API see. The label and help text carry the meaning, so the key was kept.
- **Removing the record key setting.** Keeping it hidden and refused keeps the registry, the database definitions and gate 32 in agreement, and leaves room for the future rule above.
