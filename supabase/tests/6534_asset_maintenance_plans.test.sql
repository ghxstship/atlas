-- pgTAP: migration 6534 (B11, G-95), maintenance schedules. First due, recurring due, a done one-off, Overdue on the org's
-- calendar when UTC and local dates differ, class plans expanding to live serviceable owned units, the plan guard, the
-- capability, and performed_on staying required.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 6531_supply_world.psql

select no_plan();

create function pg_temp.today() returns date language sql security definer as $$ select private.org_today(pg_temp.id('org_a')) $$;
select pg_temp.as_user('alice');
create function pg_temp.due(p_plan text, p_unit text) returns app.asset_maintenance_due language plpgsql as $$
declare v app.asset_maintenance_due;
begin
  perform pg_temp.as_user('alice');
  select d.* into v from app.asset_maintenance_due d where d.plan_id = pg_temp.id(p_plan) and d.asset_unit_id = pg_temp.id(p_unit);
  return v;
end $$;

-- A recurring plan on one unit.
insert into app.asset_maintenance_plans (org_id, asset_unit_id, title, first_due_on, every_count, every_unit)
values (pg_temp.id('org_a'), pg_temp.id('t1'), 'Inspect welds', current_date + 10, 3, 'Month');
insert into world select 'p_rec', id from app.asset_maintenance_plans where title = 'Inspect welds';
select is((pg_temp.due('p_rec', 't1')).due_on, current_date + 10, 'with no work, due on first_due_on');
select is((pg_temp.due('p_rec', 't1')).due_status, 'Pending', 'and Pending');
select pg_temp.as_user('alice');
insert into app.asset_maintenance (asset_unit_id, performed_on, description, maintenance_plan_id) values (pg_temp.id('t1'), '2027-01-31', 'Done.', pg_temp.id('p_rec'));
select is((pg_temp.due('p_rec', 't1')).due_on, '2027-04-30'::date, 'recurring: last performed plus the interval');
select is((pg_temp.due('p_rec', 't1')).last_performed_on, '2027-01-31'::date, 'with the latest entry');

-- A one-off.
select pg_temp.as_user('alice');
insert into app.asset_maintenance_plans (org_id, asset_unit_id, title, first_due_on)
values (pg_temp.id('org_a'), pg_temp.id('t2'), 'Replace cable once', current_date - 400);
insert into world select 'p_one', id from app.asset_maintenance_plans where title = 'Replace cable once';
select is((pg_temp.due('p_one', 't2')).due_status, 'Overdue', 'a past due date is Overdue');
select pg_temp.as_user('alice');
insert into app.asset_maintenance (asset_unit_id, performed_on, description, maintenance_plan_id) values (pg_temp.id('t2'), current_date, 'Done.', pg_temp.id('p_one'));
select is((pg_temp.due('p_one', 't2')).due_status, 'Completed', 'a done one-off is Completed');
select is((pg_temp.due('p_one', 't2')).due_on, null::date, 'with due_on NULL');

-- The org's calendar: a time zone ahead of UTC and a zone behind differ on the day for the same instant.
select pg_temp.as_user('alice');
insert into app.asset_maintenance_plans (org_id, asset_unit_id, title, first_due_on)
values (pg_temp.id('org_a'), pg_temp.id('t3'), 'Calendar check', pg_temp.today());
insert into world select 'p_cal', id from app.asset_maintenance_plans where title = 'Calendar check';
select is((pg_temp.due('p_cal', 't3')).due_status, 'Pending', 'due today on the org''s calendar is not Overdue');
select pg_temp.as_user('alice');
update app.asset_maintenance_plans set first_due_on = pg_temp.today() - 1 where id = pg_temp.id('p_cal');
select is((pg_temp.due('p_cal', 't3')).due_status, 'Overdue', 'due yesterday on it is');
select pg_temp.as_platform();
select ok(pg_get_viewdef('app.asset_maintenance_due'::regclass) like '%org_today%', 'the view reads the org''s calendar, never the UTC date');

