import { writeFileSync } from "node:fs";

const out = process.argv[2];

const A = [
  ["1.1.1", "Non-text Content"],
  ["1.2.1", "Audio-only and Video-only (Prerecorded)"],
  ["1.2.2", "Captions (Prerecorded)"],
  ["1.2.3", "Audio Description or Media Alternative (Prerecorded)"],
  ["1.3.1", "Info and Relationships"],
  ["1.3.2", "Meaningful Sequence"],
  ["1.3.3", "Sensory Characteristics"],
  ["1.4.1", "Use of Color"],
  ["1.4.2", "Audio Control"],
  ["2.1.1", "Keyboard"],
  ["2.1.2", "No Keyboard Trap"],
  ["2.1.4", "Character Key Shortcuts"],
  ["2.2.1", "Timing Adjustable"],
  ["2.2.2", "Pause, Stop, Hide"],
  ["2.3.1", "Three Flashes or Below Threshold"],
  ["2.4.1", "Bypass Blocks"],
  ["2.4.2", "Page Titled"],
  ["2.4.3", "Focus Order"],
  ["2.4.4", "Link Purpose (In Context)"],
  ["2.5.1", "Pointer Gestures"],
  ["2.5.2", "Pointer Cancellation"],
  ["2.5.3", "Label in Name"],
  ["2.5.4", "Motion Actuation"],
  ["3.1.1", "Language of Page"],
  ["3.2.1", "On Focus"],
  ["3.2.2", "On Input"],
  ["3.2.6", "Consistent Help"],
  ["3.3.1", "Error Identification"],
  ["3.3.2", "Labels or Instructions"],
  ["3.3.7", "Redundant Entry"],
  ["4.1.1", "Parsing"],
  ["4.1.2", "Name, Role, Value"],
];
const AA = [
  ["1.2.4", "Captions (Live)"],
  ["1.2.5", "Audio Description (Prerecorded)"],
  ["1.3.4", "Orientation"],
  ["1.3.5", "Identify Input Purpose"],
  ["1.4.3", "Contrast (Minimum)"],
  ["1.4.4", "Resize Text"],
  ["1.4.5", "Images of Text"],
  ["1.4.10", "Reflow"],
  ["1.4.11", "Non-text Contrast"],
  ["1.4.12", "Text Spacing"],
  ["1.4.13", "Content on Hover or Focus"],
  ["2.4.5", "Multiple Ways"],
  ["2.4.6", "Headings and Labels"],
  ["2.4.7", "Focus Visible"],
  ["2.4.11", "Focus Not Obscured (Minimum)"],
  ["2.5.7", "Dragging Movements"],
  ["2.5.8", "Target Size (Minimum)"],
  ["3.1.2", "Language of Parts"],
  ["3.2.3", "Consistent Navigation"],
  ["3.2.4", "Consistent Identification"],
  ["3.3.3", "Error Suggestion"],
  ["3.3.4", "Error Prevention (Legal, Financial, Data)"],
  ["3.3.8", "Accessible Authentication (Minimum)"],
  ["4.1.3", "Status Messages"],
];
const AAA = [
  ["1.2.6", "Sign Language (Prerecorded)"],
  ["1.2.7", "Extended Audio Description (Prerecorded)"],
  ["1.2.8", "Media Alternative (Prerecorded)"],
  ["1.2.9", "Audio-only (Live)"],
  ["1.3.6", "Identify Purpose"],
  ["1.4.6", "Contrast (Enhanced)"],
  ["1.4.7", "Low or No Background Audio"],
  ["1.4.8", "Visual Presentation"],
  ["1.4.9", "Images of Text (No Exception)"],
  ["2.1.3", "Keyboard (No Exception)"],
  ["2.2.3", "No Timing"],
  ["2.2.4", "Interruptions"],
  ["2.2.5", "Re-authenticating"],
  ["2.2.6", "Timeouts"],
  ["2.3.2", "Three Flashes"],
  ["2.3.3", "Animation from Interactions"],
  ["2.4.8", "Location"],
  ["2.4.9", "Link Purpose (Link Only)"],
  ["2.4.10", "Section Headings"],
  ["2.4.12", "Focus Not Obscured (Enhanced)"],
  ["2.4.13", "Focus Appearance"],
  ["2.5.5", "Target Size (Enhanced)"],
  ["2.5.6", "Concurrent Input Mechanisms"],
  ["3.1.3", "Unusual Words"],
  ["3.1.4", "Abbreviations"],
  ["3.1.5", "Reading Level"],
  ["3.1.6", "Pronunciation"],
  ["3.2.5", "Change on Request"],
  ["3.3.5", "Help"],
  ["3.3.6", "Error Prevention (All)"],
  ["3.3.9", "Accessible Authentication (Enhanced)"],
];

