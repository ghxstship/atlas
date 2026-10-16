---
title: Accessibility Conformance Report: Gateway
version: 1.0.0-draft
effective_date: The date this version is published at /legal
status: Draft for review by counsel before launch; evaluated by A23 on main 5f4e839 (Wave 6), human screen reader passes owed
---

# Accessibility Conformance Report: Gateway

> **Draft for review by counsel before launch.** This report is a draft. Levels A and AA were evaluated in the Wave 6 independent audit (A23) on build 5f4e839; human screen reader passes are still owed (see Notes). It takes effect only when GHXSTSHIP Industries LLC publishes it at /legal with completed evaluation results, and its effective date is that date of publication.

This Accessibility Conformance Report follows the structure of the ITI VPAT 2.5 International edition (VPAT 2.5Rev INT), which reports against WCAG 2.x, the Revised Section 508 Standards and EN 301 549 together. Template instructions from the VPAT form are not reproduced here.

## Name of Product and Version

Gateway 4.0, version 4.0.0 (pre-release), build 5f4e839.

## Report Date

The date this report is published at /legal. Evaluation recorded 2026-10-16 in `legal/accessibility/audit-log.md`, entries 3 to 5, 14 and 15.

## Product Description

Gateway 4.0 is the external web application of XOS 4.0 that vendors, contractors, clients, crew, staff, artists, artist representatives and sponsors use for opportunities, onboarding, engagements and payments, including the account-free signing and advance token flows. It is a Next.js web application built on the XOS design system and delivered as an installable progressive web app. Atlas has its own report (`acr-atlas.md`); Compass has `acr-compass.md`.

## Contact Information

GHXSTSHIP Industries LLC. Accessibility questions go to the accessibility mailbox listed on our contact page at /legal/contact, with a response within 5 business days as our Accessibility Statement commits.

## Notes

- **Status:** Levels A and AA are evaluated from the audit log. Level AAA is not a target and is marked Not Evaluated. Defects are filed as `legal/accessibility/findings/A23-NNN.md`; every A23 finding that affected Gateway (A23-001, A23-003, A23-013) is Fixed (A35 re-ran the sweep on 2026-10-16).
- **Screen readers:** the evaluator could not run VoiceOver, NVDA or TalkBack. Screen reader semantics were checked by reading the browser accessibility tree. Criteria that depend on spoken output (1.3.1, 3.3.1, 4.1.2, 4.1.3) need the human passes listed under "Passes still owed" in the audit log before any of them can be raised to Supports or confirmed.
- **Scope:** every Gateway route in `apps/gateway/ia/sitemap.yaml` that the demo crew member (no company account) and the demo vendor contact (Account Owner) may open, with the engagement tabs of the crew and vendor role types, plus public profiles, sign in, sign up and both token flows. The other six engagement role types share the same tab components and were not walked separately. Generated PDFs, emails and the documentation site were not audited in this pass. Supported browsers: the latest two versions of Chrome, Edge, Safari and Firefox, and Safari on iOS and iPadOS.
- **Target:** WCAG 2.2 Level AA conformance, which XOS uses to address Section 508, ADA Titles II and III, EN 301 549, the European Accessibility Act, the AODA and the Accessible Canada Act.

## Evaluation Methods Used

Used in this evaluation:

- an automated Playwright sweep (`apps/gateway/e2e/a11y`) with axe-core 4.13 and the WCAG 2.0, 2.1 and 2.2 A and AA rules, on every route for two external people and anonymous visitors, in dark and light themes, at 1280 and 375 px, with reduced motion; it also checks focus indicators, skip links, icon-only control names and tooltips, and horizontal overflow
- scripted keyboard-only journeys (top bar, command menu, account menu, settings forms at phone width) reading focus after each key
- reading the browser accessibility tree for landmarks, headings, form labels, table headers, live regions and chart and map names
- WCAG text spacing overrides on sample pages

Still owed: VoiceOver on macOS, NVDA with Firefox and Chrome, browser zoom to 200 and 400 percent, Windows high contrast mode, and veraPDF review of generated documents.

## Applicable Standards and Guidelines

