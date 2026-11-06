-- pgTAP: 2331, app.my_wallet_pass names the org's logo for the pass art (A140, RRR-204; follow-up of A93): the
-- dark-theme logo first, else the light one, else none; still nothing for another person's credential.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(8);

select has_function('app', 'my_wallet_pass', array['text', 'uuid'], 'app.my_wallet_pass exists');
select is((select string_agg(p.parameter_name, ',' order by p.ordinal_position)
  from information_schema.parameters p
  join information_schema.routines r on r.specific_name = p.specific_name
  where r.routine_schema = 'app' and r.routine_name = 'my_wallet_pass' and p.parameter_mode = 'OUT'
    and p.parameter_name in ('voided', 'logo_path')), 'voided,logo_path', 'it returns logo_path after 1501''s columns');
select ok(not has_function_privilege('anon', 'app.my_wallet_pass(text,uuid)', 'execute'), 'anon still cannot call it');
select ok(has_function_privilege('authenticated', 'app.my_wallet_pass(text,uuid)', 'execute'), 'a signed-in person can');

-- Fixture: ivy holds a badge on her org_a engagement; frank, a member of org_a, holds his own.
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('alice');
with c as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id)
  insert into world select 'cat', id from c;
with c as (insert into app.credentials (credential_category_id, holder_person_id, engagement_id)
  values (pg_temp.id('cat'), pg_temp.id('ivy'), pg_temp.id('eng_ivy_a')) returning id)
  insert into world select 'cred_ivy', id from c;
with c as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('frank')) returning id)
  insert into world select 'cred_frank', id from c;
select pg_temp.as_platform();
update app.org_brands set deleted_at = now() where org_id = pg_temp.id('org_a') and deleted_at is null;

select pg_temp.as_user('ivy');
select is((select logo_path from app.my_wallet_pass('credential', pg_temp.id('cred_ivy'))), null,
  'an org with no logo gives no logo path, so the pass keeps its accent icon');

select pg_temp.as_platform();
insert into app.org_brands (org_id, logo_light_path) values (pg_temp.id('org_a'), pg_temp.id('org_a')::text || '/logo-light.png');
select pg_temp.as_user('ivy');
select is((select logo_path from app.my_wallet_pass('credential', pg_temp.id('cred_ivy'))),
  pg_temp.id('org_a')::text || '/logo-light.png', 'the light logo when the org has only that one');

select pg_temp.as_platform();
update app.org_brands set logo_dark_path = pg_temp.id('org_a')::text || '/logo-dark.png'
where org_id = pg_temp.id('org_a') and deleted_at is null;
select pg_temp.as_user('ivy');
select is((select logo_path from app.my_wallet_pass('credential', pg_temp.id('cred_ivy'))),
  pg_temp.id('org_a')::text || '/logo-dark.png', 'the dark-theme logo first, since the pass has white labels on the accent');
select is((select count(*)::int from app.my_wallet_pass('credential', pg_temp.id('cred_frank'))), 0,
  'still nothing for another person''s badge');
select pg_temp.as_platform();

select * from finish();
rollback;
