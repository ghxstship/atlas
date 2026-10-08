---
title: Responsible Disclosure Policy
version: 1.0.0-draft
effective_date: The date this version is published at /legal
status: Draft for review by counsel before launch
---

# Responsible Disclosure Policy

> **Draft for review by counsel before launch.** This document is a draft. It is not in effect and no one may rely on it. It takes effect only when GHXSTSHIP Industries LLC publishes it at /legal, and its effective date is that date of publication.

GHXSTSHIP Industries LLC ("GHXSTSHIP") welcomes reports from security researchers. This policy is consistent with `SECURITY.md` in the XOS repository and adds detail on scope, rules of engagement and safe harbor.

## 1. How to Report

- **Preferred:** GitHub private vulnerability reporting on the `ghxstship/atlas` repository (Security tab, "Report a vulnerability").
- **Alternative:** the security mailbox listed on our contact page at /legal/contact.
- Do not open a public issue, post on a forum, or contact Customers about a vulnerability.

Include the affected surface (Atlas, Gateway, Compass, API, SDK, CLI or MCP server), the version or URL, steps to reproduce, the impact you observed, and any proof of concept. Tell us how you would like to be credited.

## 2. Our Commitments

- We acknowledge your report within **3 business days**.
- We share an assessment and remediation plan within **10 business days**.
- We keep you informed until the issue is fixed, and tell you when it is.
- We credit you in our release notes and security acknowledgments if you wish.
- We do not currently pay bounties. If we start a bounty program, we will announce it on this page.

## 3. Scope

**In scope**

- the code in the `ghxstship/atlas` repository
- the hosted XOS services: Atlas, Gateway, the public API, the documentation site and the Compass apps published by GHXSTSHIP
- the published SDKs, CLI and MCP server

**Out of scope**

- denial of service through traffic volume, or any test that degrades the service for others
- social engineering, phishing or physical attacks against GHXSTSHIP staff, Customers or users
- findings in third-party services that XOS integrates with, which go to those vendors (we will help route them)
- self-hosted deployments run by others, which go to their operators
- reports from automated scanners without a demonstrated impact, missing best-practice headers without an exploit, and clickjacking on pages with no sensitive action

## 4. Rules of Engagement

- Test only against accounts and organizations you create yourself. Use a free Access plan organization or a local self-hosted copy.
- Never access, change or delete data belonging to anyone else. If you reach someone else's data by accident, stop, do not keep it, and tell us in your report.
- Do not attempt to read Restricted fields, sealed bids or another tenant's records beyond the minimum needed to show the issue exists.
- Do not run tests that send email or SMS to real people.
- Give us reasonable time to fix an issue before any public disclosure. We aim to fix critical issues within 30 days and ask for up to 90 days before disclosure; we will agree a date with you.

## 5. Safe Harbor

If you make a good-faith effort to follow this policy, we will consider your research authorized, we will not pursue or support legal action against you for it, including under the Computer Fraud and Abuse Act, the DMCA's anti-circumvention provisions or our Terms of Service, and we will tell anyone who asks that your research was authorized. If a third party brings legal action against you for research that followed this policy, we will make this authorization known. This safe harbor does not cover conduct that violates the rules above or the law.

## 6. security.txt

We publish a security.txt file under RFC 9116 at `/.well-known/security.txt` on each XOS domain. Its content is maintained in `legal/security/security.txt` and points researchers to this policy and to our reporting channels.
