-- pgTAP: migration 1621, ADR 0033 decision 77 (2026-10-23, RRR-125). When the report.deliver worker records a scheduled
-- report emailed, the recipient gets report.delivered in the Inbox and as a push, about the report definition so it
-- opens the report in Atlas, and never as a second email or a text, even with email digests and texts on for reports.
-- A recipient who may not open the report (not its owner, and it is not shared) is told about no record. A failed
-- delivery sends nothing. private.notify now creates deliveries only on the channels a kind reaches.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(14);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

create function pg_temp.as_worker() returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  perform set_config('role', 'service_role', true);
end $$;

create function pg_temp.notices(p_person text) returns setof app.notifications
language sql as $$
  select n.* from app.notifications n where n.recipient_person_id = pg_temp.id(p_person) and n.kind = 'report.delivered'
$$;

-- Carol's weekly report to carol, dave, alice and bob, due now. Carol takes reports by email digest and by text as well.
select pg_temp.as_user('carol');
insert into app.report_definitions (membership_id, name, source_code) values (pg_temp.id('carol@org_a'), 'Spend Watch', 'records');
insert into k (key, id) select 'rep', id from app.report_definitions where name = 'Spend Watch';
insert into app.report_fields (report_definition_id, field, aggregate, position) values ((select id from k where key = 'rep'), 'title', 'None', 1);
insert into app.report_schedules (report_definition_id, cadence, local_hour, weekday, time_zone, export_format)
values ((select id from k where key = 'rep'), 'Weekly', 8, 1, 'America/New_York', 'CSV');
insert into k (key, id) select 'sched', id from app.report_schedules where report_definition_id = (select id from k where key = 'rep');
insert into app.report_schedule_recipients (report_schedule_id, membership_id) values
  ((select id from k where key = 'sched'), pg_temp.id('carol@org_a')),
  ((select id from k where key = 'sched'), pg_temp.id('dave@org_a')),
  ((select id from k where key = 'sched'), pg_temp.id('alice@org_a')),
  ((select id from k where key = 'sched'), pg_temp.id('bob@org_a'));
select app.set_my_notification_preferences(pg_temp.id('org_a'), '[
  {"category": "reports", "channel": "Email", "enabled": true},
  {"category": "reports", "channel": "SMS", "enabled": true},
  {"category": "reports", "channel": "Push", "enabled": true}]'::jsonb);
select pg_temp.as_platform();
insert into app.notification_settings (membership_id, time_zone, digest_frequency) values (pg_temp.id('carol@org_a'), 'UTC', 'Daily');
update app.report_schedules set next_run_at = now() - interval '1 minute' where id = (select id from k where key = 'sched');

select set_eq($$select channel::text from private.notification_templates where kind = 'report.delivered'$$,
  $$values ('In App'), ('Push')$$, 'report.delivered reaches the Inbox and a push only');

select pg_temp.as_worker();
select app.queue_due_report_schedules();
select pg_temp.as_platform();
insert into k (key, id) select 'carol_run', r.id from app.report_runs r
where r.report_definition_id = (select id from k where key = 'rep') and r.run_for_membership_id = pg_temp.id('carol@org_a');
insert into k (key, id) select 'dave_run', r.id from app.report_runs r
where r.report_definition_id = (select id from k where key = 'rep') and r.run_for_membership_id = pg_temp.id('dave@org_a');
insert into k (key, id) select r.run_for_membership_id::text, r.id from app.report_runs r
where r.report_definition_id = (select id from k where key = 'rep') and r.run_for_membership_id in (pg_temp.id('alice@org_a'), pg_temp.id('bob@org_a'));
insert into k (key, id) select 'carol_delivery', d.id from app.report_deliveries d where d.report_run_id = (select id from k where key = 'carol_run');
insert into k (key, id) select 'dave_delivery', d.id from app.report_deliveries d where d.report_run_id = (select id from k where key = 'dave_run');

create function pg_temp.deliver(p_membership text) returns void
language plpgsql as $$
declare
  v_run uuid := (select id from k where key = pg_temp.id(p_membership)::text);
begin
  perform app.start_report_run(v_run);
  perform app.finish_report_run(v_run, 'Succeeded', private.report_result_path(pg_temp.id('org_a'), v_run), 3, 0);
  perform app.finish_report_delivery((select d.id from app.report_deliveries d where d.report_run_id = v_run), true, 'mailpit-1621');
