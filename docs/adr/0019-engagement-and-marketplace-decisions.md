# ADR 0019: Engagement and Marketplace Decisions

- Status: Accepted
- Date: 2026-10-14
- Decider: Orchestrator, on the A28 proposal (RRR-17)

## Context

A28 built the engagement contract, external identity, the opportunity marketplace, onboarding, ratings, threads and the `api_external` projections (migrations 0700 to 0750). Section 8.7 and the canon left several modeling choices open.

## Decision

1. **Counterparties.** An engagement's `counterparty` is a row in `app.counterparties`. An external account is the organization that counterparty points to.
2. **Engagement-Document states.** The canon defines no lifecycle for these documents. The states are Proposed, Sent, Signed, Executed, Expired, Superseded and Canceled. Only the party signs; the org countersigns to move a document to Executed, and an executed document is never edited.
3. **Rate resolution.** The rate in force is the first that exists of: the agreed rate, the org's rate card line effective on the start date, and the canon rate card. Rates are Restricted and masked.
4. **Section 8.7 areas and time box.** External access is granted by area: engagement, documents, onboarding, operational and money. Each area depends on the relationship and the engagement state, and access closes 18 months after Complete. A person's own tax forms and payments never close. An Account Member gets the engagement and operational areas; Account Finance gets engagement, documents and money.
5. **External reads.** Externals read only through owner-run `api_external` views that allowlist columns, never through `security_invoker` views. App-table read policies stay internal-only. The exception is tables with no internal columns: engagement documents, onboarding items, threads, applications and a bidder's own bids.
6. **Rating release.** Both ratings are released when the second one arrives, or 14 days after Complete, whichever comes first. Each release is recorded in `private.rating_releases`.
7. **Onboarding.** Requirements apply by role type and by the jurisdiction chain. Activation checks every requirement that applies, not just the items that exist. Items carry over within one org; carry-over is computed when read, not stored as copies.
8. **Tax identifiers.** Tax identifiers are encrypted with pgcrypto using the Vault secret `xos_tax_form_key`. Only the service role can decrypt them.
9. **Pay transparency** applies to Contractor, Crew and Staff postings.
10. **Person-owned rows.** `saved_searches` and `availability_calendars` carry a nullable `org_id`. A value marks a white-label scope, or a calendar kept for one org.
11. **Organization type.** `app.organizations.organization_type` defaults to For-Profit, because that is the most restrictive type.

## Open owner decisions

These are tracked in Linear under RRR-17.

- **Pay transparency rules:** the rules table is empty because the canon has no US-CO, US-CA, US-NY, US-WA or EU jurisdictions.
- **Spend authority before publishing:** this waits on the requisition table (RRR-71).
- **Client and Sponsor engagements:** should role code and worker classification stay NOT NULL for these engagements?
- **Distance search:** this needs venue coordinates.
- **Carry-over across orgs:** carrying person-owned items (certifications) across orgs with consent.
- **Exception list:** the A02 org_id check could list the person-owned tables as a stated exception.

_Amended 2026-10-23:_ none of these is open now. Pay transparency moved to ADR 0029 (item 5), and carry-over across orgs with consent was built in migration 1082. ADR 0033 settles the rest: spend authority applies at publish only for orgs with spend limits set (decision 61); Client and Sponsor engagements drop the workforce-only fields, distance search is ratified, and the person-owned tables are a stated exception (decision 69).

## Consequences

- Every Section 8.7 projection has pgTAP coverage. Each one is checked for access through the party's own engagement, an account engagement and a representation; for denial on another party's engagement and after the time box; and for leaking internal-only columns.
- Refusals use SQLSTATE XR001 with the codes listed in the migrations. A hidden listing and a Do Not Engage flag return the same refusal, so the flag is never revealed.
