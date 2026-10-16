-- pgTAP: Trash (Section 4.10, A33). app.trash_items is a security_invoker view over soft-deleted rows,
-- never a copy: same-tenant allow, cross-tenant deny, anon deny, role bands on restore (the table's own
-- update policy decides), rows deleted together restore together, refusals for live rows, excluded
-- tables and rows past retention, the trash.restored event, and the extended retention sweep that
-- registers new tables.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(24);

-- World -----------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD') returning id)
  insert into world select 'bud', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 1, 'Stage rental.', '0000.01.01', 1, 100000, 'X', 'Declared') returning id) insert into world select 'bl', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Old Draft Budget', 'USD') returning id)
  insert into world select 'bud_old', id from x;
select pg_temp.as_platform();

-- Registry and view -------------------------------------------------------------------------------------
select ok(exists (select 1 from private.trash_tables where table_name = 'budgets' and title_column = 'name'), 'budgets reach Trash, titled by name');
select ok(not exists (select 1 from private.trash_tables where table_name = 'memberships'), 'ended memberships never reach Trash');
select ok(not exists (select 1 from private.trash_tables where table_name = 'api_keys'), 'nor revoked API keys');
select ok((select 'security_invoker=true' = any (c.reloptions) from pg_class c where c.oid = 'app.trash_items'::regclass), 'the view reads with the reader''s row level security');

-- Deleting moves rows to Trash ----------------------------------------------------------------------------
select pg_temp.as_user('carol');
update app.budget_lines set deleted_at = now() where id = pg_temp.id('bl');
update app.budgets set deleted_at = now() where id = pg_temp.id('bud');
select is((select count(*)::int from app.trash_items where subject_id in (pg_temp.id('bud'), pg_temp.id('bl'))), 2, 'the deleted budget and its line are in Trash');
select is((select title || ' ' || subject_urn from app.trash_items where subject_id = pg_temp.id('bud')),
  'Summer Series Budget urn:xpms:budgets:' || pg_temp.id('bud')::text, 'a Trash row carries its title and URN');
select is((select deleted_by from app.trash_items where subject_id = pg_temp.id('bud')), pg_temp.id('carol'), 'and who deleted it');
select is((select purge_after = deleted_at + interval '7 years' from app.trash_items where subject_id = pg_temp.id('bud')), true, 'it stays restorable for the table''s retention period');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.trash_items where subject_id = pg_temp.id('bud')), 0, 'a Viewer in no project does not see it');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.trash_items where org_id = pg_temp.id('org_a')), 0, 'another org sees nothing of it');
select throws_ok($$select app.restore_trash_item('budgets', (select id from world where key = 'bud'))$$, '42501', null, 'another org cannot restore it');
select throws_ok($$select app.record_trash_restore('budgets', (select id from world where key = 'bud'), 0)$$, 'XR001', null, 'nor record a restore it did not make');
select pg_temp.as_anon();
select throws_ok('select 1 from app.trash_items', '42501', null, 'anon cannot read Trash');
select throws_ok($$select app.restore_trash_item('budgets', gen_random_uuid())$$, '42501', null, 'anon cannot restore');
select pg_temp.as_platform();

-- Restoring ---------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.restore_trash_item('budgets', (select id from world where key = 'bud'))$$, '42501', null, 'a Member who cannot edit budgets cannot restore one');
select pg_temp.as_user('carol');
select throws_ok($$select app.restore_trash_item('memberships', (select id from world where key = 'dave@org_a'))$$,
  'XR001', 'trash_not_restorable: Rows of memberships are not restored from Trash.', 'excluded tables are not restored from Trash');
select is(app.restore_trash_item('budgets', pg_temp.id('bud')), 2, 'the Manager restores the budget, and its line deleted with it');
select is((select count(*)::int from app.budget_lines where id = pg_temp.id('bl') and deleted_at is null), 1, 'the line is live again');
select is((select count(*)::int from app.trash_items where subject_id in (pg_temp.id('bud'), pg_temp.id('bl'))), 0, 'and both have left Trash');
select throws_ok($$select app.restore_trash_item('budgets', (select id from world where key = 'bud'))$$,
  'XR001', 'trash_not_deleted: This row is not in Trash.', 'a live row is not restored');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'trash.restored' and subject_id = pg_temp.id('bud')), 1, 'trash.restored was emitted');

-- Past retention ----------------------------------------------------------------------------------------
update app.budgets set deleted_at = now() - interval '8 years' where id = pg_temp.id('bud_old');
select pg_temp.as_user('carol');
select throws_ok($$select app.restore_trash_item('budgets', (select id from world where key = 'bud_old'))$$,
  'XR001', 'trash_restore_expired: Its retention period has ended; it is about to be purged and cannot be restored.', 'a row past its retention period cannot be restored');
select pg_temp.as_platform();

-- The sweep registers new tables -------------------------------------------------------------------------
create table app.trash_probe (id uuid primary key, org_id uuid not null, name text not null, updated_by uuid, deleted_at timestamptz);
select is(private.sweep_default_retention(), 1, 'the sweep still adds the retention policy of a new table');
select ok(exists (select 1 from private.trash_tables where table_name = 'trash_probe')
  and pg_get_viewdef('app.trash_items'::regclass) like '%trash_probe%', 'and registers it in Trash, regenerating the view');

select * from finish();
rollback;
