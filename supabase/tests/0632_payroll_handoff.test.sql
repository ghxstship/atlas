-- pgTAP: payroll handoff (Section 17) over A13's payroll export. The runner reads only an export a person produced for
-- the connection's provider, of an Exported run of the same org, re-rendered and checked against its checksum.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

-- World: an exported run produced for Gusto, plus Gusto, ADP and calendar connections
select pg_temp.as_user('bob');
with c as (insert into app.integration_connections (org_id, provider_code, display_name, external_account_id) values (pg_temp.id('org_a'), 'gusto', 'Northwind Gusto', 'company-1') returning id)
  insert into world select 'gusto', id from c;
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'adp', 'Northwind ADP') returning id)
  insert into world select 'adp', id from c;
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'google_calendar', 'Calendar') returning id)
  insert into world select 'gcal', id from c;
select app.store_integration_credential(id, 'fixture-token', 'OAuth Token') from app.integration_connections;
select app.transition_integration_connection(id, 'Pending', 'Connected', 'Authorized.') from app.integration_connections where provider_code <> 'adp';

select pg_temp.as_platform();
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-07', '2027-06-20') returning id) insert into world select 'pp', id from x;
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id) insert into world select 'run', id from x;
with x as (insert into app.earning_codes (org_id, code, name) values (pg_temp.id('org_a'), 'REG', 'Regular') returning id) insert into world select 'reg', id from x;
insert into app.payroll_lines (payroll_run_id, membership_id, earning_code_id, hours, rate_minor, role_code)
values (pg_temp.id('run'), pg_temp.id('frank@org_a'), pg_temp.id('reg'), 38.5, 3200, (select role_code from xpms.role order by role_code limit 1));
insert into app.accounting_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-01', '2027-06-30');
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id) insert into world select 'draft', id from x;

select pg_temp.as_user('bob');
select throws_ok($$select * from app.payroll_export_for_handoff((select id from world where key = 'gusto'), (select id from world where key = 'run'))$$,
  '42501', null, 'signed-in callers cannot read a handoff file');
select pg_temp.as_platform();
select throws_ok($$select * from app.payroll_export_for_handoff((select id from world where key = 'gusto'), (select id from world where key = 'run'))$$,
  'XR001', 'payroll_run_not_exported: Produce the payroll export for this provider before handing it off.', 'a run that is not Exported is not handed off');

select private.transition_lifecycle('payroll_run', 'app.payroll_runs', 'payroll_run_state', 'app.payroll_run_state_transitions', 'payroll_run_id', pg_temp.id('run'), 'Draft', 'Calculated', 'Calculated.');
select private.transition_lifecycle('payroll_run', 'app.payroll_runs', 'payroll_run_state', 'app.payroll_run_state_transitions', 'payroll_run_id', pg_temp.id('run'), 'Calculated', 'Approved', 'Approved.');
select private.transition_lifecycle('payroll_run', 'app.payroll_runs', 'payroll_run_state', 'app.payroll_run_state_transitions', 'payroll_run_id', pg_temp.id('run'), 'Approved', 'Exported', 'Exported to Gusto.');
select throws_ok($$select * from app.payroll_export_for_handoff((select id from world where key = 'gusto'), (select id from world where key = 'run'))$$,
  'XR001', 'payroll_export_missing: No export of this run was produced for gusto.', 'an Exported run without a Gusto export is not handed to Gusto');
insert into app.payroll_exports (payroll_run_id, provider, file_uri, checksum_sha256)
values (pg_temp.id('run'), 'Gusto', 'payroll-exports/x.csv', encode(extensions.digest(private.render_payroll_export(pg_temp.id('run')), 'sha256'), 'hex'));

select is((select provider from app.payroll_export_for_handoff(pg_temp.id('gusto'), pg_temp.id('run'))), 'Gusto', 'the runner reads the export produced for Gusto');
select ok((select content like 'payroll_run_id,pay_period_start,%' from app.payroll_export_for_handoff(pg_temp.id('gusto'), pg_temp.id('run'))), 'as the Universal CSV');
select is((select pay_period_start from app.payroll_export_for_handoff(pg_temp.id('gusto'), pg_temp.id('run'))), '2027-06-07'::date, 'with the pay period');
select ok((select content like '%,3200,123200,USD%' from app.payroll_export_for_handoff(pg_temp.id('gusto'), pg_temp.id('run'))), 'carrying hours, rate and amount in minor units');
select throws_ok($$select * from app.payroll_export_for_handoff((select id from world where key = 'adp'), (select id from world where key = 'run'))$$,
  'XR001', 'integration_not_connected: Only a Connected connection can sync.', 'a connection that is not Connected reads nothing');
select throws_ok($$select * from app.payroll_export_for_handoff((select id from world where key = 'gcal'), (select id from world where key = 'run'))$$,
  'XR001', 'integration_category_mismatch: Payroll exports go only to a payroll connection.', 'only payroll connections receive payroll');
select throws_ok($$select * from app.payroll_export_for_handoff((select id from world where key = 'gusto'), gen_random_uuid())$$,
  '42501', null, 'an unknown run is not found');

-- A changed file is refused (the lines are frozen once Approved; simulate drift directly)
alter table app.payroll_lines disable trigger t40_guard_payroll_line;
update app.payroll_lines set hours = 40 where payroll_run_id = pg_temp.id('run');
alter table app.payroll_lines enable trigger t40_guard_payroll_line;
select throws_ok($$select * from app.payroll_export_for_handoff((select id from world where key = 'gusto'), (select id from world where key = 'run'))$$,
  'XR001', 'payroll_export_changed: The payroll lines changed since this file was produced; produce a new export.', 'a file whose checksum no longer matches is refused');

-- Payroll Export runs take the payroll run as subject
select pg_temp.as_user('bob');
select lives_ok($$select app.enqueue_integration_sync((select id from world where key = 'gusto'), 'Payroll Export', 'Outbound', 'payroll-run-1', null, 3::smallint, 'Payroll Run', (select id from world where key = 'run'))$$,
  'an Admin queues the handoff with the payroll run as subject');

-- Plan gate: an org whose plan lost the feature hands off nothing
select pg_temp.as_platform();
alter table app.payroll_lines disable trigger t40_guard_payroll_line;
update app.payroll_lines set hours = 38.5 where payroll_run_id = pg_temp.id('run');
alter table app.payroll_lines enable trigger t40_guard_payroll_line;
update app.subscriptions set plan_code = 'core' where org_id = pg_temp.id('org_a');
select throws_ok($$select * from app.payroll_export_for_handoff((select id from world where key = 'gusto'), (select id from world where key = 'run'))$$,
  'XR001', null, 'the payroll_export plan feature is required');

select * from finish();
rollback;
