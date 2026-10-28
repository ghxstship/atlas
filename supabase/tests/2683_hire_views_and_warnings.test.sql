-- pgTAP: migration 2683 (R7a parity additions G-96 and G-99). app.asset_unit_hire tells an asset-only reader that a unit
-- is hired in and when it goes back, with no vendor or cost, and off_hire_due clears once the unit is Returned.
-- private.project_site_window reads the Build and Strike records, falls back to the project dates and answers only
-- procurement readers. Each of the five hire warnings appears for a crafted line and disappears when the line fits;
-- dock warnings appear only when every dock zone the project books is taken; a NULL window bound gives no warning.
-- app.hire_window_warnings agrees with the view and refuses hire_period_order and 42501. The backup login reads neither view.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 2681_supply_world.psql

select * from no_plan();

insert into world values ('ev1', '01920000-0000-7000-8683-000000000001'), ('ret1', '01920000-0000-7000-8683-000000000101'),
  ('ev2', '01920000-0000-7000-8683-000000000002');

-- G-96: hired-in units ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.receive('ev1', 'po', jsonb_build_array(
  jsonb_build_object('po_line_id', pg_temp.id('l_radio'), 'quantity', 1, 'asset_tags', jsonb_build_array('NWL-RNT-001'))));
select pg_temp.receive('ev2', 'po', jsonb_build_array(
  jsonb_build_object('po_line_id', pg_temp.id('l_future'), 'quantity', 1, 'asset_tags', jsonb_build_array('NWL-RNT-002'))));
insert into world select 'rl_radio', id from app.receipt_lines where goods_receipt_id = pg_temp.id('ev1');
insert into world select 'r1', id from app.asset_units where asset_tag = 'NWL-RNT-001';
insert into world select 'r2', id from app.asset_units where asset_tag = 'NWL-RNT-002';
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('cls_radio'), 'NWL-RAD-OWN') returning id) insert into world select 'own', id from x;
select app.transition_asset(pg_temp.id('r1'), 'Received', 'Available', 'Shelved.');

select pg_temp.as_user('gina');
select is((select acquisition_kind || ' ' || hire_ends_at::text || ' ' || off_hire_due from app.asset_unit_hire where asset_unit_id = pg_temp.id('r1')),
  'Rental ' || '2026-01-10 12:00+00'::timestamptz::text || ' true', 'an asset-only reader sees a hired-in unit, its hire end and that it is due back');
select is((select off_hire_due from app.asset_unit_hire where asset_unit_id = pg_temp.id('r2')), false, 'a hire that has not ended is not due');
select is((select acquisition_kind || ' ' || coalesce(hire_ends_at::text, '-') || ' ' || off_hire_due from app.asset_unit_hire where asset_unit_id = pg_temp.id('own')),
  'Purchase - false', 'a unit with no receipt line is a Purchase');
select is((select count(*)::int from app.asset_unit_provenance), 0, 'the same reader reads no provenance');
select hasnt_column('app', 'asset_unit_hire', 'vendor_id', 'the hire view names no vendor');
select hasnt_column('app', 'asset_unit_hire', 'unit_price_minor', 'nor a cost');
select hasnt_column('app', 'asset_unit_hire', 'purchase_order_id', 'nor the order');
select hasnt_column('app', 'asset_unit_hire', 'po_number', 'nor its number');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.asset_unit_hire where org_id = pg_temp.id('org_a')), 0, 'another org reads no hire rows');
select pg_temp.as_user('carol');
select pg_temp.give_back('ret1', 'po', 'Off Hire', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_radio'), 'quantity', 1,
  'asset_unit_ids', jsonb_build_array(pg_temp.id('r1')))));
select pg_temp.as_user('gina');
select is((select off_hire_due from app.asset_unit_hire where asset_unit_id = pg_temp.id('r1')), false, 'off-hire is no longer due once the unit is Returned');

-- G-99: the site window ------------------------------------------------------------------------------------------------------------------
-- Readers have no usage on schema private, so the window is read under the reader's claims as the owner.
create function pg_temp.site_window(p_key text, p_project text) returns tstzrange
language plpgsql as $$
declare
  v tstzrange;
begin
  perform pg_temp.as_user(p_key);
  perform set_config('role', 'postgres', true);
  v := private.project_site_window(pg_temp.id(p_project));
  perform pg_temp.as_user(p_key);
  return v;
end $$;
select pg_temp.as_platform();
update app.projects set starts_on = '2027-06-01', ends_on = '2027-06-05' where id = pg_temp.id('prj_a');
select pg_temp.as_user('carol');
select is(pg_temp.site_window('carol', 'prj_a'), tstzrange('2027-06-01 04:00+00', '2027-06-06 04:00+00', '[)'),
  'without Build or Strike records the window runs from the first day to the day after the last, in the project zone');
insert into app.records (project_id, record_kind, title, xyz, xyz_basis, starts_at, ends_at)
values (pg_temp.id('prj_a'), 'Build', 'Build the main stage', 'Y', 'Declared', '2027-06-02 12:00+00', '2027-06-02 20:00+00');
insert into app.records (project_id, record_kind, title, xyz, xyz_basis, starts_at, ends_at)
values (pg_temp.id('prj_a'), 'Strike', 'Strike the main stage', 'Y', 'Declared', '2027-06-04 14:00+00', '2027-06-04 20:00+00');
select is(pg_temp.site_window('carol', 'prj_a'), tstzrange('2027-06-02 12:00+00', '2027-06-04 20:00+00', '[)'),
  'the Build start and the Strike end set the window');
select is(pg_temp.site_window('gina', 'prj_a'), null, 'a caller without procurement.po.read gets no window');

