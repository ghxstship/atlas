---
title: SOC 2 Control Matrix
version: 1.0.0-draft
effective_date: The date this version is approved by the Owner
status: Draft for review by counsel before launch
audience: Internal; shared with auditors under confidentiality
---

# SOC 2 Control Matrix

> **Draft for review by counsel before launch.** This control matrix is a draft. It takes effect when the Owner approves it, and its effective date is that date of approval. GHXSTSHIP Industries LLC has not yet undergone a SOC 2 examination.

This matrix maps the AICPA 2017 Trust Services Criteria (with the 2022 revised points of focus) for **Security, Availability, Confidentiality and Privacy** to XOS 4.0 controls. It is the basis for SOC 2 Type II readiness (Section 14.2). Criteria are named by reference number with a short topic in our own words; the criteria text is not reproduced.

**Columns.** _Control_ is the XOS control ID and what it does. _Evidence hook_ is the automated source an auditor or the evidence collector reads, so evidence is produced by the system rather than gathered by hand. _Owner_ is the build agent that implements it. _State_ is Drafted (the governing policy exists in `legal/`) or Planned with the build wave in which the control and its evidence hook land.

## Evidence Automation

Evidence hooks write to a single evidence store so that a Type II period can be sampled without manual collection:

- **CI evidence:** every pull request's checks (format, finish guard, lint, typecheck, unit, pgTAP, contract, CodeQL, Semgrep, secret scan, license check, database advisors) are exported as signed JSON artifacts per run.
- **Database evidence:** `audit_events`, `access_scans`, access review results, support sessions, break-glass events, retention purge runs and DSAR records are queryable by period.
- **Operational evidence:** status page history, synthetic check results, restore drill reports, incident records and post-incident reviews.
- **People and vendor evidence:** training completion, policy acknowledgments, access reviews of internal systems, and the vendor register.

A26 builds the evidence store in Wave 5; each owning agent emits to it.

## Common Criteria (Security)

