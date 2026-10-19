-- pgTAP: external crew time through engagements (late slot, requested by A17 and A28b). Exactly one worker
-- per entry, timesheet and punch; at most one per shift; same org and project as the engagement; new time
-- only on an Active or Closing engagement; overlap per person across memberships and engagements
-- (invariant 20); timesheet submission, approval separation (invariant 18) and voiding (invariant 19) for
-- external workers; the engaged person reads their own rows and nobody else's.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(30);

-- Engagement state gates time ------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$insert into app.time_entries (project_id, engagement_id, clock_in, clock_out) values ((select id from world where key = 'prj_a'), (select id from world where key = 'eng_ivy_a'), '2027-06-03 08:00+00', '2027-06-03 12:00+00')$$,
  'XR001', 'engagement_not_working: External crew record time only while their engagement is Active or Closing.', 'an Onboarding engagement records no time');
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
select lives_ok($$with x as (insert into app.time_entries (project_id, engagement_id, clock_in, clock_out) values ((select id from world where key = 'prj_a'), (select id from world where key = 'eng_ivy_a'), '2027-06-03 08:00+00', '2027-06-03 12:00+00') returning id) insert into world select 'te_ivy', id from x$$,
  'a project time writer records an external crew member''s time');
select is((select membership_id from app.time_entries where id = pg_temp.id('te_ivy')), null::uuid, 'external time carries no membership');
select throws_ok($$insert into app.time_entries (project_id, membership_id, engagement_id, clock_in) values ((select id from world where key = 'prj_a'), (select id from world where key = 'frank@org_a'), (select id from world where key = 'eng_ivy_a'), '2027-06-04 08:00+00')$$,
  '23514', null, 'a time entry names one worker, not two');
select throws_ok($$insert into app.time_entries (project_id, clock_in) values ((select id from world where key = 'prj_a'), '2027-06-04 08:00+00')$$,
  '23514', null, 'and never none');
select throws_ok($$insert into app.time_entries (project_id, engagement_id, clock_in, clock_out) values ((select id from world where key = 'prj_a'), (select id from world where key = 'eng_ivy_a'), '2027-06-03 11:00+00', '2027-06-03 13:00+00')$$,
  'XR001', 'time_entry_overlap: Time entries of one person cannot overlap.', 'an external person''s entries never overlap (invariant 20)');
select throws_ok($$insert into app.time_entries (project_id, engagement_id, clock_in, clock_out) values ((select id from world where key = 'prj_a2'), (select id from world where key = 'eng_ivy_a'), '2027-06-05 08:00+00', '2027-06-05 12:00+00')$$,
  'XR001', null, 'the engagement belongs to the entry''s project');
select throws_ok($$update app.time_entries set engagement_id = (select id from world where key = 'eng_art_a') where id = (select id from world where key = 'te_ivy')$$,
  'XR001', null, 'the worker of an entry never changes');
select pg_temp.as_user('xavier');
select throws_ok($$insert into app.time_entries (project_id, engagement_id, clock_in) values ((select id from world where key = 'prj_b'), (select id from world where key = 'eng_ivy_a'), '2027-06-06 08:00+00')$$,
  'XR001', null, 'another org cannot use the engagement (invariant 1)');
select pg_temp.as_platform();

-- Shifts --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$with x as (insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone) values ((select id from world where key = 'prj_a'), (select id from world where key = 'eng_ivy_a'), '5000.51.02', '2027-06-07 08:00+00', '2027-06-07 16:00+00', 'America/New_York') returning id) insert into world select 'sh_ivy', id from x$$,
  'a shift is assigned to an external crew member through their engagement');
select throws_ok($$insert into app.shifts (project_id, membership_id, engagement_id, starts_at, ends_at, time_zone) values ((select id from world where key = 'prj_a'), (select id from world where key = 'frank@org_a'), (select id from world where key = 'eng_ivy_a'), '2027-06-08 08:00+00', '2027-06-08 16:00+00', 'America/New_York')$$,
  '23514', null, 'a shift has at most one worker');
select lives_ok($$insert into app.shifts (project_id, starts_at, ends_at, time_zone) values ((select id from world where key = 'prj_a'), '2027-06-09 08:00+00', '2027-06-09 16:00+00', 'America/New_York')$$,
  'a shift with no worker stays an open shift');
