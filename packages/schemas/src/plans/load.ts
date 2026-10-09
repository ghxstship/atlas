import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import type { PlanDefinition, PlanPrice, PlanRegistry, PriceBookCurrency } from "./model.ts";
import { PRICE_BOOK_CURRENCIES } from "./model.ts";

/** Default location of the plan registry: the package root. */
export const PLANS_YAML_PATH = fileURLToPath(new URL("../../plans.yaml", import.meta.url));

const CODE = /^[a-z][a-z0-9_]*$/;
const minor = z.int().min(0).nullable();

const priceSchema = z.strictObject({ monthly_minor: minor, annual_minor: minor });

const planSchema = z.strictObject({
  code: z.string().regex(CODE),
  free: z.boolean().optional(),
  extends: z.string().optional(),
  limits: z.record(z.string(), z.int().min(0).nullable()),
  features: z.array(z.string()),
  prices: z.record(z.string(), priceSchema),
});

const registrySchema = z.strictObject({
  version: z.literal(1),
  limits: z.array(z.string().regex(CODE)).min(1),
  features: z.array(z.string().regex(CODE)).min(1),
  currencies: z.array(z.enum(PRICE_BOOK_CURRENCIES)),
  plans: z.array(planSchema).min(1),
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

function sameList(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((v, i) => v === expected[i]);
}

function duplicates(values: readonly string[]): string[] {
  return values.filter((v, i) => values.indexOf(v) !== i);
}

/** Checks every rule documented at the top of plans.yaml. Returns the issues found. */
export function validatePlans(raw: RawRegistry): string[] {
  const issues: string[] = [];
  for (const [label, list] of [
    ["limit", raw.limits],
    ["feature", raw.features],
    ["plan", raw.plans.map((p) => p.code)],
  ] as const) {
    for (const d of duplicates(list)) issues.push(`${label} ${d} is listed twice`);
  }
  if (!sameList(raw.currencies, PRICE_BOOK_CURRENCIES)) {
    issues.push(`currencies must be ${PRICE_BOOK_CURRENCIES.join(", ")}`);
  }

  const resolved = new Map<string, Set<string>>();
  raw.plans.forEach((plan, index) => {
    const at = `plan ${plan.code}`;
    const limitKeys = Object.keys(plan.limits);
    if (!sameList([...limitKeys].sort(), [...raw.limits].sort())) {
      issues.push(`${at} must state exactly the limits ${raw.limits.join(", ")}`);
    }
    for (const f of plan.features) {
      if (!raw.features.includes(f)) issues.push(`${at} names unknown feature ${f}`);
    }
    for (const d of duplicates(plan.features)) issues.push(`${at} lists feature ${d} twice`);

    const priceKeys = Object.keys(plan.prices);
    if (!sameList([...priceKeys].sort(), [...PRICE_BOOK_CURRENCIES].sort())) {
      issues.push(`${at} must price every currency ${PRICE_BOOK_CURRENCIES.join(", ")}`);
    }
    for (const [cur, price] of Object.entries(plan.prices)) {
      const amounts = [price.monthly_minor, price.annual_minor];
      if (plan.free === true && amounts.some((a) => a !== 0)) {
        issues.push(`${at} is free, so its ${cur} prices must be 0`);
      }
      if (plan.free !== true && amounts.some((a) => a === 0)) {
        issues.push(
          `${at} is not free, so a ${cur} price is a claim and cannot be 0; leave it null until set`,
        );
      }
    }

    const previous = index === 0 ? undefined : raw.plans[index - 1];
    if (index === 0) {
      if (plan.extends !== undefined)
        issues.push(`${at} is the first plan and cannot extend another`);
      if (plan.free !== true) issues.push(`${at} is the first plan and must be free`);
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
  return issues;
}

function toPrice(p: { monthly_minor: number | null; annual_minor: number | null }): PlanPrice {
  return { monthlyMinor: p.monthly_minor, annualMinor: p.annual_minor };
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
      prices: Object.fromEntries(
        PRICE_BOOK_CURRENCIES.map((c) => [
          c,
          toPrice(p.prices[c] as RawRegistry["plans"][number]["prices"][string]),
        ]),
      ) as Record<PriceBookCurrency, PlanPrice>,
    };
  });
  return {
    version: 1,
    limits: raw.limits,
    features: raw.features,
    currencies: raw.currencies,
    plans,
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
