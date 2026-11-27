# Support channels

The support channels GHXSTSHIP offers for XOS, with the plan each one comes with and its hours. The marketing site (`ghxstship/atlas-marketing`) and its directory listings cite this file; `design/MARKETING_LOCKSTEP.md` names it as a product fact, so a change here is a lockstep change.

This file states nothing of its own. Every row restates a sentence of a legal document that is in effect, or what the product does, and the last section quotes each source. `infra/ci/test/support-channels.test.ts` holds the quotes and the plan table to their files, so the Service Level Agreement cannot change without this file changing with it. Where the two ever differ, the Service Level Agreement governs.

## Channels

| Channel                                                             | How to reach it                                          | Plans                                                        | Hours                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| Help center                                                         | The Help articles in the apps and at docs.ghxstship.tech | Every plan. It is the only platform channel on Access        | Published articles; no staffed hours            |
| Email                                                               | support@ghxstship.pro with "Support" in the subject line | Core, Pro and Team                                           | Business hours                                  |
| Email, priority queue                                               | support@ghxstship.pro with "Support" in the subject line | Team                                                         | Business hours                                  |
| Contact support in the app                                          | Help, Contact support, sent to the platform support team | Core, Pro, Team and Enterprise, for an organization's admins | Business hours                                  |
| Dedicated channel, named contact and phone for severity 1 incidents | As the Order names them                                  | Enterprise, only where an Order names them                   | Business hours, unless the Order says otherwise |
| Account and billing email                                           | sos@ghxstship.pro                                        | Every plan                                                   | No hours stated                                 |

Business hours are 9:00 a.m. to 5:00 p.m. New York time, Monday to Friday, except US federal holidays.

Contact support in the app also has a queue that every member of every organization can use: it sends the request to the organization's own admins, not to GHXSTSHIP.

## First response targets by plan

The Service Level Agreement, section 6, sets a target for a first response on each plan. A target is for a first response, not for a fix.

| Plan       | Channels                                                                                | First response target                                  |
| ---------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Access     | Help center                                                                             | Best effort                                            |
| Core       | Email                                                                                   | 2 business days                                        |
| Pro        | Email                                                                                   | 1 business day                                         |
| Team       | Email, priority queue                                                                   | 8 business hours                                       |
| Enterprise | Dedicated channel, named contact and phone for severity 1 incidents, as the Order names | 1 hour for severity 1; 8 business hours for all others |

The Enterprise severity 1 target counts every hour of the day and every day of the week only if the Order says so. Otherwise it counts business hours.

## Not offered

- A community forum and live chat with support are not offered (ADR 0033, decision 73).
- Telephone support is not offered outside an Enterprise Order that names a phone line.
- Support on nights, weekends and US federal holidays is not offered outside an Order that says who provides it.

## What the repository does not record

These are the owner's facts. This file leaves them out instead of guessing them.

- Hours and a response target for sos@ghxstship.pro, the account and billing address.
- The Enterprise channel, named contact and severity 1 phone line. Each is set per Order and kept by hand (`legal/OWNER_INPUTS.md`, Part A, item 26).
- The languages support answers in. The legal documents state a language only for legal notices, which are in English.

## Sources

Each sentence below is quoted exactly from the file named beside it.

| File                                                          | Sentence                                                                                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legal/service-level-agreement.md`                            | Business hours are 9:00 a.m. to 5:00 p.m. New York time, and business days are Monday to Friday, except US federal holidays, in New York time.                                      |
| `legal/service-level-agreement.md`                            | We offer a dedicated channel, a named contact and a phone line only where an Order names them.                                                                                      |
| `legal/service-level-agreement.md`                            | an Order commits us to cover on nights and weekends only if it says who provides it.                                                                                                |
| `legal/service-level-agreement.md`                            | These are targets for a first response, not for a fix.                                                                                                                              |
| `legal/service-level-agreement.md`                            | The severity 1 target counts every hour of the day and every day of the week only if the Order says so. Otherwise it counts business hours                                          |
| `legal/service-level-agreement.md`                            | Questions about a person's own account can go to sos@ghxstship.pro on any plan, and technical questions about the apps to support@ghxstship.pro with "Support" in the subject line. |
| `legal/terms-of-service.md`                                   | support through the help center                                                                                                                                                     |
| `legal/terms-of-service.md`                                   | adds custom roles, IP allow-list, audit export, payroll export, priority support                                                                                                    |
| `legal/contact.md`                                            | **sos@ghxstship.pro** is for your account and billing: plans, invoices, cancellations, refunds and service credits.                                                                 |
| `docs/adr/0033-owner-decisions-2026-10-19.md`                 | a community forum with in-app support chat, and a SOC 2 evidence store are deferred past 4.0                                                                                        |
| `supabase/migrations/1592_support_channels_without_forum.sql` | Only org admins contact platform support; ask your admins through Contact Support.                                                                                                  |
| `supabase/migrations/1592_support_channels_without_forum.sql` | The Access plan includes the help center; upgrade to contact platform support.                                                                                                      |
| `packages/i18n/messages/en-US/help.json`                      | Your request goes to your organization's admins, who answer in the request.                                                                                                         |
