-- pgTAP: migration 1593, the OSHA forms and the WH-347 behind the compliance.us_forms flag (RRR-125; ADR 0033 decision
-- 54). The flag is off by default; off, the database refuses a new establishment, case, annual summary, WH-347 project
-- header or registered apprentice, and every issue of a certified payroll; an override turns them on for one org and no
-- other; the kill switch refuses them again, a week issued before included, while a soft delete still passes. The 1385
-- and 1386 suites turn the flag on for org_a and cover the forms themselves.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(20);

create function pg_temp.as_user_aal2(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- The flag ------------------------------------------------------------------------------------------------------------------
select results_eq($$select default_enabled, required_plan_feature::text, kill_switch from app.feature_flags where flag_key = 'compliance.us_forms'$$,
  $$values (false, null::text, false)$$, 'compliance.us_forms is a flag, off by default, with no plan gate and the kill switch released');
select pg_temp.as_user('alice');
select is((select enabled from app.org_feature_flags(pg_temp.id('org_a')) where flag_key = 'compliance.us_forms'), false,
  'an org reads the flag off, so Atlas hides the forms');

-- Off ---------------------------------------------------------------------------------------------------------------------------
select throws_ok($$insert into app.osha_establishments (org_id, name) values ((select id from world where key = 'org_a'), 'Northwind Shop')$$,
  'XR001', 'us_compliance_forms_off: The OSHA forms and the WH-347 certified payroll are turned off for this organization.',
  'off, an Owner cannot add an OSHA establishment');
select throws_ok($$insert into app.certified_payroll_projects (project_id, contract_number, wage_determinations, business_name, business_address, project_location)
  values ((select id from world where key = 'prj_a'), 'GS-07P-27-0001', 'FL20270001 Mod 2', 'Northwind Live LLC', '100 Harbor Way, Miami, FL 33132', 'Miami-Dade County, FL')$$,
  'XR001', null, 'nor a WH-347 project header');
select throws_ok($$insert into app.registered_apprentices (membership_id, program_name, registered_with, labor_classification, valid_from)
  values ((select id from world where key = 'frank@org_a'), 'IATSE Local 500 Apprenticeship', 'OA', 'Stagehand', '2027-01-01')$$,
  'XR001', null, 'nor a registered apprentice');

-- On for one org -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.feature_flag_overrides (org_id, flag_key, enabled, reason, expires_at)
values (pg_temp.id('org_a'), 'compliance.us_forms', true, 'Counsel answered ADR 0041''s open questions for this org.', now() + interval '30 days');
select pg_temp.as_user('alice');
select is((select enabled from app.org_feature_flags(pg_temp.id('org_a')) where flag_key = 'compliance.us_forms'), true,
  'an override turns the flag on for the org');
select lives_ok($$insert into app.osha_establishments (org_id, name) values ((select id from world where key = 'org_a'), 'Northwind Shop')$$,
  'on, an establishment is added');
insert into world select 'est', id from app.osha_establishments where name = 'Northwind Shop';
select lives_ok($$insert into app.osha_cases (establishment_id, employee_name, job_title, injury_date, event_location, description, outcome, case_type)
  values ((select id from world where key = 'est'), 'Temporary stagehand', 'Stagehand', '2027-05-02', 'Stage left', 'Cut on the left hand', 'Other recordable case', 'Injury')$$,
  'a case is recorded');
select lives_ok($$insert into app.osha_annual_summaries (establishment_id, log_year, annual_average_employees, total_hours_worked)
  values ((select id from world where key = 'est'), 2027, 32, 66400)$$,
  'and an annual summary saved');
select lives_ok($$insert into app.certified_payroll_projects (project_id, contract_number, wage_determinations, business_name, business_address, project_location)
  values ((select id from world where key = 'prj_a'), 'GS-07P-27-0001', 'FL20270001 Mod 2', 'Northwind Live LLC', '100 Harbor Way, Miami, FL 33132', 'Miami-Dade County, FL')$$,
  'a WH-347 project header is saved');
select lives_ok($$insert into app.registered_apprentices (membership_id, program_name, registered_with, labor_classification, valid_from)
  values ((select id from world where key = 'frank@org_a'), 'IATSE Local 500 Apprenticeship', 'OA', 'Stagehand', '2027-01-01')$$,
  'and a registered apprentice');
select pg_temp.as_user_aal2('alice');
select lives_ok($$select * from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-13')$$,
  'a certified payroll is issued');
select is((select count(*)::int from app.certified_payroll_submissions where project_id = pg_temp.id('prj_a')), 1,
  'and its week is numbered');
select pg_temp.as_user('xavier');
select throws_ok($$insert into app.osha_establishments (org_id, name) values ((select id from world where key = 'org_b'), 'Harbor Lights Dock')$$,
  'XR001', 'us_compliance_forms_off: The OSHA forms and the WH-347 certified payroll are turned off for this organization.',
  'the override is for one org: another org stays off');

-- Kill switch ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
update private.feature_flags set kill_switch = true where flag_key = 'compliance.us_forms';
select pg_temp.as_user_aal2('alice');
select throws_ok($$select * from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-13')$$,
  'XR001', 'us_compliance_forms_off: The OSHA forms and the WH-347 certified payroll are turned off for this organization.',
  'the kill switch refuses a week issued before when it is issued again');
select throws_ok($$select * from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-20')$$,
  'XR001', null, 'and a new week');
select throws_ok($$insert into app.osha_cases (establishment_id, employee_name, job_title, injury_date, event_location, description, outcome, case_type)
  values ((select id from world where key = 'est'), 'Temporary rigger', 'Rigger', '2027-05-09', 'Dock', 'Bruised shin', 'Other recordable case', 'Injury')$$,
  'XR001', null, 'and a new case on an establishment the org already holds');
select pg_temp.as_user('alice');
select lives_ok($$update app.osha_establishments set deleted_at = now() where id = (select id from world where key = 'est')$$,
  'an org still removes what it holds');

-- The guard -------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select set_eq($$select t.tgrelid::regclass::text from pg_trigger t where t.tgname = 't39_guard_us_compliance_forms' and not t.tgisinternal$$,
  $$values ('app.certified_payroll_projects'), ('app.certified_payroll_submissions'), ('app.osha_annual_summaries'), ('app.osha_cases'),
    ('app.osha_establishments'), ('app.registered_apprentices')$$,
  'the guard sits on every table the forms write');
select ok((select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'private.guard_us_compliance_forms()'::regprocedure)
  and not has_function_privilege('authenticated', 'private.guard_us_compliance_forms()', 'execute')
  and not has_function_privilege('anon', 'private.guard_us_compliance_forms()', 'execute'),
  'private.guard_us_compliance_forms is security definer with an empty search_path, and no signed-in or anonymous caller runs it');

select * from finish();
rollback;