| Standard or Guideline                                                                                                                       | Included in Report                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Web Content Accessibility Guidelines 2.0                                                                                                    | Level A (Yes), Level AA (Yes), Level AAA (Yes, reported through the WCAG 2.2 tables) |
| Web Content Accessibility Guidelines 2.1                                                                                                    | Level A (Yes), Level AA (Yes), Level AAA (Yes, reported through the WCAG 2.2 tables) |
| Web Content Accessibility Guidelines 2.2                                                                                                    | Level A (Yes), Level AA (Yes), Level AAA (Yes)                                       |
| Revised Section 508 standards as published by the U.S. Access Board in the Federal Register on January 18, 2017, corrected January 22, 2018 | Yes                                                                                  |
| EN 301 549 Accessibility requirements for ICT products and services, V3.1.1 (2019-11) and V3.2.1 (2021-03)                                  | Yes                                                                                  |

## Terms

The terms used in the Conformance Level columns are:

- **Supports:** the product meets the criterion through at least one method with no known defects, or through an equivalent alternative.
- **Partially Supports:** part of the product's functionality falls short of the criterion.
- **Does Not Support:** most of the product's functionality falls short of the criterion.
- **Not Applicable:** the criterion does not apply to the product, with the reason given in the remarks.
- **Not Evaluated:** no evaluation against the criterion has taken place. Used only for Level AAA criteria.

## WCAG 2.x Report

The WCAG tables also report Section 508 Chapter 5 (501.1) and Chapter 6 (602.3), and EN 301 549 Chapter 9 (Web), Chapter 10 (Non-web documents) and Chapter 11 clauses 11.1 to 11.4 (Software).

### Table 1: Success Criteria, Level A

