---
title: Data Retention and Deletion Policy
version: 1.0.0-draft
effective_date: The date this version is published at /legal
status: Draft for review by counsel before launch
---

# Data Retention and Deletion Policy

> **Draft for review by counsel before launch.** This document is a draft. It is not in effect and no one may rely on it. It takes effect only when GHXSTSHIP Industries LLC publishes it at /legal, and its effective date is that date of publication.

This policy states how long XOS 4.0 keeps data, how deletion works, and how Customers control retention for the data they own. GHXSTSHIP Industries LLC ("GHXSTSHIP") applies it as processor for Customer Data and as controller for its own records.

## 1. Principles

- **Purpose-bound.** Data is kept only as long as its purpose, a legal obligation, or a Customer instruction requires.
- **Enforced by the database.** Every table has a retention policy recorded in `retention_policies`. A scheduled purge job (pg_cron) enforces each policy. Retention is never left to manual cleanup.
- **Legal hold wins.** A legal hold flag on a record, project or organization suspends every purge that would touch it until the hold is lifted. Placing and lifting holds is logged.
- **Customer control.** Within the limits below, Customers set retention for their own records in Settings, Data and Privacy. A Customer setting can lengthen a default. It can shorten one only where no legal minimum applies.

## 2. Retention Schedule

| Data                                                     | Default retention                                                                                                                                        | Basis                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Customer records (projects, records, budgets, documents) | For the life of the subscription, until the Customer deletes them                                                                                        | Contract                                  |
| Records in Trash                                         | Restorable for the retention period shown for that record kind in Settings, Data and Privacy, then purged                                                | Customer setting                          |
| Audit ledger (`audit_events`)                            | 7 years, append-only. Personal data in audit text is redacted at 90 days at every depth of the stored data                                               | Security, accountability and legal claims |
| Activity feed (`activity_events`)                        | 18 months                                                                                                                                                | Product function                          |
| Payroll, timesheets and pay records                      | Per jurisdiction; United States default 7 years                                                                                                          | Wage and hour and tax law                 |
| Tax forms (W-9, W-8BEN, W-8BEN-E) and 1099-NEC data      | 7 years after the last tax year they support                                                                                                             | Tax law                                   |
| Invoices, purchase orders, payments and the ledger       | 7 years after the fiscal year they belong to, or longer where the Customer's jurisdiction requires                                                       | Accounting and tax law                    |
| Background check results and references                  | For the engagement plus the period the Customer's jurisdiction requires; the report itself is never stored                                               | FCRA and state law                        |
| Medical encounter records                                | As the Customer's jurisdiction and policy require; default 7 years                                                                                       | Legal claims and health record law        |
| Incident and OSHA records                                | At least 5 years after the end of the calendar year they cover (US)                                                                                      | OSHA recordkeeping                        |
| Signed agreements and signature audit certificates       | For the life of the agreement plus 7 years                                                                                                               | Evidence of contract                      |
| External party access to an engagement                   | Opens at Active, narrows to Money and Documents at Complete, closes 18 months after Complete except the person's own tax documents and payments          | Data minimization                         |
| Applications not selected                                | 2 years after the opportunity closes, unless the applicant asks for earlier deletion and no legal minimum applies                                        | Discrimination claims limitation periods  |
| Equal employment voluntary data                          | Stored apart from applications; kept only as the Customer's reporting obligation requires                                                                | Equal employment reporting                |
| Messages and chat                                        | As set by the Customer in Settings, Communication; default for the life of the subscription                                                              | Customer setting                          |
| Compass device data                                      | Until synced and then as cached for offline use; wiped on sign-out or remote sign-out                                                                    | Product function                          |
| Photos' location metadata                                | Stripped at capture unless the Customer turns retention on                                                                                               | Data minimization                         |
| AI prompts and outputs log                               | Under the audit retention rules, with personal data redacted                                                                                             | Accountability                            |
| Import batches                                           | Undo available for 7 days; batch records kept with the audit ledger                                                                                      | Product function                          |
| Notification and webhook delivery logs                   | 90 days                                                                                                                                                  | Troubleshooting                           |
| Consent records, cookie consent and SMS consent events   | For as long as the consent is relied on plus 7 years                                                                                                     | Proof of consent (GDPR, TCPA, ePrivacy)   |
| DSAR records                                             | 7 years after the request is closed                                                                                                                      | Accountability                            |
| Document acceptance log                                  | For the life of the account plus 7 years                                                                                                                 | Evidence of contract                      |
| Error reports and traces                                 | 90 days                                                                                                                                                  | Troubleshooting                           |
| Support tickets and attached diagnostics                 | 3 years after closure; diagnostics 90 days                                                                                                               | Support quality                           |
| Customer billing records (GHXSTSHIP as controller)       | 7 years after the fiscal year they belong to                                                                                                             | Tax law                                   |
| Marketing contacts                                       | Until unsubscribe or 2 years without engagement; suppression list kept to honor opt-outs                                                                 | Consent or legitimate interests           |
| Backups                                                  | Point-in-time recovery history of at least 7 days; weekly logical backups expire on the schedule in the Business Continuity and Disaster Recovery Policy | Resilience                                |

Where a jurisdiction requires a longer period than this schedule, the longer period applies to records in that jurisdiction.

## 3. Deletion Events

**Record deletion.** Deleting a record moves it to Trash. It can be restored until its retention period ends, then it is purged with its files.

**Account deletion by a person.** A person can delete their account in Compass (Profile, Settings, Delete Account), in Gateway, or from the public page at /legal/account-deletion. Their profile, sign-in and personal settings are deleted. Each organization they worked with keeps the records it must retain by law, such as timesheets, payments and tax documents. Their name in those records remains so the records stay accurate.

**Organization cancellation.** The organization becomes read-only for 30 days, with a full export available. At day 90 its data is deleted from the live service, backups age out on their schedule, and the Owner receives a deletion certificate.

**Organization deletion.** The Owner deletes with step-up authentication and by typing the organization name. A 7-day recovery window applies, then deletion proceeds as for cancellation.

**Data subject erasure.** A Customer handles erasure requests through the DSAR workflow, which deletes or anonymizes the person's data across tables while honoring legal holds and legal minimums, and records the outcome.

## 4. Deletion Methods

- Database rows are deleted, or anonymized where a record must remain for integrity, such as a ledger entry.
- Files are deleted from Storage with their versions.
- Field-level encrypted values become unrecoverable when deleted.
- Backups are not edited. Deleted data expires from backups on their schedule, and is not restored to the live service except as part of a full disaster recovery, after which deletions are re-applied.
- A deletion certificate records the organization, what was deleted, when, and the backup expiry date.

## 5. Review

GHXSTSHIP reviews this schedule at least once a year and when a law changes. Changes are published at /legal with version history.
