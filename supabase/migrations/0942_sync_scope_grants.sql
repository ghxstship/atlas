-- 0942_sync_scope_grants.sql
-- A03 Domain Data, late slot (requested by A17 Compass). The scopes PowerSync sync rules partition by:
-- one row per signed-in user and scope value, computed with the same helpers row level security uses,
-- so a device only ever downloads what the person could read through the API.
--   * internal scopes: personIds (Self), membershipIds, readableProjectIds and orgIds (Internal)
--   * external scopes: engagementIds and engagedProjectIds, with the audience set to the engagement's
--     external role type, from private.my_engagement_ids('operational') (Section 8.7 time box) and only
--     while the engagement is Active or Closing
-- Rows are refreshed by triggers on the tables that change a person's reach (memberships, roles,
-- capability grants, projects, project members, record assignments, shifts, engagements and their state
-- ledger) and nightly for
-- everyone, which also applies time boxes and validity windows that lapse without a write. Only the
-- service role (the PowerSync connector) reads the table. It lives in private, not app: it is not
-- tenant data (no org_id) and has no signed-in reader, and every app table carries org_id and a read policy. Lives in the late slot because it uses
-- engagements (0700) and pg_cron (0500s).

create table private.sync_scope_grants (
  person_user_id uuid not null references auth.users (id) on delete cascade,
  scope_key text not null,
  scope_value text not null,
  audience text not null,
  refreshed_at timestamptz not null default now(),
  primary key (person_user_id, scope_key, scope_value),
  constraint sync_scope_grants_scope_key check (scope_key in ('personIds', 'membershipIds', 'readableProjectIds', 'orgIds', 'engagementIds', 'engagedProjectIds')),
  constraint sync_scope_grants_audience_length check (char_length(audience) between 1 and 60)
);

comment on table private.sync_scope_grants is 'Sync scopes of each signed-in user for PowerSync (Section 13): the ids the person''s devices may download, computed with the row level security helpers and kept current by triggers and a nightly refresh. Readable only by the service role. Not tenant data: one row per user and scope value across every org.';
comment on column private.sync_scope_grants.person_user_id is 'Auth user the scope belongs to.';
comment on column private.sync_scope_grants.scope_key is 'personIds, membershipIds, readableProjectIds, orgIds, engagementIds or engagedProjectIds.';
comment on column private.sync_scope_grants.scope_value is 'The id in scope, as text.';
comment on column private.sync_scope_grants.audience is 'Self for the person''s own id, Internal for org scopes, or the external role type of the engagement for external scopes.';
comment on column private.sync_scope_grants.refreshed_at is 'When the row was last confirmed.';

create index sync_scope_grants_scope_idx on private.sync_scope_grants (scope_key, scope_value);

alter table private.sync_scope_grants enable row level security;
revoke all on private.sync_scope_grants from public, anon, authenticated;
grant select on private.sync_scope_grants to service_role;

-- Computing scopes as the user ----------------------------------------------------------------------------

