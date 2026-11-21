# ADR 0035: Pricing v4: Seat-Based Plans, Extra Seats, Add-Ons and Grandfathering

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

## Amendment (2026-10-23): Checkout and the customer portal (ADR 0033 decision 59)

XOS launches on the 14-day trial and the Access plan, and billing opens once Checkout is built. This closes the first gap above for plans; extra seats, Aurora packs and Talk to sales stay as they were.

- **Who and when:** the database decides before Stripe is called (migration 1640). `app.begin_billing_checkout` asks for `org.billing.manage` (the Owner), a live org that is not a sandbox, not billed by its partner and not read-only for deletion or cancellation, a plan with a USD list price above zero (never Access or Enterprise), and no paid Stripe subscription in the key's mode; then a second factor in the last 15 minutes. `app.billing_portal_customer` asks for the same capability and step-up. The checks come before step-up, so nobody passes a second factor only to be refused; for that reason Atlas's billing actions do not call `requireSecondFactor` first, as ADR 0055 decision 13 expected, and the database's `step_up_required` opens the step-up dialog instead.
- **One open checkout per org:** `app.billing_checkouts` records each session Atlas opens. A new checkout first expires the org's open sessions in Stripe, and refuses when one of them was paid meanwhile, so two browser tabs never buy two subscriptions. Recording the new session closes any other open one of the same mode, which Atlas expires too; a session the Stripe account does not have counts as gone. The webhook marks each session Completed or Expired; Completed wins. Stripe does not order its events, so a completed checkout can arrive before its subscription: until the subscription syncs, for up to three days (Stripe's retry window), another checkout is refused with `checkout_completed` and Billing and Plan says Stripe is confirming.
- **The plan still follows the subscription:** the checkout record never changes the plan. `customer.subscription.*` events, through `app.sync_subscription_from_stripe`, remain the one path to `app.subscriptions`. A running trial carries over as the Stripe trial end, so the card is charged when the trial would have ended and the trial converts at once.
- **Where Checkout is offered (migration 904100201):** `app.billing_account` also returns the rule that refuses every plan's Checkout for the org now (`private.billing_checkout_refusal`, the same checks `app.begin_billing_checkout` raises before step-up). Billing and Plan offers Choose and Add a card only where Checkout opens; a client org its partner bills, a sandbox and an org read-only for deletion or cancellation see the reason instead. `app.record_billing_checkout` refuses a session already recorded for another org, plan, term or mode (`checkout_session_taken`) instead of treating it as a repeat.
- **Back from Checkout:** a Checkout that carried the trial over saves the card and charges nothing until the trial ends, so it returns to `?checkout=trial` and the page says the card is saved. `?checkout=done` and "Payment received" are for a Checkout that charged.
- **Prices:** Checkout resolves each price by its lookup key in `plans.yaml` at runtime. Atlas reads the validated registry from `lib/billing/plan-registry.generated.ts`, written by `generate:routes`; no price id is stored.
- **Customer portal:** an org that pays changes its plan, card and billing details, gets invoices and cancels at the end of the paid period in the portal. `stripe:setup` creates its configuration from `plans.yaml` (switching between the Core, Pro and Team prices, prorated), marked so Atlas finds it.
- **Until the key is set:** Atlas reads `STRIPE_SECRET_KEY` from its server environment. Without it, Billing and Plan says billing is not open yet and the actions answer `billing_not_open`. `STRIPE_API_URL` points Atlas at a local fake of Stripe for the end-to-end journey; it is honored only on a loopback origin with a test mode key.
- **Webhook:** `stripe-webhook` also handles `checkout.session.expired` and records completed plan checkouts. It loads the Stripe SDK only once a request carries a signature, within the Edge boot budgets.
- **Tests:** pgTAP 1640, including the order of the checks, and 904100201 for the refusal Billing and Plan reads; unit tests of Checkout, the portal and the webhook with a fake Stripe client and webhook secrets generated per run; `apps/atlas/test/billing-checkout.test.ts` for the actions and Billing and Plan with and without the key; `apps/atlas/e2e/billing-checkout.spec.ts` pays on a local fake of Stripe, whose ids carry a token for each run so engines, retries and reruns on one database never collide, and fails in CI if billing is closed there.
- **Owner steps:** Stripe Tax on in the sandbox, `stripe:setup`, the webhook endpoint and the staging secrets, then the live catalogue and keys when billing opens (`infra/runbooks/production.md`, Stripe catalogue and billing).

