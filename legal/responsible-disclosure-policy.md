---
title: Responsible Disclosure Policy
version: 1.0.0
effective_date: 2026-11-10
status: In effect
---

# Responsible Disclosure Policy

GHXSTSHIP Industries LLC ("GHXSTSHIP") welcomes reports from security researchers. This policy adds detail on scope, rules of engagement and safe harbor to `SECURITY.md` in the XOS repository. If they ever differ, the version published at /legal controls.

## 1. How to Report

- **Email:** support@ghxstship.pro with "Security" in the subject line. Use this channel today.
- **GitHub:** private vulnerability reporting on the `ghxstship/atlas` repository is not turned on at this time. Use it only if the Security tab shows "Report a vulnerability".
- Do not put details of a finding in a public issue, post them on a forum, or contact Customers about a vulnerability. If your email bounces, or you have no answer within 3 business days, use the issue form "Ask for a private way to report a security finding" (https://github.com/ghxstship/atlas/issues/new?template=security_private_channel.yml). It asks only why you need one, and we then give you a private way to send the details. The form needs a GitHub account.

Include the affected surface (Atlas, Gateway, Compass, API, SDK, CLI or MCP server), the version or URL, steps to reproduce, the impact you observed, and any proof of concept. Keep other people's data out of your report. Tell us how you would like to be credited. Please write in English if you can.

You may report anonymously. We then cannot reach you with questions or updates, or credit you, and you do not need to give us your name to be covered by Section 5.

## 2. Our Commitments

If you give us a way to reach you:

- We acknowledge your report within **3 business days**. Business days are Monday to Friday, except US federal holidays, in New York time.
- We share an assessment and remediation plan within **10 business days**.
- We keep you informed until the issue is fixed, and tell you when it is.
- We credit you in our release notes and security acknowledgments if you wish.

We do not share your name or contact details with others without your permission unless the law requires it. We do not currently pay bounties, and a report does not create a right to payment. If we start a bounty program, we will announce it on this page.

## 3. Scope

**In scope**

- the code in the `ghxstship/atlas` repository
- the hosted XOS services we run at `atlas.ghxstship.tech`, `gateway.ghxstship.tech`, `api.ghxstship.tech`, `docs.ghxstship.tech`, `status.ghxstship.tech` and `console.ghxstship.tech`
- the Compass apps published by GHXSTSHIP
- the published SDKs, CLI and MCP server

**Out of scope**

- denial of service through traffic volume, or any test that degrades the service for others
- social engineering, phishing or physical attacks against GHXSTSHIP staff, Customers or users
- findings in third-party services that XOS integrates with or runs on, which go to those vendors (we will help route them)
- self-hosted deployments run by others, which go to their operators
- a Customer's own systems, including anything on its custom domain other than the XOS application itself
- reports from automated scanners without a demonstrated impact, missing best-practice headers without an exploit, and clickjacking on pages with no sensitive action

Anything not listed as in scope is out of scope. If you are not sure, ask at support@ghxstship.pro with "Security" in the subject line before you test.

## 4. Rules of Engagement

- Test only against accounts and organizations you create yourself. Use a free Access plan organization or a local self-hosted copy.
- Never access, change or delete data belonging to anyone else. If you reach someone else's data by accident, stop, do not keep or share it, and tell us in your report.
- Do not attempt to read Restricted fields, sealed bids or another tenant's records beyond the minimum needed to show the issue exists.
- Use an exploit only as far as you need to confirm the issue. Do not keep access, install anything that persists, or move further into a system once you have shown the issue.
- Run automated tools only at a rate that does not affect the service.
- Do not run tests that send email or SMS to real people.
- Give us reasonable time to fix an issue before any public disclosure. We aim to fix critical issues within 30 days and ask for up to 90 days before disclosure; we will agree a date with you.

## 5. Safe Harbor

If you make a good-faith effort to follow this policy, we will consider your research authorized, we will not pursue or support legal action against you for it, including under the Computer Fraud and Abuse Act, similar state computer crime laws, the DMCA's anti-circumvention provisions or our Terms of Service and Acceptable Use Policy, and we will tell anyone who asks that your research was authorized. If a third party brings legal action against you for research that followed this policy, we will make this authorization known.

This safe harbor does not cover conduct that violates the rules above or the law, or a demand for payment in exchange for keeping or disclosing a finding. We can authorize testing only of systems we control. We cannot authorize testing of a vendor's or Customer's own systems, and our authorization does not bind other people or government authorities.

## 6. security.txt

Our security.txt file under RFC 9116 is kept at `legal/security/security.txt` in the repository. It is served at `/.well-known/security.txt` on `atlas.ghxstship.tech`, `gateway.ghxstship.tech` and `api.ghxstship.tech` from the release that includes it, and not yet on the documentation site, the console or the status page. Its contact is support@ghxstship.pro with "Security" in the subject line.

## 7. Questions

Questions about this policy go to support@ghxstship.pro with "Security" in the subject line.
