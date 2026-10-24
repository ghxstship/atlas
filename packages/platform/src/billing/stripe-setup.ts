import type Stripe from "stripe";
import type { PlanRegistry, PriceBookCurrency } from "@xos/schemas/plans";
import { PRICE_BOOK_CURRENCIES } from "@xos/schemas/plans";
import { PORTAL_CONFIGURATION_KEY } from "./checkout.ts";

/**
 * Creates the Stripe catalogue of packages/schemas/plans.yaml (ADR 0035): one product per self-serve
 * plan, the extra-seat product and one product per add-on, their prices by lookup key with every
 * priced currency as a currency option, each offer's coupon and promotion code, and the customer
 * portal configuration Atlas opens (ADR 0033 decision 59).
 *
 * Idempotent: products use their lookup key as their Stripe id, so a second run finds them; prices
 * are found by lookup key, coupons by id, promotion codes by code and the portal configuration by its
 * metadata. Products and the portal configuration are brought up to date in place. Prices, coupons
 * and promotion codes cannot change once created, so a difference between Stripe and plans.yaml stops
 * the run with a CatalogDriftError naming every difference; the fix is a new versioned lookup key in
 * plans.yaml, never an edit in Stripe.
 */

/** The Stripe operations the catalogue setup uses. Tests pass an in-memory client. */
export interface StripeCatalogClient {
  readonly products: Pick<Stripe["products"], "retrieve" | "create" | "update">;
  readonly prices: Pick<Stripe["prices"], "list" | "create">;
  readonly coupons: Pick<Stripe["coupons"], "retrieve" | "create">;
  readonly promotionCodes: Pick<Stripe["promotionCodes"], "list" | "create">;
  readonly billingPortal: {
    readonly configurations: Pick<
      Stripe["billingPortal"]["configurations"],
      "list" | "create" | "update"
    >;
  };
}

