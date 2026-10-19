-- pgTAP: crew, time and payroll (Section 7.4 Crew, Rates and payroll). Same-tenant allow,
-- cross-tenant deny, anon deny, own-reach Field access, invariants 2 (crew assigned to a shift),
-- 8 (hashed kiosk secrets), 10 (closed production refuses time), 14 (posted pay period never
-- reopens), 15 (payroll run cannot jump from Draft to Accepted), 18 (no self-approval of swaps,
-- timesheets and time off), 19 (approval voided when hours change), 20 (no overlapping entries;
-- a shift cannot end before it starts), Restricted pay rates (Section 8.3) and every state machine.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(78);

-- Shifts (invariant 20) ------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$insert into app.shifts (project_id, membership_id, starts_at, ends_at, time_zone) values ((select id from world where key = 'prj_a'), (select id from world where key = 'frank@org_a'), '2027-06-01 16:00+00', '2027-06-01 08:00+00', 'America/New_York')$$,
  '23514', null, 'inv_20_time_overlap: a shift cannot end before it starts (invariant 20)');
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '0000.50.01', '2027-06-01 08:00+00', '2027-06-01 16:00+00', 'America/New_York') returning id)
  insert into world select 'shift_f', id from x;
with x as (insert into app.shifts (project_id, membership_id, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a2'), pg_temp.id('carol@org_a'), '2027-06-02 08:00+00', '2027-06-02 16:00+00', 'America/New_York') returning id)
  insert into world select 'shift_c', id from x;
select throws_ok($$insert into app.shifts (project_id, record_id, starts_at, ends_at, time_zone) values ((select id from world where key = 'prj_a'), null, now(), now() + interval '1 hour', 'Nowhere/Zone')$$,
  'XR001', null, 'a shift time zone is an IANA zone');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.shifts), 1, 'a Field member reads their own shift');
select throws_ok($$insert into app.shifts (project_id, starts_at, ends_at, time_zone) values ((select id from world where key = 'prj_a'), now(), now() + interval '1 hour', 'UTC')$$,
  '42501', null, 'a Field member cannot create shifts');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.shifts), 0, 'a Viewer outside every project reads no shifts');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.shifts where org_id = pg_temp.id('org_a')), 0, 'another org reads no shifts');
select pg_temp.as_anon();
select throws_ok('select 1 from app.time_entries', '42501', null, 'anon cannot read time entries');
select throws_ok('select 1 from app.payroll_runs', '42501', null, 'anon cannot read payroll runs');
select pg_temp.as_platform();

-- Shift swaps (invariant 18) -------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
with x as (insert into app.shift_swaps (shift_id, requested_by_membership_id, proposed_membership_id)
  values (pg_temp.id('shift_f'), pg_temp.id('frank@org_a'), pg_temp.id('mia@org_a')) returning id) insert into world select 'swap1', id from x;
select throws_ok($$select app.decide_shift_swap((select id from world where key = 'swap1'), 'Approved', 'Mine.')$$, '42501', null, 'a Field member cannot approve a swap');
select pg_temp.as_user('mia');
select is((select count(*)::int from app.shift_swaps), 1, 'the proposed person sees the swap');
select is((select count(*)::int from app.projects), 0, 'but not the project before taking the shift');
select pg_temp.as_user('carol');
select lives_ok($$select app.decide_shift_swap((select id from world where key = 'swap1'), 'Approved', 'Covered.')$$, 'a Manager approves the swap');
select is((select membership_id from app.shifts where id = pg_temp.id('shift_f')), pg_temp.id('mia@org_a'), 'the shift is reassigned');
select pg_temp.as_user('mia');
select is((select array_agg(id) from app.projects), array[pg_temp.id('prj_a')], 'inv_02_project_read_scope: crew assigned to a shift read its project header (invariant 2)');
select pg_temp.as_user('carol');
with x as (insert into app.shift_swaps (shift_id, requested_by_membership_id, proposed_membership_id)
  values (pg_temp.id('shift_c'), pg_temp.id('carol@org_a'), pg_temp.id('dave@org_a')) returning id) insert into world select 'swap2', id from x;
select throws_ok($$select app.decide_shift_swap((select id from world where key = 'swap2'), 'Approved', 'Self.')$$,
  'XR001', 'sod_swap_requester: A crew member cannot approve their own swap.', 'inv_18_eligible_approver: a crew member cannot approve their own swap');
