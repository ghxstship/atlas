-- pgTAP: migration 2600 (R1), project people pickers. app.project_people returns the org's current members and the
-- people named on the project's live engagements, one row each, with the engagement and the supplying account;
-- members of an engaged account who are not named never appear; a person's Active engagement wins; a Canceled
-- engagement drops out. Callers without a people picker capability on the project, and external callers, get
-- 42501. app.engagement_options lists the live engagements of reachable projects, filtered by project.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');

-- ivy also holds a newer engagement still in Onboarding; quinn's only engagement on prj_a is Canceled.
select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('ivy'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-08-01')
  returning id) insert into world select 'eng_ivy_a_later', id from x;
with x as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('quinn'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01')
  returning id) insert into world select 'eng_quinn_a', id from x;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_quinn_a', 'Onboarding', 'Canceled');

-- A producer with credentials.credential.issue --------------------------------------------------------------------------
select pg_temp.as_user('carol');
select ok(exists (select 1 from app.project_people(pg_temp.id('prj_a')) where person_id = pg_temp.id('dave') and membership_id = pg_temp.id('dave@org_a')),
  'members come with their membership');
select ok(exists (select 1 from app.project_people(pg_temp.id('prj_a')) where person_id = pg_temp.id('dave') and engagement_id is null),
  'a member without an engagement carries none');
select is((select engagement_id from app.project_people(pg_temp.id('prj_a')) where person_id = pg_temp.id('sam')), pg_temp.id('eng_vendor_a'),
  'a vendor-supplied person named on a person-plus-counterparty engagement appears with the engagement');
select is((select account_name from app.project_people(pg_temp.id('prj_a')) where person_id = pg_temp.id('sam')), 'Bayside Audio',
  'and the name of the account that supplies them');
select is((select membership_id from app.project_people(pg_temp.id('prj_a')) where person_id = pg_temp.id('sam')), null::uuid,
  'an engaged non-member has no membership');
select is((select role_type::text || ' ' || engagement_state::text from app.project_people(pg_temp.id('prj_a')) where person_id = pg_temp.id('sam')),
  'Vendor Active', 'with the engagement''s role type and state');
select ok(not exists (select 1 from app.project_people(pg_temp.id('prj_a')) where person_id = pg_temp.id('victor')),
  'a vendor-account Owner not named on an engagement is absent');
select ok(not exists (select 1 from app.project_people(pg_temp.id('prj_a')) where person_id = pg_temp.id('fiona')),
  'so is a vendor-account member without their own engagement');
select is((select count(*)::int from app.project_people(pg_temp.id('prj_a')) where person_id = pg_temp.id('ivy')), 1, 'one row per person');
select is((select engagement_id from app.project_people(pg_temp.id('prj_a')) where person_id = pg_temp.id('ivy')), pg_temp.id('eng_ivy_a'),
  'the Active engagement wins over a later one still in Onboarding');
select ok(exists (select 1 from app.project_people(pg_temp.id('prj_a')) where person_id = pg_temp.id('art') and engagement_state = 'Onboarding'),
  'an Onboarding engagement is live');
select ok(not exists (select 1 from app.project_people(pg_temp.id('prj_a')) where person_id = pg_temp.id('quinn')),
  'a person with only a Canceled engagement is absent');
select is((select array_agg(full_name order by ordinality) = array_agg(full_name order by full_name)
  from app.project_people(pg_temp.id('prj_a')) with ordinality), true, 'ordered by name');
select ok(not exists (select 1 from app.project_people(pg_temp.id('prj_a2')) where engagement_id is not null),
  'another project carries only its own engagements');

-- Who reaches the picker -------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select ok(exists (select 1 from app.project_people(pg_temp.id('prj_a'))), 'a Coordinator with assigned reach on the project reads it');
select pg_temp.as_user('erin');
select throws_ok(format('select * from app.project_people(%L)', pg_temp.id('prj_a2')), '42501', 'a people picker capability is required on the project',
  'a Collaborator not on the project holds none of the nine capabilities');
select pg_temp.as_user('sam');
select throws_ok(format('select * from app.project_people(%L)', pg_temp.id('prj_a')), '42501', null, 'an external caller is refused');
select pg_temp.as_user('xavier');
select throws_ok(format('select * from app.project_people(%L)', pg_temp.id('prj_a')), '42501', null, 'another org is refused');
select pg_temp.as_anon();
select throws_ok(format('select * from app.project_people(%L)', pg_temp.id('prj_a')), '42501', null, 'anon is refused');

-- Engagement options ------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a_later', 'Onboarding', 'Canceled');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.engagement_options(pg_temp.id('org_a'))), 3, 'the live engagements of the org''s projects');
select ok(not exists (select 1 from app.engagement_options(pg_temp.id('org_a')) where engagement_id in (pg_temp.id('eng_quinn_a'), pg_temp.id('eng_ivy_a_later'))),
  'Canceled engagements never appear');
select is((select account_name from app.engagement_options(pg_temp.id('org_a')) where engagement_id = pg_temp.id('eng_vendor_a')), 'Bayside Audio',
  'with the supplying account');
select is((select person_name || ' ' || project_key from app.engagement_options(pg_temp.id('org_a')) where engagement_id = pg_temp.id('eng_art_a')), 'Arturo Bell NWL',
  'the person and the project key');
select is((select count(*)::int from app.engagement_options(pg_temp.id('org_a'), pg_temp.id('prj_a2'))), 0, 'filtered by project');
select is((select count(*)::int from app.engagement_options(pg_temp.id('org_a'), pg_temp.id('prj_a'))), 3, 'one project''s engagements');
select pg_temp.as_user('erin');
select is((select count(*)::int from app.engagement_options(pg_temp.id('org_a'))), 3, 'a Collaborator reaches the projects they are assigned to');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.engagement_options(pg_temp.id('org_a'))), 0, 'a Viewer on no project reaches none');
select pg_temp.as_user('xavier');
select throws_ok(format('select * from app.engagement_options(%L)', pg_temp.id('org_a')), '42501', null, 'a non-member of the org is refused');
select pg_temp.as_user('sam');
select throws_ok(format('select * from app.engagement_options(%L)', pg_temp.id('org_a')), '42501', null, 'an external caller is refused');

select * from finish();
rollback;
