---
title: Accessibility Conformance Report: Compass
version: 1.0.0-draft
effective_date: The date this version is published at /legal
status: Draft for review by counsel before launch; evaluated by A23 from source on main 5f4e839 (Wave 6), device and screen reader passes owed
---

# Accessibility Conformance Report: Compass

> **Draft for review by counsel before launch.** This report is a draft. Levels A and AA were evaluated in the Wave 6 independent audit (A23) by source and component review of build 5f4e839; no device, VoiceOver or TalkBack pass has taken place yet (see Notes). It takes effect only when GHXSTSHIP Industries LLC publishes it at /legal with completed evaluation results, and its effective date is that date of publication.

This Accessibility Conformance Report follows the structure of the ITI VPAT 2.5 International edition (VPAT 2.5Rev INT), which reports against WCAG 2.x, the Revised Section 508 Standards and EN 301 549 together. Template instructions from the VPAT form are not reproduced here.

## Name of Product and Version

Compass 4.0, version 4.0.0 (pre-release), build 5f4e839.

## Report Date

The date this report is published at /legal. Evaluation recorded 2026-10-16 in `legal/accessibility/audit-log.md`, entries 16 to 22.

## Product Description

Compass 4.0 is the field application of XOS 4.0 for iOS and Android phones and tablets. It serves internal members and external parties for on-site operations: shifts and the time clock, tasks and checklists, inspections, incident reports, run of show, scanning, credentials, chat, feed, training and the kiosk. It works offline, and includes Live Activities and home screen widgets.

## Contact Information

GHXSTSHIP Industries LLC. Accessibility questions go to the accessibility mailbox listed on our contact page at /legal/contact, with a response within 5 business days as our Accessibility Statement commits.

## Notes

- **Status:** Levels A and AA are evaluated from the audit log, applying WCAG to native software as WCAG2ICT describes. Level AAA is not a target and is marked Not Evaluated. Open defects are filed as `legal/accessibility/findings/A23-NNN.md`; Serious findings A23-004 and A23-005 block release under Section 18.
- **Screen readers and devices:** the evaluator could not run VoiceOver, TalkBack, Switch Control or a simulator in this pass. Every conformance level here rests on reading the React Native source (accessibilityLabel, role, state, live regions, font scaling and touch target values) against the native theme tokens. Each level must be confirmed on device with VoiceOver on iOS and TalkBack on Android before publication; the screens to cover are listed under "Passes still owed" in the audit log.
- **Scope:** the Compass screens in `apps/compass/app` and the ui-native seam in `apps/compass/src/ui` (primitives, layout and Compass components). Live Activities and widgets were not reviewed.
- **Target:** WCAG 2.2 Level AA conformance, which XOS uses to address Section 508, ADA Titles II and III, EN 301 549, the European Accessibility Act, the AODA and the Accessible Canada Act.

## Evaluation Methods Used

Used in this evaluation:

- source and component review of every control for accessibilityLabel, accessibilityRole and accessibilityState
- touch target sizes from the native tokens (touchMin 48 pt) and hit slop
- Dynamic Type and font scaling limits (maxFontSizeMultiplier) on every text style
- reduced motion handling, and announcements for scan results, the offline queue count and clock state
- contrast of the clock button and status colors from the native color tokens in both themes

Still owed: VoiceOver on iOS, TalkBack on Android, Switch Control, Voice Control, Dynamic Type at the largest accessibility size, Reduce Motion, an external keyboard, and accessibility assertions in the Maestro flows (gate 7).

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