## Amendment (2026-11-15): plans.yaml states what is offered and what is on sale

The marketing site reads `plans.yaml` at a release tag and may not decide a product fact itself (`design/MARKETING_LOCKSTEP.md`). The registry said what each plan entitles an organization to and what each purchase costs, and nothing said which of those a price list may show. Enterprise listed a branded Compass build that the Terms of Service say is not offered, and extra seats and the Aurora request pack carried prices although nobody can buy them (ghxstship/atlas issues 108 and 116).

- **One section:** `plans.yaml` gains `offering`. It gives every feature a status: `offered`, `not_offered`, or `territory` with the `private.territories` code the feature is offered in (ADR 0160). It gives extra seats and every add-on a status: `on_sale` or `not_on_sale`. A comment block at the top of the section defines each status, so the YAML reads on its own.
- **What it decides:** what a price list shows, and nothing else. Entitlements stay in `plans[].features` and `private.plan_features`, prices stay in the price books and the Stripe catalogue, and the plan seed migration is unchanged.
- **Statuses at this amendment:**
  - `branded_compass_build` is `not_offered`: Terms of Service, section 5.1.
  - `legend_early_access` is `not_offered`: ADR 0020, decision 4.
  - `eu_data_residency` is `territory` `EEA`: ADR 0160, decision 2, and Terms of Service, section 8.5.
  - Every other feature is `offered`.
  - Extra seats and `aurora_requests_1000` are `not_on_sale`: the Gaps entry above, the 2026-10-23 amendment, and Terms of Service, section 5.3.
- **A status cites its text:** every status other than `offered` and `on_sale` carries a `basis`, a list of files and a sentence quoted from each. `packages/schemas/test/plans/offering.test.ts` holds every quote to its file, and holds the status to each sentence while the sentence stands, so neither changes without the other.
- **Readers:**
  - The Zod schema in `packages/schemas/src/plans/load.ts` validates the section: every feature and add-on, in list order, and a basis exactly where a status withholds something.
  - `@xos/schemas/plans/offering` exposes it as data and pure functions (`isPlanFeatureOffered`, `offeredPlanFeatures`, `extraSeatsOnSale`, `addonOnSale`) over a module that `generate:plans` writes and `check:plans` compares, so code that cannot read a file reads the same statuses.
  - `planFeatureOffered` in `@xos/i18n/offering` asks that module and keeps no list of its own. `@xos/i18n` now depends on `@xos/schemas`, so the design packages pack and publish with schemas before i18n.
- **Atlas:** Billing and Plan lists a plan's features through `planFeatureOffered`, and shows an extra-seat price, Buy extra seats and the Aurora request pack only while `plans.yaml` states them on sale. They are not, so the page shows none of them, where it used to show their prices beside disabled buttons. What a customer can buy is unchanged. `apps/atlas/test/plan-offering.test.ts` fails if a status is set to `on_sale` before Atlas has a purchase for it, or if another surface lists plan features without reading the offering.
- **Putting something on sale or offering a feature:** change its status in `plans.yaml` together with the text its basis quotes, run `generate:plans`, `generate:routes` and `bundle:edge`, and open the lockstep issue in `ghxstship/atlas-marketing` before the tag.
- **Where the sources disagreed, the stricter reading stands:**
  - `apps/compass/scripts/tenant-profile.ts` builds per-tenant Compass profiles, and the Terms say the branded build is not offered. It is `not_offered`.
  - Terms of Service, section 8.5, sets up an EU region only under a signed Enterprise contract, and ADR 0160 lists EU data residency once the EEA opens. It stays `territory`, which is closed at launch; opening the EEA is the moment to reconcile the two.
  - `support_session_controls` is in the Enterprise list of `plans.yaml`, the Terms' Enterprise summary does not name it, and no code gates it by plan: every Owner grants support sessions. It is `offered`, since nothing withholds it.
- **Not changed:** the seat refusal `seat_limit_reached` and the messages built on it still tell an Owner to buy extra seats in Billing and Plan. They come from the database rule for a plan that prices extra seats, and rewording them belongs with the billing UI follow-up that puts extra seats on sale. Billing and Plan itself stays neutral meanwhile: when every seat is in use on a plan that prices extra seats, it names the upgrade only (`seatsFullNotOnSale`), and says a plan sells no extra seats only for a plan that prices none. The operator console's tenant page lists a plan's features as entitlements for operators, which is not a price list, and reads no offering.