| Criterion | Topic                                               | Control                                                                                         | Evidence hook                                  | Owner             | State            |
| --------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------- | ---------------- |
| CC1.1     | Integrity and ethical values                        | CTL-01 Code of conduct and personnel acceptable use acknowledged at hire and yearly             | Acknowledgment records                         | A21               | Drafted          |
| CC1.2     | Oversight by those charged with governance          | CTL-02 Owner reviews the ISMS, risk register and objectives quarterly                           | Signed quarterly review record                 | A21               | Drafted          |
| CC1.3     | Structure, authority and responsibility             | CTL-03 Roles defined in the Information Security Policy and GOVERNANCE.md                       | Policy version history                         | A21               | Drafted          |
| CC1.4     | Competence                                          | CTL-04 Security, privacy and secure coding training at hire and yearly                          | Training completion export                     | A21               | Drafted          |
| CC1.5     | Accountability                                      | CTL-05 Policy enforcement and disciplinary clause; objectives tracked                           | Quarterly objective report                     | A21               | Drafted          |
| CC2.1     | Quality information for internal control            | CTL-06 Compliance matrix tracks every requirement to artifact and test                          | `legal/compliance-matrix.md` history           | A21               | Drafted          |
| CC2.2     | Internal communication                              | CTL-07 Policies published in the repository; changes announced to personnel                     | Repository history, acknowledgment records     | A21               | Drafted          |
| CC2.3     | External communication                              | CTL-08 Legal documents at /legal with versions; status page; security.txt; subprocessor notices | Published version log, notice log              | A21, A26          | Planned (Wave 2) |
| CC3.1     | Objectives for risk assessment                      | CTL-09 Security objectives in the Information Security Policy                                   | Policy history                                 | A21               | Drafted          |
| CC3.2     | Risk identification and analysis                    | CTL-10 Risk register reviewed quarterly                                                         | Register snapshots                             | A21               | Drafted          |
| CC3.3     | Fraud risk                                          | CTL-11 Separation of duties and spend authority enforced in SQL                                 | pgTAP results for Section 8.1 and 8.2 rules    | A02, A03          | Planned (Wave 2) |
| CC3.4     | Changes that affect controls                        | CTL-12 ADR process for contract changes; risk review on significant change                      | ADR log                                        | Orchestrator      | Drafted          |
| CC4.1     | Ongoing and separate evaluations                    | CTL-13 CI quality gates on every change; independent review in Wave 6                           | CI artifacts, review reports                   | A22, A23, A24     | Planned (Wave 6) |
| CC4.2     | Communicating deficiencies                          | CTL-14 Findings filed as issues with severity and owner; fix targets by severity                | Issue tracker export                           | A22               | Planned (Wave 6) |
| CC5.1     | Control activities to mitigate risk                 | CTL-15 Control selection in the Statement of Applicability                                      | `legal/security/iso27001-soa.md`               | A21               | Drafted          |
| CC5.2     | Technology general controls                         | CTL-16 Database as the boundary: RLS, constraints, triggers and RPCs                            | pgTAP suite results                            | A02, A03          | Planned (Wave 2) |
| CC5.3     | Policies and procedures                             | CTL-17 Ten security policies approved by the Owner                                              | Policy history                                 | A21               | Drafted          |
| CC6.1     | Logical access security                             | CTL-18 RLS on every table, capabilities, field masking, encryption                              | pgTAP RLS and masking tests, database advisors | A02               | Planned (Wave 2) |
| CC6.2     | User registration and authorization                 | CTL-19 Invitations, memberships with validity dates, SCIM                                       | `audit_events` membership changes              | A02, A30          | Planned (Wave 2) |
| CC6.3     | Role-based access and changes                       | CTL-20 Quarterly access reviews with flagging after 14 days; internal system reviews            | Access review records                          | A02, A21          | Planned (Wave 2) |
| CC6.4     | Physical access                                     | CTL-21 Inherited from infrastructure subprocessors                                              | Subprocessor SOC 2 reports in vendor register  | A21               | Drafted          |
| CC6.5     | Disposal of assets and data                         | CTL-22 Retention purge, deletion certificates, device wipe                                      | Purge run logs, certificates                   | A18               | Planned (Wave 2) |
| CC6.6     | Protection against external threats                 | CTL-23 TLS, HSTS, CSP, rate limits, IP allow-lists, SSRF resolver                               | ZAP baseline, header tests                     | A06, A18          | Planned (Wave 2) |
| CC6.7     | Restricting data transmission and movement          | CTL-24 DLP rules by class, external projections, signed webhooks                                | Export and share-link audit events             | A18, A28          | Planned (Wave 2) |
| CC6.8     | Unauthorized and malicious software                 | CTL-25 Upload virus scanning; dependency and secret scanning; pinned actions                    | Scan logs, CI artifacts                        | A18, Orchestrator | Planned (Wave 2) |
| CC7.1     | Detecting configuration changes and vulnerabilities | CTL-26 Database advisors, CodeQL, Semgrep, dependency audit, Renovate                           | CI artifacts                                   | Orchestrator, A22 | Planned (Wave 2) |
| CC7.2     | Monitoring for anomalies                            | CTL-27 Synthetic checks, Sentry, alerts to on-call                                              | Alert history                                  | A26               | Planned (Wave 5) |
| CC7.3     | Evaluating security events                          | CTL-28 Severity triage in the Incident Response Policy                                          | Incident records                               | A21               | Drafted          |
| CC7.4     | Responding to incidents                             | CTL-29 Incident response with 48-hour customer breach notice                                    | Incident records, notice log                   | A21, A26          | Drafted          |
| CC7.5     | Recovering from incidents                           | CTL-30 Post-incident review and recovery under BCDR policy                                      | Post-incident reports                          | A21, A26          | Drafted          |
| CC8.1     | Change management                                   | CTL-31 Reviewed pull requests, signed commits, CI gates, progressive rollout                    | Pull request and deployment logs               | Orchestrator, A26 | Planned (Wave 5) |
| CC9.1     | Business disruption risk mitigation                 | CTL-32 BCDR policy with RPO 1 hour, RTO 4 hours                                                 | Restore drill reports                          | A26               | Planned (Wave 5) |
| CC9.2     | Vendor and business partner risk                    | CTL-33 Vendor reviews before onboarding and yearly; DPA flow-down                               | Vendor register                                | A21               | Drafted          |

## Availability

| Criterion | Topic                                                          | Control                                                                | Evidence hook                           | Owner    | State            |
| --------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------- | -------- | ---------------- |
| A1.1      | Capacity management                                            | CTL-34 Load targets, partitioning, pooling, RLS benchmark under 50 ms  | k6 and benchmark results                | A24, A26 | Planned (Wave 5) |
| A1.2      | Environmental protections, backups and recovery infrastructure | CTL-35 PITR 7 days minimum, weekly logical backups to separate storage | Backup job logs                         | A26      | Planned (Wave 5) |
| A1.3      | Recovery testing                                               | CTL-36 Quarterly restore drill and yearly DR exercise                  | Drill reports with achieved RPO and RTO | A26      | Planned (Wave 5) |