select throws_ok($$insert into app.shift_swaps (shift_id, requested_by_membership_id, proposed_membership_id) values ((select id from world where key = 'shift_f'), (select id from world where key = 'carol@org_a'), (select id from world where key = 'dave@org_a'))$$,
  'XR001', null, 'only the person on the shift asks to swap it');
select lives_ok($$select app.cancel_shift_swap((select id from world where key = 'swap2'), 'Withdrawn.')$$, 'the requester cancels');
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'swap'), 3, 'the swap lifecycle declares three moves');
select pg_temp.as_platform();

-- Time entries (invariant 20) ------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
with x as (insert into app.time_entries (project_id, membership_id, clock_in, clock_out) values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-01 08:00+00', '2027-06-01 12:00+00') returning id)
  insert into world select 'te1', id from x;
with x as (insert into app.time_entries (project_id, membership_id, clock_in, clock_out, break_minutes) values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-01 12:30+00', '2027-06-01 16:30+00', 30) returning id)
  insert into world select 'te2', id from x;
select throws_ok($$insert into app.time_entries (project_id, membership_id, clock_in, clock_out) values ((select id from world where key = 'prj_a'), (select id from world where key = 'frank@org_a'), '2027-06-01 11:00+00', '2027-06-01 13:00+00')$$,
  'XR001', 'time_entry_overlap: Time entries of one person cannot overlap.', 'inv_20_time_overlap: time entries of one person cannot overlap (invariant 20)');
select throws_ok($$insert into app.time_entries (project_id, membership_id, clock_in) values ((select id from world where key = 'prj_a'), (select id from world where key = 'frank@org_a'), '2027-06-01 15:00+00')$$,
  'XR001', null, 'an open entry overlapping a closed one is refused');
select throws_ok($$insert into app.time_entries (project_id, membership_id, clock_in, clock_out) values ((select id from world where key = 'prj_a'), (select id from world where key = 'frank@org_a'), '2027-06-02 12:00+00', '2027-06-02 08:00+00')$$,
  '23514', null, 'an entry cannot clock out before it clocks in');
select throws_ok($$insert into app.time_entries (project_id, membership_id, clock_in, clock_out) values ((select id from world where key = 'prj_a2'), (select id from world where key = 'frank@org_a'), '2027-06-03 08:00+00', '2027-06-03 09:00+00')$$,
  'XR001', 'time_entry_project: A person records time only on projects they belong to or have a shift on.', 'a person records time only where they belong');
select throws_ok($$insert into app.time_entries (project_id, membership_id, clock_in, clock_out) values ((select id from world where key = 'prj_a'), (select id from world where key = 'dave@org_a'), '2027-06-03 08:00+00', '2027-06-03 09:00+00')$$,
  '42501', null, 'a Field member cannot record time for someone else');
select is((select count(*)::int from app.time_entry_audit where time_entry_id = pg_temp.id('te1')), 1, 'creation is audited');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.time_entries), 2, 'a Member of the project reads its time entries');
select throws_ok($$delete from app.time_entries$$, '42501', null, 'time entries are never hard deleted by signed-in callers');
select pg_temp.as_platform();
select throws_ok($$delete from app.time_entries where id = (select id from world where key = 'te1')$$, 'XR001', null, 'not even by the platform');

-- Timesheets (invariants 18 and 19) -------------------------------------------------------------------------------
select pg_temp.as_user('frank');
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end) values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-05-31', '2027-06-06') returning id)
  insert into world select 'ts1', id from x;
