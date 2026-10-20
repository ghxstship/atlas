/**
 * Shapes of the plan registry (Section 16, ADR 0008, ADR 0035). Closed lists come from `plans.yaml`
 * itself and are checked against the Postgres enums `app.plan_limit_code` and
 * `app.plan_feature_code` by a unit test.
 */

/** Price book currencies (Section 16). */
export const PRICE_BOOK_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD"] as const;
export type PriceBookCurrency = (typeof PRICE_BOOK_CURRENCIES)[number];

/** Monthly and annual prices in minor units. Null is unpriced, never zero (Section 3.7). */
export interface PlanPrice {
  readonly monthlyMinor: number | null;
  readonly annualMinor: number | null;
}

/**
 * Stripe catalog references for a self-serve paid plan, by lookup key rather than id, so one file
 * serves test mode and live mode as long as both carry the same lookup keys.
 */
export interface PlanStripeRefs {
  readonly productLookupKey: string;
  readonly monthlyPriceLookupKey: string;
  readonly annualPriceLookupKey: string;
}

/**
 * Seats bought above a plan's seat allowance (ADR 0035): a per-seat price per month and per year in
 * every currency, sold as the quantity of a recurring Stripe price on the shared extra-seat product.
 */
export interface PlanExtraSeat {
  readonly prices: Readonly<Record<PriceBookCurrency, PlanPrice>>;
  readonly monthlyPriceLookupKey: string;
  readonly annualPriceLookupKey: string;
}

/** A plan sold by contract only (Enterprise). The from-price is for display; it is never checked out. */
export interface PlanQuote {
  readonly contract: "annual";
  readonly fromMonthlyMinor: Readonly<Record<PriceBookCurrency, number | null>>;
}

export interface PlanDefinition {
  readonly code: string;
  /** 1 for the free plan, rising upward. */
  readonly sortOrder: number;
  readonly free: boolean;
  readonly extends: string | null;
  /** Every limit; null means unlimited. */
  readonly limits: Readonly<Record<string, number | null>>;
  /** Every feature the plan includes, own and inherited, in registry feature order. */
  readonly features: readonly string[];
  readonly prices: Readonly<Record<PriceBookCurrency, PlanPrice>>;
  /** Present on every self-serve paid plan; null on the free plan and on a quoted plan. */
  readonly stripe: PlanStripeRefs | null;
  /** Extra seats the plan sells above its seat allowance; null when it sells none. */
  readonly extraSeat: PlanExtraSeat | null;
  /** Present when the plan is sold by contract only. */
  readonly quote: PlanQuote | null;
  /** True when an org can subscribe to the plan through Stripe Checkout on its own. */
  readonly selfServe: boolean;
}

/** A one-time purchase that raises one limit for the calendar month it is bought in (ADR 0035). */
export interface AddonDefinition {
  readonly code: string;
  readonly limit: string;
  readonly amount: number;
  /** Plans that may buy it. */
  readonly plans: readonly string[];
  /** One-time price in minor units per currency. */
  readonly prices: Readonly<Record<PriceBookCurrency, number>>;
  readonly productLookupKey: string;
  readonly priceLookupKey: string;
}

/** A Stripe coupon with a customer-facing promotion code (ADR 0035). */
export interface OfferDefinition {
  readonly code: string;
  readonly percentOff: number;
  readonly durationMonths: number;
  readonly maxRedemptions: number;
  /** Plans whose products (and the extra-seat product) the coupon applies to. */
  readonly plans: readonly string[];
  readonly couponId: string;
  readonly promotionCode: string;
}

export interface PlanRegistry {
  readonly version: 1;
  readonly limits: readonly string[];
  readonly features: readonly string[];
  readonly currencies: readonly PriceBookCurrency[];
  /** Annual price as a multiple of the monthly price. */
  readonly annualMultiplier: number;
  /** The Stripe product (metadata.lookup_key) every extra-seat price belongs to. */
  readonly extraSeatProductLookupKey: string;
  /** Default wholesale discount for partners, in basis points (Section 4.6.1). */
  readonly partnerWholesaleDiscountBps: number;
  readonly plans: readonly PlanDefinition[];
  readonly addons: readonly AddonDefinition[];
  readonly offers: readonly OfferDefinition[];
}
