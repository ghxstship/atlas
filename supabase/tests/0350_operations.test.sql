-- pgTAP: schedule, show, places, requirements and capability, advancing, logistics and hospitality
-- (Section 7.4). Same-tenant allow, cross-tenant deny, anon deny, invariant 2 on project tables and
-- their children, role bands, and each domain rule: locked baselines, called cues, frozen capability
-- documents, geofences, reconciliation joins and critical Unknown gaps, dock slot overlap, gate
-- release authority, BEO approval separation, canon enumerations and append-only logs.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(38);

-- Schedule and invariant 2 ----------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.calendars (project_id, name, time_zone) values (pg_temp.id('prj_a'), 'Show Calendar', 'America/New_York') returning id) insert into world select 'cal', id from x;
select throws_ok($$insert into app.calendars (project_id, name, time_zone) values ((select id from world where key = 'prj_a2'), 'Other', 'UTC')$$, '42501', null, 'a Member writes only on their project');
insert into app.calendar_exceptions (calendar_id, day, is_working, note) values (pg_temp.id('cal'), '2027-07-04', false, 'Holiday.');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.calendars), 0, 'a Viewer outside the project reads no calendars (invariant 2)');
select is((select count(*)::int from app.calendar_exceptions), 0, 'nor their child rows');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.calendars where org_id = pg_temp.id('org_a')), 0, 'another org reads no calendars');
select pg_temp.as_anon();
select throws_ok('select 1 from app.cues', '42501', null, 'anon cannot read cues');
select throws_ok('select 1 from app.geofences', '42501', null, 'anon cannot read geofences');
select pg_temp.as_platform();

select pg_temp.as_user('dave');
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values (pg_temp.id('prj_a'), 'Task', 'Hang the banners', 'Y', 'Declared') returning id) insert into world select 'task', id from x;
select pg_temp.as_user('carol');
with x as (insert into app.schedule_baselines (project_id, name) values (pg_temp.id('prj_a'), 'Gate 3 Baseline') returning id) insert into world select 'bl', id from x;
insert into app.schedule_baseline_items (schedule_baseline_id, record_id, planned_starts_at) values (pg_temp.id('bl'), pg_temp.id('task'), '2027-06-01 08:00+00');
update app.schedule_baselines set locked_at = now() where id = pg_temp.id('bl');
select throws_ok($$update app.schedule_baseline_items set planned_starts_at = '2027-06-02 08:00+00' where schedule_baseline_id = (select id from world where key = 'bl')$$,
  'XR001', 'baseline_locked: A locked baseline never changes.', 'a locked baseline never changes');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.schedule_baselines (project_id, name) values ((select id from world where key = 'prj_a'), 'Mine')$$, '42501', null, 'a Member cannot write baselines');
select lives_ok($$insert into app.schedule_actuals (record_id, actual_starts_at) values ((select id from world where key = 'task'), '2027-06-01 08:15+00')$$, 'a Member records an actual start on an assigned project');
select pg_temp.as_platform();

-- Show --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date) values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night Running Order', '2027-06-05') returning id) insert into world select 'ros', id from x;
select throws_ok($$insert into app.run_of_show (project_id, scope_node_id, name, show_date) values ((select id from world where key = 'prj_a'), (select id from world where key = 'root_a2'), 'Wrong', '2027-06-05')$$,
  'XR001', null, 'a running order''s scope node belongs to its project');
with x as (insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros'), 1, 'House to Half') returning id) insert into world select 'cue', id from x;
update app.cues set called_at = '2000-01-01' where id = pg_temp.id('cue');
select is((select called_by from app.cues where id = pg_temp.id('cue')), pg_temp.id('dave'), 'a called cue is stamped with the caller');
select ok((select called_at > '2020-01-01' from app.cues where id = pg_temp.id('cue')), 'and the database time, not the caller''s');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.cues), 1, 'a Field project member reads the cues');
select pg_temp.as_platform();

