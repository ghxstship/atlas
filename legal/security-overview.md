---
title: Security Overview
version: 1.0.0
effective_date: 2026-11-10
status: In effect
---

# Security Overview

This page describes how GHXSTSHIP Industries LLC ("GHXSTSHIP") protects XOS and the data our Customers trust it with. It summarizes our internal policies and what the product does today. It is not a certification or a warranty. Where a program is in progress, or a policy is not yet fully in practice, this page says so. Our contractual security commitments are in Annex II of the Data Processing Agreement.

## 1. Program and Frameworks

We have not been audited or certified against any framework named here. They are the references we build to.

- **SOC 2 Type II.** We are building our controls to the Trust Services Criteria for Security, Availability, Confidentiality and Privacy, and plan to undergo a SOC 2 Type II examination. We hold no SOC 2 report today. We will say so here if one is issued.
- **ISO/IEC 27001:2022.** We keep an internal Statement of Applicability against ISO/IEC 27001:2022 Annex A, in which some controls are still planned. We do not hold ISO/IEC 27001 or ISO/IEC 27701 certification.
- **OWASP ASVS 5.0 Level 2.** This is our internal verification standard. A self-assessed matrix maps each requirement to a test or a document, or records it as a gap or an accepted risk.
- **NIST SP 800-63B.** We use it as a reference for authentication strength and account recovery. We have not assessed XOS against an assurance level.
- **PCI DSS v4.0.1.** Card data never touches XOS. Checkout and the customer portal are hosted by Stripe, and we rely on that design to keep our scope to SAQ A. Live card billing runs through Stripe Checkout and the Stripe customer portal.
- **HIPAA.** We make no claim of HIPAA compliance. GHXSTSHIP does not offer the Service as a covered entity or business associate service and does not sign business associate agreements.

## 2. Architecture

- **The database is the boundary.** Authorization, tenancy, state transitions and money rules are enforced inside Postgres with row-level security, constraints, triggers and stored procedures. Application code may repeat a check for usability, never instead of the database.
- **Tenant isolation.** Each row's organization is derived by the database, never accepted from the caller, and can never change. Cross-organization references are refused. The database test suite in CI checks that row-level security is on for every table and tries to read and write across tenants in each domain of the schema.
- **External access.** Vendors, crew, clients and other external parties read only through column-allowlisted views. Internal notes, margins, budget lines, other parties' rates and internal ratings are not exposed in them. Their access opens with an engagement and narrows and closes on a fixed schedule after it ends. Some people reach a limited page through a link and code a Customer issues, without an account, and those pages return only named fields.
- **Hosting.** Data lives in Supabase Postgres and Storage on Amazon Web Services in the United States. Hosting in the European Union is not offered. GHXSTSHIP sets it up only under a signed Enterprise contract it has accepted that names it, and the Subprocessor List names the EU region before any data is hosted there. The web applications run on Vercel. See the Subprocessor List.

## 3. Identity and Access

- Email and password, magic links and passkeys. Google and Apple sign-in where they are turned on for an app. SAML single sign-on and SCIM on the Enterprise plan.
- Our production setup turns on the hosted sign-in setting that checks new passwords against known breached-password lists.
- Multi-factor authentication with an authenticator app (TOTP), or a security key or passkey as a second factor. Anyone who has a second factor uses it after signing in to Atlas or Gateway, and anyone with an authenticator app uses it after signing in to Compass. Organizations can require it for Owners and Admins or for everyone; a member it applies to sets one up before opening the organization. Passkeys also sign in without a password.
- Ten single-use recovery codes per person, shown once and stored only as one-way hashes, for signing in or confirming an action without the usual second factor. Using one notifies the person; five wrong codes lock out further tries for 15 minutes.
- Step-up authentication (a second factor in the current session) for Restricted data exports, including the full organization export, SCIM tokens and break-glass. Changing a member's role, creating an API key, removing a second factor, changing passkeys, making recovery codes, letting an app use Restricted data, starting a paid plan, pausing a subscription, deleting an organization and transferring ownership need a second factor used in the last 15 minutes.
- Each person sees where they are signed in (device, approximate place, last activity) and can sign out any other session or all of them at once; Atlas, Gateway and the XOS API stop accepting a signed-out session at once.
- OAuth 2.1 apps an organization registers act for a person only after their consent, only in that organization and only in the capability groups they allowed, using authorization codes with PKCE (S256) and rotating refresh tokens. Revoking an app ends its access at once.
- Per-organization session lifetime and idle timeout: a session older than the organization allows signs in again before opening it, and in Atlas so does a session left idle longer than it allows. The session lifetime and the MFA requirement are enforced wherever Atlas, the XOS API and Compass check a session, and the idle timeout wherever Atlas does. None of them is enforced on direct calls to the underlying Supabase data endpoint; we plan to close that gap the same way as for IP allow-lists below.
- IP allow-lists. An org's IP allow-list is enforced wherever Atlas and the XOS API check a session or an API key. Compass does not check it. It is not yet enforced on direct calls to the underlying Supabase data endpoint (REST, Storage and Realtime) made with a valid session token, because only Atlas and the API see the caller's address. So a signed-in person outside the allowed networks who calls that endpoint directly can still read and write what their role allows. We plan to close this gap by routing all data access through the API.
- Role-based access with fine-grained capabilities, spend authority limits and separation of duties enforced in the database.
- "View as role" and "Why can I see this" make access transparent. A Customer can run an access review each quarter, which flags access left unreviewed.
- Break-glass access requires MFA and a written reason, notifies every Owner and Admin, applies only in the session that passed the second factor, and expires after one hour; its start, end or expiry is recorded in the audit ledger.

