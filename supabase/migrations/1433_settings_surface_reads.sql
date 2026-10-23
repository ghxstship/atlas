-- 1433_settings_surface_reads.sql
-- A86 Settings surfaces (RRR-131, finding A65-004, WP3). Three reads the settings panels need that no caller could
-- make before; each keeps the rule of the data it reads.
--   * app.my_oauth_grants(): the signed-in person's own connected apps (Section 4.5.6 personal settings item 13)
--     with the app and org names. A member may not read app.oauth_apps (org.settings.read), so the names come
--     from this definer function, limited to the caller's own grants. Revoking stays the person's own update of
--     app.oauth_grants (0638).
--   * app.custom_field_targets: the built-in tables an org may add custom fields to (org settings item 16), from
--     private.custom_field_targets (0540), which only the service role could read.
--   * app.org_usage(p_org_id, p_months): usage per meter for the open billing month and the last closed months
--     (org settings item 38), with each meter's unit. Billing months are UTC, as the monthly rollup and the Stripe
--     report count them (0510). Needs org.usage.read.

-- Connected apps --------------------------------------------------------------------------------------------------------

create or replace function app.my_oauth_grants()
returns table (oauth_grant_id uuid, org_id uuid, org_name text, app_name text, scopes text[], granted_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, g.org_id, o.name, a.name, g.scopes, g.granted_at
  from app.oauth_grants g
  join app.oauth_apps a on a.id = g.oauth_app_id
  join app.organizations o on o.id = g.org_id
  where g.person_id = (select private.current_person_id()) and g.deleted_at is null
  order by g.granted_at desc, g.id;
$$;

comment on function app.my_oauth_grants() is 'The signed-in person''s live OAuth grants (connected apps, Section 4.5.6 personal settings item 13) with the app and org names, newest first. Only the caller''s own grants; revoke by setting deleted_at on app.oauth_grants.';

-- Custom field targets --------------------------------------------------------------------------------------------------

create view app.custom_field_targets as
select t.table_name from private.custom_field_targets t;

comment on view app.custom_field_targets is 'Built-in tables an org may add custom fields to (Section 4.5.6 org settings item 16), for the Custom Fields settings page.';
comment on column app.custom_field_targets.table_name is 'Schema-qualified table, for example app.projects.';

revoke all on app.custom_field_targets from public, anon;
grant select on app.custom_field_targets to authenticated, service_role;

-- Usage -----------------------------------------------------------------------------------------------------------------

create or replace function app.org_usage(p_org_id uuid, p_months integer default 3)
returns table (period_start date, meter_code text, unit text, quantity bigint, closed boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'UTC')::date;
begin
  if p_org_id is null or p_org_id not in (select private.orgs_with_capability('org.usage.read')) then
    raise exception using errcode = '42501', message = 'org.usage.read is required to read usage';
  end if;
  return query
    select v_month, m.code, m.unit,
      coalesce((select sum(u.quantity) from app.usage_events u
                where u.org_id = p_org_id and u.meter_code = m.code and u.deleted_at is null
                  and u.created_at >= (v_month::timestamp at time zone 'UTC')), 0)::bigint,
      false
    from private.usage_meters m
    union all
    select r.period_start, r.meter_code, m.unit, r.quantity, true
    from app.usage_rollups r
    join private.usage_meters m on m.code = r.meter_code
    where r.org_id = p_org_id and r.deleted_at is null
      and r.period_start >= (v_month - make_interval(months => greatest(least(coalesce(p_months, 3), 24), 0)))::date
    order by 1 desc, 2;
end;
$$;

comment on function app.org_usage(uuid, integer) is 'An org''s usage per meter (Section 4.5.6 org settings item 38): the open billing month so far, then the closed monthly totals of the last p_months months (at most 24), each with the meter''s unit. Billing months are UTC, as the rollup counts them. Needs org.usage.read.';

-- Privileges ------------------------------------------------------------------------------------------------------------

revoke all on function app.my_oauth_grants() from public, anon;
grant execute on function app.my_oauth_grants() to authenticated;
revoke all on function app.org_usage(uuid, integer) from public, anon;
grant execute on function app.org_usage(uuid, integer) to authenticated;
