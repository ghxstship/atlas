-- pgTAP: migration 0766, vendor projections (Section 4.4.4 Vendor, Section 8.7). Purchase orders and lines only once
-- sent, for the account's Owner, Admin and Finance while the money area is open; acknowledgment once, by the account,
-- of a Sent order; deliveries and receipts; compliance on file. Denial for a supplied person, another account,
-- another tenant and anon, and the time box.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.move_po(p_expected text, p_next text) returns void language plpgsql as $$
begin
  perform pg_temp.as_platform();
  perform private.transition_lifecycle('purchase_order', 'app.purchase_orders', 'po_state', 'app.purchase_order_state_transitions',
    'purchase_order_id', pg_temp.id('po'), p_expected, p_next, 'Fixture move.');
end $$;

-- Fixture: Bayside Audio as Northwind's vendor, one order with two lines, a shipment, compliance on file ----------------------
select pg_temp.as_user('alice');
with v as (insert into app.vendors (counterparty_id, payment_terms_days) values (pg_temp.id('cp_v_a'), 30) returning id) insert into world select 'ven', id from v;
with p as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po', id from p;
insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor) values
  (pg_temp.id('po'), 1, 'Line array rental', 2, 250000), (pg_temp.id('po'), 2, 'Console rental', 1, 180000);
insert into app.insurance_certificates (vendor_id, insurer, policy_identifier, coverage_type, coverage_limit_minor, currency_code, valid_from, valid_to)
values (pg_temp.id('ven'), 'Fictional Mutual', 'GL-1001', 'General Liability', 100000000, 'USD', current_date - 30, current_date + 335);
insert into app.prequalifications (vendor_id, scope_note) values (pg_temp.id('ven'), 'Touring audio systems.');
insert into app.shipments (project_id, direction, carrier_counterparty_id, tracking_identifier) values (pg_temp.id('prj_a'), 'Inbound', pg_temp.id('cp_v_a'), 'BAY-1001');
insert into app.shipments (project_id, direction, tracking_identifier) values (pg_temp.id('prj_a'), 'Inbound', 'OTHER-2002');
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');

-- Purchase orders --------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('victor', 'select 1 from api_external.purchase_orders'), 0, 'a draft order never reaches the vendor');
select pg_temp.move_po('Proposed', 'Approved');
select is(pg_temp.n('victor', 'select 1 from api_external.purchase_orders'), 0, 'an approved order not yet sent stays internal');
select pg_temp.as_user('victor');
select throws_ok(format($$select app.acknowledge_purchase_order('%s')$$, pg_temp.id('po')), 'XR001', null, 'an unsent order cannot be acknowledged');
select pg_temp.as_platform();
select pg_temp.move_po('Approved', 'Sent');
select is(pg_temp.n('victor', 'select 1 from api_external.purchase_orders'), 1, 'account: the Owner reads the sent order');
select is(pg_temp.n('fiona', 'select 1 from api_external.po_lines'), 2, 'account: Finance reads its lines');
select is(pg_temp.n('sam', 'select 1 from api_external.purchase_orders'), 0, 'denial: the supplied person');
select is(pg_temp.n('ivy', 'select 1 from api_external.purchase_orders'), 0, 'denial: another party');
select is(pg_temp.n('xavier', 'select 1 from api_external.purchase_orders'), 0, 'denial: another tenant');
select pg_temp.as_user('fiona');
select is((select total_minor from api_external.purchase_orders), 680000::bigint, 'the total is derived from priced lines');
select ok((select sent_at is not null and acknowledged_at is null from api_external.purchase_orders), 'sent, not yet acknowledged');
select pg_temp.as_platform();
select hasnt_column('api_external', 'po_lines', 'budget_line_id', 'budget coding never reaches externals');

