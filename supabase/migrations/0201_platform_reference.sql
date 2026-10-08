-- 0201_platform_reference.sql
-- A02 Platform Data. Closed lists and platform reference data for tenancy and access:
-- capability vocabulary (filled by the generated 0203 seed), plans and their limits
-- (Section 16), subscription states and transitions (Section 3.12, lifecycle 8), and the
-- org slugs that routes reserve (Section 4.5.3).

-- Enums --------------------------------------------------------------------------------

create type app.nav_group as enum (
  'workspace', 'production', 'operations', 'people', 'commercial', 'knowledge', 'footer', 'settings', 'personal'
);
comment on type app.nav_group is 'Atlas sidebar groups (Section 4.5.2) plus the org and personal settings trees. Values match packages/schemas NAV_GROUPS.';

create type app.capability_class as enum ('read', 'write', 'approve', 'manage', 'export');
comment on type app.capability_class is 'Kind of act a capability authorizes. Values match packages/schemas CAPABILITY_CLASSES.';

create type app.capability_reach as enum ('own', 'assigned', 'organization');
comment on type app.capability_reach is 'How far a grant reaches, narrowest first so comparison orders by breadth: own rows, assigned scopes, or the whole org. Values match packages/schemas CAPABILITY_REACHES.';

create type app.subscription_state as enum ('trialing', 'active', 'past_due', 'read_only', 'canceled');
comment on type app.subscription_state is 'Subscription lifecycle (Section 3.12, lifecycle 8; Section 16 dunning makes an org read-only on day 21).';

create type app.grant_target_kind as enum ('organization', 'workspace', 'team', 'project', 'record');
comment on type app.grant_target_kind is 'What a scoped grant or record grant points at. private.scope_org resolves the owning org of each kind.';

create type app.plan_limit_code as enum (
  'seats', 'active_projects', 'field_members', 'active_external_engagements_per_month'
);
comment on type app.plan_limit_code is 'Countable plan limits of Section 16.';

create type app.plan_feature_code as enum (
  'approvals', 'advancing', 'procurement', 'upl_export',
  'white_label', 'custom_domain', 'automations', 'api_keys', 'webhooks', 'public_marketplace_listings',
  'custom_roles', 'ip_allowlist', 'audit_export', 'payroll_export', 'priority_support',
  'saml_sso', 'scim', 'eu_data_residency', 'branded_compass_build', 'sla_credits', 'support_session_controls'
);
comment on type app.plan_feature_code is 'Plan-gated features of Section 16.';

-- Capability vocabulary -------------------------------------------------------------------
-- Rows come only from the generated migration 0203 (packages/schemas/capabilities.yaml).