create or replace function private.sync_scope_rows(p_user_id uuid)
returns table (scope_key text, scope_value text, audience text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_rows jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  select coalesce(jsonb_agg(jsonb_build_object('k', r.k, 'v', r.v, 'a', r.a)), '[]'::jsonb) into v_rows
  from (
    select 'personIds' as k, p.id::text as v, 'Self' as a from app.people p where p.id = private.current_person_id()
    union
    select 'membershipIds', m::text, 'Internal' from private.my_membership_ids() m
    union
    select 'orgIds', o::text, 'Internal' from private.my_org_ids() o
    union
    select 'readableProjectIds', p.id::text, 'Internal' from app.projects p
    where p.id in (select private.readable_project_ids())
       or p.org_id in (select private.oversight_org_ids('projects.project.read'))
    union
    select 'engagementIds', e.id::text, e.role_type::text from app.engagements e
    where e.id in (select private.my_engagement_ids('operational')) and e.engagement_state in ('Active', 'Closing')
    union
    select 'engagedProjectIds', e.project_id::text, e.role_type::text from app.engagements e
    where e.id in (select private.my_engagement_ids('operational')) and e.engagement_state in ('Active', 'Closing')
  ) r;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  return query select x ->> 'k', x ->> 'v', x ->> 'a' from jsonb_array_elements(v_rows) x;
end;
$$;

comment on function private.sync_scope_rows(uuid) is 'The sync scopes of a user, computed with the same helpers as row level security by evaluating them under the user''s claims, then restoring the caller''s claims. readableProjectIds is exactly the projects read policy. When a person reaches one project through two engagements, the first role type in canon order is the audience.';
revoke all on function private.sync_scope_rows(uuid) from public, anon, authenticated;

create or replace function private.refresh_sync_scope_grants(p_user_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    return 0;
  end if;
  create temporary table if not exists sync_scope_fresh (scope_key text, scope_value text, audience text) on commit drop;
  delete from sync_scope_fresh;
  insert into sync_scope_fresh
  select distinct on (r.scope_key, r.scope_value) r.scope_key, r.scope_value, r.audience
  from private.sync_scope_rows(p_user_id) r
  order by r.scope_key, r.scope_value, r.audience;
  delete from private.sync_scope_grants g
  where g.person_user_id = p_user_id
    and not exists (select 1 from sync_scope_fresh f where f.scope_key = g.scope_key and f.scope_value = g.scope_value);
  insert into private.sync_scope_grants (person_user_id, scope_key, scope_value, audience)
  select p_user_id, f.scope_key, f.scope_value, f.audience from sync_scope_fresh f
  on conflict (person_user_id, scope_key, scope_value) do update set audience = excluded.audience, refreshed_at = now();
  select count(*) into v_count from private.sync_scope_grants g where g.person_user_id = p_user_id;
  return v_count;
end;
$$;

comment on function private.refresh_sync_scope_grants(uuid) is 'Recomputes one user''s sync scopes and replaces their rows: scopes the user lost are deleted, new ones inserted. Returns the user''s row count.';
revoke all on function private.refresh_sync_scope_grants(uuid) from public, anon, authenticated;
grant execute on function private.refresh_sync_scope_grants(uuid) to service_role;

create or replace function private.refresh_all_sync_scope_grants()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_count integer := 0;
begin
  for v_user in select distinct p.user_id from app.people p where p.user_id is not null and p.deleted_at is null loop
    perform private.refresh_sync_scope_grants(v_user);
    v_count := v_count + 1;
  end loop;
  delete from private.sync_scope_grants g
  where not exists (select 1 from app.people p where p.user_id = g.person_user_id and p.deleted_at is null);
  return v_count;
end;
$$;

comment on function private.refresh_all_sync_scope_grants() is 'Recomputes every user''s sync scopes; run nightly so validity windows and the Section 8.7 time box lapse without a write. Returns the number of users refreshed.';
revoke all on function private.refresh_all_sync_scope_grants() from public, anon, authenticated;
grant execute on function private.refresh_all_sync_scope_grants() to service_role;

create or replace function private.refresh_sync_scopes_of_people(p_person_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  for v_user in select distinct p.user_id from app.people p where p.id = any (p_person_ids) and p.user_id is not null loop
    perform private.refresh_sync_scope_grants(v_user);
  end loop;
end;
$$;

comment on function private.refresh_sync_scopes_of_people(uuid[]) is 'Refreshes the sync scopes of the users behind the given people.';
revoke all on function private.refresh_sync_scopes_of_people(uuid[]) from public, anon, authenticated;

-- Triggers -------------------------------------------------------------------------------------------------------
-- Argument: how to find the affected people from the changed row: membership (membership_id column),
-- person (person_id column), shift (membership_id or engagement_id), org (every member of the org) or
-- engagement (the engaged person, members of the engaged organization, and users who hold a scope on the
-- engagement).

create or replace function private.sync_scope_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb[] := array_remove(array[case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end], null);
  v_row jsonb;
  v_people uuid[] := '{}';
  v_engagement uuid;
begin
  foreach v_row in array v_rows loop
    if tg_argv[0] = 'person' then
      v_people := v_people || (v_row ->> 'person_id')::uuid;
    elsif tg_argv[0] = 'membership' then
      v_people := v_people || array(select m.person_id from app.memberships m where m.id = (v_row ->> 'membership_id')::uuid);
    elsif tg_argv[0] = 'shift' then
      v_people := v_people || private.worker_person_id((v_row ->> 'membership_id')::uuid, (v_row ->> 'engagement_id')::uuid);
    elsif tg_argv[0] = 'org' then
      v_people := v_people || array(select m.person_id from app.memberships m where m.org_id = (v_row ->> 'org_id')::uuid and m.deleted_at is null);
    elsif tg_argv[0] = 'engagement' then
      v_engagement := coalesce((v_row ->> 'engagement_id')::uuid, (v_row ->> 'id')::uuid);
      v_people := v_people
        || array(select e.person_id from app.engagements e where e.id = v_engagement and e.person_id is not null)
        || array(select m.person_id from app.memberships m join app.counterparties c on c.organization_id = m.org_id
                 join app.engagements e on e.counterparty_id = c.id where e.id = v_engagement and m.deleted_at is null)
        || array(select p.id from app.people p join private.sync_scope_grants g on g.person_user_id = p.user_id
                 where g.scope_key = 'engagementIds' and g.scope_value = v_engagement::text);
    end if;
  end loop;
  perform private.refresh_sync_scopes_of_people(array_remove(v_people, null));
  return null;
end;
$$;

comment on function private.sync_scope_trigger() is 'After a change to a table that decides a person''s reach, refreshes the sync scopes of the people it affects. Argument: membership, person, shift, org (every member of the row''s org, for a new or removed project) or engagement.';
revoke all on function private.sync_scope_trigger() from public, anon, authenticated;

create trigger t96_sync_scopes after insert or update or delete on app.memberships
  for each row execute function private.sync_scope_trigger('person');
create trigger t96_sync_scopes after insert or update or delete on app.membership_roles
  for each row execute function private.sync_scope_trigger('membership');
create trigger t96_sync_scopes after insert or update or delete on app.user_capability_grants
  for each row execute function private.sync_scope_trigger('membership');
create trigger t96_sync_scopes after insert or update or delete on app.project_members
  for each row execute function private.sync_scope_trigger('membership');
create trigger t96_sync_scopes after insert or update of org_id, deleted_at on app.projects
  for each row execute function private.sync_scope_trigger('org');
create trigger t96_sync_scopes after insert or update or delete on app.record_assignments
  for each row execute function private.sync_scope_trigger('membership');
create trigger t96_sync_scopes after insert or update of membership_id, engagement_id, deleted_at or delete on app.shifts
  for each row execute function private.sync_scope_trigger('shift');
create trigger t96_sync_scopes after insert or update of person_id, counterparty_id, deleted_at on app.engagements
  for each row execute function private.sync_scope_trigger('engagement');
create trigger t96_sync_scopes after insert on app.engagement_state_transitions
  for each row execute function private.sync_scope_trigger('engagement');

-- Nightly refresh ----------------------------------------------------------------------------------------------------

select cron.schedule('xos_nightly_sync_scope_refresh', '41 3 * * *', 'select private.refresh_all_sync_scope_grants()');

-- Existing users get their scopes now.
select private.refresh_all_sync_scope_grants();