-- A class plan.
select pg_temp.as_user('alice');
insert into app.asset_maintenance_plans (org_id, asset_class_id, title, first_due_on, every_count, every_unit)
values (pg_temp.id('org_a'), pg_temp.id('cls_radio'), 'Battery test', current_date + 1, 1, 'Year');
insert into world select 'p_cls', id from app.asset_maintenance_plans where title = 'Battery test';
select is((select count(*)::integer from app.asset_maintenance_due where plan_id = pg_temp.id('p_cls')), 4, 'a class plan expands to its live units');
select pg_temp.as_platform();
set local session_replication_role = replica;
update app.asset_units set asset_state = 'Lost' where id = pg_temp.id('r1');
set local session_replication_role = origin;
insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('cls_radio'), 'NWL-RAD-NEW');
select pg_temp.as_user('alice');
select is((select count(*)::integer from app.asset_maintenance_due where plan_id = pg_temp.id('p_cls')), 3, 'and leaves out Proposed and Lost units');
select pg_temp.as_platform();
-- A unit received on a rental line is the vendor's.
select pg_temp.as_user('carol');
select app.receive_goods(gen_random_uuid(), pg_temp.id('po_rent'), jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_rent'), 'quantity', 1, 'asset_tags', jsonb_build_array('NWL-RNT-001'))));
select pg_temp.as_platform();
select private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions', 'asset_unit_id', u.id, 'Received', 'Available', 'Fixture.')
from app.asset_units u where u.asset_tag = 'NWL-RNT-001';
select pg_temp.as_user('alice');
select is((select count(*)::integer from app.asset_maintenance_due where plan_id = pg_temp.id('p_cls')), 3, 'a unit received on a rental line is not expanded');
select pg_temp.producer('reader', 'assets.asset.read');
select pg_temp.as_user('reader');
select is((select count(*)::integer from app.asset_maintenance_due where plan_id = pg_temp.id('p_cls')), 3, 'and a reader without procurement.po.read reads the same');

-- The plan guard and rights.
select pg_temp.as_user('alice');
select throws_like(format($$insert into app.asset_maintenance (asset_unit_id, performed_on, description, maintenance_plan_id) values (%L, current_date, 'Done.', %L)$$, pg_temp.id('t5'), pg_temp.id('p_rec')),
  'maintenance_plan_unit:%', 'a unit outside the plan refuses maintenance_plan_unit');
select throws_like(format($$insert into app.asset_maintenance (asset_unit_id, performed_on, description, maintenance_plan_id) values (%L, current_date, 'Done.', %L)$$, pg_temp.id('t5'), pg_temp.id('p_cls')),
  'maintenance_plan_unit:%', 'and so does a unit of another class');
select lives_ok(format($$insert into app.asset_maintenance (asset_unit_id, performed_on, description, maintenance_plan_id) values (%L, current_date, 'Done.', %L)$$, pg_temp.id('r2'), pg_temp.id('p_cls')),
  'a unit of the class is covered');
select throws_ok(format($$insert into app.asset_maintenance_plans (org_id, title, first_due_on) values (%L, 'No target', current_date)$$, pg_temp.id('org_a')), '23514', null, 'exactly one of unit and class');
select throws_ok(format($$insert into app.asset_maintenance_plans (org_id, asset_unit_id, title, first_due_on, every_count) values (%L, %L, 'Half', current_date, 3)$$, pg_temp.id('org_a'), pg_temp.id('t1')), '23514', null, 'count and unit come together');
select pg_temp.as_user('reader');
select throws_ok(format($$insert into app.asset_maintenance_plans (org_id, asset_unit_id, title, first_due_on) values (%L, %L, 'No right', current_date)$$, pg_temp.id('org_a'), pg_temp.id('t1')), '42501', null, 'assets.maintenance.write is required to write');
select col_not_null('app', 'asset_maintenance', 'performed_on', 'performed_on stays required');

-- Soft delete, Trash, backup.
select pg_temp.as_platform();
select ok(exists (select 1 from private.trash_tables t where t.table_name in ('asset_maintenance_plans', 'app.asset_maintenance_plans')), 'plans are in Trash');
select ok(not has_table_privilege('xos_backup', 'app.asset_maintenance_due', 'SELECT'), 'the backup login does not read the view');

select * from finish();
rollback;
