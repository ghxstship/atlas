-- pgTAP: migration 2751 (R12), agency staff time. A Mobile punch with the shift id by the person on the roster entry
-- creates a time entry naming the entry, and anyone else is refused; the kiosk service punches a roster shift;
-- overlap holds across worker kinds; the person submits their timesheet and someone else approves it; the external
-- time views show the caller only their own rows; new time needs a working entry. Since the split of app.record_punch,
-- a signed-in Supervisor punch is still refused (punch_source_mobile).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

select ok((select count(*) = 3 from pg_constraint where conrelid in ('app.time_entries'::regclass, 'app.timesheets'::regclass, 'app.clock_punches'::regclass)
           and conname like '%_one_worker' and pg_get_constraintdef(oid) like '%num_nonnulls(membership_id, engagement_id, roster_entry_id) = 1%'), 'time, timesheets and punches each name exactly one of three workers');

-- Placed and accepted ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('olga');
select app.assign_roster_shift(pg_temp.id('slot_1'), pg_temp.id('e_stella'));
select app.assign_roster_shift(pg_temp.id('slot_2'), pg_temp.id('e_theo'));
select pg_temp.as_user('stella');
select lives_ok($$select app.accept_engaged_shift(pg_temp.id('slot_1'))$$, 'Stella accepts the shift she was placed on');
select pg_temp.as_user('theo');
select throws_ok($$select app.accept_engaged_shift(pg_temp.id('slot_1'))$$, '42501', null, 'Theo cannot accept Stella''s shift');
select app.accept_engaged_shift(pg_temp.id('slot_2'));

-- Mobile ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into world values ('p_stella_in', gen_random_uuid()), ('p_stella_out', gen_random_uuid()), ('p_theo_in', gen_random_uuid());
select pg_temp.as_user('theo');
select throws_ok($$select app.record_punch(pg_temp.id('p_stella_in'), pg_temp.id('prj_a'), 'In', now(), null, pg_temp.id('slot_1'))$$,
  '42501', null, 'another person on the roster cannot punch on Stella''s shift');
select pg_temp.as_user('dave');
select throws_ok($$select app.record_punch(pg_temp.id('p_stella_in'), pg_temp.id('prj_a'), 'In', now(), null, pg_temp.id('slot_1'))$$,
  '42501', null, 'nor can a member of the org');
select pg_temp.as_user('stella');
select is((app.record_punch(pg_temp.id('p_stella_in'), pg_temp.id('prj_a'), 'In', now() - interval '2 hours', null, pg_temp.id('slot_1'))).roster_entry_id,
  pg_temp.id('e_stella'), 'Stella punches in on her shift with only its id');
select pg_temp.as_platform();
select is((select roster_entry_id::text || ':' || coalesce(membership_id::text, '-') || ':' || coalesce(engagement_id::text, '-') || ':' || source
           from app.time_entries where shift_id = pg_temp.id('slot_1')),
  pg_temp.id('e_stella')::text || ':-:-:Mobile', 'the open time entry names her roster entry and nothing else');
select pg_temp.as_user('stella');
select is((select roster_entry_id from api_external.clock_punches where id = pg_temp.id('p_stella_in')), pg_temp.id('e_stella'),
  'Compass reads her punch back to derive the clock');
select is((app.record_punch(pg_temp.id('p_stella_in'), pg_temp.id('prj_a'), 'In', now() - interval '2 hours', null, pg_temp.id('slot_1'))).id,
  pg_temp.id('p_stella_in'), 'a replay returns the same punch');
select is(pg_temp.refusal($$select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'In', now(), null, pg_temp.id('slot_1'), p_source => 'Supervisor')$$),
  'punch_source_mobile', 'a signed-in caller cannot record a Supervisor punch through record_punch');

-- Kiosk ----------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into world select 'kiosk', k.kiosk_device_id from app.register_kiosk_device(pg_temp.id('org_a'), 'Pavilion Gate Kiosk', pg_temp.id('prj_a')) k;
select pg_temp.as_platform();
select is(pg_temp.refusal($$select app.record_punch(pg_temp.id('p_theo_in'), pg_temp.id('prj_a'), 'In', now(), null, null, null, null, null, null, 'Kiosk', pg_temp.id('kiosk'))$$),
  'punch_kiosk_worker', 'a kiosk punch names a worker or a roster shift');
