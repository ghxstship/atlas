---
title: Accessibility Conformance Report: Compass
version: 1.0.0-draft
effective_date: The date this version is published at /legal
status: Draft for review by counsel before launch; every criterion Not Evaluated until Wave 6
---

# Accessibility Conformance Report: Compass

> **Draft for review by counsel before launch.** This report is a draft. No criterion has been evaluated yet. It takes effect only when GHXSTSHIP Industries LLC publishes it at /legal with completed evaluation results, and its effective date is that date of publication.

This Accessibility Conformance Report follows the structure of the ITI VPAT 2.5 International edition (VPAT 2.5Rev INT), which reports against WCAG 2.x, the Revised Section 508 Standards and EN 301 549 together. Template instructions from the VPAT form are not reproduced here.

## Name of Product and Version

Compass 4.0, version 4.0.0 (pre-release).

## Report Date

The date this report is published at /legal. This draft structure was prepared in Wave 1 of the XOS 4.0 build.

## Product Description

Compass 4.0 is the field application of XOS 4.0 for iOS and Android phones and tablets. It serves internal members and external parties for on-site operations: shifts and the time clock, tasks and checklists, inspections, incident reports, run of show, scanning, credentials, chat, feed, training and the kiosk. It works offline, and includes Live Activities and home screen widgets.

## Contact Information

GHXSTSHIP Industries LLC. Accessibility questions go to the accessibility mailbox listed on our contact page at /legal/contact, with a response within 5 business days as our Accessibility Statement commits.

## Notes

- **Status:** every criterion in this draft is marked Not Evaluated. Evaluation happens in Wave 6, when the independent accessibility reviewer audits the product and records each pass in `legal/accessibility/audit-log.md`. This report will then be completed from that log.
- **Scope:** Every Compass screen named in Section 11.5 of the XOS 4.0 build specification, on the latest two major versions of iOS and on Android at the current Play target API level, in phone and tablet layouts, including Live Activities, widgets and kiosk mode.
- **Target:** WCAG 2.2 Level AA conformance, which XOS uses to address Section 508, ADA Titles II and III, EN 301 549, the European Accessibility Act, the AODA and the Accessible Canada Act.

## Evaluation Methods Used

Planned for Wave 6:

- automated axe-core checks in unit tests, Storybook and Playwright, and accessibility assertions in Maestro flows on iOS and Android, with zero serious or critical violations allowed
- manual testing with VoiceOver on iOS, TalkBack on Android, Switch Control, Voice Control, Dynamic Type and Android font scaling to 200 percent, Bold Text, Reduce Motion, and external keyboard.
- keyboard-only journey tests and reduced-motion snapshot tests
- review of generated documents with veraPDF for PDF/UA

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
- **Not Evaluated:** no evaluation against the criterion has taken place yet. In this draft, every criterion carries this term.

## WCAG 2.x Report

The WCAG tables also report Section 508 Chapter 5 (501.1) and Chapter 6 (602.3), and EN 301 549 Chapter 9 (Web), Chapter 10 (Non-web documents) and Chapter 11 clauses 11.1 to 11.4 (Software).

### Table 1: Success Criteria, Level A

| Criteria                                                   | Conformance Level | Remarks and Explanations                                                                                                                                    |
| ---------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1.1 Non-text Content                                     | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 1.2.1 Audio-only and Video-only (Prerecorded)              | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 1.2.2 Captions (Prerecorded)                               | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 1.3.1 Info and Relationships                               | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 1.3.2 Meaningful Sequence                                  | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 1.3.3 Sensory Characteristics                              | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 1.4.1 Use of Color                                         | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 1.4.2 Audio Control                                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 2.1.1 Keyboard                                             | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 2.1.2 No Keyboard Trap                                     | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 2.1.4 Character Key Shortcuts                              | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 2.2.1 Timing Adjustable                                    | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 2.2.2 Pause, Stop, Hide                                    | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 2.3.1 Three Flashes or Below Threshold                     | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 2.4.1 Bypass Blocks                                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 2.4.2 Page Titled                                          | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 2.4.3 Focus Order                                          | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 2.4.4 Link Purpose (In Context)                            | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 2.5.1 Pointer Gestures                                     | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 2.5.2 Pointer Cancellation                                 | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 2.5.3 Label in Name                                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 2.5.4 Motion Actuation                                     | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 3.1.1 Language of Page                                     | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 3.2.1 On Focus                                             | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 3.2.2 On Input                                             | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 3.2.6 Consistent Help                                      | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 3.3.1 Error Identification                                 | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 3.3.2 Labels or Instructions                               | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 3.3.7 Redundant Entry                                      | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |
| 4.1.1 Parsing                                              | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). WCAG 2.2 marks 4.1.1 as obsolete and always satisfied; the report will record that position. |
| 4.1.2 Name, Role, Value                                    | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification).                                                                                              |

