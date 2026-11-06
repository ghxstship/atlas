-- pgTAP: migration 6060 (RRR-244), a timesheet's period is a run of the project's local days. An evening in a zone
-- behind UTC counts on its own day, a morning in a zone ahead of UTC too, and a daylight saving change moves the start.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select no_plan();

select pg_temp.as_platform();
update app.projects set time_zone = 'America/New_York' where id = pg_temp.id('prj_a');

select is(private.project_day_start(pg_temp.id('prj_a'), date '2027-06-01'), timestamptz '2027-06-01 04:00+00',
  'a June day starts at 04:00 UTC in New York');
select is(private.project_day_start(pg_temp.id('prj_a'), date '2027-03-14'), timestamptz '2027-03-14 05:00+00',
  'the day the clocks change starts under the old offset');
select is(private.project_day_start(pg_temp.id('prj_a'), date '2027-03-15'), timestamptz '2027-03-15 04:00+00',
  'and the next under the new one');

-- 01:00 UTC on June 2 is 21:00 on June 1 in New York.
select pg_temp.as_user('frank');
insert into app.time_entries (project_id, membership_id, clock_in, clock_out)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-02 01:00+00', '2027-06-02 02:00+00');
select pg_temp.as_platform();

select is(private.worker_minutes(pg_temp.id('frank@org_a'), null, null, pg_temp.id('prj_a'), date '2027-06-01', date '2027-06-01'), 60,
  'an evening behind UTC counts on its own local day');
select is(private.worker_minutes(pg_temp.id('frank@org_a'), null, null, pg_temp.id('prj_a'), date '2027-06-02', date '2027-06-02'), 0,
  'and not on the next');

-- An entry still open is found on its local day as well.
select pg_temp.as_user('frank');
insert into app.time_entries (project_id, membership_id, clock_in)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-03 01:00+00');
select pg_temp.as_platform();
select ok(private.worker_has_open_entry(pg_temp.id('frank@org_a'), null, null, pg_temp.id('prj_a'), date '2027-06-02', date '2027-06-02'),
  'an open entry is found on its local day');
select ok(not private.worker_has_open_entry(pg_temp.id('frank@org_a'), null, null, pg_temp.id('prj_a'), date '2027-06-03', date '2027-06-03'),
  'and not on the next');
update app.time_entries set clock_out = '2027-06-03 01:30+00'
  where project_id = pg_temp.id('prj_a') and clock_in = '2027-06-03 01:00+00';

-- The view gives a timesheet's list the same bounds as its sum.
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), date '2027-06-01', date '2027-06-01') returning id)
  insert into world select 'ts_ny', id from x;
select is((select worked_minutes from app.timesheet_hours where timesheet_id = pg_temp.id('ts_ny')), 60,
  'the timesheet counts the evening');
select is((select period_starts_at from app.timesheet_hours where timesheet_id = pg_temp.id('ts_ny')), timestamptz '2027-06-01 04:00+00',
  'its list starts when the local day does');
select is((select period_ends_at from app.timesheet_hours where timesheet_id = pg_temp.id('ts_ny')), timestamptz '2027-06-02 04:00+00',
  'and ends when the next one starts');

-- Ahead of UTC: 16:00 UTC on June 10 is 01:00 on June 11 in Tokyo.
update app.projects set time_zone = 'Asia/Tokyo' where id = pg_temp.id('prj_a');
select pg_temp.as_user('frank');
insert into app.time_entries (project_id, membership_id, clock_in, clock_out)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-10 16:00+00', '2027-06-10 17:00+00');
select pg_temp.as_platform();
select is(private.worker_minutes(pg_temp.id('frank@org_a'), null, null, pg_temp.id('prj_a'), date '2027-06-11', date '2027-06-11'), 60,
  'a night ahead of UTC counts on its own local day');
select is(private.worker_minutes(pg_temp.id('frank@org_a'), null, null, pg_temp.id('prj_a'), date '2027-06-10', date '2027-06-10'), 0,
  'and not on the day before');

select * from finish();
rollback;
