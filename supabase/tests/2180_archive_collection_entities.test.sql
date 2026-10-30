-- pgTAP: archive and unarchive (A124, RRR-169; Section 4.10). app.archive_row and app.unarchive_row set and clear
-- archived_at on records (a punch item through its Task record), work orders, custom object records, vendors, venues
-- and documents, only with the capability that edits the row, and write one audit event each way. The columns change
-- through nothing else. Global search and recent items leave archived records and documents out; is:archived finds
-- only them, and an exact key finds an archived record either way; unarchiving brings them back. Venues archive
-- through archived_at now, with their venue events.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(52);

create function pg_temp.search(p_query jsonb) returns setof uuid
language sql as $$ select s.result_id from app.global_search(pg_temp.id('org_a'), p_query) s $$;

create function pg_temp.audits(p_action text, p_id uuid) returns integer
language sql as $$ select count(*)::int from app.audit_events where action = p_action and subject_id = p_id $$;

-- World: one row of each archivable table in org_a.
select pg_temp.as_user('dave');
with x as (insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Execute', 'Install the zephyr truss', 'Y', 'Declared') returning id)
  insert into world select 'rec', id from x;
insert into world select 'punch', app.create_punch_item(pg_temp.id('prj_a'), 'the handrail at stair 2 is loose.', null, null, null, 'Stair 2 landing');
insert into world select 'punch_rec', record_id from app.punch_items where id = pg_temp.id('punch');
with x as (insert into app.work_orders (project_id, title) values (pg_temp.id('prj_a'), 'Rig the Zephyr Stage Truss') returning id)
  insert into world select 'wo', id from x;
with x as (insert into app.documents (org_id, project_id, title) values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Zephyr Rigging Plan') returning id)
  insert into world select 'doc', id from x;
select app.record_recent_view(pg_temp.id('org_a'), 'records', pg_temp.id('rec'));
select app.record_recent_view(pg_temp.id('org_a'), 'documents', pg_temp.id('doc'));
select pg_temp.as_user('carol');
insert into world values ('cp', app.create_counterparty(pg_temp.id('org_a'), 'Zephyr Staging', 'Equipment Rental'));
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp')) returning id) insert into world select 'vendor', id from x;
select pg_temp.as_user('alice');
with x as (insert into app.venues (org_id, name, jurisdiction_id, time_zone)
  values (pg_temp.id('org_a'), 'Zephyr Hall', 'US-FL-MIAMI-DADE', 'America/New_York') returning id)
  insert into world select 'venue', id from x;
-- gina, a Viewer, joins the project: she reads its records and edits none.
insert into app.project_members (project_id, membership_id, project_role) values (pg_temp.id('prj_a'), pg_temp.id('gina@org_a'), 'Field');
select pg_temp.as_user('bob');
with x as (insert into app.custom_object_types (org_id, object_key, label, icon) values (pg_temp.id('org_a'), 'sponsors', 'Sponsors', 'handshake') returning id)
  insert into world select 'type', id from x;
select pg_temp.as_user('dave');
with x as (insert into app.custom_object_records (custom_object_type_id, title) values (pg_temp.id('type'), 'Zephyr Beverages') returning id)
  insert into world select 'obj', id from x;

-- Before archiving: search and recent items find the record and the document.
select ok(pg_temp.id('rec') in (select pg_temp.search('{"terms":["zephyr"]}')), 'search finds a live record');
select ok(pg_temp.id('doc') in (select pg_temp.search('{"terms":["zephyr"]}')), 'and a live document');
select is((select count(*)::int from app.recent_items(pg_temp.id('org_a')) where result_id in (pg_temp.id('rec'), pg_temp.id('doc'))), 2,
  'recent items list the record and the document dave opened');

-- Refusals ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$select app.archive_row('records', (select id from world where key = 'rec'))$$,
  '42501', null, 'a Viewer on the project reads the record but cannot archive it');
select throws_ok($$select app.archive_row('custom_object_records', (select id from world where key = 'obj'))$$,
  '42501', null, 'nor a custom object record');
select throws_ok($$select app.archive_row('venues', (select id from world where key = 'venue'))$$,
  '42501', null, 'nor a venue without places.venue.write');
select pg_temp.as_user('mia');
select throws_ok($$select app.archive_row('records', (select id from world where key = 'rec'))$$,
  'XR001', 'archive_row_not_found: This row no longer exists or is not available to you.', 'someone outside the project cannot archive a record they cannot read');
select pg_temp.as_user('dave');
select throws_ok($$select app.archive_row('vendors', (select id from world where key = 'vendor'))$$,
  '42501', null, 'a Member without vendors.vendor.write cannot archive a vendor');
select throws_ok($$select app.archive_row('projects', (select id from world where key = 'prj_a'))$$,
  'XR001', null, 'only the archivable tables are archived here');
select throws_ok($$update app.records set archived_at = clock_timestamp() where id = (select id from world where key = 'rec')$$,
  'XR001', 'archive_rpc_only: A row is archived and unarchived only through app.archive_row and app.unarchive_row.',
  'archived_at never changes outside the RPC, even for someone who edits the row');
select throws_ok($$insert into app.work_orders (project_id, title, archived_at) values ((select id from world where key = 'prj_a'), 'Paint the Fence', now())$$,
  'XR001', 'archive_rpc_only: A row is created live; archive it with app.archive_row.', 'a row is created live');
select pg_temp.as_user('xavier');
select throws_ok($$select app.archive_row('records', (select id from world where key = 'rec'))$$,
  'XR001', null, 'another org cannot archive the record');
select pg_temp.as_anon();
select throws_ok($$select app.archive_row('records', (select id from world where key = 'rec'))$$,
  '42501', null, 'anon cannot call archive_row');

-- Archiving ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select isnt(app.archive_row('records', pg_temp.id('rec')), null, 'a project member who edits records archives one');
select is((select archived_by from app.records where id = pg_temp.id('rec')), pg_temp.id('dave'), 'the record names who archived it');
select is((select count(*)::int from app.records where id = pg_temp.id('rec')), 1, 'an archived record stays readable');
select is(app.archive_row('records', pg_temp.id('rec')), (select archived_at from app.records where id = pg_temp.id('rec')),
  'archiving it again leaves it unchanged');
select isnt(app.archive_row('punch_items', pg_temp.id('punch')), null, 'a punch item is archived');
select isnt((select archived_at from app.records where id = pg_temp.id('punch_rec')), null, 'through its Task record');
select isnt(app.archive_row('work_orders', pg_temp.id('wo')), null, 'a work order is archived');
select isnt(app.archive_row('documents', pg_temp.id('doc')), null, 'a document is archived');
select isnt(app.archive_row('custom_object_records', pg_temp.id('obj')), null, 'a custom object record is archived');
select pg_temp.as_user('carol');
select isnt(app.archive_row('vendors', pg_temp.id('vendor')), null, 'a Manager archives a vendor');
select pg_temp.as_user('alice');
select isnt(app.archive_row('venues', pg_temp.id('venue')), null, 'an Owner archives a venue');

select pg_temp.as_platform();
select is(pg_temp.audits('records.archived', pg_temp.id('rec')), 1, 'archiving writes one records.archived audit event, not one per call');
select is(pg_temp.audits('records.archived', pg_temp.id('punch_rec')), 1, 'the punch item''s record is audited as a record');
select is(pg_temp.audits('vendors.archived', pg_temp.id('vendor')), 1, 'the vendor''s archive is audited');
select is((select count(*)::int from app.domain_events where subject_id in (pg_temp.id('rec'), pg_temp.id('wo'), pg_temp.id('doc'), pg_temp.id('vendor'), pg_temp.id('obj'))
  and event_type like '%archiv%'), 0, 'archiving adds no domain event kind');
select is((select count(*)::int from app.domain_events where event_type = 'venue.archived' and subject_id = pg_temp.id('venue')), 1,
  'a venue still emits venue.archived, now from archived_at');

-- Search leaves archived rows out --------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select ok(pg_temp.id('rec') not in (select pg_temp.search('{"terms":["zephyr"]}')), 'search leaves an archived record out');
select ok(pg_temp.id('doc') not in (select pg_temp.search('{"terms":["zephyr"]}')), 'and an archived document');
select ok(pg_temp.id('rec') not in (select pg_temp.search('{"types":["record"]}')), 'a filter-only search leaves it out too');
select ok(pg_temp.id('rec') in (select pg_temp.search('{"terms":["zephyr"],"is":["archived"]}')), 'is:archived finds the archived record');
select ok(pg_temp.id('doc') in (select pg_temp.search('{"terms":["zephyr"],"is":["archived"]}')), 'and the archived document');
select ok(pg_temp.id('rec') in (select pg_temp.search('{"is":["archived"]}')), 'is:archived alone lists archived records');
select ok(pg_temp.id('rec') in (select pg_temp.search(jsonb_build_object('terms', jsonb_build_array(
    (select p.project_key || '-' || r.record_number from app.records r join app.projects p on p.id = r.project_id where r.id = pg_temp.id('rec')))))),
  'an exact key finds the archived record without is:archived, as its link opens it');
select is((select count(*)::int from app.recent_items(pg_temp.id('org_a')) where result_id in (pg_temp.id('rec'), pg_temp.id('doc'))), 0,
  'recent items leave archived rows out');

-- Unarchiving --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$select app.unarchive_row('records', (select id from world where key = 'rec'))$$,
  '42501', null, 'unarchiving needs the same capability');