const s508ch3 = [
  ["302.1", "Without Vision"],
  ["302.2", "With Limited Vision"],
  ["302.3", "Without Perception of Color"],
  ["302.4", "Without Hearing"],
  ["302.5", "With Limited Hearing"],
  ["302.6", "Without Speech"],
  ["302.7", "With Limited Manipulation"],
  ["302.8", "With Limited Reach and Strength"],
  ["302.9", "With Limited Language, Cognitive, and Learning Abilities"],
];
const s508ch5 = [
  ["501.1", "Scope, Incorporation of WCAG 2.0 AA"],
  ["502.2.1", "User Control of Accessibility Features"],
  ["502.2.2", "No Disruption of Accessibility Features"],
  ["502.3.1", "Object Information"],
  ["502.3.2", "Modification of Object Information"],
  ["502.3.3", "Row, Column, and Headers"],
  ["502.3.4", "Values"],
  ["502.3.5", "Modification of Values"],
  ["502.3.6", "Label Relationships"],
  ["502.3.7", "Hierarchical Relationships"],
  ["502.3.8", "Text"],
  ["502.3.9", "Modification of Text"],
  ["502.3.10", "List of Actions"],
  ["502.3.11", "Actions on Objects"],
  ["502.3.12", "Focus Cursor"],
  ["502.3.13", "Modification of Focus Cursor"],
  ["502.3.14", "Event Notification"],
  ["502.4", "Platform Accessibility Features"],
  ["503.2", "User Preferences"],
  ["503.3", "Alternative User Interfaces"],
  ["503.4.1", "Caption Controls"],
  ["503.4.2", "Audio Description Controls"],
  ["504.2", "Content Creation or Editing"],
  ["504.2.1", "Preservation of Information Provided for Accessibility in Format Conversion"],
  ["504.2.2", "PDF Export"],
  ["504.3", "Prompts"],
  ["504.4", "Templates"],
];
const s508ch6 = [
  ["601.1", "Scope"],
  ["602.2", "Accessibility and Compatibility Features"],
  ["602.3", "Electronic Support Documentation"],
  ["602.4", "Alternate Formats for Non-Electronic Support Documentation"],
  ["603.2", "Information on Accessibility and Compatibility Features"],
  ["603.3", "Accommodation of Communication Needs"],
];

const en4 = [
  ["4.2.1", "Usage without vision"],
  ["4.2.2", "Usage with limited vision"],
  ["4.2.3", "Usage without perception of colour"],
  ["4.2.4", "Usage without hearing"],
  ["4.2.5", "Usage with limited hearing"],
  ["4.2.6", "Usage with no or limited vocal capability"],
  ["4.2.7", "Usage with limited manipulation or strength"],
  ["4.2.8", "Usage with limited reach"],
  ["4.2.9", "Minimize photosensitive seizure triggers"],
  ["4.2.10", "Usage with limited cognition, language or learning"],
  ["4.2.11", "Privacy"],
];
const en5 = [
  ["5.1", "Closed functionality (all clauses)"],
  ["5.2", "Activation of accessibility features"],
  ["5.3", "Biometrics"],
  ["5.4", "Preservation of accessibility information during conversion"],
  ["5.5.1", "Means of operation"],
  ["5.5.2", "Operable parts discernibility"],
  ["5.6.1", "Tactile or auditory status"],
  ["5.6.2", "Visual status"],
  ["5.7", "Key repeat"],
  ["5.8", "Double-strike key acceptance"],
  ["5.9", "Simultaneous user actions"],
];
const en6to8 = [
  ["Chapter 6", "ICT with Two-Way Voice Communication (all clauses)"],
  ["7.1", "Caption processing technology (all clauses)"],
  ["7.2", "Audio description technology (all clauses)"],
  ["7.3", "User controls for captions and audio description"],
  ["Chapter 8", "Hardware (all clauses)"],
];
const en9to11 = [
  ["Chapter 9", "Web (clauses 9.1 to 9.4, reported through the WCAG 2.x tables)"],
  ["9.6", "WCAG conformance requirements"],
  [
    "Chapter 10",
    "Non-web Documents (generated PDFs and exports, reported through the WCAG 2.x tables)",
  ],
  ["Chapter 11", "Software, clauses 11.1 to 11.4 (reported through the WCAG 2.x tables)"],
  ["11.5.2", "Interoperability with assistive technology (all clauses)"],
  ["11.6", "Documented accessibility usage (all clauses)"],
  ["11.7", "User preferences"],
  ["11.8", "Authoring tools (all clauses)"],
];
const en12to13 = [
  ["12.1.1", "Accessibility and compatibility features"],
  ["12.1.2", "Accessible documentation"],
  ["12.2.2", "Information on accessibility and compatibility features"],
  ["12.2.3", "Effective communication"],
  ["12.2.4", "Accessible documentation"],
  ["Chapter 13", "ICT Providing Relay or Emergency Service Access (all clauses)"],
];

