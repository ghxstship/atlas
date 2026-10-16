-- pgTAP: carrier tracking (Section 17: UPS, FedEx and DHL). Trackers follow the shipment's project (invariant 2), need
-- a Connected carrier connection and a tracking number, keep their shipment, carrier and number, and only the runner
-- writes status. Scans are append-only and recorded once; delivery and exceptions emit domain events.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

select pg_temp.as_user('bob');
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'ups', 'Northwind UPS') returning id) insert into world select 'ups', id from c;
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'fedex', 'Northwind FedEx') returning id) insert into world select 'fedex', id from c;
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'slack', 'Slack') returning id) insert into world select 'slack', id from c;
select app.store_integration_credential(pg_temp.id('ups'), 'fixture-key', 'API Key');
select app.transition_integration_connection(pg_temp.id('ups'), 'Pending', 'Connected', 'Authorized.');
select app.store_integration_credential(pg_temp.id('slack'), 'fixture-key', 'OAuth Token');
select app.transition_integration_connection(pg_temp.id('slack'), 'Pending', 'Connected', 'Authorized.');

select pg_temp.as_user('alice');
with s as (insert into app.shipments (project_id, direction, tracking_identifier) values (pg_temp.id('prj_a'), 'Inbound', '1Z999AA10123456784') returning id) insert into world select 'ship', id from s;
with s as (insert into app.shipments (project_id, direction) values (pg_temp.id('prj_a'), 'Outbound') returning id) insert into world select 'ship_untracked', id from s;
with s as (insert into app.shipments (project_id, direction, tracking_identifier) values (pg_temp.id('prj_a2'), 'Inbound', '1Z999AA10123456785') returning id) insert into world select 'ship_gala', id from s;

-- Trackers ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with t as (insert into app.shipment_trackers (shipment_id, integration_connection_id, tracking_status, delivered_at) values (pg_temp.id('ship'), pg_temp.id('ups'), 'Delivered', now()) returning id)
  insert into world select 'tracker', id from t;
select is((select tracking_number from app.shipment_trackers where id = pg_temp.id('tracker')), '1Z999AA10123456784', 'the tracking number comes from the shipment');
select is((select tracking_status::text from app.shipment_trackers where id = pg_temp.id('tracker')), 'Unknown', 'status sent on insert is discarded');
select is((select org_id from app.shipment_trackers where id = pg_temp.id('tracker')), pg_temp.id('org_a'), 'the org comes from the shipment');
select throws_ok($$insert into app.shipment_trackers (shipment_id, integration_connection_id) values ((select id from world where key = 'ship'), (select id from world where key = 'ups'))$$,
  '23505', null, 'one live tracker per shipment');
select throws_ok($$insert into app.shipment_trackers (shipment_id, integration_connection_id) values ((select id from world where key = 'ship_untracked'), (select id from world where key = 'ups'))$$,
  'XR001', 'tracking_number_required: Add the carrier tracking number to the shipment before tracking it.', 'a shipment without a number cannot be tracked');
select throws_ok($$insert into app.shipment_trackers (shipment_id, integration_connection_id, tracking_number) values ((select id from world where key = 'ship_untracked'), (select id from world where key = 'fedex'), '794698761234')$$,
  'XR001', 'integration_not_connected: Track shipments through a Connected carrier connection.', 'a Pending carrier tracks nothing');
select throws_ok($$insert into app.shipment_trackers (shipment_id, integration_connection_id, tracking_number) values ((select id from world where key = 'ship_untracked'), (select id from world where key = 'slack'), '794698761234')$$,
  'XR001', 'integration_category_mismatch: shipment_trackers rows belong to a Shipping connection, not a Communication connection.', 'only carrier connections track');
select throws_ok($$insert into app.shipment_trackers (shipment_id, integration_connection_id, tracking_number) values ((select id from world where key = 'ship_untracked'), (select id from world where key = 'ups'), 'not a number!')$$,
  '23514', null, 'tracking numbers are letters and digits');
select throws_ok($$update app.shipment_trackers set tracking_status = 'Delivered', delivered_at = now() where id = (select id from world where key = 'tracker')$$,
  'XR001', 'tracking_runner_only: Tracking status is written only by the carrier connection.', 'only the runner writes status');