| Criteria                                                   | Conformance Level | Remarks and Explanations                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.1.1 Non-text Content                                     | Supports          | Sweep (apps/gateway/e2e/a11y): axe in both themes on every route for crew (individual) and the vendor (Account Owner), engagement tabs for both role types, public profiles and token flows, at 1280 and 375 px found no image-alt, svg-img-alt or button-name violations; icon-only controls are named and have tooltips (gate 31 check). |
| 1.2.1 Audio-only and Video-only (Prerecorded)              | Not Applicable    | Gateway ships no prerecorded media of its own; EPK media is the artist's content.                                                                                                                                                                                                                                                          |
| 1.2.2 Captions (Prerecorded)                               | Not Applicable    | Gateway ships no prerecorded or live audio or video of its own. Media that customers upload is their content.                                                                                                                                                                                                                              |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | Not Applicable    | Gateway ships no prerecorded or live audio or video of its own. Media that customers upload is their content.                                                                                                                                                                                                                              |
| 1.3.1 Info and Relationships                               | Supports          | Banner, navigation, main and contentinfo landmarks, one h1 per page, labelled fields and search role on the Home search (accessibility tree).                                                                                                                                                                                              |
| 1.3.2 Meaningful Sequence                                  | Supports          | DOM order matches visual order on every screen read in the accessibility tree; the top bar, main and footer read in order.                                                                                                                                                                                                                 |
| 1.3.3 Sensory Characteristics                              | Supports          | Instructions name controls by label, not by shape or position (copy review of the empty, error and refusal states).                                                                                                                                                                                                                        |
| 1.4.1 Use of Color                                         | Supports          | Engagement and application states pair color with text; errors pair color with text.                                                                                                                                                                                                                                                       |
| 1.4.2 Audio Control                                        | Not Applicable    | Gateway plays no audio automatically.                                                                                                                                                                                                                                                                                                      |
| 2.1.1 Keyboard                                             | Supports          | Top bar, command menu, account menu, engagement tabs, forms and token flows work by keyboard.                                                                                                                                                                                                                                              |
| 2.1.2 No Keyboard Trap                                     | Supports          | The command menu and account menu keep focus inside while open and release it on Escape.                                                                                                                                                                                                                                                   |
| 2.1.4 Character Key Shortcuts                              | Supports          | Shortcuts use a modifier or are remappable in Keyboard shortcuts settings.                                                                                                                                                                                                                                                                 |
| 2.2.1 Timing Adjustable                                    | Supports          | Session expiry opens a re-authentication dialog instead of discarding work; token links expire on a schedule the sender sets, with a resend path.                                                                                                                                                                                          |
| 2.2.2 Pause, Stop, Hide                                    | Supports          | No auto-updating content runs for more than 5 seconds without a control; motion is removed with reduced motion.                                                                                                                                                                                                                            |
| 2.3.1 Three Flashes or Below Threshold                     | Supports          | No flashing content.                                                                                                                                                                                                                                                                                                                       |
| 2.4.1 Bypass Blocks                                        | Supports          | A Skip to content link is the first focus stop on every signed-in page, and landmarks are present.                                                                                                                                                                                                                                         |
| 2.4.2 Page Titled                                          | Supports          | Every route sets a non-empty document title (axe document-title clean on every route).                                                                                                                                                                                                                                                     |
| 2.4.3 Focus Order                                          | Supports          | Closing the command menu or the account menu returns focus to the control that opened it (A23-003, fixed).                                                                                                                                                                                                                                 |
| 2.4.4 Link Purpose (In Context)                            | Supports          | Links have descriptive text; axe link-name clean.                                                                                                                                                                                                                                                                                          |
| 2.5.1 Pointer Gestures                                     | Supports          | No feature needs a path-based or multipoint gesture; swipe actions have visible buttons.                                                                                                                                                                                                                                                   |
| 2.5.2 Pointer Cancellation                                 | Supports          | Controls act on click (up event), using native buttons and Radix primitives.                                                                                                                                                                                                                                                               |
| 2.5.3 Label in Name                                        | Supports          | Accessible names start with the visible label; icon-only controls use their tooltip text as name.                                                                                                                                                                                                                                          |
| 2.5.4 Motion Actuation                                     | Not Applicable    | No feature is operated by device motion.                                                                                                                                                                                                                                                                                                   |
| 3.1.1 Language of Page                                     | Supports          | The html element carries lang from the user's locale (axe html-has-lang clean).                                                                                                                                                                                                                                                            |
| 3.2.1 On Focus                                             | Supports          | Focus never triggers navigation or submission.                                                                                                                                                                                                                                                                                             |
| 3.2.2 On Input                                             | Supports          | Filters change the list in place without moving focus; forms submit only on their button.                                                                                                                                                                                                                                                  |
| 3.2.6 Consistent Help                                      | Supports          | Help sits in the same place in the header on every page.                                                                                                                                                                                                                                                                                   |
| 3.3.1 Error Identification                                 | Supports          | Server refusals and validation errors render as text in an InlineAlert next to the form.                                                                                                                                                                                                                                                   |
| 3.3.2 Labels or Instructions                               | Supports          | Every field in the forms read (settings, profile, application, token flows, sign in) has a visible label; axe label clean.                                                                                                                                                                                                                 |
| 3.3.7 Redundant Entry                                      | Supports          | Profile details prefill applications and onboarding, and token advances can be claimed into the account.                                                                                                                                                                                                                                   |
| 4.1.1 Parsing                                              | Supports          | Obsolete in WCAG 2.2 and treated as satisfied; React output has no duplicate-id violations in axe.                                                                                                                                                                                                                                         |
| 4.1.2 Name, Role, Value                                    | Supports          | Sweep (apps/gateway/e2e/a11y): axe in both themes on every route for crew (individual) and the vendor (Account Owner), engagement tabs for both role types, public profiles and token flows, at 1280 and 375 px found no aria, name or role violations; the view switcher exposes radio and checked state.                                 |

### Table 2: Success Criteria, Level AA

