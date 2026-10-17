-- pgTAP: A43 (RRR-87), migrations 1126 and 1127, finding A38-004. Report runs in .xlsx and PDF name their own
-- file; the scheduler turns a due schedule into one run per recipient, as that member; a finished run releases
-- its deliveries to the report.deliver queue and a failed one fails them; only the worker reads and finishes a
-- delivery. Same-tenant allow, cross-tenant deny, anon deny, role band.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(29);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

create function pg_temp.as_worker() returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  perform set_config('role', 'service_role', true);
end $$;

-- World: carol's report and a weekly PDF schedule to carol and dave, already due.
select pg_temp.as_user('carol');
insert into app.report_definitions (membership_id, name, source_code) values (pg_temp.id('carol@org_a'), 'Spend Watch', 'records');
insert into k (key, id) select 'rep', id from app.report_definitions where name = 'Spend Watch';
insert into app.report_fields (report_definition_id, field, aggregate, position) values ((select id from k where key = 'rep'), 'title', 'None', 1);
insert into app.report_schedules (report_definition_id, cadence, local_hour, weekday, time_zone, export_format)
values ((select id from k where key = 'rep'), 'Weekly', 8, 1, 'America/New_York', 'PDF');
insert into k (key, id) select 'sched', id from app.report_schedules where report_definition_id = (select id from k where key = 'rep');
insert into app.report_schedule_recipients (report_schedule_id, membership_id) values
  ((select id from k where key = 'sched'), pg_temp.id('carol@org_a')),
  ((select id from k where key = 'sched'), pg_temp.id('dave@org_a'));
select pg_temp.as_platform();
update app.report_schedules set next_run_at = now() - interval '1 minute' where id = (select id from k where key = 'sched');

-- Formats (1126) ---------------------------------------------------------------------------------------------------
select is(private.report_result_path(pg_temp.id('org_a'), pg_temp.id('org_a'), 'XLSX'), pg_temp.id('org_a')::text || '/' || pg_temp.id('org_a')::text || '.xlsx',
  'an .xlsx run names a .xlsx file');
select is(private.report_result_run('a/' || pg_temp.id('org_a')::text || '.pdf'), pg_temp.id('org_a'), 'a PDF file name names its run');
select is(private.report_result_run('a/' || pg_temp.id('org_a')::text || '.exe'), null::uuid, 'any other extension names no run');

-- Scheduler (1127) --------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok('select app.queue_due_report_schedules()', '42501', null, 'a person cannot run the scheduler');
select pg_temp.as_worker();
select is(app.queue_due_report_schedules(), 2, 'the scheduler queues one delivery per recipient of the due schedule');
select pg_temp.as_platform();
select is((select count(*)::int from app.report_runs where report_definition_id = (select id from k where key = 'rep') and export_format = 'PDF'), 2,
  'with one PDF run each');
select is((select array_agg(run_for_membership_id order by run_for_membership_id) from app.report_runs where report_definition_id = (select id from k where key = 'rep')),
  (select array_agg(m order by m) from unnest(array[pg_temp.id('carol@org_a'), pg_temp.id('dave@org_a')]) m),
  'each run is made as its recipient, with their own access');
select is((select count(*)::int from app.job_queue q join app.report_runs r on r.id = q.subject_id
  where q.job_kind = 'report.run' and r.report_definition_id = (select id from k where key = 'rep')), 2, 'and queued for the report.run worker');
select ok((select next_run_at > now() from app.report_schedules where id = (select id from k where key = 'sched')), 'the schedule moves to its next slot');
select pg_temp.as_worker();
select is(app.queue_due_report_schedules(), 0, 'a schedule is not queued twice for one slot');
select pg_temp.as_platform();
update app.report_schedules set next_run_at = now() - interval '1 minute', paused_at = now() where id = (select id from k where key = 'sched');
select pg_temp.as_worker();
select is(app.queue_due_report_schedules(), 0, 'a paused schedule is not queued');
select pg_temp.as_platform();
update app.report_schedules set paused_at = null, next_run_at = now() + interval '1 day' where id = (select id from k where key = 'sched');

