-- 0922_service_accounts.sql
-- A04R public API runtime. Service accounts give API keys a database identity RLS understands
-- (ADR 0003, orchestrator decision on API key token exchange, option a):
--   * every service account is a sign-in (auth.users, no password, cannot sign in interactively), a
--     person and a membership in one org holding one role, so capabilities and RLS apply unchanged;
--   * app.create_service_account refuses a role the creator does not hold (no escalation) and Owner;
--   * app.retire_service_account ends the membership and revokes the account's keys at once;
--   * app.create_api_key gains a service account argument, and app.exchange_api_key (service role only)
--     resolves a presented key to the subject the api-token Edge Function signs a short-lived JWT for.

create table app.service_accounts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  owner_person_id uuid not null references app.people (id),
  expires_at timestamptz,
  user_id uuid not null references auth.users (id),
  person_id uuid not null references app.people (id),
  membership_id uuid not null references app.memberships (id),
  constraint service_accounts_name_length check (char_length(btrim(name)) between 1 and 200)
);

create unique index service_accounts_user_id_key on app.service_accounts (user_id);
create unique index service_accounts_person_id_key on app.service_accounts (person_id);
create index service_accounts_owner_person_id_idx on app.service_accounts (owner_person_id);
create index service_accounts_membership_id_idx on app.service_accounts (membership_id);

call private.install_domain_table('app.service_accounts');
call private.describe('app.service_accounts', 'Non-human members with their own audit identity (Settings, API keys and service accounts). Each is a sign-in, a person and a membership in its org holding one role; API keys attached to it act as it.', array[
  'name', 'Service account name, for example Ledger Export Bot.',
  'owner_person_id', 'Person accountable for the service account.',
  'expires_at', 'When the service account stops working; null for no expiry.',
  'user_id', 'Sign-in of the service account (auth.users). It has no password and never signs in interactively.',
  'person_id', 'Person row of the service account, the actor recorded in audit columns.',
  'membership_id', 'Membership that carries the service account''s role in the org.'
]);

call private.install_policies('app.service_accounts',
  $$private.has_capability(org_id, 'org.settings.read') or private.has_capability(org_id, 'org.api_keys.manage')$$,
  null,
  $$private.has_capability(org_id, 'org.api_keys.manage')$$);

revoke update on app.service_accounts from authenticated;
grant update (name, owner_person_id, expires_at) on app.service_accounts to authenticated;

call private.install_default_retention('app.service_accounts', interval '1 year');

alter table app.api_keys
  add constraint api_keys_service_account_id_fkey foreign key (service_account_id) references app.service_accounts (id);
create index api_keys_service_account_id_idx on app.api_keys (service_account_id);

-- Guards ----------------------------------------------------------------------------------------------------

create or replace function private.guard_service_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from app.memberships m
    where m.person_id = new.owner_person_id and m.org_id = new.org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  ) then
    perform private.refuse('service_account_owner_not_member', 'The owner must be an active member of the org.');
  end if;
  if new.expires_at is not null and (tg_op = 'INSERT' or new.expires_at is distinct from old.expires_at)
     and new.expires_at <= now() then
    perform private.refuse('service_account_expiry_invalid', 'Set the expiry after now, or leave it empty.');
  end if;
  if tg_op = 'UPDATE' and (new.user_id, new.person_id, new.membership_id) is distinct from (old.user_id, old.person_id, old.membership_id) then
    perform private.refuse('service_account_identity_immutable', 'A service account keeps its sign-in, person and membership.');
  end if;
  return new;
end;
$$;

comment on function private.guard_service_account() is 'Service account rules: the owner is an active member of the org, the expiry lies ahead, and the sign-in, person and membership never change.';
revoke all on function private.guard_service_account() from public, anon, authenticated;

create trigger t20_guard_service_account before insert or update on app.service_accounts
  for each row execute function private.guard_service_account();

create or replace function private.guard_api_key_service_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.service_account_id is not null and not exists (
    select 1 from app.service_accounts s where s.id = new.service_account_id and s.org_id = new.org_id and s.deleted_at is null
  ) then
    perform private.refuse('api_key_service_account_invalid', 'Attach the key to an active service account of the same org.');
  end if;
  return new;
end;
$$;

comment on function private.guard_api_key_service_account() is 'An API key acts for an active service account of its own org, or for none.';
revoke all on function private.guard_api_key_service_account() from public, anon, authenticated;

create trigger t21_guard_api_key_service_account before insert or update of service_account_id on app.api_keys
  for each row execute function private.guard_api_key_service_account();

-- RPCs --------------------------------------------------------------------------------------------------------

