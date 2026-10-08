---
title: Service Level Agreement
version: 1.0.0-draft
effective_date: The date this version is published at /legal
status: Draft for review by counsel before launch
---

# Service Level Agreement

> **Draft for review by counsel before launch.** This document is a draft. It is not in effect and no one may rely on it. It takes effect only when GHXSTSHIP Industries LLC publishes it at /legal, and its effective date is that date of publication.

This Service Level Agreement ("SLA") forms part of the Terms of Service between GHXSTSHIP Industries LLC ("GHXSTSHIP") and the Customer. It sets the availability target for XOS 4.0, the service credits available on the Enterprise plan, and the support response targets for every plan.

## 1. Availability Target

GHXSTSHIP targets **99.9 percent Monthly Uptime** for Atlas, Gateway and the public API in the Customer's region.

## 2. Definitions

- **Monthly Uptime** is the total minutes in a calendar month minus Downtime minutes, divided by the total minutes in that month, expressed as a percentage.
- **Downtime** is a period of at least one minute in which the synthetic checks run from at least two of our five monitoring regions fail for sign-in or an API read in the Customer's region, or in which the API returns server errors for more than 5 percent of valid requests. Downtime is measured by our synthetic monitoring, which checks every minute, and shown on the public status page.
- **Covered Services** are Atlas, Gateway and the public API at `/api/v1`. Compass depends on these services. Its offline operation and queued writes are designed to continue during Downtime, and Compass sync is not separately measured.
- **Service Credit** is a percentage of the monthly subscription fee for the affected organization, applied to a future invoice.

## 3. Service Credits

Service Credits apply to Customers on the Enterprise plan.

| Monthly Uptime                               | Service Credit |
| -------------------------------------------- | -------------- |
| Below 99.9 percent, at or above 99.0 percent | 10 percent     |
| Below 99.0 percent, at or above 95.0 percent | 25 percent     |
| Below 95.0 percent                           | 50 percent     |

- To receive a Service Credit, the Owner or an Admin must request it through Contact Support within 30 days after the end of the affected month, with the dates and times of the Downtime.
- Service Credits for a month may not exceed 50 percent of that month's fee for the affected organization.
- Service Credits are the Customer's sole and exclusive financial remedy for failure to meet the availability target. They do not limit the Customer's right to terminate for material breach under the Terms of Service if Monthly Uptime is below 99.0 percent in three consecutive months.
- Service Credits have no cash value and are forfeited if the Customer's account is terminated for non-payment.

## 4. Exclusions

Downtime does not include unavailability caused by:

- scheduled maintenance announced at least 72 hours in advance through the in-app banner and the status page, limited to 4 hours per month
- emergency maintenance to address a critical security vulnerability, where we give as much notice as we can
- factors outside our reasonable control, including internet failures beyond our network, and force majeure events
- the Customer's own systems, integrations, custom domains or DNS, identity provider, or network
- actions or configurations by the Customer or its users, including IP allow-lists and rate limits reached by their own traffic
- suspension under the Terms of Service or the Acceptable Use Policy
- features labeled Beta, and the Access plan's free service

## 5. Status and Incident Communication

- A public status page shows each component (Atlas, API, Realtime, Sync, Notifications) per region.
- During an incident we post updates on the status page and in an in-app banner linked to it at least every 60 minutes until it is resolved.
- For incidents that cause Downtime, we publish a post-incident report within 5 business days.

## 6. Support Response Targets

| Plan       | Channels                                                         | First response target |
| ---------- | ---------------------------------------------------------------- | --------------------- |
| Access     | Help center and community forum                                  | Best effort           |
| Core       | Email                                                            | 2 business days       |
| Pro        | Email and in-app chat                                            | 1 business day        |
| Team       | Email and in-app chat, priority queue                            | 8 business hours      |
| Enterprise | Dedicated channel, named contact, phone for severity 1 incidents | 1 hour for severity 1 |

**Severity levels**

| Severity | Meaning                                                                                      |
| -------- | -------------------------------------------------------------------------------------------- |
| 1        | The Service is unavailable or a core workflow is unusable for many users, with no workaround |
| 2        | A core workflow is degraded or unusable for some users, or a workaround is burdensome        |
| 3        | A feature does not work as documented and a reasonable workaround exists                     |
| 4        | A question, cosmetic issue or feature request                                                |

Business hours and business days follow the time zone on the Customer's billing account, Monday to Friday, excluding public holidays in that jurisdiction. Support never views Customer Data without a support session granted by the Owner.

## 7. Recovery Objectives

GHXSTSHIP designs the Service to a 1 hour recovery point objective and a 4 hour recovery time objective, verified by restore drills. These are design objectives, not service credit commitments.

## 8. Changes

We may update this SLA under the change rules in the Terms of Service. A change will not reduce the availability target or the credit schedule during a paid Enterprise term.
