/**
 * Shapes of the plan registry (Section 16, ADR 0008). Closed lists come from `plans.yaml`
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
}

export interface PlanRegistry {
  readonly version: 1;
  readonly limits: readonly string[];
  readonly features: readonly string[];
  readonly currencies: readonly PriceBookCurrency[];
  readonly plans: readonly PlanDefinition[];
}
