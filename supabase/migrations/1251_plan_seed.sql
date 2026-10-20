-- 1251_plan_seed.sql
-- Generated from packages/schemas/plans.yaml by
-- `pnpm --filter @xos/schemas generate:plans`. Never edit by hand: the
-- @xos/schemas unit tests fail when this file differs from the generator output.
--
-- Plan registry version 1: 5 plans, 25 plan limits,
-- 55 plan features, 25 list prices, 15 extra-seat prices, 3 add-on rows.
-- Upserts every plan, limit and feature and replaces each mirror as a set, so it ends in the
-- registry state whatever earlier seeds applied (ADR 0008, ADR 0018, ADR 0035).

-- Plans -----------------------------------------------------------------------

insert into app.plans (code, sort_order) values
  ('access', 1),
  ('core', 2),
  ('pro', 3),
  ('team', 4),
  ('enterprise', 5)
on conflict (code) do update set sort_order = excluded.sort_order;

-- Limits (null is unlimited) --------------------------------------------------

insert into private.plan_limits (plan_code, limit_code, limit_value) values
  ('access', 'seats'::app.plan_limit_code, 1),
  ('access', 'active_projects'::app.plan_limit_code, 1),
  ('access', 'field_members'::app.plan_limit_code, 10),
  ('access', 'active_external_engagements_per_month'::app.plan_limit_code, 25),
  ('access', 'aurora_requests_per_month'::app.plan_limit_code, 0),
  ('core', 'seats'::app.plan_limit_code, 5),
  ('core', 'active_projects'::app.plan_limit_code, null),
  ('core', 'field_members'::app.plan_limit_code, null),
  ('core', 'active_external_engagements_per_month'::app.plan_limit_code, 250),
  ('core', 'aurora_requests_per_month'::app.plan_limit_code, 500),
  ('pro', 'seats'::app.plan_limit_code, 15),
  ('pro', 'active_projects'::app.plan_limit_code, null),
  ('pro', 'field_members'::app.plan_limit_code, null),
  ('pro', 'active_external_engagements_per_month'::app.plan_limit_code, 2500),
  ('pro', 'aurora_requests_per_month'::app.plan_limit_code, 2000),
  ('team', 'seats'::app.plan_limit_code, 40),
  ('team', 'active_projects'::app.plan_limit_code, null),
  ('team', 'field_members'::app.plan_limit_code, null),
  ('team', 'active_external_engagements_per_month'::app.plan_limit_code, null),
  ('team', 'aurora_requests_per_month'::app.plan_limit_code, 10000),
  ('enterprise', 'seats'::app.plan_limit_code, null),
  ('enterprise', 'active_projects'::app.plan_limit_code, null),
  ('enterprise', 'field_members'::app.plan_limit_code, null),
  ('enterprise', 'active_external_engagements_per_month'::app.plan_limit_code, null),
  ('enterprise', 'aurora_requests_per_month'::app.plan_limit_code, null)
on conflict (plan_code, limit_code) do update set limit_value = excluded.limit_value;

-- Features, replaced as a set -------------------------------------------------

