-- 1432_personal_access_tokens.sql
-- A86 Settings surfaces (RRR-131, finding A65-004, WP3), Section 4.5.6 personal settings item 15: Developer,
-- "personal API tokens, where the org allows them".
--   * developer.personal_tokens: the org setting that allows them (off by default; org.api_keys.manage). Turning it
--     off stops every token of the org at the next exchange. Tokens also need the api_keys plan feature.
--   * app.personal_access_tokens: one person's token for one org. Only the SHA-256 hash of the secret is stored
--     (`xos_pat_` and 48 hex digits, shown once); a visible prefix tells tokens apart; expiry at most one year
--     ahead; revocation is final. The person sees their own tokens; org.api_keys.manage sees and revokes all of
--     the org's.
--   * app.personal_access_token_scopes: the capability groups a token may use, one row each (a junction table,
--     doctrine 1280). A person can only scope a token to groups they hold a capability in, and RLS still decides
--     every read and write the token makes, so a token never reaches further than its person.
--   * app.create_personal_access_token and app.revoke_personal_access_token write audit events
--     (personal_access_token.created and personal_access_token.revoked).
--   * app.exchange_api_key, replaced from 0922: an `xos_pat_` secret now resolves to the person's own sign-in, so
--     the api-token Edge Function signs the same short-lived JWT with the token's scopes (0936 enforces them). The
--     `xos_live_` path is unchanged.
-- Step-up before creating a token is A77's (requireSecondFactor); this migration does not stand in for it.

select private.define_setting('developer.personal_tokens', 'Boolean', 'org.api_keys.manage', array['organization'], false, p_default_boolean => false);

create or replace function private.org_allows_personal_tokens(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.setting_boolean(p_org_id, 'developer.personal_tokens'), false)
    and private.org_has_feature(p_org_id, 'api_keys');
$$;

comment on function private.org_allows_personal_tokens(uuid) is 'True when the org turned developer.personal_tokens on and its plan has the api_keys feature (Section 4.5.6 personal settings item 15).';