const products = {
  atlas: {
    name: "Atlas 4.0 and Gateway 4.0",
    file: "acr-atlas.md",
    title: "Accessibility Conformance Report: Atlas",
    desc: "Atlas 4.0 is the internal web application of XOS 4.0, used by organization members to plan, budget, procure, staff, advance and close experiential productions. Gateway 4.0 is the external web application that vendors, contractors, clients, crew, staff, artists, artist representatives and sponsors use for opportunities, onboarding, engagements and payments. Both are Next.js web applications built on one design system and are delivered as installable progressive web apps. This report covers both, together with the documentation site, generated PDF documents and notification emails.",
    scope:
      "Every Atlas and Gateway screen named in Section 11.5 of the XOS 4.0 build specification, the documentation site, every generated document template, and every email template. Supported browsers: the latest two versions of Chrome, Edge, Safari and Firefox, and Safari on iOS and iPadOS.",
    at: "VoiceOver on macOS, NVDA with Firefox and Chrome on Windows, VoiceOver on iOS and iPadOS, keyboard only, browser zoom to 400 percent, and Windows high contrast mode.",
    swRemark:
      "Atlas and Gateway are web applications; Chapter 5 applies to them as web software through Section 508 E205.4 and 501.1.",
  },
  compass: {
    name: "Compass 4.0",
    file: "acr-compass.md",
    title: "Accessibility Conformance Report: Compass",
    desc: "Compass 4.0 is the field application of XOS 4.0 for iOS and Android phones and tablets. It serves internal members and external parties for on-site operations: shifts and the time clock, tasks and checklists, inspections, incident reports, run of show, scanning, credentials, chat, feed, training and the kiosk. It works offline, and includes Live Activities and home screen widgets.",
    scope:
      "Every Compass screen named in Section 11.5 of the XOS 4.0 build specification, on the latest two major versions of iOS and on Android at the current Play target API level, in phone and tablet layouts, including Live Activities, widgets and kiosk mode.",
    at: "VoiceOver on iOS, TalkBack on Android, Switch Control, Voice Control, Dynamic Type and Android font scaling to 200 percent, Bold Text, Reduce Motion, and external keyboard.",
    swRemark: "Compass is native mobile software; Chapter 5 applies in full.",
  },
};

const NE = "Not Evaluated";
const wave = "Evaluation is scheduled for Wave 6 (independent verification).";
const table = (rows, remark) =>
  [
    "| Criteria | Conformance Level | Remarks and Explanations |",
    "| --- | --- | --- |",
    ...rows.map(([id, name]) => `| ${id} ${name} | ${NE} | ${remark ?? wave} |`),
  ].join("\n");