-- G-99: the five warnings ------------------------------------------------------------------------------------------------------------------
-- po3 is still Proposed, so its line can be moved; its project's window is 2027-06-02 12:00 to 2027-06-04 20:00 UTC.
select pg_temp.as_platform();
update app.po_lines set acquisition_kind = 'Rental', hire_period = '[2027-06-02 10:00+00,2027-06-05 10:00+00)', unit_price_minor = 100
where id = pg_temp.id('l3');
create function pg_temp.warnings() returns text
language sql as $$ select coalesce(string_agg(warning, ', ' order by warning), '-') from app.po_line_hire_warnings where po_line_id = pg_temp.id('l3') $$;
create function pg_temp.move_hire(p_from text, p_to text) returns void
language sql as $$ update app.po_lines set hire_period = tstzrange(p_from::timestamptz, p_to::timestamptz, '[)') where id = pg_temp.id('l3') $$;

select pg_temp.as_user('carol');
select is(pg_temp.warnings(), '-', 'a hire that covers the window and stays within a day of it raises nothing');
select pg_temp.move_hire('2027-06-02 14:00+00', '2027-06-05 10:00+00');
select is(pg_temp.warnings(), 'Delivery After Load In', 'a delivery after the Build starts is flagged');
select pg_temp.move_hire('2027-06-02 10:00+00', '2027-06-04 18:00+00');
select is(pg_temp.warnings(), 'Return Before Load Out', 'a return before the Strike ends is flagged');
select pg_temp.move_hire('2027-05-30 10:00+00', '2027-06-05 10:00+00');
select is(pg_temp.warnings(), 'Hire Beyond Site Window', 'a hire starting more than a day early is flagged');
select pg_temp.move_hire('2027-06-02 10:00+00', '2027-06-07 10:00+00');
select is(pg_temp.warnings(), 'Hire Beyond Site Window', 'and one ending more than a day late');
select pg_temp.move_hire('2027-06-02 10:00+00', '2027-06-05 10:00+00');

with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'DOCK-1', 'Loading Dock One') returning id) insert into world select 'dock1', id from x;
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'DOCK-2', 'Loading Dock Two') returning id) insert into world select 'dock2', id from x;
insert into app.dock_slots (project_id, zone_id, starts_at, ends_at) values
  (pg_temp.id('prj_a'), pg_temp.id('dock1'), '2027-06-02 09:00+00', '2027-06-02 11:00+00'),
  (pg_temp.id('prj_a'), pg_temp.id('dock2'), '2027-06-03 09:00+00', '2027-06-03 11:00+00');
select is(pg_temp.warnings(), '-', 'one dock taken at the delivery while another dock the project books is free raises nothing');
insert into app.dock_slots (project_id, zone_id, starts_at, ends_at) values
  (pg_temp.id('prj_a'), pg_temp.id('dock2'), '2027-06-02 09:30+00', '2027-06-02 10:30+00');
select is(pg_temp.warnings(), 'Delivery Docks Full', 'every dock taken at the delivery is flagged');
insert into app.dock_slots (project_id, zone_id, starts_at, ends_at) values
  (pg_temp.id('prj_a'), pg_temp.id('dock1'), '2027-06-05 09:00+00', '2027-06-05 11:00+00'),
  (pg_temp.id('prj_a'), pg_temp.id('dock2'), '2027-06-05 09:00+00', '2027-06-05 11:00+00');
select is(pg_temp.warnings(), 'Delivery Docks Full, Return Docks Full', 'and every dock taken at the return');
select pg_temp.move_hire('2027-06-02 11:00+00', '2027-06-05 12:00+00');
select is(pg_temp.warnings(), '-', 'moving the hire to free dock times clears both');

-- The form's check agrees with the view ------------------------------------------------------------------------------------------------------
select is((select coalesce(string_agg(w, ', ' order by w), '-') from app.hire_window_warnings(pg_temp.id('prj_a'), '2027-06-02 14:00+00', '2027-06-04 18:00+00') w),
  'Delivery After Load In, Return Before Load Out', 'an unsaved hire raises the same warnings');
select pg_temp.move_hire('2027-06-02 14:00+00', '2027-06-04 18:00+00');
select is(pg_temp.warnings(), 'Delivery After Load In, Return Before Load Out', 'as the saved line does');
select throws_ok($$select * from app.hire_window_warnings(pg_temp.id('prj_a'), '2027-06-05 10:00+00', '2027-06-02 10:00+00')$$,
  'XR001', 'hire_period_order: A hire ends after it starts.', 'a hire that ends before it starts is refused');
select pg_temp.as_user('gina');
select throws_ok($$select * from app.hire_window_warnings(pg_temp.id('prj_a'), '2027-06-02 10:00+00', '2027-06-05 10:00+00')$$,
  '42501', null, 'a caller without procurement.po.read is refused');
select is((select count(*)::int from app.po_line_hire_warnings), 0, 'and reads no saved warnings');

-- A NULL window bound gives no warning ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(lower(pg_temp.site_window('carol', 'prj_a2')), null, 'a project with no dates and no records has no window start');
select is((select count(*)::int from app.hire_window_warnings(pg_temp.id('prj_a2'), '2027-01-01 00:00+00', '2027-12-31 00:00+00')), 0,
  'so no window rule warns on its hires');

select pg_temp.as_platform();
select is(has_table_privilege('xos_backup', 'app.asset_unit_hire', 'select'), false, 'the backup login cannot read hire rows');
select is(has_table_privilege('xos_backup', 'app.po_line_hire_warnings', 'select'), false, 'nor hire warnings');

select * from finish();
rollback;
