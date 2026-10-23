---
title: Security Overview
version: 1.0.0-draft
effective_date: The date this version is published at /legal
status: Draft for review by counsel before launch
---

# Security Overview

> **Draft for review by counsel before launch.** This document is a draft. It is not in effect and no one may rely on it. It takes effect only when GHXSTSHIP Industries LLC publishes it at /legal, and its effective date is that date of publication.

This page describes how GHXSTSHIP Industries LLC ("GHXSTSHIP") protects XOS 4.0 and the data our Customers trust it with. It summarizes our internal policies. It is not a certification. Where a program is in progress, this page says so.

## 1. Program and Frameworks

- **SOC 2 Type II.** We are building our controls to the Trust Services Criteria for Security, Availability, Confidentiality and Privacy, and plan to undergo a SOC 2 Type II examination. We will publish the report's availability here when it is issued.
- **ISO/IEC 27001:2022 and ISO/IEC 27701.** We maintain a Statement of Applicability against ISO/IEC 27001:2022 Annex A and design our privacy controls to ISO/IEC 27701. We do not currently hold certification.
- **OWASP ASVS 5.0 Level 2.** Every application control is mapped to a test or document.
- **NIST SP 800-63B.** Authentication strength and account recovery follow its guidance.
- **PCI DSS v4.0.1.** Card data never touches XOS. Checkout and the customer portal are hosted by Stripe, which keeps our scope to SAQ A.

## 2. Architecture

- **The database is the boundary.** Authorization, tenancy, state transitions and money rules are enforced inside Postgres with row-level security, constraints, triggers and stored procedures. Application code may repeat a check for usability, never instead of the database.
- **Tenant isolation.** Each row's organization is derived by the database, never accepted from the caller, and can never change. Cross-organization references are refused. Every build runs automated tests that try to read and write across tenants on every table.
- **External access.** Vendors, crew, clients and other external parties read only through column-allowlisted views. Internal notes, margins, budget lines, other parties' rates and internal ratings never reach them. Their access opens with an engagement and narrows and closes on a fixed schedule after it ends.
- **Hosting.** Data lives in Supabase Postgres and Storage on Amazon Web Services in the United States. An Enterprise customer may ask for hosting in the European Union; it is set up under that customer's agreement, and the Subprocessor List names the EU region before any data is hosted there. The web applications run on Vercel. See the Subprocessor List.

## 3. Identity and Access

- Email and password, magic links, passkeys, and Google, Apple and Microsoft sign-in. SAML single sign-on and SCIM on the Enterprise plan.
- Passwords are checked against known breached-password lists.
- Multi-factor authentication with an authenticator app (TOTP), or a security key or passkey as a second factor. Anyone who has a second factor uses it after signing in, in Atlas, Gateway and Compass. Organizations can require it for Owners and Admins or for everyone; a member it applies to sets one up before opening the organization. Passkeys also sign in without a password.
- Ten single-use recovery codes per person, shown once and stored only as one-way hashes, for signing in or confirming an action without the usual second factor. Using one notifies the person; five wrong codes lock out further tries for 15 minutes.
- Step-up authentication (a second factor in the current session) for Restricted data exports, including the full organization export, SCIM tokens and break-glass. Changing a member's role, creating an API key, removing a second factor, changing passkeys, making recovery codes and letting an app use Restricted data need a second factor used in the last 15 minutes. Billing changes will ask for the same when they open in Atlas.
- Each person sees where they are signed in (device, approximate place, last activity) and can sign out any other session or all of them at once; Atlas, Gateway and the XOS API stop accepting a signed-out session at once.
- OAuth 2.1 apps an organization registers act for a person only after their consent, only in that organization and only in the capability groups they allowed, using authorization codes with PKCE (S256) and rotating refresh tokens. Revoking an app ends its access at once.
- Per-organization session lifetime and idle timeout: a session older than the organization allows signs in again before opening it, and in Atlas so does a session left idle longer than it allows. The session lifetime and the MFA requirement are enforced wherever Atlas, the XOS API and Compass check a session, and the idle timeout wherever Atlas does. None of them is enforced on direct calls to the underlying Supabase data endpoint; we plan to close that gap the same way as for IP allow-lists below.
- IP allow-lists. An org's IP allow-list is enforced wherever Atlas and the XOS API check a session or an API key. It is not yet enforced on direct calls to the underlying Supabase data endpoint (REST, Storage and Realtime) made with a valid session token, because only Atlas and the API see the caller's address. So a signed-in person outside the allowed networks who calls that endpoint directly can still read and write what their role allows. We plan to close this gap by routing all data access through the API.
- Role-based access with fine-grained capabilities, spend authority limits and separation of duties enforced in the database.
- "View as role" and "Why can I see this" make access transparent. Quarterly access reviews flag unreviewed access.
- Break-glass access requires MFA and a written reason, notifies every Admin, applies only in the session that passed the second factor, and expires after one hour; its start, end or expiry is recorded in the audit ledger.