insert into k (key, id) select 'carol_run', r.id from app.report_runs r where r.report_definition_id = (select id from k where key = 'rep') and r.run_for_membership_id = pg_temp.id('carol@org_a');
insert into k (key, id) select 'dave_run', r.id from app.report_runs r where r.report_definition_id = (select id from k where key = 'rep') and r.run_for_membership_id = pg_temp.id('dave@org_a');
insert into k (key, id) select 'carol_delivery', d.id from app.report_deliveries d where d.report_run_id = (select id from k where key = 'carol_run');
insert into k (key, id) select 'dave_delivery', d.id from app.report_deliveries d where d.report_run_id = (select id from k where key = 'dave_run');

-- A finished run releases its delivery ------------------------------------------------------------------------------
select pg_temp.as_worker();
select app.start_report_run((select id from k where key = 'carol_run'));
select throws_ok(format($$select app.finish_report_run('%s', 'Succeeded', '%s', 3, 1)$$, (select id from k where key = 'carol_run'),
  private.report_result_path(pg_temp.id('org_a'), (select id from k where key = 'carol_run'))), 'XR001', null,
  'a PDF run cannot claim a CSV file');
select lives_ok(format($$select app.finish_report_run('%s', 'Succeeded', '%s', 3, 1)$$, (select id from k where key = 'carol_run'),
  private.report_result_path(pg_temp.id('org_a'), (select id from k where key = 'carol_run'), 'PDF')), 'a PDF run finishes with its PDF');
select pg_temp.as_platform();
select is((select count(*)::int from app.job_queue where job_kind = 'report.deliver' and subject_id = (select id from k where key = 'carol_delivery')), 1,
  'the finished run queues its delivery for the report.deliver worker');
select pg_temp.as_worker();
select app.start_report_run((select id from k where key = 'dave_run'));
select app.finish_report_run((select id from k where key = 'dave_run'), 'Failed', null, null, null, 'The source was removed.');
select pg_temp.as_platform();
select is((select delivery_status || ': ' || last_error from app.report_deliveries where id = (select id from k where key = 'dave_delivery')),
  'Failed: The report run failed: The source was removed.', 'a failed run fails its delivery with the reason');

-- Delivery worker API -----------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$select * from app.report_delivery('%s')$$, (select id from k where key = 'carol_delivery')), '42501', null,
  'a person cannot read the worker''s view of a delivery');
select pg_temp.as_worker();
select is((select report_name || ' / ' || export_format::text || ' / ' || row_count::text from app.report_delivery((select id from k where key = 'carol_delivery'))),
  'Spend Watch / PDF / 3', 'the worker reads the report, format and counts');
select ok((select recipient_email is not null from app.report_delivery((select id from k where key = 'carol_delivery'))), 'and the recipient''s address');
select throws_ok(format($$select app.finish_report_delivery('%s', false, null, ' ')$$, (select id from k where key = 'carol_delivery')), 'XR001', null,
  'a failed delivery says why');
select lives_ok(format($$select app.finish_report_delivery('%s', true, 'mailpit-1')$$, (select id from k where key = 'carol_delivery')),
  'the worker records the delivery sent');
select throws_ok(format($$select app.finish_report_delivery('%s', true, 'again')$$, (select id from k where key = 'carol_delivery')), 'XR001',
  'report_delivery_finished: This report delivery has already finished.', 'a delivery finishes once');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'report.delivered' and subject_id = (select id from k where key = 'carol_delivery')), 1,
  'a sent delivery emits report.delivered');

-- Access ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select count(*)::int from app.report_deliveries where report_schedule_id = (select id from k where key = 'sched')), 2,
  'same tenant: the schedule''s owner reads every delivery');
select throws_ok(format($$update app.report_deliveries set delivery_status = 'Sent', sent_at = now() where id = '%s'$$, (select id from k where key = 'dave_delivery')),
  '42501', null, 'a person cannot mark a delivery sent');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.report_deliveries where report_schedule_id = (select id from k where key = 'sched')), 1,
  'role band: a recipient reads only their own delivery');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.report_deliveries), 0, 'cross tenant: another org reads none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.report_deliveries', '42501', null, 'anon deny');
select pg_temp.as_platform();
select is((select count(*)::int from cron.job where jobname = 'xos_queue_due_report_schedules'), 1, 'the scheduler runs on pg_cron');
select is((select max_attempts::int from private.job_kinds where code = 'report.deliver'), 5, 'report.deliver is a job kind with five attempts');

select * from finish();
rollback;
