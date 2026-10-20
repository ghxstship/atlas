import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import type {
  AddonDefinition,
  OfferDefinition,
  PlanDefinition,
  PlanPrice,
  PlanRegistry,
  PriceBookCurrency,
} from "./model.ts";
import { PRICE_BOOK_CURRENCIES } from "./model.ts";

/** Default location of the plan registry: the package root. */
export const PLANS_YAML_PATH = fileURLToPath(new URL("../../plans.yaml", import.meta.url));

const CODE = /^[a-z][a-z0-9_]*$/;
const minor = z.int().min(0).nullable();

const priceSchema = z.strictObject({ monthly_minor: minor, annual_minor: minor });

/** Stripe lookup keys and coupon ids: lowercase letters, digits and underscores. */
const LOOKUP_KEY = /^[a-z0-9_]+$/;
const lookupKey = z.string().regex(LOOKUP_KEY);

const stripeSchema = z.strictObject({
  product_lookup_key: lookupKey,
  prices: z.strictObject({ monthly: lookupKey, annual: lookupKey }),
});

const extraSeatSchema = z.strictObject({
  prices: z.record(z.string(), priceSchema),
  stripe: z.strictObject({ monthly: lookupKey, annual: lookupKey }),
});

const quoteSchema = z.strictObject({
  contract: z.literal("annual"),
  from_monthly_minor: z.record(z.string(), minor),
});

const planSchema = z.strictObject({
  code: z.string().regex(CODE),
  free: z.boolean().optional(),
  extends: z.string().optional(),
  limits: z.record(z.string(), z.int().min(0).nullable()),
  features: z.array(z.string()),
  prices: z.record(z.string(), priceSchema),
  extra_seat: extraSeatSchema.optional(),
  quote: quoteSchema.optional(),
  stripe: stripeSchema.optional(),
});

const addonSchema = z.strictObject({
  code: z.string().regex(CODE),
  adds: z.strictObject({ limit: z.string().regex(CODE), amount: z.int().min(1) }),
  plans: z.array(z.string()).min(1),
  prices: z.record(z.string(), z.int().min(1)),
  stripe: z.strictObject({ product_lookup_key: lookupKey, price: lookupKey }),
});

const offerSchema = z.strictObject({
  code: z.string().regex(CODE),
  percent_off: z.int().min(1).max(100),
  duration_months: z.int().min(1).max(36),
  max_redemptions: z.int().min(1),
  plans: z.array(z.string()).min(1),
  stripe: z.strictObject({
    coupon_id: lookupKey,
    promotion_code: z.string().regex(/^[A-Z0-9]{3,20}$/),
  }),
});

const registrySchema = z.strictObject({
  version: z.literal(1),
  limits: z.array(z.string().regex(CODE)).min(1),
  features: z.array(z.string().regex(CODE)).min(1),
  currencies: z.array(z.enum(PRICE_BOOK_CURRENCIES)),
  annual_multiplier: z.int().min(1).max(12),
  extra_seat_product_lookup_key: lookupKey,
  partner_wholesale_discount_bps: z.int().min(0).max(9000),
  plans: z.array(planSchema).min(1),
  addons: z.array(addonSchema).default([]),
  offers: z.array(offerSchema).default([]),
});

