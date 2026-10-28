---
title: Switching providers
summary: Move your organization to another provider or your own deployment, with the full export, 30 days of transition support, and no switching charges from 12 January 2027.
section: operate
order: 14
---

You can move your organization from XOS to another provider, or to your own deployment of XOS, at any time. Section 11.3 of the Terms of Service sets out what GHXSTSHIP does when you switch, as the EU Data Act requires: export all exportable data and metadata in the structured formats documented here, give 30 days of transition support on request, and, from 12 January 2027, charge no switching fees. This guide is the process; the Terms are the binding text.

## What you get

- **Your data and metadata**, in the [full export](guide:full-export): every table of your organization as JSON and CSV, the stored files and a manifest, described column by column in the [data dictionary](dictionary:).
- **30 days of transition support**, on request: help reading the export, mapping its tables to the new system, and getting anything the archive could not hold, such as stored files over its size limit.
- **No switching charges from 12 January 2027.** From that date GHXSTSHIP charges no switching fees, for the export, the transition support or anything else switching needs. Your subscription is separate: its cancellation follows Section 11.1 of the Terms.

## Switch

1. **Ask for transition support.** The Owner or an Admin contacts the platform team from **Settings, Help and support** in Atlas, or writes to the support mailbox listed on the contact page published with the Terms. Say that you are switching providers and the day you want the 30 days to start. The platform team never sees your organization's data unless the Owner grants a support session.
2. **Take a full export to test with.** The Owner downloads it from **Settings, Danger zone** (see [Full export](guide:full-export)). Load it into the new system and check the counts against `manifest.json`.
3. **Move the work.** Keep using XOS until the new system is ready. For a deployment of your own, the [self-hosting guide](guide:self-hosting) covers the setup, and the export's tables have the same names and columns as those of a deployment of the same XOS version.
4. **Take the final export** on the day you stop using XOS, so it holds everything up to that day.
5. **Cancel.** The Owner cancels in **Settings, Danger zone**. The organization stays read-only for 30 days with the full export available, and the Owner can reactivate it within that time. On day 90 GHXSTSHIP deletes its data from the live service and sends the Owner a deletion certificate.

Records the law requires you to keep, such as payroll and tax records, are deleted on day 90 with everything else, so keep them from your export.

## Other ways to read your data

While you switch, these keep working beside the export:

- The public API at `/api/v1` reads and writes your records one at a time or in pages ([API reference](reference:projects)).
- On the Enterprise plan, [warehouse delivery](guide:warehouse-delivery) copies your data into your own bucket every night.
