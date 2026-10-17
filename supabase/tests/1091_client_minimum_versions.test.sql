-- pgTAP: the server-advertised minimum client version (A39, Section 5.1, journey 40).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(12);

select pg_temp.as_platform();
select results_eq(
  $$select minimum_version, update_url from api_public.client_minimum_version('compass', 'ios')$$,
  $$values ('4.0.0'::text, null::text)$$,
  'Compass on iOS starts at the first build, 4.0.0, with no store page yet');
select is((select count(*)::int from api_public.client_minimum_version('compass', 'android')), 1, 'Android has its own floor');
select is((select count(*)::int from api_public.client_minimum_version('compass', 'web')), 0, 'an unknown platform has no floor');

-- Anyone may read it, before sign-in too.
select pg_temp.as_anon();
select is((select minimum_version from api_public.client_minimum_version('compass', 'ios')), '4.0.0', 'anon reads the floor, so the launch check runs before sign-in');
select throws_ok('select * from private.client_minimum_versions', '42501', null, 'anon cannot read the table itself');
select pg_temp.as_user('dave');
select is((select minimum_version from api_public.client_minimum_version('compass', 'ios')), '4.0.0', 'a signed-in person reads the same floor');
select throws_ok($$update private.client_minimum_versions set minimum_version = '1.0.0'$$, '42501', null, 'a signed-in person cannot lower the floor');

-- Only the service role raises it.
select pg_temp.as_platform();
set local role service_role;
update private.client_minimum_versions set minimum_version = '4.1.0', update_url = 'https://apps.example.com/compass'
where client = 'compass' and platform = 'ios';
reset role;
select results_eq(
  $$select minimum_version, update_url from api_public.client_minimum_version('compass', 'ios')$$,
  $$values ('4.1.0'::text, 'https://apps.example.com/compass'::text)$$,
  'a raised floor and its store page read back');

-- Invariants: a semantic version, an https store page, known clients and platforms.
select throws_ok($$update private.client_minimum_versions set minimum_version = '4.1' where platform = 'ios'$$, '23514', null, 'the floor is MAJOR.MINOR.PATCH');
select throws_ok($$update private.client_minimum_versions set update_url = 'http://apps.example.com' where platform = 'ios'$$, '23514', null, 'the store page is https');
select throws_ok($$insert into private.client_minimum_versions (client, platform, minimum_version) values ('atlas', 'ios', '1.0.0')$$, '23514', null, 'only known clients');
select throws_ok($$insert into private.client_minimum_versions (client, platform, minimum_version) values ('compass', 'web', '1.0.0')$$, '23514', null, 'only known platforms');

select * from finish();
rollback;
