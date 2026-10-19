# ADR 0034: Pricing v4: Seat-Based Plans, Extra Seats, Add-Ons and Grandfathering

- Status: Accepted (carries out ADR 0033 decision 18; amends ADR 0018 and ADR 0020)
- Date: 2026-10-19
- Decider: Owner (prices approved 2026-10-19); engineering choices by A58 (RRR-103)

## Context

ADR 0033 decision 18 asked the owner to set the prices of every plan and the annual discount before the Stripe products are created. Until now, `packages/schemas/plans.yaml` carried the ATLVS catalogue v3: USD only, unlimited seats on every paid plan, and no add-ons or offers (ADR 0018). The owner approved the v4 pricing on 2026-10-19. It needs things the plan registry could not express:

- a seat allowance with extra seats above it
- a plan sold by quote only
- local-currency price books
- a one-time add-on
- a promotion with a redemption cap
- a default wholesale discount

## Decision

### 1. Prices and limits

| Plan       | Monthly (USD)                       | Annual (USD) | Seats     | Extra seat a month | Engagements a month | Aurora requests a month |
| ---------- | ----------------------------------- | ------------ | --------- | ------------------ | ------------------- | ----------------------- |
| Access     | 0                                   | 0            | 1         | not sold           | 25                  | 0                       |
| Core       | 149                                 | 1,490        | 5         | 19                 | 250                 | 500                     |
| Pro        | 399                                 | 3,990        | 15        | 19                 | 2,500               | 2,000                   |
| Team       | 899                                 | 8,990        | 40        | 15                 | unlimited           | 10,000                  |
| Enterprise | quoted, from 2,500, annual contract | quoted       | unlimited | not sold           | unlimited           | unlimited               |

- **Annual billing:** two months free. `annual_multiplier: 10`, and the validator holds every annual price, plan or seat, to ten times monthly.
- **Unlimited on paid plans:** active projects and field crew. Access keeps 1 project and 10 field members.
- **Features:** each plan keeps its features (ADR 0020).
- **Local prices:** Core, Pro and Team are priced in EUR, GBP, CAD and AUD, monthly:
  - Core: 139, 119, 199 and 229.
  - Pro: 369, 319, 549 and 609.
  - Team: 829, 719, 1,229 and 1,369.
- **Local extra seats:** 18, 15, 26 and 29 on Core and Pro; 14, 12, 21 and 23 on Team.
- **Enterprise list prices:** null in every currency. Wholesale statements count an Enterprise client as unpriced, never as zero.

### 2. Add-ons and offers

- **Aurora request pack:** 1,000 requests for USD 49 (EUR 45, GBP 39, CAD 67, AUD 75).
  - A one-time purchase that raises `aurora_requests_per_month` for the UTC calendar month it is paid in.
  - Sold to Core, Pro and Team.
  - A purchase is always recorded. It raises the allowance only while the org is on a plan that lists the pack, so a downgrade to Access never turns a paid pack into requests Access cannot use.
- **Founding customer:** 30 percent off the first year.
  - Stripe coupon `xos_founding_customer_v4`: repeating, 12 months, 50 redemptions, on the plan and extra-seat products.
  - Promotion code `FOUNDING30`: 50 redemptions, first-time customers only.
  - Checkout accepts promotion codes.
- **Partner wholesale:** 30 percent off list.
  - `partner_wholesale_discount_bps: 3000` in plans.yaml.
  - The generated plan seed sets it as the default of `app.partner_agreements.wholesale_discount_bps`, so the partner console's discount field matches plans.yaml.
  - Existing agreements keep the discount they were signed at.

### 3. Registry, generator and Stripe

- **Registry:** `plans.yaml` gains `annual_multiplier`, `extra_seat_product_lookup_key`, `partner_wholesale_discount_bps`, `addons` and `offers`. Each plan gains `extra_seat` (a price book and two Stripe lookup keys) and an optional `quote`.
- **Validator rules:**
  - A seat-limited self-serve plan must sell extra seats.
  - A plan with unlimited seats, the free plan or a quoted plan cannot sell extra seats.
  - A quoted plan has null list prices and no Stripe prices.
  - Add-ons and offers name only self-serve plans.
  - Every lookup key, coupon id and promotion code is unique.
- **Stripe lookup keys (v4):**
  - Plans: `xos_plan_<plan>_v4` for the product, `xos_plan_<plan>_monthly_v4` and `xos_plan_<plan>_annual_v4` for the prices.
  - Extra seats: one product, `xos_extra_seat_v4`, with prices `xos_seat_<plan>_monthly_v4` and `xos_seat_<plan>_annual_v4`. An annual subscription carries the annual seat price, because Stripe requires every item of a subscription to share its interval.
  - Aurora pack: product `xos_addon_aurora_requests_1000_v4`, price `xos_addon_aurora_requests_1000_once_v4`.
  - Each price is in USD, with every other priced currency as a Stripe currency option.
  - The v3 `atlvs_*` catalogue stays in Stripe as history; the webhook ignores its prices.
