-- pgTAP: migration 3001 (B11, G-180), procurement needs. Consolidation by class and onto a need, Requested linking, the
-- refusals of a link, the double-count rules for a pool and its Split children, set_po_line_need on a Sent order, the
-- need's own guards, atomic multi-line writers, Trash and cross-org.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 3001_supply_world.psql

select no_plan();

-- 1. Consolidating with no need -----------------------------------------------------------------------------------------------------
insert into world select 'a1', pg_temp.alloc('request', 'dave', 'eng_vendor_a', 'class', 'cls_truss', 9);
insert into world select 'a2', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_truss', 6);
insert into world select 'a3', pg_temp.alloc('request', 'dave', 'e_mo', 'class', 'cls_radio', 1);
select pg_temp.as_user('carol');
insert into world select 'needs', (app.consolidate_allocations(array[pg_temp.id('a1'), pg_temp.id('a2'), pg_temp.id('a3')]))[1];
select pg_temp.as_platform();
select is((select count(*)::integer from app.procurement_need_requests l join app.procurement_needs n on n.id = l.procurement_need_id
           where l.advance_allocation_id in (pg_temp.id('a1'), pg_temp.id('a2'))), 2, 'each allocation stays traceable to its need');
select is((select n.quantity from app.procurement_needs n join app.procurement_need_requests l on l.procurement_need_id = n.id
           where l.advance_allocation_id = pg_temp.id('a1')), 15::numeric, 'no need: one need per class, of the summed quantity');
select is((select n.description from app.procurement_needs n join app.procurement_need_requests l on l.procurement_need_id = n.id
           where l.advance_allocation_id = pg_temp.id('a3')), (select c.name from app.asset_classes c where c.id = pg_temp.id('cls_radio')), 'described by the class name');
select is((select count(distinct l.procurement_need_id)::integer from app.procurement_need_requests l
           where l.advance_allocation_id in (pg_temp.id('a1'), pg_temp.id('a3'))), 2, 'and two classes give two needs');
select matches((select app.procurement_need_display_key(n) from app.procurement_needs n join app.procurement_need_requests l on l.procurement_need_id = n.id
           where l.advance_allocation_id = pg_temp.id('a1')), '^NWL-NEED-[0-9]+$', 'the display key reads {project}-NEED-{n}');

-- 2. Refusals of a link ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.procurement_needs (project_id, description, quantity) values (pg_temp.id('prj_a'), 'Free text need', 5);
insert into world select 'need5', n.id from app.procurement_needs n where n.description = 'Free text need';
select throws_like(format($$select app.consolidate_allocations(array[%L]::uuid[])$$, pg_temp.id('a1')), 'need_request_linked:%', 'a request already linked refuses need_request_linked');
insert into world select 'decl', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_truss', 1);
select pg_temp.as_user('carol');
select app.decide_allocation(pg_temp.id('decl'), 'Rejected', 'No need.');
select throws_like(format($$select app.consolidate_allocations(array[%L]::uuid[])$$, pg_temp.id('decl')), 'need_request_state:%', 'a Declined request refuses need_request_state');
insert into world select 'trv', pg_temp.alloc('request', 'dave', 'e_kai', 'travel', '', 1);
select pg_temp.as_user('carol');
select throws_like(format($$select app.consolidate_allocations(array[%L]::uuid[])$$, pg_temp.id('trv')), 'need_request_not_asset:%', 'a request for something else refuses need_request_not_asset');
select throws_ok($$select app.consolidate_allocations('{}'::uuid[])$$, '42501', null, 'an empty selection names no project');
insert into app.procurement_needs (project_id, description, quantity, asset_class_id) values (pg_temp.id('prj_a'), 'Radios only', 5, pg_temp.id('cls_radio'));
insert into world select 'need_radio', n.id from app.procurement_needs n where n.description = 'Radios only';
insert into world select 'a4', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_truss', 2);
select pg_temp.as_user('carol');
select throws_like(format($$select app.consolidate_allocations(array[%L]::uuid[], %L)$$, pg_temp.id('a4'), pg_temp.id('need_radio')), 'need_request_class:%', 'a need of another class refuses need_request_class');
insert into app.procurement_needs (project_id, description, quantity, element_id) values (pg_temp.id('prj_a'), 'Another element', 5, '8000.01.01-XPMS-001');
insert into world select 'need_el', n.id from app.procurement_needs n where n.description = 'Another element';
select throws_like(format($$select app.consolidate_allocations(array[%L]::uuid[], %L)$$, pg_temp.id('a4'), pg_temp.id('need_el')), 'need_request_class:%', 'a need naming another element refuses need_request_class');
select pg_temp.as_user('alice');
insert into app.procurement_needs (project_id, description, quantity) values (pg_temp.id('prj_a2'), 'Other project', 5);
insert into world select 'need_other', n.id from app.procurement_needs n where n.description = 'Other project';
select pg_temp.as_user('alice');
select throws_like(format($$select app.consolidate_allocations(array[%L]::uuid[], %L)$$, pg_temp.id('a4'), pg_temp.id('need_other')), 'need_request_project:%', 'a need of another project refuses need_request_project');