insert into private.plan_features (plan_code, feature_code) values
  ('core', 'approvals'::app.plan_feature_code),
  ('core', 'advancing'::app.plan_feature_code),
  ('core', 'procurement'::app.plan_feature_code),
  ('core', 'upl_export'::app.plan_feature_code),
  ('core', 'aurora_ai'::app.plan_feature_code),
  ('pro', 'approvals'::app.plan_feature_code),
  ('pro', 'advancing'::app.plan_feature_code),
  ('pro', 'procurement'::app.plan_feature_code),
  ('pro', 'upl_export'::app.plan_feature_code),
  ('pro', 'white_label'::app.plan_feature_code),
  ('pro', 'custom_domain'::app.plan_feature_code),
  ('pro', 'automations'::app.plan_feature_code),
  ('pro', 'api_keys'::app.plan_feature_code),
  ('pro', 'webhooks'::app.plan_feature_code),
  ('pro', 'public_marketplace_listings'::app.plan_feature_code),
  ('pro', 'aurora_ai'::app.plan_feature_code),
  ('team', 'approvals'::app.plan_feature_code),
  ('team', 'advancing'::app.plan_feature_code),
  ('team', 'procurement'::app.plan_feature_code),
  ('team', 'upl_export'::app.plan_feature_code),
  ('team', 'white_label'::app.plan_feature_code),
  ('team', 'custom_domain'::app.plan_feature_code),
  ('team', 'automations'::app.plan_feature_code),
  ('team', 'api_keys'::app.plan_feature_code),
  ('team', 'webhooks'::app.plan_feature_code),
  ('team', 'public_marketplace_listings'::app.plan_feature_code),
  ('team', 'custom_roles'::app.plan_feature_code),
  ('team', 'ip_allowlist'::app.plan_feature_code),
  ('team', 'audit_export'::app.plan_feature_code),
  ('team', 'payroll_export'::app.plan_feature_code),
  ('team', 'priority_support'::app.plan_feature_code),
  ('team', 'aurora_ai'::app.plan_feature_code),
  ('enterprise', 'approvals'::app.plan_feature_code),
  ('enterprise', 'advancing'::app.plan_feature_code),
  ('enterprise', 'procurement'::app.plan_feature_code),
  ('enterprise', 'upl_export'::app.plan_feature_code),
  ('enterprise', 'white_label'::app.plan_feature_code),
  ('enterprise', 'custom_domain'::app.plan_feature_code),
  ('enterprise', 'automations'::app.plan_feature_code),
  ('enterprise', 'api_keys'::app.plan_feature_code),
  ('enterprise', 'webhooks'::app.plan_feature_code),
  ('enterprise', 'public_marketplace_listings'::app.plan_feature_code),
  ('enterprise', 'custom_roles'::app.plan_feature_code),
  ('enterprise', 'ip_allowlist'::app.plan_feature_code),
  ('enterprise', 'audit_export'::app.plan_feature_code),
  ('enterprise', 'payroll_export'::app.plan_feature_code),
  ('enterprise', 'priority_support'::app.plan_feature_code),
  ('enterprise', 'saml_sso'::app.plan_feature_code),
  ('enterprise', 'scim'::app.plan_feature_code),
  ('enterprise', 'eu_data_residency'::app.plan_feature_code),
  ('enterprise', 'branded_compass_build'::app.plan_feature_code),
  ('enterprise', 'sla_credits'::app.plan_feature_code),
  ('enterprise', 'support_session_controls'::app.plan_feature_code),
  ('enterprise', 'aurora_ai'::app.plan_feature_code),
  ('enterprise', 'legend_early_access'::app.plan_feature_code)
on conflict (plan_code, feature_code) do nothing;

delete from private.plan_features f
where not exists (
  select 1 from (values
  ('core', 'approvals'::app.plan_feature_code),
  ('core', 'advancing'::app.plan_feature_code),
  ('core', 'procurement'::app.plan_feature_code),
  ('core', 'upl_export'::app.plan_feature_code),
  ('core', 'aurora_ai'::app.plan_feature_code),
  ('pro', 'approvals'::app.plan_feature_code),
  ('pro', 'advancing'::app.plan_feature_code),
  ('pro', 'procurement'::app.plan_feature_code),
  ('pro', 'upl_export'::app.plan_feature_code),
  ('pro', 'white_label'::app.plan_feature_code),
  ('pro', 'custom_domain'::app.plan_feature_code),
  ('pro', 'automations'::app.plan_feature_code),
  ('pro', 'api_keys'::app.plan_feature_code),
  ('pro', 'webhooks'::app.plan_feature_code),
  ('pro', 'public_marketplace_listings'::app.plan_feature_code),
  ('pro', 'aurora_ai'::app.plan_feature_code),
  ('team', 'approvals'::app.plan_feature_code),
  ('team', 'advancing'::app.plan_feature_code),
  ('team', 'procurement'::app.plan_feature_code),
  ('team', 'upl_export'::app.plan_feature_code),
  ('team', 'white_label'::app.plan_feature_code),
  ('team', 'custom_domain'::app.plan_feature_code),
  ('team', 'automations'::app.plan_feature_code),
  ('team', 'api_keys'::app.plan_feature_code),
  ('team', 'webhooks'::app.plan_feature_code),
  ('team', 'public_marketplace_listings'::app.plan_feature_code),
  ('team', 'custom_roles'::app.plan_feature_code),
  ('team', 'ip_allowlist'::app.plan_feature_code),
  ('team', 'audit_export'::app.plan_feature_code),
  ('team', 'payroll_export'::app.plan_feature_code),
  ('team', 'priority_support'::app.plan_feature_code),
  ('team', 'aurora_ai'::app.plan_feature_code),
  ('enterprise', 'approvals'::app.plan_feature_code),
  ('enterprise', 'advancing'::app.plan_feature_code),
  ('enterprise', 'procurement'::app.plan_feature_code),
  ('enterprise', 'upl_export'::app.plan_feature_code),
  ('enterprise', 'white_label'::app.plan_feature_code),
  ('enterprise', 'custom_domain'::app.plan_feature_code),
  ('enterprise', 'automations'::app.plan_feature_code),
  ('enterprise', 'api_keys'::app.plan_feature_code),
  ('enterprise', 'webhooks'::app.plan_feature_code),
  ('enterprise', 'public_marketplace_listings'::app.plan_feature_code),
  ('enterprise', 'custom_roles'::app.plan_feature_code),
  ('enterprise', 'ip_allowlist'::app.plan_feature_code),
  ('enterprise', 'audit_export'::app.plan_feature_code),
  ('enterprise', 'payroll_export'::app.plan_feature_code),
  ('enterprise', 'priority_support'::app.plan_feature_code),
  ('enterprise', 'saml_sso'::app.plan_feature_code),
  ('enterprise', 'scim'::app.plan_feature_code),
  ('enterprise', 'eu_data_residency'::app.plan_feature_code),
  ('enterprise', 'branded_compass_build'::app.plan_feature_code),
  ('enterprise', 'sla_credits'::app.plan_feature_code),
  ('enterprise', 'support_session_controls'::app.plan_feature_code),
  ('enterprise', 'aurora_ai'::app.plan_feature_code),
  ('enterprise', 'legend_early_access'::app.plan_feature_code)
  ) as s (plan_code, feature_code)
  where s.plan_code = f.plan_code and s.feature_code = f.feature_code
);