- **Generated seed:** the plan seed is now `1251_plan_seed.sql`. Besides plans, limits and features, it writes the database mirrors of plans.yaml:
  - `private.plan_list_prices`, which wholesale billing reads.
  - `private.plan_extra_seat_prices`.
  - `private.plan_addons`.
  - The partner discount default.
- **Mirror test:** the Atlas mirror test reads the plan seed instead of 1060.
- **Seed numbering:** the next change to plans.yaml moves the seed to the next free number of the agent making it (ADR 0018, decision 3).
- **Setup script:** `pnpm --filter @xos/platform stripe:setup` creates the catalogue in Stripe test mode.
  - It is idempotent: products use their lookup key as their id, prices are found by lookup key, coupons by id and promotion codes by code.
  - It refuses live mode keys.
  - It stops before writing when Stripe differs from plans.yaml, because prices and coupons cannot change. The fix is a new versioned lookup key in plans.yaml, never an edit in Stripe.

### 4. Seat enforcement

- **Seats counted:** active members whose best role is above Field (`private.membership_band_counts`, unchanged). Viewers and Field crew never take a seat.
- **Limit in force:** `private.org_plan_limits` gives the plan allowance plus `app.subscriptions.extra_seats`. Extra seats are the Stripe quantity of the plan's extra-seat price, which `app.sync_subscription_from_stripe` now carries (new parameter `p_extra_seats`, default 0) and which nobody else can write: callers have only select on `app.subscriptions`.
- **Refusals:** a role assignment that needs a seat beyond the limit refuses (SQLSTATE XR001) with:
  - `seat_limit_reached` when the plan sells extra seats: "All N seats are in use. Buy extra seats in Billing and Plan, or upgrade the plan."
  - `seat_limit_upgrade` when it does not (Access): "Upgrade the plan to add seats."
  - Atlas shows the matching en-US and es-US copy in Members settings, on join requests and invite links, and to an invitee whose invitation hits the limit.
- **Buying seats:** Checkout takes `extraSeats`, and `setExtraSeats` changes the quantity on a live subscription, prorated. The webhook syncs the new quantity, which raises the limit.
- **Seat usage:** `app.seat_usage` reports usage, limit, allowance, extra seats, whether the plan sells extra seats, and grandfathering to members. Billing and Plan shows it.

### 5. Grandfathering

- **Who keeps unlimited seats:** every paid subscription that is live when migration 1250 runs (`seats_grandfathered = true`). It keeps unlimited seats until its plan changes or it ends; a trigger clears the flag then.
- **Price:** grandfathering covers seats only. The price a grandfathered org pays stays its v3 Stripe price until it changes plan, because Stripe subscriptions keep their price until changed.
- **New subscriptions and plan changes:** they get the v4 limits.
- **Seed and demo orgs:** they are created after the migrations run, so they are not grandfathered, and they fit the v4 limits.
  - The demo productions org has 5 seats on Team (40).
  - Each other demo org with a subscription has 1 or 2 seats on Team.
  - The orgs without a subscription are on Access with at most 1 seat.
- **Recommendation:** grandfather every existing paying org. No org has paid through Stripe yet: Checkout is not connected in Atlas, and the hosted project holds only the demo tenant. If any org has paid before 1250 reaches production, the flag keeps it whole.

## Consequences

- **Database:** migrations 1250 and 1251, with pgTAP 1250 and 1251. pgTAP 0204 now expects a seat refusal of `seat_limit_upgrade` and a Team allowance of 40, and pgTAP 1060 expects the v4 Core list price.
- **API:** `subscriptions` gains the read-only `extra_seats` and `seats_grandfathered` (correction `subscription-extra-seats`).
- **Gaps:** Atlas still has no Checkout route. On Billing and Plan, choosing a plan, buying extra seats, buying a pack and Talk to sales stay disabled. The API and data paths exist: `createCheckoutSession` with `extraSeats`, `setExtraSeats`, `createAddonCheckoutSession`, the webhook, and the 1250 RPCs. Connecting them is the billing UI follow-up.
- **Not changed:**
  - Section 5.3 of the Terms of Service names engagement limits but not seat allowances, and still says field members are metered. Counsel reviews the legal pages under ADR 0033 decision 23.
  - Wholesale statements price client orgs at plan list price only. Extra seats bought by client orgs are not on the statement yet.
- **Owner action:** run `stripe:setup` against the Stripe sandbox once the test mode secret from ADR 0033 decision 19 is set. The steps are in `infra/runbooks/production.md`, Stripe catalogue.
