-- pgTAP: migration 6532 (B11, G-180), need status. The four computed statuses, Proposed lines only drafted, a Canceled
-- order dropping out, returns (Defective lowers ordered, Off Hire and Over Delivery do not), no stored status column,
-- requested quantity for a buyer without advancing.packet.read and no names for them, withdrawn requests, the ready view
-- and its pool rules, and the backup login.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 6531_supply_world.psql

select no_plan();

create function pg_temp.requested(p_key text) returns numeric language sql security definer as $$ select private.need_requested_quantity(pg_temp.id(p_key)) $$;

select pg_temp.as_user('carol');
insert into app.procurement_needs (project_id, description, quantity) values (pg_temp.id('prj_a'), 'Five things', 5);
insert into world select 'n', id from app.procurement_needs where description = 'Five things';

select is((pg_temp.need(pg_temp.id('n'))).need_status, 'Needs Ordered', 'nothing ordered is Needs Ordered');

-- Proposed only drafts.
select pg_temp.order_with('o1', 3, pg_temp.id('n'));
select is((pg_temp.need(pg_temp.id('n'))).need_status, 'Needs Ordered', 'a Proposed order is still Needs Ordered');
select is((pg_temp.need(pg_temp.id('n'))).drafted_quantity, 3::numeric, 'and shows as drafted');

-- 3 of 5.
select pg_temp.approve_order('o1', false);
select is((pg_temp.need(pg_temp.id('n'))).need_status, 'Short', '3 of 5 ordered is Short');
select is((pg_temp.need(pg_temp.id('n'))).ordered_quantity, 3::numeric, 'with ordered 3');
select is((pg_temp.need(pg_temp.id('n'))).drafted_quantity, 0::numeric, 'and none drafted');

-- 5 of 5.
select pg_temp.order_with('o2', 2, pg_temp.id('n'));
select pg_temp.approve_order('o2');
select is((pg_temp.need(pg_temp.id('n'))).need_status, 'On Order', '5 of 5 is On Order');

-- 6 of 5.
select pg_temp.order_with('o3', 1, pg_temp.id('n'));
select pg_temp.approve_order('o3');
select is((pg_temp.need(pg_temp.id('n'))).need_status, 'Excess', '6 of 5 is Excess');

-- Canceling drops its lines.
select pg_temp.as_user('carol');
select app.transition_purchase_order(pg_temp.id('o3'), 'Sent', 'Canceled', 'Not after all.');
select is((pg_temp.need(pg_temp.id('n'))).need_status, 'On Order', 'canceling an order drops its lines');

-- Returns. o2: 2 ordered on a purchase line; both are received.
create function pg_temp.received_line(p_line text) returns uuid language sql security definer as $$
  select rl.id from app.receipt_lines rl where rl.po_line_id = pg_temp.id(p_line) and rl.deleted_at is null limit 1
$$;
select pg_temp.as_user('carol');
select app.receive_goods(gen_random_uuid(), pg_temp.id('o2'), jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('o2_l'), 'quantity', 2)));
select is((pg_temp.need(pg_temp.id('n'))).received_quantity, 2::numeric, 'receipts read through');
select pg_temp.as_user('carol');
select app.return_goods(gen_random_uuid(), pg_temp.id('o2'), 'Over Delivery', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.received_line('o2_l'), 'quantity', 1)));
select is((pg_temp.need(pg_temp.id('n'))).ordered_quantity, 5::numeric, 'an Over Delivery return does not lower ordered');
select pg_temp.as_user('carol');
select app.return_goods(gen_random_uuid(), pg_temp.id('o2'), 'Defective', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.received_line('o2_l'), 'quantity', 1)));
select is((pg_temp.need(pg_temp.id('n'))).ordered_quantity, 4::numeric, 'a Defective return lowers ordered');
select is((pg_temp.need(pg_temp.id('n'))).need_status, 'Short', 'and the need reads Short again');

-- Off Hire on a rental line does not lower ordered.
select pg_temp.as_user('carol');
insert into app.procurement_needs (project_id, description, quantity) values (pg_temp.id('prj_a'), 'A hire', 1);
insert into world select 'nh', id from app.procurement_needs where description = 'A hire';
select pg_temp.order_with('oh', 1, pg_temp.id('nh'), 'ven', null, 'Rental', '[2027-05-01 00:00+00,2027-07-01 00:00+00)');
select pg_temp.approve_order('oh');
select pg_temp.as_user('carol');
select app.receive_goods(gen_random_uuid(), pg_temp.id('oh'), jsonb_build_array(jsonb_build_object('po_line_id', pg_temp.id('oh_l'), 'quantity', 1)));
select app.return_goods(gen_random_uuid(), pg_temp.id('oh'), 'Off Hire', jsonb_build_array(jsonb_build_object('receipt_line_id', pg_temp.received_line('oh_l'), 'quantity', 1)));
select is((pg_temp.need(pg_temp.id('nh'))).ordered_quantity, 1::numeric, 'an Off Hire return does not lower ordered');
select is((pg_temp.need(pg_temp.id('nh'))).need_status, 'On Order', 'and the hire stays On Order');

-- A Closed order still counts as ordered (ADR 0104 amendment).
select pg_temp.as_user('carol');
select app.transition_purchase_order(pg_temp.id('oh'), 'Sent', 'Closed', 'Done.');
select is((pg_temp.need(pg_temp.id('nh'))).ordered_quantity, 1::numeric, 'a Closed order still counts');