## 4. Data Protection

- TLS 1.2 or higher everywhere, with HSTS, including the preload directive, on Atlas, Gateway and the operator console.
- AES-256 encryption at rest.
- Field-level encryption for tax identifiers, bank account and routing numbers, passport numbers, supplier certificate numbers and medical treatment notes.
- Every column carries a classification: Public, Internal, Confidential or Restricted. Restricted values, such as allergies and pay rates, are masked unless the viewer holds the matching capability.
- Dietary and accessibility values, allergies and meal preferences are Restricted fields that cannot be selected directly, and every read is logged. Standard exports refuse them, and guest needs reach the people who may read them only through a logged read or download. These values are not encrypted at the field level: field-level encryption covers the identifiers and notes listed above.
- Data loss prevention by classification: export controls, expiring share links with access codes, and watermarks on Confidential and Restricted documents.
- Compass encrypts its offline database and supports biometric unlock that stays on the device. It deletes its offline records on sign-out and, after a remote sign-out, when the app next connects and learns of it, so a device that stays offline keeps them until then. Temporary photos and voice notes waiting to upload, and the shift details and queued punches that the clock widget and Live Activity use, are kept outside the encrypted database.
- AI features are off until an Admin turns them on. Stored fields classified Restricted and medical encounter records are removed from the record context sent to AI models. A document a person chooses to extract goes to the model whole, with whatever it prints, and a prompt goes as typed. We do not use Customer Data to train models. Our AI provider's commercial terms do not allow it to unless an account opts in to its Development Partner mode, and we do not opt in.

## 5. Application Security

- Strict Content Security Policy with nonces on Atlas, Gateway and the operator console, with same-site cookies and CSRF protection. The public documentation site, which holds no Customer Data, does not set this policy.
- SSRF protection on webhooks and imports.
- Uploads are MIME-sniffed, size-capped and, for SVG, sanitized. Active content is never served inline from public storage. These stores are virus-scanned: attachments, field media, onboarding uploads, imports, support screenshots, party uploads and credential photos, and profile and brand images, which are scanned in a staging store before they are published. Raw inbound email messages are not scanned: no screen serves them, and an attachment copied from one onto a document is scanned there. Scanning is set up to use ClamAV on a dedicated machine we run at Fly.io, reached only over mutual TLS. Files are sent there to be scanned, and its storage volume holds virus signatures, not uploads. Fly.io is on the Subprocessor List. A file stays quarantined until it scans clean, including when the scanner cannot be reached, and an infected file is deleted.
- Rate limits per IP, user, API key and token; repeated token failures lock the token.
- Webhooks are signed with HMAC-SHA256 and a timestamp.

## 6. Secure Development

- Changes normally reach the main branch through pull requests that run CI: static analysis (Semgrep, and CodeQL for JavaScript, TypeScript and Python, which also runs on main and every week), dependency audit, secret scanning, license checks, database security advisors and the test suite. Repository settings do not require that route or a passing run before merge. Our change policy also calls for approval by a maintainer other than the author and for signed commits. Neither is enforced by repository settings today, and approval by a second maintainer cannot be required while there is one maintainer. Review is currently by automated and AI-assisted checks and by the maintainer who merges the change.
- A dynamic scan (OWASP ZAP baseline) is set up to run nightly against staging. It skips when the job cannot reach staging, so it does not run on every night.
- CI actions are pinned by commit hash. Each release is built with a CycloneDX software bill of materials. Our release records are not public yet, so we provide the file on request.
- Dependencies are audited in CI and updated by hand. Automated update requests through Renovate are configured and not yet running.
- We have not yet completed an independent penetration test.