select pg_temp.as_user('dave');
select is(app.unarchive_row('records', pg_temp.id('rec')), null, 'a project member unarchives the record');
select is((select archived_at::text || archived_by::text from app.records where id = pg_temp.id('rec')), null, 'it is live again and names no archiver');
select ok(pg_temp.id('rec') in (select pg_temp.search('{"terms":["zephyr"]}')), 'search finds it again');
select ok(pg_temp.id('rec') not in (select pg_temp.search(jsonb_build_object('terms', jsonb_build_array(
    (select p.project_key || '-' || r.record_number from app.records r join app.projects p on p.id = r.project_id where r.id = pg_temp.id('rec'))),
    'is', jsonb_build_array('archived')))),
  'and is:archived leaves the live record out even by its exact key');
select is(app.unarchive_row('documents', pg_temp.id('doc')), null, 'the document is unarchived');
select ok(pg_temp.id('doc') in (select pg_temp.search('{"terms":["zephyr"]}')), 'and found again');
select is((select count(*)::int from app.recent_items(pg_temp.id('org_a')) where result_id in (pg_temp.id('rec'), pg_temp.id('doc'))), 2,
  'recent items list them again');
select pg_temp.as_platform();
select is(pg_temp.audits('records.unarchived', pg_temp.id('rec')), 1, 'unarchiving writes a records.unarchived audit event');

