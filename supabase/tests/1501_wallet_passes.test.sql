-- pgTAP: 1501, app.my_wallet_pass gives the wallet-pass Edge Function what a pass for the signed-in person's
-- own credential or shift shows, and nothing for anyone else's (A93, RRR-138; Section 11.10 item 14).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(12);

select has_function('app', 'my_wallet_pass', array['text', 'uuid'], 'app.my_wallet_pass exists');
select isnt(obj_description('app.my_wallet_pass(text,uuid)'::regprocedure, 'pg_proc'), null, 'it is documented');
select ok(not has_function_privilege('anon', 'app.my_wallet_pass(text,uuid)', 'execute'), 'anon cannot call it');

-- Fixture: alice (Owner of org_a) gives ivy a Crew badge and a shift on her org_a engagement, and frank, a
-- member of org_a, a badge of his own.
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('alice');
with c as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id)
  insert into world select 'cat', id from c;
with c as (insert into app.credentials (credential_category_id, holder_person_id, engagement_id, valid_to)
  values (pg_temp.id('cat'), pg_temp.id('ivy'), pg_temp.id('eng_ivy_a'), now() + interval '30 days') returning id)
  insert into world select 'cred_ivy', id from c;
with c as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('frank')) returning id)
  insert into world select 'cred_frank', id from c;
with s as (insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '5000.51.02', '2027-06-01 12:00+00', '2027-06-01 22:00+00', 'America/New_York')
  returning id) insert into world select 'shift_ivy', id from s;
select pg_temp.as_platform();

select pg_temp.as_user('ivy');
select is((select count(*)::int from app.my_wallet_pass('credential', pg_temp.id('cred_ivy'))), 1, 'the holder gets their own badge''s pass');
select is((select barcode from app.my_wallet_pass('credential', pg_temp.id('cred_ivy'))),
  'XOSCR1:' || (select credential_number from app.credentials where id = pg_temp.id('cred_ivy')),
  'its barcode is the payload the Compass badge shows, so gates scan it');
select is((select title || '|' || project_name || '|' || time_zone from app.my_wallet_pass('credential', pg_temp.id('cred_ivy'))),
  'Crew|Northwind Summer Series|America/New_York', 'it names the category, the project and the project''s calendar');
select is((select voided from app.my_wallet_pass('credential', pg_temp.id('cred_ivy'))), false, 'a live badge is not void');
select is((select count(*)::int from app.my_wallet_pass('credential', pg_temp.id('cred_frank'))), 0,
  'nobody gets a pass for another person''s badge');
select is((select title || '|' || kind from app.my_wallet_pass('shift', pg_temp.id('shift_ivy'))),
  (select job_title from xpms.role where role_code = '5000.51.02') || '|shift', 'an engaged person gets a pass for their own shift');
select is((select count(*)::int from app.my_wallet_pass('ticket', pg_temp.id('shift_ivy'))), 0, 'an unknown kind returns nothing');

select pg_temp.as_user('frank');
select is((select count(*)::int from app.my_wallet_pass('shift', pg_temp.id('shift_ivy'))), 0, 'nor for another person''s shift');

-- A revoked badge's pass is void, so the wallet shows it as no longer valid.
select pg_temp.as_user('alice');
update app.credentials set revoked_at = now() where id = pg_temp.id('cred_ivy');
select pg_temp.as_user('ivy');
select is((select voided from app.my_wallet_pass('credential', pg_temp.id('cred_ivy'))), true, 'a revoked badge''s pass is void');
select pg_temp.as_platform();

select * from finish();
rollback;
