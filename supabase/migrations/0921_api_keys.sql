-- 0921_api_keys.sql
-- A04R public API runtime. Org-scoped API keys for servers (ADR 0003): `Authorization: Bearer xos_live_...`.
--   * api_keys: hashed secret (SHA-256), visible prefix, owning org, scopes (capability groups from the
--     capability registry), expiry, last use, revocation and creator. The secret is returned once by
--     app.create_api_key and never stored in plain text; the hash column is never readable by callers.
--   * Org admins (org.api_keys.manage) create, rename, rescope, revoke and trash keys; org.settings.read
--     lists them (the contract's read capability). Keys need the api_keys plan feature.
--   * app.authenticate_api_key resolves a presented secret for the API runtime.

create table app.api_keys (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  service_account_id uuid,
  scopes text[] not null,
  expires_at timestamptz not null,
  prefix text not null,
  secret_hash bytea not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references app.people (id),
  constraint api_keys_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint api_keys_scopes_present check (cardinality(scopes) > 0),
  constraint api_keys_prefix_format check (prefix ~ '^xos_live_[0-9a-f]{8}$'),
  constraint api_keys_secret_hash_length check (octet_length(secret_hash) = 32),
  constraint api_keys_revocation_pair check ((revoked_at is null) = (revoked_by is null))
);

create unique index api_keys_prefix_key on app.api_keys (prefix);
create unique index api_keys_secret_hash_key on app.api_keys (secret_hash);
create index api_keys_revoked_by_idx on app.api_keys (revoked_by);

call private.install_domain_table('app.api_keys');
call private.describe('app.api_keys', 'Org-scoped API keys for servers (ADR 0003): hashed, capability-scoped and expiring. The secret is shown once at creation; only its SHA-256 hash is stored.', array[
  'name', 'Key name shown in Settings, for example Accounting Sync.',
  'service_account_id', 'Service account the key acts for, once service accounts exist; null for an org key.',
  'scopes', 'Capability groups (the first segment of capability codes in the registry) the key may use.',
  'expires_at', 'When the key stops working. At most one year after it is set.',
  'prefix', 'Visible start of the secret (xos_live_ and 8 hex digits), so people can tell keys apart.',
  'secret_hash', 'SHA-256 of the full secret. Never readable by signed-in callers.',
  'last_used_at', 'When the key last authenticated a request, to the minute.',
  'revoked_at', 'When the key was revoked; a revoked key never works again.',
  'revoked_by', 'Person who revoked the key.'
]);

call private.install_policies('app.api_keys',
  $$private.has_capability(org_id, 'org.settings.read') or private.has_capability(org_id, 'org.api_keys.manage')$$,
  null,
  $$private.has_capability(org_id, 'org.api_keys.manage')$$);

-- Callers never read the hash and change only the editable columns; creation and revocation go through RPCs.
revoke select, insert, update on app.api_keys from authenticated;
grant select (id, org_id, name, service_account_id, scopes, expires_at, prefix, last_used_at, revoked_at, revoked_by,
  created_at, created_by, updated_at, updated_by, deleted_at) on app.api_keys to authenticated;
grant update (name, scopes, expires_at, deleted_at) on app.api_keys to authenticated;

call private.install_default_retention('app.api_keys', interval '1 year');

-- Guard ---------------------------------------------------------------------------------------------------

create or replace function private.guard_api_key()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unknown text;
begin
  select s into v_unknown
  from unnest(new.scopes) s
  where not exists (select 1 from app.capabilities c where split_part(c.code, '.', 1) = s)
  limit 1;
  if v_unknown is not null then
    perform private.refuse('api_key_scope_unknown', format('%s is not a capability group.', v_unknown));
  end if;
  if tg_op = 'INSERT' or new.expires_at is distinct from old.expires_at then
    if new.expires_at <= now() or new.expires_at > now() + interval '1 year' then
      perform private.refuse('api_key_expiry_invalid', 'Set the expiry after now and at most one year ahead.');
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if old.revoked_at is not null and (new.name, new.scopes, new.expires_at) is distinct from (old.name, old.scopes, old.expires_at) then
      perform private.refuse('api_key_revoked', 'A revoked key cannot be changed.');
    end if;
    if (new.prefix, new.secret_hash) is distinct from (old.prefix, old.secret_hash) then
      perform private.refuse('api_key_secret_immutable', 'A key''s secret never changes; create a new key instead.');
    end if;
    if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
      perform private.refuse('api_key_revoked', 'A revoked key stays revoked.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_api_key() is 'API key rules: scopes are capability groups from the registry, the expiry lies within one year, a revoked key is frozen and stays revoked, and the secret never changes.';

revoke all on function private.guard_api_key() from public, anon, authenticated;

create trigger t20_guard_api_key before insert or update on app.api_keys
  for each row execute function private.guard_api_key();

-- RPCs ----------------------------------------------------------------------------------------------------

create or replace function app.create_api_key(p_org_id uuid, p_name text, p_scopes text[], p_expires_at timestamptz)
returns table (api_key_id uuid, secret text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_secret text := 'xos_live_' || encode(extensions.gen_random_bytes(24), 'hex');
  v_id uuid;
begin
  if not private.has_capability(p_org_id, 'org.api_keys.manage') then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if not private.org_has_feature(p_org_id, 'api_keys') then
    perform private.refuse('plan_feature_required', 'API keys need the Pro plan or above.');
  end if;
  insert into app.api_keys (org_id, name, scopes, expires_at, prefix, secret_hash)
  values (p_org_id, btrim(p_name), coalesce((select array_agg(distinct s order by s) from unnest(p_scopes) s), '{}'),
    p_expires_at, left(v_secret, 17), extensions.digest(v_secret, 'sha256'))
  returning id into v_id;
  return query select v_id, v_secret;
end;
$$;

comment on function app.create_api_key(uuid, text, text[], timestamptz) is 'Creates an API key and returns its secret once; only the SHA-256 hash is stored. Needs org.api_keys.manage and the api_keys plan feature.';

create or replace function app.revoke_api_key(p_api_key_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key app.api_keys;
begin
  select * into v_key from app.api_keys k where k.id = p_api_key_id and k.deleted_at is null;
  if v_key.id is null or not private.has_capability(v_key.org_id, 'org.api_keys.manage') then
    raise exception using errcode = '42501', message = 'API key not found';
  end if;
  if v_key.revoked_at is not null then
    perform private.refuse('api_key_revoked', 'This key is already revoked.');
  end if;
  update app.api_keys set revoked_at = now(), revoked_by = private.current_person_id() where id = p_api_key_id;
end;
$$;

comment on function app.revoke_api_key(uuid) is 'Revokes an API key at once and for good. Needs org.api_keys.manage.';

create or replace function app.authenticate_api_key(p_secret text)
returns table (api_key_id uuid, org_id uuid, scopes text[], service_account_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key app.api_keys;
begin
  if p_secret is null or p_secret !~ '^xos_live_[0-9a-f]{48}$' then
    return;
  end if;
  select * into v_key from app.api_keys k where k.secret_hash = extensions.digest(p_secret, 'sha256');
  if v_key.id is null or v_key.revoked_at is not null or v_key.deleted_at is not null or v_key.expires_at <= now()
     or not private.org_has_feature(v_key.org_id, 'api_keys') then
    return;
  end if;
  if v_key.last_used_at is null or v_key.last_used_at < now() - interval '1 minute' then
    update app.api_keys set last_used_at = date_trunc('minute', now()) where id = v_key.id;
  end if;
  return query select v_key.id, v_key.org_id, v_key.scopes, v_key.service_account_id;
end;
$$;

comment on function app.authenticate_api_key(text) is 'Resolves a presented API key for the API runtime: no row for an unknown, revoked, trashed or expired key, or when the plan lost the api_keys feature. Records last use to the minute.';

revoke all on function app.create_api_key(uuid, text, text[], timestamptz) from public, anon;
revoke all on function app.revoke_api_key(uuid) from public, anon;
revoke all on function app.authenticate_api_key(text) from public;
grant execute on function app.create_api_key(uuid, text, text[], timestamptz) to authenticated, service_role;
grant execute on function app.revoke_api_key(uuid) to authenticated, service_role;
grant execute on function app.authenticate_api_key(text) to anon, authenticated, service_role;
