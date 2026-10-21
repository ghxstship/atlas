-- pgTAP: reports, runs and schedules to members only, dashboards, calendar feeds with hashed tokens and
-- owner-scoped content, project inboxes and signed reply addresses (Section 4.6.4, Section 4.6.5).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(37);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert on k to public;

-- Reports ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$insert into app.report_definitions (membership_id, name, source_code) values (pg_temp.id('dave@org_a'), 'My Report', 'records')$$,
  '42501', null, 'a member without reports.report.write cannot build reports');
select pg_temp.as_user('carol');
insert into app.report_definitions (membership_id, name, source_code, chart, group_by_field)
values (pg_temp.id('carol@org_a'), 'Open Records by Phase', 'records', 'Bar', 'phase_code');
insert into k (key, id) select 'rep', id from app.report_definitions;
insert into app.report_fields (report_definition_id, field, aggregate, position) values
  ((select id from k where key = 'rep'), 'phase_code', 'None', 1), ((select id from k where key = 'rep'), 'id', 'Count', 2);
insert into app.report_filters (report_definition_id, field, operator, value_text) values ((select id from k where key = 'rep'), 'record_state', 'ne', 'Complete');
select throws_ok($$insert into app.report_definitions (membership_id, name, source_code) values (pg_temp.id('carol@org_a'), 'Bad', 'custom_object')$$,
  '23514', null, 'a custom object report names its object');
select ok(app.run_report((select id from k where key = 'rep'), 'PDF') is not null, 'the owner runs the report');
select is((select run_for_membership_id from app.report_runs), pg_temp.id('carol@org_a'), 'a run uses the access of the member it runs for');
select pg_temp.as_platform();
select is((select count(*)::integer from app.job_queue where job_kind = 'report.run'), 1, 'the run job is queued');
select pg_temp.as_user('frank');
select is((select count(*)::integer from app.report_definitions), 0, 'others cannot see a private report');
select pg_temp.as_user('carol');
update app.report_definitions set shared = true;
select pg_temp.as_user('frank');
select is((select count(*)::integer from app.report_definitions), 0, 'a shared report needs reports.report.read and the source''s read capability');
select pg_temp.as_user('bob');
select is((select count(*)::integer from app.report_fields), 2, 'a reader of the source reads a shared report and its fields');
select throws_ok($$insert into app.report_fields (report_definition_id, field, position) values ((select id from k where key = 'rep'), 'title', 3)$$,
  '42501', null, 'only the owner edits a report');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.report_definitions), 0, 'no cross-tenant report reads');

-- Schedules go to members only ---------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.report_schedules (report_definition_id, cadence, local_hour, weekday, time_zone, export_format, next_run_at)
values ((select id from k where key = 'rep'), 'Weekly', 7, 1, 'America/New_York', 'PDF', now() - interval '10 years');
insert into k (key, id) select 'sched', id from app.report_schedules;
select ok((select next_run_at > now() and extract(isodow from next_run_at at time zone 'America/New_York') = 1
           and extract(hour from next_run_at at time zone 'America/New_York') = 7 from app.report_schedules),
  'the database computes the next delivery on the weekday and hour in the schedule''s zone');
select throws_ok($$insert into app.report_schedules (report_definition_id, cadence, local_hour, time_zone, export_format, next_run_at)
  values ((select id from k where key = 'rep'), 'Weekly', 7, 'America/New_York', 'PDF', now())$$, '23514', null, 'a weekly schedule names its weekday');
insert into app.report_schedule_recipients (report_schedule_id, membership_id) values ((select id from k where key = 'sched'), pg_temp.id('dave@org_a'));
select throws_ok($$insert into app.report_schedule_recipients (report_schedule_id, membership_id) values ((select id from k where key = 'sched'), pg_temp.id('xavier@org_b'))$$,
  'XR001', null, 'a scheduled report never goes outside the org');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.report_schedule_recipients), 1, 'a recipient sees that they receive the report');

-- Dashboards -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
update app.report_definitions set shared = false;
select pg_temp.as_user('dave');
insert into app.dashboards (org_id, name, membership_id) values (pg_temp.id('org_a'), 'My Day', pg_temp.id('dave@org_a'));
insert into k (key, id) select 'dash', id from app.dashboards;
select throws_ok($$insert into app.dashboard_tiles (dashboard_id, report_definition_id, grid_column, grid_row, column_span, row_span)
  values ((select id from k where key = 'dash'), (select id from k where key = 'rep'), 1, 1, 6, 4)$$, '42501', null,
  'a tile shows only a report its dashboard owner can read');
select throws_ok($$insert into app.dashboards (org_id, name, membership_id, team_id) values (pg_temp.id('org_a'), 'Both', pg_temp.id('dave@org_a'), pg_temp.id('team_a'))$$,
  '23514', null, 'a dashboard belongs to one member or one team');
select pg_temp.as_user('erin');
insert into app.dashboards (org_id, name, team_id) values (pg_temp.id('org_a'), 'Load-In Board', pg_temp.id('team_a'));
select is((select count(*)::integer from app.dashboards), 1, 'a team member reads the team dashboard and not other people''s');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.dashboards), 1, 'a person outside the team does not see it');
select pg_temp.as_platform();
select throws_ok($$insert into app.dashboard_tiles (dashboard_id, report_definition_id, grid_column, grid_row, column_span, row_span)
  values ((select id from k where key = 'dash'), (select id from k where key = 'rep'), 10, 1, 6, 4)$$, '23514', null, 'tiles stay on the 12-column grid');

