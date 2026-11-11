-- pgTAP: migration 2370, the views three collections export so their rows are the ones the page shows (A102, RRR-146;
-- Section 4.6.4). app.my_work_export is the reader's own open records (owned, accountable or assigned), so an Owner's
-- My Work export carries their list and not every assignment in the org. app.activity_export gives each activity row
-- its domain event's project, for readers who cannot read domain events too, and app.goods_receipt_export gives each
-- receipt its purchase order's project, so a project tab exports only its project. Each runs as its reader and keeps
-- the backup login out.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(16);

create function pg_temp.new_record(p_title text, p_owner text default null, p_accountable text default null, p_project text default 'prj_a') returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, title, xyz, xyz_basis, owner_party_id, accountable_party_id)
  values (pg_temp.id(p_project), 'Task', p_title, 'Y', 'Declared', pg_temp.id(p_owner), pg_temp.id(p_accountable))
  returning id into v;
  return v;
end $$;

create function pg_temp.as_worker() returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  perform set_config('role', 'service_role', true);
end $$;

-- World: dave owns one open record, is accountable for another and assigned to a third; alice owns one; dave also
-- owns a deleted record and a deferred one, which My Work leaves out.
select pg_temp.as_user('alice');
insert into world values ('w_owned', pg_temp.new_record('Install the truss', 'dave'));
insert into world values ('w_accountable', pg_temp.new_record('Verify the rigging plan', null, 'dave'));
insert into world values ('w_assigned', pg_temp.new_record('Hang the banner'));
insert into world values ('w_alice', pg_temp.new_record('Order the generator', 'alice'));
insert into world values ('w_deleted', pg_temp.new_record('Paint the stage', 'dave'));
insert into world values ('w_deferred', pg_temp.new_record('Rent the forklift', 'dave'));
insert into app.record_assignments (record_id, membership_id) values (pg_temp.id('w_assigned'), pg_temp.id('dave@org_a'));
select app.transition_record(pg_temp.id('w_deferred'), 'Proposed', 'Deferred', 'Moved.', null, 'Moved to the fall series.');
select pg_temp.as_platform();
update app.records set deleted_at = now() where id = pg_temp.id('w_deleted');

-- My Work ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select results_eq($$select title from app.my_work_export order by title$$,
  $$values ('Hang the banner'::text), ('Install the truss'), ('Verify the rigging plan')$$,
  'a person''s My Work is the open records they own, are accountable for or are assigned to');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.records where org_id = pg_temp.id('org_a') and deleted_at is null), 5,
  'the Owner reads every live record of the org');
select results_eq($$select title from app.my_work_export$$, $$values ('Order the generator'::text)$$,
  'yet the Owner''s My Work is only their own');

-- The export of My Work, read by the worker as the requester.
insert into world values ('exp_my_work', app.request_export(pg_temp.id('org_a'), 'CSV', 'My Work',
  array['app.my_work_export.record_number', 'app.my_work_export.title'], null, null));
select pg_temp.as_worker();
create temporary table claimed as select * from app.claim_export_renders('worker-1', 20);
grant select on claimed to public;
select is((select count(*)::int from claimed where export_job_id = pg_temp.id('exp_my_work')), 1, 'the worker claims the My Work export');
select results_eq($$select r ->> 'title' from jsonb_array_elements(app.export_job_rows((select id from world where key = 'exp_my_work'), 100)) r$$,
  $$values ('Order the generator'::text)$$, 'an Owner''s My Work export carries their own records, not every assignment in the org');

-- Activity with its project ----------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into world select 'ev_owned', e.id from app.domain_events e where e.subject_id = pg_temp.id('w_owned') order by e.occurred_at limit 1;
select pg_temp.as_user('dave');
select ok((select count(*) from app.activity_export where project_id = pg_temp.id('prj_a')) > 0,
  'a project member who cannot read domain events sees the project of each activity row');
select is((select project_id from app.activity_export where domain_event_id = pg_temp.id('ev_owned')), pg_temp.id('prj_a'),
  'the creation of a record of the project is on the project''s activity');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.activity_export a join app.domain_events e on e.id = a.domain_event_id
    where a.project_id is distinct from e.project_id), 0,
  'each activity row''s project is its domain event''s');
select ok((select count(*) from app.activity_export where project_id = pg_temp.id('prj_a'))
    < (select count(*) from app.activity_export),
  'the project''s rows are fewer than the org''s feed');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.activity_export where org_id = pg_temp.id('org_a')), 0, 'another org reads none of it');
-- The helper itself, called with xavier's claims (signed-in callers reach it only through the view).
select set_config('role', 'postgres', true);
select is(private.domain_event_project_id(pg_temp.id('ev_owned')), null::uuid, 'nor the project of another org''s domain event');

-- Goods receipts with their project --------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into world values ('cp_v', app.create_counterparty(pg_temp.id('org_a'), 'Harborline Staging', 'Equipment Rental'));
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id, payment_terms_days) values (pg_temp.id('cp_v'), 30) returning id)
  insert into world select 'ven', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD') returning id)
  insert into world select 'bud', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 1, 'Stage rental.', '0000.01.01', 1, 100000, 'X', 'Declared') returning id)
  insert into world select 'bl', id from x;
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, budget_line_id, element_id, quantity, unit_price_minor)
  values (pg_temp.id('po'), 1, 'Stage deck sections.', pg_temp.id('bl'), '0000.01.01-XOS-001', 2, 20000);
select pg_temp.as_user('alice');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor)
  values (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Purchase Order', 'USD', 100000);
select pg_temp.as_user('bob');
select app.approve_purchase_order(pg_temp.id('po'), 'Within limit.');
select pg_temp.as_user('carol');
with x as (insert into app.goods_receipts (purchase_order_id, note) values (pg_temp.id('po'), 'Arrived complete.') returning id)
  insert into world select 'gr', id from x;
select results_eq($$select id, project_id, purchase_order_id from app.goods_receipt_export$$,
  $$select pg_temp.id('gr'), pg_temp.id('prj_a'), pg_temp.id('po')$$,
  'a goods receipt carries its purchase order''s project');
select is((select count(*)::int from app.goods_receipt_export where project_id = pg_temp.id('prj_a2')), 0,
  'so another project''s receipts tab exports none of it');

-- Each view runs as its reader and keeps the backup login and anon out (1650) --------------------------------------
select pg_temp.as_platform();
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relname in ('activity_export', 'goods_receipt_export', 'my_work_export')
      and c.reloptions::text[] && array['security_invoker=on', 'security_invoker=true']), 3,
  'the three views run as their reader');
select is((select count(*)::int from unnest(array['app.activity_export', 'app.goods_receipt_export', 'app.my_work_export']) v
    where has_table_privilege('xos_backup', v, 'SELECT')), 0, 'the backup login reads none of them');
select is((select count(*)::int from unnest(array['app.activity_export', 'app.goods_receipt_export', 'app.my_work_export']) v
    where has_table_privilege('anon', v, 'SELECT')), 0, 'nor does anon');

select * from finish();
rollback;
