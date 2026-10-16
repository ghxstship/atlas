-- 0638_identity_and_verification.sql
-- A19 Integrations. The identity and verification integrations routed to A19 (Section 9, Section 10.1, Section 4.8):
--   * OAuth 2.1 apps (public PKCE clients registered by an org) and the consent grants people give them
--   * identity providers (SAML 2.0 or OIDC through Supabase Auth SSO) with just-in-time joins, and SCIM 2.0
--     provisioning: a hashed bearer token per provider, SCIM identities, IdP groups mapped to roles and teams, and
--     joins and offboarding through A30's join helper (private.join_org_with_role) and the membership guards
--   * organization verification requests, checked by the verifier jobs (Stripe Identity or a business registry)
--     that call A30's app.record_organization_verification; domain checks call app.record_domain_verification
-- SAML and SCIM need the Enterprise plan features saml_sso and scim (Section 16).

-- OAuth apps and grants -------------------------------------------------------------------------------------------

create table app.oauth_apps (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  client_id text not null default ('xos_client_' || encode(extensions.gen_random_bytes(12), 'hex')),
  redirect_uri text not null,
  deleted_at timestamptz,
  constraint oauth_apps_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint oauth_apps_client_id_format check (client_id ~ '^xos_client_[0-9a-f]{24}$'),
  constraint oauth_apps_redirect_uri check (
    char_length(redirect_uri) <= 2000
    and (redirect_uri ~ '^https://[^/?#\s]+' or redirect_uri ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$)')
    and redirect_uri !~ '#')
);

create unique index oauth_apps_client_id_key on app.oauth_apps (client_id);

call private.install_domain_table('app.oauth_apps');
call private.describe('app.oauth_apps', 'OAuth 2.1 clients an org registers for user-delegated access to the public API (Section 10.1). Public clients using PKCE: no client secret exists. Scopes map one to one to capability groups.', array[
  'org_id', 'Org that registered the app and whose data it may reach.',
  'name', 'App name shown on the consent screen.',
  'client_id', 'OAuth client identifier, issued by the database and never changed.',
  'redirect_uri', 'Registered redirect URI: HTTPS, or a loopback address for native apps; no fragment.'
]);

call private.install_policies('app.oauth_apps',
  $$org_id in (select private.orgs_with_capability('org.settings.read'))$$,
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$);

create or replace function private.guard_oauth_app()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.client_id := 'xos_client_' || encode(extensions.gen_random_bytes(12), 'hex');
  elsif new.client_id <> old.client_id then
    perform private.refuse('oauth_client_id_fixed', 'A client id never changes; register a new app instead.');
  end if;
  return new;
end;
$$;

comment on function private.guard_oauth_app() is 'OAuth apps: the database issues the client id and never changes it.';

create trigger t40_guard_oauth_app before insert or update on app.oauth_apps
  for each row execute function private.guard_oauth_app();

create table app.oauth_grants (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  oauth_app_id uuid not null references app.oauth_apps (id),
  person_id uuid not null references app.people (id),
  scopes text[] not null,
  granted_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint oauth_grants_scopes_present check (cardinality(scopes) between 1 and 40)
);

create index oauth_grants_app_idx on app.oauth_grants (oauth_app_id);
create index oauth_grants_person_idx on app.oauth_grants (person_id);
create unique index oauth_grants_live_key on app.oauth_grants (oauth_app_id, person_id) where deleted_at is null;

call private.install_domain_table('app.oauth_grants', 'app.oauth_apps', 'oauth_app_id');
call private.describe('app.oauth_grants', 'Consent a person gave an OAuth app: the capability groups it may use on their behalf. The person revokes it by deleting it; a new consent replaces the old one.', array[
  'oauth_app_id', 'App consented to.',
  'person_id', 'Person who consented, set from the session.',
  'scopes', 'Capability groups granted (first segments of capability codes, as API key scopes).',
  'granted_at', 'When consent was given.'
]);

call private.install_policies('app.oauth_grants',
  $$person_id = (select private.current_person_id())
    or org_id in (select private.orgs_with_capability('org.integrations.manage'))$$,
  null,
  $$person_id = (select private.current_person_id())$$);