## 7. Reliability and Recovery

- 99.9 percent monthly availability target, with a public status page. Anonymous, read-only synthetic checks run about every 5 minutes from one US region against the Atlas and Gateway sign-in pages, the start of the API document, the API host and the documentation site. They do not sign in or read Customer Data. Realtime, Compass sync and notifications are not checked, and the page shows them as No data and Not checked yet.
- A row shows Outage only after the same check fails twice in a row, on runs at least 4 minutes apart, which is also when an alert goes out. A row shows Degraded on a single failed check or a slow answer. The page updates when a failure is confirmed or ends, and about once an hour once its deployment token is set, so its last checked time is usually within about an hour and can be older, because GitHub can delay or drop a scheduled run. A day in the history shows Outage when confirmed failures leave under 99 percent of that component's checks good. It shows Degraded on any shorter confirmed failure, or when more than 5 percent of its answers were slow or failed without confirmation. The uptime figure counts only confirmed failures, and the page says so. Incident notices on the page are published from a separate list that needs no code change.
- Daily backups kept for 7 days. A weekly encrypted logical backup, designed to be kept for 35 days in separate storage, is set up and has not yet completed a run. It lists stored files but does not contain them.
- Design objectives of a 1 hour recovery point and a 4 hour recovery time, which are not a promise that a given incident will be recovered within them. The 1 hour objective depends on point-in-time recovery with 7 days of history, a paid database add-on; daily backups alone give 24 hours. Restore drills have run on local copies of the database, and a drill against production is still to come.
- Our release runbook calls for staged rollouts of Atlas (5, 25, then 100 percent), with a person checking each stage against the error thresholds of a release gate command and able to abort to the previous deployment. The staged rollout setting is not yet turned on, and the gate does not act by itself. Every web application has instant rollback to its previous deployment, and risky features have kill switches.

## 8. Monitoring and Incident Response

- An append-only audit ledger, retained for 7 years, records security-relevant events in every organization. The change detail, IP address and user agent in each entry are redacted after 90 days. People with audit access read it in Settings.
- Error and performance monitoring is built into server code and Edge Functions, and reports once its production connection is set. Personal data is scrubbed from error reports and from XOS's own log lines before they leave the application, except a pseudonymous person ID. Platform logs from Vercel and, once its drain is set up, Supabase carry IP addresses and user IDs and go to our log service, which is on the Subprocessor List.
- Runbooks set out alert routing. One person is currently on call, so there is no 24-hour rotation. An alert needs a required check to fail twice in a row on runs at least 4 minutes apart, and a failed weekly backup also alerts. Alerts reach that person by email and, once the alert route is connected, the on-call channel. GHXSTSHIP is a small team, and one person currently holds the Security Lead and Privacy Officer roles.
- Our written incident response policy sets severity levels, roles and timelines. We notify affected Customers of a personal data breach without undue delay and within 48 hours of becoming aware of it. Where GHXSTSHIP is itself the controller, we notify people and authorities as the law requires.

## 9. People and Vendors

- Our written policies take effect when GHXSTSHIP approves them. They require personnel to sign confidentiality undertakings, to be screened where the law allows, and to complete security and privacy training at hire and every year.
- GHXSTSHIP staff open a Customer's data in the Service only during a support session granted by its Owner, which lasts at most 24 hours, is read-only and is logged to the Customer's audit ledger. Outside a session, we may access data only on the Customer's written instruction or a person's request to delete their own account, to run and verify backups and restores, to respond to an incident, or where the law compels it or to prevent imminent harm to people or to the Service. Section 5 of the Data Processing Agreement sets out these routes, the record we keep and when we tell the Customer. GHXSTSHIP's operator console also shows, for each open request in a Customer's data subject register, the organization, the kind of request and its dates, so that we can see when a clock is running. It does not show who asked or what they said. Automated processes such as scanning, notifications and backups handle data without a person viewing it. Our policy limits production infrastructure access to named people for a stated task, with logging.
- Our policy requires a review of every subprocessor before use and every year after. Section 7.4 of the Data Processing Agreement states the written terms we must have with each subprocessor.

## 10. Reporting a Vulnerability

See our Responsible Disclosure Policy. Security questions from Customers go to support@ghxstship.pro with "Security" in the subject line. Customers and prospective customers doing a security review can also ask that address for what exists today, under a confidentiality agreement: our OWASP ASVS matrix, threat model and policies, along with our data protection impact assessment template. We have no audit report or independent penetration test to share, as Sections 1 and 6 say.
