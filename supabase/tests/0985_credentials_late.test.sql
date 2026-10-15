-- pgTAP: A14 late slot (migration 0985). A credential's engagement, for party badges, must be a live
-- engagement on the credential's project; the module's tables are audited without Restricted
-- medical notes and carry retention policies.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(11);

select pg_temp.as_user('carol');
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'ARTIST', 'Artist Party') returning id) insert into world select 'cat', id from x;
select pg_temp.as_platform();
insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
select p.project, pg_temp.id('erin'), 'Artist', '2000.50.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', current_date
from (values (pg_temp.id('prj_a')), (pg_temp.id('prj_a2'))) p (project);
insert into world select 'eng', id from app.engagements where project_id = pg_temp.id('prj_a') and person_id = pg_temp.id('erin');
insert into world select 'eng_other', id from app.engagements where project_id = pg_temp.id('prj_a2') and person_id = pg_temp.id('erin');

select pg_temp.as_user('carol');
select throws_ok($$insert into app.credentials (credential_category_id, holder_person_id, engagement_id) values ((select id from world where key = 'cat'), (select id from world where key = 'erin'), (select id from world where key = 'cat'))$$,
  'XR001', null, 'an engagement id must name an engagement');
select throws_ok($$insert into app.credentials (credential_category_id, holder_person_id, engagement_id) values ((select id from world where key = 'cat'), (select id from world where key = 'erin'), (select id from world where key = 'eng_other'))$$,
  'XR001', 'credential_engagement_project: A credential''s engagement belongs to the same project as its category.', 'a party badge''s engagement is on the same project');
select lives_ok($$insert into app.credentials (credential_category_id, holder_person_id, engagement_id) values ((select id from world where key = 'cat'), (select id from world where key = 'erin'), (select id from world where key = 'eng'))$$,
  'a party badge is issued under an engagement on its project');
select is((select engagement_id from app.credentials where holder_person_id = pg_temp.id('erin')), pg_temp.id('eng'), 'the credential keeps its engagement');
select pg_temp.as_platform();

-- Audit trails and retention ------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'FOH', 'Front of House') returning id) insert into world select 'zone', id from x;
with x as (insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
  values (pg_temp.id('cat'), pg_temp.id('zone'), 'ENM-036', now() - interval '1 day', now() + interval '1 day') returning id) insert into world select 'grid', id from x;
with x as (insert into app.incidents (project_id, title, severity_enum_id, occurred_at) values (pg_temp.id('prj_a'), 'Guest Fall Near Gate 2', 'ENM-099', now()) returning id) insert into world select 'inc', id from x;
select pg_temp.as_user('alice');
select app.record_medical_encounter(pg_temp.id('inc'), 'Guest, adult.', 'Abrasion to the knee, cleaned and dressed.', 'Released');
select pg_temp.as_platform();
select ok(exists (select 1 from app.audit_events where subject_table = 'app.credentials' and subject_id = (select id from app.credentials where holder_person_id = pg_temp.id('erin'))), 'issuing a credential is audited');
select ok(exists (select 1 from app.audit_events where subject_table = 'app.access_grid' and subject_id = pg_temp.id('grid')), 'a grid change is audited');
select ok(exists (select 1 from app.audit_events where subject_table = 'app.incidents' and subject_id = pg_temp.id('inc')), 'an incident is audited');
select ok(exists (select 1 from app.audit_events where subject_table = 'app.medical_encounters'), 'a medical encounter is audited');
select ok(not exists (select 1 from app.audit_events where subject_table = 'app.medical_encounters' and diff::text like '%Abrasion%'), 'without its Restricted notes');
select is((select count(*)::int from private.retention_policies where table_name in ('app.credentials', 'app.access_scans', 'app.incidents', 'app.medical_encounters', 'app.radio_channels')), 5,
  'the module''s tables carry retention policies');
select is((select basis::text from private.retention_policies where table_name = 'app.access_scans'), 'Age', 'the scan ledger is kept by age');

select * from finish();
rollback;
