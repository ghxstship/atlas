-- pgTAP: ticketing data (Section 17, gate 8 measurement). Attendance rows follow the project under invariant 2
-- (projects.gate.read, projects.gate.evidence.write), belong to a ticketing connection and the project's own shows,
-- upsert per day and class, and total with NULL-aware gross.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

select pg_temp.as_user('bob');
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'ticketing_csv', 'Box Office Exports') returning id) insert into world select 'csv', id from c;
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'slack', 'Slack') returning id) insert into world select 'slack', id from c;
select app.transition_integration_connection(pg_temp.id('csv'), 'Pending', 'Connected', 'Ready for exports.');
insert into world values ('run', app.enqueue_integration_sync(pg_temp.id('csv'), 'Attendance Import', 'Inbound', 'box-office-2027-06-05', pg_temp.id('prj_a'), 3::smallint, null, null, 'imports/box-office.csv'));

-- Runner import -------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select throws_ok($$select app.record_attendance((select id from world where key = 'run'), '[]')$$,
  'XR001', 'integration_sync_not_running: Attendance is recorded only while the run is Running.', 'attendance is recorded only while the run is Running');
select app.claim_integration_sync(pg_temp.id('run'));
select is(app.record_attendance(pg_temp.id('run'), jsonb_build_array(
  jsonb_build_object('scope_node_id', pg_temp.id('show_a'), 'counted_on', '2027-06-05', 'ticket_class', 'General Admission', 'tickets_sold', 1800, 'tickets_scanned', 1650, 'comps', 40, 'gross_minor', 8100000, 'currency_code', 'USD'),
  jsonb_build_object('scope_node_id', pg_temp.id('show_a'), 'counted_on', '2027-06-05', 'ticket_class', 'VIP', 'tickets_sold', 200, 'gross_minor', null))),
  2, 'the runner records two rows for the run''s project');
select is((select count(*)::int from app.attendance_counts where project_id = pg_temp.id('prj_a')), 2, 'rows take the run''s project');
select is(app.record_attendance(pg_temp.id('run'), jsonb_build_array(
  jsonb_build_object('scope_node_id', pg_temp.id('show_a'), 'counted_on', '2027-06-05', 'ticket_class', 'VIP', 'tickets_sold', 210, 'gross_minor', 2100000, 'currency_code', 'USD'))),
  1, 'a newer figure for the same day and class');
select is((select count(*)::int from app.attendance_counts), 2, 'replaces the older one');
select is((select tickets_sold from app.attendance_counts where ticket_class = 'VIP'), 210, 'with the new figure');
select throws_ok($$select app.record_attendance((select id from world where key = 'run'), jsonb_build_array(jsonb_build_object('project_id', (select id from world where key = 'prj_b'), 'counted_on', '2027-06-05', 'ticket_class', 'GA', 'tickets_sold', 1)))$$,
  'XR001', 'attendance_project_unknown: An attendance row names a project this org does not have.', 'a row cannot name another org''s project');
select throws_ok($$select app.record_attendance((select id from world where key = 'run'), jsonb_build_array(jsonb_build_object('scope_node_id', (select id from world where key = 'root_a2'), 'counted_on', '2027-06-05', 'ticket_class', 'GA', 'tickets_sold', 1)))$$,
  'XR001', 'same_project: attendance_counts.scope_node_id points to a row of another project.', 'a show of another project is refused');
select throws_ok($$select app.record_attendance((select id from world where key = 'run'), jsonb_build_array(jsonb_build_object('counted_on', '2027-06-05', 'ticket_class', 'GA', 'tickets_sold', -1)))$$,
  '23514', null, 'counts are never negative');
select throws_ok($$select app.record_attendance((select id from world where key = 'run'), jsonb_build_array(jsonb_build_object('counted_on', '2027-06-05', 'ticket_class', 'GA', 'tickets_sold', 1, 'gross_minor', 500)))$$,
  '23514', null, 'a gross needs its currency');
select throws_ok($$select app.record_attendance((select id from world where key = 'run'), '{"rows": []}')$$,
  'XR001', 'attendance_rows_malformed: Attendance rows arrive as a list.', 'rows arrive as a list');
select pg_temp.as_user('bob');
select throws_ok($$select app.record_attendance((select id from world where key = 'run'), '[]')$$, '42501', null, 'signed-in callers cannot run imports');

-- Totals ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select tickets_sold from app.project_attendance_totals where project_id = pg_temp.id('prj_a')), 2010::bigint, 'sold totals across classes');
select is((select gross_minor from app.project_attendance_totals where project_id = pg_temp.id('prj_a')), 10200000::bigint, 'gross totals when every row is priced');
select is((select scans_unreported_count::int from app.project_attendance_totals where project_id = pg_temp.id('prj_a')), 1, 'unreported scans are counted, not zeroed');
update app.attendance_counts set gross_minor = null, currency_code = null where ticket_class = 'VIP';
select is((select gross_minor from app.project_attendance_totals where project_id = pg_temp.id('prj_a')), null::bigint, 'an unpriced row makes the gross NULL, never zero');
select is((select unpriced_count::int from app.project_attendance_totals where project_id = pg_temp.id('prj_a')), 1, 'with the unpriced count beside it');

-- Access ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::int from app.attendance_counts), 2, 'a project member reads attendance');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.attendance_counts), 0, 'a Viewer outside the project reads none (invariant 2)');
select is((select count(*)::int from app.project_attendance_totals), 0, 'nor the totals');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.attendance_counts), 0, 'another org reads none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.attendance_counts', '42501', null, 'anon cannot read attendance');
select pg_temp.as_user('alice');
select lives_ok($$update app.attendance_counts set comps = 45 where ticket_class = 'General Admission'$$, 'the Owner corrects a figure by hand');
select lives_ok($$insert into app.attendance_counts (project_id, integration_connection_id, counted_on, ticket_class, tickets_sold) values ((select id from world where key = 'prj_a'), (select id from world where key = 'csv'), '2027-06-06', 'General Admission', 1500)$$,
  'and enters a missing day');
select throws_ok($$insert into app.attendance_counts (project_id, integration_connection_id, counted_on, ticket_class, tickets_sold) values ((select id from world where key = 'prj_a'), (select id from world where key = 'slack'), '2027-06-07', 'GA', 1)$$,
  'XR001', 'integration_category_mismatch: attendance_counts rows belong to a Ticketing connection, not a Communication connection.', 'attendance comes only from ticketing connections');
select pg_temp.as_user('gina');
select throws_ok($$insert into app.attendance_counts (project_id, integration_connection_id, counted_on, ticket_class, tickets_sold) values ((select id from world where key = 'prj_a'), (select id from world where key = 'csv'), '2027-06-07', 'GA', 1)$$,
  '42501', null, 'a Viewer cannot enter attendance');

select * from finish();
rollback;
