-- 1471_console_tenants_plans_flags.sql
-- A90 operator console (RRR-135, finding A65-009; Section 4.10 "tenant search, plan overrides and feature flags",
-- Section 16): what the platform team reads and changes about a tenant without ever opening its records.
--   * app.console_search_orgs and app.console_org_detail (tenants.read): orgs by name, slug, Owner email and plan,
--     and one org's plan, subscription, status, usage, limits, features, flags, overrides, Owners and support
--     sessions. Billing and identity facts only: records stay closed without a support session (1472).
--   * app.plan_overrides: an operator's time-boxed change to an org's plan (Plan), to one plan feature (Feature) or
--     to one countable limit (Limit), with a reason and an expiry of at most a year, ended early at most once.
--     private.org_plan_limits (latest: 1250) and private.org_has_feature (latest: 0204) apply live overrides, so
--     every limit and feature check follows them. Billing, Stripe and the support channel keep the subscription's
--     own plan.
--   * flag overrides over app.feature_flag_overrides (0540): set and cleared by operators (flags.write) with a
--     reason and an expiry; the kill switch (flags.kill_switch) turns a feature off everywhere.
-- Every change is written by its operator's session, so the row's audit trail lands in the tenant's audit ledger
-- with the operator as the actor, and in app.platform_operator_actions (1470).

-- Plan overrides -----------------------------------------------------------------------------------------------------

create type app.plan_override_kind as enum ('Plan', 'Feature', 'Limit');
comment on type app.plan_override_kind is 'What a plan override changes (A90): the whole plan, one plan feature, or one countable limit.';

create table app.plan_overrides (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  override_kind app.plan_override_kind not null,
  plan_code text references app.plans (code),
  feature_code app.plan_feature_code,
  feature_enabled boolean,
  limit_code app.plan_limit_code,
  limit_value bigint,
  reason text not null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  ended_by uuid references app.people (id),
  end_reason text,
  constraint plan_overrides_shape check (
    (override_kind = 'Plan' and plan_code is not null and feature_code is null and feature_enabled is null
      and limit_code is null and limit_value is null)
    or (override_kind = 'Feature' and feature_code is not null and feature_enabled is not null and plan_code is null
      and limit_code is null and limit_value is null)
    or (override_kind = 'Limit' and limit_code is not null and plan_code is null and feature_code is null
      and feature_enabled is null)),
  constraint plan_overrides_limit_value check (limit_value is null or limit_value >= 0),
  constraint plan_overrides_window check (expires_at > starts_at and expires_at <= starts_at + interval '366 days'),
  constraint plan_overrides_reason_length check (char_length(btrim(reason)) between 1 and 500),
  constraint plan_overrides_ended check ((ended_at is null) = (end_reason is null)
    and (ended_by is null or ended_at is not null)),
  constraint plan_overrides_end_reason_length check (end_reason is null or char_length(btrim(end_reason)) between 1 and 500)
);

create index plan_overrides_plan_code_idx on app.plan_overrides (plan_code);
create index plan_overrides_ended_by_idx on app.plan_overrides (ended_by);

call private.install_domain_table('app.plan_overrides');
create unique index plan_overrides_one_plan on app.plan_overrides (org_id)
  where override_kind = 'Plan' and ended_at is null and deleted_at is null;
create unique index plan_overrides_one_feature on app.plan_overrides (org_id, feature_code)
  where override_kind = 'Feature' and ended_at is null and deleted_at is null;
create unique index plan_overrides_one_limit on app.plan_overrides (org_id, limit_code)
  where override_kind = 'Limit' and ended_at is null and deleted_at is null;
call private.describe('app.plan_overrides', 'An operator''s time-boxed change to an org''s plan (A90, Section 16): the whole plan, one plan feature on or off, or one countable limit. Written only by the console RPCs with a reason and an expiry of at most a year; ended early at most once. Live overrides drive private.org_plan_limits and private.org_has_feature; billing keeps the subscription''s plan.', array[
  'override_kind', 'Plan, Feature or Limit.',
  'plan_code', 'Plan the org is held to while a Plan override lasts.',
  'feature_code', 'Plan feature a Feature override turns on or off.',
  'feature_enabled', 'Whether a Feature override turns the feature on (true) or off (false).',
  'limit_code', 'Countable limit a Limit override sets.',
  'limit_value', 'Limit in force while a Limit override lasts; null is unlimited.',
  'reason', 'Why the platform team made the override.',
  'starts_at', 'When the override began.',
  'expires_at', 'When the override stops applying, at most a year after it began.',
  'ended_at', 'When an operator ended the override early, or a newer override replaced it.',
  'ended_by', 'Operator who ended it early.',
  'end_reason', 'Why it ended early.'
]);