select is((select worked_minutes from app.timesheet_hours where timesheet_id = pg_temp.id('ts1')), 450, 'worked minutes are derived from the entries less breaks');
select lives_ok($$select app.submit_timesheet((select id from world where key = 'ts1'))$$, 'the worker submits their timesheet');
select throws_ok($$select app.decide_timesheet((select id from world where key = 'ts1'), 'Approved', 'Mine.')$$, '42501', null, 'a Field member cannot approve timesheets');
select pg_temp.as_user('carol');
select lives_ok($$select app.decide_timesheet((select id from world where key = 'ts1'), 'Approved', 'Matches the call sheet.')$$, 'a Manager approves');
select is((select approved_minutes from app.timesheet_approvals where timesheet_id = pg_temp.id('ts1')), 450, 'the approval records the minutes approved');
select pg_temp.as_user('frank');
update app.time_entries set clock_out = '2027-06-01 17:00+00' where id = pg_temp.id('te2');
select pg_temp.as_platform();
select is((select timesheet_state::text from app.timesheets where id = pg_temp.id('ts1')), 'Proposed', 'inv_19_timesheet_void: changing the hours voids the approval (invariant 19)');
select isnt((select voided_at from app.timesheet_approvals where timesheet_id = pg_temp.id('ts1')), null, 'the approval is marked voided');
select is((select count(*)::int from app.domain_events where event_type = 'timesheet.approval_voided' and subject_id = pg_temp.id('ts1')), 1, 'timesheet.approval_voided was emitted');
select is((select count(*)::int from app.time_entry_audit where time_entry_id = pg_temp.id('te2')), 2, 'the change is audited');
select pg_temp.as_user('carol');
with x as (insert into app.time_entries (project_id, membership_id, clock_in, clock_out) values (pg_temp.id('prj_a'), pg_temp.id('carol@org_a'), '2027-06-01 08:00+00', '2027-06-01 10:00+00') returning id)
  insert into world select 'te_c', id from x;
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end) values (pg_temp.id('prj_a'), pg_temp.id('carol@org_a'), '2027-05-31', '2027-06-06') returning id)
  insert into world select 'ts_c', id from x;
select app.submit_timesheet(pg_temp.id('ts_c'));
select throws_ok($$select app.decide_timesheet((select id from world where key = 'ts_c'), 'Approved', 'Self.')$$,
  'XR001', 'sod_timesheet_submitter: The submitter of a timesheet cannot approve it.', 'inv_18_eligible_approver: the submitter cannot approve their timesheet (invariant 18)');
select pg_temp.as_user('frank');
select app.submit_timesheet(pg_temp.id('ts1'), 'Resubmitted after correction.');
select pg_temp.as_user('carol');
select lives_ok($$select app.decide_timesheet((select id from world where key = 'ts1'), 'Rejected', 'Overtime not authorized.')$$, 'Submitted to Rejected');
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'timesheet'), 6, 'the timesheet lifecycle declares six moves');
select pg_temp.as_platform();

-- Corrections ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
with x as (insert into app.time_entry_corrections (time_entry_id, proposed_clock_in, proposed_clock_out, reason)
  values (pg_temp.id('te1'), '2027-06-01 07:30+00', '2027-06-01 12:00+00', 'Started early for the truck.') returning id) insert into world select 'corr', id from x;
select throws_ok($$select app.decide_time_entry_correction((select id from world where key = 'corr'), 'Approved', 'Mine.')$$, '42501', null, 'a Field member cannot approve corrections');
select pg_temp.as_user('carol');
select lives_ok($$select app.decide_time_entry_correction((select id from world where key = 'corr'), 'Approved', 'Truck log agrees.')$$, 'a Manager approves the correction');
select is((select clock_in from app.time_entries where id = pg_temp.id('te1')), '2027-06-01 07:30+00'::timestamptz, 'the entry is rewritten');
select is((select count(*)::int from app.time_entry_audit where time_entry_id = pg_temp.id('te1')), 2, 'and the rewrite is audited');
select throws_ok($$update app.time_entry_corrections set reason = 'Edited.' where id = (select id from world where key = 'corr')$$, 'XR001', null, 'a decided correction is not edited');
select pg_temp.as_platform();

