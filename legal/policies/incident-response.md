---
title: Incident Response Policy
version: 1.0.0-draft
effective_date: The date this version is approved by the Owner
status: Draft for review by counsel before launch
audience: Internal
---

# Incident Response Policy

> **Draft for review by counsel before launch.** This internal policy is a draft. It takes effect when the Owner approves it, and its effective date is that date of approval.

## 1. Purpose and Scope

This policy sets how GHXSTSHIP Industries LLC ("GHXSTSHIP") detects, responds to, communicates about and learns from security and availability incidents affecting XOS 4.0, including personal data breaches. The operational runbooks that carry it out live with the reliability infrastructure and are linked from every alert.

## 2. Definitions

- **Event:** any observable occurrence that may affect security or availability.
- **Incident:** an event that compromises, or is reasonably likely to compromise, the confidentiality, integrity or availability of systems or data, or that breaks a security policy.
- **Personal data breach:** an incident that leads to accidental or unlawful destruction, loss, alteration, unauthorized disclosure of, or access to, personal data.

## 3. Severity

| Severity | Description                                                                                                     | Response start      |
| -------- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| SEV1     | Confirmed cross-tenant exposure or breach of Restricted data; Atlas, Gateway or the API unavailable in a region | Immediately, 24x7   |
| SEV2     | Suspected breach; major feature unavailable; security control failure with no evidence of exploitation          | Within 1 hour, 24x7 |
| SEV3     | Limited degradation; vulnerability requiring a fix with no active exploitation                                  | Next business day   |
| SEV4     | Minor issue with no customer impact                                                                             | Scheduled           |

## 4. Roles

- **Incident Commander:** the on-call engineer until the Security Lead or a delegate takes over. Owns decisions and the timeline.
- **Communications Lead:** drafts status page updates, in-app banners and customer notices.
- **Privacy Officer:** assesses whether personal data is involved and leads regulatory and customer breach notification.
- **Owner:** informed of every SEV1 and SEV2, and approves external statements about a personal data breach.

## 5. Process

1. **Detect and report.** Anyone who notices an event reports it immediately through the on-call channel. Alerts from monitoring, synthetic checks, error tracking, secret scanning, database advisors and researcher reports open an incident automatically or by the on-call engineer.
2. **Triage.** The Incident Commander assigns a severity, opens an incident record with a timeline, and assembles the responders.
3. **Contain.** Stop the harm first: revoke credentials, disable a feature with its kill switch, roll back a release, block traffic, or isolate a tenant's integration. Preserve evidence before changing systems where it is safe to do so.
4. **Investigate.** Establish scope from the audit ledger, access logs, file access log and provider logs: which tenants, records and people are affected, and how.
5. **Eradicate and recover.** Fix the root cause, restore from backups if needed under the Business Continuity and Disaster Recovery Policy, and verify with tests.
6. **Communicate.** As in Section 6.
7. **Learn.** Hold a blameless post-incident review within 5 business days for SEV1 and SEV2. Record causes, what worked, and actions with owners and dates. Track actions to completion.

## 6. Communication and Notification

- **Status page and banner.** For incidents affecting availability, post within 30 minutes of declaring SEV1 or SEV2, and update at least every 60 minutes until resolved.
- **Customers.** Notify affected Customers of a personal data breach without undue delay and within 48 hours of becoming aware of it, with the information in Section 9 of the Data Processing Agreement. Follow up as facts become known.
- **Regulators.** Where GHXSTSHIP is controller, notify the competent supervisory authority within 72 hours of awareness under the GDPR and UK GDPR, and meet the deadlines of other regimes, including the India DPDP Act, Singapore PDPA, POPIA, PIPA, PIPEDA, Quebec Law 25, Swiss nFADP, Australian Privacy Act and US state breach laws. Where GHXSTSHIP is processor, support the Customer's notifications.
- **Individuals.** Where GHXSTSHIP is controller and the law requires, notify affected individuals in plain language.
- **Post-incident report.** Publish one within 5 business days for incidents that caused Downtime under the Service Level Agreement.
- **Law enforcement.** Engage only with the Owner's approval and after legal advice.

## 7. Evidence

Incident records, timelines, logs and decisions are kept for 7 years. Evidence is collected in a way that preserves its integrity, with a record of who collected it and when.

## 8. Testing

The incident response plan is exercised at least once a year with a tabletop exercise covering a personal data breach and a regional outage. Findings update this policy and the runbooks.

## 9. Review

This policy is reviewed at least once a year and after every SEV1.