### Table 2: Success Criteria, Level AA

| Criteria                                        | Conformance Level | Remarks and Explanations                                       |
| ----------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| 1.2.4 Captions (Live)                           | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 1.2.5 Audio Description (Prerecorded)           | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 1.3.4 Orientation                               | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 1.3.5 Identify Input Purpose                    | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 1.4.3 Contrast (Minimum)                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 1.4.4 Resize Text                               | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 1.4.5 Images of Text                            | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 1.4.10 Reflow                                   | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 1.4.11 Non-text Contrast                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 1.4.12 Text Spacing                             | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 1.4.13 Content on Hover or Focus                | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 2.4.5 Multiple Ways                             | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 2.4.6 Headings and Labels                       | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 2.4.7 Focus Visible                             | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 2.4.11 Focus Not Obscured (Minimum)             | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 2.5.7 Dragging Movements                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 2.5.8 Target Size (Minimum)                     | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 3.1.2 Language of Parts                         | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 3.2.3 Consistent Navigation                     | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 3.2.4 Consistent Identification                 | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 3.3.3 Error Suggestion                          | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 3.3.4 Error Prevention (Legal, Financial, Data) | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 3.3.8 Accessible Authentication (Minimum)       | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 4.1.3 Status Messages                           | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |

### Table 3: Success Criteria, Level AAA

| Criteria                                       | Conformance Level | Remarks and Explanations                                                                                                            |
| ---------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1.2.6 Sign Language (Prerecorded)              | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 1.2.7 Extended Audio Description (Prerecorded) | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 1.2.8 Media Alternative (Prerecorded)          | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 1.2.9 Audio-only (Live)                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 1.3.6 Identify Purpose                         | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 1.4.6 Contrast (Enhanced)                      | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 1.4.7 Low or No Background Audio               | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 1.4.8 Visual Presentation                      | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 1.4.9 Images of Text (No Exception)            | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 2.1.3 Keyboard (No Exception)                  | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 2.2.3 No Timing                                | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 2.2.4 Interruptions                            | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 2.2.5 Re-authenticating                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 2.2.6 Timeouts                                 | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 2.3.2 Three Flashes                            | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 2.3.3 Animation from Interactions              | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 2.4.8 Location                                 | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 2.4.9 Link Purpose (Link Only)                 | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 2.4.10 Section Headings                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 2.4.12 Focus Not Obscured (Enhanced)           | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 2.4.13 Focus Appearance                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 2.5.5 Target Size (Enhanced)                   | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 2.5.6 Concurrent Input Mechanisms              | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 3.1.3 Unusual Words                            | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 3.1.4 Abbreviations                            | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 3.1.5 Reading Level                            | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 3.1.6 Pronunciation                            | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 3.2.5 Change on Request                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 3.3.5 Help                                     | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 3.3.6 Error Prevention (All)                   | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |
| 3.3.9 Accessible Authentication (Enhanced)     | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). XOS does not target Level AAA; results are reported for information. |

## Revised Section 508 Report

### Chapter 3: Functional Performance Criteria

| Criteria                                                       | Conformance Level | Remarks and Explanations                                       |
| -------------------------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| 302.1 Without Vision                                           | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 302.2 With Limited Vision                                      | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 302.3 Without Perception of Color                              | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 302.4 Without Hearing                                          | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 302.5 With Limited Hearing                                     | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 302.6 Without Speech                                           | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 302.7 With Limited Manipulation                                | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 302.8 With Limited Reach and Strength                          | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 302.9 With Limited Language, Cognitive, and Learning Abilities | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |

### Chapter 4: Hardware

| Criteria                          | Conformance Level | Remarks and Explanations                                                                                                                                                  |
| --------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chapter 4 Hardware (all sections) | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass 4.0 is software and runs on customer-supplied hardware; applicability will be confirmed in Wave 6. |

### Chapter 5: Software

| Criteria                                                                            | Conformance Level | Remarks and Explanations                                                                                                     |
| ----------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 501.1 Scope, Incorporation of WCAG 2.0 AA                                           | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.2.1 User Control of Accessibility Features                                      | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.2.2 No Disruption of Accessibility Features                                     | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.3.1 Object Information                                                          | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.3.2 Modification of Object Information                                          | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.3.3 Row, Column, and Headers                                                    | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.3.4 Values                                                                      | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.3.5 Modification of Values                                                      | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.3.6 Label Relationships                                                         | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.3.7 Hierarchical Relationships                                                  | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.3.8 Text                                                                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.3.9 Modification of Text                                                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.3.10 List of Actions                                                            | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.3.11 Actions on Objects                                                         | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.3.12 Focus Cursor                                                               | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.3.13 Modification of Focus Cursor                                               | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.3.14 Event Notification                                                         | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 502.4 Platform Accessibility Features                                               | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 503.2 User Preferences                                                              | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 503.3 Alternative User Interfaces                                                   | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 503.4.1 Caption Controls                                                            | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 503.4.2 Audio Description Controls                                                  | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 504.2 Content Creation or Editing                                                   | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 504.2.1 Preservation of Information Provided for Accessibility in Format Conversion | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 504.2.2 PDF Export                                                                  | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 504.3 Prompts                                                                       | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |
| 504.4 Templates                                                                     | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). Compass is native mobile software; Chapter 5 applies in full. |