## 4. Data Protection

- TLS 1.2 or higher everywhere, with HSTS preloading.
- AES-256 encryption at rest.
- Field-level encryption for tax identifiers, bank details, government identifiers and medical encounter notes.
- Every column carries a classification: Public, Internal, Confidential or Restricted. Restricted values are masked unless the viewer holds the matching capability.
- Data loss prevention by classification: export controls, expiring share links with access codes, and watermarks on Confidential and Restricted documents.
- Compass encrypts its offline database, supports biometric unlock, and wipes its local store on remote sign-out.
- Medical records and Restricted fields are never sent to AI models. Customer data is never used to train models.

## 5. Application Security

- Strict Content Security Policy with nonces, same-site cookies and CSRF protection.
- SSRF protection on webhooks and imports.
- Uploads are MIME-sniffed, size-capped, virus-scanned and, for SVG, sanitized. Active content is never served inline from public storage. Virus scanning uses ClamAV that we run ourselves, so files never leave XOS infrastructure for scanning. A file stays quarantined until it scans clean, and an infected file is deleted.
- Rate limits per IP, user, API key and token; repeated token failures lock the token.
- Webhooks are signed with HMAC-SHA256 and a timestamp.

## 6. Secure Development

- Every change is peer reviewed and must pass CI: static analysis (CodeQL and Semgrep), dependency audit, secret scanning, license checks, database security advisors and the full test suite.
- Dynamic scanning (OWASP ZAP baseline) runs against staging.
- Commits on the main branch are signed. CI actions are pinned by commit hash. Each release ships a CycloneDX software bill of materials.
- Dependencies are kept current by automated update requests.

## 7. Reliability and Recovery

- 99.9 percent monthly availability target, with a public status page and synthetic checks every minute from five regions.
- Point-in-time recovery with at least 7 days of history and weekly logical backups to separate storage.
- 1 hour recovery point objective and 4 hour recovery time objective, verified by restore drills.
- Staged rollouts of Atlas (5, 25, then 100 percent) that roll back when errors regress, instant rollback of every web application to its previous deployment, and kill switches on risky features.

## 8. Monitoring and Incident Response

- An append-only audit ledger, retained for 7 years, records security-relevant events in every organization. Customers can export it on the Team plan and above.
- Errors and performance are monitored, with personal data scrubbed before it leaves the application.
- Alerts route to an on-call rotation with runbooks.
- Our incident response plan sets severity levels, roles and timelines. We notify affected Customers of a personal data breach within 48 hours of becoming aware of it.

## 9. People and Vendors

- Personnel sign confidentiality undertakings, are screened where the law allows, and complete security and privacy training at hire and every year.
- GHXSTSHIP staff never view a Customer's data without a support session granted by its Owner, which expires within 24 hours and is logged to the Customer's audit ledger.
- Every subprocessor is reviewed before use and every year after, under written data protection terms.

## 10. Reporting a Vulnerability

See our Responsible Disclosure Policy and the security.txt file published with it. Security questions from Customers go to the security mailbox listed on our contact page at /legal/contact.