-- Kiosk (invariant 8) --------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
create temporary table kiosk_key as select * from app.register_kiosk_device(pg_temp.id('org_a'), 'Dock Gate Kiosk', pg_temp.id('prj_a'));
grant select on kiosk_key to public;
select lives_ok($$select app.set_kiosk_pin((select id from world where key = 'frank@org_a'), '4821')$$, 'an Admin sets a member''s kiosk PIN');
select throws_ok($$select app.set_kiosk_pin((select id from world where key = 'frank@org_a'), '12')$$, 'XR001', null, 'a PIN is 4 to 8 digits');
select throws_ok($$select device_key_hash from app.kiosk_devices$$, '42501', null, 'the device key hash is never selectable');
select throws_ok($$select pin_hash from app.kiosk_pins$$, '42501', null, 'inv_08_token_rpcs_hashed_secrets: the PIN hash is never selectable');
select pg_temp.as_platform();
select ok((select pin_hash <> '4821' and pin_hash like '$2%' from app.kiosk_pins where membership_id = pg_temp.id('frank@org_a') and deleted_at is null), 'inv_08_token_rpcs_hashed_secrets: the PIN is stored as a bcrypt hash');
select is(private.verify_kiosk_pin((select device_key from kiosk_key), pg_temp.id('frank@org_a'), '4821'), true, 'the right PIN on a live kiosk verifies');
select is(private.verify_kiosk_pin('xkio_wrong', pg_temp.id('frank@org_a'), '4821'), false, 'an unknown device key does not');
select is((select count(*)::int from (select private.verify_kiosk_pin((select device_key from kiosk_key), pg_temp.id('frank@org_a'), '0000') from generate_series(1, 5)) s), 5, 'five wrong PINs');
select is(private.verify_kiosk_pin((select device_key from kiosk_key), pg_temp.id('frank@org_a'), '4821'), false, 'inv_08_token_rpcs_hashed_secrets: lock the PIN even for the right PIN afterwards');

-- Rates (Restricted, Section 8.3) --------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.rate_cards (org_id, name, currency_code, effective_from) values (pg_temp.id('org_a'), '2027 Crew Rates', 'USD', '2027-01-01') returning id)
  insert into world select 'rc', id from x;
select throws_ok($$insert into app.rate_card_lines (rate_card_id, role_code, worker_classification, pay_basis, arrangement, overtime_rule_id, rate_minor) values ((select id from world where key = 'rc'), '0000.50.01', 'INDEPENDENT_CONTRACTOR', 'Salary', 'Retainer', 'OTR-002', 1)$$,
  '23503', null, 'a rate card line needs a permitted pay basis and classification (decision D16)');
insert into app.rate_card_lines (rate_card_id, role_code, worker_classification, pay_basis, arrangement, canon_rate_card_id, overtime_rule_id, rate_minor)
values (pg_temp.id('rc'), '0000.50.01', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Retainer', 'LRC-001', 'OTR-002', 85000);
select throws_ok($$select rate_minor from app.rate_card_lines$$, '42501', null, 'a Restricted rate is not selectable directly');
select is((select rate_minor from app.rate_card_lines_masked), null::bigint, 'without data.restricted.read.payroll the rate is masked');
select is((select is_masked from app.rate_card_lines_masked), true, 'and marked masked');
select pg_temp.as_user('alice');
select is((select rate_minor from app.rate_card_lines_masked), 85000::bigint, 'the holder of data.restricted.read.payroll reads the rate');
select pg_temp.as_user('bob');
insert into app.pay_rates (membership_id, role_code, rate_minor, currency_code, effective_from) values (pg_temp.id('frank@org_a'), '0000.50.01', 3200, 'USD', '2027-01-01');
select pg_temp.as_user('frank');
select is((select rate_minor from app.pay_rates_masked), 3200::bigint, 'a person reads their own pay rate');
select pg_temp.as_user('carol');
select is((select is_masked from app.pay_rates_masked), true, 'a Manager without the payroll restricted capability sees it masked');
select pg_temp.as_platform();
select throws_ok($$update app.pay_rates set rate_minor = 1$$, 'XR001', null, 'the pay rate ledger is append-only');

-- Pay periods and payroll runs (invariants 14 and 15) ---------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-05-31', '2027-06-13') returning id) insert into world select 'pp', id from x;
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id) insert into world select 'run', id from x;
select pg_temp.as_user('bob');
with x as (insert into app.earning_codes (org_id, code, name) values (pg_temp.id('org_a'), 'REG', 'Regular') returning id) insert into world select 'ec', id from x;
select pg_temp.as_user('carol');
select throws_ok($$select app.transition_payroll_run((select id from world where key = 'run'), 'Draft', 'Accepted', 'Skip.')$$,
  'XR001', 'payroll_run_transition_not_allowed: A payroll run cannot move from Draft to Accepted.', 'inv_15_payroll_no_jump: a Draft run cannot jump to Accepted (invariant 15)');
select lives_ok($$select app.transition_payroll_run((select id from world where key = 'run'), 'Draft', 'Calculated', 'Calculated.')$$, 'Draft to Calculated');
select throws_ok($$select app.approve_payroll_run((select id from world where key = 'run'), 'Self.')$$,
  'XR001', 'sod_approval_requester: An approval is decided by an eligible approver, never the requester.', 'the run''s creator cannot approve it');
