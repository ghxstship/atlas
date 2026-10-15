-- pgTAP: A13 Crew additions (migrations 0460 and 0461). The shift lifecycle (Draft, Published,
-- Accepted, Canceled) with publish, accept and claim, every move allowed and refused; reassignment
-- returning an accepted shift to Published; swap project maintenance; domain events; payroll
-- calculation from approved timesheets with weekly overtime and masked rates; the payroll export with
-- its plan gate, restricted export capability and step-up authentication (journeys 10, 12, 31, 66).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(54);

-- Claims with step-up (aal2), keeping the authenticated role.
create function pg_temp.as_user_aal2(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- Shift lifecycle -------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '0000.50.01', '2027-06-01 12:00+00', '2027-06-01 20:00+00', 'America/New_York') returning id)
  insert into world select 'sh1', id from x;
with x as (insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), '0000.50.01', '2027-06-02 12:00+00', '2027-06-02 20:00+00', 'America/New_York') returning id)
  insert into world select 'open1', id from x;
with x as (insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), '0000.50.01', '2027-06-01 14:00+00', '2027-06-01 18:00+00', 'America/New_York') returning id)
  insert into world select 'open_overlap', id from x;
select is((select shift_state::text from app.shifts where id = pg_temp.id('sh1')), 'Draft', 'a new shift starts in Draft');
select is((select count(*)::int from app.shift_state_transitions where shift_id = pg_temp.id('sh1')), 1, 'creation is logged');
select throws_ok($$insert into app.shifts (project_id, starts_at, ends_at, time_zone, shift_state) values ((select id from world where key = 'prj_a'), now(), now() + interval '1 hour', 'UTC', 'Published')$$,
  'XR001', null, 'a shift cannot be created already published');
select throws_ok($$update app.shifts set shift_state = 'Published' where id = (select id from world where key = 'sh1')$$,
  'XR001', null, 'the state changes only through the RPCs');
select throws_ok($$select app.transition_shift((select id from world where key = 'sh1'), 'Draft', 'Accepted', 'Skip.')$$,
  'XR001', null, 'a writer cannot accept for the crew member');
select throws_ok($$select app.accept_shift((select id from world where key = 'sh1'))$$,
  '42501', null, 'only the person assigned accepts');
select is(app.publish_shifts(array[pg_temp.id('sh1'), pg_temp.id('open1'), pg_temp.id('open_overlap')]), 3, 'a Manager publishes drafted shifts in one call');
select throws_ok($$select app.publish_shifts(array[(select id from world where key = 'sh1')])$$,
  'XR001', 'shift_state_conflict: The shift is not in the expected state Draft.', 'a published shift is not published again');
select lives_ok($$select app.transition_shift((select id from world where key = 'open_overlap'), 'Published', 'Draft', 'Back to planning.')$$, 'Published returns to Draft');
select lives_ok($$select app.transition_shift((select id from world where key = 'open_overlap'), 'Draft', 'Published', 'Republished.')$$, 'and is published again');
select pg_temp.as_user('frank');
select throws_ok($$select app.transition_shift((select id from world where key = 'sh1'), 'Published', 'Canceled', 'Mine.')$$,
  '42501', null, 'a Field member cannot cancel a shift');
select throws_ok($$update app.shifts set ends_at = '2027-06-01 23:00+00' where id = (select id from world where key = 'sh1')$$,
  '42501', null, 'a Field member cannot change the times of their own shift');
select lives_ok($$select app.accept_shift((select id from world where key = 'sh1'), 'See you there.')$$, 'the assigned crew member accepts (journey 10)');
select is((select shift_state::text from app.shifts where id = pg_temp.id('sh1')), 'Accepted', 'the shift is Accepted');
select throws_ok($$select app.accept_shift((select id from world where key = 'sh1'))$$,
  'XR001', null, 'an accepted shift is not accepted twice');

-- Claiming open shifts (journey 66) ------------------------------------------------------------------------
select lives_ok($$select app.claim_open_shift((select id from world where key = 'open1'))$$, 'a Field member claims a published open shift');
select is((select membership_id from app.shifts where id = pg_temp.id('open1')), pg_temp.id('frank@org_a'), 'the claimed shift is theirs');
select is((select shift_state::text from app.shifts where id = pg_temp.id('open1')), 'Accepted', 'and Accepted');
select throws_ok($$select app.claim_open_shift((select id from world where key = 'open_overlap'))$$,
  'XR001', 'shift_double_booked: You already hold a shift that overlaps this one.', 'a claim that double books is refused');
