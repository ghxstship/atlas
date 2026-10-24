-- pgTAP: the public brand lookups return the org id (0931). Builds its own org (0200 identity world), so it
-- passes on a database without the demo seed (A71, RRR-116).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(3);

select pg_temp.as_anon();
select is(
  (select org_id from api_public.org_brand_for_slug('northwind-live')),
  pg_temp.id('org_a'),
  'the slug lookup returns the org id to anon'
);
select is(
  (select count(*)::integer from api_public.org_brand_for_slug('no-such-org')),
  0,
  'an unknown slug returns nothing'
);
select ok(
  has_function_privilege('anon', 'api_public.org_brand_for_host(text)', 'execute'),
  'anon may look up a brand by host'
);

select * from finish();
rollback;