create or replace function app.create_service_account(p_org_id uuid, p_name text, p_role_id uuid, p_expires_at timestamptz default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_role app.roles;
  v_user uuid := gen_random_uuid();
  v_person uuid;
  v_membership uuid;
  v_id uuid;
begin
  if v_me is null or not private.has_capability(p_org_id, 'org.api_keys.manage') then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  select * into v_role from app.roles r where r.id = p_role_id and (r.org_id is null or r.org_id = p_org_id) and r.deleted_at is null;
  if v_role.id is null then
    perform private.refuse('service_account_role_unknown', 'Choose a role of this organization.');
  end if;
  if v_role.band = 1 then
    perform private.refuse('service_account_owner_role', 'A service account cannot hold the Owner role.');
  end if;
  perform private.assert_holds_role_capabilities(v_me, p_org_id, p_role_id);
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 200 then
    perform private.refuse('service_account_name_invalid', 'Name the service account in 1 to 200 characters.');
  end if;

  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'service-account+' || v_user::text || '@service.xos.invalid', now(),
    jsonb_build_object('provider', 'xos_service_account', 'providers', jsonb_build_array('xos_service_account')),
    jsonb_build_object('full_name', btrim(p_name)), now(), now());
  select p.id into v_person from app.people p where p.user_id = v_user;
  if v_person is null then
    insert into app.people (user_id, full_name) values (v_user, btrim(p_name)) returning id into v_person;
  end if;

  perform private.begin_trusted_operation('membership_write');
  insert into app.memberships (org_id, person_id) values (p_org_id, v_person) returning id into v_membership;
  insert into app.membership_roles (membership_id, role_id, granted_by) values (v_membership, p_role_id, v_me);
  perform private.end_trusted_operation('membership_write');

  insert into app.service_accounts (org_id, name, owner_person_id, expires_at, user_id, person_id, membership_id)
  values (p_org_id, btrim(p_name), v_me, p_expires_at, v_user, v_person, v_membership)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.create_service_account(uuid, text, uuid, timestamptz) is 'Creates a service account: a sign-in without a password, its person and a membership in the org with one role. Needs org.api_keys.manage; the creator must hold every capability of the role, and Owner is refused. The creator owns the account.';

create or replace function app.retire_service_account(p_service_account_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account app.service_accounts;
begin
  select * into v_account from app.service_accounts s where s.id = p_service_account_id and s.deleted_at is null;
  if v_account.id is null or not private.has_capability(v_account.org_id, 'org.api_keys.manage') then
    raise exception using errcode = '42501', message = 'service account not found';
  end if;
  update app.api_keys set revoked_at = now(), revoked_by = private.current_person_id()
  where service_account_id = v_account.id and revoked_at is null;
  perform private.begin_trusted_operation('membership_write');
  update app.memberships set valid_to = now() where id = v_account.membership_id and (valid_to is null or valid_to > now());
  perform private.end_trusted_operation('membership_write');
  update app.service_accounts set deleted_at = now() where id = v_account.id;
end;
$$;

comment on function app.retire_service_account(uuid) is 'Retires a service account at once: revokes its API keys, ends its membership and moves it to Trash. Needs org.api_keys.manage.';

create or replace function app.create_api_key(p_org_id uuid, p_name text, p_scopes text[], p_expires_at timestamptz, p_service_account_id uuid)
returns table (api_key_id uuid, secret text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_secret text;
begin
  select k.api_key_id, k.secret into v_id, v_secret from app.create_api_key(p_org_id, p_name, p_scopes, p_expires_at) k;
  if p_service_account_id is not null then
    update app.api_keys set service_account_id = p_service_account_id where id = v_id;
  end if;
  return query select v_id, v_secret;
end;
$$;

comment on function app.create_api_key(uuid, text, text[], timestamptz, uuid) is 'Creates an API key that acts for a service account of the org and returns its secret once. Needs org.api_keys.manage and the api_keys plan feature.';

create or replace function app.exchange_api_key(p_secret text)
returns table (api_key_id uuid, org_id uuid, scopes text[], user_id uuid, service_account_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key record;
  v_account app.service_accounts;
begin
  select * into v_key from app.authenticate_api_key(p_secret) limit 1;
  if v_key.api_key_id is null then
    return;
  end if;
  if v_key.service_account_id is null then
    perform private.refuse('api_key_needs_service_account', 'Attach this key to a service account before calling the API with it.');
  end if;
  select * into v_account from app.service_accounts s where s.id = v_key.service_account_id;
  if v_account.deleted_at is not null or (v_account.expires_at is not null and v_account.expires_at <= now())
     or not private.user_holds_active_membership(v_account.user_id, v_account.org_id) then
    return;
  end if;
  return query select v_key.api_key_id, v_key.org_id, v_key.scopes, v_account.user_id, v_account.id;
end;
$$;

comment on function app.exchange_api_key(text) is 'Token exchange (service role only): resolves a presented API key to the service account sign-in the api-token Edge Function signs a short-lived JWT for. No row for an invalid key or an expired, retired or removed service account; a refusal for a key without a service account.';

revoke all on function app.create_service_account(uuid, text, uuid, timestamptz) from public, anon;
revoke all on function app.retire_service_account(uuid) from public, anon;
revoke all on function app.create_api_key(uuid, text, text[], timestamptz, uuid) from public, anon;
revoke all on function app.exchange_api_key(text) from public, anon, authenticated;
grant execute on function app.create_service_account(uuid, text, uuid, timestamptz) to authenticated, service_role;
grant execute on function app.retire_service_account(uuid) to authenticated, service_role;
grant execute on function app.create_api_key(uuid, text, text[], timestamptz, uuid) to authenticated, service_role;
grant execute on function app.exchange_api_key(text) to service_role;
