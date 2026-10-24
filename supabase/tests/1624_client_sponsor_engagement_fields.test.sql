-- pgTAP: migration 1624, ADR 0033 decision 69 (2026-10-23, RRR-125, ADR 0019 amendment). Client and Sponsor engagements
-- carry no canon role, worker classification, pay or employment terms; every other engagement still names a role and a
-- classification. The views every surface reads keep an engagement without a role, with its workforce columns NULL, and
-- engaging a sponsor from an accepted application keeps none of the terms the caller passes.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(14);

-- A sponsor account (Gulfside Brewing, sol its Account Owner) and its counterparty in Northwind.
select pg_temp.new_user('sol', 'sol@gulfside.test', 'Sol Ferreira');
select pg_temp.as_user('sol');
insert into world values ('acct_s', app.create_external_account('Gulfside Brewing', 'gulfside-brewing'));
select pg_temp.as_user('alice');
insert into world values ('cp_s_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_s')));

-- 1. The database keeps work terms off client and sponsor engagements -----------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sol'), pg_temp.id('cp_s_a'), 'Sponsor', '2027-06-01')$$,
  'a sponsor engagement needs no role, classification or pay terms');
insert into world select 'eng_sponsor', e.id from app.engagements e where e.person_id = pg_temp.id('sol');
select throws_ok($$insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis,
    arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sol'), pg_temp.id('cp_s_a'), 'Sponsor', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate',
    'Per Engagement', '2027-06-01')$$,
  'XR001', 'engagement_work_terms: Sponsor engagements carry no role, worker classification, pay or employment terms.',
  'and cannot carry them');
select throws_ok(format($$update app.engagements set agreed_rate_minor = 250000, currency_code = 'USD' where id = %L$$, pg_temp.id('eng_sponsor')),
  'XR001', null, 'not even an agreed rate later');
select throws_ok($$insert into app.engagements (project_id, person_id, counterparty_id, role_type, employment_status, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sol'), pg_temp.id('cp_s_a'), 'Client', 'Full-Time', '2027-06-01')$$,
  'XR001', null, 'nor a client engagement employment terms');
select throws_ok($$insert into app.engagements (project_id, person_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('quinn'), 'Crew', '2027-06-01')$$,
  'XR001', 'engagement_role_required: An engagement of someone who works for the org names a canon role and worker classification.',
  'a crew engagement still names its role and classification');
select pg_temp.as_platform();
set local session_replication_role = replica;
select throws_ok(format($$update app.engagements set role_code = '5000.51.02' where id = %L$$, pg_temp.id('eng_sponsor')),
  '23514', null, 'the check constraint holds even when the trigger does not run');
set local session_replication_role = origin;

-- 2. Every surface still lists it, its work terms NULL --------------------------------------------------------------------
select pg_temp.as_user('carol');
select results_eq(format($$select role_type::text, role_code::text, job_title::text, worker_classification::text from app.engagement_board where engagement_id = %L$$,
    pg_temp.id('eng_sponsor')),
  $$values ('Sponsor', null::text, null::text, null::text)$$, 'the Engagements board lists it');
select results_eq(format($$select worker_classification::text, payment_channel::text, pay_basis::text, rate_minor from app.engagement_resolved where engagement_id = %L$$,
    pg_temp.id('eng_sponsor')),
  $$values (null::text, null::text, null::text, null::bigint)$$, 'the resolved engagement reads it with no rate');
select pg_temp.as_user('sol');
select results_eq(format($$select role_type::text, job_title::text, pay_basis::text, rate_minor from api_external.engagements where id = %L$$,
    pg_temp.id('eng_sponsor')),
  $$values ('Sponsor', null::text, null::text, null::bigint)$$, 'the sponsor reads it in Gateway');
select pg_temp.as_platform();
select is((select count(*)::int from app.engagements where role_type in ('Client', 'Sponsor')
    and num_nonnulls(role_code, worker_classification, pay_basis, arrangement, agreed_rate_minor, currency_code,
      employment_status, flsa_status, labor_agreement_id) > 0), 0, 'no client or sponsor engagement holds a work term');

-- 3. Engaging a sponsor from an accepted application keeps no terms --------------------------------------------------------
select pg_temp.as_user('carol');
with o as (insert into app.opportunities (project_id, role_type, title, visibility, starts_on)
  values (pg_temp.id('prj_a'), 'Sponsor', 'Summer Series Beverage Partner', 'Invited', '2027-06-01') returning id)
insert into world select 'opp_sponsor', id from o;
insert into app.opportunity_invitations (opportunity_id, organization_id) values (pg_temp.id('opp_sponsor'), pg_temp.id('acct_v'));
select app.transition_opportunity(pg_temp.id('opp_sponsor'), 'Draft', 'Pending Approval', 'Ready.');
select app.transition_opportunity(pg_temp.id('opp_sponsor'), 'Pending Approval', 'Published', 'Approved.');
select pg_temp.as_user('victor');
with a as (insert into app.applications (opportunity_id, applicant_organization_id) values (pg_temp.id('opp_sponsor'), pg_temp.id('acct_v')) returning id)
insert into world select 'app_sponsor', id from a;
select pg_temp.as_user('carol');
select app.transition_application(pg_temp.id('app_sponsor'), 'Submitted', 'In Review', 'Shortlisted.');
with o as (select app.send_offer(pg_temp.id('app_sponsor'), 'Flat', 1500000, 'USD', null, null, null, null) as id)
insert into world select 'offer_sponsor', id from o;
select pg_temp.as_user('victor');
select app.accept_offer(pg_temp.id('offer_sponsor'));
select pg_temp.as_user('carol');
select lives_ok(format($$select app.create_engagement_from_application(%L, 'INDEPENDENT_CONTRACTOR', 'Flat Fee', 'Per Engagement', null, null)$$,
    pg_temp.id('app_sponsor')),
  'a sponsor is engaged from an accepted application, through the same call API v1 makes');
select pg_temp.as_platform();
select results_eq(format($$select role_type::text, role_code::text, worker_classification::text, pay_basis::text, agreed_rate_minor from app.engagements
    where application_id = %L$$, pg_temp.id('app_sponsor')),
  $$values ('Sponsor', null::text, null::text, null::text, null::bigint)$$,
  'and its engagement keeps none of the classification, pay terms or offer amount passed');
select ok((select counterparty_id is not null from app.engagements where application_id = pg_temp.id('app_sponsor')),
  'it names the sponsor''s account as its counterparty');
select is((select worker_classification from app.engagements where id = pg_temp.id('eng_ivy_a')), 'INDEPENDENT_CONTRACTOR',
  'crew engagements keep theirs');

select * from finish();
rollback;
