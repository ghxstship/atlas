-- pgTAP: 2140, bulk edit of purchase orders, RFQs and vendors (A120, RRR-165, Section 11.7). Each resource previews
-- without changing anything, commits all or nothing, checks the capability on every row, and sends its inverse back
-- through the same RPC. A bulk approval keeps every rule of a single one: one order the creator may not approve, one
-- an Active approval policy holds, one above the approver's spend limit or one needing a second approver refuses the
-- whole call.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(69);

create function pg_temp.bulk(p_resource text, p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language plpgsql as $$
begin
  return case p_resource
    when 'purchase_orders' then app.bulk_update_purchase_orders(p_rows, p_preview, p_reason)
    when 'rfqs' then app.bulk_update_rfqs(p_rows, p_preview, p_reason)
    when 'vendors' then app.bulk_update_vendors(p_rows, p_preview, p_reason)
  end;
end $$;

-- The same values for each named row.
create function pg_temp.rows(p_keys text[], p_set jsonb) returns jsonb
language sql as $$
  select jsonb_agg(jsonb_build_object('id', pg_temp.id(k), 'set', p_set) order by o) from unnest(p_keys) with ordinality u(k, o);
$$;

create temporary table answer (r jsonb);
grant all on answer to public;

-- Fixtures ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into world values ('cp_1', app.create_counterparty(pg_temp.id('org_a'), 'Harborline Staging', 'Equipment Rental'));
insert into world values ('cp_2', app.create_counterparty(pg_temp.id('org_a'), 'Quayside Audio', 'Audio Supply'));
insert into world values ('cp_3', app.create_counterparty(pg_temp.id('org_a'), 'Pierpoint Rigging', 'Equipment Rental'));
select pg_temp.as_user('xavier');
insert into world values ('cp_b', app.create_counterparty(pg_temp.id('org_b'), 'Dockside Lighting', null));
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_b')) returning id) insert into world select 'vb', id from x;
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id, payment_terms_days) values (pg_temp.id('cp_1'), 30) returning id) insert into world select 'v1', id from x;
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_2')) returning id) insert into world select 'v2', id from x;
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_3')) returning id) insert into world select 'v3', id from x;
select pg_temp.as_platform();

-- Vendors ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('vendors', pg_temp.rows(array['v1', 'v2'], '{"vendor_state": "Onboarded"}'), true) r) x),
  '2', 'a vendor preview counts the rows that would change');
select is((select count(*)::int from app.vendors where id in (pg_temp.id('v1'), pg_temp.id('v2')) and vendor_state = 'Prospect'), 2,
  'and changes nothing');

insert into answer select pg_temp.bulk('vendors', pg_temp.rows(array['v1', 'v2'], '{"vendor_state": "Onboarded"}'), false, 'Paperwork in.');
select is((select r ->> 'committed' from answer), 'true', 'vendors move along their lifecycle in bulk');
select is((select count(*)::int from app.vendors where id in (pg_temp.id('v1'), pg_temp.id('v2')) and vendor_state = 'Onboarded'), 2,
  'both vendors are Onboarded');
select is((select count(*)::int from app.vendor_state_transitions where vendor_id in (pg_temp.id('v1'), pg_temp.id('v2')) and reason = 'Paperwork in.'), 2,
  'through app.transition_vendor, each move in the ledger with the reason');

delete from answer;
insert into answer select pg_temp.bulk('vendors', pg_temp.rows(array['v1', 'v2'], '{"payment_terms_days": 45, "default_currency_code": "USD"}'));
select is((select (r ->> 'changed')::int from answer), 2, 'payment terms and the default currency change in bulk');
select is((select payment_terms_days from app.vendors where id = pg_temp.id('v2')), 45, 'the terms land');
select is((select default_currency_code::text from app.vendors where id = pg_temp.id('v1')), 'USD', 'and so does the currency');
select is((select r -> 'inverse' -> 0 -> 'set' -> 'payment_terms_days' from answer), '30'::jsonb, 'the inverse holds the terms before');
select is(
  (select r ->> 'committed' from (select pg_temp.bulk('vendors', (select r -> 'inverse' from answer)) r) x),
  'true', 'sending the inverse back undoes the change');
select is((select payment_terms_days from app.vendors where id = pg_temp.id('v1')), 30, 'the first vendor has its terms back');
select is((select default_currency_code from app.vendors where id = pg_temp.id('v2')), null, 'and the second has no default currency again');

delete from answer;
insert into answer select pg_temp.bulk('vendors',
  jsonb_build_array(
    jsonb_build_object('id', pg_temp.id('v1'), 'set', jsonb_build_object('vendor_state', 'Active')),
    jsonb_build_object('id', pg_temp.id('v3'), 'set', jsonb_build_object('vendor_state', 'Active'))));
