-- pgTAP: 1781, restoring from Trash skips append-only ledgers (A119, RRR-164, Section 11.7). A record and a work order,
-- each referenced by a state ledger, restore as the person who may edit them, and a child deleted with its subject
-- still comes back with it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(9);

select pg_temp.as_user('dave');
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Hang the banner', 'Y', 'Declared') returning id)
  insert into world select 't1', id from x;
with x as (insert into app.work_orders (project_id, title) values (pg_temp.id('prj_a'), 'Rig the Main Stage Truss') returning id)
  insert into world select 'wo1', id from x;
insert into world values ('p1', app.create_punch_item(pg_temp.id('prj_a'), 'Loose handrail at stair B'));
insert into world select 'p1_record', record_id from app.punch_items where id = pg_temp.id('p1');

-- A record, whose state ledger has a deleted_at column the caller may not update.
update app.records set deleted_at = now() where id = pg_temp.id('t1');
select is((select count(*)::int from app.trash_items where subject_id = pg_temp.id('t1')), 1, 'a trashed record is in Trash');
select is(app.restore_trash_item('records', pg_temp.id('t1')), 1, 'and restores without touching its state ledger');
select is((select deleted_at from app.records where id = pg_temp.id('t1')), null, 'it is live again');

-- A work order, the same with its own ledger.
update app.work_orders set deleted_at = now() where id = pg_temp.id('wo1');
select is((select count(*)::int from app.trash_items where subject_id = pg_temp.id('wo1')), 1, 'a deleted work order is in Trash');
select is(app.restore_trash_item('work_orders', pg_temp.id('wo1')), 1, 'and restores as the person who may edit it');
select is((select deleted_at from app.work_orders where id = pg_temp.id('wo1')), null, 'it is live again');

-- A child deleted with its subject (the same deleted_at) still comes back.
update app.punch_items set deleted_at = now() where id = pg_temp.id('p1');
update app.records set deleted_at = now() where id = pg_temp.id('p1_record');
select is(app.restore_trash_item('records', pg_temp.id('p1_record')), 2, 'a record restores with the punch item deleted with it');
select is((select deleted_at from app.punch_items where id = pg_temp.id('p1')), null, 'which is live again');

update app.work_orders set deleted_at = now() where id = pg_temp.id('wo1');
select pg_temp.as_user('gina');
select throws_ok(
  format($$select app.restore_trash_item('work_orders', %L)$$, (select id from world where key = 'wo1')),
  '42501', null, 'a Viewer still cannot restore what they cannot edit');

select pg_temp.as_platform();
select * from finish();
rollback;
