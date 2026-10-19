-- pgTAP: migration 1207, blocking by handle (A52). A person blocks a profile they can see by its handle, idempotently; a
-- hidden profile and an unknown handle are refused alike; app.my_blocks lists their blocks with handle and name, and
-- nobody else's.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(8);

select pg_temp.as_user('xavier');
select app.ensure_my_profile();
update app.person_profiles set visibility = 'Public';
select app.ensure_organization_profile(pg_temp.id('org_b'));
update app.organization_profiles set visibility = 'Public' where org_id = pg_temp.id('org_b');
select pg_temp.as_user('paul');
select app.ensure_my_profile();

select pg_temp.as_user('dave');
select ok(app.block_profile('person', 'xavier-dubois') is not null, 'Dave blocks a Public profile by its handle');
select is(app.block_profile('person', 'Xavier-Dubois'), (select id from app.blocks where blocked_person_id = pg_temp.id('xavier')),
  'blocking again returns the same block');
select lives_ok($$select app.block_profile('organization', 'harbor-lights')$$, 'and an organization by its handle');
select throws_ok($$select app.block_profile('person', 'paul-brennan')$$,
  'XR001', 'block_handle_unknown: No profile with this handle is visible to you.', 'a Private profile cannot be found to block');
select throws_ok($$select app.block_profile('person', 'nobody-at-all')$$,
  'XR001', 'block_handle_unknown: No profile with this handle is visible to you.', 'an unknown handle answers the same');
select results_eq($$select blocked_kind, blocked_handle, blocked_name from app.my_blocks() order by blocked_kind$$,
  $$values ('organization', 'harbor-lights', 'Harbor Lights Productions'), ('person', 'xavier-dubois', 'Xavier Dubois')$$,
  'my_blocks lists both with handle and name');

select pg_temp.as_user('xavier');
select is((select count(*)::int from app.my_blocks()), 0, 'the blocked person sees none of them');

select pg_temp.as_anon();
select throws_ok($$select app.block_profile('person', 'xavier-dubois')$$, '42501', null, 'anon cannot block');

select * from finish();
rollback;
