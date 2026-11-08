---
title: Accessibility Statement
version: 1.0.0-draft
effective_date: The date GHXSTSHIP states when it makes this version final
status: Draft before launch
---

# Accessibility Statement

> **Draft before launch.** This document is a draft. It is not in effect and no one may rely on it. Showing it at /legal does not put it in effect. It takes effect only on the effective date that GHXSTSHIP Industries LLC states at the top of a final version.

GHXSTSHIP Industries LLC ("GHXSTSHIP") wants everyone who plans, staffs, supplies and works at live productions to be able to use XOS 4.0, including people with disabilities. This statement covers Atlas, Gateway, Compass for iOS and Android, the documentation site, our emails and the PDFs XOS generates. It was prepared on 6 November 2026.

## 1. Our Standard

Our design and test target is the **Web Content Accessibility Guidelines (WCAG) 2.2 at Level AA**. It is a target. Section 2 says how far we have checked it.

XOS is sold to organizations, and buyers often ask about Section 508 of the US Rehabilitation Act, the Americans with Disabilities Act, EN 301 549, the Accessibility for Ontarians with Disabilities Act and the Accessible Canada Act. Our Accessibility Conformance Reports use the VPAT 2.5 International edition format, which reports against WCAG, the Revised Section 508 Standards and EN 301 549 together, so that buyers can compare. This statement does not say that XOS meets any of those laws or standards, or that any of them applies to XOS.

Using XOS does not make an organization or its event accessible or compliant. Each organization remains responsible for its own duties, such as accessible venues and ticketing, and accommodations for its workers and guests.

Generated PDFs are designed to PDF/UA-1. An automated veraPDF check of the generated document templates runs in our continuous integration. No person has reviewed the PDFs or used them with assistive technology, so this is not a claim that they conform. Emails use semantic HTML and have a plain-text version.

## 2. Conformance Status

**We do not claim conformance with WCAG 2.2 Level AA.** What we have done so far:

- On 16 October 2026, on a build before version 4.0.0, a separate automated build agent evaluated Atlas, Gateway and Compass at Levels A and AA, and a second agent re-ran its checks after the fixes. That agent is software. It is not a human auditor, and it could not run a screen reader.
- For Atlas and Gateway, the evaluation ran in headless Chrome 155 only, using automated checks with axe-core 4.13, scripted keyboard journeys and reading of the browser's accessibility tree. For Compass, it rested on reading the source code, not on testing a device.
- Versions 4.1 to 4.5 have shipped since then. They have been through our automated checks, but the evaluation has not been repeated.

The results are in our draft Accessibility Conformance Reports for Atlas, Gateway and Compass at /legal/acr-atlas, /legal/acr-gateway and /legal/acr-compass. They mark as Partially Supports each criterion that depends on the human passes still owed. We will update this statement and those reports as evaluation continues.

## 3. What We Build In

These are our design rules and what we have built. They are not results of testing with people who use assistive technology.

- Keyboard operation of every screen, including the command menu, tables and dialogs, with visible focus.
- Names, roles and states for screen readers: VoiceOver on macOS and iOS, NVDA on Windows, and TalkBack on Android. No one has yet tested XOS with these screen readers.
- Color contrast checked against WCAG 2.2 AA in light and dark themes. The white-label theme editor blocks any brand color combination that fails contrast.
- No information conveyed by color alone.
- Reduced motion respected, with haptics optional in Compass.
- In Compass: Dynamic Type and font scaling to 200 percent, labels for controls, and touch targets of at least 48 points, checked so far in source code only.
- Layouts that can mirror for right-to-left languages, checked with a test locale. No right-to-left language ships today.
- Help text on fields with legal or financial meaning, and tooltips that do not hold information found nowhere else.

## 4. How We Test

- Automated axe-core checks in component stories and in end-to-end tests of every signed-in Atlas and Gateway page for each role, in both themes, at desktop and phone widths. A serious or critical violation fails the check.
- Scripted keyboard-only journey tests.
- Reduced-motion tests on web and mobile.
- An automated PDF/UA check of generated PDFs.

**Not done yet.** No person has yet run the screen reader, device, browser zoom or forced-colors passes. We have decided to hire an accessibility tester for the screen reader passes, and that testing has not happened. The screens and criteria these passes must cover are listed in our accessibility audit log.

## 5. Feedback and Response Commitment

If you have trouble using any part of XOS, or need information in another format, tell us:

- by email: the accessibility mailbox listed on our contact page at /legal/contact, which reaches GHXSTSHIP directly
- by mail: the postal address listed on that contact page
- in the Service: Help, then Contact Support. Say in your message that it is about accessibility. In Compass and in Gateway's platform support, this reaches GHXSTSHIP about your own account. In Atlas, it reaches your organization's admins first

**We respond within 5 business days.** Our response will acknowledge the issue, tell you how we will address it, and offer a way to get the information or complete the task you need in the meantime. We log every report and track it to resolution. Business days are Monday to Friday, except US federal holidays, in New York time.

If you are a crew member, vendor or other external party using XOS for an organization, you can also contact that organization, which can request help from us for you.

## 6. Formal Complaints

If you are not satisfied with our response, you may ask for review by writing to the accessibility mailbox with "Review" in the subject. We respond within 10 business days. A person looks at your complaint afresh and records the reasons. GHXSTSHIP is a small team, so that person may be the one who first responded, and if so we tell you.

You may also contact the enforcement body in your country. In the United States, the Department of Justice takes complaints under the Americans with Disabilities Act at ada.gov/file-a-complaint.

## 7. Third-Party Content

Content that Customers upload, such as riders, documents and images, is outside our control and is shown or passed on as uploaded. XOS adds alternative text to the images in the PDFs it generates, but it does not offer a field for alternative text on every uploaded file. Customers are responsible for the accessibility of what they upload.

## 8. Review of This Statement

We review this statement at least once a year and after each major release.

## 9. Known Limitations

- Criteria that depend on spoken output are unconfirmed in Atlas, Gateway and Compass, because no screen reader pass has been run.
- Browser zoom at 200 and 400 percent and Windows forced colors have not been tested by a person.
- Generated PDFs, emails and the documentation site were not part of the October 2026 evaluation. They have automated checks only, and email zoom has not been tested.
- Compass Live Activities and home screen widgets were not reviewed.
- The October 2026 evaluation did not use Edge, Firefox or Safari. Section 10 says where automated checks reach further.
- The Contact Support form has no accessibility category. Use the mailbox, or say so in your message.

## 10. Supported Browsers

XOS is built to support the latest two versions of Chrome, Edge, Safari and Firefox, and Safari on iOS and iPadOS. That is a support target. It does not mean accessibility has been evaluated in each of them.

The October 2026 evaluation in Section 2 ran in headless Chrome only. In our continuous integration, the axe-core checks of signed-in pages run in Chromium, and the axe-core checks of component stories run in the Chromium, Firefox and WebKit browser engines. WebKit is the engine behind Safari, but these checks do not run in Safari itself, and none runs in Edge.