select pg_temp.as_user('mia');
select throws_ok($$select app.claim_open_shift((select id from world where key = 'open1'))$$,
  'XR001', 'shift_already_claimed: Someone already holds this shift.', 'a claimed shift cannot be claimed again');
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), '0000.50.01', '2027-06-05 12:00+00', '2027-06-05 20:00+00', 'America/New_York') returning id)
  insert into world select 'open_draft', id from x;
select pg_temp.as_user('frank');
select is((select count(*)::int from app.shifts where id = pg_temp.id('open_draft')), 0, 'a draft open shift is not visible to crew');
select throws_ok($$select app.claim_open_shift((select id from world where key = 'open_draft'))$$,
  'XR001', 'shift_not_published: Only a published open shift can be claimed.', 'a draft open shift cannot be claimed');
select pg_temp.as_user('xavier');
select throws_ok($$select app.claim_open_shift((select id from world where key = 'open_overlap'))$$,
  '42501', null, 'another org cannot claim the shift');

-- Reassignment and swaps -------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
update app.shifts set membership_id = pg_temp.id('mia@org_a') where id = pg_temp.id('open1');
select is((select shift_state::text from app.shifts where id = pg_temp.id('open1')), 'Published', 'a writer reassigning an accepted shift returns it to Published');
select pg_temp.as_user('frank');
with x as (insert into app.shift_swaps (shift_id, requested_by_membership_id, proposed_membership_id)
  values (pg_temp.id('sh1'), pg_temp.id('frank@org_a'), pg_temp.id('mia@org_a')) returning id) insert into world select 'swap', id from x;
select is((select project_id from app.shift_swaps where id = pg_temp.id('swap')), pg_temp.id('prj_a'), 'a swap carries its shift''s project');
select pg_temp.as_user('carol');
select lives_ok($$select app.decide_shift_swap((select id from world where key = 'swap'), 'Approved', 'Covered.')$$, 'the swap is approved');
select is((select shift_state::text from app.shifts where id = pg_temp.id('sh1')), 'Accepted', 'an approved swap keeps the acceptance');
select pg_temp.as_platform();
select lives_ok($$update app.shift_swaps set project_id = (select id from world where key = 'prj_a2') where id = (select id from world where key = 'swap')$$,
  'a direct write to the swap project is overwritten');
select is((select project_id from app.shift_swaps where id = pg_temp.id('swap')), pg_temp.id('prj_a'), 'and stays the shift''s project');

-- Tenancy -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.shift_state_transitions), 0, 'another org reads no shift transitions');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.shift_state_transitions), 0, 'a Viewer outside the project reads no shift transitions');
select pg_temp.as_anon();
select throws_ok('select 1 from app.shift_state_transitions', '42501', null, 'anon cannot read shift transitions');
select throws_ok($$select app.claim_open_shift('00000000-0000-0000-0000-000000000000')$$, '42501', null, 'anon cannot claim');
select pg_temp.as_platform();
select ok((select count(*) from app.domain_events where event_type = 'shift.created' and subject_id = pg_temp.id('sh1')) = 1, 'shift creation is a domain event');
select ok((select count(*) from app.domain_events where event_type = 'shift.state_changed' and subject_id = pg_temp.id('sh1')) >= 2, 'every shift move is a domain event');
select ok((select count(*) from app.domain_events where event_type = 'shift_swap.requested' and org_id = pg_temp.id('org_a')) = 1, 'a swap request is a domain event');

-- Payroll calculation ------------------------------------------------------------------------------------------
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
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-07', '2027-06-20') returning id) insert into world select 'pp', id from x;
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id) insert into world select 'run', id from x;
select throws_ok($$select app.calculate_payroll_run((select id from world where key = 'run'))$$,
  'XR001', null, 'calculation needs a regular earning code');
select pg_temp.as_user('bob');
insert into app.earning_codes (org_id, code, name) values (pg_temp.id('org_a'), 'REG', 'Regular');
select pg_temp.as_user('carol');
select throws_ok($$select app.calculate_payroll_run((select id from world where key = 'run'))$$,
  'XR001', 'payroll_overtime_code_missing: Overtime was worked; add an overtime earning code in Payroll and Time Off settings before calculating.', 'overtime needs an overtime earning code');