-- No stored status.
select is((select count(*)::integer from information_schema.columns
           where table_schema = 'app' and table_name = 'procurement_needs' and column_name in ('need_status', 'status', 'ordered_quantity')), 0,
  'there is no stored status column');
select is((select c.relkind::text from pg_class c where c.oid = 'app.procurement_need_status'::regclass), 'v', 'status is a plain view');

-- Requested quantity for a buyer who cannot read allocations.
insert into world select 'rq1', pg_temp.alloc('request', 'dave', 'eng_vendor_a', 'class', 'cls_truss', 7);
insert into world select 'rq2', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_truss', 8);
select pg_temp.as_user('carol');
insert into app.procurement_needs (project_id, description, quantity) values (pg_temp.id('prj_a'), 'Truss for all', 5);
insert into world select 'nt', id from app.procurement_needs where description = 'Truss for all';
select app.consolidate_allocations(array[pg_temp.id('rq1'), pg_temp.id('rq2')], pg_temp.id('nt'));
select is((pg_temp.need(pg_temp.id('nt'))).requested_quantity, 15::numeric, 'a need of 5 with 15 requested reads requested 15');
select is((pg_temp.need(pg_temp.id('nt'))).quantity, 5::numeric, 'and keeps its quantity of 5');

select pg_temp.producer('buyer', 'procurement.po.read');
select pg_temp.as_user('buyer');
select is((select requested_quantity from app.procurement_need_status where need_id = pg_temp.id('nt')), 15::numeric, 'a buyer without advancing.packet.read reads the true number');
select ok((select effective_during from app.procurement_need_status where need_id = pg_temp.id('nt')) is not null, 'and the span of the requests');
select is((select needed_during from app.procurement_need_status where need_id = pg_temp.id('nt')), null::tstzrange, 'its own window stays empty, so an edit form never stores the span');
select is(app.procurement_time_zone(pg_temp.id('prj_a')), (select time_zone from app.procurement_need_status where need_id = pg_temp.id('nt')), 'and reads the project''s time zone to type times in');
select is((select count(*)::integer from app.advance_allocations where id = pg_temp.id('rq1')), 0, 'and cannot read the allocations');
select is((select count(*)::integer from app.allocations_ready_to_consolidate), 0, 'nor the holder names');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.procurement_need_status where need_id = pg_temp.id('nt')), 0, 'another org reads nothing');
select is(pg_temp.requested('nt'), 0::numeric, 'and the helper tells it nothing');

-- A withdrawal drops out.
select pg_temp.as_user('dave');
select app.withdraw_allocation(pg_temp.id('rq2'), 'No longer needed.');
select is((pg_temp.need(pg_temp.id('nt'))).requested_quantity, 7::numeric, 'a later withdrawal drops it from requested');

-- The ready view.
insert into world select 'rq3', pg_temp.alloc('request', 'dave', 'e_mo', 'class', 'cls_truss', 1);
insert into world select 'pool', pg_temp.alloc('request', 'dave', 'eng_vendor_a', 'class', 'cls_radio', 3);
select pg_temp.as_user('carol');
select app.decide_allocation(pg_temp.id('pool'), 'Approved');
insert into world select 'kid', (app.split_allocation(pg_temp.id('pool'), jsonb_build_array(jsonb_build_object('roster_entry_id', pg_temp.id('e_kai'), 'quantity', 1))))[1];
select ok(exists (select 1 from app.allocations_ready_to_consolidate where allocation_id = pg_temp.id('rq3')), 'a live request with no link is ready');
select is((select holder_name from app.allocations_ready_to_consolidate where allocation_id = pg_temp.id('rq3')), 'Mo Lindqvist', 'with its holder''s name');
select is((select count(*)::integer from app.allocations_ready_to_consolidate where allocation_id in (pg_temp.id('rq1'))), 0, 'a linked request is not');
select is((select count(*)::integer from app.allocations_ready_to_consolidate where allocation_id in (pg_temp.id('pool'), pg_temp.id('kid'))), 2, 'an unlinked pool and its child both are');
select app.consolidate_allocations(array[pg_temp.id('pool')]);
select is((select count(*)::integer from app.allocations_ready_to_consolidate where allocation_id = pg_temp.id('kid')), 0, 'a Split child of a linked pool never appears');
select app.unlink_need_request(pg_temp.id('pool'));
select app.consolidate_allocations(array[pg_temp.id('kid')]);
select is((select count(*)::integer from app.allocations_ready_to_consolidate where allocation_id = pg_temp.id('pool')), 0, 'nor a pool with a linked child');
select pg_temp.producer('adv', 'advancing.packet.read');
select pg_temp.as_user('adv');
select is(app.procurement_time_zone(pg_temp.id('prj_a')), null::text, 'no procurement capability reads no time zone');
select is((select count(*)::integer from app.allocations_ready_to_consolidate), 0, 'advancing.packet.read alone reads nothing there');

-- The backup login reads no new view.
select pg_temp.as_platform();
select ok(not has_table_privilege('xos_backup', c.oid, 'SELECT'), c.relname || ' is out of the backup login''s reach')
from pg_class c where c.oid in ('app.procurement_need_status'::regclass, 'app.allocations_ready_to_consolidate'::regclass);

select * from finish();
rollback;
