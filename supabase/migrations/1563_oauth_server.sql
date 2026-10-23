-- 1563_oauth_server.sql
-- A99 Authentication follow-ups (RRR-144; findings A65-002, trace rows S8.5-02 and S10.1-02, ADR 0055). OAuth 2.1 for
-- the public API on Supabase Auth's OAuth server ([auth.oauth_server] in supabase/config.toml): authorization code
-- with PKCE (S256 only), refresh-token rotation and revocation. The OpenAPI document (frozen v1) already names
-- `/oauth/authorize` and `/oauth/token` and one scope per capability group; Atlas now serves both.
--
-- Supabase Auth accepts only its own scopes (openid, email, profile, phone) and refuses any other with "unsupported
-- scope", so the capability groups travel beside it:
--   * Every app an org registers (app.oauth_apps, 0638) is mirrored as a public Supabase Auth OAuth client
--     (auth.oauth_clients, no secret, token_endpoint_auth_method none) by a trigger, mapped in private.oauth_app_clients.
--     Renaming or moving its redirect URI follows; removing the app deletes the client, revokes every consent and ends
--     every session of it.
--   * Atlas's /oauth/authorize takes the capability groups in `scope`, starts Supabase Auth's authorization with its own
--     scopes, and records the groups for that authorization (app.record_oauth_request), for the signed-in person who
--     asked. The consent page (/oauth/consent) reads them back (app.oauth_consent_request) and app.consent_oauth_request
--     records the consent in app.oauth_grants before Supabase Auth issues the code.
--   * PKCE: Supabase Auth requires a code challenge but accepts the plain method; consent is refused unless the
--     authorization used S256.
--   * Restricted capability groups (private.oauth_scope_restricted: data, which holds the Restricted classifications;
--     org, which manages members, roles, keys, security and billing; audit, the ledger) need step-up on consent: a
--     second factor in the last 15 minutes.
--   * An access token Supabase Auth issues to an app carries `client_id`. For such a session private.api_key_scopes()
--     returns the live grant's capability groups (none once revoked), so every capability check, the step-up check
--     (apps never step up) and the org session rules (apps are exempt, like API keys) treat it as a scoped credential.
--     It reaches only the org that registered the app: private.my_org_ids() and private.person_capability_reach()
--     leave out every other org, and the custom access token hook sets its org_id claim to that org.
--   * Revoking a grant (deleting it, as the API and Connected apps do) revokes Supabase Auth's consent and ends the
--     app's sessions for that person at once, so its refresh token stops working and its access token reaches nothing.

-- Which session is an app's -------------------------------------------------------------------------------------------------