-- Acknowledgment -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('sam');
select throws_ok(format($$select app.acknowledge_purchase_order('%s')$$, pg_temp.id('po')), '42501', null, 'a supplied person cannot acknowledge');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.acknowledge_purchase_order('%s')$$, pg_temp.id('po')), '42501', null, 'another tenant cannot acknowledge');
select pg_temp.as_user('fiona');
select lives_ok(format($$select app.acknowledge_purchase_order('%s')$$, pg_temp.id('po')), 'Account Finance acknowledges the sent order');
select throws_ok(format($$select app.acknowledge_purchase_order('%s')$$, pg_temp.id('po')), 'XR001', null, 'an order is acknowledged once');
select ok((select acknowledged_at is not null from api_external.purchase_orders), 'the acknowledgment shows on the order');
select pg_temp.as_platform();
select is((select acknowledged_by from app.po_acknowledgments), pg_temp.id('fiona'), 'the acknowledger comes from the session');
select is(pg_temp.n('alice', 'select 1 from app.po_acknowledgments'), 1, 'same tenant: the org reads the acknowledgment');
select is(pg_temp.n('xavier', 'select 1 from app.po_acknowledgments'), 0, 'cross tenant: another org reads none');
select throws_ok('update app.po_acknowledgments set acknowledged_at = now()', 'XR001', null, 'acknowledgments are append-only on every path');
select pg_temp.as_user('fiona');
select throws_ok(format($$insert into app.po_acknowledgments (purchase_order_id) values ('%s')$$, pg_temp.id('po')), '42501', null,
  'acknowledgments are written only through the RPC');
select pg_temp.as_platform();

-- Deliveries and receipts --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with g as (insert into app.goods_receipts (purchase_order_id, note) values (pg_temp.id('po'), 'One case dented.') returning id)
  insert into world select 'gr', id from g;
insert into app.receipt_lines (goods_receipt_id, po_line_id, quantity_received)
select pg_temp.id('gr'), l.id, 2 from app.po_lines l where l.purchase_order_id = pg_temp.id('po') and l.line_number = 1;
select pg_temp.as_platform();
select is(pg_temp.n('victor', 'select 1 from api_external.goods_receipts'), 1, 'the vendor reads what was received');
select is(pg_temp.n('victor', 'select 1 from api_external.receipt_lines'), 1, 'with quantities per line');
select hasnt_column('api_external', 'goods_receipts', 'note', 'receiving notes never reach externals');
select is(pg_temp.n('sam', 'select 1 from api_external.deliveries'), 1, 'account: an Account Member reads the account''s delivery (operational area)');
select is(pg_temp.n('victor', 'select 1 from api_external.deliveries'), 1, 'account: the Owner reads only the account''s own shipment');
select is(pg_temp.n('fiona', 'select 1 from api_external.deliveries'), 0, 'Account Finance has no operational area');

-- Compliance on file ----------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('victor', 'select 1 from api_external.vendor_insurance_certificates where is_current'), 1, 'the account reads its current certificate');
select is(pg_temp.n('fiona', 'select 1 from api_external.vendor_prequalifications'), 1, 'and its prequalification');
select is(pg_temp.n('sam', 'select 1 from api_external.vendor_insurance_certificates'), 0, 'denial: the supplied person');
select is(pg_temp.n('cora', 'select 1 from api_external.vendor_prequalifications'), 0, 'denial: an unrelated person');
select hasnt_column('api_external', 'vendor_prequalifications', 'decided_by', 'who decided never reaches externals');

-- Time box ----------------------------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select is(pg_temp.n('victor', 'select 1 from api_external.deliveries'), 0, 'Complete: deliveries close with the operational area');
select is(pg_temp.n('victor', 'select 1 from api_external.purchase_orders'), 1, 'Complete: orders stay readable in the money area');
select pg_temp.backdate_close('eng_vendor_a', interval '19 months');
select is(pg_temp.n('victor', 'select 1 from api_external.purchase_orders'), 0, 'after 18 months orders close');
select is(pg_temp.n('victor', 'select 1 from api_external.vendor_insurance_certificates'), 0, 'and compliance with them');
select pg_temp.as_anon();
select throws_ok('select 1 from api_external.purchase_orders', '42501', null, 'anon deny');
select pg_temp.as_platform();

select * from finish();
rollback;