end $$;

-- 1. A sent report reaches the Inbox and a push ------------------------------------------------------------------------
select pg_temp.as_worker();
select app.start_report_run((select id from k where key = 'carol_run'));
select app.finish_report_run((select id from k where key = 'carol_run'), 'Succeeded',
  private.report_result_path(pg_temp.id('org_a'), (select id from k where key = 'carol_run')), 3, 0);
select pg_temp.as_platform();
select is((select count(*)::integer from pg_temp.notices('carol')), 0, 'nothing is sent before the email goes out');
select pg_temp.as_worker();
select app.finish_report_delivery((select id from k where key = 'carol_delivery'), true, 'mailpit-1621');
select pg_temp.as_platform();
select is((select count(*)::integer from pg_temp.notices('carol')), 1, 'once the worker records the email sent, the recipient is told once');
select is((select n.subject_table || ' ' || (n.subject_id = (select id from k where key = 'rep'))::text from pg_temp.notices('carol') n),
  'app.report_definitions true', 'about the report, so the Inbox item opens it in Atlas');
select is((select n.message_args ->> 'title' from pg_temp.notices('carol') n), 'Spend Watch', 'named by the report''s name');
select is((select n.message_args ->> 'reportRunId' from pg_temp.notices('carol') n), (select id::text from k where key = 'carol_run'),
  'with the run that made the file');
select ok((select n.archived_at is null from pg_temp.notices('carol') n), 'it shows in her Inbox');
select set_eq($$select d.channel::text from app.notification_deliveries d join pg_temp.notices('carol') n on n.id = d.notification_id$$,
  $$values ('Push')$$, 'and goes out as a push only: no second email, no digest line and no text, although she takes all three for reports');
select is((select count(*)::integer from app.email_digest_queue q where q.membership_id = pg_temp.id('carol@org_a')), 0,
  'nothing joins her email digest');

-- 2. A failed delivery tells nobody -------------------------------------------------------------------------------------
select pg_temp.as_worker();
select app.start_report_run((select id from k where key = 'dave_run'));
select app.finish_report_run((select id from k where key = 'dave_run'), 'Succeeded',
  private.report_result_path(pg_temp.id('org_a'), (select id from k where key = 'dave_run')), 3, 0);
select app.finish_report_delivery((select id from k where key = 'dave_delivery'), false, null, 'The recipient has no email address on file.');
select pg_temp.as_platform();
select is((select count(*)::integer from pg_temp.notices('dave')), 0, 'a delivery that failed sends no report.delivered');

-- 3. Only a recipient who may open the report is sent to it --------------------------------------------------------------
-- Alice owns the org but not the report, and carol has not shared it (0550): her notice names no record, so it opens her
-- Inbox, not Saved reports with no panel. Once carol shares it, bob, who may read reports on records, is sent to it.
select pg_temp.as_worker();
select pg_temp.deliver('alice@org_a');
select pg_temp.as_platform();
select is((select count(*)::integer from pg_temp.notices('alice')), 1, 'a recipient who may not open the report is still told');
select ok((select n.subject_table is null and n.subject_id is null from pg_temp.notices('alice') n),
  'about no record, while the report is not shared with her');
update app.report_definitions set shared = true where id = (select id from k where key = 'rep');
select pg_temp.as_worker();
select pg_temp.deliver('bob@org_a');
select pg_temp.as_platform();
select is((select n.subject_id from pg_temp.notices('bob') n), (select id from k where key = 'rep'),
  'once it is shared, a member who may read its source is sent to the report');

-- 4. Every kind reaches only its own channels ------------------------------------------------------------------------------
-- opportunity.matched names In App, Email and Push (A89): a member who takes opportunities by text gets no text.
select pg_temp.as_user('carol');
select app.set_my_notification_preferences(pg_temp.id('org_a'), '[{"category": "opportunities", "channel": "SMS", "enabled": true}]'::jsonb);
select pg_temp.as_platform();
select private.notify(pg_temp.id('org_a'), pg_temp.id('carol'), 'opportunity.matched', null, null, null,
  '{"count": 2, "searchName": "Riggers"}') as v_match \gset
select is((select count(*)::integer from app.notification_deliveries d where d.notification_id = :'v_match' and d.channel = 'SMS'), 0,
  'a kind never gets a delivery on a channel it does not reach');

select * from finish();
rollback;
