import type { PlanRegistry } from "./model.ts";
import { PRICE_BOOK_CURRENCIES } from "./model.ts";

/**
 * Repository-relative path of the current generated plan seed migration (ADR 0018).
 * Applied migrations are never edited (ADR 0004), so when plans.yaml changes after a seed has
 * shipped, this moves to the next number in the range of the agent changing it and the earlier seeds
 * stay as history. Each seed is a complete idempotent upsert, so the latest one decides the state.
 */
export const PLAN_SEED_MIGRATION = "supabase/migrations/1251_plan_seed.sql";

const PLAN_SEED_FILE = PLAN_SEED_MIGRATION.slice(PLAN_SEED_MIGRATION.lastIndexOf("/") + 1);

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function amount(value: number | null | undefined): string {
  return value === null || value === undefined ? "null" : String(value);
}

function valuesBlock(rows: readonly (readonly string[])[]): string {
  return rows.map((cols) => `  (${cols.join(", ")})`).join(",\n");
}

/** Deletes every row of a mirror table that the generated set does not name. */
function deleteOthers(
  table: string,
  columns: readonly [string, string],
  rows: readonly (readonly string[])[],
): string {
  const [a, b] = columns;
  if (rows.length === 0) return `delete from ${table};`;
  return `delete from ${table} t
where not exists (
  select 1 from (values
${valuesBlock(rows.map((r) => [r[0] ?? "", r[1] ?? ""]))}
  ) as s (${a}, ${b})
  where s.${a} = t.${a} and s.${b} = t.${b}
);`;
}

/** An upsert of the rows followed by a blank line, or nothing when there are no rows. */
function upsert(target: string, rows: readonly (readonly string[])[], conflict: string): string {
  if (rows.length === 0) return "";
  return `insert into ${target} values
${valuesBlock(rows)}
on conflict ${conflict};

`;
}

/**
 * Renders the plan seed migration. Output is a pure function of the registry, so the same
 * YAML always yields byte-identical SQL. Every statement is an upsert or a set replacement,
 * so applying it after the rows 0201 seeds, or on its own, ends in the same state.
 * Besides plans, limits and features it writes the database mirrors of plans.yaml: monthly list
 * prices (wholesale billing, 1060), extra-seat prices and add-ons (1250), and the default partner
 * wholesale discount. Stripe lookup keys stay in plans.yaml; billing reads them there.
 */
export function renderPlanSeedSql(registry: PlanRegistry): string {
  const plans = registry.plans.map((p) => [literal(p.code), String(p.sortOrder)]);
  const limits = registry.plans.flatMap((p) =>
    registry.limits.map((l) => [
      literal(p.code),
      `${literal(l)}::app.plan_limit_code`,
      amount(p.limits[l]),
    ]),
  );
  const features = registry.plans.flatMap((p) =>
    p.features.map((f) => [literal(p.code), `${literal(f)}::app.plan_feature_code`]),
  );
  const listPrices = registry.plans.flatMap((p) =>
    PRICE_BOOK_CURRENCIES.map((c) => [
      literal(p.code),
      literal(c),
      amount(p.prices[c].monthlyMinor),
    ]),
  );
  const seatPrices = registry.plans.flatMap((p) =>
    p.extraSeat === null
      ? []
      : PRICE_BOOK_CURRENCIES.map((c) => [
          literal(p.code),
          literal(c),
          amount(p.extraSeat?.prices[c].monthlyMinor),
          amount(p.extraSeat?.prices[c].annualMinor),
        ]),
  );
  const addons = registry.addons.flatMap((a) =>
    a.plans.map((plan) => [
      literal(a.code),
      literal(plan),
      `${literal(a.limit)}::app.plan_limit_code`,
      String(a.amount),
    ]),
  );

  return `-- ${PLAN_SEED_FILE}
-- Generated from packages/schemas/plans.yaml by
-- \`pnpm --filter @xos/schemas generate:plans\`. Never edit by hand: the
-- @xos/schemas unit tests fail when this file differs from the generator output.
--
-- Plan registry version ${registry.version}: ${plans.length} plans, ${limits.length} plan limits,
-- ${features.length} plan features, ${listPrices.length} list prices, ${seatPrices.length} extra-seat prices, ${addons.length} add-on rows.
-- Upserts every plan, limit and feature and replaces each mirror as a set, so it ends in the
-- registry state whatever earlier seeds applied (ADR 0008, ADR 0018, ADR 0035).

-- Plans -----------------------------------------------------------------------

insert into app.plans (code, sort_order) values
${valuesBlock(plans)}
on conflict (code) do update set sort_order = excluded.sort_order;

-- Limits (null is unlimited) --------------------------------------------------

insert into private.plan_limits (plan_code, limit_code, limit_value) values
${valuesBlock(limits)}
on conflict (plan_code, limit_code) do update set limit_value = excluded.limit_value;

-- Features, replaced as a set -------------------------------------------------

insert into private.plan_features (plan_code, feature_code) values
${valuesBlock(features)}
on conflict (plan_code, feature_code) do nothing;

delete from private.plan_features f
where not exists (
  select 1 from (values
${valuesBlock(features)}
  ) as s (plan_code, feature_code)
  where s.plan_code = f.plan_code and s.feature_code = f.feature_code
);

-- Monthly list prices (null is unpriced, never zero) --------------------------

insert into private.plan_list_prices (plan_code, currency_code, monthly_minor) values
${valuesBlock(listPrices)}
on conflict (plan_code, currency_code) do update set monthly_minor = excluded.monthly_minor;

-- Extra-seat prices, replaced as a set ----------------------------------------

${upsert(
  "private.plan_extra_seat_prices (plan_code, currency_code, monthly_minor, annual_minor)",
  seatPrices,
  "(plan_code, currency_code) do update\n  set monthly_minor = excluded.monthly_minor, annual_minor = excluded.annual_minor",
)}${deleteOthers("private.plan_extra_seat_prices", ["plan_code", "currency_code"], seatPrices)}

-- Add-ons, replaced as a set --------------------------------------------------

${upsert(
  "private.plan_addons (addon_code, plan_code, limit_code, amount)",
  addons,
  "(addon_code, plan_code) do update\n  set limit_code = excluded.limit_code, amount = excluded.amount",
)}${deleteOthers("private.plan_addons", ["addon_code", "plan_code"], addons)}

-- Partner wholesale discount --------------------------------------------------

alter table app.partner_agreements
  alter column wholesale_discount_bps set default ${String(registry.partnerWholesaleDiscountBps)};
`;
}
