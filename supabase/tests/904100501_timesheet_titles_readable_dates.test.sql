-- pgTAP: migration 904100501 (C-24). A timesheet's approval request and its reminder name the period in words, never
-- as ISO dates: "Nov 8 to Nov 10" within a year, with the years across two, and one day once.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(8);

select is(private.date_range_label('2026-11-08', '2026-11-10'), 'Nov 8 to Nov 10', 'a range within a year reads month and day');
select is(private.date_range_label('2026-12-29', '2027-01-04'), 'Dec 29, 2026 to Jan 4, 2027', 'a range across years names both years');
select is(private.date_range_label('2026-11-08', '2026-11-08'), 'Nov 8', 'a one-day range names the day once');
select is(private.date_range_label('2026-03-01', '2026-03-07'), 'Mar 1 to Mar 7', 'single-digit days carry no leading zero');

-- Frank submits a week; the Manager's request names him and the week in words.
select pg_temp.as_user('frank');
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
           values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-07-05', '2027-07-11') returning id)
  insert into world select 'ts', id from x;
select app.submit_timesheet(pg_temp.id('ts'), 'Week of the load-in.');
select pg_temp.as_platform();

select is((select message_args ->> 'title' from app.notifications
           where recipient_person_id = pg_temp.id('carol') and subject_id = pg_temp.id('ts') and kind = 'approval.requested'),
  format('Timesheet %s, Jul 5 to Jul 11', (select full_name from app.people where id = pg_temp.id('frank'))),
  'the request names the worker and the period in words');
select ok((select bool_and(message_args ->> 'title' !~ '\d{4}-\d{2}-\d{2}') from app.notifications
           where subject_id = pg_temp.id('ts') and kind = 'approval.requested'),
  'no request title carries an ISO date');
select is((select message_args ->> 'periodStart' || '/' || (message_args ->> 'periodEnd') from app.notifications
           where recipient_person_id = pg_temp.id('carol') and subject_id = pg_temp.id('ts') and kind = 'approval.requested'),
  '2027-07-05/2027-07-11', 'the dates stay in the arguments, for Compass to write in the person''s language');

select is((select title from private.pending_approvals() where subject_table = 'timesheets' and subject_id = pg_temp.id('ts')),
  format('Timesheet %s, Jul 5 to Jul 11', (select full_name from app.people where id = pg_temp.id('frank'))),
  'the reminder for the waiting timesheet names the period in words too');

select * from finish();
rollback;