select is((select r ->> 'committed' from answer), 'false', 'one move the vendor lifecycle forbids commits nothing');
select is((select vendor_state::text from app.vendors where id = pg_temp.id('v1')), 'Onboarded', 'so the allowed vendor stays Onboarded');
select is((select r -> 'refused' -> 0 ->> 'id' from answer), pg_temp.id('v3')::text, 'the refusal names the Prospect');
select is((select r -> 'refused' -> 0 ->> 'rule' from answer), 'vendor_transition_not_allowed', 'with the lifecycle''s rule');

select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('vendors', pg_temp.rows(array['v1'], jsonb_build_object('counterparty_id', pg_temp.id('cp_2'))))  r) x),
  'bulk_field_not_editable', 'a vendor keeps its company');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('vendors', pg_temp.rows(array['v1'], '{"account_number": "0001-2345-6789"}'))  r) x),
  'bulk_field_not_editable', 'and bank details never change in bulk');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('vendors', pg_temp.rows(array['v1'], '{"payment_terms_days": -5}'))  r) x),
  'invalid', 'the table''s checks still apply');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('vendors', pg_temp.rows(array['vb'], '{"payment_terms_days": 15}'))  r) x),
  'bulk_row_not_found', 'another org''s vendor reads as not found');

select pg_temp.as_user('dave');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('vendors', pg_temp.rows(array['v1'], '{"payment_terms_days": 15}'))  r) x),
  'not_allowed', 'a Member who reads vendors cannot change them');
select pg_temp.as_user('xavier');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('vendors', pg_temp.rows(array['v1'], '{"payment_terms_days": 15}'))  r) x),
  'bulk_row_not_found', 'another org cannot change them');
select pg_temp.as_anon();
select throws_ok($$select app.bulk_update_vendors('[]'::jsonb)$$, '42501', null, 'anon cannot call vendor bulk edit');
select pg_temp.as_platform();
select is((select payment_terms_days from app.vendors where id = pg_temp.id('v1')), 30, 'no refused call changed the vendor');

-- RFQs ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.rfqs (project_id, title) values (pg_temp.id('prj_a'), 'Stage Package') returning id) insert into world select 'r1', id from x;
with x as (insert into app.rfqs (project_id, title) values (pg_temp.id('prj_a'), 'Audio Package') returning id) insert into world select 'r2', id from x;
with x as (insert into app.rfqs (project_id, title) values (pg_temp.id('prj_a'), 'Rigging Package') returning id) insert into world select 'r3', id from x;
with x as (insert into app.rfqs (project_id, title) values (pg_temp.id('prj_a'), 'Lighting Package') returning id) insert into world select 'r4', id from x;
insert into app.rfq_invitations (rfq_id, vendor_id) values
  (pg_temp.id('r1'), pg_temp.id('v1')), (pg_temp.id('r2'), pg_temp.id('v2')), (pg_temp.id('r4'), pg_temp.id('v1'));

select is(
  (select r ->> 'changed' from (select pg_temp.bulk('rfqs', pg_temp.rows(array['r1', 'r2'], '{"rfq_state": "Issued"}'), true) r) x),
  '2', 'an RFQ preview counts the rows that would change');
delete from answer;
insert into answer select pg_temp.bulk('rfqs', pg_temp.rows(array['r1', 'r2'], '{"rfq_state": "Issued"}'), false, 'Specification is final.');
select is((select r ->> 'committed' from answer), 'true', 'RFQs are issued in bulk');
select is((select count(*)::int from app.rfqs where id in (pg_temp.id('r1'), pg_temp.id('r2')) and rfq_state = 'Issued'), 2, 'both are Issued');
select is((select count(*)::int from app.rfq_state_transitions where rfq_id = pg_temp.id('r1') and reason = 'Specification is final.'), 1,
  'through app.transition_rfq, with the reason in the ledger');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('rfqs', (select r -> 'inverse' from answer)) r) x),
  'rfq_transition_not_allowed', 'an undo the lifecycle forbids is refused');
select is((select rfq_state::text from app.rfqs where id = pg_temp.id('r1')), 'Issued', 'so the RFQ stays Issued');

delete from answer;
insert into answer select pg_temp.bulk('rfqs', pg_temp.rows(array['r4', 'r3'], '{"rfq_state": "Issued"}'));
select is((select r ->> 'committed' from answer), 'false', 'an RFQ without an invited vendor refuses the whole call');
select is((select r -> 'refused' -> 0 ->> 'rule' from answer), 'rfq_no_invitations', 'with the rule a single issue meets');
select is((select rfq_state::text from app.rfqs where id = pg_temp.id('r4')), 'Proposed', 'and the invited RFQ is not issued either');

