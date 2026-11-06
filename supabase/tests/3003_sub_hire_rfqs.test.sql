-- pgTAP: migration 3003 (B11, G-97), sub-hire RFQ drafts. Shortages against own stock, other projects' holds, windows
-- that never overlap, a rental that covers one allocation, past events, the draft and its replay, request lines locked
-- after issue, response lines naming their line, and the journey from shortage to rental order.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 3001_supply_world.psql

select no_plan();

create function pg_temp.short(p_class text, p_project text default 'prj_a') returns numeric language plpgsql as $$
declare v numeric;
begin
  perform pg_temp.as_user('carol');
  select s.short_quantity into v from app.asset_shortages(pg_temp.id('org_a'), pg_temp.id(p_project)) s where s.asset_class_id = pg_temp.id(p_class);
  return v;
end $$;

-- Ten truss units, nothing asked: no row.
select is(pg_temp.short('cls_truss'), null::numeric, 'nothing asked for, nothing short');
insert into world select 'a1', pg_temp.alloc('request', 'dave', 'eng_vendor_a', 'class', 'cls_truss', 15);
select is(pg_temp.short('cls_truss'), 5::numeric, 'own stock of 10 against 15 requested gives short 5');
select pg_temp.as_user('carol');
select is((select s.time_zone from app.asset_shortages(pg_temp.id('org_a'), pg_temp.id('prj_a')) s where s.asset_class_id = pg_temp.id('cls_truss')),
  (select p.time_zone from app.projects p where p.id = pg_temp.id('prj_a')), 'the row carries the project''s time zone, to read its window in');
select pg_temp.as_user('carol');
select ok(not exists (
  select 1 from information_schema.parameters p join information_schema.routines r on r.specific_name = p.specific_name
  where r.routine_schema = 'app' and r.routine_name = 'asset_shortages' and p.parameter_name ilike '%price%'), 'no price column');

-- Two allocations that never overlap do not add up.
select pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_radio', 3, null, null, '2027-08-01 12:00+00', '2027-08-02 12:00+00');
select pg_temp.alloc('request', 'dave', 'e_mo', 'class', 'cls_radio', 3, null, null, '2027-09-01 12:00+00', '2027-09-02 12:00+00');
select is(pg_temp.short('cls_radio'), null::numeric, 'two allocations of 3 that never overlap fit four units');

-- Past events never shout.
select pg_temp.as_platform();
set local session_replication_role = replica;
update app.advance_allocations set needed_during = tstzrange(now() - interval '10 days', now() - interval '9 days', '[)') where id = pg_temp.id('a1');
set local session_replication_role = origin;
select is(pg_temp.short('cls_truss'), null::numeric, 'an allocation that has ended is not short');
select pg_temp.as_platform();
set local session_replication_role = replica;
update app.advance_allocations set needed_during = tstzrange('2027-06-01 12:00+00', '2027-06-05 12:00+00', '[)') where id = pg_temp.id('a1');
set local session_replication_role = origin;

-- Another project's live holds count. Two of the ten truss units go to prj_a2 on the same days.
select pg_temp.as_user('alice');
insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
values (pg_temp.id('prj_a2'), pg_temp.id('sam'), pg_temp.id('cp_v_a'), 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2027-06-01');
insert into world select 'eng_a2', e.id from app.engagements e where e.project_id = pg_temp.id('prj_a2') and e.counterparty_id = pg_temp.id('cp_v_a');
select pg_temp.move_engagement('eng_a2', 'Onboarding', 'Active');
select pg_temp.as_user('alice');
insert into world select 'held', app.assign_allocation(pg_temp.id('prj_a2'), pg_temp.id('eng_a2'), null, null, pg_temp.id('cls_truss'), null, null, null,
  2, '2027-06-02 12:00+00', '2027-06-03 12:00+00', 'America/New_York', null, null);
select is(pg_temp.short('cls_truss'), 7::numeric, 'another project''s live holds raise the shortage');
select pg_temp.as_user('alice');
select app.withdraw_allocation(pg_temp.id('held'), 'Not needed.');
select is(pg_temp.short('cls_truss'), 5::numeric, 'and a withdrawn hold stops counting');

-- A rental that covers one allocation is not hired twice.
select pg_temp.as_user('carol');
insert into app.asset_classes (org_id, element_id, name) values (pg_temp.id('org_a'), '3000.05.01-GHXST-015', 'Large Projectors');
insert into world select 'cls_proj', id from app.asset_classes where name = 'Large Projectors';
select pg_temp.order_with('rent1', 2, null, 'ven', '3000.05.01-GHXST-015', 'Rental', '[2027-06-01 00:00+00,2027-06-03 00:00+00)');
select pg_temp.approve_order('rent1');
select pg_temp.alloc('request', 'dave', 'e_kai', 'class', 'cls_proj', 2, null, null, '2027-06-01 12:00+00', '2027-06-02 12:00+00');
select is(pg_temp.short('cls_proj'), null::numeric, 'a rental that contains the allocation covers it');
select pg_temp.alloc('request', 'dave', 'e_mo', 'class', 'cls_proj', 1, null, null, '2027-07-10 12:00+00', '2027-07-11 12:00+00');
select is(pg_temp.short('cls_proj'), 1::numeric, 'the later allocation alone is short');
select pg_temp.as_user('carol');
select is((select window_from from app.asset_shortages(pg_temp.id('org_a'), pg_temp.id('prj_a')) s where s.asset_class_id = pg_temp.id('cls_proj')), '2027-07-10 12:00+00'::timestamptz,
  'and the window is only the allocations that are short, so the rental is not bought again');

-- Who reads it.
select pg_temp.producer('buyer', 'procurement.po.read');
select pg_temp.producer('adv', 'advancing.packet.read');
select pg_temp.producer('none', 'assets.asset.read');
select pg_temp.as_user('buyer');
select ok(exists (select 1 from app.asset_shortages(pg_temp.id('org_a'))), 'procurement.po.read reads shortages');
select pg_temp.as_user('adv');
select ok(exists (select 1 from app.asset_shortages(pg_temp.id('org_a'))), 'so does advancing.packet.read');
select is((select count(open_need_id)::integer from app.asset_shortages(pg_temp.id('org_a'))), 0, 'without the need');
select pg_temp.as_user('none');
select is((select count(*)::integer from app.asset_shortages(pg_temp.id('org_a'))), 0, 'other projects are omitted');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.asset_shortages(pg_temp.id('org_a'))), 0, 'another org reads nothing');

