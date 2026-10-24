-- pgTAP: migration 1385, finding A65-014 (RRR-127). OSHA recordkeeping: establishments and summaries for those who handle
-- incidents, cases (health information) only for holders of the medical capability, case numbers per establishment and
-- year, the 180-day cap and outcome rules, members only as named employees, and the 300A totals without names.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(17);

-- The forms sit behind the compliance.us_forms flag, off by default (1593, ADR 0033 decision 54); org_a has it on here.
select pg_temp.as_platform();
insert into app.feature_flag_overrides (org_id, flag_key, enabled, reason)
values (pg_temp.id('org_a'), 'compliance.us_forms', true, 'Test: the forms are on for org_a.');

-- Establishments ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$insert into app.osha_establishments (org_id, name) values ((select id from world where key = 'org_a'), 'Warehouse')$$,
  '42501', null, 'a Member cannot add an establishment');
select pg_temp.as_user('alice');
insert into app.osha_establishments (org_id, name, street_address, locality, region_code, postal_code, naics_code, industry_description)
values (pg_temp.id('org_a'), 'Northwind Shop', '100 Harbor Way', 'Miami', 'FL', '33132', '711310', 'Promoters of live events');
insert into world select 'est', id from app.osha_establishments where name = 'Northwind Shop';
select throws_ok($$insert into app.osha_establishments (org_id, name, region_code) values ((select id from world where key = 'org_a'), 'Bad', 'Florida')$$,
  '23514', null, 'the state is two letters');

-- Cases ------------------------------------------------------------------------------------------------------------------
insert into app.osha_cases (establishment_id, person_id, job_title, injury_date, event_location, description, outcome, days_away, case_type)
values (pg_temp.id('est'), pg_temp.id('frank'), 'Rigger', '2026-03-10', 'Loading dock north end',
  'Sprained left ankle stepping off the truck ramp', 'Days away from work', 4, 'Injury');
insert into app.osha_cases (establishment_id, employee_name, privacy_case, job_title, injury_date, event_location, description, outcome, case_type)
values (pg_temp.id('est'), 'Temporary stagehand', true, 'Stagehand', '2026-05-02', 'Stage left',
  'Needlestick from a contaminated sharp', 'Other recordable case', 'All other illnesses');
select results_eq($$select case_number, log_year::int from app.osha_cases order by injury_date$$,
  $$values ('001'::text, 2026), ('002'::text, 2026)$$, 'cases are numbered on the establishment''s log for the year');
select throws_ok($$insert into app.osha_cases (establishment_id, person_id, job_title, injury_date, event_location, description, outcome, days_away, days_restricted, case_type)
  values ((select id from world where key = 'est'), (select id from world where key = 'frank'), 'Rigger', '2026-06-01', 'Dock', 'Back strain', 'Days away from work', 120, 70, 'Injury')$$,
  '23514', null, 'days away and of restriction stop counting at 180 together');
select throws_ok($$insert into app.osha_cases (establishment_id, person_id, job_title, injury_date, event_location, description, outcome, days_away, case_type)
  values ((select id from world where key = 'est'), (select id from world where key = 'frank'), 'Rigger', '2026-06-01', 'Dock', 'Back strain', 'Job transfer or restriction', 3, 'Injury')$$,
  '23514', null, 'a job transfer case has no days away');
select throws_ok($$insert into app.osha_cases (establishment_id, person_id, job_title, injury_date, event_location, description, outcome, case_type)
  values ((select id from world where key = 'est'), (select id from world where key = 'xavier'), 'Rigger', '2026-06-01', 'Dock', 'Back strain', 'Other recordable case', 'Injury')$$,
  'XR001', null, 'a person on a case is a member of the org');
select throws_ok($$insert into app.osha_cases (establishment_id, person_id, job_title, injury_date, event_location, description, outcome, case_type, died_on)
  values ((select id from world where key = 'est'), (select id from world where key = 'frank'), 'Rigger', '2026-06-01', 'Dock', 'Back strain', 'Other recordable case', 'Injury', '2026-06-02')$$,
  '23514', null, 'a date of death needs the Death outcome');

-- Who reads cases ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select is((select count(*)::int from app.osha_cases), 0, 'an Admin without the medical capability reads no case');
select is((select count(*)::int from app.osha_establishments), 1, 'but reads the establishment');
select throws_ok($$insert into app.osha_cases (establishment_id, employee_name, job_title, injury_date, event_location, description, outcome, case_type)
  values ((select id from world where key = 'est'), 'Someone', 'Rigger', '2026-06-01', 'Dock', 'Cut', 'Other recordable case', 'Injury')$$,
  '42501', null, 'nor writes one');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.osha_establishments), 0, 'another org reads nothing');
select throws_ok($$select * from app.osha_summary((select id from world where key = 'est'), 2026)$$, '42501', null,
  'nor its summary');

-- The 300A ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select results_eq($$select days_away_cases, other_cases, days_away, injuries, other_illnesses from app.osha_summary((select id from world where key = 'est'), 2026)$$,
  $$values (1, 1, 4, 1, 1)$$, 'a Manager who reads incidents reads the totals');
select pg_temp.as_user('alice');
insert into app.osha_annual_summaries (establishment_id, log_year, annual_average_employees, total_hours_worked, certified_by, certifier_title, certified_on)
values (pg_temp.id('est'), 2026, 32, 66400, pg_temp.id('alice'), 'Owner', '2027-01-20');
select is((select org_id from app.osha_annual_summaries), pg_temp.id('org_a'), 'a summary takes its org from the establishment');
select results_eq($$select total_hours_worked, annual_average_employees from app.osha_employment_estimate((select id from world where key = 'org_a'), 2026)$$,
  $$values (0::bigint, 0)$$, 'the worksheet estimate reads time and payroll (none here)');
select pg_temp.as_user('dave');
select throws_ok($$select * from app.osha_employment_estimate((select id from world where key = 'org_a'), 2026)$$, '42501', null,
  'the estimate needs safety.incident.close');

-- Audit --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok((select count(*) from app.audit_events where subject_table = 'app.osha_cases') >= 2, 'every case change is in the audit trail');

select * from finish();
rollback;