| Criteria                                                   | Conformance Level  | Remarks and Explanations                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1.1 Non-text Content                                     | Supports           | Source review of apps/compass at 5f4e839 (no device run): every IconButton requires a label; decorative icons are hidden from assistive technology (importantForAccessibility no-hide-descendants); status icons sit beside text. Kiosk PIN dots read as bullets (A23-010, Minor). |
| 1.2.1 Audio-only and Video-only (Prerecorded)              | Not Applicable     | Compass ships no prerecorded or live audio or video of its own; voice notes are user content.                                                                                                                                                                                      |
| 1.2.2 Captions (Prerecorded)                               | Not Applicable     | Compass ships no prerecorded or live audio or video of its own; voice notes are user content.                                                                                                                                                                                      |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | Not Applicable     | Compass ships no prerecorded or live audio or video of its own; voice notes are user content.                                                                                                                                                                                      |
| 1.3.1 Info and Relationships                               | Supports           | Source review of apps/compass at 5f4e839 (no device run): headings use accessibilityRole header, tab bars use tablist and tab, segmented controls use radiogroup, field labels are the inputs' accessibilityLabel.                                                                 |
| 1.3.2 Meaningful Sequence                                  | Supports           | Screens are single-column stacks whose order matches reading order.                                                                                                                                                                                                                |
| 1.3.3 Sensory Characteristics                              | Supports           | Instructions name controls by label (copy review).                                                                                                                                                                                                                                 |
| 1.4.1 Use of Color                                         | Supports           | Clock states, scan results and geofence status pair color with a text label and an icon.                                                                                                                                                                                           |
| 1.4.2 Audio Control                                        | Not Applicable     | Compass plays no audio automatically; haptics are optional.                                                                                                                                                                                                                        |
| 2.1.1 Keyboard                                             | Partially Supports | Controls are native Pressables reachable by switch access and hardware keyboards; the offline banner's View action cannot be reached by screen readers or switch access (A23-005).                                                                                                 |
| 2.1.2 No Keyboard Trap                                     | Supports           | Sheets are Modals with onRequestClose (back gesture, Escape) and a Close button.                                                                                                                                                                                                   |
| 2.1.4 Character Key Shortcuts                              | Not Applicable     | Compass has no single-character shortcuts.                                                                                                                                                                                                                                         |
| 2.2.1 Timing Adjustable                                    | Supports           | Hold-to-confirm has an accessibility action that activates without holding; no session timeout discards entered work.                                                                                                                                                              |
| 2.2.2 Pause, Stop, Hide                                    | Supports           | The run of show countdown is essential live content and stops when the screen closes; no decorative motion runs.                                                                                                                                                                   |
| 2.3.1 Three Flashes or Below Threshold                     | Supports           | No flashing content; the torch is the device light.                                                                                                                                                                                                                                |
| 2.4.1 Bypass Blocks                                        | Not Applicable     | Applies to sets of web pages; Compass screens have no repeated blocks to bypass beyond the tab bar (WCAG2ICT).                                                                                                                                                                     |
| 2.4.2 Page Titled                                          | Supports           | Every screen renders through Screen with a title.                                                                                                                                                                                                                                  |
| 2.4.3 Focus Order                                          | Supports           | Focus follows the visual stack; sheets set accessibilityViewIsModal so focus stays in the sheet.                                                                                                                                                                                   |
| 2.4.4 Link Purpose (In Context)                            | Supports           | List rows and buttons are named by their visible text.                                                                                                                                                                                                                             |
| 2.5.1 Pointer Gestures                                     | Supports           | Every swipe action on a list row has a visible button and an accessibility action (ListRow).                                                                                                                                                                                       |
| 2.5.2 Pointer Cancellation                                 | Supports           | Pressable acts on release; hold-to-confirm cancels when the finger lifts early.                                                                                                                                                                                                    |
| 2.5.3 Label in Name                                        | Supports           | Accessibility labels are the visible label (Button, ClockButton adds the timer after the label).                                                                                                                                                                                   |
| 2.5.4 Motion Actuation                                     | Not Applicable     | No feature is operated by device motion.                                                                                                                                                                                                                                           |
| 3.1.1 Language of Page                                     | Supports           | The app follows the device locale and ships en-US and es-US.                                                                                                                                                                                                                       |
| 3.2.1 On Focus                                             | Supports           | Focus never triggers an action.                                                                                                                                                                                                                                                    |
| 3.2.2 On Input                                             | Supports           | Changing a segmented control or switch never navigates.                                                                                                                                                                                                                            |
| 3.2.6 Consistent Help                                      | Not Applicable     | WCAG2ICT applies 3.2.6 to sets of web pages or software programs; Compass is a single program.                                                                                                                                                                                     |
| 3.3.1 Error Identification                                 | Supports           | Refusals render as RefusalNotice text naming the reason (for example outside the geofence).                                                                                                                                                                                        |
| 3.3.2 Labels or Instructions                               | Supports           | Every TextField, Switch and SegmentedControl requires a label prop.                                                                                                                                                                                                                |
| 3.3.7 Redundant Entry                                      | Supports           | Incident and inspection flows carry location and project forward.                                                                                                                                                                                                                  |
| 4.1.1 Parsing                                              | Not Applicable     | Applies to markup languages; obsolete in WCAG 2.2.                                                                                                                                                                                                                                 |
| 4.1.2 Name, Role, Value                                    | Partially Supports | Controls expose label, role and disabled and busy state. Radio controls report selected instead of checked (A23-006); the offline banner wraps its action out of reach (A23-005).                                                                                                  |

