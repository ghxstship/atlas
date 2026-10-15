-- 0920_active_org_token_hook.sql
-- A04R public API runtime. The active organization is bound to the credential (ADR 0007 item 1):
--   * active_org_selections: the org each sign-in chose in the context switcher, written only through
--     app.set_active_org, which checks an active membership;
--   * private.custom_access_token_hook: the Supabase Auth custom access token hook. It writes the
--     `org_id` claim from the selection while the membership is still active, and removes the claim
--     otherwise, so a session JWT carries the org the API binds.
-- Enable it in supabase/config.toml (orchestrator):
--   [auth.hook.custom_access_token]
--   enabled = true
--   uri = "pg-functions://postgres/private/custom_access_token_hook"

-- Active org selections ----------------------------------------------------------------------------------

create table app.active_org_selections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  org_id uuid not null references app.organizations (id),
  selected_at timestamptz not null default now()
);

create index active_org_selections_org_id_idx on app.active_org_selections (org_id);

comment on table app.active_org_selections is 'The org each sign-in chose in the context switcher (ADR 0007 item 1). The custom access token hook copies it into the org_id claim while the membership is active. Written only through app.set_active_org.';
comment on column app.active_org_selections.user_id is 'Sign-in (auth.users.id) that made the choice; one row per sign-in.';
comment on column app.active_org_selections.org_id is 'Chosen org. A choice whose membership ended stays here but no longer reaches the token.';
comment on column app.active_org_selections.selected_at is 'When the org was last chosen.';

alter table app.active_org_selections enable row level security;
revoke all on app.active_org_selections from public, anon, authenticated;
grant select on app.active_org_selections to authenticated;
grant all on app.active_org_selections to service_role;

create policy active_org_selections_read on app.active_org_selections
  for select to authenticated using (user_id = (select auth.uid()));

-- Membership check by sign-in ----------------------------------------------------------------------------
-- The hook runs before a session exists, so private.is_member (which reads the JWT) cannot be used. This
-- helper takes the sign-in and the org as arguments (ADR 0016 crash rule).

create or replace function private.user_holds_active_membership(p_user_id uuid, p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.memberships m
    join app.people p on p.id = m.person_id
    join app.organizations o on o.id = m.org_id
    where p.user_id = p_user_id and p.deleted_at is null
      and m.org_id = p_org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      and o.deleted_at is null
  );
$$;

comment on function private.user_holds_active_membership(uuid, uuid) is 'True when the sign-in''s person holds an active membership in the org (Section 7.5 invariant 3). Takes both as arguments so the token hook can use it before a session exists.';

revoke all on function private.user_holds_active_membership(uuid, uuid) from public, anon, authenticated;
grant execute on function private.user_holds_active_membership(uuid, uuid) to service_role;

-- Context switcher ----------------------------------------------------------------------------------------

create or replace function app.set_active_org(p_org_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'a signed-in caller is required';
  end if;
  if p_org_id is null or not private.user_holds_active_membership(v_user, p_org_id) then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  insert into app.active_org_selections (user_id, org_id, selected_at)
  values (v_user, p_org_id, now())
  on conflict (user_id) do update set org_id = excluded.org_id, selected_at = excluded.selected_at;
end;
$$;

comment on function app.set_active_org(uuid) is 'Context switcher: records the org the signed-in person works in. Refreshing the session afterwards puts it in the org_id claim. An org without an active membership is not found (42501, answered as 404).';

revoke all on function app.set_active_org(uuid) from public, anon;
grant execute on function app.set_active_org(uuid) to authenticated, service_role;

-- Custom access token hook ----------------------------------------------------------------------------------

create or replace function private.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (event ->> 'user_id')::uuid;
  v_claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  v_org uuid;
begin
  select s.org_id into v_org
  from app.active_org_selections s
  where s.user_id = v_user and private.user_holds_active_membership(v_user, s.org_id);
  if v_org is null then
    v_claims := v_claims - 'org_id';
  else
    v_claims := jsonb_set(v_claims, '{org_id}', to_jsonb(v_org::text));
  end if;
  return jsonb_set(event, '{claims}', v_claims);
end;
$$;

comment on function private.custom_access_token_hook(jsonb) is 'Supabase Auth custom access token hook (ADR 0007 item 1): sets the org_id claim to the org chosen in the context switcher while its membership is active, and removes the claim otherwise.';

revoke all on function private.custom_access_token_hook(jsonb) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema private to supabase_auth_admin;
    grant execute on function private.custom_access_token_hook(jsonb) to supabase_auth_admin;
  end if;
end;
$$;