create or replace function app.org_allows_personal_tokens(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_org_id in (select private.my_org_ids()) and private.org_allows_personal_tokens(p_org_id);
$$;

comment on function app.org_allows_personal_tokens(uuid) is 'For a member: whether their org allows personal API tokens (developer.personal_tokens and the api_keys plan feature). False for anyone else. Atlas shows Personal settings, Developer only when true.';

create or replace function app.my_orgs_allowing_personal_tokens()
returns table (org_id uuid, org_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.name from app.organizations o
  where o.id in (select private.my_org_ids()) and o.deleted_at is null and private.org_allows_personal_tokens(o.id)
  order by o.name, o.id;
$$;

comment on function app.my_orgs_allowing_personal_tokens() is 'The signed-in person''s orgs that allow personal API tokens, by name. Gateway shows Settings, Developer when there is at least one.';

-- Tokens ----------------------------------------------------------------------------------------------------------------

create table app.personal_access_tokens (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  name text not null,
  prefix text not null,
  secret_hash bytea not null,
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references app.people (id),
  constraint personal_access_tokens_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint personal_access_tokens_prefix_format check (prefix ~ '^xos_pat_[0-9a-f]{8}$'),
  constraint personal_access_tokens_secret_hash_length check (octet_length(secret_hash) = 32),
  constraint personal_access_tokens_revocation_pair check ((revoked_at is null) = (revoked_by is null))
);

create unique index personal_access_tokens_prefix_key on app.personal_access_tokens (prefix);
create unique index personal_access_tokens_secret_hash_key on app.personal_access_tokens (secret_hash);
create index personal_access_tokens_person_idx on app.personal_access_tokens (person_id);
create index personal_access_tokens_revoked_by_idx on app.personal_access_tokens (revoked_by);

call private.install_domain_table('app.personal_access_tokens');
call private.describe('app.personal_access_tokens', 'Personal API tokens (Section 4.5.6 personal settings item 15): one person''s token for one org, where the org allows them (developer.personal_tokens). The secret is shown once; only its SHA-256 hash is stored. A token acts as its person, narrowed to its scopes.', array[
  'person_id', 'Person the token acts as.',
  'name', 'Token name the person chose, for example Laptop scripts.',
  'prefix', 'Visible start of the secret (xos_pat_ and 8 hex digits), so people can tell tokens apart.',
  'secret_hash', 'SHA-256 of the full secret. Never readable by signed-in callers.',
  'expires_at', 'When the token stops working. At most one year after creation.',
  'last_used_at', 'When the token last authenticated a request, to the minute.',
  'revoked_at', 'When the token was revoked; a revoked token never works again.',
  'revoked_by', 'Person who revoked the token: its owner or an org admin.'
]);

call private.install_policies('app.personal_access_tokens',
  $$person_id = (select private.current_person_id()) or org_id in (select private.orgs_with_capability('org.api_keys.manage'))$$,
  null,
  null);

-- Callers never read the hash and never write directly: creation and revocation go through the RPCs below.
revoke select, insert, update on app.personal_access_tokens from authenticated;
grant select (id, org_id, person_id, name, prefix, expires_at, last_used_at, revoked_at, revoked_by,
  created_at, created_by, updated_at, updated_by, deleted_at) on app.personal_access_tokens to authenticated;

create table app.personal_access_token_scopes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  personal_access_token_id uuid not null references app.personal_access_tokens (id),
  scope text not null,
  constraint personal_access_token_scopes_format check (scope ~ '^[a-z][a-z_]*$')
);

call private.install_domain_table('app.personal_access_token_scopes', 'app.personal_access_tokens', 'personal_access_token_id');
create unique index personal_access_token_scopes_key on app.personal_access_token_scopes (personal_access_token_id, scope)
  where deleted_at is null;
call private.describe('app.personal_access_token_scopes', 'A capability group a personal API token may use (Section 4.5.6 personal settings item 15), one row per group. Fixed when the token is created.', array[
  'personal_access_token_id', 'Token the scope belongs to.',
  'scope', 'Capability group: the first segment of capability codes in the registry, for example work.'
]);

call private.install_policies('app.personal_access_token_scopes',
  $$org_id in (select private.orgs_with_capability('org.api_keys.manage'))
    or personal_access_token_id in (select t.id from app.personal_access_tokens t where t.person_id = (select private.current_person_id()))$$,
  null,
  null);
revoke insert, update on app.personal_access_token_scopes from authenticated;

-- RPCs ------------------------------------------------------------------------------------------------------------------

create or replace function app.create_personal_access_token(p_org_id uuid, p_name text, p_scopes text[], p_expires_at timestamptz)
returns table (personal_access_token_id uuid, secret text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_secret text := 'xos_pat_' || encode(extensions.gen_random_bytes(24), 'hex');
  v_scopes text[] := coalesce((select array_agg(distinct s order by s) from unnest(p_scopes) s where s is not null), '{}');
  v_bad text;
  v_id uuid;
begin
  perform private.require_membership_in(p_org_id);
  if not private.org_allows_personal_tokens(p_org_id) then
    perform private.refuse('personal_tokens_off', 'Your organization does not allow personal API tokens.');
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 200 then
    perform private.refuse('personal_token_name', 'Name the token in 1 to 200 characters.');
  end if;
  if cardinality(v_scopes) = 0 then
    perform private.refuse('personal_token_scopes', 'Choose at least one area the token may use.');
  end if;
  select s into v_bad from unnest(v_scopes) s
  where not exists (select 1 from app.capabilities c where split_part(c.code, '.', 1) = s and private.has_capability(p_org_id, c.code))
  limit 1;
  if v_bad is not null then
    perform private.refuse('personal_token_scope_not_held', format('You hold no capability in %s, so a token cannot use it.', v_bad));
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '1 year' then
    perform private.refuse('personal_token_expiry', 'Set the expiry after now and at most one year ahead.');
  end if;
  if (select count(*) from app.personal_access_tokens t
      where t.org_id = p_org_id and t.person_id = v_person and t.revoked_at is null and t.deleted_at is null
        and t.expires_at > now()) >= 10 then
    perform private.refuse('personal_token_limit', 'You already have 10 active tokens here. Revoke one first.');
  end if;

  insert into app.personal_access_tokens (org_id, person_id, name, prefix, secret_hash, expires_at)
  values (p_org_id, v_person, btrim(p_name), left(v_secret, 16), extensions.digest(v_secret, 'sha256'), p_expires_at)
  returning id into v_id;
  insert into app.personal_access_token_scopes (org_id, personal_access_token_id, scope)
  select p_org_id, v_id, s from unnest(v_scopes) s;
  perform private.write_audit_event(p_org_id, 'personal_access_token.created', 'app.personal_access_tokens', v_id,
    jsonb_build_object('name', btrim(p_name), 'prefix', left(v_secret, 16), 'scopes', to_jsonb(v_scopes), 'expires_at', p_expires_at));
  return query select v_id, v_secret;
end;
$$;

comment on function app.create_personal_access_token(uuid, text, text[], timestamptz) is 'Creates the signed-in member''s personal API token for an org that allows them and returns its secret once; only the SHA-256 hash is stored. Scopes are capability groups the person holds; expiry at most one year ahead; at most 10 active tokens per person and org. Audited.';

create or replace function app.revoke_personal_access_token(p_token_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_token app.personal_access_tokens;
begin
  select * into v_token from app.personal_access_tokens t where t.id = p_token_id and t.deleted_at is null;
  if v_token.id is null or not (v_token.person_id = v_person or private.has_capability(v_token.org_id, 'org.api_keys.manage')) then
    raise exception using errcode = '42501', message = 'personal access token not found';
  end if;
  if v_token.revoked_at is not null then
    perform private.refuse('personal_token_revoked', 'This token is already revoked.');
  end if;
  update app.personal_access_tokens set revoked_at = now(), revoked_by = v_person where id = p_token_id;
  perform private.write_audit_event(v_token.org_id, 'personal_access_token.revoked', 'app.personal_access_tokens', p_token_id,
    jsonb_build_object('prefix', v_token.prefix, 'owner', v_token.person_id));
end;
$$;

comment on function app.revoke_personal_access_token(uuid) is 'Revokes a personal API token at once and for good: its owner, or an org admin with org.api_keys.manage. Audited.';

create or replace function private.exchange_personal_access_token(p_secret text)
returns table (api_key_id uuid, org_id uuid, scopes text[], user_id uuid, service_account_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token app.personal_access_tokens;
  v_user uuid;
begin
  if p_secret is null or p_secret !~ '^xos_pat_[0-9a-f]{48}$' then
    return;
  end if;
  select * into v_token from app.personal_access_tokens t where t.secret_hash = extensions.digest(p_secret, 'sha256');
  if v_token.id is null or v_token.revoked_at is not null or v_token.deleted_at is not null or v_token.expires_at <= now()
     or not private.org_allows_personal_tokens(v_token.org_id) then
    return;
  end if;
  select p.user_id into v_user from app.people p where p.id = v_token.person_id;
  if v_user is null or not private.user_holds_active_membership(v_user, v_token.org_id) then
    return;
  end if;
  if v_token.last_used_at is null or v_token.last_used_at < now() - interval '1 minute' then
    update app.personal_access_tokens set last_used_at = date_trunc('minute', now()) where id = v_token.id;
  end if;
  return query
    select v_token.id, v_token.org_id,
      coalesce((select array_agg(s.scope order by s.scope) from app.personal_access_token_scopes s
                where s.personal_access_token_id = v_token.id and s.deleted_at is null), '{}'),
      v_user, null::uuid;
end;
$$;

comment on function private.exchange_personal_access_token(text) is 'Resolves a presented personal API token to its person''s sign-in, org and scopes: no row for an unknown, revoked, trashed or expired token, an org that no longer allows tokens or lost the api_keys feature, or a person no longer a member. Records last use to the minute.';

-- Replaces 0922's definition (the latest), keeping its xos_live_ behavior unchanged.
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
  if p_secret like 'xos\_pat\_%' then
    return query select * from private.exchange_personal_access_token(p_secret);
    return;
  end if;
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

comment on function app.exchange_api_key(text) is 'Token exchange (service role only): resolves a presented API key to the service account sign-in, or a personal API token (xos_pat_) to its person''s sign-in, that the api-token Edge Function signs a short-lived JWT for. No row for an invalid key or token or an expired, retired or removed account; a refusal for a key without a service account.';

-- Retention -------------------------------------------------------------------------------------------------------------

call private.install_default_retention('app.personal_access_tokens', interval '1 year');
call private.install_default_retention('app.personal_access_token_scopes', interval '1 year');

-- Privileges ------------------------------------------------------------------------------------------------------------

revoke all on function private.org_allows_personal_tokens(uuid) from public, anon, authenticated;
revoke all on function app.org_allows_personal_tokens(uuid) from public, anon;
grant execute on function app.org_allows_personal_tokens(uuid) to authenticated;
revoke all on function app.my_orgs_allowing_personal_tokens() from public, anon;
grant execute on function app.my_orgs_allowing_personal_tokens() to authenticated;
revoke all on function private.exchange_personal_access_token(text) from public, anon, authenticated;
revoke all on function app.create_personal_access_token(uuid, text, text[], timestamptz) from public, anon;
grant execute on function app.create_personal_access_token(uuid, text, text[], timestamptz) to authenticated;
revoke all on function app.revoke_personal_access_token(uuid) from public, anon;
grant execute on function app.revoke_personal_access_token(uuid) to authenticated;
revoke all on function app.exchange_api_key(text) from public, anon, authenticated;
grant execute on function app.exchange_api_key(text) to service_role;
