import type { PlanRegistry } from "./model.ts";

/** Repository-relative path of the generated plan seed migration (ADR 0004 range 0200 to 0299). */
export const PLAN_SEED_MIGRATION = "supabase/migrations/0207_plan_seed.sql";

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function valuesBlock(rows: readonly (readonly string[])[]): string {
  return rows.map((cols) => `  (${cols.join(", ")})`).join(",\n");
}

/**
 * Renders the plan seed migration. Output is a pure function of the registry, so the same
 * YAML always yields byte-identical SQL. Every statement is an upsert or a set replacement,
 * so applying it after the rows 0201 seeds, or on its own, ends in the same state.
 * Price books have no table yet; they are read from plans.yaml by billing (A18).
 */
export function renderPlanSeedSql(registry: PlanRegistry): string {
  const plans = registry.plans.map((p) => [literal(p.code), String(p.sortOrder)]);
  const limits = registry.plans.flatMap((p) =>
    registry.limits.map((l) => [
      literal(p.code),
      `${literal(l)}::app.plan_limit_code`,
      p.limits[l] === null || p.limits[l] === undefined ? "null" : String(p.limits[l]),
    ]),
  );
  const features = registry.plans.flatMap((p) =>
    p.features.map((f) => [literal(p.code), `${literal(f)}::app.plan_feature_code`]),
  );

  return `-- 0207_plan_seed.sql
-- Generated from packages/schemas/plans.yaml by
-- \`pnpm --filter @xos/schemas generate:plans\`. Never edit by hand: the
-- @xos/schemas unit tests fail when this file differs from the generator output.
--
-- Plan registry version ${registry.version}: ${plans.length} plans, ${limits.length} plan limits,
-- ${features.length} plan features. Upserts the rows 0201_platform_reference.sql seeds, so
-- plans.yaml is the single source from here on (ADR 0008).

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
`;
}
