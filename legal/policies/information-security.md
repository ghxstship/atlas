---
title: Information Security Policy
version: 1.0.0-draft
effective_date: The date this version is approved by the Owner
status: Draft for review by counsel before launch
audience: Internal
---

# Information Security Policy

> **Draft for review by counsel before launch.** This internal policy is a draft. It takes effect when the Owner approves it, and its effective date is that date of approval.

## 1. Purpose

This policy sets the direction and rules for protecting the confidentiality, integrity, availability and privacy of information at GHXSTSHIP Industries LLC ("GHXSTSHIP"), including the XOS 4.0 platform and the Customer Data it holds. It is the top-level policy of our information security management system (ISMS) and the anchor for our SOC 2 and ISO/IEC 27001:2022 programs.

## 2. Scope

This policy applies to:

- all GHXSTSHIP personnel: employees, contractors, and AI coding agents operating under GHXSTSHIP's direction
- all information GHXSTSHIP creates, receives or holds, in any form
- all systems that store or process that information: the XOS production, staging and development environments, the source repository and CI, company devices, and the subprocessors on the Subprocessor List

## 3. Roles and Responsibilities

| Role            | Responsibility                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner           | Accountable for the ISMS. Approves policies, accepts risk, allocates resources, and reviews the program at least once a year. The Owner is Julian Clarkson.       |
| Security Lead   | Designated in writing by the Owner. Runs the ISMS day to day: risk register, control monitoring, incident response, vendor reviews, training and audit readiness. |
| Privacy Officer | Designated in writing by the Owner. Owns records of processing, DSAR handling, DPIAs and privacy notices. May be the same person as the Security Lead.            |
| Maintainers     | Apply secure development and change management rules to the paths they own, and review pull requests.                                                             |
| All personnel   | Follow the policies, complete training, protect credentials and devices, and report events immediately.                                                           |

## 4. Policy Statements

4.1 **Risk-based.** GHXSTSHIP maintains a risk register. Each risk records the asset, threat, likelihood, impact, owner, treatment and residual risk. The Security Lead reviews it every quarter and after any significant change or incident. Residual risks above the Owner's stated appetite need the Owner's written acceptance.

4.2 **Controls.** GHXSTSHIP selects controls from ISO/IEC 27001:2022 Annex A, maps them to the SOC 2 Trust Services Criteria, and records the selection and justification in the Statement of Applicability (`legal/security/iso27001-soa.md`) and the control matrix (`legal/security/soc2-controls.md`).

4.3 **Supporting policies.** These policies implement this one and carry equal authority: Access Control, Encryption, Vendor Management, Incident Response, Business Continuity and Disaster Recovery, Secure Development, Data Classification, Acceptable Use, and Change Management.

4.4 **Security by design.** Security rules are enforced in the database (row-level security, constraints, triggers and stored procedures) and verified by automated tests in CI. Application code may repeat a check for usability, never replace it.

4.5 **Least privilege and need to know.** Access is granted by role and capability, time-boxed, reviewed quarterly, and removed promptly when no longer needed.

4.6 **Customer Data access.** Personnel never view Customer Data in the Service without a support session granted by the Customer's Owner. Support sessions expire within 24 hours and every action is logged to the Customer's audit ledger.

4.7 **Personnel security.** Personnel sign confidentiality undertakings before access, are screened where the law allows and in proportion to their access, complete security and privacy awareness training at hire and every year, and have access removed on the day they leave.

4.8 **Asset management.** GHXSTSHIP keeps an inventory of systems, repositories, cloud accounts, domains, devices and data stores, each with an owner and a classification.

4.9 **Logging and monitoring.** Security-relevant events are logged to append-only stores, monitored, and alerted to an on-call rotation with runbooks.

4.10 **Compliance.** GHXSTSHIP identifies the legal, regulatory and contractual requirements that apply to it, records them in the compliance matrix (`legal/compliance-matrix.md`), and tracks each to an artifact and a test.

4.11 **Physical security.** Production systems run in the facilities of our infrastructure subprocessors, whose physical controls are verified through their independent audit reports. Company devices follow the endpoint rules in the Acceptable Use Policy.

## 5. Objectives

- Zero cross-tenant data exposure, verified by tenant isolation tests on every table in every build.
- Zero open findings rated High or Critical at each release.
- 99.9 percent monthly availability for Atlas and the API.
- Customer notice of a personal data breach within 48 hours of awareness.
- 100 percent of personnel trained within 30 days of hire and every year.

The Security Lead reports progress against these objectives to the Owner every quarter.

## 6. Exceptions

An exception to any security policy must be requested in writing, state the risk and compensating controls, have an expiry no later than 12 months, and be approved by the Security Lead and, for High risk, by the Owner. Exceptions are recorded in the risk register.

## 7. Enforcement

Violations may lead to removal of access and to disciplinary action up to termination of employment or contract, and may be reported to authorities where the law requires.

## 8. Review

This policy and every supporting policy are reviewed at least once a year, after a major incident, and after a significant change to the platform or the law. The Owner approves each new version, and every version is kept in the repository history.