select lives_ok($$insert into app.time_entries (project_id, engagement_id, shift_id, clock_in, clock_out) values ((select id from world where key = 'prj_a'), (select id from world where key = 'eng_ivy_a'), (select id from world where key = 'sh_ivy'), '2027-06-07 08:00+00', '2027-06-07 16:00+00')$$,
  'external time works the external crew member''s shift');
select throws_ok($$insert into app.time_entries (project_id, membership_id, shift_id, clock_in, clock_out) values ((select id from world where key = 'prj_a'), (select id from world where key = 'frank@org_a'), (select id from world where key = 'sh_ivy'), '2027-06-07 17:00+00', '2027-06-07 18:00+00')$$,
  'XR001', null, 'a member cannot work an external crew member''s shift');
select pg_temp.as_user('frank');
update app.shifts set engagement_id = null where id = pg_temp.id('sh_ivy');
select pg_temp.as_platform();
select is((select engagement_id from app.shifts where id = pg_temp.id('sh_ivy')), pg_temp.id('eng_ivy_a'), 'a person who cannot write shifts reassigns nothing');
select pg_temp.as_platform();

-- Timesheets ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$with x as (insert into app.timesheets (project_id, engagement_id, period_start, period_end) values ((select id from world where key = 'prj_a'), (select id from world where key = 'eng_ivy_a'), '2027-06-01', '2027-06-07') returning id) insert into world select 'ts_ivy', id from x$$,
  'a timesheet is opened for an external crew member');
select throws_ok($$insert into app.timesheets (project_id, engagement_id, period_start, period_end) values ((select id from world where key = 'prj_a'), (select id from world where key = 'eng_ivy_a'), '2027-06-01', '2027-06-07')$$,
  '23505', null, 'one timesheet per engagement and period');
select pg_temp.as_platform();
select is((select worked_minutes from app.timesheet_hours where timesheet_id = pg_temp.id('ts_ivy')), 720, 'the timesheet sums the external entries');
select pg_temp.as_user('ivy');
select lives_ok($$select app.submit_timesheet((select id from world where key = 'ts_ivy'), 'My week.')$$, 'the engaged person submits their own timesheet');
select pg_temp.as_user('carol');
select lives_ok($$select app.decide_timesheet((select id from world where key = 'ts_ivy'), 'Approved', 'Checked.')$$, 'a project approver approves it');
select pg_temp.as_platform();
select is((select approved_minutes from app.timesheet_approvals where timesheet_id = pg_temp.id('ts_ivy')), 720, 'the approval records the external minutes');
select pg_temp.as_user('carol');
update app.time_entries set clock_out = '2027-06-03 13:00+00' where id = pg_temp.id('te_ivy');
select pg_temp.as_platform();
select is((select timesheet_state::text from app.timesheets where id = pg_temp.id('ts_ivy')), 'Proposed', 'inv_19_timesheet_void: a change to external hours voids the approval (invariant 19)');

-- Reads ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.time_entries), 2, 'the engaged person reads their own time entries');
select is((select count(*)::int from app.shifts), 1, 'and their own shift');
select is((select count(*)::int from app.timesheets), 1, 'and their own timesheet');
select throws_ok($$insert into app.time_entries (project_id, engagement_id, clock_in) values ((select id from world where key = 'prj_a'), (select id from world where key = 'eng_ivy_a'), '2027-06-10 08:00+00')$$,
  '42501', null, 'externals record time through the punch RPC, not by direct insert');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.time_entries), 0, 'another external person reads none of it');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.time_entries where engagement_id is not null), 0, 'a Viewer outside the project reads none of it');

-- A finished engagement records no more time -----------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.time_entries (project_id, engagement_id, clock_in, clock_out) values ((select id from world where key = 'prj_a'), (select id from world where key = 'eng_ivy_a'), '2027-06-20 08:00+00', '2027-06-20 12:00+00')$$,
  'XR001', 'engagement_not_working: External crew record time only while their engagement is Active or Closing.', 'a Complete engagement records no new time');
select pg_temp.as_platform();
select is((select count(*)::int from app.clock_punches where engagement_id is not null), 0, 'no external punches yet; the punch RPC suite covers them');

select * from finish();
rollback;