call private.install_policies('app.plan_overrides',
  $$org_id in (select private.orgs_with_capability('org.billing.read'))$$);
call private.install_audit_trail('app.plan_overrides');
call private.install_default_retention('app.plan_overrides');

create or replace function private.guard_plan_override()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.override_kind <> old.override_kind or new.plan_code is distinct from old.plan_code
      or new.feature_code is distinct from old.feature_code or new.feature_enabled is distinct from old.feature_enabled
      or new.limit_code is distinct from old.limit_code or new.limit_value is distinct from old.limit_value
      or new.reason <> old.reason or new.starts_at <> old.starts_at or new.expires_at <> old.expires_at
      or (old.ended_at is not null and (new.ended_at is distinct from old.ended_at
          or new.end_reason is distinct from old.end_reason or new.ended_by is distinct from old.ended_by))) then
    perform private.refuse('plan_override_immutable', 'A plan override keeps its change, reason and window; it can only be ended early, once.');
  end if;
  return new;
end;
$$;

comment on function private.guard_plan_override() is 'Plan overrides keep their change, reason and window; ending early happens once.';
revoke all on function private.guard_plan_override() from public, anon, authenticated;

create trigger t40_guard_plan_override before update on app.plan_overrides
  for each row execute function private.guard_plan_override();

-- Effective limits and features (latest definitions: private.org_plan_limits 1250, private.org_has_feature 0204) -----

create or replace view private.org_plan_limits as
select o.id as org_id, p.plan_code, pl.limit_code,
  case
    when lo.id is not null then lo.limit_value
    when pl.limit_value is null then null
    when pl.limit_code = 'seats' and p.seats_grandfathered then null
    when pl.limit_code = 'seats' then pl.limit_value + p.extra_seats
    else pl.limit_value + coalesce((
      select sum(a.amount::bigint * ap.quantity)
      from app.addon_purchases ap
      join private.plan_addons a on a.addon_code = ap.addon_code and a.plan_code = p.plan_code
      where ap.org_id = o.id and ap.deleted_at is null and a.limit_code = pl.limit_code
        and ap.applies_month = (date_trunc('month', now() at time zone 'UTC'))::date
    ), 0)
  end::bigint as limit_value
from app.organizations o
cross join lateral (
  select coalesce(po.plan_code, s.plan_code, 'access') as plan_code,
    coalesce(s.extra_seats, 0) as extra_seats,
    coalesce(s.seats_grandfathered, false) as seats_grandfathered
  from (select 1) as one
  left join app.subscriptions s
    on s.org_id = o.id and s.subscription_state <> 'canceled' and s.deleted_at is null
  left join lateral (
    select x.plan_code from app.plan_overrides x
    where x.org_id = o.id and x.override_kind = 'Plan' and x.ended_at is null and x.deleted_at is null
      and x.starts_at <= now() and x.expires_at > now()
    order by x.starts_at desc limit 1
  ) po on true
) p
join private.plan_limits pl on pl.plan_code = p.plan_code
left join lateral (
  select x.id, x.limit_value from app.plan_overrides x
  where x.org_id = o.id and x.override_kind = 'Limit' and x.limit_code = pl.limit_code and x.ended_at is null
    and x.deleted_at is null and x.starts_at <= now() and x.expires_at > now()
  order by x.starts_at desc limit 1
) lo on true;

comment on view private.org_plan_limits is 'Each org''s effective plan limits. The plan is a live Plan override''s (A90, 1471), else the current subscription''s, else Access. Seats are the plan allowance plus the extra seats bought, or unlimited for a grandfathered subscription; a limit an add-on raises adds this UTC month''s purchases (ADR 0035); a live Limit override replaces the limit outright (null is unlimited). Downgrades never delete data.';
comment on column private.org_plan_limits.org_id is 'Organization.';
comment on column private.org_plan_limits.plan_code is 'Plan in force: a live Plan override''s, the current subscription''s, or access.';
comment on column private.org_plan_limits.limit_code is 'Countable limit.';
comment on column private.org_plan_limits.limit_value is 'Maximum count in force, or null for unlimited.';