create or replace function private.guard_oauth_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unknown text;
begin
  if tg_op = 'UPDATE' and (new.scopes <> old.scopes or new.oauth_app_id <> old.oauth_app_id or new.person_id <> old.person_id) then
    perform private.refuse('oauth_grant_fixed', 'A consent is never edited; consent again to change it.');
  end if;
  if tg_op = 'UPDATE' and old.deleted_at is not null then
    perform private.refuse('oauth_grant_revoked', 'A revoked consent stays revoked.');
  end if;
  select s into v_unknown from unnest(new.scopes) s
  where not exists (select 1 from app.capabilities c where split_part(c.code, '.', 1) = s) limit 1;
  if v_unknown is not null then
    perform private.refuse('oauth_scope_unknown', format('%s is not a capability group.', v_unknown));
  end if;
  return new;
end;
$$;

comment on function private.guard_oauth_grant() is 'OAuth grants: scopes are capability groups, a consent is never edited, and a revoked one stays revoked.';

create trigger t40_guard_oauth_grant before insert or update on app.oauth_grants
  for each row execute function private.guard_oauth_grant();

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
begin
  select * into v_app from app.oauth_apps a where a.client_id = p_client_id and a.deleted_at is null;
  if v_app.id is null then
    perform private.refuse('oauth_client_unknown', 'This app is not registered.');
  end if;
  if not exists (select 1 from app.memberships m where m.org_id = v_app.org_id and m.person_id = v_me and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    perform private.refuse('oauth_not_member', 'Only members of the org that registered the app can consent to it.');
  end if;
  update app.oauth_grants set deleted_at = now() where oauth_app_id = v_app.id and person_id = v_me and deleted_at is null;
  insert into app.oauth_grants (oauth_app_id, person_id, scopes)
  values (v_app.id, v_me, (select array_agg(distinct s order by s) from unnest(p_scopes) s))
  returning id into v_grant;
  return v_grant;
end;
$$;

comment on function app.grant_oauth_consent(text, text[]) is 'Records the signed-in person''s consent to an OAuth app of an org they belong to, replacing an earlier consent. Returns the grant id.';

-- Identity providers, SSO just-in-time joins and SCIM ---------------------------------------------------------------

create type app.identity_protocol as enum ('SAML', 'OIDC');
comment on type app.identity_protocol is 'Single sign-on protocol of an identity provider.';

create table app.identity_providers (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  protocol app.identity_protocol not null,
  name text not null,
  auth_provider_id text not null,
  default_role_id uuid not null references app.roles (id),
  jit_enabled boolean not null default false,
  scim_enabled boolean not null default false,
  scim_token_hash bytea,
  scim_token_prefix text,
  deleted_at timestamptz,
  constraint identity_providers_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint identity_providers_auth_id_length check (char_length(auth_provider_id) between 1 and 200),
  constraint identity_providers_token_hash check (scim_token_hash is null or octet_length(scim_token_hash) = 32),
  constraint identity_providers_token_pair check ((scim_token_hash is null) = (scim_token_prefix is null))
);

create index identity_providers_org_idx on app.identity_providers (org_id);
create index identity_providers_default_role_idx on app.identity_providers (default_role_id);
create unique index identity_providers_auth_key on app.identity_providers (auth_provider_id) where deleted_at is null;
create unique index identity_providers_token_key on app.identity_providers (scim_token_hash) where deleted_at is null and scim_token_hash is not null;

call private.install_domain_table('app.identity_providers', null, null, array['app.roles', 'default_role_id']);
call private.describe('app.identity_providers', 'An org''s enterprise identity provider (Section 9): SAML 2.0 or OIDC sign-in through a Supabase Auth SSO provider, optional just-in-time joins with a default role, and optional SCIM 2.0 provisioning authenticated by a hashed bearer token. Needs the saml_sso feature; SCIM also needs scim.', array[
  'org_id', 'Org the provider signs people into.',
  'protocol', 'SAML or OIDC.',
  'name', 'Provider name, for example the IdP tenant.',
  'auth_provider_id', 'Supabase Auth SSO provider id; a sign-in through it carries app_metadata.provider = sso:<id>.',
  'default_role_id', 'Role a person receives on a just-in-time or SCIM join. Never the Owner role.',
  'jit_enabled', 'Whether signing in through the provider joins the org.',
  'scim_enabled', 'Whether SCIM provisioning is on.',
  'scim_token_hash', 'SHA-256 of the SCIM bearer token. The token is shown once. Never readable by signed-in callers.',
  'scim_token_prefix', 'Visible start of the SCIM token, to tell tokens apart.'
]);

revoke select on app.identity_providers from authenticated;
grant select (id, org_id, protocol, name, auth_provider_id, default_role_id, jit_enabled, scim_enabled, scim_token_prefix,
  created_at, created_by, updated_at, updated_by, deleted_at) on app.identity_providers to authenticated;

call private.install_policies('app.identity_providers',
  $$org_id in (select private.orgs_with_capability('org.settings.read'))$$,
  $$org_id in (select private.orgs_with_capability('org.security.write'))$$);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.identity_providers', 'scim_token_hash', 'Confidential', null);

create or replace function private.guard_identity_provider()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.org_has_feature(new.org_id, 'saml_sso') then
    perform private.refuse('integration_plan_feature', 'Enterprise single sign-on needs a plan with the saml_sso feature.');
  end if;
  if new.scim_enabled and not private.org_has_feature(new.org_id, 'scim') then
    perform private.refuse('integration_plan_feature', 'SCIM provisioning needs a plan with the scim feature.');
  end if;
  if (select r.band from app.roles r where r.id = new.default_role_id) = 1 then
    perform private.refuse('sso_default_role_owner', 'Single sign-on never makes anyone an Owner; choose another default role.');
  end if;
  if (select r.org_id from app.roles r where r.id = new.default_role_id) is distinct from new.org_id
     and (select r.org_id from app.roles r where r.id = new.default_role_id) is not null then
    perform private.refuse('cross_org_reference', 'identity_providers.default_role_id points to a row of another org.');
  end if;
  if not private.in_trusted_operation('scim_token')
     and (tg_op = 'INSERT' and new.scim_token_hash is not null
       or tg_op = 'UPDATE' and (new.scim_token_hash is distinct from old.scim_token_hash or new.scim_token_prefix is distinct from old.scim_token_prefix)) then
    perform private.refuse('scim_token_rpc_only', 'Issue SCIM tokens through app.issue_scim_token.');
  end if;
  return new;
end;
$$;

comment on function private.guard_identity_provider() is 'Identity providers: saml_sso (and scim when SCIM is on) on the plan, never the Owner role by default, a role of the same org or a system role, and SCIM tokens only through their RPC.';

create trigger t40_guard_identity_provider before insert or update on app.identity_providers
  for each row execute function private.guard_identity_provider();

create or replace function app.issue_scim_token(p_identity_provider_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_provider app.identity_providers;
  v_token text := 'xos_scim_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  perform private.require_person();
  select * into v_provider from app.identity_providers p where p.id = p_identity_provider_id and p.deleted_at is null for update;
  if v_provider.id is null or not private.has_capability(v_provider.org_id, 'org.security.write') then
    raise exception using errcode = '42501', message = 'org.security.write is required';
  end if;
  if private.session_aal() <> 'aal2' then
    perform private.refuse('step_up_required', 'Issuing a SCIM token needs step-up authentication.');
  end if;
  perform private.begin_trusted_operation('scim_token');
  update app.identity_providers set scim_token_hash = extensions.digest(v_token, 'sha256'), scim_token_prefix = left(v_token, 13)
  where id = p_identity_provider_id;
  perform private.end_trusted_operation('scim_token');
  return v_token;
end;
$$;

comment on function app.issue_scim_token(uuid) is 'Issues or rotates a provider''s SCIM bearer token and returns it once; only its SHA-256 is kept. Needs org.security.write and step-up authentication.';

create or replace function app.scim_provider_for_token(p_token text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from app.identity_providers p
  where p.scim_token_hash = extensions.digest(p_token, 'sha256') and p.scim_enabled and p.deleted_at is null
    and private.org_has_feature(p.org_id, 'scim');
$$;

comment on function app.scim_provider_for_token(text) is 'SCIM endpoint: the provider a bearer token belongs to, while SCIM is on and the plan has it, or NULL. Service role only.';

create table app.scim_group_mappings (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  identity_provider_id uuid not null references app.identity_providers (id),
  idp_group text not null,
  role_id uuid references app.roles (id),
  team_id uuid references app.teams (id),
  deleted_at timestamptz,
  constraint scim_group_mappings_group_length check (char_length(btrim(idp_group)) between 1 and 255),
  constraint scim_group_mappings_target check (num_nonnulls(role_id, team_id) >= 1)
);

create index scim_group_mappings_provider_idx on app.scim_group_mappings (identity_provider_id);
create index scim_group_mappings_role_idx on app.scim_group_mappings (role_id);
create index scim_group_mappings_team_idx on app.scim_group_mappings (team_id);
create unique index scim_group_mappings_key on app.scim_group_mappings (identity_provider_id, idp_group) where deleted_at is null;

call private.install_domain_table('app.scim_group_mappings', 'app.identity_providers', 'identity_provider_id', array['app.roles', 'role_id', 'app.teams', 'team_id']);
call private.describe('app.scim_group_mappings', 'Identity-provider groups mapped to a role, a team or both. SCIM provisioning grants them on join and takes them back when the person leaves the group.', array[
  'identity_provider_id', 'Identity provider the group comes from.',
  'idp_group', 'Group display name as the identity provider sends it.',
  'role_id', 'Role members of the group receive. Never the Owner role.',
  'team_id', 'Team members of the group join.'
]);

call private.install_policies('app.scim_group_mappings',
  $$org_id in (select private.orgs_with_capability('org.settings.read'))$$,
  $$org_id in (select private.orgs_with_capability('org.security.write'))$$);

create or replace function private.guard_scim_group_mapping()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role_id is not null and (select r.band from app.roles r where r.id = new.role_id) = 1 then
    perform private.refuse('sso_default_role_owner', 'Single sign-on never makes anyone an Owner; map the group to another role.');
  end if;
  return new;
end;
$$;

comment on function private.guard_scim_group_mapping() is 'SCIM group mappings never grant the Owner role.';

create trigger t40_guard_scim_group_mapping before insert or update on app.scim_group_mappings
  for each row execute function private.guard_scim_group_mapping();

create table app.scim_identities (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  identity_provider_id uuid not null references app.identity_providers (id),
  external_id text not null,
  user_name text not null,
  person_id uuid not null references app.people (id),
  active boolean not null default true,
  groups text[] not null default '{}',
  deleted_at timestamptz,
  constraint scim_identities_external_length check (char_length(external_id) between 1 and 255),
  constraint scim_identities_user_name check (user_name = lower(user_name) and char_length(user_name) between 3 and 320)
);

create index scim_identities_provider_idx on app.scim_identities (identity_provider_id);
create index scim_identities_person_idx on app.scim_identities (person_id);
create unique index scim_identities_external_key on app.scim_identities (identity_provider_id, external_id) where deleted_at is null;
create unique index scim_identities_user_name_key on app.scim_identities (identity_provider_id, user_name) where deleted_at is null;
create unique index scim_identities_person_key on app.scim_identities (identity_provider_id, person_id) where deleted_at is null;

call private.install_domain_table('app.scim_identities', 'app.identity_providers', 'identity_provider_id');
call private.describe('app.scim_identities', 'People the identity provider provisions through SCIM: their SCIM id, whether they are active, and the group names last sent. Written only by the SCIM endpoint.', array[
  'identity_provider_id', 'Identity provider.',
  'external_id', 'SCIM user id the identity provider assigned.',
  'user_name', 'SCIM userName (the sign-in email), lowercase.',
  'person_id', 'XOS person provisioned.',
  'active', 'Whether the identity provider has the person active; inactive ends the membership.',
  'groups', 'Group display names last provisioned (provider payload).'
]);

call private.install_policies('app.scim_identities',
  $$org_id in (select private.orgs_with_capability('org.security.write'))$$);

create or replace function app.join_by_sso(p_org_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_provider_claim text;
  v_provider app.identity_providers;
begin
  select u.raw_app_meta_data ->> 'provider' into v_provider_claim from auth.users u where u.id = (select auth.uid());
  if v_provider_claim is null or v_provider_claim not like 'sso:%' then
    perform private.refuse('sso_session_required', 'Sign in through your organization''s single sign-on first.');
  end if;
  select * into v_provider from app.identity_providers p
  where p.org_id = p_org_id and p.auth_provider_id = substr(v_provider_claim, 5) and p.deleted_at is null;
  if v_provider.id is null or not v_provider.jit_enabled then
    perform private.refuse('sso_join_unavailable', 'This organization does not add people who sign in through this identity provider.');
  end if;
  if not private.org_has_feature(p_org_id, 'saml_sso') then
    perform private.refuse('integration_plan_feature', 'Enterprise single sign-on needs a plan with the saml_sso feature.');
  end if;
  return private.join_org_with_role(p_org_id, v_me, v_provider.default_role_id, null);
end;
$$;

comment on function app.join_by_sso(uuid) is 'Just-in-time join (Section 4.8.1, Section 9): a person who signed in through the org''s identity provider joins with its default role, when the org turned just-in-time joins on. Uses A30''s join helper, so plan limits and membership guards apply. Returns the membership id.';

create or replace function app.scim_provision(
  p_identity_provider_id uuid,
  p_external_id text,
  p_user_name text,
  p_user_id uuid,
  p_active boolean,
  p_groups text[]
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_provider app.identity_providers;
  v_person uuid;
  v_identity app.scim_identities;
  v_membership uuid;
  v_groups text[] := coalesce((select array_agg(distinct btrim(g) order by btrim(g)) from unnest(p_groups) g where btrim(g) <> ''), '{}');
  v_mapping record;
begin
  select * into v_provider from app.identity_providers p where p.id = p_identity_provider_id and p.deleted_at is null;
  if v_provider.id is null or not v_provider.scim_enabled or not private.org_has_feature(v_provider.org_id, 'scim') then
    perform private.refuse('scim_unavailable', 'SCIM provisioning is off for this identity provider.');
  end if;
  select p.id into v_person from app.people p where p.user_id = p_user_id;
  if v_person is null then
    perform private.refuse('scim_user_unknown', 'Create the auth user before provisioning it.');
  end if;
  select * into v_identity from app.scim_identities i
  where i.identity_provider_id = p_identity_provider_id and i.external_id = p_external_id and i.deleted_at is null for update;
  if v_identity.id is null then
    insert into app.scim_identities (identity_provider_id, external_id, user_name, person_id, active, groups)
    values (p_identity_provider_id, p_external_id, lower(btrim(p_user_name)), v_person, p_active, v_groups) returning * into v_identity;
  elsif v_identity.person_id <> v_person then
    perform private.refuse('scim_identity_person_fixed', 'A SCIM user stays linked to the person it was provisioned as.');
  end if;

  select m.id into v_membership from app.memberships m
  where m.org_id = v_provider.org_id and m.person_id = v_person and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());

  if not p_active then
    if v_membership is not null then
      perform private.begin_trusted_operation('membership_write');
      update app.memberships set valid_to = now() where id = v_membership;
      perform private.end_trusted_operation('membership_write');
    end if;
    update app.scim_identities set active = false, groups = v_groups where id = v_identity.id;
    return null;
  end if;

  v_membership := private.join_org_with_role(v_provider.org_id, v_person, v_provider.default_role_id, null);
  perform private.begin_trusted_operation('membership_write');
  -- Grant what the current groups map to.
  for v_mapping in
    select g.role_id, g.team_id from app.scim_group_mappings g
    where g.identity_provider_id = p_identity_provider_id and g.deleted_at is null and g.idp_group = any (v_groups)
  loop
    if v_mapping.role_id is not null and not exists (select 1 from app.membership_roles mr
        where mr.membership_id = v_membership and mr.role_id = v_mapping.role_id and mr.deleted_at is null) then
      insert into app.membership_roles (membership_id, role_id) values (v_membership, v_mapping.role_id);
    end if;
    if v_mapping.team_id is not null and not exists (select 1 from app.team_members tm
        where tm.membership_id = v_membership and tm.team_id = v_mapping.team_id and tm.deleted_at is null) then
      insert into app.team_members (team_id, membership_id) values (v_mapping.team_id, v_membership);
    end if;
  end loop;
  -- Take back what groups the person left map to, unless a current group or the default role still gives it.
  update app.membership_roles mr set deleted_at = now()
  where mr.membership_id = v_membership and mr.deleted_at is null and mr.role_id <> v_provider.default_role_id
    and mr.role_id in (select g.role_id from app.scim_group_mappings g where g.identity_provider_id = p_identity_provider_id
                       and g.deleted_at is null and g.idp_group = any (v_identity.groups) and not g.idp_group = any (v_groups))
    and mr.role_id not in (select g.role_id from app.scim_group_mappings g where g.identity_provider_id = p_identity_provider_id
                           and g.deleted_at is null and g.idp_group = any (v_groups) and g.role_id is not null);
  update app.team_members tm set deleted_at = now()
  where tm.membership_id = v_membership and tm.deleted_at is null
    and tm.team_id in (select g.team_id from app.scim_group_mappings g where g.identity_provider_id = p_identity_provider_id
                       and g.deleted_at is null and g.idp_group = any (v_identity.groups) and not g.idp_group = any (v_groups))
    and tm.team_id not in (select g.team_id from app.scim_group_mappings g where g.identity_provider_id = p_identity_provider_id
                           and g.deleted_at is null and g.idp_group = any (v_groups) and g.team_id is not null);
  perform private.end_trusted_operation('membership_write');
  update app.scim_identities set active = true, groups = v_groups where id = v_identity.id;
  return v_membership;
end;
$$;

comment on function app.scim_provision(uuid, text, text, uuid, boolean, text[]) is 'SCIM endpoint: provisions a user. Active joins the org with the provider''s default role through A30''s join helper, grants the roles and teams the current groups map to and takes back those of groups the person left; inactive ends the membership, which opens offboarding. Returns the membership id, or NULL when deactivated. Service role only.';

-- Organization verification requests ----------------------------------------------------------------------------------

create type app.verification_request_state as enum ('Pending', 'Passed', 'Failed');
comment on type app.verification_request_state is 'Outcome of an organization verification request (a check status, ADR 0002).';

create table app.organization_verification_requests (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  method text not null,
  provider_reference text not null,
  request_state app.verification_request_state not null default 'Pending',
  last_checked_at timestamptz,
  failure_reason text,
  deleted_at timestamptz,
  constraint organization_verification_requests_method check (method in ('Stripe Identity', 'Business Registry')),
  constraint organization_verification_requests_reference check (char_length(btrim(provider_reference)) between 1 and 200),
  constraint organization_verification_requests_reason check (failure_reason is null or char_length(failure_reason) <= 500),
  constraint organization_verification_requests_outcome check ((request_state = 'Failed') = (failure_reason is not null))
);

create index organization_verification_requests_org_idx on app.organization_verification_requests (org_id);
create index organization_verification_requests_pending_idx on app.organization_verification_requests (last_checked_at) where request_state = 'Pending';

call private.install_domain_table('app.organization_verification_requests');
call private.describe('app.organization_verification_requests', 'An org''s request to verify its business identity (Section 4.8.3): a Stripe Identity verification session or a business registry entry, checked by the verifier job, which records a passed check through A30''s app.record_organization_verification.', array[
  'org_id', 'Org asking to be verified.',
  'method', 'Stripe Identity or Business Registry: the labels of A30''s app.organization_verification_method (0860), which migrates after this range.',
  'provider_reference', 'Stripe Identity verification session id, or the registry entry as <jurisdiction>/<company number>.',
  'request_state', 'Pending, Passed or Failed. Written by the verifier.',
  'last_checked_at', 'When the verifier last checked.',
  'failure_reason', 'Why the check failed.'
]);

call private.install_policies('app.organization_verification_requests',
  $$org_id in (select private.orgs_with_capability('org.settings.read'))$$,
  $$org_id in (select private.orgs_with_capability('org.security.write'))$$);

create or replace function private.guard_verification_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.in_trusted_operation('organization_verification')
     and (tg_op = 'INSERT' and (new.request_state <> 'Pending' or new.last_checked_at is not null)
       or tg_op = 'UPDATE' and (new.request_state is distinct from old.request_state or new.last_checked_at is distinct from old.last_checked_at
         or new.failure_reason is distinct from old.failure_reason
         or new.method <> old.method or new.provider_reference <> old.provider_reference)) then
    perform private.refuse('verification_request_verifier_only', 'Only the verifier records the outcome of a verification request.');
  end if;
  if tg_op = 'INSERT' and new.method = 'Business Registry' and new.provider_reference !~ '^[a-z]{2}(_[a-z0-9]{1,3})?/[A-Za-z0-9-]{1,40}$' then
    perform private.refuse('verification_reference_invalid', 'Name the registry entry as <jurisdiction>/<company number>, for example us_fl/P12000012345.');
  end if;
  return new;
end;
$$;

comment on function private.guard_verification_request() is 'Verification requests start Pending, keep their method and reference, and only the verifier records outcomes. Registry references are <jurisdiction>/<company number>.';

create trigger t40_guard_verification_request before insert or update on app.organization_verification_requests
  for each row execute function private.guard_verification_request();

create or replace function app.record_organization_check(p_request_id uuid, p_passed boolean, p_reason text, p_expires_at timestamptz default null)
returns app.verification_request_state
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request app.organization_verification_requests;
  v_verification uuid;
begin
  select * into v_request from app.organization_verification_requests r where r.id = p_request_id and r.deleted_at is null for update;
  if v_request.id is null then
    perform private.refuse('verification_request_unknown', 'The verification request does not exist or was withdrawn.');
  end if;
  if v_request.request_state <> 'Pending' then
    perform private.refuse('verification_request_decided', 'The verification request already has an outcome.');
  end if;
  perform private.begin_trusted_operation('organization_verification');
  if p_passed then
    -- A30's function and enum (0860) migrate after this range, so they are resolved when the check runs.
    execute 'select app.record_organization_verification($1, $2::app.organization_verification_method, $3, $4)'
      into v_verification using v_request.org_id, v_request.method, v_request.provider_reference, p_expires_at;
    update app.organization_verification_requests set request_state = 'Passed', last_checked_at = now()
    where id = p_request_id;
  elsif p_passed is false then
    update app.organization_verification_requests
    set request_state = 'Failed', failure_reason = left(coalesce(nullif(btrim(p_reason), ''), 'The check did not pass.'), 500), last_checked_at = now()
    where id = p_request_id;
  else
    update app.organization_verification_requests set last_checked_at = now() where id = p_request_id;
  end if;
  perform private.end_trusted_operation('organization_verification');
  return (select r.request_state from app.organization_verification_requests r where r.id = p_request_id);
end;
$$;

comment on function app.record_organization_check(uuid, boolean, text, timestamptz) is 'Verifier: records a check of a Pending request. Passed records the verification through A30''s app.record_organization_verification; false fails it with a reason; NULL means still pending at the provider and only stamps the check time. Service role only.';

-- Privileges and retention ------------------------------------------------------------------------------------------------

revoke all on function private.guard_oauth_app() from public, anon, authenticated;
revoke all on function private.guard_oauth_grant() from public, anon, authenticated;
revoke all on function private.guard_identity_provider() from public, anon, authenticated;
revoke all on function private.guard_scim_group_mapping() from public, anon, authenticated;
revoke all on function private.guard_verification_request() from public, anon, authenticated;
revoke all on function app.grant_oauth_consent(text, text[]) from public, anon;
revoke all on function app.issue_scim_token(uuid) from public, anon;
revoke all on function app.join_by_sso(uuid) from public, anon;
grant execute on function app.grant_oauth_consent(text, text[]) to authenticated, service_role;
grant execute on function app.issue_scim_token(uuid) to authenticated;
grant execute on function app.join_by_sso(uuid) to authenticated, service_role;
revoke all on function app.scim_provider_for_token(text) from public, anon, authenticated;
revoke all on function app.scim_provision(uuid, text, text, uuid, boolean, text[]) from public, anon, authenticated;
revoke all on function app.record_organization_check(uuid, boolean, text, timestamptz) from public, anon, authenticated;
grant execute on function app.scim_provider_for_token(text) to service_role;
grant execute on function app.scim_provision(uuid, text, text, uuid, boolean, text[]) to service_role;
grant execute on function app.record_organization_check(uuid, boolean, text, timestamptz) to service_role;

call private.install_default_retention('app.oauth_apps');
call private.install_default_retention('app.oauth_grants');
call private.install_default_retention('app.identity_providers');
call private.install_default_retention('app.scim_group_mappings');
call private.install_default_retention('app.scim_identities');
call private.install_default_retention('app.organization_verification_requests');
