-- pgTAP: A13 additions in 0462, 0463 and the late slot 0981. Published open shifts are visible to crew
-- who may read shifts at any reach and nobody else; Compass can replay accept and claim; external crew
-- timesheets stay out of payroll; per diems for external crew name exactly one worker on an Active
-- engagement of the same project, and the engaged person reads only their own; agreements reference
-- offers; People and Crew records are commentable.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(18);

-- Open shift visibility (0462) ------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), '0000.50.01', '2027-07-01 12:00+00', '2027-07-01 20:00+00', 'America/New_York') returning id)
  insert into world select 'open', id from x;
with x as (insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), '0000.50.01', '2027-07-02 12:00+00', '2027-07-02 20:00+00', 'America/New_York') returning id)
  insert into world select 'draft', id from x;
select app.publish_shifts(array[pg_temp.id('open')]);
select pg_temp.as_user('frank');
select is((select count(*)::int from app.shifts where id = pg_temp.id('open')), 1, 'a Field member sees a published open shift');
select is((select count(*)::int from app.shifts where id = pg_temp.id('draft')), 0, 'but not a draft one');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.shifts where id = pg_temp.id('open')), 0, 'a Viewer without shift read sees no open shift');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.shifts where id = pg_temp.id('open')), 0, 'another org sees no open shift');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.shifts where id = pg_temp.id('open')), 0, 'external crew see no internal open shift');
select pg_temp.as_user('frank');
select lives_ok($$select app.claim_open_shift((select id from world where key = 'open'))$$, 'and the Field member claims it');
select pg_temp.as_platform();

-- Compass replay allowlist (0463) --------------------------------------------------------------------------------
select ok(exists (select 1 from private.sync_rpcs where rpc = 'app.accept_shift'), 'Compass may replay accept_shift');
select ok(exists (select 1 from private.sync_rpcs where rpc = 'app.claim_open_shift'), 'Compass may replay claim_open_shift');

-- External timesheets stay out of payroll (0463) ------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
insert into app.time_entries (project_id, engagement_id, clock_in, clock_out)
values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-07-05 12:00+00', '2027-07-05 20:00+00');
with x as (insert into app.timesheets (project_id, engagement_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-07-05', '2027-07-11') returning id) insert into world select 'ts_ivy', id from x;
select app.submit_timesheet(pg_temp.id('ts_ivy'));
select pg_temp.as_user('bob');
select app.decide_timesheet(pg_temp.id('ts_ivy'), 'Approved', 'Matches the call sheet.');
insert into app.earning_codes (org_id, code, name) values (pg_temp.id('org_a'), 'REG', 'Regular');
select pg_temp.as_user('carol');
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-07-05', '2027-07-18') returning id) insert into world select 'pp', id from x;
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id) insert into world select 'run', id from x;
select is(app.calculate_payroll_run(pg_temp.id('run')), 0, 'an approved external timesheet adds no payroll line and does not block the run');

-- Per diems for external crew (0981) ----------------------------------------------------------------------------
select lives_ok($$with x as (insert into app.per_diems (project_id, engagement_id, day, amount_minor, currency_code) values ((select id from world where key = 'prj_a'), (select id from world where key = 'eng_ivy_a'), '2027-07-05', 6500, 'USD') returning id) insert into world select 'pd_ivy', id from x$$,
  'a time writer records a per diem for external crew');
select throws_ok($$insert into app.per_diems (project_id, engagement_id, day, amount_minor, currency_code) values ((select id from world where key = 'prj_a'), (select id from world where key = 'eng_ivy_a'), '2027-07-05', 6500, 'USD')$$,
  '23505', null, 'one per diem per engagement and day');
select throws_ok($$insert into app.per_diems (project_id, membership_id, engagement_id, day, amount_minor, currency_code) values ((select id from world where key = 'prj_a'), (select id from world where key = 'frank@org_a'), (select id from world where key = 'eng_ivy_a'), '2027-07-06', 6500, 'USD')$$,
  '23514', null, 'a per diem names one worker, not two');
select throws_ok($$insert into app.per_diems (project_id, engagement_id, day, amount_minor, currency_code) values ((select id from world where key = 'prj_a2'), (select id from world where key = 'eng_ivy_a'), '2027-07-06', 6500, 'USD')$$,
  'XR001', null, 'the engagement belongs to the per diem''s project');
select throws_ok($$insert into app.per_diems (project_id, engagement_id, day, amount_minor, currency_code) values ((select id from world where key = 'prj_a'), (select id from world where key = 'eng_art_a'), '2027-07-06', 6500, 'USD')$$,
  'XR001', null, 'a per diem needs an Active or Closing engagement');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.per_diems), 1, 'the engaged person reads their own per diem');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.per_diems), 0, 'another freelancer reads none');
select pg_temp.as_platform();

-- Agreements and comments (0981) ---------------------------------------------------------------------------------
select ok(exists (select 1 from pg_constraint where conname = 'agreements_offer_id_fkey'), 'agreements reference offers');
select ok((select count(*) from private.comment_subjects where table_name in ('app.shift_swaps', 'app.time_entries', 'app.rate_cards', 'app.pay_periods',
  'app.time_off_requests', 'app.requisitions', 'app.agreements', 'app.role_assignments')) = 8, 'People and Crew records are commentable');

select * from finish();
rollback;