-- Places --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.spaces (venue_id, name, capacity) values (pg_temp.id('venue_a'), 'Main Deck', 1200) returning id) insert into world select 'space', id from x;
with x as (insert into app.zones (venue_id, space_id, code, name) values (pg_temp.id('venue_a'), pg_temp.id('space'), 'DOCK-1', 'Loading Dock') returning id) insert into world select 'dock', id from x;
select is((select org_id from app.zones where id = pg_temp.id('dock')), pg_temp.id('org_a'), 'a zone''s org is derived from its venue');
with x as (insert into app.capability_documents (venue_id, title, document_uri, valid_from, is_frozen) values (pg_temp.id('venue_a'), 'Rigging Plot', 'docs/rigging.pdf', '2027-01-01', true) returning id) insert into world select 'capdoc', id from x;
select throws_ok($$update app.capability_documents set valid_to = '2027-12-31' where id = (select id from world where key = 'capdoc')$$,
  'XR001', 'capability_document_frozen: A frozen capability document never changes; add a new version.', 'a frozen capability document never changes');
with x as (insert into app.geofences (venue_id, zone_id, name, boundary) values (pg_temp.id('venue_a'), pg_temp.id('dock'), 'Dock Fence',
  'SRID=4326;POLYGON((-80.20 25.77, -80.19 25.77, -80.19 25.78, -80.20 25.78, -80.20 25.77))') returning id) insert into world select 'fence', id from x;
select is(app.point_in_geofence(pg_temp.id('fence'), -80.195, 25.775), true, 'a point inside the geofence is covered');
select is(app.point_in_geofence(pg_temp.id('fence'), -80.10, 25.775), false, 'a point outside is not');
select pg_temp.as_user('xavier');
select is(app.point_in_geofence(pg_temp.id('fence'), -80.195, 25.775), null, 'another org cannot probe the geofence');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.zones), 1, 'a Viewer reads the org''s venue zones (places.venue.read org-wide)');
select throws_ok($$insert into app.zones (venue_id, code, name) values ((select id from world where key = 'venue_a'), 'GATE-9', 'Gate')$$, '42501', null, 'a Viewer cannot write zones');
select pg_temp.as_platform();

-- Requirements and capability --------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.capability_statements (project_id, direction, urid, description, is_critical) values (pg_temp.id('prj_a'), 'Require', '0000.01.01', 'Full venue for 1,200.', true) returning id)
  insert into world select 'req', id from x;
with x as (insert into app.capability_statements (project_id, direction, urid, description) values (pg_temp.id('prj_a'), 'Require', '0000.02.01', 'Second need.') returning id)
  insert into world select 'req2', id from x;
with x as (insert into app.capability_statements (project_id, direction, urid, description, venue_id, assertion_word) values (pg_temp.id('prj_a'), 'Provide', '0000.01.01', 'Pavilion seats 1,200.', pg_temp.id('venue_a'), 'DOCUMENTED') returning id)
  insert into world select 'cap', id from x;
select throws_ok($$insert into app.capability_statements (project_id, direction, urid, description) values ((select id from world where key = 'prj_a'), 'Provide', '0000.01.01', 'Nobody.')$$,
  '23514', null, 'a capability names its provider');
select throws_ok($$insert into app.capability_statements (project_id, direction, urid, description, venue_id, assertion_word) values ((select id from world where key = 'prj_a'), 'Provide', '0000.01.01', 'Bad word.', (select id from world where key = 'venue_a'), 'QUOTED')$$,
  '23503', null, 'a capability assertion word comes from the capability family');
select is((select count(*)::int from app.project_requirements), 2, 'requirements are the Require facet');
select is((select count(*)::int from app.project_capabilities), 1, 'capabilities are the Provide facet');
with x as (insert into app.reconciliations (project_id) values (pg_temp.id('prj_a')) returning id) insert into world select 'rec', id from x;
select throws_ok($$insert into app.reconciliation_lines (reconciliation_id, requirement_id, result) values ((select id from world where key = 'rec'), (select id from world where key = 'req'), 'Met')$$,
  '23514', null, 'Met names the capability that meets it');