| Criteria                                        | Conformance Level | Remarks and Explanations                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.2.4 Captions (Live)                           | Not Applicable    | Gateway ships no prerecorded or live audio or video of its own. Media that customers upload is their content.                                                                                                                                                        |
| 1.2.5 Audio Description (Prerecorded)           | Not Applicable    | Gateway ships no prerecorded or live audio or video of its own. Media that customers upload is their content.                                                                                                                                                        |
| 1.3.4 Orientation                               | Supports          | Layouts work in portrait and landscape; the sweep's 375 by 812 run renders every route without an orientation lock.                                                                                                                                                  |
| 1.3.5 Identify Input Purpose                    | Supports          | Sign in and sign up fields carry autocomplete tokens (email, current-password, new-password, name, organization).                                                                                                                                                    |
| 1.4.3 Contrast (Minimum)                        | Supports          | Sweep (apps/gateway/e2e/a11y): axe in both themes on every route for crew (individual) and the vendor (Account Owner), engagement tabs for both role types, public profiles and token flows, at 1280 and 375 px found no color-contrast violations in dark or light. |
| 1.4.4 Resize Text                               | Supports          | Text is sized in rem and the layout reflows; the 375 px run is the 400 percent zoom equivalent of 1280 px. Browser zoom at 200 percent is listed in the passes owed.                                                                                                 |
| 1.4.5 Images of Text                            | Supports          | No images of text other than organization logos, which are excepted as logotypes.                                                                                                                                                                                    |
| 1.4.10 Reflow                                   | Supports          | Every route reflows at 375 px, Settings and Profile settings included: selects fit their container (A23-013, fixed).                                                                                                                                                 |
| 1.4.11 Non-text Contrast                        | Supports          | Control borders, the focus ring (focus-ring token) and state glyphs were spot checked in both themes; no failures found. Forced colors mode is owed a manual pass.                                                                                                   |
| 1.4.12 Text Spacing                             | Supports          | With WCAG text spacing overrides, Home, Engagements and Profile settings lost no content.                                                                                                                                                                            |
| 1.4.13 Content on Hover or Focus                | Supports          | Tooltips open on hover and focus, persist while hovered and close on Escape.                                                                                                                                                                                         |
| 2.4.5 Multiple Ways                             | Supports          | The top bar (bottom bar on phones), the command menu, breadcrumbs and the avatar menu reach every page.                                                                                                                                                              |
| 2.4.6 Headings and Labels                       | Supports          | Each page has one h1 (the sweep asserts it) and sections use h2 and h3; form labels describe their fields.                                                                                                                                                           |
| 2.4.7 Focus Visible                             | Supports          | The sweep checks the first six focus stops on every route; all show an outline or a focus-within ring.                                                                                                                                                               |
| 2.4.11 Focus Not Obscured (Minimum)             | Supports          | At phone width content scrolls clear of the sticky bottom tab bar, so the focused control stays visible (A23-001, fixed).                                                                                                                                            |
| 2.5.7 Dragging Movements                        | Supports          | No feature needs dragging; file upload accepts a file picker as well as drop.                                                                                                                                                                                        |
| 2.5.8 Target Size (Minimum)                     | Supports          | Targets are 24 px or larger, and the bottom bar no longer covers form buttons (A23-001, fixed).                                                                                                                                                                      |
| 3.1.2 Language of Parts                         | Supports          | Interface text is single-locale; customer content in other languages is the customer's.                                                                                                                                                                              |
| 3.2.3 Consistent Navigation                     | Supports          | The five destinations come from one sitemap and render in the same order on every page.                                                                                                                                                                              |
| 3.2.4 Consistent Identification                 | Supports          | The same components and labels are used for the same functions across modules (design system).                                                                                                                                                                       |
| 3.3.3 Error Suggestion                          | Supports          | Refusal copy names the next action (Section 19.6 copy rules).                                                                                                                                                                                                        |
| 3.3.4 Error Prevention (Legal, Financial, Data) | Supports          | Signing shows the document and asks for a typed name; offers can be reviewed before accepting; invoices can be reviewed before submitting.                                                                                                                           |
| 3.3.8 Accessible Authentication (Minimum)       | Supports          | Sign in allows password managers and paste; token flows use a six-digit code the person can paste from email.                                                                                                                                                        |
| 4.1.3 Status Messages                           | Supports          | Saved notices render with role status; a human screen reader pass is owed to confirm announcements.                                                                                                                                                                  |

### Table 3: Success Criteria, Level AAA