for (const key of Object.keys(products)) {
  const p = products[key];
  const parsingRemark = `${wave} WCAG 2.2 marks 4.1.1 as obsolete and always satisfied; the report will record that position.`;
  const levelA = [
    "| Criteria | Conformance Level | Remarks and Explanations |",
    "| --- | --- | --- |",
    ...A.map(
      ([id, name]) => `| ${id} ${name} | ${NE} | ${id === "4.1.1" ? parsingRemark : wave} |`,
    ),
  ].join("\n");
  const doc = `---
title: ${p.title}
version: 1.0.0-draft
effective_date: The date this version is published at /legal
status: Draft for review by counsel before launch; every criterion Not Evaluated until Wave 6
---

# ${p.title}

> **Draft for review by counsel before launch.** This report is a draft. No criterion has been evaluated yet. It takes effect only when GHXSTSHIP Industries LLC publishes it at /legal with completed evaluation results, and its effective date is that date of publication.

This Accessibility Conformance Report follows the structure of the ITI VPAT 2.5 International edition (VPAT 2.5Rev INT), which reports against WCAG 2.x, the Revised Section 508 Standards and EN 301 549 together. Template instructions from the VPAT form are not reproduced here.

## Name of Product and Version

${p.name}, version 4.0.0 (pre-release).

## Report Date

The date this report is published at /legal. This draft structure was prepared in Wave 1 of the XOS 4.0 build.

## Product Description

${p.desc}

## Contact Information

GHXSTSHIP Industries LLC. Accessibility questions go to the accessibility mailbox listed on our contact page at /legal/contact, with a response within 5 business days as our Accessibility Statement commits.

## Notes

- **Status:** every criterion in this draft is marked Not Evaluated. Evaluation happens in Wave 6, when the independent accessibility reviewer audits the product and records each pass in \`legal/accessibility/audit-log.md\`. This report will then be completed from that log.
- **Scope:** ${p.scope}
- **Target:** WCAG 2.2 Level AA conformance, which XOS uses to address Section 508, ADA Titles II and III, EN 301 549, the European Accessibility Act, the AODA and the Accessible Canada Act.

## Evaluation Methods Used

Planned for Wave 6:

- automated axe-core checks in unit tests, Storybook and Playwright${key === "compass" ? ", and accessibility assertions in Maestro flows on iOS and Android" : ""}, with zero serious or critical violations allowed
- manual testing with ${p.at}
- keyboard-only journey tests and reduced-motion snapshot tests
- review of generated documents with veraPDF for PDF/UA

## Applicable Standards and Guidelines

| Standard or Guideline | Included in Report |
| --- | --- |
| Web Content Accessibility Guidelines 2.0 | Level A (Yes), Level AA (Yes), Level AAA (Yes, reported through the WCAG 2.2 tables) |
| Web Content Accessibility Guidelines 2.1 | Level A (Yes), Level AA (Yes), Level AAA (Yes, reported through the WCAG 2.2 tables) |
| Web Content Accessibility Guidelines 2.2 | Level A (Yes), Level AA (Yes), Level AAA (Yes) |
| Revised Section 508 standards as published by the U.S. Access Board in the Federal Register on January 18, 2017, corrected January 22, 2018 | Yes |
| EN 301 549 Accessibility requirements for ICT products and services, V3.1.1 (2019-11) and V3.2.1 (2021-03) | Yes |

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

${levelA}

### Table 2: Success Criteria, Level AA

${table(AA)}

### Table 3: Success Criteria, Level AAA

${table(AAA, `${wave} XOS does not target Level AAA; results are reported for information.`)}

## Revised Section 508 Report

### Chapter 3: Functional Performance Criteria

${table(s508ch3)}

### Chapter 4: Hardware

${table([["Chapter 4", "Hardware (all sections)"]], `${wave} ${p.name} is software and runs on customer-supplied hardware; applicability will be confirmed in Wave 6.`)}

### Chapter 5: Software

${table(s508ch5, `${wave} ${p.swRemark}`)}

### Chapter 6: Support Documentation and Services

${table(s508ch6)}

## EN 301 549 Report

### Chapter 4: Functional Performance Statements

${table(en4)}

### Chapter 5: Generic Requirements

${table(en5)}

### Chapters 6 to 8: Two-Way Voice, Video and Hardware

${table(en6to8)}

### Chapters 9 to 11: Web, Non-web Documents and Software

${table(en9to11)}

### Chapters 12 and 13: Documentation, Support Services, Relay and Emergency Access

${table(en12to13)}

## Legal Disclaimer

This report describes the accessibility of ${p.name} as of its report date, based on the evaluation methods listed. It is provided for information. It is not a warranty and does not create obligations beyond those in the customer's agreement with GHXSTSHIP Industries LLC. "Voluntary Product Accessibility Template" and "VPAT" are registered service marks of the Information Technology Industry Council (ITI).
`;
  writeFileSync(`${out}/${p.file}`, doc);
}