select throws_ok($$insert into app.reconciliation_lines (reconciliation_id, requirement_id, capability_id, result) values ((select id from world where key = 'rec'), (select id from world where key = 'req2'), (select id from world where key = 'cap'), 'Met')$$,
  'XR001', null, 'a capability meets only a requirement for the same URID');
insert into app.reconciliation_lines (reconciliation_id, requirement_id, result) values (pg_temp.id('rec'), pg_temp.id('req'), 'Unknown'), (pg_temp.id('rec'), pg_temp.id('req2'), 'Unknown');
select is((select count(*)::int from app.reconciliation_gaps where reconciliation_id = pg_temp.id('rec')), 1, 'an Unknown against a critical requirement is a gap; against a non-critical one it is not');
select pg_temp.as_platform();

-- Advancing --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.advance_packets (project_id, title) values (pg_temp.id('prj_a'), 'Artist Advance') returning id) insert into world select 'pkt', id from x;
select throws_ok($$insert into app.advance_recipients (advance_packet_id) values ((select id from world where key = 'pkt'))$$, '23514', null, 'an advance recipient is a person or a counterparty');
select lives_ok($$insert into app.advance_recipients (advance_packet_id, person_id) values ((select id from world where key = 'pkt'), (select id from world where key = 'mia'))$$, 'a person is a recipient');
select pg_temp.as_platform();

-- Logistics ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$insert into app.shipments (project_id, direction, freight_type_enum_id) values ((select id from world where key = 'prj_a'), 'Inbound', 'ENM-082')$$,
  'XR001', null, 'a freight type comes from the Freight Type enumeration');
insert into app.shipments (project_id, direction, freight_type_enum_id) values (pg_temp.id('prj_a'), 'Inbound', 'ENM-022');
insert into app.dock_slots (project_id, zone_id, starts_at, ends_at) values (pg_temp.id('prj_a'), pg_temp.id('dock'), '2027-06-01 06:00+00', '2027-06-01 08:00+00');
select throws_ok($$insert into app.dock_slots (project_id, zone_id, starts_at, ends_at) values ((select id from world where key = 'prj_a'), (select id from world where key = 'dock'), '2027-06-01 07:00+00', '2027-06-01 09:00+00')$$,
  'XR001', 'dock_slot_overlap: Slots at one dock never overlap.', 'dock slots never overlap');
with x as (insert into app.gate_queue (project_id, vehicle_identifier) values (pg_temp.id('prj_a'), 'FL-TRK-221') returning id) insert into world select 'gq', id from x;
select pg_temp.as_user('frank');
select throws_ok($$update app.gate_queue set released_at = now() where id = (select id from world where key = 'gq')$$, '42501', null, 'a Field member cannot release a vehicle');
select pg_temp.as_user('dave');
select lives_ok($$update app.gate_queue set released_at = now() where id = (select id from world where key = 'gq')$$, 'a Member with release authority on the project releases it');
insert into app.marshalling_log (project_id, entry) values (pg_temp.id('prj_a'), 'Truck staged in lane 2.');
select throws_ok($$update app.marshalling_log set entry = 'Edited.'$$, '42501', null, 'the marshalling log is append-only for signed-in callers');
select pg_temp.as_platform();
select throws_ok($$update app.marshalling_log set entry = 'Edited.'$$, 'XR001', null, 'and for the platform');

-- Hospitality -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.beos (project_id, event_at, guest_count) values (pg_temp.id('prj_a'), '2027-06-05 18:00+00', 150) returning id) insert into world select 'beo', id from x;
select throws_ok($$update app.beos set approved_at = now() where id = (select id from world where key = 'beo')$$,
  'XR001', 'sod_approval_requester: An approval is decided by an eligible approver, never the requester.', 'the BEO author cannot approve it');
select pg_temp.as_user('carol');
select lives_ok($$update app.beos set approved_at = now() where id = (select id from world where key = 'beo')$$, 'another eligible person approves the BEO');
select is((select approved_by from app.beos where id = pg_temp.id('beo')), pg_temp.id('carol'), 'the approver is stamped');
select pg_temp.as_platform();

select * from finish();
rollback;