-- Venues ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select lives_ok($$insert into app.venues (org_id, name, jurisdiction_id, time_zone) values ((select id from world where key = 'org_a'), 'Zephyr Hall', 'US-FL-MIAMI-DADE', 'America/New_York')$$,
  'an archived venue''s name is free for a new venue');
select pg_temp.as_platform();
select ok(pg_temp.id('venue') not in (select candidate_id from private.fuzzy_candidates(pg_temp.id('org_a'), 'venues', 'Zephyr Hall')),
  'import duplicate review leaves the archived venue out (2182)');
select is((select count(*)::int from private.fuzzy_candidates(pg_temp.id('org_a'), 'venues', 'Zephyr Hall')), 1,
  'and offers only the live venue of that name');
select pg_temp.as_user('alice');
select throws_ok($$select app.unarchive_row('venues', (select id from world where key = 'venue'))$$,
  'XR001', 'archive_name_taken: A live venue already has this name; rename one of them first.', 'so the archived one is unarchived only after a rename');
update app.venues set name = 'Zephyr Hall Annex' where id = pg_temp.id('venue');
select is(app.unarchive_row('venues', pg_temp.id('venue')), null, 'after a rename it is unarchived');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'venue.restored' and subject_id = pg_temp.id('venue')), 1,
  'and emits venue.restored');

select * from finish();
rollback;