### Chapter 6: Support Documentation and Services

| Criteria                                                         | Conformance Level | Remarks and Explanations                                       |
| ---------------------------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| 601.1 Scope                                                      | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 602.2 Accessibility and Compatibility Features                   | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 602.3 Electronic Support Documentation                           | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 602.4 Alternate Formats for Non-Electronic Support Documentation | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 603.2 Information on Accessibility and Compatibility Features    | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 603.3 Accommodation of Communication Needs                       | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |

## EN 301 549 Report

### Chapter 4: Functional Performance Statements

| Criteria                                                  | Conformance Level | Remarks and Explanations                                       |
| --------------------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| 4.2.1 Usage without vision                                | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 4.2.2 Usage with limited vision                           | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 4.2.3 Usage without perception of colour                  | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 4.2.4 Usage without hearing                               | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 4.2.5 Usage with limited hearing                          | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 4.2.6 Usage with no or limited vocal capability           | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 4.2.7 Usage with limited manipulation or strength         | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 4.2.8 Usage with limited reach                            | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 4.2.9 Minimize photosensitive seizure triggers            | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 4.2.10 Usage with limited cognition, language or learning | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 4.2.11 Privacy                                            | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |

### Chapter 5: Generic Requirements

| Criteria                                                        | Conformance Level | Remarks and Explanations                                       |
| --------------------------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| 5.1 Closed functionality (all clauses)                          | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 5.2 Activation of accessibility features                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 5.3 Biometrics                                                  | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 5.4 Preservation of accessibility information during conversion | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 5.5.1 Means of operation                                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 5.5.2 Operable parts discernibility                             | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 5.6.1 Tactile or auditory status                                | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 5.6.2 Visual status                                             | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 5.7 Key repeat                                                  | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 5.8 Double-strike key acceptance                                | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 5.9 Simultaneous user actions                                   | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |

### Chapters 6 to 8: Two-Way Voice, Video and Hardware

| Criteria                                                     | Conformance Level | Remarks and Explanations                                       |
| ------------------------------------------------------------ | ----------------- | -------------------------------------------------------------- |
| Chapter 6 ICT with Two-Way Voice Communication (all clauses) | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 7.1 Caption processing technology (all clauses)              | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 7.2 Audio description technology (all clauses)               | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 7.3 User controls for captions and audio description         | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| Chapter 8 Hardware (all clauses)                             | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |

### Chapters 9 to 11: Web, Non-web Documents and Software

| Criteria                                                                                        | Conformance Level | Remarks and Explanations                                       |
| ----------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| Chapter 9 Web (clauses 9.1 to 9.4, reported through the WCAG 2.x tables)                        | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 9.6 WCAG conformance requirements                                                               | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| Chapter 10 Non-web Documents (generated PDFs and exports, reported through the WCAG 2.x tables) | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| Chapter 11 Software, clauses 11.1 to 11.4 (reported through the WCAG 2.x tables)                | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 11.5.2 Interoperability with assistive technology (all clauses)                                 | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 11.6 Documented accessibility usage (all clauses)                                               | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 11.7 User preferences                                                                           | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 11.8 Authoring tools (all clauses)                                                              | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |

### Chapters 12 and 13: Documentation, Support Services, Relay and Emergency Access

| Criteria                                                                 | Conformance Level | Remarks and Explanations                                       |
| ------------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------- |
| 12.1.1 Accessibility and compatibility features                          | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 12.1.2 Accessible documentation                                          | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 12.2.2 Information on accessibility and compatibility features           | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 12.2.3 Effective communication                                           | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| 12.2.4 Accessible documentation                                          | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |
| Chapter 13 ICT Providing Relay or Emergency Service Access (all clauses) | Not Evaluated     | Evaluation is scheduled for Wave 6 (independent verification). |

## Legal Disclaimer

This report describes the accessibility of Compass 4.0 as of its report date, based on the evaluation methods listed. It is provided for information. It is not a warranty and does not create obligations beyond those in the customer's agreement with GHXSTSHIP Industries LLC. "Voluntary Product Accessibility Template" and "VPAT" are registered service marks of the Information Technology Industry Council (ITI).
