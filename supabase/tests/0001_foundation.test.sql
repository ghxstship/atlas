-- pgTAP: foundation schemas, extensions, privileges and UUID v7.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(19);

select has_schema('xpms');
select has_schema('app');
select has_schema('api_public');
select has_schema('api_external');
select has_schema('private');

select has_extension('extensions', 'pgcrypto', 'pgcrypto lives in extensions');
select has_extension('extensions', 'pg_trgm', 'pg_trgm lives in extensions');
select has_extension('extensions', 'vector', 'vector lives in extensions');
select has_extension('extensions', 'ltree', 'ltree lives in extensions');
select has_extension('extensions', 'postgis', 'postgis lives in extensions');
select has_extension('extensions', 'pg_net', 'pg_net lives in extensions');
select has_extension('pg_cron', 'pg_cron is installed');
select has_extension('supabase_vault', 'supabase_vault is installed');

select ok(
  not has_schema_privilege('anon', 'private', 'usage'),
  'anon has no usage on private'
);
select ok(
  not has_schema_privilege('authenticated', 'private', 'usage'),
  'authenticated has no usage on private'
);
select ok(
  not has_schema_privilege('anon', 'app', 'usage'),
  'anon has no usage on app'
);

select is(
  substring(private.uuid_v7()::text from 15 for 1),
  '7',
  'uuid_v7 sets the version nibble to 7'
);
select ok(
  substring(private.uuid_v7()::text from 20 for 1) in ('8', '9', 'a', 'b'),
  'uuid_v7 keeps the RFC 9562 variant'
);
select ok(
  (select bool_and(a < b) from (
    select u as a, lead(u) over (order by n) as b
    from (select n, private.uuid_v7() as u from generate_series(1, 10) n, lateral (select pg_sleep(0.002) where n > 0) z) s
  ) t where b is not null),
  'uuid_v7 values generated later sort later'
);

select * from finish();
rollback;
