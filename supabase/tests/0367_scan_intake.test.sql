-- pgTAP: unresolved scans from Compass (requested by A17). Scanners on the project record them with the
-- device time; the scan never changes; it is resolved once through the RPC, to a record of the same org or
-- dismissed with a note; scan log readers and the scanner read; other orgs and anon are denied.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(19);

-- Recording ------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$with x as (insert into app.scan_intake (project_id, scanned_value, symbology, scan_mode, device_scanned_at) values ((select id from world where key = 'prj_a'), 'NWL-ASSET-00412', 'Code 128', 'Asset', now() - interval '2 hours') returning id) insert into world select 'scan1', id from x$$,
  'a scanner on the project records an unresolved scan');
select is((select scanned_by from app.scan_intake where id = pg_temp.id('scan1')), pg_temp.id('dave'), 'the scanner is the session person');
with x as (insert into app.scan_intake (project_id, scanned_value, symbology, scan_mode, device_scanned_at) values (pg_temp.id('prj_a'), 'https://unknown.example/tag', 'QR Code', 'Lookup', now()) returning id) insert into world select 'scan2', id from x;
select throws_ok($$insert into app.scan_intake (project_id, scanned_value, symbology, scan_mode, device_scanned_at) values ((select id from world where key = 'prj_a'), 'X', 'NFC', 'Lookup', now() + interval '1 day')$$,
  'XR001', null, 'a scan from the future is refused');
select throws_ok($$insert into app.scan_intake (project_id, scanned_value, symbology, scan_mode, device_scanned_at, resolution, resolved_at, resolved_by) values ((select id from world where key = 'prj_a'), 'X', 'NFC', 'Lookup', now(), 'Dismissed', now(), (select id from world where key = 'dave'))$$,
  'XR001', null, 'a scan cannot arrive already resolved');
select throws_ok($$update app.scan_intake set scanned_value = 'Edited' where id = (select id from world where key = 'scan1')$$,
  'XR001', null, 'the scan itself never changes');
select throws_ok($$update app.scan_intake set resolution = 'Dismissed', resolved_at = now(), resolved_by = (select id from world where key = 'dave'), resolution_note = 'x' where id = (select id from world where key = 'scan1')$$,
  'XR001', null, 'resolution only through the RPC');
select pg_temp.as_user('gina');
select throws_ok($$insert into app.scan_intake (project_id, scanned_value, symbology, scan_mode, device_scanned_at) values ((select id from world where key = 'prj_a'), 'X', 'NFC', 'Lookup', now())$$,
  '42501', null, 'a Viewer outside the project cannot record scans');
select is((select count(*)::int from app.scan_intake), 0, 'nor read them');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.scan_intake), 0, 'another org reads none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.scan_intake', '42501', null, 'anon cannot read scans');

-- Resolving ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('xavier');
select throws_ok($$select app.resolve_scan_intake((select id from world where key = 'scan1'), 'Dismissed', null, null, 'Not ours.')$$, '42501', null, 'another org cannot resolve the scan');
select pg_temp.as_user('carol');
select throws_ok($$select app.resolve_scan_intake((select id from world where key = 'scan1'), 'Matched', 'venues', (select id from world where key = 'venue_b'))$$,
  'XR001', null, 'a scan resolves only to a record of its own org');
select throws_ok($$select app.resolve_scan_intake((select id from world where key = 'scan1'), 'Matched', 'no_such_table', gen_random_uuid())$$,
  'XR001', null, 'and only to a tenant record that exists');
select throws_ok($$select app.resolve_scan_intake((select id from world where key = 'scan2'), 'Dismissed')$$,
  'XR001', 'scan_intake_dismiss_note: Say why the scan is dismissed.', 'a dismissal needs a note');
select lives_ok($$select app.resolve_scan_intake((select id from world where key = 'scan1'), 'Matched', 'venues', (select id from world where key = 'venue_a'), 'Tag belongs to the pavilion.')$$, 'a scan is matched to a record');
select is((select resolved_by from app.scan_intake where id = pg_temp.id('scan1')), pg_temp.id('carol'), 'the resolver is recorded');
select throws_ok($$select app.resolve_scan_intake((select id from world where key = 'scan1'), 'Dismissed', null, null, 'Again.')$$,
  'XR001', 'scan_intake_resolved: This scan was already resolved.', 'a scan is resolved once');
select lives_ok($$select app.resolve_scan_intake((select id from world where key = 'scan2'), 'Dismissed', null, null, 'Promotional sticker.')$$, 'a scan is dismissed with a note');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'scan_intake.resolved'), 2, 'each resolution emits scan_intake.resolved');

select * from finish();
rollback;