select pg_temp.as_user('bob');
insert into app.earning_codes (org_id, code, name, is_overtime) values (pg_temp.id('org_a'), 'OT', 'Overtime', true);
select pg_temp.as_user('frank');
select throws_ok($$select app.calculate_payroll_run((select id from world where key = 'run'))$$,
  '42501', null, 'a Field member cannot calculate payroll');
select pg_temp.as_user('carol');
select is(app.calculate_payroll_run(pg_temp.id('run')), 2, 'a Manager without the payroll restricted capability calculates two lines');
select is((select payroll_run_state::text from app.payroll_runs where id = pg_temp.id('run')), 'Calculated', 'the run is Calculated');
select is((select hours from app.payroll_lines l join app.earning_codes e on e.id = l.earning_code_id where l.payroll_run_id = pg_temp.id('run') and e.code = 'REG' and l.deleted_at is null), 40.00, 'forty regular hours under the federal weekly rule');
select is((select hours from app.payroll_lines l join app.earning_codes e on e.id = l.earning_code_id where l.payroll_run_id = pg_temp.id('run') and e.code = 'OT' and l.deleted_at is null), 10.00, 'ten overtime hours');
select is((select count(*)::int from app.payroll_line_amounts where payroll_run_id = pg_temp.id('run') and is_masked), 2, 'the Manager still sees the rates masked');
select pg_temp.as_user('alice');
select is((select rate_minor from app.payroll_line_amounts a join app.earning_codes e on e.id = a.earning_code_id where a.payroll_run_id = pg_temp.id('run') and e.code = 'OT'), 4800::bigint, 'overtime pays the rate times the canon multiplier of 1.5');
select pg_temp.as_user('carol');
select throws_ok($$select app.calculate_payroll_run((select id from world where key = 'run'))$$,
  'XR001', 'payroll_run_not_draft: Only a Draft payroll run is calculated; return it to Draft first.', 'only a Draft run is calculated');

-- Payroll export ---------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.accounting_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-01', '2027-06-30');
select pg_temp.as_user('alice');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Payroll Run', 'USD', 100000000);
select pg_temp.as_user('bob');
select is(app.approve_payroll_run(pg_temp.id('run'), 'Approved.'), true, 'the run is approved by someone other than its creator');
select pg_temp.as_user('carol');
select throws_ok($$select * from app.produce_payroll_export((select id from world where key = 'run'))$$,
  'XR001', 'export_restricted: A payroll export carries Restricted pay rates and needs the restricted export capability.', 'exporting Restricted rates needs the restricted export capability');
select pg_temp.as_user('alice');
select throws_ok($$select * from app.produce_payroll_export((select id from world where key = 'run'))$$,
  'XR001', 'step_up_required: Exporting Restricted columns needs step-up authentication.', 'a Restricted export without step-up is refused (journey 31)');
select pg_temp.as_user_aal2('alice');
create temporary table produced as select * from app.produce_payroll_export(pg_temp.id('run'), 'CSV');
grant select on produced to public;
select is((select payroll_run_state::text from app.payroll_runs where id = pg_temp.id('run')), 'Exported', 'producing the export moves the run to Exported');
select is((select checksum_sha256 from produced), encode(extensions.digest((select content from produced), 'sha256'), 'hex'), 'the recorded checksum is the file''s SHA-256');
select is((select content from app.payroll_export_file((select payroll_export_id from produced))), (select content from produced), 'the export renders the same file again');
select pg_temp.as_platform();
select ok((select count(*) from app.domain_events where event_type = 'payroll_export.produced') = 1, 'the export is a domain event');
select pg_temp.as_user('xavier');
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_b'), '2027-06-07', '2027-06-20') returning id) insert into world select 'pp_b', id from x;
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp_b'), 'USD') returning id) insert into world select 'run_b', id from x;
select pg_temp.as_platform();
select throws_ok($$insert into app.payroll_exports (payroll_run_id, provider, file_uri, checksum_sha256) values ((select id from world where key = 'run_b'), 'CSV', 'x', repeat('a', 64))$$,
  'XR001', 'plan_feature_required: Payroll export is included from the Team plan; upgrade in Billing and Plan.', 'an org below Team cannot record a payroll export');

select * from finish();
rollback;