-- 3. Linking leaves the quantity alone ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select app.consolidate_allocations(array[pg_temp.id('a4')], pg_temp.id('need5'));
select is((select quantity from app.procurement_needs where id = pg_temp.id('need5')), 5::numeric, 'linking to a need leaves its quantity');
select app.unlink_need_request(pg_temp.id('a4'));
select is((select count(*)::integer from app.procurement_need_requests where advance_allocation_id = pg_temp.id('a4') and deleted_at is null), 0, 'unlinking takes it off');
select lives_ok(format($$select app.consolidate_allocations(array[%L]::uuid[], %L)$$, pg_temp.id('a4'), pg_temp.id('need5')), 'and it links again');
select throws_ok($$update app.procurement_need_requests set deleted_at = now()$$, '42501', null, 'no direct writes to links');
select throws_ok(format($$insert into app.procurement_need_requests (procurement_need_id, advance_allocation_id) values (%L, %L)$$, pg_temp.id('need5'), pg_temp.id('decl')), '42501', null, 'no direct inserts either');

-- 4. Capabilities -----------------------------------------------------------------------------------------------------------------------
select pg_temp.producer('nora', 'procurement.po.write');
select pg_temp.producer('peta', 'advancing.packet.read');
insert into world select 'a5', pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_truss', 1);
select pg_temp.as_user('nora');
select throws_ok(format($$select app.consolidate_allocations(array[%L]::uuid[])$$, pg_temp.id('a5')), '42501', null, 'procurement.po.write alone is not enough');
select pg_temp.as_user('peta');
select throws_ok(format($$select app.consolidate_allocations(array[%L]::uuid[])$$, pg_temp.id('a5')), '42501', null, 'advancing.packet.read alone is not enough');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.consolidate_allocations(array[%L]::uuid[])$$, pg_temp.id('a5')), '42501', null, 'another org gets 42501');
select is((select count(*)::integer from app.procurement_needs where id = pg_temp.id('need5')), 0, 'and reads nothing');

-- 5. A pool and its Split children ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into world select 'pool', pg_temp.alloc('request', 'dave', 'eng_vendor_a', 'class', 'cls_radio', 3);
select pg_temp.as_user('carol');
select app.decide_allocation(pg_temp.id('pool'), 'Approved');
insert into world select 'kids', (app.split_allocation(pg_temp.id('pool'), jsonb_build_array(jsonb_build_object('roster_entry_id', pg_temp.id('e_kai'), 'quantity', 1))))[1];
select is((select quantity from app.advance_allocations where id = pg_temp.id('pool')), 2::numeric, 'a split reduces the pool');
insert into world select 'pool_need', (app.consolidate_allocations(array[pg_temp.id('pool')]))[1];
select is((select quantity from app.procurement_needs where id = pg_temp.id('pool_need')), 3::numeric, 'a new need counts a pool plus its live Split children');
select throws_like(format($$select app.consolidate_allocations(array[%L]::uuid[])$$, pg_temp.id('kids')), 'need_request_overlap:%', 'a child of a linked pool refuses need_request_overlap');
select app.unlink_need_request(pg_temp.id('pool'));
select app.consolidate_allocations(array[pg_temp.id('kids')], pg_temp.id('pool_need'));
select throws_like(format($$select app.consolidate_allocations(array[%L]::uuid[])$$, pg_temp.id('pool')), 'need_request_overlap:%', 'a pool with a linked child refuses need_request_overlap');
select app.unlink_need_request(pg_temp.id('kids'));
select throws_like(format($$select app.consolidate_allocations(array[%L, %L]::uuid[])$$, pg_temp.id('pool'), pg_temp.id('kids')), 'need_request_overlap:%', 'a selection of a pool and its child refuses need_request_overlap');

-- 6. Zero sums ----------------------------------------------------------------------------------------------------------------------------
insert into world select 'zero', pg_temp.alloc('request', 'dave', 'e_mo', 'class', 'cls_truss', 1);
select pg_temp.as_platform();
set local session_replication_role = replica;
update app.advance_allocations set quantity = 0 where id = pg_temp.id('zero');
set local session_replication_role = origin;
select pg_temp.as_user('carol');
select throws_like(format($$select app.consolidate_allocations(array[%L]::uuid[])$$, pg_temp.id('zero')), 'need_request_quantity:%', 'a selection summing to 0 refuses need_request_quantity, not a check violation');