-- The draft.
select pg_temp.as_user('carol');
insert into world values ('evt', gen_random_uuid());
select is(app.create_sub_hire_rfq(pg_temp.id('evt'), pg_temp.id('prj_a'), array[pg_temp.id('cls_truss')], 'Sub-hire truss'), pg_temp.id('evt'), 'the event id is the RFQ id');
select is((select rfq_state::text from app.rfqs where id = pg_temp.id('evt')), 'Proposed', 'the draft is Proposed');
select is((select count(*)::integer from app.rfq_invitations where rfq_id = pg_temp.id('evt')), 0, 'with no invitations');
select is((select acquisition_kind::text from app.rfq_lines where rfq_id = pg_temp.id('evt')), 'Rental', 'one Rental line');
select is((select quantity from app.rfq_lines where rfq_id = pg_temp.id('evt')), 5::numeric, 'of the short quantity');
select is((select hire_period from app.rfq_lines where rfq_id = pg_temp.id('evt')), tstzrange('2027-06-01 12:00+00', '2027-06-05 12:00+00', '[)'), 'hired for the window');
select is((select element_id from app.rfq_lines where rfq_id = pg_temp.id('evt')), '3000.05.01-GHXST-014', 'of the class element');
insert into world select 'need', procurement_need_id from app.rfq_lines where rfq_id = pg_temp.id('evt');
select is((select quantity from app.procurement_needs where id = pg_temp.id('need')), 5::numeric, 'with a need of quantity 5');
select is((select open_rfq_id from app.asset_shortages(pg_temp.id('org_a'), pg_temp.id('prj_a')) s where s.asset_class_id = pg_temp.id('cls_truss')), pg_temp.id('evt'), 'the shortage names the open RFQ');
select is((select count(*)::integer from app.rfq_lines where rfq_id = pg_temp.id('evt')), 1, 'before replay');
select is(app.create_sub_hire_rfq(pg_temp.id('evt'), pg_temp.id('prj_a'), array[pg_temp.id('cls_truss')], 'Sub-hire truss'), pg_temp.id('evt'), 'a replay returns the same RFQ');
select is((select count(*)::integer from app.rfq_lines where rfq_id = pg_temp.id('evt')), 1, 'and changes no row counts');
select pg_temp.as_user('alice');
select throws_like(format($$select app.create_sub_hire_rfq(%L, %L, array[%L]::uuid[], 'Elsewhere')$$, pg_temp.id('evt'), pg_temp.id('prj_a2'), pg_temp.id('cls_truss')), 'rfq_event_reused:%', 'another project refuses rfq_event_reused');
select pg_temp.as_user('carol');
select throws_like(format($$select app.create_sub_hire_rfq(gen_random_uuid(), %L, array[%L]::uuid[], 'Again')$$, pg_temp.id('prj_a'), pg_temp.id('cls_truss')), 'sub_hire_rfq_open:%', 'a new event id while the need has an open RFQ refuses sub_hire_rfq_open');
select throws_like(format($$select app.create_sub_hire_rfq(gen_random_uuid(), %L, array[%L]::uuid[], 'Covered')$$, pg_temp.id('prj_a'), pg_temp.id('cls_radio')), 'sub_hire_not_short:%', 'a covered class refuses sub_hire_not_short');
select pg_temp.as_user('buyer');
select throws_ok(format($$select app.create_sub_hire_rfq(gen_random_uuid(), %L, array[%L]::uuid[], 'No')$$, pg_temp.id('prj_a'), pg_temp.id('cls_truss')), '42501', null, 'without the write capabilities, 42501');
select pg_temp.as_user('carol');
select throws_like(format($$select app.transition_rfq(%L, 'Proposed', 'Issued', 'Go.')$$, pg_temp.id('evt')), 'rfq_no_invitations:%', 'issue still refuses until a vendor is invited');