select is(
  (select r ->> 'changed' from (select pg_temp.bulk('rfqs', pg_temp.rows(array['r1'], '{"rfq_state": "Closed"}'), false, 'Deadline passed.') r) x),
  '1', 'closing in bulk unseals the responses');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('rfqs', pg_temp.rows(array['r1'], '{"rfq_state": "Awarded"}')) r) x),
  'bulk_field_not_editable', 'awarding stays a single move');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('rfqs', pg_temp.rows(array['r1'], '{"title": "Stage and Truss Package"}')) r) x),
  'bulk_field_not_editable', 'only the state of an RFQ changes in bulk');

select pg_temp.as_user('gina');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('rfqs', pg_temp.rows(array['r4'], '{"rfq_state": "Canceled"}')) r) x),
  'bulk_row_not_found', 'a Viewer outside the project cannot change its RFQs');
select pg_temp.as_user('xavier');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('rfqs', pg_temp.rows(array['r4'], '{"rfq_state": "Canceled"}')) r) x),
  'bulk_row_not_found', 'another org cannot change them');
select pg_temp.as_platform();

-- Purchase orders: approval keeps every rule of a single approval ----------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('v1'), 'USD') returning id) insert into world select 'po1', id from x;
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('v1'), 'USD') returning id) insert into world select 'po2', id from x;
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('v2'), 'USD') returning id) insert into world select 'po3', id from x;
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('v2'), 'USD') returning id) insert into world select 'po4', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor) values
  (pg_temp.id('po1'), 1, 'Stage deck sections.', 2, 10000),
  (pg_temp.id('po2'), 1, 'Truss package.', 1, 50000),
  (pg_temp.id('po3'), 1, 'Monitor wedges.', 1, 10000),
  (pg_temp.id('po4'), 1, 'Cable ramps.', 4, null);
select pg_temp.as_user('alice');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor)
values (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Purchase Order', 'USD', 30000);
select pg_temp.as_platform();

select pg_temp.as_user('carol');
delete from answer;
insert into answer select pg_temp.bulk('purchase_orders', pg_temp.rows(array['po1'], '{"po_state": "Approved"}'));
select is((select r -> 'refused' -> 0 ->> 'rule' from answer), 'sod_po_creator', 'the creator cannot approve their order in bulk either');

select pg_temp.as_user('bob');
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('purchase_orders', pg_temp.rows(array['po1', 'po3'], '{"po_state": "Approved"}'), true) r) x),
  '2', 'an approval preview counts the orders it would approve');
select is((select count(*)::int from app.spend_approvals where document_id in (pg_temp.id('po1'), pg_temp.id('po3'))), 0,
  'and records no approval');

delete from answer;
insert into answer select pg_temp.bulk('purchase_orders', pg_temp.rows(array['po1', 'po2'], '{"po_state": "Approved"}'), false, 'Within budget.');
select is((select r ->> 'committed' from answer), 'false', 'one order above the approver''s spend limit refuses the whole call');
select is((select r -> 'refused' -> 0 ->> 'id' from answer), pg_temp.id('po2')::text, 'the refusal names that order');
select is((select r -> 'refused' -> 0 ->> 'rule' from answer), 'spend_authority_exceeded', 'with the spend authority rule');
select is((select po_state::text from app.purchase_orders where id = pg_temp.id('po1')), 'Proposed', 'the order within the limit is not approved');
select is((select count(*)::int from app.spend_approvals where document_id = pg_temp.id('po1')), 0, 'and its approval is undone with the call');

select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('purchase_orders', pg_temp.rows(array['po4'], '{"po_state": "Approved"}')) r) x),
  'purchase_order_unpriced', 'an unpriced order is refused as a single approval refuses it');

select pg_temp.as_platform();
update app.spend_authorities set dual_approval_above_minor = 15000 where document_type = 'Purchase Order';
select pg_temp.as_user('bob');
delete from answer;
insert into answer select pg_temp.bulk('purchase_orders', pg_temp.rows(array['po3', 'po1'], '{"po_state": "Approved"}'));
select is((select r -> 'refused' -> 0 ->> 'rule' from answer), 'bulk_needs_further_approval', 'an order needing a second approver refuses the whole call');
select is((select r -> 'refused' -> 0 ->> 'id' from answer), pg_temp.id('po1')::text, 'naming that order');
select is((select count(*)::int from app.spend_approvals where document_id in (pg_temp.id('po1'), pg_temp.id('po3'))), 0,
  'and no first approval is left behind');
