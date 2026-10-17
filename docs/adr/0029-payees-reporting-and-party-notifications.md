# ADR 0029: Individual Payees, Reporting Delivery and Party Notifications

- Status: Accepted
- Date: 2026-10-17
- Decider: Orchestrator

## Context

A43 closed the finance and reporting gaps (A38-004, 006, 007). A44 closed the Gateway and notification gaps (A38-001, 002, 003, 005), and added Gateway account deletion and the Compass Clock In shortcut.

## Decision

1. **Individual payees.** An invoice or payment names exactly one of `counterparty_id` and `payee_person_id`, enforced by a CHECK constraint.
   - A person is a payee only on a Payable invoice that carries an `engagement_id`.
   - A payment to a person takes its org from the caller, and that org must engage the person individually.
2. **Gateway invoice steps are derived, not stored.** The stored invoice states are unchanged. Gateway shows these steps:
   - **Submitted:** the invoice is issued.
   - **Approved:** the invoice is approved.
   - **Scheduled:** a payment is applied but a balance remains.
   - **Paid:** approved payments bring the balance to zero.

   Notifications (`invoice.submitted`, `.approved`, `.scheduled`, `.paid`) follow the same steps. They reach the payee person for an individual, or the billing account's Owner, Admin and Finance members (1131, 1190).

3. **XOS records payments and never moves money.** `PayoutProvider` is a port, and only `ManualPayout` ships. The payout provider is an owner decision.
4. **1099-NEC.** The export covers approved USD payments in the calendar year of 60,000 minor units or more, to payees with an Independent Contractor engagement.
   - The output is CSV in IRS FIRE B record order.
   - The full TIN comes only from a Restricted export with step-up, never from the API.
5. **Pay transparency.**
   - Rules are keyed by jurisdiction code, and a rule covers its descendants by code prefix. The latest rule in force wins.
   - A remote posting is covered by its country's rules that apply to remote work. `is_remote` is fixed once a posting is published.
   - The seeded list carries `needs_counsel_review` until counsel confirms it.
6. **Report delivery.** Report runs render CSV, XLSX (exceljs) and PDF (pdfkit), with the renderers loaded lazily in the shared Edge bundle.
   - A scheduled delivery runs once per recipient, with that member's own access.
   - Mail goes through ReportMailer: Mailpit for local hosts only, and Resend inside an allow-list in production.
7. **External party notifications.** People who work with an org through an engagement or account membership get notifications through `private.notify`. Their channel choices live in a person-level table.
8. **Profile section sharing.** A shared section is the owner's consent. It overrides that section's visibility, but only for the org it was shared with. Explore lists organizations as a view of Explore.
9. **Clock In App Shortcut.** It is a `LiveActivityIntent` on the same App Group queue as the Live Activity punches (ADR 0028).
10. **Sitemap additions (amends ADR 0006).**
    - Gateway's Crew and Staff tab sets include `engagement.invoices` after `engagement.timesheets`.
    - Atlas adds `finance.year-end` and `reports.dashboards`.

## Consequences

- **Owner and counsel:** confirm the pay-transparency list. Canon also needs the US states below Florida before on-site postings in those states are covered.
- **Production report email:** needs `XOS_EMAIL_TRANSPORT=resend` and an allow-list.
- **Shortcut tile and Siri:** they need a signed build with the owner's Apple team to test on a device.
