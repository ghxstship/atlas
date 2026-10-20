-- pgTAP: the public organization profile returns the org id (0934). Builds its own org and Public profile
-- (0200 identity world), so it passes on a database without the demo seed (A71, RRR-116).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(2);

select pg_temp.as_user('alice');
select app.ensure_organization_profile(pg_temp.id('org_a'));
update app.organization_profiles set visibility = 'Public' where org_id = pg_temp.id('org_a');

select pg_temp.as_anon();
select is(
  (select org_id from api_public.organization_profile('northwind-live')),
  pg_temp.id('org_a'),
  'a Public org profile returns its org id to anon'
);
select is(
  (select count(*)::integer from api_public.organization_profile('no-such-company')),
  0,
  'an unknown handle returns nothing'
);

select * from finish();
rollback;
