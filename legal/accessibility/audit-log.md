---
title: Accessibility Audit Log
version: 1.1.0-draft
effective_date: 2026-10-16 (first audit entries)
status: Draft for review by counsel before launch
audience: Internal; summarized in the ACRs and the Accessibility Statement
---

# Accessibility Audit Log

> **Draft for review by counsel before launch.** Entries 1 to 23 record the Wave 6 independent audit by A23 on main 5f4e839; entries 24 to 28 record A35's fixes and re-verification. Screen reader passes with real assistive technology are still owed; see "Passes still owed" below.

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

| 1 | 2026-10-16 | Atlas | Every sitemap route, Owner, Manager, Field, Viewer (sweep) | 5f4e839 | Automated axe, dark and light, reduced motion | Chrome 155 headless, Playwright 1.64, axe-core 4.13, 1280 px | WCAG 2.0, 2.1, 2.2 A and AA tags | Fail | A23-011 (Moderate), A23-016 (Moderate) | A06, A05 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 2 | 2026-10-16 | Atlas | Every sitemap route at phone width (sweep) | 5f4e839 | Automated axe, reflow at 375 px, focus indicator, icon-only names and tooltips | Chrome 155 headless, Playwright 1.64, axe-core 4.13, 375 px, touch | 1.4.10, 2.1.1, 2.4.7, 2.4.11, gate 31 | Fail | A23-015 (Serious), A23-016 (Moderate) | A08, A07, A05 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 3 | 2026-10-16 | Gateway | Every sitemap route for crew (individual) and vendor (Account Owner), engagement tabs for both role types (sweep) | 5f4e839 | Automated axe, dark and light, reduced motion | Chrome 155 headless, Playwright 1.64, axe-core 4.13, 1280 px | WCAG 2.0, 2.1, 2.2 A and AA tags | Pass | None | A27 | n/a | A23 |
| 4 | 2026-10-16 | Gateway | Every sitemap route at phone width (sweep) | 5f4e839 | Automated axe, reflow at 375 px, focus | Chrome 155 headless, Playwright 1.64, axe-core 4.13, 375 px, touch | 1.4.10, 2.4.11, 2.5.8 | Fail | A23-001 (Serious), A23-013 (Moderate) | A05, A27 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 5 | 2026-10-16 | Gateway | Public profile, company page, sign in, sign up, signing and advance token flows | 5f4e839 | Automated axe, both themes | Chrome 155 headless, Playwright 1.64, axe-core 4.13, 1280 and 375 px | WCAG 2.2 A and AA tags | Pass | None | A27 | n/a | A23 |
| 6 | 2026-10-16 | Atlas | Sign in and sign up, public legal documents | 5f4e839 | Automated axe, keyboard | Chrome 155 headless, Playwright 1.64, axe-core 4.13, 1280 and 375 px | 1.3.1, 2.1.1, 2.4.7, 3.3.2 | Pass | None | A06 | n/a | A23 |
| 7 | 2026-10-16 | Atlas | Command menu (Section 11.5) | 5f4e839 | Keyboard only | Chrome 155 headless, Playwright 1.64, axe-core 4.13 | 2.1.1, 2.1.2, 2.4.3, 4.1.2 | Fail | A23-003 (Serious) | A05, A06 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 8 | 2026-10-16 | Atlas | Records list and Record side peek | 5f4e839 | Keyboard only, accessibility tree | Chrome 155 headless, Playwright 1.64, axe-core 4.13 | 1.3.1, 2.1.1, 2.1.2, 2.4.3 | Fail | A23-003 (Serious), A23-012 (Moderate) | A05, A08 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 9 | 2026-10-16 | Atlas | Create dialog (New record) | 5f4e839 | Keyboard only | Chrome 155 headless, Playwright 1.64, axe-core 4.13 | 2.1.2, 2.4.3, 3.3.2 | Fail | A23-003 (Serious) | A05, A08 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 10 | 2026-10-16 | Atlas | Home and shell landmarks, headings, skip link | 5f4e839 | Accessibility tree, keyboard | Chrome 155 headless, Playwright 1.64, axe-core 4.13 | 1.3.1, 2.4.1, 2.4.6 | Fail | A23-011 (Moderate) | A06 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 11 | 2026-10-16 | Atlas | Phone bottom bar with tip and tour cards | 5f4e839 | Keyboard at 375 px | Chrome 155 headless, Playwright 1.64, axe-core 4.13, 375 px | 1.4.13, 2.4.11 | Fail | A23-002 (Serious) | A31 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 12 | 2026-10-16 | Atlas | Toasts and undo (Move to Trash) | 5f4e839 | Source review, accessibility tree | Source at 5f4e839 | 4.1.3 | Fail | A23-014 (Moderate, needs screen reader confirmation) | A05 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 13 | 2026-10-16 | Atlas | Coordinate matrix report, Budget versus actual, Venues map | 5f4e839 | Accessibility tree | Chrome 155 headless, Playwright 1.64, axe-core 4.13 | 1.1.1, 1.3.1 | Pass | None | Module agents | n/a | A23 |
| 14 | 2026-10-16 | Gateway | Top bar, command menu, account menu | 5f4e839 | Keyboard only, accessibility tree | Chrome 155 headless, Playwright 1.64, axe-core 4.13 | 2.1.1, 2.4.1, 2.4.3 | Fail | A23-003 (Serious) | A05, A27 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 15 | 2026-10-16 | Gateway | Settings forms at phone width | 5f4e839 | Keyboard at 375 px | Chrome 155 headless, Playwright 1.64, axe-core 4.13, 375 px | 1.4.10, 2.4.11 | Fail | A23-001 (Serious), A23-013 (Moderate) | A05, A27 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 16 | 2026-10-16 | Compass | Scan (asset, receiving, credential) | 5f4e839 | Source and component review | Source at 5f4e839 | 4.1.2, 4.1.3 | Fail | A23-004 (Serious), A23-006 (Moderate) | A17 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 17 | 2026-10-16 | Compass | Clock in with geofence states | 5f4e839 | Source review, contrast from tokens | Source at 5f4e839 | 1.4.3, 1.4.4, 4.1.3 | Fail | A23-004 (Serious), A23-007 (Moderate) | A17 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 18 | 2026-10-16 | Compass | Offline queue and offline banner | 5f4e839 | Source review | Source at 5f4e839 | 2.1.1, 4.1.2, 4.1.3 | Fail | A23-004 (Serious), A23-005 (Serious) | A17 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 19 | 2026-10-16 | Compass | Quick incident, sheets, run of show live | 5f4e839 | Source review | Source at 5f4e839 | 2.3.3, 4.1.2, 4.1.3 | Fail | A23-006, A23-008, A23-009 (Moderate) | A17 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 20 | 2026-10-16 | Compass | Kiosk mode, banners | 5f4e839 | Source review | Source at 5f4e839 | 1.1.1, 4.1.2 | Fail | A23-010 (Minor) | A17 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 21 | 2026-10-16 | Compass | Touch targets on every primitive | 5f4e839 | Source review against tokens (touchMin 48 pt) | Source at 5f4e839 | 2.5.5, 2.5.8 | Pass | None | A17 | n/a | A23 |
| 22 | 2026-10-16 | Compass | Labels, roles and states on every control | 5f4e839 | Source review | Source at 5f4e839 | 1.1.1, 4.1.2 | Fail | A23-006 (Moderate) | A17 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 23 | 2026-10-16 | Atlas | Error state when a page fails (Field Lead on Project overview) | 5f4e839 | Accessibility tree, keyboard | Chrome 155 headless, Playwright 1.64, axe-core 4.13 | 1.3.1, 2.4.5, 2.4.6 | Fail | A23-017 (Moderate) | A06 | 2026-10-16, fixed (see the finding file; re-verified in entries 24 to 28) | A23 |
| 24 | 2026-10-16 | Atlas | Every sitemap route, Owner, Manager, Field, Viewer, plus sign in, sign up and public legal documents (sweep re-run) | a3af66d | Automated axe, dark and light, reduced motion, reflow at 375 px, focus, icon-only names and tooltips | Chrome 155 headless, Playwright 1.64, axe-core 4.13, 1280 and 375 px, fresh supabase db reset with every seed | WCAG 2.0, 2.1, 2.2 A and AA tags; 1.4.10, 2.1.1, 2.4.1, 2.4.7, 2.4.11, gate 31 | Pass | None open; known.ts is empty (A23-011, A23-015, A23-016, A23-017 closed). 1398 routes checked, 46 skipped (desktop-only nodes on phones, and rows the role may not read, which answer 404 inside the shell) | A35 | 2026-10-16, a3af66d | A35 |
| 25 | 2026-10-16 | Gateway | Every sitemap route for crew and vendor, public profile, company page, token flows (sweep re-run) | a3af66d | Automated axe, both themes, reflow at 375 px, focus | Chrome 155 headless, Playwright 1.64, axe-core 4.13, 1280 and 375 px, production build | WCAG 2.2 A and AA tags; 1.4.10, 2.4.11, 2.5.8 | Pass | None open; known.ts is empty (A23-001, A23-013 closed). 190 of 190 | A35 | 2026-10-16, a3af66d | A35 |
| 26 | 2026-10-16 | Compass | Quick incident, segmented controls, clock button, sheets, hold to confirm, run of show live, kiosk PIN, banners | a3af66d | Source review and unit tests (apps/compass/test/a23-moderate.test.ts, packages/ui-native/test/a23.test.tsx) | Vitest 5, jsdom with the ui-native React Native shim | 1.1.1, 1.4.4, 2.3.3, 4.1.2, 4.1.3 | Pass | None open (A23-006 to A23-010 fixed); device passes still owed | A35 | 2026-10-16, 684526f | A35 |
| 27 | 2026-10-16 | Atlas | Records list grid, toasts and undo, failed page and 404 inside the shell | a3af66d | Accessibility tree in Chrome, unit tests (packages/ui data, foundations, layout tests) | Chrome 155 headless, Playwright 1.64; Vitest 5 jsdom | 1.3.1, 2.4.5, 2.4.6, 4.1.3 | Pass | None open (A23-012, A23-014, A23-017 fixed); the A23-014 screen reader confirmation is still owed | A35 | 2026-10-16, a3af66d | A35 |
| 28 | 2026-10-16 | Atlas | Functional defects found by the sweep: Field Lead project overview, Manager saved view link, Viewer project and record links, unregistered icons, procurement view labels | a3af66d | Browser probe per role, unit tests (apps/atlas/test page-parts, saved-view-target, icons) | Chrome 155 headless, Playwright 1.64 | 1.1.1, 2.4.5, 3.2.3 | Pass | None open | A35 | 2026-10-16, a3af66d | A35 |

