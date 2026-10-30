-- pgTAP: migration 2905 (B1, RRR-225; ADR 0140 D6). A sign's production state is computed from its marks and procurement's
-- rows: a Proposed or Canceled order leaves it To Order, Approved, Sent or Closed makes it Ordered, its line received net of
-- returns makes it Printed, and a placed mark makes it Placed. A sign reader without procurement read sees the state and
-- the ordered-through-PO flag but no order fact; the summary counts each project's signs; neither view reaches xos_backup.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 2681_supply_world.psql
\ir 2900_places_parts.psql

select * from no_plan();

insert into world values
  ('ev1', '01920000-0000-7000-8905-000000000001'), ('ret1', '01920000-0000-7000-8905-000000000101');

create function pg_temp.state(p_key text) returns text
language sql stable as $$ select production_state::text from app.sign_production where sign_id = pg_temp.id(p_key) $$;

select pg_temp.as_user('carol');
with x as (insert into app.signs (project_id, title, sign_type, po_line_id) values (pg_temp.id('prj_a'), 'On a proposed order', 'Menu', pg_temp.id('l3')) returning id) insert into world select 's_prop', id from x;
with x as (insert into app.signs (project_id, title, sign_type, po_line_id, site_plan_pin_id) values (pg_temp.id('prj_a'), 'On a sent order', 'Directional', pg_temp.id('l_svc'), pg_temp.id('pin_a')) returning id) insert into world select 's_sent', id from x;
with x as (insert into app.signs (project_id, title, sign_type, po_line_id) values (pg_temp.id('prj_a'), 'On a closed order', 'Sponsor', pg_temp.id('l2')) returning id) insert into world select 's_closed', id from x;
with x as (insert into app.signs (project_id, title, sign_type, location_text, needed_by) values (pg_temp.id('prj_a'), 'Marked by hand', 'Regulatory', 'Dock door', current_date - 2) returning id) insert into world select 's_hand', id from x;
with x as (insert into app.signs (project_id, title, sign_type) values (pg_temp.id('prj_a'), 'Nothing yet', 'Informational') returning id) insert into world select 's_none', id from x;
select app.transition_purchase_order(pg_temp.id('po2'), 'Sent', 'Closed', 'Delivered.');

select is(pg_temp.state('s_prop'), 'To Order', 'a Proposed order leaves the sign To Order');
select is(pg_temp.state('s_sent'), 'Ordered', 'a Sent order makes it Ordered');
select is(pg_temp.state('s_closed'), 'Ordered', 'and so does a Closed one');
select is(pg_temp.state('s_none'), 'To Order', 'a sign with nothing is To Order');
select pg_temp.as_user('bob');
select app.approve_purchase_order(pg_temp.id('po3'), 'Within limit.');
select pg_temp.as_user('carol');
select is(pg_temp.state('s_prop'), 'Ordered', 'an Approved order makes it Ordered');
select app.transition_purchase_order(pg_temp.id('po3'), 'Approved', 'Canceled', 'Not needed.');
select is(pg_temp.state('s_prop'), 'To Order', 'canceling the order takes it back to To Order');

select pg_temp.receive('ev1', 'po', jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('l_svc'), 'quantity', 1)));
select is(pg_temp.state('s_sent'), 'Printed', 'its line received makes it Printed');
select is((select received from app.sign_production where sign_id = pg_temp.id('s_sent')), true, 'and received');
insert into world select 'rl_svc', id from app.receipt_lines where goods_receipt_id = pg_temp.id('ev1') and po_line_id = pg_temp.id('l_svc');
select pg_temp.give_back('ret1', 'po', 'Wrong Item', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.id('rl_svc'), 'quantity', 1)));
select is(pg_temp.state('s_sent'), 'Ordered', 'a full return takes it back to Ordered');

select app.mark_sign_step(pg_temp.id('s_hand'), 'Ordered');
select is(pg_temp.state('s_hand'), 'Ordered', 'a manual mark orders a sign without a line');
select app.mark_sign_step(pg_temp.id('s_hand'), 'Printed');
select is(pg_temp.state('s_hand'), 'Printed', 'and prints it');
select is((select overdue from app.sign_production where sign_id = pg_temp.id('s_hand')), true, 'past its needed-by day it is overdue');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'sign.created'), 5, 'sign.created is emitted');
select pg_temp.as_user('carol');

-- The summary -------------------------------------------------------------------------------------------------------------------
select is((select to_order || ' ' || ordered || ' ' || printed || ' ' || placed || ' ' || unplaced || ' ' || unlocated || ' ' || overdue
  from app.project_signage_summary where project_id = pg_temp.id('prj_a')), '2 2 1 0 1 3 1', 'the summary counts each state, unplaced, unlocated and overdue');
select app.mark_sign_step(pg_temp.id('s_hand'), 'Placed');
select is(pg_temp.state('s_hand'), 'Placed', 'placing makes it Placed');
select is((select overdue from app.sign_production where sign_id = pg_temp.id('s_hand')), false, 'and no longer overdue');
select pg_temp.as_user('dave');
update app.site_plan_pins set deleted_at = now() where id = pg_temp.id('pin_a');
select is((select located from app.sign_production where sign_id = pg_temp.id('s_sent')), false, 'a sign whose pin was archived is unlocated');

-- A reader without procurement read -------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is(pg_temp.state('s_closed'), 'Ordered', 'a Field reader sees the state');
select is((select ordered_via_po from app.sign_production where sign_id = pg_temp.id('s_closed')), true, 'and that it is ordered through an order');
select is((select count(*)::int from app.po_lines), 0, 'but reads no order line');
select hasnt_column('app', 'sign_production', 'po_number', 'the view carries no order number');
select hasnt_column('app', 'sign_production', 'vendor_id', 'no vendor');
select hasnt_column('app', 'sign_production', 'unit_price_minor', 'no price');
select hasnt_column('app', 'sign_production', 'quantity_received', 'no quantity');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.sign_production), 0, 'another org reads no production rows');
select is((select count(*)::int from app.project_signage_summary), 0, 'nor a summary');
select pg_temp.as_anon();
select throws_ok('select 1 from app.sign_production', '42501', null, 'anon cannot read it');
select pg_temp.as_platform();
select is(has_table_privilege('xos_backup', 'app.sign_production', 'select'), false, 'the backup login cannot read production');
select is(has_table_privilege('xos_backup', 'app.project_signage_summary', 'select'), false, 'nor the summary');

select * from finish();
rollback;