select throws_ok($$update app.shipment_trackers set tracking_number = '1Z999AA10123456785' where id = (select id from world where key = 'tracker')$$,
  'XR001', 'shipment_tracker_fixed: A tracker keeps its shipment, carrier and number; stop it and start another.', 'a tracker keeps its number');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.shipment_trackers), 1, 'a project Member reads the tracker (logistics read on the project)');
select throws_ok($$insert into app.shipment_trackers (shipment_id, integration_connection_id) values ((select id from world where key = 'ship_gala'), (select id from world where key = 'ups'))$$,
  '42501', null, 'a Member cannot track a shipment of a project they are not on');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.shipment_trackers), 0, 'a Viewer outside the project reads none (invariant 2)');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.shipment_trackers), 0, 'another org reads none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.shipment_trackers', '42501', null, 'anon cannot read trackers');
select throws_ok('select 1 from app.shipment_tracking_events', '42501', null, 'anon cannot read scans');

-- Runner updates ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok($$select app.record_tracking_update((select id from world where key = 'tracker'), 'In Transit', 'In transit', null, null, '[]')$$, '42501', null, 'signed-in callers cannot write tracking');
select pg_temp.as_platform();
select is(app.record_tracking_update(pg_temp.id('tracker'), 'In Transit', 'Departed facility', '2027-06-03 18:00+00', null,
  '[{"status":"Label Created","code":"MP","description":"Label created","occurred_at":"2027-06-01T09:00:00Z"},{"status":"In Transit","code":"DP","description":"Departed facility","location":"Louisville, KY","occurred_at":"2027-06-02T03:00:00Z"}]'),
  2, 'the runner records two new scans');
select is((select tracking_status::text from app.shipment_trackers where id = pg_temp.id('tracker')), 'In Transit', 'and the latest status');
select is((select estimated_delivery_at from app.shipment_trackers where id = pg_temp.id('tracker')), '2027-06-03 18:00+00'::timestamptz, 'with the estimate');
select is(app.record_tracking_update(pg_temp.id('tracker'), 'In Transit', 'Departed facility', '2027-06-03 18:00+00', null,
  '[{"status":"In Transit","code":"DP","description":"Departed facility","occurred_at":"2027-06-02T03:00:00Z"}]'), 0, 'a scan already recorded is not recorded again');
select is(app.record_tracking_update(pg_temp.id('tracker'), 'Delivered', 'Delivered', null, '2027-06-03 15:12+00',
  '[{"status":"Delivered","code":"D","description":"","occurred_at":"2027-06-03T15:12:00Z"}]'), 1, 'delivery is recorded');
select is((select delivered_at from app.shipment_trackers where id = pg_temp.id('tracker')), '2027-06-03 15:12+00'::timestamptz, 'with the delivery time');
select is((select description from app.shipment_tracking_events where carrier_status_code = 'D'), 'D', 'a scan without a description keeps its code');
select is((select count(*)::int from app.domain_events where event_type = 'shipment.delivered'), 1, 'shipment.delivered is emitted once');
select app.record_tracking_update(pg_temp.id('tracker'), 'Delivered', 'Delivered', null, null, '[]');
select is((select count(*)::int from app.domain_events where event_type = 'shipment.delivered'), 1, 'and not again for the same status');
select throws_ok($$select app.record_tracking_update((select id from world where key = 'tracker'), 'Exception', 'x', null, null, '{"not":"a list"}')$$,
  'XR001', 'tracking_events_malformed: Tracking events arrive as a list.', 'events arrive as a list');
select throws_ok($$select app.record_tracking_update(gen_random_uuid(), 'Exception', 'x', null, null, '[]')$$,
  'XR001', 'shipment_tracker_unknown: The tracker does not exist or was stopped.', 'an unknown tracker is refused');
select throws_ok($$update app.shipment_tracking_events set description = 'x'$$, 'XR001', null, 'scans are append-only');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.shipment_tracking_events), 3, 'a project Member reads the scan history');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.shipment_tracking_events), 0, 'another org reads none');

-- Stopping
select pg_temp.as_user('alice');
select lives_ok($$update app.shipment_trackers set deleted_at = now() where id = (select id from world where key = 'tracker')$$, 'a logistics writer stops tracking');
select lives_ok($$insert into app.shipment_trackers (shipment_id, integration_connection_id) values ((select id from world where key = 'ship'), (select id from world where key = 'ups'))$$, 'and can start again');

select * from finish();
rollback;
