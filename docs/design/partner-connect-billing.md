# Design note: partner-to-client billing through Stripe Connect

- Status: Proposed, for the owner's decision (finding A65-026)
- Date: 2026-10-20
- Author: A79 (RRR-124)

## What the spec asks

Section 4.6.1: "The platform bills the partner at wholesale. The partner bills its clients through Stripe Connect
(Standard accounts) at prices the partner sets." The platform-to-partner side is decided and built: Stripe Billing
invoices from wholesale statements (ADR 0033 decision 21, migration 1060). Partner prices for each client are
recorded (`app.partner_client_prices`), but nothing charges a client.

## Proposal

1. **Account.** Each partner connects its own Stripe account as a Standard connected account through Stripe's
   hosted onboarding (account links). The partner owns the account, its dashboard, payouts, disputes and tax
   registrations; XOS stores only the connected account id on a new `app.partner_connect_accounts` row (one per
   partner org), written by the webhook when `account.updated` reports `charges_enabled`.
2. **Charging clients.** XOS creates the client's subscription on the partner's account (the `Stripe-Account`
   header), using a product and price the partner's account owns at the amount in `app.partner_client_prices`.
   The client's card is collected by Checkout in the partner's name. The platform takes no application fee: its
   revenue is the wholesale statement it already bills the partner.
3. **State in XOS.** Connect webhooks (`customer.subscription.*` from connected accounts, which carry `account`)
   go through the existing ingestion (`app.record_stripe_event`) and a new sync that moves the client's
   subscription through the same transition engine. Dunning (0560) applies unchanged: the client becomes
   read-only on day 21, never deleted.
4. **Leaving.** `app.leave_partner` (1354) already moves billing to the client as a 14-day trial of its plan. With
   Connect, it also cancels the client's subscription on the partner's account at the end of the paid period.
5. **Credentials.** The platform's own Stripe secret key acts on connected accounts; no partner key is ever stored.
   Connect needs the platform account's Connect settings (branding, the Standard account type) set once by the
   owner.

## Open decisions for the owner

- Whether partners may bill clients at all in the first release, or only the platform bills clients directly.
- Whether XOS takes an application fee on top of wholesale billing.
- Which countries partners may onboard from (Standard accounts follow Stripe's country support).

## Not in scope here

Building any of this: no migration, client or webhook handler exists for Connect, and the A79 build leaves
`app.partner_client_prices` as a record of the partner's prices only.
