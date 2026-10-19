-- pgTAP: Playbook field homes (A51, RRR-96, finding A47-001). Every Playbook `field` target in the seeded column
-- map names a real column, except the entries blocked on an owner ruling; the new homes keep their shape rules,
-- and cue calls follow their cue's project under RLS, with same-tenant allow, cross-tenant deny and anon deny.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(18);

-- Gate 14 against the database: xpms.playbook_column joined to the catalog.
select is((
  select count(*)::int from xpms.playbook_column pc
  where pc.disposition = 'field'
    and not exists (
      select 1 from information_schema.columns c
      where c.table_schema || '.' || c.table_name || '.' || c.column_name = pc.target)
    and pc.note not like 'Blocked on owner (RRR-64):%'), 0,
  'every Playbook field target is a real column unless it is blocked on an owner ruling');
select is((
  select count(*)::int from xpms.playbook_column pc
  where pc.disposition = 'field' and pc.note like 'Blocked on owner (RRR-64):%'), 0,
  'no Playbook column waits on the owner: decision 25 settled the eighteen (A56, RRR-101)');
select is((
  select count(*)::int from xpms.playbook_column pc
  where pc.target = 'xpms.production_template_values.value_text'
    and pc.sheet_name <> 'Cover Page' and pc.note not like 'Template only: %'), 0,
  'every template-only column states why');

-- Show: a running order on a schedule record, a cue with its segment, space and department calls.
select pg_temp.as_user('dave');
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, wbs_code, description)
  values (pg_temp.id('prj_a'), 'Event', 'Opening Night', 'Z', 'Declared', '7.1', 'The first show of the series.') returning id)
insert into world select 'event', id from x;
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, parent_record_id, wbs_code)
  values (pg_temp.id('prj_a'), 'Task', 'Hang the banners', 'Y', 'Declared', pg_temp.id('event'), '7.1.1') returning id)
insert into world select 'task', id from x;
select is((select parent_record_id from app.records where id = pg_temp.id('task')), pg_temp.id('event'),
  'a task rolls up to its summary record');
select throws_ok($$insert into app.records (project_id, record_kind, title, xyz, xyz_basis, wbs_code)
  values ((select id from world where key = 'prj_a'), 'Task', 'Hang the banners', 'Y', 'Declared', '7.a')$$,
  '23514', null, 'a WBS code is dot-separated numbers');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date, record_id)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night Running Order', '2027-06-05', pg_temp.id('event')) returning id)
insert into world select 'ros', id from x;
with x as (insert into app.cues (run_of_show_id, position, label, segment, description)
  values (pg_temp.id('ros'), 1, 'Doors Open', 'Act I · Ingress', 'Front of house doors open.') returning id)
insert into world select 'cue', id from x;
insert into app.cue_calls (cue_id, call_kind, instruction) values
  (pg_temp.id('cue'), 'Audio', 'Ambient music at 72 dBA.'),
  (pg_temp.id('cue'), 'Lighting', 'Warm architectural wash.');
select is((select count(*)::int from app.cue_calls where cue_id = pg_temp.id('cue')), 2, 'a cue carries one call per department');
select is((select org_id from app.cue_calls limit 1), pg_temp.id('org_a'), 'a cue call takes its org from the cue');
select throws_ok($$insert into app.cue_calls (cue_id, call_kind, instruction) values ((select id from world where key = 'cue'), 'Audio', 'Again.')$$,
  '23505', null, 'a department is called once per cue');

-- Logistics, procurement and project shape rules.
select throws_ok($$update app.projects set budget_envelope_minor = -1 where id = (select id from world where key = 'prj_a')$$,
  '23514', null, 'a budget envelope is never negative');
select pg_temp.as_platform();
select throws_ok($$update app.shifts set scheduled_break_minutes = 2000$$, '23514', null, 'a scheduled break fits in a day');
select throws_ok($$insert into app.shipments (org_id, project_id, direction, pallet_count) values
  ((select id from world where key = 'org_a'), (select id from world where key = 'prj_a'), 'Inbound', -1)$$,
  '23514', null, 'a shipment never has negative pallets');
select lives_ok($$insert into app.shipments (org_id, project_id, direction, urid, pallet_count, weight_lb, seal_identifier)
  values ((select id from world where key = 'org_a'), (select id from world where key = 'prj_a'), 'Inbound', '5000.52.01', 26, 45000, 'SL-990142')$$,
  'a shipment records its URID, pallets, weight and seal');
select throws_ok($$insert into app.shipments (org_id, project_id, direction, urid) values
  ((select id from world where key = 'org_a'), (select id from world where key = 'prj_a'), 'Inbound', '9999.99.99')$$,
  '23503', null, 'a shipment URID is a canon category');

-- Tenancy: references into another org or project are refused.
select pg_temp.as_platform();
select throws_ok($$insert into app.records (project_id, record_kind, title, xyz, xyz_basis, parent_record_id)
  values ((select id from world where key = 'prj_a2'), 'Task', 'Hang the banners', 'Y', 'Declared', (select id from world where key = 'event'))$$,
  'XR001', null, 'a parent record in another project is refused');
select throws_ok($$insert into app.run_of_show (project_id, name, show_date, record_id)
  values ((select id from world where key = 'prj_b'), 'Pier Night', '2027-06-05', (select id from world where key = 'event'))$$,
  'XR001', null, 'a running order cannot point at another org''s record');

select pg_temp.as_user('xavier');
select is((select count(*)::int from app.cue_calls), 0, 'another org reads none of the cue calls');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.cue_calls), 2, 'a Field project member reads the cue calls');

set local role anon;
set local request.jwt.claims = '';
select throws_ok('select 1 from app.cue_calls', '42501', null, 'anon cannot read cue calls');

select * from finish();
rollback;