## Confidentiality

| Criterion | Topic                                                | Control                                                                | Evidence hook                 | Owner    | State            |
| --------- | ---------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------- | -------- | ---------------- |
| C1.1      | Identifying and maintaining confidential information | CTL-37 Column classification registry; field-level encryption; masking | Registry coverage check in CI | A02, A21 | Planned (Wave 2) |
| C1.2      | Disposal of confidential information                 | CTL-38 Retention schedule, purge jobs, deletion certificates           | Purge run logs                | A18, A21 | Drafted          |

## Privacy

| Criterion | Topic                                                 | Control                                                                                                | Evidence hook                                                    | Owner    | State            |
| --------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | -------- | ---------------- |
| P1.1      | Notice of privacy practices                           | CTL-39 Privacy Policy, Cookie Policy, AI Features Notice, Worker Terms, notice at collection           | Published version log                                            | A21      | Drafted          |
| P2.1      | Choice and consent                                    | CTL-40 Consent banner with prior blocking, GPC, SMS consent, consent log stored server-side            | `consent_records`, `cookie_consent_events`, `sms_consent_events` | A18, A21 | Planned (Wave 2) |
| P3.1      | Collection limited to purpose                         | CTL-41 Data minimization: city-level location, EXIF stripping, no protected attributes in applications | Schema review, pgTAP                                             | A03, A28 | Planned (Wave 2) |
| P3.2      | Explicit consent for sensitive data                   | CTL-42 Separate consent for supplier diversity data and voluntary equal employment data                | Consent records                                                  | A28      | Planned (Wave 3) |
| P4.1      | Use limited to purpose                                | CTL-43 Lawful basis registry per processing activity                                                   | Registry export                                                  | A18, A21 | Planned (Wave 2) |
| P4.2      | Retention                                             | CTL-44 Retention policies per table, legal hold                                                        | `retention_policies`, purge logs                                 | A18      | Planned (Wave 2) |
| P4.3      | Disposal                                              | CTL-45 Deletion at day 90 after cancellation with certificate                                          | Deletion certificates                                            | A18      | Planned (Wave 2) |
| P5.1      | Access by data subjects                               | CTL-46 DSAR workflow with 30-day clock                                                                 | `dsar_requests`                                                  | A18, A21 | Planned (Wave 2) |
| P5.2      | Correction by data subjects                           | CTL-47 Profile self-service and DSAR rectification                                                     | `dsar_requests`, audit events                                    | A30, A18 | Planned (Wave 3) |
| P6.1      | Disclosure to third parties with consent or authority | CTL-48 Consent to share profile fields per application                                                 | Consent snapshots                                                | A28      | Planned (Wave 3) |
| P6.2      | Record of authorized disclosures                      | CTL-49 Audit ledger of exports, shares and support sessions                                            | `audit_events`, `file_access_log`                                | A02, A18 | Planned (Wave 2) |
| P6.3      | Record of unauthorized disclosures                    | CTL-50 Breach register in incident records                                                             | Incident records                                                 | A21      | Drafted          |
| P6.4      | Third-party privacy commitments                       | CTL-51 Subprocessor DPAs and annual review                                                             | Vendor register                                                  | A21      | Drafted          |
| P6.5      | Third-party breach notification to the entity         | CTL-52 Subprocessor contracts require prompt breach notice                                             | Vendor register                                                  | A21      | Drafted          |
| P6.6      | Breach notification to affected parties               | CTL-53 Customer notice within 48 hours; regulator and individual notice per regime                     | Notice log                                                       | A21      | Drafted          |
| P6.7      | Accounting of disclosures to data subjects            | CTL-54 DSAR access output includes disclosures and recipients                                          | DSAR output samples                                              | A18      | Planned (Wave 2) |
| P7.1      | Data quality                                          | CTL-55 Provenance and assertion ranks on records; correction workflow                                  | Provenance columns, pgTAP                                        | A03      | Planned (Wave 2) |
| P8.1      | Inquiries, complaints and disputes                    | CTL-56 Privacy mailbox, appeal process, regulator referral                                             | Ticket records                                                   | A21, A31 | Planned (Wave 3) |

## Summary

| State            | Controls |
| ---------------- | -------- |
| Drafted          | 23       |
| Planned (Wave 2) | 21       |
| Planned (Wave 3) | 4        |
| Planned (Wave 5) | 6        |
| Planned (Wave 6) | 2        |
| Total            | 56       |