create or replace function private.oauth_client_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case when (c ->> 'client_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (c ->> 'client_id')::uuid end
  from (select nullif(current_setting('request.jwt.claims', true), '')::jsonb as c) claims;
$$;

comment on function private.oauth_client_id() is 'The Supabase Auth OAuth client named by the client_id claim of the session JWT (an app''s access token), or NULL for every other session.';
revoke all on function private.oauth_client_id() from public, anon, authenticated;

create table private.oauth_app_clients (
  oauth_app_id uuid primary key references app.oauth_apps (id),
  auth_client_id uuid not null unique references auth.oauth_clients (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table private.oauth_app_clients enable row level security;
revoke all on private.oauth_app_clients from public, anon, authenticated;

comment on table private.oauth_app_clients is 'The Supabase Auth OAuth client behind each registered app (ADR 0055), written by the app''s trigger. Private: apps and grants are read through app.oauth_apps and app.oauth_grants.';
comment on column private.oauth_app_clients.oauth_app_id is 'Registered app (app.oauth_apps).';
comment on column private.oauth_app_clients.auth_client_id is 'Its public client in Supabase Auth (auth.oauth_clients.id), the client_id an app sends and its tokens carry.';
comment on column private.oauth_app_clients.created_at is 'When the client was created.';

create or replace function private.oauth_session()
returns table (oauth_app_id uuid, org_id uuid, scopes text[])
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.org_id,
         coalesce((select g.scopes from app.oauth_grants g
                   where g.oauth_app_id = a.id and g.person_id = private.current_person_id() and g.deleted_at is null
                   order by g.granted_at desc limit 1), '{}'::text[])
  from private.oauth_app_clients c
  join app.oauth_apps a on a.id = c.oauth_app_id and a.deleted_at is null
  where c.auth_client_id = private.oauth_client_id();
$$;

comment on function private.oauth_session() is 'For an app''s session (a JWT with client_id): the registered app, its org and the capability groups the person''s live grant gives it (empty once revoked). No row for any other session or for a client no registered app owns.';
revoke all on function private.oauth_session() from public, anon, authenticated;

create or replace function private.oauth_org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when private.oauth_client_id() is null then null
              else coalesce((select s.org_id from private.oauth_session() s), '00000000-0000-0000-0000-000000000000'::uuid) end;
$$;

comment on function private.oauth_org_id() is 'The one org an app''s session may reach: the org that registered the app, or the nil uuid (no org) for a client no registered app owns. NULL for every other session.';
revoke all on function private.oauth_org_id() from public, anon, authenticated;

-- Redefined from 0936 (its latest definition): an app's session is scoped like an API key's.
create or replace function private.api_key_scopes()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when c ? 'amr' and jsonb_typeof(c -> 'amr') = 'array'
         and exists (select 1 from jsonb_array_elements(c -> 'amr') e
                     where jsonb_typeof(e) = 'object' and e ->> 'method' = 'xos_api_key')
    then coalesce((select array_agg(s) from jsonb_array_elements_text(
                     case when jsonb_typeof(c -> 'scopes') = 'array' then c -> 'scopes' else '[]'::jsonb end) s),
                  '{}'::text[])
    when c ? 'client_id'
    then coalesce((select s.scopes from private.oauth_session() s), '{}'::text[])
  end
  from (select nullif(current_setting('request.jwt.claims', true), '')::jsonb as c) claims;
$$;

comment on function private.api_key_scopes() is 'The capability groups a scoped credential may use, or null for a person''s own session: the scopes of the API key behind the session (A22-001), or, for an app''s session (a JWT with client_id), the person''s live grant to that app (ADR 0055). An empty array permits nothing.';
revoke all on function private.api_key_scopes() from public, anon, authenticated;

-- Redefined from 0204 (its only definition): an app's session reaches only its own org.
create or replace function private.my_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.org_id from app.memberships m
  where m.person_id = private.current_person_id()
    and m.deleted_at is null
    and m.valid_from <= now()
    and (m.valid_to is null or m.valid_to > now())
    and (private.oauth_client_id() is null or m.org_id = private.oauth_org_id());
$$;

comment on function private.my_org_ids() is 'Orgs where the signed-in person holds an active membership; for an app''s session only the org that registered the app (ADR 0055).';

-- Redefined from 1298 (its latest definition; 1203's reach and 1298's break-glass rule unchanged): an app's
-- session reaches only its own org.
create or replace function private.person_capability_reach(p_person_id uuid, p_org_id uuid, p_capability text, p_include_delegations boolean)
 RETURNS app.capability_reach
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $$
begin
  if p_person_id is null or p_org_id is null then
    return null;
  end if;
  -- A22-001: an API-key session reaches only the capability groups in the key's scopes.
  if p_person_id = private.current_person_id()
     and private.api_key_scopes() is not null
     and not (split_part(p_capability, '.', 1) = any (private.api_key_scopes())) then
    return null;
  end if;
  -- A99 (ADR 0055): an app's session reaches only the org that registered the app.
  if p_person_id = private.current_person_id()
     and private.oauth_client_id() is not null
     and p_org_id is distinct from private.oauth_org_id() then
    return null;
  end if;
  return (
    select max(s.reach) from (
      select rc.reach
      from app.memberships m
      join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
      join app.roles r on r.id = mr.role_id and r.deleted_at is null
      join app.role_capabilities rc on rc.role_id = r.id and rc.deleted_at is null
      where m.person_id = p_person_id and m.org_id = p_org_id
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        and rc.capability_code = p_capability
      union all
      select 'organization'::app.capability_reach
      from app.user_capability_grants g
      join app.memberships m on m.id = g.membership_id
      where m.person_id = p_person_id and m.org_id = p_org_id
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        and g.capability_code = p_capability and g.scope_id is null and g.deleted_at is null
        and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
      union all
      select 'organization'::app.capability_reach
      from app.record_grants rg
      where rg.org_id = p_org_id and rg.target_kind = 'organization' and rg.target_id = p_org_id
        and rg.capability_code = p_capability and rg.deleted_at is null
        and rg.valid_from <= now() and rg.valid_to > now()
        and (rg.grantee_person_id = p_person_id
             or rg.grantee_org_id in (select private.person_org_ids(p_person_id)))
      union all
      -- 1203: an open break-glass session (Section 8.4) reaches the Owner role's capabilities org-wide, while the
      -- membership is active. 1298 (A69-009): only for the holder themself, in a second-factor session that is not an
      -- API key, so it never reaches a delegate or another session of the holder.
      select 'organization'::app.capability_reach
      from app.break_glass_sessions b
      join app.memberships m on m.person_id = b.person_id and m.org_id = b.org_id
      join app.role_capabilities rc on rc.capability_code = p_capability and rc.deleted_at is null
        and rc.reach = 'organization'
        and rc.role_id = (select r.id from app.roles r where r.org_id is null and r.code = 'owner')
      where b.person_id = p_person_id and b.org_id = p_org_id and b.deleted_at is null
        and b.started_at <= now() and b.expires_at > now() and b.ended_at is null
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        and p_person_id = private.current_person_id()
        and private.session_aal() = 'aal2'
        and private.api_key_scopes() is null
      union all
      select private.person_capability_reach(dm.person_id, p_org_id, p_capability, false)
      from app.delegations d
      join app.memberships em on em.id = d.delegate_membership_id
      join app.memberships dm on dm.id = d.delegator_membership_id
      where p_include_delegations
        and d.org_id = p_org_id and d.deleted_at is null
        and d.valid_from <= now() and d.valid_to > now()
        and em.person_id = p_person_id
        and em.deleted_at is null and em.valid_from <= now() and (em.valid_to is null or em.valid_to > now())
        and dm.deleted_at is null and dm.valid_from <= now() and (dm.valid_to is null or dm.valid_to > now())
        and (d.capability_code = p_capability
             or (d.capability_code is null and exists (
               select 1 from app.capabilities c where c.code = p_capability and c.capability_class = 'approve')))
    ) s
  );
end;
$$;

comment on function private.person_capability_reach(uuid, uuid, text, boolean) is 'Widest reach a person holds on a capability in an org now: the union of roles, org-wide direct grants, org-level record grants, the holder''s own break-glass session and, when asked, one-hop delegations. An API key or an app reaches only the capability groups it is scoped to, and an app only the org that registered it (ADR 0055).';
revoke all on function private.person_capability_reach(uuid, uuid, text, boolean) from public, anon, authenticated;

-- Redefined from 0920 (its only definition): an app's token names the app's org.
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
  v_client text := v_claims ->> 'client_id';
  v_org uuid;
begin
  if v_client is not null then
    -- An app's token (ADR 0055): the org that registered the app, while the person is a member of it.
    select a.org_id into v_org
    from private.oauth_app_clients c
    join app.oauth_apps a on a.id = c.oauth_app_id and a.deleted_at is null
    where c.auth_client_id::text = v_client and private.user_holds_active_membership(v_user, a.org_id);
  else
    select s.org_id into v_org
    from app.active_org_selections s
    where s.user_id = v_user and private.user_holds_active_membership(v_user, s.org_id);
  end if;
  if v_org is null then
    v_claims := v_claims - 'org_id';
  else
    v_claims := jsonb_set(v_claims, '{org_id}', to_jsonb(v_org::text));
  end if;
  return jsonb_set(event, '{claims}', v_claims);
end;
$$;

comment on function private.custom_access_token_hook(jsonb) is 'Supabase Auth custom access token hook (ADR 0007 item 1): sets the org_id claim to the org chosen in the context switcher while its membership is active, and removes the claim otherwise. An app''s token (client_id claim, ADR 0055) names the org that registered the app instead.';

revoke all on function private.custom_access_token_hook(jsonb) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function private.custom_access_token_hook(jsonb) to supabase_auth_admin;
  end if;
end;
$$;

-- Mirroring registered apps as Supabase Auth clients ------------------------------------------------------------------------

create or replace function private.sync_oauth_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client uuid;
begin
  if tg_op = 'INSERT' then
    v_client := gen_random_uuid();
    -- A public client exactly as Supabase Auth's admin API writes one: an empty secret hash, no secret.
    insert into auth.oauth_clients (id, client_secret_hash, registration_type, redirect_uris, grant_types, client_name,
      client_type, token_endpoint_auth_method)
    values (v_client, '', 'manual', new.redirect_uri, 'authorization_code,refresh_token', btrim(new.name), 'public', 'none');
    insert into private.oauth_app_clients (oauth_app_id, auth_client_id) values (new.id, v_client);
    return new;
  end if;
  select c.auth_client_id into v_client from private.oauth_app_clients c where c.oauth_app_id = new.id;
  if v_client is null then
    return new;
  end if;
  if new.deleted_at is not null and old.deleted_at is null then
    -- Removing the app ends it everywhere: its consents, its sessions and the client itself.
    update app.oauth_grants set deleted_at = now() where oauth_app_id = new.id and deleted_at is null;
    update auth.oauth_consents set revoked_at = now() where client_id = v_client and revoked_at is null;
    delete from auth.sessions where oauth_client_id = v_client;
    update auth.oauth_clients set deleted_at = now(), updated_at = now() where id = v_client;
  elsif new.name is distinct from old.name or new.redirect_uri is distinct from old.redirect_uri then
    update auth.oauth_clients set client_name = btrim(new.name), redirect_uris = new.redirect_uri, updated_at = now()
    where id = v_client;
  end if;
  return new;
end;
$$;

comment on function private.sync_oauth_client() is 'Keeps the Supabase Auth OAuth client of a registered app in step (ADR 0055): created with the app as a public PKCE client, renamed and re-pointed with it, and on removal its grants, consents, sessions and the client end.';
revoke all on function private.sync_oauth_client() from public, anon, authenticated;

create trigger t90_sync_oauth_client after insert or update on app.oauth_apps
  for each row execute function private.sync_oauth_client();

-- Apps registered before this migration get their client now.
do $$
declare
  v_app record;
  v_client uuid;
begin
  for v_app in
    select a.id, a.name, a.redirect_uri from app.oauth_apps a
    where a.deleted_at is null and not exists (select 1 from private.oauth_app_clients c where c.oauth_app_id = a.id)
  loop
    v_client := gen_random_uuid();
    insert into auth.oauth_clients (id, client_secret_hash, registration_type, redirect_uris, grant_types, client_name,
      client_type, token_endpoint_auth_method)
    values (v_client, '', 'manual', v_app.redirect_uri, 'authorization_code,refresh_token', btrim(v_app.name), 'public', 'none');
    insert into private.oauth_app_clients (oauth_app_id, auth_client_id) values (v_app.id, v_client);
  end loop;
end;
$$;

-- Revoking a grant ends the app's access for that person --------------------------------------------------------------------

create or replace function private.revoke_oauth_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row app.oauth_grants := case when tg_op = 'DELETE' then old else new end;
  v_client uuid;
  v_user uuid;
begin
  if tg_op = 'UPDATE' and (not (new.deleted_at is not null and old.deleted_at is null)
                           or private.in_trusted_operation('oauth_regrant')) then
    return new;
  end if;
  select c.auth_client_id into v_client from private.oauth_app_clients c where c.oauth_app_id = v_row.oauth_app_id;
  select p.user_id into v_user from app.people p where p.id = v_row.person_id;
  if v_client is not null and v_user is not null and not exists (
      select 1 from app.oauth_grants g
      where g.oauth_app_id = v_row.oauth_app_id and g.person_id = v_row.person_id and g.deleted_at is null and g.id <> v_row.id) then
    update auth.oauth_consents set revoked_at = now() where client_id = v_client and user_id = v_user and revoked_at is null;
    delete from auth.sessions where oauth_client_id = v_client and user_id = v_user;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function private.revoke_oauth_access() is 'When a person''s grant to an app ends (deleted or soft-deleted, not replaced by a new consent): revokes Supabase Auth''s consent and ends the app''s sessions for that person, so its refresh token stops working at once (ADR 0055).';
revoke all on function private.revoke_oauth_access() from public, anon, authenticated;

create trigger t90_revoke_oauth_access after update or delete on app.oauth_grants
  for each row execute function private.revoke_oauth_access();

-- Capability groups beside Supabase Auth's scopes ---------------------------------------------------------------------------

create or replace function private.oauth_scope_restricted(p_scope text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_scope in ('org', 'audit')
    or exists (select 1 from app.capabilities c where c.module_code = p_scope and c.code like '%.restricted%');
$$;

comment on function private.oauth_scope_restricted(text) is 'Whether a capability group reaches Restricted data or the org''s control: any group with a Restricted capability (data: payroll, banking, tax, government and medical reads and Restricted exports), org (members, roles, API keys, security, billing) and audit (the ledger). Consent to one needs step-up (ADR 0055).';
revoke all on function private.oauth_scope_restricted(text) from public, anon, authenticated;

create table private.oauth_requests (
  authorization_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  oauth_app_id uuid not null references app.oauth_apps (id),
  scopes text not null,
  created_at timestamptz not null default now(),
  constraint oauth_requests_authorization_id_format check (authorization_id ~ '^[a-z0-9]{16,64}$'),
  constraint oauth_requests_scopes_format check (scopes ~ '^[a-z][a-z0-9_]*( [a-z][a-z0-9_]*){0,39}$')
);

create index oauth_requests_user_idx on private.oauth_requests (user_id);
create index oauth_requests_app_idx on private.oauth_requests (oauth_app_id);

alter table private.oauth_requests enable row level security;
revoke all on private.oauth_requests from public, anon, authenticated;

comment on table private.oauth_requests is 'The capability groups an app asked for in one authorization (ADR 0055), recorded by Atlas''s /oauth/authorize because Supabase Auth carries only its own scopes. Read by the consent page, removed on consent or denial; Supabase Auth expires the authorization after three minutes.';
comment on column private.oauth_requests.authorization_id is 'Supabase Auth authorization (auth.oauth_authorizations.authorization_id).';
comment on column private.oauth_requests.user_id is 'Signed-in person who started it and alone may consent to it.';
comment on column private.oauth_requests.oauth_app_id is 'Registered app asking.';
comment on column private.oauth_requests.scopes is 'Capability groups asked for (first segments of capability codes), sorted, distinct and space-separated as OAuth writes scopes.';
comment on column private.oauth_requests.created_at is 'When Atlas recorded the request.';

create or replace function app.record_oauth_request(p_authorization_id text, p_scopes text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_me uuid := private.require_person();
  v_authorization auth.oauth_authorizations;
  v_app app.oauth_apps;
  v_scopes text[] := (select array_agg(distinct lower(btrim(s)) order by lower(btrim(s))) from unnest(p_scopes) s where btrim(s) <> '');
  v_unknown text;
  v_granted text[];
begin
  perform private.require_read_write();
  if private.api_key_scopes() is not null then
    raise exception using errcode = '42501', message = 'a signed-in session is required';
  end if;
  select * into v_authorization from auth.oauth_authorizations a
  where a.authorization_id = p_authorization_id and a.status = 'pending' and a.expires_at > now()
    and (a.user_id is null or a.user_id = v_user);
  if v_authorization.id is null then
    perform private.refuse('oauth_request_expired', 'This sign-in request has expired. Start again from the app.');
  end if;
  select a.* into v_app from private.oauth_app_clients c join app.oauth_apps a on a.id = c.oauth_app_id
  where c.auth_client_id = v_authorization.client_id and a.deleted_at is null;
  if v_app.id is null then
    perform private.refuse('oauth_client_unknown', 'This app is not registered.');
  end if;
  if not exists (select 1 from app.memberships m where m.org_id = v_app.org_id and m.person_id = v_me and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    perform private.refuse('oauth_not_member', 'Only members of the org that registered the app can consent to it.');
  end if;
  if v_scopes is null or cardinality(v_scopes) not between 1 and 40 then
    perform private.refuse('oauth_scope_missing', 'Ask for at least one capability group, and at most 40.');
  end if;
  select s into v_unknown from unnest(v_scopes) s
  where not exists (select 1 from app.capabilities c where c.module_code = s) limit 1;
  if v_unknown is not null then
    perform private.refuse('oauth_scope_unknown', format('%s is not a capability group.', v_unknown));
  end if;
  insert into private.oauth_requests (authorization_id, user_id, oauth_app_id, scopes)
  values (p_authorization_id, v_user, v_app.id, array_to_string(v_scopes, ' '))
  on conflict (authorization_id) do nothing;
  if not found then
    perform private.refuse('oauth_request_recorded', 'This sign-in request was already started.');
  end if;
  -- Asking for more than the live grant gives: Supabase Auth must ask the person again instead of reusing its consent.
  select g.scopes into v_granted from app.oauth_grants g
  where g.oauth_app_id = v_app.id and g.person_id = v_me and g.deleted_at is null;
  if v_granted is null or not (v_scopes <@ v_granted) then
    update auth.oauth_consents set revoked_at = now()
    where client_id = v_authorization.client_id and user_id = v_user and revoked_at is null;
  end if;
end;
$$;

comment on function app.record_oauth_request(text, text[]) is 'Records the capability groups an app asks for in a pending Supabase Auth authorization, for the signed-in member who started it (Atlas''s /oauth/authorize, ADR 0055). Refuses an expired or unknown authorization, an unregistered app, a non-member, unknown groups and a second recording; asking for more than the live grant makes Supabase Auth ask for consent again.';
revoke all on function app.record_oauth_request(text, text[]) from public, anon;
grant execute on function app.record_oauth_request(text, text[]) to authenticated;

create or replace function app.oauth_consent_request(p_authorization_id text)
returns table (
  oauth_app_id uuid,
  app_name text,
  client_id text,
  org_id uuid,
  org_name text,
  redirect_uri text,
  scopes text[],
  restricted_scopes text[],
  granted_scopes text[],
  pkce_s256 boolean,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.name, a.client_id, a.org_id, o.name, z.redirect_uri, string_to_array(r.scopes, ' '),
         coalesce((select array_agg(s order by s) from unnest(string_to_array(r.scopes, ' ')) s
                   where private.oauth_scope_restricted(s)), '{}'::text[]),
         (select g.scopes from app.oauth_grants g
          where g.oauth_app_id = a.id and g.person_id = private.current_person_id() and g.deleted_at is null),
         z.code_challenge_method::text = 's256',
         z.expires_at
  from private.oauth_requests r
  join app.oauth_apps a on a.id = r.oauth_app_id and a.deleted_at is null
  join app.organizations o on o.id = a.org_id
  join auth.oauth_authorizations z on z.authorization_id = r.authorization_id
  where r.authorization_id = p_authorization_id and r.user_id = (select auth.uid())
    and z.status = 'pending' and z.expires_at > now();
$$;

comment on function app.oauth_consent_request(text) is 'What the consent page shows for a pending authorization the caller started: the app, its org and redirect URI, the capability groups asked for, which of them are Restricted (step-up on consent), what the caller''s live grant already gives, whether the authorization used PKCE with S256, and when it expires. No row otherwise.';
revoke all on function app.oauth_consent_request(text) from public, anon;
grant execute on function app.oauth_consent_request(text) to authenticated;

create or replace function app.consent_oauth_request(p_authorization_id text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request record;
  v_grant uuid;
begin
  select * into v_request from app.oauth_consent_request(p_authorization_id);
  if v_request.oauth_app_id is null then
    perform private.refuse('oauth_request_expired', 'This sign-in request has expired. Start again from the app.');
  end if;
  if not v_request.pkce_s256 then
    perform private.refuse('oauth_pkce_required', 'This app must use PKCE with S256. Ask its developer to update it.');
  end if;
  v_grant := app.grant_oauth_consent(v_request.client_id, v_request.scopes);
  delete from private.oauth_requests where authorization_id = p_authorization_id;
  return v_grant;
end;
$$;

comment on function app.consent_oauth_request(text) is 'The caller consents to a pending authorization they started: refuses a missing or expired one and one without PKCE S256, then records the grant (app.grant_oauth_consent, with step-up for Restricted groups) and removes the request. Atlas then asks Supabase Auth to issue the code. Returns the grant id.';
revoke all on function app.consent_oauth_request(text) from public, anon;
grant execute on function app.consent_oauth_request(text) to authenticated;

create or replace function app.decline_oauth_request(p_authorization_id text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  delete from private.oauth_requests where authorization_id = p_authorization_id and user_id = (select auth.uid());
$$;

comment on function app.decline_oauth_request(text) is 'Removes the caller''s pending request when they deny consent; Supabase Auth then answers the app with access_denied.';
revoke all on function app.decline_oauth_request(text) from public, anon;
grant execute on function app.decline_oauth_request(text) to authenticated;

-- Redefined from 0638 (its only definition), every rule kept: an app never consents for a person, and Restricted groups
-- need step-up.
create or replace function app.grant_oauth_consent(p_client_id text, p_scopes text[])
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_app app.oauth_apps;
  v_grant uuid;
  v_restricted text;
begin
  if private.api_key_scopes() is not null then
    perform private.refuse('step_up_session_only', 'Consent comes from the person''s own session, never an API key or an app.');
  end if;
  select * into v_app from app.oauth_apps a where a.client_id = p_client_id and a.deleted_at is null;
  if v_app.id is null then
    perform private.refuse('oauth_client_unknown', 'This app is not registered.');
  end if;
  if not exists (select 1 from app.memberships m where m.org_id = v_app.org_id and m.person_id = v_me and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    perform private.refuse('oauth_not_member', 'Only members of the org that registered the app can consent to it.');
  end if;
  select s into v_restricted from unnest(p_scopes) s where private.oauth_scope_restricted(s) limit 1;
  if v_restricted is not null then
    perform private.require_second_factor(format('let %s use Restricted data', v_app.name));
  end if;
  -- Replacing a consent keeps the app connected: the revocation trigger skips the old grant's end.
  perform private.begin_trusted_operation('oauth_regrant');
  update app.oauth_grants set deleted_at = now() where oauth_app_id = v_app.id and person_id = v_me and deleted_at is null;
  perform private.end_trusted_operation('oauth_regrant');
  insert into app.oauth_grants (oauth_app_id, person_id, scopes)
  values (v_app.id, v_me, (select array_agg(distinct s order by s) from unnest(p_scopes) s))
  returning id into v_grant;
  return v_grant;
end;
$$;

comment on function app.grant_oauth_consent(text, text[]) is 'Records the signed-in person''s consent to an OAuth app of an org they belong to, replacing an earlier consent. Restricted capability groups need step-up (a second factor in the last 15 minutes); an API key or an app never consents. Returns the grant id.';
revoke all on function app.grant_oauth_consent(text, text[]) from public, anon;
grant execute on function app.grant_oauth_consent(text, text[]) to authenticated, service_role;

create or replace function app.my_oauth_access()
returns table (oauth_app_id uuid, org_id uuid, scopes text[])
language sql
stable
security definer
set search_path = ''
as $$
  select s.oauth_app_id, s.org_id, s.scopes from private.oauth_session() s;
$$;

comment on function app.my_oauth_access() is 'For an app''s session, the registered app, its org and the capability groups the person''s live grant gives it, as the API runtime enforces them (ADR 0055). No row for any other session.';
revoke all on function app.my_oauth_access() from public, anon;
grant execute on function app.my_oauth_access() to authenticated;

create or replace function app.my_oauth_apps()
returns table (grant_id uuid, oauth_app_id uuid, app_name text, org_name text, scopes text[], granted_at timestamptz,
  last_used_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, a.id, a.name, o.name, g.scopes, g.granted_at,
         (select max(greatest(s.updated_at, s.refreshed_at at time zone 'UTC')) from auth.sessions s
          where s.user_id = (select auth.uid()) and s.oauth_client_id = c.auth_client_id)
  from app.oauth_grants g
  join app.oauth_apps a on a.id = g.oauth_app_id and a.deleted_at is null
  join app.organizations o on o.id = a.org_id
  left join private.oauth_app_clients c on c.oauth_app_id = a.id
  where g.person_id = private.current_person_id() and g.deleted_at is null
  order by g.granted_at desc;
$$;

comment on function app.my_oauth_apps() is 'The apps the caller lets act for them (Connected apps): each live grant with the app, its org, the capability groups and when the app last refreshed its access.';
revoke all on function app.my_oauth_apps() from public, anon;
grant execute on function app.my_oauth_apps() to authenticated;

create or replace function app.oauth_app_client_ids(p_org_id uuid)
returns table (oauth_app_id uuid, auth_client_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, c.auth_client_id
  from app.oauth_apps a
  join private.oauth_app_clients c on c.oauth_app_id = a.id
  where a.org_id = p_org_id and a.deleted_at is null
    and private.has_capability(p_org_id, 'org.settings.read');
$$;

comment on function app.oauth_app_client_ids(uuid) is 'The client_id each live app of an org sends to /oauth/authorize (its Supabase Auth client), for those who may read the org''s settings, as app.oauth_apps is read.';
revoke all on function app.oauth_app_client_ids(uuid) from public, anon;
grant execute on function app.oauth_app_client_ids(uuid) to authenticated;

-- Atlas serves /oauth/authorize, /oauth/token and /oauth/consent, so no org may take the slug.
insert into private.reserved_org_slugs (slug) values ('oauth') on conflict do nothing;
