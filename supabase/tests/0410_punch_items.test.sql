-- pgTAP: punch list items (0410). Same-tenant allow, cross-tenant deny, anon deny, role bands,
-- the Task-of-subtype-Execute rule, "Correct <what>" titles, same-project references, record
-- immutability, idempotency per inspection result and the punch_item.created event.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(20);

-- Creation through the RPC ------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into world select 'p1', app.create_punch_item(pg_temp.id('prj_a'), 'the handrail at stair 2 is loose.', null, null, null, 'Stair 2 landing');
select is((select r.title from app.punch_items p join app.records r on r.id = p.record_id where p.id = pg_temp.id('p1')),
  'Correct the handrail at stair 2 is loose', 'the Task is titled Correct <what> without closing punctuation');
select is((select r.record_kind || ' ' || r.record_subtype from app.punch_items p join app.records r on r.id = p.record_id where p.id = pg_temp.id('p1')),
  'Task Execute', 'a punch item is a Task record of subtype Execute');
select is((select r.record_state from app.punch_items p join app.records r on r.id = p.record_id where p.id = pg_temp.id('p1')),
  'Proposed', 'its record starts Proposed');
select is((select location_text from app.punch_items where id = pg_temp.id('p1')), 'Stair 2 landing', 'the written location is kept');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'punch_item.created' and subject_id = pg_temp.id('p1')),
  1, 'creating a punch item emits punch_item.created');
select is((select project_id from app.domain_events where event_type = 'punch_item.created' and subject_id = pg_temp.id('p1')),
  pg_temp.id('prj_a'), 'the event carries the item''s project');
select pg_temp.as_user('dave');
select throws_ok($$select app.create_punch_item((select id from world where key = 'prj_a'), '   ')$$,
  'XR001', null, 'a punch item says what must be corrected');

-- Visibility and role bands --------------------------------------------------------------------------------
select is((select count(*)::int from app.punch_items where id = pg_temp.id('p1')), 1, 'a project member reads the punch item');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.punch_items where id = pg_temp.id('p1')), 1, 'a Field project member reads it');
select pg_temp.as_user('gina');
select throws_ok($$select app.create_punch_item((select id from world where key = 'prj_a'), 'the exit sign is dark')$$,
  '42501', null, 'a Viewer cannot raise a punch item');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.punch_items), 0, 'another org reads no punch items');
select throws_ok($$select app.create_punch_item((select id from world where key = 'prj_a'), 'the exit sign is dark')$$,
  '42501', null, 'another org cannot raise a punch item on the project');
select pg_temp.as_anon();
select throws_ok($$select count(*) from app.punch_items$$, '42501', null, 'anon cannot read punch items');
select pg_temp.as_platform();

-- Guards ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Verify', 'Verify the handrail', 'Y', 'Declared') returning id) insert into world select 'plain', id from x;
select throws_ok($$insert into app.punch_items (record_id) values ((select id from world where key = 'plain'))$$,
  'XR001', null, 'only a Task of subtype Execute carries a punch item');
select pg_temp.as_user('carol');
with x as (insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a2'), 'Inspection', 'Safety', 'Gala Fire Walk', 'Y', 'Declared') returning id) insert into world select 'gala_inspection', id from x;
select throws_ok($$select app.create_punch_item((select id from world where key = 'prj_a'), 'the extinguisher is missing', (select id from world where key = 'gala_inspection'))$$,
  'XR001', null, 'the source record belongs to the item''s project');
select pg_temp.as_user('dave');
select throws_ok($$update app.punch_items set record_id = (select id from world where key = 'plain') where id = (select id from world where key = 'p1')$$,
  'XR001', null, 'a punch item stays on its record');
select lives_ok($$update app.punch_items set location_text = 'Stair 2 upper landing' where id = (select id from world where key = 'p1')$$,
  'a project member edits where the item is');

-- From a failed inspection result (A09, journey 17) ------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.inspection_templates (org_id, name) values (pg_temp.id('org_a'), 'Egress Walk') returning id) insert into world select 'tmpl', id from x;
with x as (insert into app.inspection_items (inspection_template_id, position, prompt) values (pg_temp.id('tmpl'), 1, 'Exit signs lit?') returning id) insert into world select 'item', id from x;
select pg_temp.as_user('dave');
with x as (insert into app.inspections (project_id, inspection_template_id) values (pg_temp.id('prj_a'), pg_temp.id('tmpl')) returning id) insert into world select 'insp', id from x;
with x as (insert into app.inspection_results (inspection_id, inspection_item_id, result_enum_id) values (pg_temp.id('insp'), pg_temp.id('item'), 'ENM-084') returning id) insert into world select 'result', id from x;
select pg_temp.as_platform();
insert into world select 'p2', private.insert_punch_item(pg_temp.id('prj_a'), 'Exit signs lit?', null, pg_temp.id('result'));
select is((select r.title from app.punch_items p join app.records r on r.id = p.record_id where p.id = pg_temp.id('p2')),
  'Correct Exit signs lit', 'a failed result becomes "Correct <item prompt>"');
select is(private.insert_punch_item(pg_temp.id('prj_a'), 'Exit signs lit?', null, pg_temp.id('result')), pg_temp.id('p2'),
  'a second call for the same result returns the existing item');
select is((select count(*)::int from app.punch_items where inspection_result_id = pg_temp.id('result')), 1,
  'one punch item per inspection result');

select * from finish();
rollback;