select pg_temp.as_platform();
update app.spend_authorities set dual_approval_above_minor = null where document_type = 'Purchase Order';

-- An Active approval policy over 15,000 holds the larger order until its approval is Approved; the smaller one, which
-- the policy does not cover, would be approved on its own.
select pg_temp.as_user('bob');
with x as (insert into app.approval_policies (org_id, name, document_type, currency_code, applies_above_minor)
  values (pg_temp.id('org_a'), 'Larger purchase orders', 'Purchase Order', 'USD', 15000) returning id) insert into world select 'pol', id from x;
insert into app.approval_steps (approval_policy_id, step_order, name, approver_role_id)
values (pg_temp.id('pol'), 1, 'Admin review', pg_temp.system_role('admin'));
select app.transition_approval_policy(pg_temp.id('pol'), 'Draft', 'Active', 'Ready.');
delete from answer;
insert into answer select pg_temp.bulk('purchase_orders', pg_temp.rows(array['po3', 'po1'], '{"po_state": "Approved"}'));
select is((select r ->> 'committed' from answer), 'false', 'an order an Active approval policy holds refuses the whole call');
select is((select jsonb_array_length(r -> 'refused') from answer), 1, 'only that order is refused');
select is((select r -> 'refused' -> 0 ->> 'id' from answer), pg_temp.id('po1')::text, 'the refusal names it');
select is((select r -> 'refused' -> 0 ->> 'rule' from answer), 'approval_policy_pending', 'with the approval policy rule');
select is((select po_state::text from app.purchase_orders where id = pg_temp.id('po3')), 'Proposed', 'the order the policy does not cover is not approved either');
select is((select count(*)::int from app.spend_approvals where document_id in (pg_temp.id('po1'), pg_temp.id('po3'))), 0,
  'and its approval is undone with the call');
select app.transition_approval_policy(pg_temp.id('pol'), 'Active', 'Retired', 'Review done.');

select pg_temp.as_user('bob');
delete from answer;
insert into answer select pg_temp.bulk('purchase_orders', pg_temp.rows(array['po1', 'po3'], '{"po_state": "Approved"}'), false, 'Within budget.');
select is((select r ->> 'committed' from answer), 'true', 'orders within the limit are approved in bulk');
select is((select count(*)::int from app.purchase_orders where id in (pg_temp.id('po1'), pg_temp.id('po3')) and po_state = 'Approved'), 2, 'both are Approved');
select is((select count(*)::int from app.spend_approvals where document_id in (pg_temp.id('po1'), pg_temp.id('po3')) and approver_person_id = pg_temp.id('bob')), 2,
  'each under the approver''s spend authority');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'po.approved' and subject_id in (pg_temp.id('po1'), pg_temp.id('po3'))), 2,
  'and each emits po.approved');
select pg_temp.as_user('bob');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('purchase_orders', (select r -> 'inverse' from answer)) r) x),
  'purchase_order_transition_not_allowed', 'an undo never takes an approval back');

select pg_temp.as_user('carol');
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('purchase_orders', pg_temp.rows(array['po1', 'po3'], '{"po_state": "Sent"}'), false, 'Emailed.') r) x),
  '2', 'approved orders are sent in bulk');
select is((select count(*)::int from app.purchase_order_state_transitions where purchase_order_id = pg_temp.id('po3') and reason = 'Emailed.'), 1,
  'through app.transition_purchase_order, with the reason in the ledger');

select pg_temp.as_user('dave');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('purchase_orders', pg_temp.rows(array['po2'], '{"po_state": "Canceled"}')) r) x),
  'not_allowed', 'a project member who reads orders cannot cancel them');
select pg_temp.as_user('xavier');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('purchase_orders', pg_temp.rows(array['po2'], '{"po_state": "Canceled"}')) r) x),
  'bulk_row_not_found', 'another org cannot change them');
select pg_temp.as_anon();
select throws_ok($$select app.bulk_update_purchase_orders('[]'::jsonb)$$, '42501', null, 'anon cannot call purchase order bulk edit');
select pg_temp.as_platform();

-- Audit -------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from app.audit_events where action = 'vendors.bulk_update' and org_id = pg_temp.id('org_a')), 3,
  'each committed vendor call writes one vendors.bulk_update event');
select is((select count(*)::int from app.audit_events where action = 'purchase_orders.bulk_update' and diff ->> 'reason' = 'Within budget.'), 1,
  'the purchase order event names the reason');
select ok((select count(*) from app.audit_events where action = 'rfqs.bulk_update' and org_id = pg_temp.id('org_a')) >= 2,
  'and RFQ calls write rfqs.bulk_update');

select * from finish();
rollback;