-- Monthly list prices (null is unpriced, never zero) --------------------------

insert into private.plan_list_prices (plan_code, currency_code, monthly_minor) values
  ('access', 'USD', 0),
  ('access', 'EUR', 0),
  ('access', 'GBP', 0),
  ('access', 'CAD', 0),
  ('access', 'AUD', 0),
  ('core', 'USD', 14900),
  ('core', 'EUR', 13900),
  ('core', 'GBP', 11900),
  ('core', 'CAD', 19900),
  ('core', 'AUD', 22900),
  ('pro', 'USD', 39900),
  ('pro', 'EUR', 36900),
  ('pro', 'GBP', 31900),
  ('pro', 'CAD', 54900),
  ('pro', 'AUD', 60900),
  ('team', 'USD', 89900),
  ('team', 'EUR', 82900),
  ('team', 'GBP', 71900),
  ('team', 'CAD', 122900),
  ('team', 'AUD', 136900),
  ('enterprise', 'USD', null),
  ('enterprise', 'EUR', null),
  ('enterprise', 'GBP', null),
  ('enterprise', 'CAD', null),
  ('enterprise', 'AUD', null)
on conflict (plan_code, currency_code) do update set monthly_minor = excluded.monthly_minor;

-- Extra-seat prices, replaced as a set ----------------------------------------

insert into private.plan_extra_seat_prices (plan_code, currency_code, monthly_minor, annual_minor) values
  ('core', 'USD', 1900, 19000),
  ('core', 'EUR', 1800, 18000),
  ('core', 'GBP', 1500, 15000),
  ('core', 'CAD', 2600, 26000),
  ('core', 'AUD', 2900, 29000),
  ('pro', 'USD', 1900, 19000),
  ('pro', 'EUR', 1800, 18000),
  ('pro', 'GBP', 1500, 15000),
  ('pro', 'CAD', 2600, 26000),
  ('pro', 'AUD', 2900, 29000),
  ('team', 'USD', 1500, 15000),
  ('team', 'EUR', 1400, 14000),
  ('team', 'GBP', 1200, 12000),
  ('team', 'CAD', 2100, 21000),
  ('team', 'AUD', 2300, 23000)
on conflict (plan_code, currency_code) do update
  set monthly_minor = excluded.monthly_minor, annual_minor = excluded.annual_minor;

delete from private.plan_extra_seat_prices t
where not exists (
  select 1 from (values
  ('core', 'USD'),
  ('core', 'EUR'),
  ('core', 'GBP'),
  ('core', 'CAD'),
  ('core', 'AUD'),
  ('pro', 'USD'),
  ('pro', 'EUR'),
  ('pro', 'GBP'),
  ('pro', 'CAD'),
  ('pro', 'AUD'),
  ('team', 'USD'),
  ('team', 'EUR'),
  ('team', 'GBP'),
  ('team', 'CAD'),
  ('team', 'AUD')
  ) as s (plan_code, currency_code)
  where s.plan_code = t.plan_code and s.currency_code = t.currency_code
);

-- Add-ons, replaced as a set --------------------------------------------------

insert into private.plan_addons (addon_code, plan_code, limit_code, amount) values
  ('aurora_requests_1000', 'core', 'aurora_requests_per_month'::app.plan_limit_code, 1000),
  ('aurora_requests_1000', 'pro', 'aurora_requests_per_month'::app.plan_limit_code, 1000),
  ('aurora_requests_1000', 'team', 'aurora_requests_per_month'::app.plan_limit_code, 1000)
on conflict (addon_code, plan_code) do update
  set limit_code = excluded.limit_code, amount = excluded.amount;

delete from private.plan_addons t
where not exists (
  select 1 from (values
  ('aurora_requests_1000', 'core'),
  ('aurora_requests_1000', 'pro'),
  ('aurora_requests_1000', 'team')
  ) as s (addon_code, plan_code)
  where s.addon_code = t.addon_code and s.plan_code = t.plan_code
);

-- Partner wholesale discount --------------------------------------------------

alter table app.partner_agreements
  alter column wholesale_discount_bps set default 3000;