### Table 2: Success Criteria, Level AA

| Criteria                                        | Conformance Level  | Remarks and Explanations                                                                                                                                                                         |
| ----------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.2.4 Captions (Live)                           | Not Applicable     | Compass ships no prerecorded or live audio or video of its own; voice notes are user content.                                                                                                    |
| 1.2.5 Audio Description (Prerecorded)           | Not Applicable     | Compass ships no prerecorded or live audio or video of its own; voice notes are user content.                                                                                                    |
| 1.3.4 Orientation                               | Supports           | Phone and tablet layouts support both orientations; kiosk mode follows the device mount.                                                                                                         |
| 1.3.5 Identify Input Purpose                    | Supports           | TextField passes autoComplete (email, password, one-time-code) to the platform.                                                                                                                  |
| 1.4.3 Contrast (Minimum)                        | Supports           | Native color tokens checked: clock button labels and timers meet 3:1 as large text and body text pairs meet 4.5:1 in both themes (for example white on accent 4.78:1 dark and 5.68:1 light).     |
| 1.4.4 Resize Text                               | Partially Supports | Text scales with Dynamic Type and Android font scale up to 200 percent (maxFontSizeMultiplier 2), except the clock button label and timer, capped at 160 percent (A23-007).                      |
| 1.4.5 Images of Text                            | Supports           | No images of text other than logos.                                                                                                                                                              |
| 1.4.10 Reflow                                   | Supports           | Screens are vertical stacks that wrap at 390 pt and grow with text size; no two-dimensional scrolling outside maps and the camera.                                                               |
| 1.4.11 Non-text Contrast                        | Supports           | Control borders use the borderControl token and selected states change fill as well as border.                                                                                                   |
| 1.4.12 Text Spacing                             | Not Applicable     | Native apps give users no mechanism to override text spacing (WCAG2ICT).                                                                                                                         |
| 1.4.13 Content on Hover or Focus                | Not Applicable     | Compass shows no content on hover or focus.                                                                                                                                                      |
| 2.4.5 Multiple Ways                             | Not Applicable     | Applies to sets of web pages (WCAG2ICT).                                                                                                                                                         |
| 2.4.6 Headings and Labels                       | Supports           | Screen headings and field labels describe their purpose.                                                                                                                                         |
| 2.4.7 Focus Visible                             | Supports           | Focus is drawn by the platform (VoiceOver cursor, Android focus highlight); no custom focus suppression.                                                                                         |
| 2.4.11 Focus Not Obscured (Minimum)             | Supports           | The tab bar sits below the screen content rather than over it, and sheets are modal, so a focused control is not covered.                                                                        |
| 2.5.7 Dragging Movements                        | Supports           | No feature needs dragging.                                                                                                                                                                       |
| 2.5.8 Target Size (Minimum)                     | Supports           | Every primitive uses the touchMin token (48 pt) with glove hit slop; kiosk keys are 64 pt.                                                                                                       |
| 3.1.2 Language of Parts                         | Supports           | Interface text is single-locale.                                                                                                                                                                 |
| 3.2.3 Consistent Navigation                     | Not Applicable     | Applies to sets of web pages; the tab bar is consistent on every screen in any case.                                                                                                             |
| 3.2.4 Consistent Identification                 | Not Applicable     | Applies to sets of web pages; components are shared in any case.                                                                                                                                 |
| 3.3.3 Error Suggestion                          | Supports           | Refusal copy names the next action.                                                                                                                                                              |
| 3.3.4 Error Prevention (Legal, Financial, Data) | Supports           | Critical actions use hold to confirm or a review step; queued actions can be reviewed in the offline queue.                                                                                      |
| 3.3.8 Accessible Authentication (Minimum)       | Supports           | Sign in supports password managers, magic link and biometrics. Kiosk mode asks for a PIN; the alternative for the same task is clocking in from the person's own Compass, which needs no recall. |
| 4.1.3 Status Messages                           | Does Not Support   | On iOS nothing is announced: scan results, clock changes, queued punches, offline queue counts and toasts (A23-004, Serious). On Android the run of show countdown floods TalkBack (A23-009).    |

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