-- Lines.
select pg_temp.as_user('alice');
insert into world select 'n_a2', (app.add_procurement_needs(pg_temp.id('prj_a2'), '[{"description":"Elsewhere","quantity":1}]'))[1];
select throws_like(format($$insert into app.rfq_lines (rfq_id, description, quantity, procurement_need_id) values (%L, 'Foreign need', 1, %L)$$, pg_temp.id('evt'), pg_temp.id('n_a2')), 'rfq_line_need:%', 'a need of another project refuses rfq_line_need');
select pg_temp.as_user('carol');
insert into app.rfq_lines (rfq_id, description, quantity) values (pg_temp.id('evt'), 'Spare clamps', 8);
select is((select max(line_number) from app.rfq_lines where rfq_id = pg_temp.id('evt') and deleted_at is null), 2, 'a line takes the next number');
insert into app.rfq_invitations (rfq_id, vendor_id) values (pg_temp.id('evt'), pg_temp.id('ven'));
select lives_ok(format($$select app.transition_rfq(%L, 'Proposed', 'Issued', 'Go.')$$, pg_temp.id('evt')), 'with an invitation it issues');
select throws_like(format($$update app.rfq_lines set quantity = 99 where rfq_id = %L$$, pg_temp.id('evt')), 'rfq_line_locked:%', 'lines refuse rfq_line_locked after issue');
select throws_like(format($$insert into app.rfq_lines (rfq_id, description, quantity) values (%L, 'Late', 1)$$, pg_temp.id('evt')), 'rfq_line_locked:%', 'and take no new line');

-- Responses.
insert into world select 'rl', id from app.rfq_lines where rfq_id = pg_temp.id('evt') and line_number = 1;
insert into app.rfqs (id, project_id, title) values (gen_random_uuid(), pg_temp.id('prj_a'), 'Another RFQ');
insert into world select 'other', id from app.rfqs where title = 'Another RFQ';
insert into app.rfq_lines (rfq_id, description, quantity) values (pg_temp.id('other'), 'Other line', 1);
insert into world select 'rl_other', id from app.rfq_lines where rfq_id = pg_temp.id('other');
select throws_like(format($$select app.record_rfq_response(%L, %L, null, 'USD', jsonb_build_array(jsonb_build_object('description', 'Wrong line', 'quantity', 1, 'unit_price_minor', 100, 'rfq_line_id', %L::text)))$$,
  pg_temp.id('evt'), pg_temp.id('ven'), pg_temp.id('rl_other')), 'rfq_response_line_line:%', 'a response line naming another RFQ''s line refuses rfq_response_line_line');

-- The journey: quote, close, award, order from the response.
select lives_ok(format($$select app.record_rfq_response(%L, %L, null, 'USD', jsonb_build_array(jsonb_build_object('description', 'Truss on hire', 'quantity', 5, 'unit_price_minor', 2000, 'rfq_line_id', %L::text)))$$,
  pg_temp.id('evt'), pg_temp.id('ven'), pg_temp.id('rl')), 'a quote records against the line');
select app.transition_rfq(pg_temp.id('evt'), 'Issued', 'Closed', 'Quotes in.');
select pg_temp.as_user('alice');
select app.transition_rfq(pg_temp.id('evt'), 'Closed', 'Awarded', 'Harborline.');
select pg_temp.as_platform();
select is((select l.element_id from app.rfq_response_lines l where l.rfq_line_id = pg_temp.id('rl')), '3000.05.01-GHXST-014', 'the response line defaults its element from the request line, or the shortage would never clear');
select pg_temp.as_user('carol');
select pg_temp.as_platform();
insert into world select 'resp', s.id from app.rfq_responses s where s.rfq_id = pg_temp.id('evt');
select pg_temp.as_user('carol');
with o as (insert into app.purchase_orders (project_id, vendor_id, currency_code, rfq_response_id)
  values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD', pg_temp.id('resp')) returning id) insert into world select 'po_sh', id from o;
insert into app.po_lines (purchase_order_id, line_number, description, element_id, quantity, unit_price_minor, acquisition_kind, hire_period, procurement_need_id)
select pg_temp.id('po_sh'), 1, l.description, l.element_id, l.quantity, l.unit_price_minor, q.acquisition_kind, q.hire_period, q.procurement_need_id
from app.rfq_response_lines l join app.rfq_lines q on q.id = l.rfq_line_id where l.rfq_line_id = pg_temp.id('rl');
select is(pg_temp.short('cls_truss'), null::numeric, 'a Proposed rental order already clears the shortage');
select is((pg_temp.need(pg_temp.id('need'))).need_status, 'Needs Ordered', 'while the need still reads Needs Ordered');
select is((pg_temp.need(pg_temp.id('need'))).drafted_quantity, 5::numeric, 'with 5 drafted');
select pg_temp.approve_order('po_sh');
select is((pg_temp.need(pg_temp.id('need'))).need_status, 'On Order', 'after approval the need reads On Order');
select is(pg_temp.short('cls_truss'), null::numeric, 'and the shortage row is gone');

select * from finish();
rollback;
