---
title: Business Continuity and Disaster Recovery Policy
version: 1.0.0-draft
effective_date: The date this version is approved by the Owner
status: Draft before launch
audience: Internal
---

# Business Continuity and Disaster Recovery Policy

> **Draft before launch.** This internal policy is a draft. It takes effect when the Owner approves it, and its effective date is that date of approval.

## 1. Purpose and Scope

This policy makes sure GHXSTSHIP Industries LLC ("GHXSTSHIP") can keep XOS 4.0 running through disruption and recover it within stated objectives. It covers the production platform in every region, the data it holds, the delivery pipeline, and the people and vendors needed to operate it.

## 2. Objectives

| Measure                                           | Objective                                        |
| ------------------------------------------------- | ------------------------------------------------ |
| Recovery point objective (RPO)                    | 1 hour                                           |
| Recovery time objective (RTO)                     | 4 hours                                          |
| Monthly availability, Atlas and API               | 99.9 percent                                     |
| Compass field operations during a platform outage | Continue offline; queued writes sync on recovery |

## 3. Backups

- **Daily backups** of the production database are kept for 7 days.
- **Point-in-time recovery** with at least 7 days of history is called for on every production database. It is a paid add-on, and the 1 hour recovery point depends on it; daily backups alone give 24 hours.
- **Weekly logical backups** are written to storage separate from the primary provider account, encrypted, and kept for 5 weeks. The job is set up and has not yet completed a run.
- **File storage** is listed in the weekly backup, which does not contain the files themselves.
- **Region.** Backups of any EU tenant stay in the European Union; no EU tenant is hosted today.
- **Integrity.** Each backup job records a checksum and a success or failure that alerts on failure.
- **Expiry.** Backups expire on this schedule. Deleted data is therefore gone from all backups no later than 5 weeks after deletion from the live service, and within 7 days while only daily backups run.

## 4. Restore Drills

A restore drill script restores the latest backup to an isolated environment, runs integrity checks and a smoke test, and records the achieved RPO and RTO. It is called for every quarter and after any change to the backup design. Drills have run on local copies of the database, and a drill against production is still to come. A failed drill is a SEV2 incident.

## 5. Resilience by Design

- **Offline-first field app.** Compass keeps working without a connection. Writes queue with idempotency keys and sync in order when service returns.
- **Progressive delivery.** This policy calls for Atlas releases to go to 5, 25 and then 100 percent, each stage approved only when error rates hold, and to roll back when they regress. The staged rollout setting is not yet turned on. Every web application can return at once to its previous deployment. Risky features ship behind flags with kill switches.
- **Expand and contract migrations.** No release breaks the version before it, so rollback is always possible.
- **Connection pooling and read replicas** isolate reporting load from transactions.
- **Monitoring.** Anonymous, read-only synthetic checks run about every 5 minutes from one US region against the Atlas and Gateway sign-in pages, the API and the documentation site. Realtime, Compass sync and notifications are not checked yet.
- **Error budget.** When a month's error budget is spent, feature releases pause until reliability work restores it.

## 6. Disaster Scenarios

| Scenario                                         | Response                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database corruption or destructive change        | Point-in-time restore to just before the event, then replay verified writes                                                                                                                                                     |
| Loss of the primary database region              | Restore the latest backup into another region of the same jurisdiction, repoint the applications, and communicate through the status page                                                                                       |
| Hosting provider outage for the web applications | Status page and banner; Compass continues offline; redeploy to a secondary region when the provider allows                                                                                                                      |
| Loss of a subprocessor (email, SMS, push, AI)    | Degrade the affected feature, queue messages for retry, and inform Customers                                                                                                                                                    |
| Compromise of the delivery pipeline              | Freeze releases, rotate credentials, rebuild from a verified commit, and follow the Incident Response Policy                                                                                                                    |
| Loss of key personnel                            | Documented runbooks, a backup reader for the support@ghxstship.pro inbox, once the Owner names one, who can acknowledge and reach the Owner, and break-glass credentials held in the password manager under the Owner's control |

## 7. Roles

The Owner declares a disaster. The Security Lead coordinates recovery under the Incident Response Policy. The person on call runs the runbooks. While GHXSTSHIP has one person, that person holds every role.

## 8. Testing and Review

Beyond the quarterly restore drill, a full disaster recovery exercise runs once a year. This policy is reviewed after each exercise and at least once a year.