| Criteria                                                       | Conformance Level  | Remarks and Explanations                                                                                                                                                                                               |
| -------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 302.1 Without Vision                                           | Partially Supports | Controls expose labels, roles and states to VoiceOver and TalkBack, but status changes are not announced on iOS (A23-004) and the offline banner action is unreachable (A23-005). A device screen reader pass is owed. |
| 302.2 With Limited Vision                                      | Partially Supports | Contrast and 48 pt targets pass; text scales to 200 percent except the clock button (A23-007).                                                                                                                         |
| 302.3 Without Perception of Color                              | Supports           | See 1.4.1.                                                                                                                                                                                                             |
| 302.4 Without Hearing                                          | Supports           | Nothing is conveyed by sound; scan and clock feedback is visual and haptic.                                                                                                                                            |
| 302.5 With Limited Hearing                                     | Supports           | See 302.4.                                                                                                                                                                                                             |
| 302.6 Without Speech                                           | Supports           | Voice notes are optional; every input has a typed path.                                                                                                                                                                |
| 302.7 With Limited Manipulation                                | Partially Supports | 48 pt targets, glove hit slop and an accessibility action for hold to confirm; the offline banner action is unreachable by switch access (A23-005).                                                                    |
| 302.8 With Limited Reach and Strength                          | Supports           | Primary actions sit in thumb reach; no strength needed.                                                                                                                                                                |
| 302.9 With Limited Language, Cognitive, and Learning Abilities | Supports           | Three-step incident report, one primary action per screen, plain-language refusals.                                                                                                                                    |

### Chapter 4: Hardware

| Criteria                          | Conformance Level | Remarks and Explanations                                        |
| --------------------------------- | ----------------- | --------------------------------------------------------------- |
| Chapter 4 Hardware (all sections) | Not Applicable    | Compass is software on customer or personal phones and tablets. |

### Chapter 5: Software

| Criteria                                                                            | Conformance Level  | Remarks and Explanations                                                                                                            |
| ----------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 501.1 Scope, Incorporation of WCAG 2.0 AA                                           | Partially Supports | See the WCAG 2.x tables, applied to software through WCAG2ICT.                                                                      |
| 502.2.1 User Control of Accessibility Features                                      | Supports           | Compass does not override platform accessibility features.                                                                          |
| 502.2.2 No Disruption of Accessibility Features                                     | Supports           | No code path in Compass disables VoiceOver, TalkBack, Switch Control or zoom.                                                       |
| 502.3.1 Object Information                                                          | Supports           | React Native maps label, role and state to the platform accessibility API.                                                          |
| 502.3.2 Modification of Object Information                                          | Supports           | Editable fields accept assistive technology input through TextInput.                                                                |
| 502.3.3 Row, Column, and Headers                                                    | Not Applicable     | Compass presents no data tables.                                                                                                    |
| 502.3.4 Values                                                                      | Supports           | Switches, progress bars and segmented controls expose their values.                                                                 |
| 502.3.5 Modification of Values                                                      | Supports           | Values can be changed through assistive technology on native controls.                                                              |
| 502.3.6 Label Relationships                                                         | Supports           | Field labels are set as the input's accessibilityLabel.                                                                             |
| 502.3.7 Hierarchical Relationships                                                  | Supports           | Lists and tab bars expose their structure (tablist, list rows).                                                                     |
| 502.3.8 Text                                                                        | Supports           | Text is native text exposed to assistive technology.                                                                                |
| 502.3.9 Modification of Text                                                        | Supports           | Text fields expose edits to assistive technology.                                                                                   |
| 502.3.10 List of Actions                                                            | Supports           | Swipe actions on rows are exposed as accessibility actions.                                                                         |
| 502.3.11 Actions on Objects                                                         | Supports           | Hold to confirm exposes an activate action.                                                                                         |
| 502.3.12 Focus Cursor                                                               | Supports           | Focus is the platform accessibility focus.                                                                                          |
| 502.3.13 Modification of Focus Cursor                                               | Supports           | Compass does not move focus programmatically except into modal sheets.                                                              |
| 502.3.14 Event Notification                                                         | Does Not Support   | State changes such as scan results, punches and queue counts raise no announcement on iOS (A23-004).                                |
| 502.4 Platform Accessibility Features                                               | Supports           | Works with platform accessibility features (Dynamic Type, Bold Text, Reduce Transparency); Reduce Motion is not honoured (A23-008). |
| 503.2 User Preferences                                                              | Partially Supports | Follows the system color scheme and text size; ignores Reduce Motion (A23-008) and caps clock text at 160 percent (A23-007).        |
| 503.3 Alternative User Interfaces                                                   | Not Applicable     | Compass provides no alternative user interface that works as assistive technology.                                                  |
| 503.4.1 Caption Controls                                                            | Not Applicable     | Compass has no synchronized media player.                                                                                           |
| 503.4.2 Audio Description Controls                                                  | Not Applicable     | Compass has no synchronized media player.                                                                                           |
| 504.2 Content Creation or Editing                                                   | Partially Supports | Incident and task notes are plain text; photos attach with no prompt for a description.                                             |
| 504.2.1 Preservation of Information Provided for Accessibility in Format Conversion | Not Applicable     | Compass converts no content between formats.                                                                                        |
| 504.2.2 PDF Export                                                                  | Not Applicable     | Compass does not export PDFs; documents are generated by Atlas.                                                                     |
| 504.3 Prompts                                                                       | Partially Supports | Photo capture does not prompt for a description of the photo.                                                                       |
| 504.4 Templates                                                                     | Not Applicable     | Compass provides no document templates.                                                                                             |

