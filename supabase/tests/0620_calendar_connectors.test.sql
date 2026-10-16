-- pgTAP: calendar connectors (Section 17: two-way Meeting, Event and Shift sync). Calendar targets (RLS, role bands,
-- category and cross-org guards, one target per kind and scope), the item view (records and shifts in one shape,
-- canceled items kept for removal), and inbound time changes with replan logging and refusals.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

select pg_temp.as_user('bob');
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'google_calendar', 'Production Calendar') returning id)
  insert into world select 'gcal', id from c;
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'slack', 'Slack') returning id)
  insert into world select 'slack', id from c;
select app.store_integration_credential(pg_temp.id('gcal'), 'fixture-token', 'OAuth Token');
select app.transition_integration_connection(pg_temp.id('gcal'), 'Pending', 'Connected', 'Authorized.');

select pg_temp.as_user('carol');
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), 'Meeting', 'Production Meeting', 'Y', 'Declared', '2027-06-01 14:00+00', '2027-06-01 15:00+00', 'America/New_York') returning id)
  insert into world select 'meeting', id from r;
insert into app.record_meeting (record_id, location_text) values (pg_temp.id('meeting'), 'Pier Office');
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, starts_at)
  values (pg_temp.id('prj_a'), 'Event', 'Opening Night on the Pier', 'Y', 'Declared', '2027-06-05 23:00+00') returning id)
  insert into world select 'event', id from r;
insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values (pg_temp.id('prj_a'), 'Meeting', 'Undated Meeting', 'Y', 'Declared');
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, starts_at)
  values (pg_temp.id('prj_a2'), 'Meeting', 'Gala Planning Session', 'Y', 'Declared', '2027-11-01 15:00+00') returning id)
  insert into world select 'gala', id from r;
with s as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), (select role_code from xpms.role order by role_code limit 1), '2027-06-05 20:00+00', '2027-06-06 04:00+00', 'America/New_York') returning id)
  insert into world select 'shift', id from s;

-- Targets ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok($$insert into app.integration_calendar_targets (integration_connection_id, project_id, sync_kind, external_calendar_id) values ((select id from world where key = 'gcal'), (select id from world where key = 'prj_a'), 'Meeting', 'nwl-meetings@group.calendar.google.com')$$,
  'an Admin points project meetings at a calendar');
select lives_ok($$insert into app.integration_calendar_targets (integration_connection_id, sync_kind, external_calendar_id, direction, conflict_policy) values ((select id from world where key = 'gcal'), 'Event', 'events@group.calendar.google.com', 'Outbound', 'XOS Wins')$$,
  'and every event of the org at another');
select lives_ok($$insert into app.integration_calendar_targets (integration_connection_id, project_id, sync_kind, external_calendar_id) values ((select id from world where key = 'gcal'), (select id from world where key = 'prj_a'), 'Shift', 'crew@group.calendar.google.com')$$,
  'and project shifts at a crew calendar');
select throws_ok($$insert into app.integration_calendar_targets (integration_connection_id, project_id, sync_kind, external_calendar_id) values ((select id from world where key = 'gcal'), (select id from world where key = 'prj_a'), 'Meeting', 'other')$$,
  '23505', null, 'one target per kind and project');
select throws_ok($$insert into app.integration_calendar_targets (integration_connection_id, sync_kind, external_calendar_id) values ((select id from world where key = 'gcal'), 'Event', 'other')$$,
  '23505', null, 'one org-wide target per kind');
select throws_ok($$insert into app.integration_calendar_targets (integration_connection_id, sync_kind, external_calendar_id) values ((select id from world where key = 'slack'), 'Meeting', 'C123')$$,
  'XR001', 'integration_category_mismatch: integration_calendar_targets rows belong to a Calendar connection, not a Communication connection.', 'targets belong to calendar connections');
select throws_ok($$insert into app.integration_calendar_targets (integration_connection_id, project_id, sync_kind, external_calendar_id) values ((select id from world where key = 'gcal'), (select id from world where key = 'prj_b'), 'Shift', 'x')$$,
  'XR001', 'cross_org_reference: integration_calendar_targets.project_id points to a row of another org.', 'a target cannot name another org''s project');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.integration_calendar_targets), 0, 'a Manager reads no targets');
select throws_ok($$insert into app.integration_calendar_targets (integration_connection_id, sync_kind, external_calendar_id) values ((select id from world where key = 'gcal'), 'Shift', 'x')$$, '42501', null, 'a Manager cannot add targets');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.integration_calendar_targets), 0, 'another org reads none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.integration_calendar_targets', '42501', null, 'anon cannot read targets');
select throws_ok('select 1 from app.integration_calendar_items', '42501', null, 'anon cannot read calendar items');