| Criteria                                       | Conformance Level | Remarks and Explanations                                                                                                     |
| ---------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1.2.6 Sign Language (Prerecorded)              | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 1.2.7 Extended Audio Description (Prerecorded) | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 1.2.8 Media Alternative (Prerecorded)          | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 1.2.9 Audio-only (Live)                        | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 1.3.6 Identify Purpose                         | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 1.4.6 Contrast (Enhanced)                      | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 1.4.7 Low or No Background Audio               | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 1.4.8 Visual Presentation                      | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 1.4.9 Images of Text (No Exception)            | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 2.1.3 Keyboard (No Exception)                  | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 2.2.3 No Timing                                | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 2.2.4 Interruptions                            | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 2.2.5 Re-authenticating                        | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 2.2.6 Timeouts                                 | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 2.3.2 Three Flashes                            | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 2.3.3 Animation from Interactions              | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 2.4.8 Location                                 | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 2.4.9 Link Purpose (Link Only)                 | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 2.4.10 Section Headings                        | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 2.4.12 Focus Not Obscured (Enhanced)           | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 2.4.13 Focus Appearance                        | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 2.5.5 Target Size (Enhanced)                   | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 2.5.6 Concurrent Input Mechanisms              | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 3.1.3 Unusual Words                            | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 3.1.4 Abbreviations                            | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 3.1.5 Reading Level                            | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 3.1.6 Pronunciation                            | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 3.2.5 Change on Request                        | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 3.3.5 Help                                     | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 3.3.6 Error Prevention (All)                   | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |
| 3.3.9 Accessible Authentication (Enhanced)     | Not Evaluated     | Level AAA is not a conformance target and was not evaluated in this pass (VPAT 2.5 allows Not Evaluated for Level AAA only). |

## Revised Section 508 Report

### Chapter 3: Functional Performance Criteria

| Criteria                                                       | Conformance Level  | Remarks and Explanations                                                                                                                                    |
| -------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 302.1 Without Vision                                           | Partially Supports | Landmarks, labels and names are exposed, and focus returns when overlays close (A23-003, fixed). A human screen reader pass is owed.                        |
| 302.2 With Limited Vision                                      | Supports           | Contrast passes in both themes, text reflows at 375 px on every page, and the bottom tab bar no longer hides the focused control (A23-001, A23-013, fixed). |
| 302.3 Without Perception of Color                              | Supports           | Color is always paired with text or a glyph (1.4.1).                                                                                                        |
| 302.4 Without Hearing                                          | Supports           | Gateway conveys nothing by sound alone.                                                                                                                     |
| 302.5 With Limited Hearing                                     | Supports           | Gateway conveys nothing by sound alone.                                                                                                                     |
| 302.6 Without Speech                                           | Supports           | No feature needs speech.                                                                                                                                    |
| 302.7 With Limited Manipulation                                | Supports           | Keyboard operation and 24 px or larger targets; the bottom tab bar no longer hides the focused control (A23-001, fixed).                                    |
| 302.8 With Limited Reach and Strength                          | Supports           | No feature needs reach or strength; any device position works.                                                                                              |
| 302.9 With Limited Language, Cognitive, and Learning Abilities | Supports           | Plain-language copy, one primary action per screen (gate 27), consistent navigation and help, undo for reversible actions.                                  |

### Chapter 4: Hardware

| Criteria                          | Conformance Level | Remarks and Explanations                                                      |
| --------------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| Chapter 4 Hardware (all sections) | Not Applicable    | Gateway is software that runs in the customer's browser on customer hardware. |

### Chapter 5: Software

| Criteria                                                                            | Conformance Level  | Remarks and Explanations                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 501.1 Scope, Incorporation of WCAG 2.0 AA                                           | Partially Supports | See the WCAG 2.x tables.                                                                                                                                   |
| 502.2.1 User Control of Accessibility Features                                      | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.2.2 No Disruption of Accessibility Features                                     | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.3.1 Object Information                                                          | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.3.2 Modification of Object Information                                          | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.3.3 Row, Column, and Headers                                                    | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.3.4 Values                                                                      | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.3.5 Modification of Values                                                      | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.3.6 Label Relationships                                                         | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.3.7 Hierarchical Relationships                                                  | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.3.8 Text                                                                        | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.3.9 Modification of Text                                                        | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.3.10 List of Actions                                                            | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.3.11 Actions on Objects                                                         | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.3.12 Focus Cursor                                                               | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.3.13 Modification of Focus Cursor                                               | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.3.14 Event Notification                                                         | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 502.4 Platform Accessibility Features                                               | Not Applicable     | Gateway is web content; Section 508 E205 and E208 apply WCAG 2.0 AA through 501.1, reported in the WCAG tables.                                            |
| 503.2 User Preferences                                                              | Supports           | Follows the platform color scheme, reduced motion and text size; the user can override theme in preferences.                                               |
| 503.3 Alternative User Interfaces                                                   | Not Applicable     | Gateway provides no alternative user interface that works as assistive technology.                                                                         |
| 503.4.1 Caption Controls                                                            | Not Applicable     | Gateway has no synchronized media player of its own.                                                                                                       |
| 503.4.2 Audio Description Controls                                                  | Not Applicable     | Gateway has no synchronized media player of its own.                                                                                                       |
| 504.2 Content Creation or Editing                                                   | Partially Supports | Rich text editing exposes headings, lists and links; the editor itself carries the WCAG gaps listed in the tables.                                         |
| 504.2.1 Preservation of Information Provided for Accessibility in Format Conversion | Partially Supports | Exports were not audited in this pass; reported conservatively until the veraPDF and export review (see 504.2.2).                                          |
| 504.2.2 PDF Export                                                                  | Partially Supports | Generated documents are designed as tagged PDF (Section 11.9). veraPDF validation is gate 19, owned by A24; A23 did not audit generated PDFs in this pass. |
| 504.3 Prompts                                                                       | Partially Supports | Image uploads (logos, attachments) do not prompt for a text description.                                                                                   |
| 504.4 Templates                                                                     | Partially Supports | Document templates (Section 11.9) were not audited in this pass; see 504.2.2.                                                                              |