### Chapter 6: Support Documentation and Services

| Criteria                                                         | Conformance Level | Remarks and Explanations                                                                  |
| ---------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| 601.1 Scope                                                      | Supports          | Heading only; see 602 and 603.                                                            |
| 602.2 Accessibility and Compatibility Features                   | Supports          | Accessibility features are described in the Accessibility Statement published at /legal.  |
| 602.3 Electronic Support Documentation                           | Supports          | Support documentation is web content on the documentation site, not covered by this pass. |
| 602.4 Alternate Formats for Non-Electronic Support Documentation | Supports          | Alternate formats on request through the accessibility mailbox.                           |
| 603.2 Information on Accessibility and Compatibility Features    | Supports          | Accessibility questions are answered within 5 business days (Accessibility Statement).    |
| 603.3 Accommodation of Communication Needs                       | Supports          | Support works by email, web form and in-app ticket.                                       |

## EN 301 549 Report

### Chapter 4: Functional Performance Statements

| Criteria                                                  | Conformance Level  | Remarks and Explanations                                    |
| --------------------------------------------------------- | ------------------ | ----------------------------------------------------------- |
| 4.2.1 Usage without vision                                | Partially Supports | See 302.1.                                                  |
| 4.2.2 Usage with limited vision                           | Partially Supports | See 302.2.                                                  |
| 4.2.3 Usage without perception of colour                  | Supports           | See 302.3.                                                  |
| 4.2.4 Usage without hearing                               | Supports           | See 302.4.                                                  |
| 4.2.5 Usage with limited hearing                          | Supports           | See 302.5.                                                  |
| 4.2.6 Usage with no or limited vocal capability           | Supports           | See 302.6.                                                  |
| 4.2.7 Usage with limited manipulation or strength         | Partially Supports | See 302.7.                                                  |
| 4.2.8 Usage with limited reach                            | Supports           | See 302.8.                                                  |
| 4.2.9 Minimize photosensitive seizure triggers            | Supports           | No flashing content.                                        |
| 4.2.10 Usage with limited cognition, language or learning | Supports           | See 302.9.                                                  |
| 4.2.11 Privacy                                            | Supports           | Accessibility features need no disclosure of personal data. |

### Chapter 5: Generic Requirements

