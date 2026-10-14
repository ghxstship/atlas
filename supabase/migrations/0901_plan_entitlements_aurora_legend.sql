-- 0901_plan_entitlements_aurora_legend.sql
-- Plan packaging (ADR 0020): Atlas is in every plan, and the tiers differ by Gateway reach,
-- the Aurora AI allowance and Legend. This adds the entitlement codes the plan seed 0902 uses.
-- Enum values are added in their own migration because Postgres cannot use a new enum value
-- in the transaction that adds it.

alter type app.plan_limit_code add value if not exists 'aurora_requests_per_month';
alter type app.plan_feature_code add value if not exists 'aurora_ai';
alter type app.plan_feature_code add value if not exists 'legend_early_access';

comment on type app.plan_limit_code is 'Countable plan limits of Section 16 and ADR 0020.';
comment on type app.plan_feature_code is 'Plan-gated features of Section 16 and ADR 0020.';