-- 7. Order lines ------------------------------------------------------------------------------------------------------------------------------
select pg_temp.order_with('o1', 2);
select pg_temp.as_user('carol');
select lives_ok(format($$update app.po_lines set procurement_need_id = %L where id = %L$$, pg_temp.id('need5'), pg_temp.id('o1_l')), 'a Proposed line takes a need by a normal write');
select lives_ok(format($$update app.po_lines set procurement_need_id = null where id = %L$$, pg_temp.id('o1_l')), 'and drops it');
select pg_temp.approve_order('o1');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.set_po_line_need(%L, %L)$$, pg_temp.id('o1_l'), pg_temp.id('need5')), 'app.set_po_line_need works on a Sent order');
select is((select procurement_need_id from app.po_lines where id = pg_temp.id('o1_l')), pg_temp.id('need5'), 'and the line names the need');
select throws_like(format($$update app.po_lines set description = 'Changed' where id = %L$$, pg_temp.id('o1_l')), 'purchase_order_locked:%', 'every other change still refuses purchase_order_locked');
select throws_like(format($$update app.po_lines set procurement_need_id = null where id = %L$$, pg_temp.id('o1_l')), 'purchase_order_locked:%', 'and so does a direct write of the need');
select throws_like(format($$select app.set_po_line_need(%L, %L)$$, pg_temp.id('o1_l'), pg_temp.id('need_other')), 'need_line_project:%', 'a need of another project refuses need_line_project');
select pg_temp.order_with('o2', 2);
select pg_temp.as_user('carol');
select app.transition_purchase_order(pg_temp.id('o2'), 'Proposed', 'Canceled', 'Not needed.');
select throws_like(format($$select app.set_po_line_need(%L, %L)$$, pg_temp.id('o2_l'), pg_temp.id('need5')), 'need_line_order_state:%', 'a Canceled order refuses need_line_order_state');
-- Units must agree.
update app.procurement_needs set unit_basis = 'each' where id = pg_temp.id('need_el');
select pg_temp.order_with('o3', 2);
select pg_temp.as_user('carol');
update app.po_lines set unit_basis = 'hour' where id = pg_temp.id('o3_l');
select throws_like(format($$select app.set_po_line_need(%L, %L)$$, pg_temp.id('o3_l'), pg_temp.id('need_el')), 'need_line_unit:%', 'another unit than the need refuses need_line_unit');

-- 8. Deleting ------------------------------------------------------------------------------------------------------------------------------
select throws_like(format($$update app.procurement_needs set deleted_at = now() where id = %L$$, pg_temp.id('need5')), 'need_has_links:%', 'a need with live requests and lines refuses need_has_links');
select lives_ok(format($$update app.procurement_needs set deleted_at = now() where id = %L$$, pg_temp.id('need_radio')), 'a need with neither goes');
select pg_temp.as_platform();
select ok(exists (select 1 from private.trash_tables t where t.table_name in ('procurement_needs', 'app.procurement_needs')), 'needs are in Trash');
select ok(exists (select 1 from private.trash_excluded_tables t where t.table_name = 'procurement_need_requests'), 'links are kept out, with a rationale');

-- 9. Atomic quick add ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(cardinality(app.add_procurement_needs(pg_temp.id('prj_a'), '[{"description":"SM58","quantity":12},{"description":"Truss","quantity":4,"note":"Black"}]')), 2, 'two lines add two needs');
select throws_like(format($$select app.add_procurement_needs(%L, '[{"description":"Good","quantity":1},{"description":"Bad","quantity":0}]')$$, pg_temp.id('prj_a')), 'equipment_line_invalid:%', 'one bad line refuses');
select is((select count(*)::integer from app.procurement_needs where description = 'Good'), 0, 'and writes none');
select throws_like(format($$select app.add_procurement_needs(%L, %L::jsonb)$$, pg_temp.id('prj_a'), (select jsonb_agg(jsonb_build_object('description', 'x' || g, 'quantity', 1)) from generate_series(1, 201) g)), 'equipment_too_many:%', 'above 200 lines refuses equipment_too_many');
select pg_temp.order_with('o4', 2);
select pg_temp.as_user('carol');
select is(cardinality(app.add_po_lines(pg_temp.id('o4'), '[{"description":"SM58","quantity":12},{"description":"Truss","quantity":4}]')), 2, 'two lines go on an order');
select is((select max(line_number) from app.po_lines where purchase_order_id = pg_temp.id('o4') and deleted_at is null), 3, 'numbered after its last line');
select throws_like(format($$select app.add_po_lines(%L, '[{"description":"Late","quantity":1}]')$$, pg_temp.id('o1')), 'purchase_order_locked:%', 'an order past Proposed refuses');
select pg_temp.as_user('frank');
select throws_ok(format($$select app.add_procurement_needs(%L, '[{"description":"x","quantity":1}]')$$, pg_temp.id('prj_a')), '42501', null, 'without procurement.po.write, 42501');


select * from finish();
rollback;