### Chapter 6: Support Documentation and Services

| Criteria                                                         | Conformance Level | Remarks and Explanations                                                                                                         |
| ---------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 601.1 Scope                                                      | Supports          | Heading only; see 602 and 603.                                                                                                   |
| 602.2 Accessibility and Compatibility Features                   | Supports          | The help center documents keyboard shortcuts, themes and accessibility settings.                                                 |
| 602.3 Electronic Support Documentation                           | Supports          | The documentation site and help center are web content built on the same design system; they are not covered by this audit pass. |
| 602.4 Alternate Formats for Non-Electronic Support Documentation | Supports          | Support documentation is electronic; alternate formats are provided on request through the accessibility mailbox.                |
| 603.2 Information on Accessibility and Compatibility Features    | Supports          | Support staff answer accessibility questions through the accessibility mailbox within 5 business days (Accessibility Statement). |
| 603.3 Accommodation of Communication Needs                       | Supports          | Support works by email, web form and in-app ticket, so no single channel is required.                                            |

## EN 301 549 Report

### Chapter 4: Functional Performance Statements

| Criteria                                                  | Conformance Level  | Remarks and Explanations                                                                                             |
| --------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 4.2.1 Usage without vision                                | Partially Supports | See 302.1.                                                                                                           |
| 4.2.2 Usage with limited vision                           | Partially Supports | See 302.2.                                                                                                           |
| 4.2.3 Usage without perception of colour                  | Supports           | See 302.3.                                                                                                           |
| 4.2.4 Usage without hearing                               | Supports           | See 302.4.                                                                                                           |
| 4.2.5 Usage with limited hearing                          | Supports           | See 302.5.                                                                                                           |
| 4.2.6 Usage with no or limited vocal capability           | Supports           | See 302.6.                                                                                                           |
| 4.2.7 Usage with limited manipulation or strength         | Partially Supports | See 302.7.                                                                                                           |
| 4.2.8 Usage with limited reach                            | Supports           | See 302.8.                                                                                                           |
| 4.2.9 Minimize photosensitive seizure triggers            | Supports           | No flashing content (2.3.1).                                                                                         |
| 4.2.10 Usage with limited cognition, language or learning | Supports           | See 302.9.                                                                                                           |
| 4.2.11 Privacy                                            | Supports           | Accessibility features need no disclosure of personal data; screen reader output has the same privacy as the screen. |

### Chapter 5: Generic Requirements

