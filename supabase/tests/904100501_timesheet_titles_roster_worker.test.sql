-- pgTAP: migration 904100501 (C-24). An agency staff member's submitted timesheet names them in its reminder title and
-- arguments too: 5862 resolved the worker without the roster entry, so the reminder read "Timesheet , Nov 8 to Nov 10".
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 4654_project_facts_world.psql
\ir 4750_agency_world.psql

select plan(3);

select pg_temp.as_user('carol');
with t as (insert into app.timesheets (project_id, roster_entry_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('e_stella'), '2027-07-05', '2027-07-11') returning id)
  insert into world select 'ts_stella', id from t;
select pg_temp.as_user('stella');
select app.bulk_update_my_timesheets(jsonb_build_array(jsonb_build_object('id', pg_temp.id('ts_stella'),
  'set', jsonb_build_object('timesheet_state', 'Submitted'))));
select pg_temp.as_platform();

select is((select title from private.pending_approvals() where subject_table = 'timesheets' and subject_id = pg_temp.id('ts_stella')),
  'Timesheet Stella Okafor, Jul 5 to Jul 11', 'the reminder title names the roster worker');

select ok(private.send_approval_reminders(now() + interval '25 hours') > 0, 'the reminder goes after a day');
select ok((select count(*) > 0 and bool_and(n.message_args ->> 'title' = 'Timesheet Stella Okafor, Jul 5 to Jul 11'
                                            and n.message_args ->> 'workerName' = 'Stella Okafor'
                                            and n.message_args ->> 'periodStart' = '2027-07-05'
                                            and n.message_args ->> 'periodEnd' = '2027-07-11')
           from app.notifications n where n.subject_id = pg_temp.id('ts_stella') and n.kind = 'approval.reminder'),
  'every reminder names Stella and carries her period');

select * from finish();
rollback;
