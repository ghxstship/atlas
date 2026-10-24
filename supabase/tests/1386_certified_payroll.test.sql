-- pgTAP: migration 1386, finding A65-014 (RRR-127). The WH-347 certified payroll: a Restricted export (capabilities, step-up,
-- audit), the project header it needs, daily straight and overtime hours with overtime counted over the week, rates and
-- gross pay, a worker number that is never a social security number, registered apprentices, and payroll numbering.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(15);

-- The forms sit behind the compliance.us_forms flag, off by default (1593, ADR 0033 decision 54); org_a has it on here.
select pg_temp.as_platform();
insert into app.feature_flag_overrides (org_id, flag_key, enabled, reason)
values (pg_temp.id('org_a'), 'compliance.us_forms', true, 'Test: the forms are on for org_a.');

create function pg_temp.as_user_aal2(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- Work: Frank, Monday to Friday 10 hours on the Northwind project (Miami-Dade: the federal weekly rule only).
select pg_temp.as_user('bob');
insert into app.pay_rates (membership_id, role_code, rate_minor, currency_code, effective_from)
values (pg_temp.id('frank@org_a'), '0000.50.01', 3200, 'USD', '2027-01-01');
select pg_temp.as_user('frank');
insert into app.time_entries (project_id, membership_id, clock_in, clock_out)
select pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), (d::date + time '12:00') at time zone 'UTC', (d::date + time '22:00') at time zone 'UTC'
from generate_series(date '2027-06-07', date '2027-06-11', interval '1 day') d;
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-07', '2027-06-13') returning id) insert into world select 'ts', id from x;
select app.submit_timesheet(pg_temp.id('ts'));
select pg_temp.as_user('carol');
select app.decide_timesheet(pg_temp.id('ts'), 'Approved', 'Matches the call sheet.');

-- Who may export -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user_aal2('dave');
select throws_ok($$select * from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-13')$$,
  '42501', null, 'a Member without crew.payroll.export cannot export');
select pg_temp.as_user_aal2('carol');
select throws_ok($$select * from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-13')$$,
  'XR001', null, 'a Manager without the restricted export capability cannot either');
select pg_temp.as_user('alice');
select throws_ok($$select * from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-13')$$,
  'XR001', 'step_up_required: Exporting Restricted columns needs step-up authentication.', 'pay rates need step-up authentication');
select pg_temp.as_user_aal2('alice');
select throws_ok($$select * from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-13')$$,
  'XR001', null, 'the project needs its WH-347 header first');
insert into app.certified_payroll_projects (project_id, contract_number, wage_determinations, business_name, business_address, project_location)
values (pg_temp.id('prj_a'), 'GS-07P-27-0001', 'FL20270001 Mod 2', 'Northwind Live LLC', '100 Harbor Way, Miami, FL 33132', 'Miami-Dade County, FL');
select is((select org_id from app.certified_payroll_projects), pg_temp.id('org_a'), 'the header takes its org from the project');

-- The rows -------------------------------------------------------------------------------------------------------------------
select results_eq($$select payroll_number, entry_number, last_name, first_name, apprentice, straight_minutes, overtime_minutes, total_minutes
  from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-13')$$,
  $$values (1, 1, 'Adeyemi'::text, 'Frank'::text, 'J'::text, array[600, 600, 600, 600, 0, 0, 0], array[0, 0, 0, 0, 600, 0, 0], 3000)$$,
  'daily straight and overtime hours, overtime after 40 hours in the week');
select results_eq($$select currency_code, straight_rate_minor, overtime_rate_minor, gross_project_minor, gross_all_work_minor
  from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-13')$$,
  $$values ('USD'::text, 3200::bigint, 4800::bigint, 176000::bigint, 176000::bigint)$$, 'rates and gross pay on the project and for all work');
select ok((select identifying_number ~ '^[0-9A-F]{8}$' from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-13')),
  'the worker identifying number is the worker''s own XOS number, never a social security number');
select is((select labor_classification from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-13')),
  (select job_title::text from xpms.role where role_code = '0000.50.01'), 'the labor classification is the canon role worked');

-- Numbering ---------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from app.certified_payroll_submissions where project_id = pg_temp.id('prj_a')), 1,
  'issuing the same week again keeps its number');
select is((select payroll_number from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-20', true) limit 1), null,
  'a week with no work returns no rows');
select results_eq($$select week_ending, payroll_number, final_submission from app.certified_payroll_submissions
  where project_id = (select id from world where key = 'prj_a') order by payroll_number$$,
  $$values ('2027-06-13'::date, 1, false), ('2027-06-20'::date, 2, true)$$, 'the next week is number 2 and carries the final mark');

-- Apprentices ---------------------------------------------------------------------------------------------------------------------
insert into app.registered_apprentices (membership_id, program_name, registered_with, labor_classification, progression_level, valid_from)
values (pg_temp.id('frank@org_a'), 'IATSE Local 500 Apprenticeship', 'OA', 'Stagehand', '2', '2027-01-01');
select is((select apprentice from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-13')), 'RA 2',
  'a registered apprentice is RA with the progression level');

-- Audit and tenancy -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok((select count(*) from app.audit_events where action = 'crew.certified_payroll_exported') >= 1, 'every export is audited');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.certified_payroll_projects), 0, 'another org reads no header');

select * from finish();
rollback;