-- Calendar feeds --------------------------------------------------------------------------------------------------------
insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone) values
  (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '0000.50.01', date_trunc('day', now()) + interval '30 days 8 hours', date_trunc('day', now()) + interval '30 days 16 hours', 'America/New_York'),
  (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), '0000.50.01', date_trunc('day', now()) + interval '31 days 8 hours', date_trunc('day', now()) + interval '31 days 16 hours', 'America/New_York');
select pg_temp.as_user('frank');
insert into k (key, id, val) select 'feed', calendar_feed_id, feed_token from app.create_calendar_feed(pg_temp.id('org_a'));
select ok((select val like 'xcal_%' from k where key = 'feed'), 'the feed token is returned once');
select throws_ok($$select token_hash from app.calendar_feeds$$, '42501', null, 'nobody reads the token hash');
select is((select token_hint from app.calendar_feeds), right((select val from k where key = 'feed'), 4), 'only a hint of the token is shown');
select throws_ok($$select app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a2'))$$, '42501', null,
  'nobody subscribes to a project they cannot read');
select pg_temp.as_anon();
select is(coalesce(jsonb_array_length(api_public.calendar_feed((select val from k where key = 'feed')) -> 'events'), 0), 1,
  'a personal feed shows the owner''s own shift and nobody else''s');
select is(coalesce(jsonb_array_length(api_public.calendar_feed('xcal_wrong') -> 'events'), 0), 0, 'a wrong token shows nothing');
select pg_temp.as_user('frank');
update app.calendar_feeds set revoked_at = now();
select throws_ok($$update app.calendar_feeds set project_id = pg_temp.id('prj_a')$$, '42501', null, 'a feed only gets revoked');
select pg_temp.as_anon();
select is(coalesce(jsonb_array_length(api_public.calendar_feed((select val from k where key = 'feed')) -> 'events'), 0), 0, 'a revoked feed shows nothing');
select pg_temp.as_user('dave');
insert into k (key, id, val) select 'pfeed', calendar_feed_id, feed_token from app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'));
select pg_temp.as_anon();
select ok(coalesce(jsonb_array_length(api_public.calendar_feed((select val from k where key = 'pfeed')) -> 'events'), 0) >= 1,
  'a project feed shows the project''s shifts its owner may see');
select pg_temp.as_user('dave');
select app.leave_organization(pg_temp.id('org_a'));
select pg_temp.as_anon();
select is(coalesce(jsonb_array_length(api_public.calendar_feed((select val from k where key = 'pfeed')) -> 'events'), 0), 0,
  'leaving the org ends the feed at once (invariant 3)');

-- Email in ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
insert into k (key, val) values ('inbox', app.create_project_inbox(pg_temp.id('prj_a')));
select pg_temp.as_platform();
select ok(app.receive_inbound_email((select val from k where key = 'inbox'), 'Rider@Bandmgmt.test', 'Rider v3', '<m1@bandmgmt.test>', true, 'Attached.', 'raw/m1.eml') is not null,
  'mail to a project inbox lands as an inbound message');
select is(app.receive_inbound_email((select val from k where key = 'inbox'), 'rider@bandmgmt.test', 'Rider v3', '<m1@bandmgmt.test>', true, 'Attached.', 'raw/m1.eml'), null::uuid,
  'a redelivery is ignored');
select is((select inbound_status from app.inbound_messages where message_id_header = '<m1@bandmgmt.test>'), 'Verified'::app.inbound_status, 'DKIM-verified mail is accepted');
insert into k (key, val) values ('reply', private.reply_local_part(pg_temp.id('erin'), pg_temp.id('prj_a')));
select app.receive_inbound_email((select val from k where key = 'reply'), 'erin@northwind.test', 'Re: Opening night', '<r1@northwind.test>', true, 'Confirmed for 6 PM.', 'raw/r1.eml');
select is((select inbound_status from app.inbound_messages where message_id_header = '<r1@northwind.test>'), 'Verified'::app.inbound_status,
  'a signed reply from the person''s own address with DKIM passing is accepted');
select is(app.receive_inbound_email(regexp_replace((select val from k where key = 'reply'), '.$', 'x'), 'erin@northwind.test', 'Re', '<r2@northwind.test>', true, 'Forged.', 'raw/r2.eml'),
  null::uuid, 'a reply address with a bad signature is ignored');
select app.receive_inbound_email((select val from k where key = 'reply'), 'mallory@evil.test', 'Re', '<r3@evil.test>', true, 'Spoof.', 'raw/r3.eml');
select is((select rejection_reason from app.inbound_messages where message_id_header = '<r3@evil.test>'),
  'The reply did not come from the address the email was sent to.', 'a reply from another address is rejected with the reason');
select pg_temp.as_user('erin');
select is((select count(*)::integer from app.inbound_messages where purpose = 'Reply'), 2, 'a person sees replies sent from their reply address');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.inbound_messages), 0, 'no cross-tenant inbound reads');

select * from finish();
rollback;