| Criteria                                                        | Conformance Level  | Remarks and Explanations                                                                                                                                        |
| --------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 Closed functionality (all clauses)                          | Partially Supports | Kiosk mode is closed functionality on a shared device; it keeps platform VoiceOver and TalkBack available, but kiosk PIN progress is read as bullets (A23-010). |
| 5.2 Activation of accessibility features                        | Supports           | Platform accessibility features stay available in kiosk mode.                                                                                                   |
| 5.3 Biometrics                                                  | Supports           | Biometric unlock is optional; password and magic link remain.                                                                                                   |
| 5.4 Preservation of accessibility information during conversion | Not Applicable     | Compass converts no content between formats.                                                                                                                    |
| 5.5.1 Means of operation                                        | Supports           | No operation needs grasping, pinching or twisting; hold to confirm has an accessibility action.                                                                 |
| 5.5.2 Operable parts discernibility                             | Not Applicable     | Applies to hardware operable parts.                                                                                                                             |
| 5.6.1 Tactile or auditory status                                | Supports           | Toggle states are spoken by the platform switch control and shown as text.                                                                                      |
| 5.6.2 Visual status                                             | Supports           | Toggle states are visible as text and color together.                                                                                                           |
| 5.7 Key repeat                                                  | Not Applicable     | Key repeat is a platform keyboard setting.                                                                                                                      |
| 5.8 Double-strike key acceptance                                | Not Applicable     | A platform keyboard setting.                                                                                                                                    |
| 5.9 Simultaneous user actions                                   | Supports           | No action needs simultaneous input.                                                                                                                             |

### Chapters 6 to 8: Two-Way Voice, Video and Hardware

| Criteria                                                     | Conformance Level | Remarks and Explanations                                                                                      |
| ------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------- |
| Chapter 6 ICT with Two-Way Voice Communication (all clauses) | Not Applicable    | Compass carries no voice communication; Radio channels is a reference table of channel names and frequencies. |
| 7.1 Caption processing technology (all clauses)              | Not Applicable    | Compass has no media player.                                                                                  |
| 7.2 Audio description technology (all clauses)               | Not Applicable    | Compass has no media player.                                                                                  |
| 7.3 User controls for captions and audio description         | Not Applicable    | Compass has no media player.                                                                                  |
| Chapter 8 Hardware (all clauses)                             | Not Applicable    | Compass is software only.                                                                                     |

### Chapters 9 to 11: Web, Non-web Documents and Software

| Criteria                                                                                        | Conformance Level  | Remarks and Explanations                                            |
| ----------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| Chapter 9 Web (clauses 9.1 to 9.4, reported through the WCAG 2.x tables)                        | Not Applicable     | Compass is native software, so Chapter 9 (web) does not apply.      |
| 9.6 WCAG conformance requirements                                                               | Not Applicable     | Compass is native software, so Chapter 9 (web) does not apply.      |
| Chapter 10 Non-web Documents (generated PDFs and exports, reported through the WCAG 2.x tables) | Not Applicable     | Compass produces no non-web documents.                              |
| Chapter 11 Software, clauses 11.1 to 11.4 (reported through the WCAG 2.x tables)                | Partially Supports | See the WCAG 2.x tables (WCAG2ICT).                                 |
| 11.5.2 Interoperability with assistive technology (all clauses)                                 | Partially Supports | See 502.3.1 to 502.3.14; event notification fails on iOS (A23-004). |
| 11.6 Documented accessibility usage (all clauses)                                               | Supports           | See 602.2.                                                          |
| 11.7 User preferences                                                                           | Partially Supports | See 503.2.                                                          |
| 11.8 Authoring tools (all clauses)                                                              | Not Applicable     | Compass is not an authoring tool for web content or documents.      |

### Chapters 12 and 13: Documentation, Support Services, Relay and Emergency Access

| Criteria                                                                 | Conformance Level | Remarks and Explanations                                                                                                         |
| ------------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 12.1.1 Accessibility and compatibility features                          | Supports          | See 602.2.                                                                                                                       |
| 12.1.2 Accessible documentation                                          | Supports          | See 602.3.                                                                                                                       |
| 12.2.2 Information on accessibility and compatibility features           | Supports          | See 603.2.                                                                                                                       |
| 12.2.3 Effective communication                                           | Supports          | See 603.3.                                                                                                                       |
| 12.2.4 Accessible documentation                                          | Supports          | See 602.4.                                                                                                                       |
| Chapter 13 ICT Providing Relay or Emergency Service Access (all clauses) | Not Applicable    | Compass provides no relay or emergency service access; emergency codes are an internal reference, not an emergency call service. |

## Legal Disclaimer

This report describes the accessibility of Compass 4.0 as of its report date, based on the evaluation methods listed. It is provided for information. It is not a warranty and does not create obligations beyond those in the customer's agreement with GHXSTSHIP Industries LLC. "Voluntary Product Accessibility Template" and "VPAT" are registered service marks of the Information Technology Industry Council (ITI).