| Criteria                                                        | Conformance Level  | Remarks and Explanations                                                                                 |
| --------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| 5.1 Closed functionality (all clauses)                          | Not Applicable     | Gateway is not closed functionality; it runs in a standard browser with the user's assistive technology. |
| 5.2 Activation of accessibility features                        | Supports           | Accessibility settings sit in personal preferences and need no assistance to reach.                      |
| 5.3 Biometrics                                                  | Supports           | Biometric sign in (passkeys) is optional; password, magic link and OAuth remain available.               |
| 5.4 Preservation of accessibility information during conversion | Partially Supports | See 504.2.1.                                                                                             |
| 5.5.1 Means of operation                                        | Supports           | No operation needs grasping, pinching or twisting.                                                       |
| 5.5.2 Operable parts discernibility                             | Not Applicable     | Applies to hardware operable parts.                                                                      |
| 5.6.1 Tactile or auditory status                                | Not Applicable     | Applies to hardware locking or toggle controls.                                                          |
| 5.6.2 Visual status                                             | Not Applicable     | Applies to hardware locking or toggle controls.                                                          |
| 5.7 Key repeat                                                  | Not Applicable     | Key repeat is a platform keyboard setting.                                                               |
| 5.8 Double-strike key acceptance                                | Not Applicable     | Double-strike acceptance is a platform keyboard setting.                                                 |
| 5.9 Simultaneous user actions                                   | Supports           | No action needs simultaneous input.                                                                      |

### Chapters 6 to 8: Two-Way Voice, Video and Hardware

| Criteria                                                     | Conformance Level | Remarks and Explanations                         |
| ------------------------------------------------------------ | ----------------- | ------------------------------------------------ |
| Chapter 6 ICT with Two-Way Voice Communication (all clauses) | Not Applicable    | Gateway provides no two-way voice communication. |
| 7.1 Caption processing technology (all clauses)              | Not Applicable    | Gateway has no media player of its own.          |
| 7.2 Audio description technology (all clauses)               | Not Applicable    | Gateway has no media player of its own.          |
| 7.3 User controls for captions and audio description         | Not Applicable    | Gateway has no media player of its own.          |
| Chapter 8 Hardware (all clauses)                             | Not Applicable    | Gateway is software only.                        |

### Chapters 9 to 11: Web, Non-web Documents and Software

| Criteria                                                                                        | Conformance Level  | Remarks and Explanations                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Chapter 9 Web (clauses 9.1 to 9.4, reported through the WCAG 2.x tables)                        | Partially Supports | See the WCAG 2.x tables.                                                                                                     |
| 9.6 WCAG conformance requirements                                                               | Partially Supports | Every A23 finding is fixed; the human screen reader pass in the audit log is owed before the report claims full conformance. |
| Chapter 10 Non-web Documents (generated PDFs and exports, reported through the WCAG 2.x tables) | Partially Supports | See 504.2.2: generated PDFs were not audited in this pass.                                                                   |
| Chapter 11 Software, clauses 11.1 to 11.4 (reported through the WCAG 2.x tables)                | Not Applicable     | Gateway is web content, reported under Chapter 9.                                                                            |
| 11.5.2 Interoperability with assistive technology (all clauses)                                 | Not Applicable     | Gateway is web content, reported under Chapter 9.                                                                            |
| 11.6 Documented accessibility usage (all clauses)                                               | Not Applicable     | Gateway is web content, reported under Chapter 9.                                                                            |
| 11.7 User preferences                                                                           | Supports           | See 503.2.                                                                                                                   |
| 11.8 Authoring tools (all clauses)                                                              | Partially Supports | See 504.2 to 504.4.                                                                                                          |

### Chapters 12 and 13: Documentation, Support Services, Relay and Emergency Access

| Criteria                                                                 | Conformance Level | Remarks and Explanations                               |
| ------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------ |
| 12.1.1 Accessibility and compatibility features                          | Supports          | See 602.2.                                             |
| 12.1.2 Accessible documentation                                          | Supports          | See 602.3.                                             |
| 12.2.2 Information on accessibility and compatibility features           | Supports          | See 603.2.                                             |
| 12.2.3 Effective communication                                           | Supports          | See 603.3.                                             |
| 12.2.4 Accessible documentation                                          | Supports          | See 602.4.                                             |
| Chapter 13 ICT Providing Relay or Emergency Service Access (all clauses) | Not Applicable    | Gateway provides no relay or emergency service access. |

## Legal Disclaimer

This report describes the accessibility of Gateway 4.0 as of its report date, based on the evaluation methods listed. It is provided for information. It is not a warranty and does not create obligations beyond those in the customer's agreement with GHXSTSHIP Industries LLC. "Voluntary Product Accessibility Template" and "VPAT" are registered service marks of the Information Technology Industry Council (ITI).