/** Raised when the plan registry text is malformed or breaks a registry rule. */
export class PlanRegistryError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Plan registry is invalid:\n  ${issues.join("\n  ")}`);
    this.name = "PlanRegistryError";
    this.issues = issues;
  }
}

type RawRegistry = z.infer<typeof registrySchema>;
type RawPrice = z.infer<typeof priceSchema>;

function sameList(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((v, i) => v === expected[i]);
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return sameList([...actual].sort(), [...expected].sort());
}

function duplicates(values: readonly string[]): string[] {
  return values.filter((v, i) => values.indexOf(v) !== i);
}

const EVERY_CURRENCY = PRICE_BOOK_CURRENCIES.join(", ");

/** Checks a price book: every currency, annual at the multiplier, zero only where allowed. */
function checkPriceBook(
  issues: string[],
  at: string,
  book: Record<string, RawPrice>,
  multiplier: number,
  free: boolean,
): void {
  if (!sameSet(Object.keys(book), PRICE_BOOK_CURRENCIES)) {
    issues.push(`${at} must price every currency ${EVERY_CURRENCY}`);
  }
  for (const [cur, price] of Object.entries(book)) {
    const amounts = [price.monthly_minor, price.annual_minor];
    if (free && amounts.some((a) => a !== 0)) {
      issues.push(`${at} is free, so its ${cur} prices must be 0`);
    }
    if (!free && amounts.some((a) => a === 0)) {
      issues.push(
        `${at} is not free, so a ${cur} price is a claim and cannot be 0; leave it null until set`,
      );
    }
    if ((price.monthly_minor === null) !== (price.annual_minor === null)) {
      issues.push(`${at} prices ${cur} monthly and annual together, or neither`);
    } else if (
      price.monthly_minor !== null &&
      price.annual_minor !== null &&
      price.annual_minor !== price.monthly_minor * multiplier
    ) {
      issues.push(`${at} must price ${cur} annually at ${String(multiplier)} times monthly`);
    }
  }
}

/** Checks every rule documented at the top of plans.yaml. Returns the issues found. */
export function validatePlans(raw: RawRegistry): string[] {
  const issues: string[] = [];
  for (const [label, list] of [
    ["limit", raw.limits],
    ["feature", raw.features],
    ["plan", raw.plans.map((p) => p.code)],
    ["add-on", raw.addons.map((a) => a.code)],
    ["offer", raw.offers.map((o) => o.code)],
  ] as const) {
    for (const d of duplicates(list)) issues.push(`${label} ${d} is listed twice`);
  }
  if (!sameList(raw.currencies, PRICE_BOOK_CURRENCIES)) {
    issues.push(`currencies must be ${EVERY_CURRENCY}`);
  }

  const resolved = new Map<string, Set<string>>();
  raw.plans.forEach((plan, index) => {
    const at = `plan ${plan.code}`;
    const free = plan.free === true;
    const quoted = plan.quote !== undefined;
    if (!sameSet(Object.keys(plan.limits), raw.limits)) {
      issues.push(`${at} must state exactly the limits ${raw.limits.join(", ")}`);
    }
    for (const f of plan.features) {
      if (!raw.features.includes(f)) issues.push(`${at} names unknown feature ${f}`);
    }
    for (const d of duplicates(plan.features)) issues.push(`${at} lists feature ${d} twice`);

    checkPriceBook(issues, at, plan.prices, raw.annual_multiplier, free);

    if (free && plan.stripe !== undefined) {
      issues.push(`${at} is free, so it has no Stripe price`);
    }
    if (quoted) {
      if (free) issues.push(`${at} is free, so it has no quote`);
      if (plan.stripe !== undefined) {
        issues.push(`${at} is sold by quote, so it has no Stripe price`);
      }
      if (Object.values(plan.prices).some((p) => p.monthly_minor !== null)) {
        issues.push(`${at} is sold by quote, so its list prices stay null`);
      }
      const from = plan.quote?.from_monthly_minor ?? {};
      if (!sameSet(Object.keys(from), PRICE_BOOK_CURRENCIES)) {
        issues.push(`${at} must state a quote from-price for every currency ${EVERY_CURRENCY}`);
      }
      if (Object.values(from).some((v) => v === 0)) {
        issues.push(`${at} cannot quote from 0; leave it null until set`);
      }
    } else if (!free && plan.stripe === undefined) {
      issues.push(`${at} is paid, so it must name its Stripe product and price lookup keys`);
    }

    const seats = plan.limits["seats"];
    const seatsLimited = seats !== null && seats !== undefined;
    if (plan.extra_seat !== undefined) {
      if (free || quoted) issues.push(`${at} is not self-serve, so it sells no extra seats`);
      if (!seatsLimited) issues.push(`${at} has unlimited seats, so it sells no extra seats`);
      checkPriceBook(
        issues,
        `${at} extra seat`,
        plan.extra_seat.prices,
        raw.annual_multiplier,
        false,
      );
    } else if (!free && !quoted && seatsLimited) {
      issues.push(`${at} limits seats, so it must sell extra seats`);
    }

    const previous = index === 0 ? undefined : raw.plans[index - 1];
    if (index === 0) {
      if (plan.extends !== undefined)
        issues.push(`${at} is the first plan and cannot extend another`);
      if (!free) issues.push(`${at} is the first plan and must be free`);
    } else if (plan.extends !== previous?.code) {
      issues.push(`${at} must extend the plan before it, ${previous?.code ?? ""}`);
    }

    const inherited =
      plan.extends === undefined ? new Set<string>() : (resolved.get(plan.extends) ?? new Set());
    for (const f of plan.features) {
      if (inherited.has(f)) issues.push(`${at} repeats feature ${f} from ${plan.extends ?? ""}`);
    }
    resolved.set(plan.code, new Set([...inherited, ...plan.features]));

    if (previous !== undefined) {
      for (const limit of raw.limits) {
        const mine = plan.limits[limit];
        const theirs = previous.limits[limit];
        if (mine === undefined || theirs === undefined) continue;
        if (theirs === null && mine !== null) {
          issues.push(`${at} limits ${limit} although ${previous.code} is unlimited`);
        } else if (mine !== null && theirs !== null && mine < theirs) {
          issues.push(`${at} allows fewer ${limit} than ${previous.code}`);
        }
      }
    }
  });

  for (const addon of raw.addons) {
    const at = `add-on ${addon.code}`;
    if (!raw.limits.includes(addon.adds.limit)) {
      issues.push(`${at} adds to unknown limit ${addon.adds.limit}`);
    }
    if (!sameSet(Object.keys(addon.prices), PRICE_BOOK_CURRENCIES)) {
      issues.push(`${at} must price every currency ${EVERY_CURRENCY}`);
    }
    for (const code of addon.plans) {
      const plan = raw.plans.find((p) => p.code === code);
      if (plan === undefined) issues.push(`${at} names unknown plan ${code}`);
      else if (plan.stripe === undefined) {
        issues.push(`${at} is sold only to self-serve paid plans, not ${code}`);
      } else if (plan.limits[addon.adds.limit] === null) {
        issues.push(`${at} cannot raise ${addon.adds.limit} on ${code}, which is unlimited`);
      }
    }
  }
  for (const offer of raw.offers) {
    for (const code of offer.plans) {
      const plan = raw.plans.find((p) => p.code === code);
      if (plan === undefined) issues.push(`offer ${offer.code} names unknown plan ${code}`);
      else if (plan.stripe === undefined) {
        issues.push(`offer ${offer.code} applies only to self-serve paid plans, not ${code}`);
      }
    }
  }

  const productKeys = [
    raw.extra_seat_product_lookup_key,
    ...raw.plans.flatMap((p) => (p.stripe === undefined ? [] : [p.stripe.product_lookup_key])),
    ...raw.addons.map((a) => a.stripe.product_lookup_key),
  ];
  const priceKeys = [
    ...raw.plans.flatMap((p) =>
      p.stripe === undefined ? [] : [p.stripe.prices.monthly, p.stripe.prices.annual],
    ),
    ...raw.plans.flatMap((p) =>
      p.extra_seat === undefined ? [] : [p.extra_seat.stripe.monthly, p.extra_seat.stripe.annual],
    ),
    ...raw.addons.map((a) => a.stripe.price),
  ];
  for (const d of duplicates([...productKeys, ...priceKeys])) {
    issues.push(`Stripe lookup key ${d} is used twice`);
  }
  for (const d of duplicates(raw.offers.map((o) => o.stripe.coupon_id))) {
    issues.push(`Stripe coupon ${d} is used twice`);
  }
  for (const d of duplicates(raw.offers.map((o) => o.stripe.promotion_code))) {
    issues.push(`Stripe promotion code ${d} is used twice`);
  }
  return issues;
}

function toPrice(p: RawPrice): PlanPrice {
  return { monthlyMinor: p.monthly_minor, annualMinor: p.annual_minor };
}

function byCurrency<T, U>(
  book: Readonly<Record<string, T>>,
  map: (value: T) => U,
): Record<PriceBookCurrency, U> {
  return Object.fromEntries(PRICE_BOOK_CURRENCIES.map((c) => [c, map(book[c] as T)])) as Record<
    PriceBookCurrency,
    U
  >;
}

function toRegistry(raw: RawRegistry): PlanRegistry {
  const included = new Map<string, Set<string>>();
  const plans: PlanDefinition[] = raw.plans.map((p, i) => {
    const own = new Set([
      ...(p.extends === undefined ? [] : [...(included.get(p.extends) ?? [])]),
      ...p.features,
    ]);
    included.set(p.code, own);
    return {
      code: p.code,
      sortOrder: i + 1,
      free: p.free ?? false,
      extends: p.extends ?? null,
      limits: Object.fromEntries(raw.limits.map((l) => [l, p.limits[l] ?? null])),
      features: raw.features.filter((f) => own.has(f)),
      prices: byCurrency(p.prices, toPrice),
      stripe:
        p.stripe === undefined
          ? null
          : {
              productLookupKey: p.stripe.product_lookup_key,
              monthlyPriceLookupKey: p.stripe.prices.monthly,
              annualPriceLookupKey: p.stripe.prices.annual,
            },
      extraSeat:
        p.extra_seat === undefined
          ? null
          : {
              prices: byCurrency(p.extra_seat.prices, toPrice),
              monthlyPriceLookupKey: p.extra_seat.stripe.monthly,
              annualPriceLookupKey: p.extra_seat.stripe.annual,
            },
      quote:
        p.quote === undefined
          ? null
          : {
              contract: p.quote.contract,
              fromMonthlyMinor: byCurrency(p.quote.from_monthly_minor, (v) => v ?? null),
            },
      selfServe: p.stripe !== undefined,
    };
  });
  const addons: AddonDefinition[] = raw.addons.map((a) => ({
    code: a.code,
    limit: a.adds.limit,
    amount: a.adds.amount,
    plans: a.plans,
    prices: byCurrency(a.prices, (v) => v),
    productLookupKey: a.stripe.product_lookup_key,
    priceLookupKey: a.stripe.price,
  }));
  const offers: OfferDefinition[] = raw.offers.map((o) => ({
    code: o.code,
    percentOff: o.percent_off,
    durationMonths: o.duration_months,
    maxRedemptions: o.max_redemptions,
    plans: o.plans,
    couponId: o.stripe.coupon_id,
    promotionCode: o.stripe.promotion_code,
  }));
  return {
    version: 1,
    limits: raw.limits,
    features: raw.features,
    currencies: raw.currencies,
    annualMultiplier: raw.annual_multiplier,
    extraSeatProductLookupKey: raw.extra_seat_product_lookup_key,
    partnerWholesaleDiscountBps: raw.partner_wholesale_discount_bps,
    plans,
    addons,
    offers,
  };
}

/** Parses and validates plan registry text. */
export function parsePlanRegistry(text: string): PlanRegistry {
  const parsed = registrySchema.safeParse(parse(text));
  if (!parsed.success) {
    throw new PlanRegistryError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const issues = validatePlans(parsed.data);
  if (issues.length > 0) throw new PlanRegistryError(issues);
  return toRegistry(parsed.data);
}

/** Loads `plans.yaml` (or another path) and validates it. */
export function loadPlanRegistry(path: string = PLANS_YAML_PATH): PlanRegistry {
  return parsePlanRegistry(readFileSync(path, "utf8"));
}
