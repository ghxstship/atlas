---
title: Accessibility Audit Log
version: 1.0.0-draft
effective_date: The date the first audit entry is recorded
status: Draft for review by counsel before launch
audience: Internal; summarized in the ACRs and the Accessibility Statement
---

# Accessibility Audit Log

> **Draft for review by counsel before launch.** This log is a draft structure. No audit has been recorded yet.

Section 14.1 requires manual keyboard and screen reader passes on every screen in Section 11.5, with VoiceOver on macOS and iOS, NVDA and TalkBack, logged here. **Audits begin in Wave 6**, when A23 (Accessibility Review) runs the independent audit across Atlas, Gateway and Compass. Automated axe-core results are produced by CI on every build and are referenced here, not copied.

The Accessibility Conformance Reports (`acr-atlas.md` and `acr-compass.md`) are completed from this log, and every user report received under the Accessibility Statement is logged here with its 5 business day response.

## Columns

| Column            | Meaning                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Entry             | Sequential entry number, never reused                                                                                           |
| Date              | Date of the pass, in ISO 8601                                                                                                   |
| Shell             | Atlas, Gateway, Compass, Docs, Email or PDF                                                                                     |
| Screen or journey | The Section 11.5 screen name or the Section 20.2 journey number                                                                 |
| Build             | Release tag or commit SHA tested                                                                                                |
| Method            | Keyboard, VoiceOver macOS, VoiceOver iOS, NVDA, TalkBack, zoom 200 or 400 percent, Dynamic Type, reduced motion, or user report |
| Environment       | Browser or OS and assistive technology versions                                                                                 |
| Criteria          | WCAG 2.2 success criteria examined, by number                                                                                   |
| Result            | Pass, Fail or Not Applicable                                                                                                    |
| Finding           | Issue link for each failure, with severity (Critical, Serious, Moderate, Minor)                                                 |
| Owner             | Agent or team responsible for the fix                                                                                           |
| Resolved          | Date and build in which the fix was verified, or open                                                                           |
| Auditor           | Person or agent who ran the pass                                                                                                |

## Entries

| Entry | Date | Shell | Screen or journey | Build | Method | Environment | Criteria | Result | Finding | Owner | Resolved | Auditor |
| ----- | ---- | ----- | ----------------- | ----- | ------ | ----------- | -------- | ------ | ------- | ----- | -------- | ------- |

No entries yet. The first entries are recorded in Wave 6.
