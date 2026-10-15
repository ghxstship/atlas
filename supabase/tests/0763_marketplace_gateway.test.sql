-- pgTAP: migration 0763, the Gateway marketplace additions. Saved opportunities (RLS: own allow, other person deny,
-- anon deny; invariants: only open listings, Do Not Engage refuses like an unseen listing, fixed opportunity and
-- person), the caller's own marketplace projections, the venue locality and the certification requirements check.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Fixture ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
update app.venues set locality = 'Miami' where id = pg_temp.id('venue_a');
with c as (insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_a'), 'Rigging Level 2', 'Fictional Rigging Board')
  returning id) insert into world select 'cert_rig', id from c;
with c as (insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_a'), 'First Aid', 'Fictional Aid Council')
  returning id) insert into world select 'cert_aid', id from c;
insert into app.certification_holders (certification_id, person_id, issued_on, expires_on)
values (pg_temp.id('cert_rig'), pg_temp.id('ivy'), '2026-01-01', '2030-01-01'),
       (pg_temp.id('cert_aid'), pg_temp.id('ivy'), '2020-01-01', '2021-01-01');
select pg_temp.as_user('carol');
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, venue_id, starts_on, ends_on, requisition_id)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Summer Series Riggers', 'Invited', pg_temp.id('venue_a'), '2027-06-01', '2027-06-03', pg_temp.id('requisition_a'))
  returning id) insert into world select 'opp', id from o;
insert into app.opportunity_invitations (opportunity_id, person_id) values (pg_temp.id('opp'), pg_temp.id('ivy')), (pg_temp.id('opp'), pg_temp.id('quinn'));
insert into app.opportunity_requirements (opportunity_id, requirement_kind, description, certification_id) values
  (pg_temp.id('opp'), 'Certification', 'Rigging Level 2 or higher.', pg_temp.id('cert_rig')),
  (pg_temp.id('opp'), 'Certification', 'Current first aid.', pg_temp.id('cert_aid'));
insert into app.opportunity_requirements (opportunity_id, requirement_kind, description) values (pg_temp.id('opp'), 'Equipment', 'Own harness.');
with q as (insert into app.opportunity_questions (opportunity_id, prompt, sort_order, is_required)
  values (pg_temp.id('opp'), 'Which venues have you rigged?', 1, true) returning id) insert into world select 'q', id from q;
with o as (insert into app.opportunities (project_id, role_type, title, visibility, starts_on)
  values (pg_temp.id('prj_a'), 'Crew', 'Draft Call', 'Invited', '2027-06-01') returning id) insert into world select 'opp_draft', id from o;
select app.transition_opportunity(pg_temp.id('opp'), 'Draft', 'Pending Approval', 'Ready.');
select app.transition_opportunity(pg_temp.id('opp'), 'Pending Approval', 'Published', 'Approved.');
select pg_temp.as_platform();

-- Saved opportunities: invariants ------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select lives_ok(format($$insert into app.saved_opportunities (opportunity_id) values ('%s')$$, pg_temp.id('opp')), 'ivy saves an open listing');
select is((select person_id from app.saved_opportunities), pg_temp.id('ivy'), 'the person comes from the session');
select throws_ok(format($$insert into app.saved_opportunities (opportunity_id) values ('%s')$$, pg_temp.id('opp')), '23505', null,
  'a listing is saved once');
select throws_ok(format($$insert into app.saved_opportunities (opportunity_id) values ('%s')$$, pg_temp.id('opp_draft')), 'XR001',
  'opportunity_not_available: This opportunity is not open to you.', 'a listing not open to the person cannot be saved');
select throws_ok(format($$insert into app.saved_opportunities (opportunity_id, person_id) values ('%s', '%s')$$, pg_temp.id('opp'), pg_temp.id('quinn')),
  '42501', null, 'the person column is never written by the caller');
select pg_temp.as_platform();
select pg_temp.as_user('alice');
insert into app.talent_pools (org_id, name, pool_kind) values (pg_temp.id('org_a'), 'Riggers', 'Talent');
insert into app.pool_members (talent_pool_id, person_id, standing, reason, review_on)
select p.id, pg_temp.id('quinn'), 'Do Not Engage', 'No-show at the spring load-in.', '2027-01-01' from app.talent_pools p where p.name = 'Riggers';
select pg_temp.as_user('quinn');
select throws_ok(format($$insert into app.saved_opportunities (opportunity_id) values ('%s')$$, pg_temp.id('opp')), 'XR001',
  'opportunity_not_available: This opportunity is not open to you.', 'a Do Not Engage flag refuses with the same words, so it never shows');
select pg_temp.as_platform();
select throws_ok(format($$update app.saved_opportunities set opportunity_id = '%s'$$, pg_temp.id('opp_draft')), 'XR001', null,
  'a saved opportunity keeps its opportunity on every path');