-- Items ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select count(*)::int from app.integration_calendar_items where sync_kind = 'Meeting' and integration_connection_id = pg_temp.id('gcal')), 1, 'the project meeting syncs; undated and other-project meetings do not');
select is((select location_text from app.integration_calendar_items where local_id = pg_temp.id('meeting')), 'Pier Office', 'with its location');
select is((select ends_at from app.integration_calendar_items where local_id = pg_temp.id('event')), '2027-06-06 00:00+00'::timestamptz, 'an event without an end lasts an hour');
select is((select time_zone from app.integration_calendar_items where local_id = pg_temp.id('event')), 'America/New_York', 'and takes the project time zone');
select is((select entity::text from app.integration_calendar_items where local_id = pg_temp.id('shift')), 'Shift', 'shifts sync as Shift rows');
select ok((select title like 'Northwind Summer Series · %' from app.integration_calendar_items where local_id = pg_temp.id('shift')), 'a shift is titled with its project and role');
select is((select location_text from app.integration_calendar_items where local_id = pg_temp.id('shift')), 'Northwind Pier Pavilion', 'at the project venue');
select pg_temp.as_user('bob');
select is((select count(*)::int from app.integration_calendar_items), 3, 'an Admin reads the items of the org''s targets');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.integration_calendar_items), 0, 'another org reads none');
select pg_temp.as_platform();
update app.records set deleted_at = now() where id = pg_temp.id('event');
select ok((select canceled from app.integration_calendar_items where local_id = pg_temp.id('event')), 'a deleted item stays listed as canceled for removal');
update app.records set deleted_at = null where id = pg_temp.id('event');

-- Inbound changes ----------------------------------------------------------------------------------------------------------
select throws_ok($$select app.apply_calendar_change((select id from world where key = 'gcal'), 'Record', (select id from world where key = 'meeting'), '2027-06-01 16:00+00', '2027-06-01 17:00+00', 'etag-2')$$,
  'XR001', 'calendar_item_unmapped: Only items this connection placed on the calendar take changes from it.', 'an unmapped item takes no change');
select app.upsert_integration_external_id(pg_temp.id('gcal'), 'Record', pg_temp.id('meeting'), 'gcal-evt-1', 'etag-1');
select app.upsert_integration_external_id(pg_temp.id('gcal'), 'Shift', pg_temp.id('shift'), 'gcal-evt-2', 'etag-1');
select pg_temp.as_user('bob');
select throws_ok($$select app.apply_calendar_change((select id from world where key = 'gcal'), 'Record', (select id from world where key = 'meeting'), '2027-06-01 16:00+00', '2027-06-01 17:00+00', 'etag-2')$$,
  '42501', null, 'signed-in callers cannot apply calendar changes');
select pg_temp.as_user('carol');
select app.transition_record(pg_temp.id('meeting'), 'Proposed', 'Scheduled', 'Agenda set.');
select pg_temp.as_platform();
select ok(app.apply_calendar_change(pg_temp.id('gcal'), 'Record', pg_temp.id('meeting'), '2027-06-01 16:00+00', '2027-06-01 17:00+00', 'etag-2'), 'the runner moves a meeting');
select is((select starts_at from app.records where id = pg_temp.id('meeting')), '2027-06-01 16:00+00'::timestamptz, 'the record takes the new start');
select is((select reason from app.record_replans where record_id = pg_temp.id('meeting') order by created_at desc limit 1), 'Moved in the calendar connection Production Calendar.', 'a scheduled record logs a replan with the reason');
select is((select external_version from app.integration_external_ids where local_id = pg_temp.id('meeting')), 'etag-2', 'the provider version is recorded');
select ok(app.apply_calendar_change(pg_temp.id('gcal'), 'Shift', pg_temp.id('shift'), '2027-06-05 21:00+00', '2027-06-06 05:00+00', 'etag-2'), 'the runner moves a shift');
select is((select starts_at from app.shifts where id = pg_temp.id('shift')), '2027-06-05 21:00+00'::timestamptz, 'the shift takes the new start');
select throws_ok($$select app.apply_calendar_change((select id from world where key = 'gcal'), 'Shift', (select id from world where key = 'shift'), '2027-06-05 21:00+00', '2027-06-05 21:00+00', 'etag-3')$$,
  'XR001', 'calendar_window_invalid: A shift ends after it starts.', 'a shift cannot collapse to nothing');
select throws_ok($$select app.apply_calendar_change((select id from world where key = 'gcal'), 'Record', (select id from world where key = 'meeting'), '2027-06-01 18:00+00', '2027-06-01 17:00+00', 'etag-3')$$,
  'XR001', 'calendar_window_invalid: A calendar change needs a start and an end that is not before it.', 'an end before the start is refused');
select pg_temp.as_user('bob');
select app.transition_integration_connection(pg_temp.id('gcal'), 'Connected', 'Paused', 'Hold.');
select pg_temp.as_platform();
select throws_ok($$select app.apply_calendar_change((select id from world where key = 'gcal'), 'Record', (select id from world where key = 'meeting'), '2027-06-01 16:00+00', '2027-06-01 17:00+00', 'etag-4')$$,
  'XR001', 'integration_not_connected: Only a Connected connection can sync.', 'a paused connection writes nothing back');

select * from finish();
rollback;
