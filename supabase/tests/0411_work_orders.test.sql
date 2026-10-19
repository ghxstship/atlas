-- pgTAP: work orders and bids (0411). Same-tenant allow, cross-tenant deny, anon deny, role bands,
-- numbering and display keys, the lifecycle (every rule allowed and representative moves refused),
-- the award rules (creator refused, unpriced and withdrawn bids refused, award RPC only), bid
-- window and immutability, retention, the ledger and the domain events.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(38);

create function pg_temp.wo_state(p_key text) returns text
language sql as $$ select work_order_state::text from app.work_orders where id = pg_temp.id(p_key) $$;

-- Creation and keys ------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.work_orders (project_id, title, scope_of_work) values (pg_temp.id('prj_a'), 'Rig the Main Stage Truss', 'Supply and hang 40 ft of box truss.') returning id)
  insert into world select 'wo1', id from x;
with x as (insert into app.work_orders (project_id, title) values (pg_temp.id('prj_a'), 'Install Barricade Line') returning id)
  insert into world select 'wo2', id from x;
select is((select app.work_order_display_key(w) from app.work_orders w where w.id = pg_temp.id('wo1')), 'NWL-WO-1', 'the first work order of the project is NWL-WO-1');
select is((select app.work_order_display_key(w) from app.work_orders w where w.id = pg_temp.id('wo2')), 'NWL-WO-2', 'the next is NWL-WO-2');
select is(pg_temp.wo_state('wo1'), 'Draft', 'a new work order is Draft');
select is((select count(*)::int from app.work_order_state_transitions where work_order_id = pg_temp.id('wo1') and from_state is null), 1, 'creation writes the first ledger entry');
select throws_ok($$insert into app.work_orders (project_id, title, work_order_state) values ((select id from world where key = 'prj_a'), 'Paint the Fence', 'Open')$$,
  'XR001', null, 'a work order starts Draft');
select throws_ok($$update app.work_orders set work_order_number = 9 where id = (select id from world where key = 'wo1')$$, 'XR001', null, 'a work order keeps its number');
select throws_ok($$update app.work_orders set project_id = (select id from world where key = 'prj_a2') where id = (select id from world where key = 'wo1')$$, 'XR001', null, 'a work order stays in its project');
select throws_ok($$insert into app.work_orders (project_id, scope_node_id, title) values ((select id from world where key = 'prj_a'), (select id from world where key = 'root_a2'), 'Paint the Fence')$$,
  'XR001', null, 'the scope node belongs to the work order''s project');
select throws_ok($$update app.work_orders set work_order_state = 'Open' where id = (select id from world where key = 'wo1')$$, 'XR001', null, 'the state changes only through the RPC');

-- Visibility and bands -----------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select count(*)::int from app.work_orders where project_id = pg_temp.id('prj_a')), 2, 'a Field project member reads the project''s work orders');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.work_orders where project_id = pg_temp.id('prj_a')), 2, 'a Manager reads every project''s work orders (oversight)');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.work_orders where project_id = pg_temp.id('prj_a')), 0, 'a Viewer outside the project reads none of its work orders (invariant 2)');
select throws_ok($$insert into app.work_orders (project_id, title) values ((select id from world where key = 'prj_a'), 'Paint the Fence')$$,
  '42501', null, 'a Viewer cannot create a work order');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.work_orders), 0, 'another org reads no work orders');
select is((select count(*)::int from app.work_order_bids), 0, 'another org reads no bids');
select pg_temp.as_anon();
select throws_ok($$select count(*) from app.work_orders$$, '42501', null, 'anon cannot read work orders');

-- Bids ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.work_order_bids (work_order_id, bidder_organization_id, amount_minor, currency_code) values (pg_temp.id('wo1'), pg_temp.id('org_b'), 1250000, 'USD') returning id)
  insert into world select 'bid_priced', id from x;
with x as (insert into app.work_order_bids (work_order_id, bidder_person_id, currency_code, note) values (pg_temp.id('wo1'), pg_temp.id('frank'), 'USD', 'Price to follow after the site walk.') returning id)
  insert into world select 'bid_unpriced', id from x;
with x as (insert into app.work_order_bids (work_order_id, bidder_organization_id, amount_minor, currency_code) values (pg_temp.id('wo1'), pg_temp.id('org_p'), 990000, 'USD') returning id)
  insert into world select 'bid_withdrawn', id from x;