export interface ProductSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface PriceSpec {
  readonly lookupKey: string;
  readonly productId: string;
  readonly nickname: string;
  /** Lowercase ISO code of the default currency (USD). */
  readonly currency: string;
  readonly unitAmount: number;
  /** Every other priced currency, lowercase, to its amount in minor units. */
  readonly currencyOptions: Readonly<Record<string, number>>;
  /** Null for a one-time price. */
  readonly interval: "month" | "year" | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface CouponSpec {
  readonly id: string;
  readonly name: string;
  readonly percentOff: number;
  readonly durationMonths: number;
  readonly maxRedemptions: number;
  readonly productIds: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

export interface PromotionCodeSpec {
  readonly code: string;
  readonly couponId: string;
  readonly maxRedemptions: number;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * The customer portal configuration: payment methods, invoices and billing details, cancellation at
 * the end of the paid period, and switching between the self-serve plans and terms, prorated.
 */
export interface PortalSpec {
  readonly name: string;
  readonly metadata: Readonly<Record<string, string>>;
  /** Each plan product the portal may switch to, with the lookup keys of its prices. */
  readonly products: readonly {
    readonly productId: string;
    readonly priceLookupKeys: readonly string[];
  }[];
}

export interface StripeCatalog {
  readonly products: readonly ProductSpec[];
  readonly prices: readonly PriceSpec[];
  readonly coupons: readonly CouponSpec[];
  readonly promotionCodes: readonly PromotionCodeSpec[];
  readonly portal: PortalSpec;
}

/** Display names of plans and add-ons on Stripe invoices and Checkout (English, as Stripe shows them). */
const PLAN_NAMES: Readonly<Record<string, string>> = {
  core: "XOS Core",
  pro: "XOS Pro",
  team: "XOS Team",
};

function planName(code: string): string {
  return PLAN_NAMES[code] ?? `XOS ${code.charAt(0).toUpperCase()}${code.slice(1)}`;
}

/** USD as the price's own currency and every other priced currency as an option. */
function amounts(
  book: Readonly<Record<PriceBookCurrency, number | null>>,
  lookupKey: string,
): { readonly unitAmount: number; readonly currencyOptions: Record<string, number> } {
  const usd = book.USD;
  if (usd === null) throw new Error(`${lookupKey} has no USD price, which Stripe needs as default`);
  const currencyOptions: Record<string, number> = {};
  for (const c of PRICE_BOOK_CURRENCIES) {
    const value = book[c];
    if (c !== "USD" && value !== null) currencyOptions[c.toLowerCase()] = value;
  }
  return { unitAmount: usd, currencyOptions };
}

/** The Stripe catalogue plans.yaml describes. A pure function of the registry. */
export function stripeCatalog(registry: PlanRegistry): StripeCatalog {
  const products: ProductSpec[] = [];
  const prices: PriceSpec[] = [];
  const selfServe = registry.plans.filter((p) => p.stripe !== null);
  for (const plan of selfServe) {
    const stripe = plan.stripe;
    if (stripe === null) continue;
    products.push({
      id: stripe.productLookupKey,
      name: planName(plan.code),
      description: `${planName(plan.code)} plan, ${String(plan.limits["seats"] ?? "unlimited")} seats included.`,
      metadata: { lookup_key: stripe.productLookupKey, xos_kind: "plan", plan_code: plan.code },
    });
    for (const [interval, key, pick] of [
      ["month", stripe.monthlyPriceLookupKey, "monthlyMinor"],
      ["year", stripe.annualPriceLookupKey, "annualMinor"],
    ] as const) {
      const book = Object.fromEntries(
        PRICE_BOOK_CURRENCIES.map((c) => [c, plan.prices[c][pick]]),
      ) as Record<PriceBookCurrency, number | null>;
      prices.push({
        lookupKey: key,
        productId: stripe.productLookupKey,
        nickname: `${planName(plan.code)} ${interval === "month" ? "monthly" : "annual"}`,
        ...amounts(book, key),
        currency: "usd",
        interval,
        metadata: { xos_kind: "plan", plan_code: plan.code },
      });
    }
  }

  const seatPlans = registry.plans.filter((p) => p.extraSeat !== null);
  if (seatPlans.length > 0) {
    products.push({
      id: registry.extraSeatProductLookupKey,
      name: "XOS extra seat",
      description: "A seat above the seats your plan includes.",
      metadata: { lookup_key: registry.extraSeatProductLookupKey, xos_kind: "extra_seat" },
    });
  }
  for (const plan of seatPlans) {
    const seat = plan.extraSeat;
    if (seat === null) continue;
    for (const [interval, key, pick] of [
      ["month", seat.monthlyPriceLookupKey, "monthlyMinor"],
      ["year", seat.annualPriceLookupKey, "annualMinor"],
    ] as const) {
      const book = Object.fromEntries(
        PRICE_BOOK_CURRENCIES.map((c) => [c, seat.prices[c][pick]]),
      ) as Record<PriceBookCurrency, number | null>;
      prices.push({
        lookupKey: key,
        productId: registry.extraSeatProductLookupKey,
        nickname: `Extra seat on ${planName(plan.code)}, ${interval === "month" ? "monthly" : "annual"}`,
        ...amounts(book, key),
        currency: "usd",
        interval,
        metadata: { xos_kind: "extra_seat", plan_code: plan.code },
      });
    }
  }

  for (const addon of registry.addons) {
    products.push({
      id: addon.productLookupKey,
      name: `XOS ${addon.limit === "aurora_requests_per_month" ? "Aurora" : addon.limit} pack of ${addon.amount.toLocaleString("en-US")}`,
      description: `Adds ${addon.amount.toLocaleString("en-US")} to this month's allowance.`,
      metadata: { lookup_key: addon.productLookupKey, xos_kind: "addon", addon_code: addon.code },
    });
    prices.push({
      lookupKey: addon.priceLookupKey,
      productId: addon.productLookupKey,
      nickname: `${addon.code} one-time`,
      ...amounts(addon.prices, addon.priceLookupKey),
      currency: "usd",
      interval: null,
      metadata: { xos_kind: "addon", addon_code: addon.code },
    });
  }

  const coupons: CouponSpec[] = [];
  const promotionCodes: PromotionCodeSpec[] = [];
  for (const offer of registry.offers) {
    const planProducts = offer.plans.flatMap((code) => {
      const plan = registry.plans.find((p) => p.code === code);
      return plan?.stripe ? [plan.stripe.productLookupKey] : [];
    });
    coupons.push({
      id: offer.couponId,
      name: `${offer.percentOff}% off for ${offer.durationMonths} months`,
      percentOff: offer.percentOff,
      durationMonths: offer.durationMonths,
      maxRedemptions: offer.maxRedemptions,
      productIds:
        seatPlans.length > 0 ? [...planProducts, registry.extraSeatProductLookupKey] : planProducts,
      metadata: { xos_offer: offer.code },
    });
    promotionCodes.push({
      code: offer.promotionCode,
      couponId: offer.couponId,
      maxRedemptions: offer.maxRedemptions,
      metadata: { xos_offer: offer.code },
    });
  }
  const portal: PortalSpec = {
    name: "XOS plans",
    metadata: { xos_portal: PORTAL_CONFIGURATION_KEY },
    products: selfServe.flatMap((plan) =>
      plan.stripe === null
        ? []
        : [
            {
              productId: plan.stripe.productLookupKey,
              priceLookupKeys: [
                plan.stripe.monthlyPriceLookupKey,
                plan.stripe.annualPriceLookupKey,
              ],
            },
          ],
    ),
  };
  return { products, prices, coupons, promotionCodes, portal };
}

type PortalFeatures = Stripe.BillingPortal.ConfigurationCreateParams.Features;

/** The portal's features, with the price ids Stripe gave the plan prices. */
export function portalFeatures(
  portal: PortalSpec,
  priceIds: ReadonlyMap<string, string>,
): PortalFeatures {
  return {
    customer_update: { enabled: true, allowed_updates: ["email", "address", "name", "tax_id"] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: {
      enabled: true,
      mode: "at_period_end",
      cancellation_reason: {
        enabled: true,
        options: ["too_expensive", "missing_features", "switched_service", "unused", "other"],
      },
    },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ["price", "promotion_code"],
      proration_behavior: "create_prorations",
      trial_update_behavior: "continue_trial",
      products: portal.products.map((p) => ({
        product: p.productId,
        prices: p.priceLookupKeys.map((key) => priceIds.get(key) ?? key),
      })),
    },
  };
}

/** The parts of a portal configuration the setup decides, in a stable order, to compare. */
function portalShape(features: unknown): string {
  const f = (features ?? {}) as {
    customer_update?: { enabled?: boolean; allowed_updates?: string[] | null };
    invoice_history?: { enabled?: boolean };
    payment_method_update?: { enabled?: boolean };
    subscription_cancel?: {
      enabled?: boolean;
      mode?: string;
      cancellation_reason?: { enabled?: boolean; options?: string[] | null };
    };
    subscription_update?: {
      enabled?: boolean;
      default_allowed_updates?: string[] | null;
      proration_behavior?: string;
      trial_update_behavior?: string;
      products?: { product: string; prices: string[] }[] | null;
    };
  };
  const sorted = (list: readonly string[] | null | undefined) => [...(list ?? [])].sort();
  return JSON.stringify([
    f.customer_update?.enabled,
    sorted(f.customer_update?.allowed_updates),
    f.invoice_history?.enabled,
    f.payment_method_update?.enabled,
    f.subscription_cancel?.enabled,
    f.subscription_cancel?.mode,
    f.subscription_cancel?.cancellation_reason?.enabled,
    sorted(f.subscription_cancel?.cancellation_reason?.options),
    f.subscription_update?.enabled,
    sorted(f.subscription_update?.default_allowed_updates),
    f.subscription_update?.proration_behavior,
    f.subscription_update?.trial_update_behavior,
    (f.subscription_update?.products ?? [])
      .map((p) => [p.product, sorted(p.prices)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}

/** Stripe holds a price, coupon or promotion code that differs from plans.yaml. */
export class CatalogDriftError extends Error {
  readonly differences: readonly string[];
  constructor(differences: readonly string[]) {
    super(
      `The Stripe catalogue differs from plans.yaml; give the changed item a new lookup key:\n  ${differences.join("\n  ")}`,
    );
    this.name = "CatalogDriftError";
    this.differences = differences;
  }
}

export type SetupAction = "created" | "updated" | "unchanged" | "would create" | "would update";

export interface SetupReport {
  readonly items: readonly {
    readonly kind: "product" | "price" | "coupon" | "promotion_code" | "portal_configuration";
    readonly key: string;
    readonly action: SetupAction;
  }[];
}

function isMissing(error: unknown): boolean {
  const e = error as { statusCode?: number; code?: string } | null;
  return e?.statusCode === 404 || e?.code === "resource_missing";
}

function sameRecord(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) {
  return Object.entries(a).every(([k, v]) => b[k] === v);
}

function priceDifferences(spec: PriceSpec, price: Stripe.Price): string[] {
  const at = `price ${spec.lookupKey}`;
  const out: string[] = [];
  const productId = typeof price.product === "string" ? price.product : price.product.id;
  if (!price.active) out.push(`${at} is archived in Stripe`);
  if (productId !== spec.productId)
    out.push(`${at} belongs to ${productId}, not ${spec.productId}`);
  if (price.currency !== spec.currency)
    out.push(`${at} is in ${price.currency}, not ${spec.currency}`);
  if (price.unit_amount !== spec.unitAmount) {
    out.push(`${at} costs ${String(price.unit_amount)}, not ${String(spec.unitAmount)}`);
  }
  const interval = price.recurring?.interval ?? null;
  if (
    interval !== spec.interval ||
    (spec.interval !== null && price.recurring?.interval_count !== 1)
  ) {
    out.push(`${at} recurs ${interval ?? "never"}, not ${spec.interval ?? "never"}`);
  }
  const options = price.currency_options ?? {};
  for (const [currency, amount] of Object.entries(spec.currencyOptions)) {
    const actual = options[currency]?.unit_amount;
    if (actual !== amount) {
      out.push(`${at} costs ${String(actual ?? "nothing")} in ${currency}, not ${String(amount)}`);
    }
  }
  return out;
}

/**
 * Brings the Stripe account up to the catalogue of plans.yaml. With dryRun, reads only and reports
 * what it would create or update. Throws CatalogDriftError, before writing anything, when a price,
 * coupon or promotion code in Stripe differs from plans.yaml.
 */
export async function syncStripeCatalog(
  client: StripeCatalogClient,
  registry: PlanRegistry,
  options: { readonly dryRun?: boolean } = {},
): Promise<SetupReport> {
  const dryRun = options.dryRun === true;
  const catalog = stripeCatalog(registry);
  const items: { kind: SetupReport["items"][number]["kind"]; key: string; action: SetupAction }[] =
    [];
  const differences: string[] = [];

  // Read everything first, so drift stops the run before any write.
  const products = new Map<string, Stripe.Product | null>();
  for (const spec of catalog.products) {
    try {
      products.set(spec.id, await client.products.retrieve(spec.id));
    } catch (error) {
      if (!isMissing(error)) throw error;
      products.set(spec.id, null);
    }
  }
  const prices = new Map<string, Stripe.Price | null>();
  for (const spec of catalog.prices) {
    const found = await client.prices.list({
      lookup_keys: [spec.lookupKey],
      limit: 1,
      expand: ["data.currency_options"],
    });
    const price = found.data[0] ?? null;
    prices.set(spec.lookupKey, price);
    if (price !== null) differences.push(...priceDifferences(spec, price));
  }
  const coupons = new Map<string, Stripe.Coupon | null>();
  for (const spec of catalog.coupons) {
    let coupon: Stripe.Coupon | null = null;
    try {
      coupon = await client.coupons.retrieve(spec.id);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    coupons.set(spec.id, coupon);
    if (coupon !== null) {
      const at = `coupon ${spec.id}`;
      if (coupon.percent_off !== spec.percentOff) {
        differences.push(
          `${at} takes ${String(coupon.percent_off)}% off, not ${String(spec.percentOff)}%`,
        );
      }
      if (coupon.duration !== "repeating" || coupon.duration_in_months !== spec.durationMonths) {
        differences.push(
          `${at} lasts ${coupon.duration}, not ${String(spec.durationMonths)} months`,
        );
      }
      if (coupon.max_redemptions !== spec.maxRedemptions) {
        differences.push(
          `${at} allows ${String(coupon.max_redemptions)} redemptions, not ${String(spec.maxRedemptions)}`,
        );
      }
    }
  }
  const promotionCodes = new Map<string, Stripe.PromotionCode | null>();
  for (const spec of catalog.promotionCodes) {
    const found = await client.promotionCodes.list({ code: spec.code, limit: 1 });
    const code = found.data[0] ?? null;
    promotionCodes.set(spec.code, code);
    if (code !== null) {
      const coupon = code.promotion.coupon;
      const couponId = typeof coupon === "string" ? coupon : coupon?.id;
      if (couponId !== spec.couponId) {
        differences.push(
          `promotion code ${spec.code} applies ${String(couponId)}, not ${spec.couponId}`,
        );
      }
    }
  }
  const portals = await client.billingPortal.configurations.list({ active: true, limit: 100 });
  const portal =
    portals.data.find(
      (c) => c.metadata?.["xos_portal"] === catalog.portal.metadata["xos_portal"],
    ) ?? null;
  if (differences.length > 0) throw new CatalogDriftError(differences);

  for (const spec of catalog.products) {
    const existing = products.get(spec.id) ?? null;
    if (existing === null) {
      if (!dryRun) {
        await client.products.create({
          id: spec.id,
          name: spec.name,
          description: spec.description,
          metadata: { ...spec.metadata },
          tax_code: "txcd_10103001",
        });
      }
      items.push({ kind: "product", key: spec.id, action: dryRun ? "would create" : "created" });
      continue;
    }
    const current =
      existing.active &&
      existing.name === spec.name &&
      existing.description === spec.description &&
      sameRecord(spec.metadata, existing.metadata);
    if (current) {
      items.push({ kind: "product", key: spec.id, action: "unchanged" });
      continue;
    }
    if (!dryRun) {
      await client.products.update(spec.id, {
        active: true,
        name: spec.name,
        description: spec.description,
        metadata: { ...spec.metadata },
      });
    }
    items.push({ kind: "product", key: spec.id, action: dryRun ? "would update" : "updated" });
  }

  const priceIds = new Map<string, string>();
  for (const spec of catalog.prices) {
    const existing = prices.get(spec.lookupKey) ?? null;
    if (existing !== null) {
      priceIds.set(spec.lookupKey, existing.id);
      items.push({ kind: "price", key: spec.lookupKey, action: "unchanged" });
      continue;
    }
    if (!dryRun) {
      const created = await client.prices.create({
        product: spec.productId,
        lookup_key: spec.lookupKey,
        nickname: spec.nickname,
        currency: spec.currency,
        unit_amount: spec.unitAmount,
        tax_behavior: "exclusive",
        currency_options: Object.fromEntries(
          Object.entries(spec.currencyOptions).map(([c, unit_amount]) => [
            c,
            { unit_amount, tax_behavior: "exclusive" as const },
          ]),
        ),
        ...(spec.interval === null ? {} : { recurring: { interval: spec.interval } }),
        metadata: { ...spec.metadata },
      });
      priceIds.set(spec.lookupKey, created.id);
    }
    items.push({ kind: "price", key: spec.lookupKey, action: dryRun ? "would create" : "created" });
  }

  for (const spec of catalog.coupons) {
    if (coupons.get(spec.id) !== null) {
      items.push({ kind: "coupon", key: spec.id, action: "unchanged" });
      continue;
    }
    if (!dryRun) {
      await client.coupons.create({
        id: spec.id,
        name: spec.name,
        percent_off: spec.percentOff,
        duration: "repeating",
        duration_in_months: spec.durationMonths,
        max_redemptions: spec.maxRedemptions,
        applies_to: { products: [...spec.productIds] },
        metadata: { ...spec.metadata },
      });
    }
    items.push({ kind: "coupon", key: spec.id, action: dryRun ? "would create" : "created" });
  }

  for (const spec of catalog.promotionCodes) {
    if (promotionCodes.get(spec.code) !== null) {
      items.push({ kind: "promotion_code", key: spec.code, action: "unchanged" });
      continue;
    }
    if (!dryRun) {
      await client.promotionCodes.create({
        promotion: { type: "coupon", coupon: spec.couponId },
        code: spec.code,
        max_redemptions: spec.maxRedemptions,
        restrictions: { first_time_transaction: true },
        metadata: { ...spec.metadata },
      });
    }
    items.push({
      kind: "promotion_code",
      key: spec.code,
      action: dryRun ? "would create" : "created",
    });
  }

  // The customer portal switches between the plan prices, so it is set once they all exist.
  const features = portalFeatures(catalog.portal, priceIds);
  const portalKey = catalog.portal.metadata["xos_portal"] ?? "";
  if (portal === null) {
    if (!dryRun) {
      await client.billingPortal.configurations.create({
        name: catalog.portal.name,
        features,
        metadata: { ...catalog.portal.metadata },
      });
    }
    items.push({
      kind: "portal_configuration",
      key: portalKey,
      action: dryRun ? "would create" : "created",
    });
  } else if (
    portal.name === catalog.portal.name &&
    portalShape(portal.features) === portalShape(features)
  ) {
    items.push({ kind: "portal_configuration", key: portalKey, action: "unchanged" });
  } else {
    if (!dryRun) {
      await client.billingPortal.configurations.update(portal.id, {
        name: catalog.portal.name,
        features,
      });
    }
    items.push({
      kind: "portal_configuration",
      key: portalKey,
      action: dryRun ? "would update" : "updated",
    });
  }
  return { items };
}

/** Refuses anything but a Stripe test mode secret or restricted key (ADR 0035: the script is test mode only). */
export function assertTestModeKey(key: string | undefined): string {
  if (key === undefined || key.length === 0) {
    throw new Error("STRIPE_SECRET_KEY is not set. Export a test mode key (sk_test_...) first.");
  }
  if (!/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(key)) {
    throw new Error(
      "STRIPE_SECRET_KEY is not a Stripe test mode key. This script creates the test mode catalogue only.",
    );
  }
  return key;
}
