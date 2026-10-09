-- 0207_plan_seed.sql
-- Generated from packages/schemas/plans.yaml by
-- `pnpm --filter @xos/schemas generate:plans`. Never edit by hand: the
-- @xos/schemas unit tests fail when this file differs from the generator output.
--
-- Plan registry version 1: 5 plans, 20 plan limits,
-- 50 plan features. Upserts the rows 0201_platform_reference.sql seeds, so
-- plans.yaml is the single source from here on (ADR 0008).

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
  ('access', 'active_projects'::app.plan_limit_code, 2),
  ('access', 'field_members'::app.plan_limit_code, 10),
  ('access', 'active_external_engagements_per_month'::app.plan_limit_code, 25),
  ('core', 'seats'::app.plan_limit_code, null),
  ('core', 'active_projects'::app.plan_limit_code, null),
  ('core', 'field_members'::app.plan_limit_code, null),
  ('core', 'active_external_engagements_per_month'::app.plan_limit_code, 250),
  ('pro', 'seats'::app.plan_limit_code, null),
  ('pro', 'active_projects'::app.plan_limit_code, null),
  ('pro', 'field_members'::app.plan_limit_code, null),
  ('pro', 'active_external_engagements_per_month'::app.plan_limit_code, 2500),
  ('team', 'seats'::app.plan_limit_code, null),
  ('team', 'active_projects'::app.plan_limit_code, null),
  ('team', 'field_members'::app.plan_limit_code, null),
  ('team', 'active_external_engagements_per_month'::app.plan_limit_code, null),
  ('enterprise', 'seats'::app.plan_limit_code, null),
  ('enterprise', 'active_projects'::app.plan_limit_code, null),
  ('enterprise', 'field_members'::app.plan_limit_code, null),
  ('enterprise', 'active_external_engagements_per_month'::app.plan_limit_code, null)
on conflict (plan_code, limit_code) do update set limit_value = excluded.limit_value;

-- Features, replaced as a set -------------------------------------------------

insert into private.plan_features (plan_code, feature_code) values
  ('core', 'approvals'::app.plan_feature_code),
  ('core', 'advancing'::app.plan_feature_code),
  ('core', 'procurement'::app.plan_feature_code),
  ('core', 'upl_export'::app.plan_feature_code),
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
  ('enterprise', 'support_session_controls'::app.plan_feature_code)
on conflict (plan_code, feature_code) do nothing;

delete from private.plan_features f
where not exists (
  select 1 from (values
  ('core', 'approvals'::app.plan_feature_code),
  ('core', 'advancing'::app.plan_feature_code),
  ('core', 'procurement'::app.plan_feature_code),
  ('core', 'upl_export'::app.plan_feature_code),
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
  ('enterprise', 'support_session_controls'::app.plan_feature_code)
  ) as s (plan_code, feature_code)
  where s.plan_code = f.plan_code and s.feature_code = f.feature_code
);