select is((select amount_minor from app.work_order_bids where id = pg_temp.id('bid_unpriced')), null::bigint, 'a bid without a price stays NULL, never zero');
select throws_ok($$insert into app.work_order_bids (work_order_id, currency_code, amount_minor) values ((select id from world where key = 'wo1'), 'USD', 10)$$,
  '23514', null, 'a bid names exactly one bidder');
select lives_ok($$update app.work_order_bids set withdrawn_at = now() where id = (select id from world where key = 'bid_withdrawn')$$, 'a bid can be withdrawn');
select throws_ok($$update app.work_order_bids set withdrawn_at = null where id = (select id from world where key = 'bid_withdrawn')$$, 'XR001', null, 'a withdrawn bid stays withdrawn');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'work_order_bid.submitted' and subject_id = pg_temp.id('wo1')), 3, 'each bid emits work_order_bid.submitted');

-- Lifecycle ------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$select app.transition_work_order((select id from world where key = 'wo1'), 'Draft', 'Open', 'Bids invited.')$$, 'Draft to Open');
select throws_ok($$select app.transition_work_order((select id from world where key = 'wo1'), 'Open', 'Awarded', 'Picked.')$$, 'XR001', null, 'Awarded is reached only through the award RPC');
select throws_ok($$select app.transition_work_order((select id from world where key = 'wo1'), 'Open', 'Complete', 'Done.')$$, 'XR001', 'work_order_transition_not_allowed: A work order cannot move from Open to Complete.', 'Open cannot jump to Complete');
select throws_ok($$select app.transition_work_order((select id from world where key = 'wo1'), 'Draft', 'Open', 'Again.')$$, 'XR001', null, 'the expected state must match');
select throws_ok($$update app.work_orders set awarded_bid_id = (select id from world where key = 'bid_priced') where id = (select id from world where key = 'wo1')$$, 'XR001', null, 'the award is set only through the award RPC');

-- Award --------------------------------------------------------------------------------------------------
select throws_ok($$select app.award_work_order((select id from world where key = 'wo1'), (select id from world where key = 'bid_priced'), 'Lowest bid.')$$,
  'XR001', 'sod_work_order_award: A work order is awarded by someone other than the person who created it.', 'the creator cannot award their own work order');
select pg_temp.as_user('carol');
select throws_ok($$select app.award_work_order((select id from world where key = 'wo1'), (select id from world where key = 'bid_unpriced'), 'Best fit.')$$,
  'XR001', null, 'an unpriced bid cannot be awarded');
select throws_ok($$select app.award_work_order((select id from world where key = 'wo1'), (select id from world where key = 'bid_withdrawn'), 'Cheapest.')$$,
  'XR001', null, 'a withdrawn bid cannot be awarded');
select pg_temp.as_user('gina');
select throws_ok($$select app.award_work_order((select id from world where key = 'wo1'), (select id from world where key = 'bid_priced'), 'Lowest bid.')$$,
  '42501', null, 'a Viewer cannot award');
select pg_temp.as_user('carol');
select lives_ok($$select app.award_work_order((select id from world where key = 'wo1'), (select id from world where key = 'bid_priced'), 'Lowest priced bid.')$$, 'another eligible person awards a priced bid');
select is(pg_temp.wo_state('wo1'), 'Awarded', 'the work order is Awarded');
select is((select awarded_bid_id from app.work_orders where id = pg_temp.id('wo1')), pg_temp.id('bid_priced'), 'the awarded bid is recorded');
select throws_ok($$update app.work_order_bids set amount_minor = 1 where id = (select id from world where key = 'bid_priced')$$, 'XR001', null, 'an awarded bid never changes');
select throws_ok($$insert into app.work_order_bids (work_order_id, bidder_organization_id, amount_minor, currency_code) values ((select id from world where key = 'wo1'), (select id from world where key = 'org_b'), 5, 'USD')$$,
  'XR001', null, 'bids close once the work order is awarded');
select lives_ok($$select app.transition_work_order((select id from world where key = 'wo1'), 'Awarded', 'In Progress', 'Crew on site.')$$, 'Awarded to In Progress');
select lives_ok($$select app.transition_work_order((select id from world where key = 'wo1'), 'In Progress', 'Complete', 'Truss signed off.')$$, 'In Progress to Complete');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where subject_id = pg_temp.id('wo1') and event_type in ('work_order.awarded', 'work_order.state_changed')), 5,
  'the award and every state change are emitted');

select * from finish();
rollback;