-- Saved opportunities: RLS ----------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from app.saved_opportunities'), 1, 'own allow');
select is(pg_temp.n('quinn', 'select 1 from app.saved_opportunities'), 0, 'another person reads none');
select is(pg_temp.n('alice', 'select 1 from app.saved_opportunities'), 0, 'the org never sees who saved its listing');
select pg_temp.as_anon();
select throws_ok('select 1 from app.saved_opportunities', '42501', null, 'anon deny');
select throws_ok('select 1 from api_external.my_saved_opportunities', '42501', null, 'anon cannot read the projection');
select pg_temp.as_platform();
select is(pg_temp.n('ivy', 'select 1 from api_external.my_saved_opportunities where is_open'), 1, 'the projection lists the open save');

-- Opportunity detail: locality and the requirements check ---------------------------------------------------------------------
select pg_temp.as_user('ivy');
select is((select venue_locality from api_external.opportunities where id = pg_temp.id('opp')), 'Miami', 'the listing shows the venue city');
select is((select caller_holds from api_external.opportunity_requirements where certification_id = pg_temp.id('cert_rig')), true,
  'a current holding meets the certification requirement');
select is((select caller_holds from api_external.opportunity_requirements where certification_id = pg_temp.id('cert_aid')), false,
  'an expired holding does not');
select is((select caller_holds from api_external.opportunity_requirements where requirement_kind = 'Equipment'), null::boolean,
  'non-certification requirements carry no check');
select is((select count(*)::int from api_external.my_certifications), 2, 'ivy lists her holdings');
select is((select count(*)::int from api_external.my_certifications where is_current), 1, 'one is current');
select pg_temp.as_platform();
select is(pg_temp.n('quinn', 'select 1 from api_external.my_certifications'), 0, 'another person lists none of ivy''s holdings');

-- Unsave by soft delete ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select lives_ok('update app.saved_opportunities set deleted_at = now()', 'ivy removes the save');
select is((select count(*)::int from api_external.my_saved_opportunities), 0, 'the removed save leaves the list');
select lives_ok(format($$insert into app.saved_opportunities (opportunity_id) values ('%s')$$, pg_temp.id('opp')), 'and can save it again');
select pg_temp.as_platform();

-- Saved searches, alerts, applications, slates and calendars ------------------------------------------------------------------------
select pg_temp.as_user('ivy');
insert into app.saved_searches (person_id, name, role_type) values (pg_temp.id('ivy'), 'Rigging Calls', 'Crew');
with a as (insert into app.applications (opportunity_id, applicant_person_id, availability_confirmed) values (pg_temp.id('opp'), pg_temp.id('ivy'), true)
  returning id) insert into world select 'app_ivy', id from a;
insert into app.application_answers (application_id, opportunity_question_id, answer_text) values (pg_temp.id('app_ivy'), pg_temp.id('q'), 'Pier Pavilion.');
insert into app.availability_calendars (person_id, time_zone) values (pg_temp.id('ivy'), 'America/New_York');
select pg_temp.as_platform();
insert into app.opportunity_alerts (saved_search_id, opportunity_id) select s.id, pg_temp.id('opp') from app.saved_searches s where s.name = 'Rigging Calls';
select is(pg_temp.n('ivy', 'select 1 from api_external.my_saved_searches'), 1, 'own saved search');
select is(pg_temp.n('ivy', 'select 1 from api_external.my_opportunity_alerts where is_open'), 1, 'own alert on an open listing');
select is(pg_temp.n('ivy', 'select 1 from api_external.my_application_answers'), 1, 'own application answers');
select is(pg_temp.n('ivy', 'select 1 from api_external.my_availability_calendars'), 1, 'own calendar');
select is(pg_temp.n('quinn', 'select 1 from api_external.my_saved_searches'), 0, 'denial: another person''s saved searches');
select is(pg_temp.n('quinn', 'select 1 from api_external.my_opportunity_alerts'), 0, 'denial: another person''s alerts');
select is(pg_temp.n('quinn', 'select 1 from api_external.my_application_answers'), 0, 'denial: another person''s answers');
select is(pg_temp.n('quinn', 'select 1 from api_external.my_availability_calendars'), 0, 'denial: another person''s calendars');
select is(pg_temp.n('carol', 'select 1 from api_external.my_application_answers'), 0, 'the org reads answers in Atlas, never through api_external');

-- Agency slate through the account ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.opportunity_invitations (opportunity_id, organization_id) values (pg_temp.id('opp'), pg_temp.id('acct_v'));
select pg_temp.as_user('victor');
with a as (insert into app.applications (opportunity_id, applicant_organization_id) values (pg_temp.id('opp'), pg_temp.id('acct_v')) returning id)
  insert into world select 'app_v', id from a;
insert into app.agency_slates (application_id, person_id) values (pg_temp.id('app_v'), pg_temp.id('sam'));
select pg_temp.as_platform();
select is(pg_temp.n('victor', 'select 1 from api_external.my_agency_slates'), 1, 'account: the Owner lists the agency slate');
select is(pg_temp.n('fiona', 'select 1 from api_external.my_agency_slates'), 0, 'Account Finance does not manage applications');
select is(pg_temp.n('ivy', 'select 1 from api_external.my_agency_slates'), 0, 'denial: another applicant');

select * from finish();
rollback;
