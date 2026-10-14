-- pgTAP: org-scoped API keys (ADR 0003): hashed secrets shown once, capability-group scopes, expiry,
-- revocation, admin-only management, tenant isolation and authentication for the API runtime.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(34);

-- Creation ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
create temporary table key_a as
  select * from app.create_api_key(pg_temp.id('org_a'), ' Accounting Sync ', array['finance', 'org', 'finance'], now() + interval '90 days');
grant select on key_a to public;
select ok((select secret ~ '^xos_live_[0-9a-f]{48}$' from key_a), 'an admin creates a key and receives the secret once');
select results_eq($$select name, scopes, prefix from app.api_keys where id = (select api_key_id from key_a)$$,
  $$select 'Accounting Sync'::text, array['finance', 'org']::text[], (select left(secret, 17) from key_a)$$,
  'the name is trimmed, scopes are deduplicated and the prefix is the start of the secret');
select throws_ok($$select secret_hash from app.api_keys$$, '42501', null, 'the hash column is never readable');
select throws_ok($$select * from app.api_keys$$, '42501', null, 'select * fails because the hash is withheld');
select pg_temp.as_platform();
select ok((select secret_hash = extensions.digest((select secret from key_a), 'sha256') from app.api_keys where id = (select api_key_id from key_a)),
  'only the SHA-256 hash of the secret is stored');
select is((select count(*)::integer from app.api_keys k where k.secret_hash::text like '%' || (select right(secret, 16) from key_a) || '%'), 0,
  'the plain secret is stored nowhere in the row');

select pg_temp.as_user('bob');
select throws_ok($$select app.create_api_key(pg_temp.id('org_a'), 'Bad', array['finances'], now() + interval '1 day')$$,
  'XR001', 'api_key_scope_unknown: finances is not a capability group.', 'scopes must be capability groups from the registry');
select throws_ok($$select app.create_api_key(pg_temp.id('org_a'), 'Bad', array[]::text[], now() + interval '1 day')$$,
  '23514', null, 'a key needs at least one scope');
select throws_ok($$select app.create_api_key(pg_temp.id('org_a'), 'Bad', array['org'], now() - interval '1 minute')$$,
  'XR001', null, 'an expiry in the past is refused');
select throws_ok($$select app.create_api_key(pg_temp.id('org_a'), 'Bad', array['org'], now() + interval '400 days')$$,
  'XR001', null, 'an expiry more than a year ahead is refused');
select throws_ok($$select app.create_api_key(pg_temp.id('org_a'), '  ', array['org'], now() + interval '1 day')$$,
  '23514', null, 'a key needs a name');
select throws_ok($$insert into app.api_keys (org_id, name, scopes, expires_at, prefix, secret_hash)
  values (pg_temp.id('org_a'), 'Direct', array['org'], now() + interval '1 day', 'xos_live_00000000', sha256('x'))$$,
  '42501', null, 'keys are never inserted directly');

-- Role bands -------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select lives_ok($$select app.create_api_key(pg_temp.id('org_a'), 'Owner Key', array['org'], now() + interval '1 day')$$,
  'an owner creates keys');
select pg_temp.as_user('carol');
select throws_ok($$select app.create_api_key(pg_temp.id('org_a'), 'Manager Key', array['org'], now() + interval '1 day')$$,
  '42501', 'organization not found', 'a manager cannot create keys');
select is((select count(*)::integer from app.api_keys), 0, 'a manager reads no keys');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.api_keys), 0, 'a member reads no keys');
select pg_temp.as_user('bob');
select is((select count(*)::integer from app.api_keys), 2, 'an admin lists the org''s keys');

-- Plans and tenants -----------------------------------------------------------------------------------------------
select pg_temp.as_user('xavier');
select throws_ok($$select app.create_api_key(pg_temp.id('org_b'), 'Harbor', array['org'], now() + interval '1 day')$$,
  'XR001', 'plan_feature_required: API keys need the Pro plan or above.', 'keys need the api_keys plan feature');
select throws_ok($$select app.create_api_key(pg_temp.id('org_a'), 'Cross', array['org'], now() + interval '1 day')$$,
  '42501', null, 'an admin of another org cannot create keys here');
select is((select count(*)::integer from app.api_keys where org_id = pg_temp.id('org_a')), 0, 'no cross-tenant key reads');
select throws_ok(format('select app.revoke_api_key(%L)', (select api_key_id from key_a)), '42501', 'API key not found',
  'another org cannot revoke the key');
select pg_temp.as_anon();
select throws_ok($$select app.create_api_key(gen_random_uuid(), 'Anon', array['org'], now() + interval '1 day')$$,
  '42501', null, 'anon cannot create keys');

-- Updates ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok(format($$update app.api_keys set name = 'Ledger Sync', scopes = array['finance'] where id = %L$$, (select api_key_id from key_a)),
  'an admin renames and rescopes a key');
select throws_ok(format($$update app.api_keys set prefix = 'xos_live_ffffffff' where id = %L$$, (select api_key_id from key_a)),
  '42501', null, 'the prefix is not writable');
select pg_temp.as_user('carol');
update app.api_keys set name = 'Hijacked' where id = (select api_key_id from key_a);
select pg_temp.as_user('bob');
select is((select name from app.api_keys where id = (select api_key_id from key_a)), 'Ledger Sync', 'a manager cannot rename a key');

-- Authentication -----------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select results_eq(format('select org_id, scopes from app.authenticate_api_key(%L)', (select secret from key_a)),
  format($$values (%L::uuid, array['finance']::text[])$$, pg_temp.id('org_a')), 'a valid secret resolves its org and scopes');
select pg_temp.as_platform();
select ok((select last_used_at is not null from app.api_keys where id = (select api_key_id from key_a)), 'use is recorded');
select pg_temp.as_anon();
select is((select count(*)::integer from app.authenticate_api_key('xos_live_' || repeat('0', 48))), 0, 'an unknown secret resolves nothing');
select is((select count(*)::integer from app.authenticate_api_key('not a key')), 0, 'a malformed secret resolves nothing');

-- Revocation and expiry -----------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok(format('select app.revoke_api_key(%L)', (select api_key_id from key_a)), 'an admin revokes a key');
select throws_ok(format('select app.revoke_api_key(%L)', (select api_key_id from key_a)), 'XR001',
  'api_key_revoked: This key is already revoked.', 'a revoked key cannot be revoked again');
select throws_ok(format($$update app.api_keys set name = 'Revived' where id = %L$$, (select api_key_id from key_a)), 'XR001', null,
  'a revoked key cannot be changed');
select pg_temp.as_anon();
select is((select count(*)::integer from app.authenticate_api_key((select secret from key_a))), 0, 'a revoked key no longer authenticates');
select pg_temp.as_user('alice');
create temporary table key_b as select * from app.create_api_key(pg_temp.id('org_a'), 'Short', array['org'], now() + interval '1 day');
grant select on key_b to public;
select pg_temp.as_platform();
alter table app.api_keys disable trigger t20_guard_api_key;
update app.api_keys set expires_at = now() - interval '1 second' where id = (select api_key_id from key_b);
alter table app.api_keys enable trigger t20_guard_api_key;
select pg_temp.as_anon();
select is((select count(*)::integer from app.authenticate_api_key((select secret from key_b))), 0, 'an expired key no longer authenticates');

select * from finish();
rollback;