## How the automated entries were run

- Atlas: `pnpm --filter @xos/atlas exec playwright test -c e2e/a11y/playwright.a11y.config.ts`
  (apps/atlas/e2e/a11y). Gateway: the same with `@xos/gateway` (apps/gateway/e2e/a11y). Both run on
  a local stack after `supabase db reset` with every seed. Open findings are listed in each sweep's
  `known.ts`; an entry that stops reproducing fails the sweep so it can be closed here.
- Keyboard entries were driven by scripted key presses (Tab, Shift+Tab, Enter, Escape, arrows,
  Cmd+K) with `document.activeElement` and the accessibility tree read after each step.
- Compass entries are a source and component review of apps/compass at 5f4e839. No simulator or
  device run took place in this pass.

## Passes still owed

A23 cannot run VoiceOver, NVDA or TalkBack. Section 14.1 requires these human passes before the
ACRs can claim Supports for the criteria that depend on spoken output:

| Shell   | Screens                                                                                       | Assistive technology                                                                   | Criteria to confirm                             |
| ------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Atlas   | Every Section 11.5 Atlas screen, Command menu, Record side peek, toasts                       | VoiceOver with Safari on macOS; NVDA with Firefox and Chrome on Windows                | 1.3.1, 2.4.3, 4.1.2, 4.1.3 (A23-014)            |
| Gateway | Every Section 11.5 Gateway screen, token signing and advance flows                            | VoiceOver on macOS and iOS Safari; NVDA                                                | 1.3.1, 3.3.1, 4.1.3                             |
| Compass | Today, Clock, Kiosk, Scan, Quick incident, Inspection runner, Run of show live, Offline queue | VoiceOver on iOS; TalkBack on Android; Dynamic Type at the largest size; Reduce Motion | 1.4.4, 2.3.3, 4.1.2, 4.1.3 (A23-004 to A23-010) |
| All     | Browser zoom 200 and 400 percent, Windows high contrast (forced colors)                       | Edge on Windows                                                                        | 1.4.4, 1.4.10, 1.4.11                           |