select is((app.record_punch(pg_temp.id('p_theo_in'), pg_temp.id('prj_a'), 'In', now() - interval '1 hour', null, pg_temp.id('slot_2'),
  null, null, null, null, 'Kiosk', pg_temp.id('kiosk'))).roster_entry_id, pg_temp.id('e_theo'), 'the kiosk service punches Theo in on his roster shift');

-- Overlap across worker kinds -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with e as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('stella'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01') returning id)
  insert into world select 'eng_stella_crew', id from e;
select pg_temp.move_engagement('eng_stella_crew', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
select is(pg_temp.refusal($$insert into app.time_entries (project_id, engagement_id, clock_in) values (pg_temp.id('prj_a'), pg_temp.id('eng_stella_crew'), now() - interval '1 hour')$$),
  'time_entry_overlap', 'Stella''s own engagement cannot overlap the time she works for the agency (invariant 20)');
select is(pg_temp.refusal($$update app.time_entries set roster_entry_id = pg_temp.id('e_theo') where shift_id = pg_temp.id('slot_1')$$),
  'time_entry_immutable', 'the roster entry of time never changes');

-- Timesheets -----------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('stella');
select app.record_punch(pg_temp.id('p_stella_out'), pg_temp.id('prj_a'), 'Out', now() - interval '1 minute', null, pg_temp.id('slot_1'));
select pg_temp.as_user('carol');
with t as (insert into app.timesheets (project_id, roster_entry_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('e_stella'), current_date - 1, current_date + 5) returning id)
  insert into world select 'ts_stella', id from t;
select throws_ok($$insert into app.timesheets (project_id, roster_entry_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('e_stella'), current_date - 1, current_date + 5)$$, '23505', null, 'one timesheet per entry and period');
select pg_temp.as_user('theo');
select throws_ok($$select app.submit_timesheet(pg_temp.id('ts_stella'))$$, '42501', null, 'Theo cannot submit Stella''s timesheet');
select pg_temp.as_user('stella');
select is((select worked_minutes from api_external.timesheets where id = pg_temp.id('ts_stella')), 119, 'Stella reads her minutes');
select lives_ok($$select app.submit_timesheet(pg_temp.id('ts_stella'))$$, 'and submits her own timesheet');
select throws_ok($$select app.decide_timesheet(pg_temp.id('ts_stella'), 'Approved', 'Mine.')$$, '42501', null, 'the person never approves');
select pg_temp.as_platform();
select is(private.worker_person_id(null, null, pg_temp.id('e_stella')), pg_temp.id('stella'),
  'the approver separation resolves the roster person (sod_timesheet_submitter)');
select pg_temp.as_user('carol');
select lives_ok($$select app.decide_timesheet(pg_temp.id('ts_stella'), 'Approved', 'Hours match the call sheet.')$$, 'the production approves it');
select is((select approved_minutes from app.timesheet_approvals where timesheet_id = pg_temp.id('ts_stella')), 119, 'with the roster minutes');

-- External views ----------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('stella');
select is((select array_agg(distinct roster_entry_id) from api_external.time_entries), array[pg_temp.id('e_stella')], 'Stella reads only her time');
select is((select count(*)::int from api_external.timesheets), 1, 'and her timesheet');
select pg_temp.as_user('theo');
select is((select array_agg(distinct roster_entry_id) from api_external.time_entries), array[pg_temp.id('e_theo')], 'Theo reads only his');
select is((select count(*)::int from api_external.timesheets), 0, 'and none of Stella''s timesheets');
select pg_temp.as_user('uma');
select is((select count(*)::int from api_external.time_entries), 0, 'an Account Member of the agency reads none');

-- A working entry -----------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('olga');
select app.withdraw_roster_entry(pg_temp.id('e_stella'), 'Left the agency.');
select pg_temp.as_user('carol');
select is(pg_temp.refusal($$insert into app.time_entries (project_id, roster_entry_id, clock_in, clock_out) values (pg_temp.id('prj_a'), pg_temp.id('e_stella'), now() + interval '3 days', now() + interval '3 days 2 hours')$$),
  'roster_entry_not_working', 'a withdrawn entry takes no new time');

select * from finish();
rollback;