create or replace function private.org_has_feature(p_org_id uuid, p_feature app.plan_feature_code)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select x.feature_enabled from app.plan_overrides x
     where x.org_id = p_org_id and x.override_kind = 'Feature' and x.feature_code = p_feature and x.ended_at is null
       and x.deleted_at is null and x.starts_at <= now() and x.expires_at > now()
     order by x.starts_at desc limit 1),
    exists (
      select 1 from private.plan_features f
      where f.feature_code = p_feature
        and f.plan_code = (select distinct l.plan_code from private.org_plan_limits l where l.org_id = p_org_id)
    ));
$$;

comment on function private.org_has_feature(uuid, app.plan_feature_code) is 'True when a live Feature override turns the feature on for the org (A90, 1471), or, without one, when the org''s plan in force includes it. A Feature override that turns it off wins over the plan.';

-- Tenant search and detail -------------------------------------------------------------------------------------------

create or replace function private.like_pattern(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select '%' || replace(replace(replace(btrim(coalesce(p_text, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
$$;

comment on function private.like_pattern(text) is 'A case-insensitive contains pattern for ILIKE with the text''s own %, _ and \ escaped.';
revoke all on function private.like_pattern(text) from public, anon, authenticated;

create or replace function private.org_owner_people(p_org_id uuid)
returns table (person_id uuid, full_name text, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (p.id) p.id, p.full_name, u.email::text
  from app.memberships m
  join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
  join app.roles r on r.id = mr.role_id and r.org_id is null and r.code = 'owner'
  join app.people p on p.id = m.person_id
  left join auth.users u on u.id = p.user_id
  where m.org_id = p_org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
$$;

comment on function private.org_owner_people(uuid) is 'The active Owners of an org with their sign-in email.';
revoke all on function private.org_owner_people(uuid) from public, anon, authenticated;

create or replace function app.console_search_orgs(p_query text default null, p_plan_code text default null, p_limit integer default 50)
returns table (
  org_id uuid,
  name text,
  slug text,
  plan_code text,
  subscription_plan_code text,
  subscription_state app.subscription_state,
  owner_name text,
  owner_email text,
  seats bigint,
  canceled boolean,
  parent_org_name text,
  created_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pattern text := private.like_pattern(p_query);
begin
  perform private.require_platform_operator('tenants.read');
  if p_plan_code is not null and not exists (select 1 from app.plans pl where pl.code = p_plan_code) then
    perform private.refuse('console_unknown_plan', 'Choose a plan from the list.');
  end if;
  if char_length(btrim(coalesce(p_query, ''))) > 200 then
    perform private.refuse('console_query_length', 'Search with up to 200 characters.');
  end if;
  perform private.log_operator_action('organization.searched', null, null, null, null,
    jsonb_build_object('query', btrim(coalesce(p_query, '')), 'plan', p_plan_code));
  return query
  select o.id, o.name, o.slug, ep.plan_code, s.plan_code, s.subscription_state, ow.full_name, ow.email,
    (select c.seats from private.membership_band_counts(o.id) c), private.org_read_only(o.id), parent.name, o.created_at
  from app.organizations o
  left join app.organizations parent on parent.id = o.parent_org_id
  left join app.subscriptions s on s.org_id = o.id and s.subscription_state <> 'canceled' and s.deleted_at is null
  cross join lateral (select distinct l.plan_code from private.org_plan_limits l where l.org_id = o.id) ep
  left join lateral (select x.full_name, x.email from private.org_owner_people(o.id) x order by x.email limit 1) ow on true
  where o.deleted_at is null
    and (p_plan_code is null or ep.plan_code = p_plan_code)
    and (btrim(coalesce(p_query, '')) = ''
      or o.name ilike v_pattern or o.slug ilike v_pattern
      or exists (select 1 from private.org_owner_people(o.id) x where x.email ilike v_pattern))
  order by (lower(o.name) = lower(btrim(coalesce(p_query, '')))
            or lower(o.slug) = lower(btrim(coalesce(p_query, '')))) desc, o.name
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

comment on function app.console_search_orgs(text, text, integer) is 'Tenant search for the operator console (tenants.read): orgs whose name, slug or Owner email contains the query, optionally on one plan in force, exact name or slug first. Returns billing and identity facts only; each search is logged.';
revoke all on function app.console_search_orgs(text, text, integer) from public, anon;
grant execute on function app.console_search_orgs(text, text, integer) to authenticated;

create or replace function app.console_org_detail(p_org_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org app.organizations;
  v_plan text;
  v_month timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_result jsonb;
begin
  perform private.require_platform_operator('tenants.read');
  select * into v_org from app.organizations o where o.id = p_org_id and o.deleted_at is null;
  if v_org.id is null then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  select distinct l.plan_code into v_plan from private.org_plan_limits l where l.org_id = v_org.id;
  perform private.log_operator_action('organization.viewed', v_org.id, 'app.organizations', v_org.id, null, '{}'::jsonb);

  select jsonb_build_object(
    'org', jsonb_build_object('id', v_org.id, 'name', v_org.name, 'slug', v_org.slug, 'created_at', v_org.created_at,
      'parent', (select jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug)
                 from app.organizations p where p.id = v_org.parent_org_id),
      'client_count', (select count(*) from app.organizations c where c.parent_org_id = v_org.id and c.deleted_at is null)),
    'plan', jsonb_build_object(
      'plan_code', v_plan,
      'subscription', (select jsonb_build_object('plan_code', s.plan_code, 'state', s.subscription_state,
                         'extra_seats', s.extra_seats, 'grandfathered', s.seats_grandfathered, 'since', s.created_at)
                       from app.subscriptions s
                       where s.org_id = v_org.id and s.subscription_state <> 'canceled' and s.deleted_at is null)),
    'status', jsonb_build_object(
      'read_only', private.org_read_only(v_org.id),
      'cancellation', (select jsonb_build_object('canceled_at', c.canceled_at, 'read_only_until', c.read_only_until,
                         'purge_after', c.purge_after)
                       from app.org_cancellations c
                       where c.org_id = v_org.id and c.reactivated_at is null and c.deleted_at is null)),
    'usage', jsonb_build_object(
      'seats', (select c.seats from private.membership_band_counts(v_org.id) c),
      'field_members', (select c.field_members from private.membership_band_counts(v_org.id) c),
      'active_projects', (select count(*) from app.projects p
                          where p.org_id = v_org.id and p.deleted_at is null and p.archived_at is null
                            and p.project_state in ('Proposed', 'Active', 'Blocked')),
      -- Usage meters roll up per UTC month, the billing month of add-ons and wholesale statements (1060, 1250).
      'month_start', v_month,
      'meters', coalesce((select jsonb_agg(jsonb_build_object('meter_code', u.meter_code, 'quantity', u.quantity)
                                  order by u.meter_code)
                          from (select e.meter_code, sum(e.quantity)::bigint as quantity from app.usage_events e
                                where e.org_id = v_org.id and e.created_at >= v_month
                                group by e.meter_code) u), '[]'::jsonb)),
    'limits', coalesce((select jsonb_agg(jsonb_build_object('limit_code', l.limit_code, 'limit_value', l.limit_value,
                          'plan_value', pl.limit_value) order by l.limit_code)
                        from private.org_plan_limits l
                        join private.plan_limits pl on pl.plan_code = l.plan_code and pl.limit_code = l.limit_code
                        where l.org_id = v_org.id), '[]'::jsonb),
    'features', coalesce((select jsonb_agg(jsonb_build_object('feature_code', f.code,
                            'enabled', private.org_has_feature(v_org.id, f.code),
                            'in_plan', exists (select 1 from private.plan_features pf
                                               where pf.plan_code = v_plan and pf.feature_code = f.code))
                            order by f.code)
                          from unnest(enum_range(null::app.plan_feature_code)) as f (code)), '[]'::jsonb),
    'flags', coalesce((select jsonb_agg(jsonb_build_object('flag_key', ff.flag_key, 'description', ff.description,
                         'default_enabled', ff.default_enabled, 'kill_switch', ff.kill_switch,
                         'required_plan_feature', ff.required_plan_feature,
                         'enabled', private.flag_enabled(v_org.id, ff.flag_key),
                         'override', (select jsonb_build_object('id', o.id, 'enabled', o.enabled, 'reason', o.reason,
                                        'expires_at', o.expires_at, 'set_by', p.full_name, 'set_at', o.created_at,
                                        'live', o.expires_at is null or o.expires_at > now())
                                      from app.feature_flag_overrides o left join app.people p on p.id = o.created_by
                                      where o.org_id = v_org.id and o.flag_key = ff.flag_key and o.deleted_at is null))
                         order by ff.flag_key)
                       from private.feature_flags ff), '[]'::jsonb),
    'plan_overrides', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.override_kind,
                                  'plan_code', x.plan_code, 'feature_code', x.feature_code,
                                  'feature_enabled', x.feature_enabled, 'limit_code', x.limit_code,
                                  'limit_value', x.limit_value, 'reason', x.reason, 'starts_at', x.starts_at,
                                  'expires_at', x.expires_at, 'ended_at', x.ended_at, 'end_reason', x.end_reason,
                                  'set_by', p.full_name,
                                  'live', x.ended_at is null and x.starts_at <= now() and x.expires_at > now())
                                  order by x.starts_at desc)
                                from (select * from app.plan_overrides y
                                      where y.org_id = v_org.id and y.deleted_at is null
                                      order by y.starts_at desc limit 20) x
                                left join app.people p on p.id = x.created_by), '[]'::jsonb),
    'owners', coalesce((select jsonb_agg(jsonb_build_object('name', x.full_name, 'email', x.email) order by x.email)
                        from private.org_owner_people(v_org.id) x), '[]'::jsonb),
    'support_sessions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'reason', s.reason,
                                    'starts_at', s.starts_at, 'ends_at', s.ends_at, 'ended_at', s.ended_at,
                                    'grantee_org_name', g.name,
                                    'open', s.ended_at is null and s.ends_at > now()) order by s.starts_at desc)
                                  from (select * from app.support_sessions y
                                        where y.org_id = v_org.id and y.deleted_at is null
                                        order by y.starts_at desc limit 10) s
                                  left join app.organizations g on g.id = s.grantee_org_id), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

comment on function app.console_org_detail(uuid) is 'One org for the operator console (tenants.read): identity, plan in force and subscription, status (read-only, cancellation), usage this UTC month, limits, features, flags with overrides, recent plan overrides, Owners and recent support sessions. Never the org''s records. Each view is logged.';
revoke all on function app.console_org_detail(uuid) from public, anon;
grant execute on function app.console_org_detail(uuid) to authenticated;

-- Plan override RPCs -------------------------------------------------------------------------------------------------

create or replace function app.console_set_plan_override(
  p_org_id uuid,
  p_kind app.plan_override_kind,
  p_plan_code text,
  p_feature_code app.plan_feature_code,
  p_feature_enabled boolean,
  p_limit_code app.plan_limit_code,
  p_limit_value bigint,
  p_reason text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('plans.write');
  v_id uuid;
begin
  if not exists (select 1 from app.organizations o where o.id = p_org_id and o.deleted_at is null) then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    perform private.refuse('plan_override_reason', 'Say why the override is needed, in up to 500 characters.');
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '366 days' then
    perform private.refuse('plan_override_expiry', 'An override ends within a year: choose an expiry after now and at most a year away.');
  end if;
  if p_kind is null
     or (p_kind = 'Plan' and (p_plan_code is null or not exists (select 1 from app.plans pl where pl.code = p_plan_code)))
     or (p_kind = 'Feature' and (p_feature_code is null or p_feature_enabled is null))
     or (p_kind = 'Limit' and (p_limit_code is null or coalesce(p_limit_value, 0) < 0)) then
    perform private.refuse('plan_override_shape', 'Choose a plan, a feature and whether it is on, or a limit and its value.');
  end if;
  perform 1 from app.organizations o where o.id = p_org_id for update;
  update app.plan_overrides x set ended_at = now(), ended_by = v_operator, end_reason = 'Replaced by a newer override.'
  where x.org_id = p_org_id and x.override_kind = p_kind and x.ended_at is null and x.deleted_at is null
    and (p_kind = 'Plan' or (p_kind = 'Feature' and x.feature_code = p_feature_code)
         or (p_kind = 'Limit' and x.limit_code = p_limit_code));
  insert into app.plan_overrides (org_id, override_kind, plan_code, feature_code, feature_enabled, limit_code, limit_value,
    reason, expires_at)
  values (p_org_id, p_kind,
    case when p_kind = 'Plan' then p_plan_code end,
    case when p_kind = 'Feature' then p_feature_code end,
    case when p_kind = 'Feature' then p_feature_enabled end,
    case when p_kind = 'Limit' then p_limit_code end,
    case when p_kind = 'Limit' then p_limit_value end,
    btrim(p_reason), p_expires_at)
  returning id into v_id;
  perform private.log_operator_action('plan_override.set', p_org_id, 'app.plan_overrides', v_id, p_reason,
    jsonb_build_object('kind', p_kind, 'plan_code', p_plan_code, 'feature_code', p_feature_code,
      'feature_enabled', p_feature_enabled, 'limit_code', p_limit_code, 'limit_value', p_limit_value,
      'expires_at', p_expires_at));
  return v_id;
end;
$$;

comment on function app.console_set_plan_override(uuid, app.plan_override_kind, text, app.plan_feature_code, boolean, app.plan_limit_code, bigint, text, timestamptz) is 'An Administrator (plans.write) holds an org to a plan, turns one plan feature on or off, or sets one limit (null unlimited) until an expiry within a year, with a reason. A live override of the same plan, feature or limit is ended as replaced. Returns the override id.';
revoke all on function app.console_set_plan_override(uuid, app.plan_override_kind, text, app.plan_feature_code, boolean, app.plan_limit_code, bigint, text, timestamptz) from public, anon;
grant execute on function app.console_set_plan_override(uuid, app.plan_override_kind, text, app.plan_feature_code, boolean, app.plan_limit_code, bigint, text, timestamptz) to authenticated;

create or replace function app.console_end_plan_override(p_override_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('plans.write');
  v_row app.plan_overrides;
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    perform private.refuse('plan_override_reason', 'Say why the override ends early, in up to 500 characters.');
  end if;
  select * into v_row from app.plan_overrides x where x.id = p_override_id and x.deleted_at is null for update;
  if v_row.id is null then
    raise exception using errcode = '42501', message = 'plan override not found';
  end if;
  if v_row.ended_at is not null or v_row.expires_at <= now() then
    perform private.refuse('plan_override_ended', 'This override has already ended.');
  end if;
  update app.plan_overrides set ended_at = now(), ended_by = v_operator, end_reason = btrim(p_reason) where id = v_row.id;
  perform private.log_operator_action('plan_override.ended', v_row.org_id, 'app.plan_overrides', v_row.id, p_reason, '{}'::jsonb);
  return v_row.id;
end;
$$;

comment on function app.console_end_plan_override(uuid, text) is 'An Administrator (plans.write) ends a live plan override early with a reason. Returns the override id.';
revoke all on function app.console_end_plan_override(uuid, text) from public, anon;
grant execute on function app.console_end_plan_override(uuid, text) to authenticated;

-- Feature flags ------------------------------------------------------------------------------------------------------

create or replace function app.console_flags()
returns table (
  flag_key text,
  description text,
  default_enabled boolean,
  required_plan_feature app.plan_feature_code,
  kill_switch boolean,
  overrides_on bigint,
  overrides_off bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('tenants.read');
  return query
  select f.flag_key, f.description, f.default_enabled, f.required_plan_feature, f.kill_switch,
    count(o.id) filter (where o.enabled), count(o.id) filter (where not o.enabled)
  from private.feature_flags f
  left join app.feature_flag_overrides o on o.flag_key = f.flag_key and o.deleted_at is null
    and (o.expires_at is null or o.expires_at > now())
  group by f.flag_key
  order by f.flag_key;
end;
$$;

comment on function app.console_flags() is 'Every feature flag with its default, plan gate, kill switch and how many orgs have a live override on and off (tenants.read).';
revoke all on function app.console_flags() from public, anon;
grant execute on function app.console_flags() to authenticated;

create or replace function app.console_set_flag_override(
  p_org_id uuid,
  p_flag_key text,
  p_enabled boolean,
  p_reason text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('flags.write');
  v_id uuid;
begin
  if not exists (select 1 from app.organizations o where o.id = p_org_id and o.deleted_at is null) then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if not exists (select 1 from private.feature_flags f where f.flag_key = p_flag_key) then
    perform private.refuse('flag_unknown', 'Choose a flag from the list.');
  end if;
  if p_enabled is null then
    perform private.refuse('flag_override_value', 'Choose on or off.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 300 then
    perform private.refuse('flag_override_reason', 'Say why the override is needed, in up to 300 characters.');
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '366 days' then
    perform private.refuse('flag_override_expiry', 'An override ends within a year: choose an expiry after now and at most a year away.');
  end if;
  perform 1 from app.organizations o where o.id = p_org_id for update;
  update app.feature_flag_overrides x set deleted_at = now()
  where x.org_id = p_org_id and x.flag_key = p_flag_key and x.deleted_at is null;
  insert into app.feature_flag_overrides (org_id, flag_key, enabled, reason, expires_at)
  values (p_org_id, p_flag_key, p_enabled, btrim(p_reason), p_expires_at)
  returning id into v_id;
  perform private.log_operator_action('flag_override.set', p_org_id, 'app.feature_flag_overrides', v_id, p_reason,
    jsonb_build_object('flag_key', p_flag_key, 'enabled', p_enabled, 'expires_at', p_expires_at));
  return v_id;
end;
$$;

comment on function app.console_set_flag_override(uuid, text, boolean, text, timestamptz) is 'An operator (flags.write) turns a flag on or off for one org until an expiry within a year, with a reason, replacing any override of the flag there. The kill switch and the plan still win (private.flag_enabled). Returns the override id.';
revoke all on function app.console_set_flag_override(uuid, text, boolean, text, timestamptz) from public, anon;
grant execute on function app.console_set_flag_override(uuid, text, boolean, text, timestamptz) to authenticated;

create or replace function app.console_clear_flag_override(p_override_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('flags.write');
  v_row app.feature_flag_overrides;
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 300 then
    perform private.refuse('flag_override_reason', 'Say why the override is cleared, in up to 300 characters.');
  end if;
  select * into v_row from app.feature_flag_overrides x where x.id = p_override_id and x.deleted_at is null for update;
  if v_row.id is null then
    raise exception using errcode = '42501', message = 'flag override not found';
  end if;
  update app.feature_flag_overrides set deleted_at = now() where id = v_row.id;
  perform private.log_operator_action('flag_override.cleared', v_row.org_id, 'app.feature_flag_overrides', v_row.id, p_reason,
    jsonb_build_object('flag_key', v_row.flag_key, 'enabled', v_row.enabled));
  return v_row.id;
end;
$$;

comment on function app.console_clear_flag_override(uuid, text) is 'An operator (flags.write) clears an org''s flag override with a reason, so the flag''s default applies again. Returns the override id.';
revoke all on function app.console_clear_flag_override(uuid, text) from public, anon;
grant execute on function app.console_clear_flag_override(uuid, text) to authenticated;

create or replace function app.console_set_kill_switch(p_flag_key text, p_kill boolean, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('flags.kill_switch');
begin
  if p_kill is null then
    perform private.refuse('flag_override_value', 'Choose whether the kill switch is on or off.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    perform private.refuse('flag_kill_switch_reason', 'Say why, in up to 500 characters.');
  end if;
  update private.feature_flags set kill_switch = p_kill where flag_key = p_flag_key;
  if not found then
    perform private.refuse('flag_unknown', 'Choose a flag from the list.');
  end if;
  perform private.log_operator_action('feature_flag.kill_switch', null, null, null, p_reason,
    jsonb_build_object('flag_key', p_flag_key, 'kill_switch', p_kill));
  return p_flag_key;
end;
$$;

comment on function app.console_set_kill_switch(text, boolean, text) is 'An Administrator (flags.kill_switch) turns a feature off everywhere at once, or back on, with a reason (Section 5.1). Returns the flag key.';
revoke all on function app.console_set_kill_switch(text, boolean, text) from public, anon;
grant execute on function app.console_set_kill_switch(text, boolean, text) to authenticated;
