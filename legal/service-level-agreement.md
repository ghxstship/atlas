---
title: Service Level Agreement
version: 1.0.0-draft
effective_date: The date GHXSTSHIP states when it makes this version final
status: Draft before launch
---

# Service Level Agreement

> **Draft before launch.** This document is a draft. It is not in effect and no one may rely on it. Showing it at /legal does not put it in effect. It takes effect only on the effective date that GHXSTSHIP Industries LLC states at the top of a final version.

This Service Level Agreement ("SLA") forms part of the Terms of Service between GHXSTSHIP Industries LLC ("GHXSTSHIP") and the Customer. It sets the availability target for XOS 4.0, the service credits available on the Enterprise plan, and the support response targets for every plan.

## 1. Availability Target

GHXSTSHIP targets **99.9 percent Monthly Uptime** for Atlas, Gateway and the public API. This is a target. The remedy for missing it is the Service Credit in Section 3, on the Enterprise plan.

## 2. Definitions

- **Monthly Uptime** is the total minutes in a calendar month minus Downtime minutes, divided by the total minutes in that month, expressed as a percentage.
- **Downtime** is either of these. (a) A period in which one of our synthetic checks of a Covered Service fails and the same check fails again on a later run that starts at least 4 minutes after it. Downtime then runs from the first of those failed checks to the next passing run of that check. A single failed check followed by a pass is not Downtime from a check. The checks that run see the Atlas and Gateway sign-in pages, the start of the API document and the API host's answer to an unauthenticated request. (b) A period of at least 5 minutes in a row in which our server logs show server errors for more than 5 percent of valid API requests.
- **Measurement.** The Security Overview states which synthetic checks are running and how often. They run about every 5 minutes from one US region, so Downtime from a check can be measured only as finely as that. For any part of a month in which the checks were not running, we measure Downtime from our server logs and any evidence the Customer gives us. The public status page shows the status of each component and when it was last checked.
- **Covered Services** are Atlas, Gateway and the public API at `/api/v1`. Compass depends on these services. Its offline operation and queued writes are designed to continue during Downtime, and Compass sync is not separately measured. Nothing else is a Covered Service, including AI features, notifications, webhooks, realtime features, integrations and the documentation site. This SLA sets no latency, delivery or timing target for any feature, including live cue and show-calling features.
- **Service Credit** is a percentage of the monthly subscription fee for the affected organization, applied to a future invoice or paid as Section 3 states. For a fee billed annually, the monthly fee is one twelfth of the annual fee.

## 3. Service Credits

Service Credits apply to Customers on the Enterprise plan.

| Monthly Uptime                               | Service Credit |
| -------------------------------------------- | -------------- |
| Below 99.9 percent, at or above 99.0 percent | 10 percent     |
| Below 99.0 percent, at or above 95.0 percent | 25 percent     |
| Below 95.0 percent                           | 50 percent     |

- To receive a Service Credit, the Owner or an Admin must request it through Contact Support or the support mailbox listed on our contact page at /legal/contact within 30 days after the end of the affected month, with the dates and times it believes were affected, as far as it knows them. We check the request against our records and tell the Customer the result. On request we give the Customer the Monthly Uptime figure and the check results and log extracts we relied on, with other customers' data removed.
- Service Credits for a month may not exceed 50 percent of that month's fee for the affected organization.
- Service Credits are the Customer's sole and exclusive financial remedy for failure to meet the availability target, as Section 13.6 of the Terms of Service also states.
- Monthly Uptime below 99.0 percent in three consecutive months is a material breach that cannot be cured. The Customer may terminate the affected subscription by notice, with no cure period, and receives the refund of prepaid fees for the remaining term that Section 11.6 of the Terms of Service gives. Section 11.10 of those Terms says what happens to the data.
- A Service Credit is not paid in cash while the subscription continues. If the subscription ends with an unused Service Credit and no further invoice to apply it to, we pay it to the Customer. A Service Credit is forfeited if the Customer's account is terminated for non-payment.

## 4. Exclusions

Downtime does not include unavailability caused by:

- scheduled maintenance announced at least 72 hours in advance through the in-app banner and the status page, limited to 4 hours per month
- emergency maintenance to address a critical security vulnerability, where we give as much notice as we can
- factors outside our reasonable control, including internet failures beyond our network, and force majeure events. An outage at a provider on the Subprocessor List that hosts or runs a Covered Service is not, by itself, outside our control, and counts as Downtime
- the Customer's own systems, integrations, custom domains or DNS, identity provider, or network
- actions or configurations by the Customer or its users, including IP allow-lists and rate limits reached by their own traffic
- suspension under the Terms of Service or the Acceptable Use Policy, or read-only status under the Terms of Service
- features labeled Beta, and the Access plan's free service

Scheduled maintenance can fall on a show date. A Customer cannot block it on named dates unless its Order says so.

## 5. Status and Incident Communication

- A public status page shows each component: Atlas, Gateway, API, Documentation, Realtime, Sync and Notifications. Documentation is shown there but is not a Covered Service. The page shows when each component was last checked, and a component with no check shows No data and Not checked yet.
- A component shows Outage after two failed checks in a row at least 4 minutes apart, and Degraded after one failed check or a slow answer. The uptime figure on the page counts only confirmed failures.
- During an incident we aim to post updates on the status page and in an in-app banner linked to it at least every 60 minutes until it is resolved.
- For incidents that cause Downtime, we aim to publish a post-incident report within 5 business days.

The 60 minute and 5 business day figures are targets.

## 6. Support Response Targets

| Plan       | Channels                                                                                | First response target                                  |
| ---------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Access     | Help center                                                                             | Best effort                                            |
| Core       | Email                                                                                   | 2 business days                                        |
| Pro        | Email                                                                                   | 1 business day                                         |
| Team       | Email, priority queue                                                                   | 8 business hours                                       |
| Enterprise | Dedicated channel, named contact and phone for severity 1 incidents, as the Order names | 1 hour for severity 1; 8 business hours for all others |

We offer a dedicated channel, a named contact and a phone line only where an Order names them. GHXSTSHIP is a small team, and an Order commits us to cover on nights and weekends only if it says who provides it.

These are targets for a first response, not for a fix. The severity 1 target counts every hour of the day and every day of the week only if the Order says so. Otherwise it counts business hours, so a Customer that needs cover on nights and weekends for its shows should have that written into its Order. Questions about a person's own account can go to the support mailbox on any plan.

**Severity levels**

| Severity | Meaning                                                                                      |
| -------- | -------------------------------------------------------------------------------------------- |
| 1        | The Service is unavailable or a core workflow is unusable for many users, with no workaround |
| 2        | A core workflow is degraded or unusable for some users, or a workaround is burdensome        |
| 3        | A feature does not work as documented and a reasonable workaround exists                     |
| 4        | A question, cosmetic issue or feature request                                                |

Business hours are 9:00 a.m. to 5:00 p.m. New York time, and business days are Monday to Friday, except US federal holidays, in New York time. Support views Customer Data only during a support session granted by the Owner, apart from the cases Section 8.7 of the Terms of Service lists.

## 7. Recovery Objectives

GHXSTSHIP designs the Service to a 1 hour recovery point objective and a 4 hour recovery time objective. The 1 hour objective depends on point-in-time recovery being active on the production database; daily backups alone give 24 hours. We test backups with restore drills. The Security Overview states where those drills have run. These are design objectives, not service credit commitments, and not a promise that a given incident will be recovered within them.

## 8. Changes

We may update this SLA under the change rules in the Terms of Service. A change will not reduce the availability target or the credit schedule during a paid Enterprise term.