create table app.capability_modules (
  code text primary key,
  nav_group app.nav_group not null,
  project_scoped boolean not null,
  sort_order integer not null unique,
  constraint capability_modules_code_format check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table app.capability_modules is 'Modules that group capabilities, generated from packages/schemas/capabilities.yaml. Platform reference data, not tenant data.';
comment on column app.capability_modules.code is 'Module code, the first segment of every capability code in the module.';
comment on column app.capability_modules.nav_group is 'Sidebar or settings group the module belongs to.';
comment on column app.capability_modules.project_scoped is 'True when the module''s records belong to projects, so a Member''s writes reach only assigned projects.';
comment on column app.capability_modules.sort_order is 'Registry order, used as the default sort.';

create table app.capabilities (
  code text primary key,
  module_code text not null references app.capability_modules (code),
  capability_class app.capability_class not null,
  description text not null,
  sort_order integer not null unique,
  constraint capabilities_code_format check (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,4}$'),
  constraint capabilities_code_in_module check (split_part(code, '.', 1) = module_code)
);

create index capabilities_module_code_idx on app.capabilities (module_code);

comment on table app.capabilities is 'Fine-grained capability verbs (Section 8), generated from packages/schemas/capabilities.yaml. Platform reference data, not tenant data.';
comment on column app.capabilities.code is 'Capability code, for example finance.po.approve. RLS calls private.has_capability with it.';
comment on column app.capabilities.module_code is 'Module the capability belongs to.';
comment on column app.capabilities.capability_class is 'Kind of act the capability authorizes.';
comment on column app.capabilities.description is 'Sentence-case description of what the capability allows, for documentation and the roles page.';
comment on column app.capabilities.sort_order is 'Registry order, used as the default sort.';

-- Plans (Section 16) -----------------------------------------------------------------------

create table app.plans (
  code text primary key,
  sort_order smallint not null unique,
  constraint plans_code_format check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table app.plans is 'Subscription plans of Section 16. Display names come from the i18n catalogs keyed by code.';
comment on column app.plans.code is 'Plan code.';
comment on column app.plans.sort_order is 'Plan order from the free plan upward.';

insert into app.plans (code, sort_order) values
  ('access', 1),
  ('core', 2),
  ('pro', 3),
  ('team', 4),
  ('enterprise', 5);

create table private.plan_limits (
  plan_code text not null references app.plans (code),
  limit_code app.plan_limit_code not null,
  limit_value bigint,
  primary key (plan_code, limit_code),
  constraint plan_limits_value_positive check (limit_value is null or limit_value >= 0)
);

comment on table private.plan_limits is 'Countable limits per plan (Section 16). A null limit_value means unlimited. Enforced in SQL through private.org_plan_limits.';
comment on column private.plan_limits.plan_code is 'Plan the limit applies to.';
comment on column private.plan_limits.limit_code is 'Which countable limit.';
comment on column private.plan_limits.limit_value is 'Maximum allowed count, or null for unlimited.';

insert into private.plan_limits (plan_code, limit_code, limit_value) values
  ('access', 'seats', 1),
  ('access', 'active_projects', 2),
  ('access', 'field_members', 10),
  ('access', 'active_external_engagements_per_month', 25),
  ('core', 'seats', null),
  ('core', 'active_projects', null),
  ('core', 'field_members', null),
  ('core', 'active_external_engagements_per_month', 250),
  ('pro', 'seats', null),
  ('pro', 'active_projects', null),
  ('pro', 'field_members', null),
  ('pro', 'active_external_engagements_per_month', 2500),
  ('team', 'seats', null),
  ('team', 'active_projects', null),
  ('team', 'field_members', null),
  ('team', 'active_external_engagements_per_month', null),
  ('enterprise', 'seats', null),
  ('enterprise', 'active_projects', null),
  ('enterprise', 'field_members', null),
  ('enterprise', 'active_external_engagements_per_month', null);

create table private.plan_features (
  plan_code text not null references app.plans (code),
  feature_code app.plan_feature_code not null,
  primary key (plan_code, feature_code)
);

create index plan_features_feature_code_idx on private.plan_features (feature_code);

comment on table private.plan_features is 'Features each plan includes (Section 16). Absence of a row means the plan does not include the feature.';
comment on column private.plan_features.plan_code is 'Plan that includes the feature.';
comment on column private.plan_features.feature_code is 'Included feature.';

insert into private.plan_features (plan_code, feature_code)
select p.plan_code, f.feature_code::app.plan_feature_code
from (values ('core'), ('pro'), ('team'), ('enterprise')) as p (plan_code)
cross join (values ('approvals'), ('advancing'), ('procurement'), ('upl_export')) as f (feature_code)
union all
select p.plan_code, f.feature_code::app.plan_feature_code
from (values ('pro'), ('team'), ('enterprise')) as p (plan_code)
cross join (values ('white_label'), ('custom_domain'), ('automations'), ('api_keys'), ('webhooks'),
  ('public_marketplace_listings')) as f (feature_code)
union all
select p.plan_code, f.feature_code::app.plan_feature_code
from (values ('team'), ('enterprise')) as p (plan_code)
cross join (values ('custom_roles'), ('ip_allowlist'), ('audit_export'), ('payroll_export'),
  ('priority_support')) as f (feature_code)
union all
select 'enterprise', f.feature_code::app.plan_feature_code
from (values ('saml_sso'), ('scim'), ('eu_data_residency'), ('branded_compass_build'), ('sla_credits'),
  ('support_session_controls')) as f (feature_code);

-- Subscription transitions -------------------------------------------------------------------

create table app.subscription_state_transition_rules (
  from_state app.subscription_state not null,
  to_state app.subscription_state not null,
  primary key (from_state, to_state),
  constraint subscription_transition_rules_distinct check (from_state <> to_state)
);

create index subscription_state_transition_rules_to_state_idx on app.subscription_state_transition_rules (to_state);

comment on table app.subscription_state_transition_rules is 'Allowed subscription state transitions. Canceled is terminal; a returning org starts a new subscription.';
comment on column app.subscription_state_transition_rules.from_state is 'State the subscription is leaving.';
comment on column app.subscription_state_transition_rules.to_state is 'State the subscription may enter from from_state.';

insert into app.subscription_state_transition_rules (from_state, to_state) values
  ('trialing', 'active'),
  ('trialing', 'canceled'),
  ('active', 'past_due'),
  ('active', 'canceled'),
  ('past_due', 'active'),
  ('past_due', 'read_only'),
  ('past_due', 'canceled'),
  ('read_only', 'active'),
  ('read_only', 'canceled');

-- Reserved org slugs (Section 4.5.3) ----------------------------------------------------------

create table private.reserved_org_slugs (
  slug text primary key
);

comment on table private.reserved_org_slugs is 'First URL segments that routes already use, so no org may take them as its slug.';
comment on column private.reserved_org_slugs.slug is 'Reserved slug.';

insert into private.reserved_org_slugs (slug) values
  ('advance'), ('api'), ('app'), ('auth'), ('c'), ('docs'), ('explore'), ('help'), ('home'), ('ical'),
  ('legal'), ('login'), ('me'), ('messages'), ('money'), ('partner'), ('profile'), ('settings'),
  ('sign'), ('signup'), ('status'), ('support'), ('u'), ('work'), ('www');

-- Privileges --------------------------------------------------------------------------------

alter table app.capability_modules enable row level security;
alter table app.capabilities enable row level security;
alter table app.plans enable row level security;
alter table app.subscription_state_transition_rules enable row level security;
alter table private.plan_limits enable row level security;
alter table private.plan_features enable row level security;
alter table private.reserved_org_slugs enable row level security;

revoke all on app.capability_modules, app.capabilities, app.plans, app.subscription_state_transition_rules
  from public, anon, authenticated;
grant select on app.capability_modules, app.capabilities, app.plans, app.subscription_state_transition_rules
  to authenticated;
grant select on app.capability_modules, app.capabilities, app.plans, app.subscription_state_transition_rules
  to service_role;

create policy capability_modules_read on app.capability_modules
  for select to authenticated using (true);
create policy capabilities_read on app.capabilities
  for select to authenticated using (true);
create policy plans_read on app.plans
  for select to authenticated using (true);
create policy subscription_state_transition_rules_read on app.subscription_state_transition_rules
  for select to authenticated using (true);

revoke all on private.plan_limits, private.plan_features, private.reserved_org_slugs
  from public, anon, authenticated;
grant select on private.plan_limits, private.plan_features, private.reserved_org_slugs to service_role;