select pg_temp.as_user('alice');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Payroll Run', 'USD', 100000000);
select pg_temp.as_user('bob');
select is(app.approve_payroll_run(pg_temp.id('run'), 'Approved.'), true, 'an Admin within spend authority approves the run');
select throws_ok($$select app.transition_pay_period((select id from world where key = 'pp'), 'Open', 'Posted', 'Skip.')$$, 'XR001', null, 'an Open period cannot jump to Posted');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_pay_period((select id from world where key = 'pp'), 'Open', 'Closed', 'Cutoff.')$$, 'Open to Closed');
select throws_ok($$select app.transition_pay_period((select id from world where key = 'pp'), 'Closed', 'Posted', 'Post.')$$,
  'XR001', 'pay_period_runs_open: Every payroll run of the period is Accepted or Canceled before it posts.', 'a period with an unfinished run does not post');
select lives_ok($$select app.transition_payroll_run((select id from world where key = 'run'), 'Approved', 'Exported', 'Sent to provider.')$$, 'Approved to Exported');
select lives_ok($$select app.transition_payroll_run((select id from world where key = 'run'), 'Exported', 'Accepted', 'Provider accepted.')$$, 'Exported to Accepted');
select lives_ok($$select app.transition_pay_period((select id from world where key = 'pp'), 'Closed', 'Posted', 'Posted.')$$, 'Closed to Posted');
select throws_ok($$select app.transition_pay_period((select id from world where key = 'pp'), 'Posted', 'Open', 'Reopen.')$$,
  'XR001', 'pay_period_transition_not_allowed: A pay period cannot move from Posted to Open.', 'inv_14_pay_period_no_reopen: a posted pay period cannot reopen (invariant 14)');
select throws_ok($$insert into app.payroll_runs (pay_period_id, currency_code) values ((select id from world where key = 'pp'), 'USD')$$, 'XR001', null, 'a posted period takes no new runs');
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'payroll_run'), 9, 'the payroll run lifecycle declares nine moves');
select pg_temp.as_platform();

-- Time off (invariant 18) ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
with x as (insert into app.time_off_policies (org_id, name) values (pg_temp.id('org_a'), 'Paid Time Off') returning id) insert into world select 'pto', id from x;
select pg_temp.as_user('frank');
with x as (insert into app.time_off_requests (time_off_policy_id, membership_id, starts_on, ends_on, hours) values (pg_temp.id('pto'), pg_temp.id('frank@org_a'), '2027-07-01', '2027-07-02', 16) returning id)
  insert into world select 'to1', id from x;
select throws_ok($$select app.decide_time_off((select id from world where key = 'to1'), 'Approved', 'Mine.')$$, '42501', null, 'a Field member cannot approve time off');
select pg_temp.as_user('carol');
select lives_ok($$select app.decide_time_off((select id from world where key = 'to1'), 'Approved', 'Covered.')$$, 'a Manager approves time off');
with x as (insert into app.time_off_requests (time_off_policy_id, membership_id, starts_on, ends_on, hours) values (pg_temp.id('pto'), pg_temp.id('carol@org_a'), '2027-07-05', '2027-07-05', 8) returning id)
  insert into world select 'to2', id from x;
select throws_ok($$select app.decide_time_off((select id from world where key = 'to2'), 'Approved', 'Self.')$$,
  'XR001', 'sod_time_off_requester: The requester of time off cannot approve it.', 'the requester cannot approve their time off');
select pg_temp.as_platform();

-- Invariant 10 ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.transition_production(pg_temp.id('prj_a'), 'Proposed', 'Active', 'Live.');
select app.transition_production(pg_temp.id('prj_a'), 'Active', 'Complete', 'Wrapped.');
select app.transition_production(pg_temp.id('prj_a'), 'Complete', 'Closed', 'Closed.');
select pg_temp.as_user('frank');
select throws_ok($$insert into app.time_entries (project_id, membership_id, clock_in, clock_out) values ((select id from world where key = 'prj_a'), (select id from world where key = 'frank@org_a'), '2027-06-10 08:00+00', '2027-06-10 09:00+00')$$,
  'XR001', 'production_closed: A closed production refuses new invoices, purchase orders, expenses, time entries and change orders.', 'a closed production refuses a new time entry (invariant 10)');
select pg_temp.as_platform();

select * from finish();
rollback;
