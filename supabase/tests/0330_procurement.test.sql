-- pgTAP: vendors and procurement (Section 7.4 Vendors and Procurement). Same-tenant allow,
-- cross-tenant deny, anon deny, role bands, Restricted bank columns masked (Section 8.3),
-- sod_vendor_payment and sod_po_creator (Section 8.2), spend authority on purchase orders
-- (Section 8.1), sealed RFQ responses, receipts never beyond the order, invariant 10 for purchase
-- orders, invariant 17 (three-way match), item IDs, and every procurement state machine.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(77);

-- World -----------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into world values ('cp_v', app.create_counterparty(pg_temp.id('org_a'), 'Harborline Staging', 'Equipment Rental'));
insert into world values ('cp_v2', app.create_counterparty(pg_temp.id('org_a'), 'Quayside Audio', 'Audio Supply'));
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id, payment_terms_days) values (pg_temp.id('cp_v'), 30) returning id)
  insert into world select 'ven', id from x;
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v2')) returning id)
  insert into world select 'ven2', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD') returning id)
  insert into world select 'bud', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 1, 'Stage rental.', '0000.01.01', 1, 100000, 'X', 'Declared') returning id)
  insert into world select 'bl', id from x;
select pg_temp.as_platform();

-- Vendors and their lifecycle ---------------------------------------------------------------------------
select is((select org_id from app.vendors where id = pg_temp.id('ven')), pg_temp.id('org_a'), 'a vendor''s org is derived from its counterparty');
select is((select vendor_state::text from app.vendors where id = pg_temp.id('ven')), 'Prospect', 'a vendor starts as a Prospect');
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'vendor'), 9, 'the vendor lifecycle declares nine moves');
select pg_temp.as_user('carol');
select throws_ok($$update app.vendors set vendor_state = 'Active' where id = (select id from world where key = 'ven')$$, 'XR001', null, 'the vendor state changes only through its RPC');
select throws_ok($$select app.transition_vendor((select id from world where key = 'ven'), 'Prospect', 'Active', 'Skip.')$$, 'XR001', 'vendor_transition_not_allowed: A vendor cannot move from Prospect to Active.', 'a Prospect cannot jump to Active');
select lives_ok($$select app.transition_vendor((select id from world where key = 'ven'), 'Prospect', 'Onboarded', 'Paperwork in.')$$, 'Prospect to Onboarded');
select lives_ok($$select app.transition_vendor((select id from world where key = 'ven'), 'Onboarded', 'Active', 'Approved for use.')$$, 'Onboarded to Active');
select lives_ok($$select app.transition_vendor((select id from world where key = 'ven2'), 'Prospect', 'Onboarded', 'In.')$$, 'second vendor onboarded');
select lives_ok($$select app.transition_vendor((select id from world where key = 'ven2'), 'Onboarded', 'Blocked', 'COI lapsed.')$$, 'Onboarded to Blocked');
select throws_ok($$select app.transition_vendor((select id from world where key = 'ven2'), 'Blocked', 'Prospect', 'Back.')$$, 'XR001', 'vendor_transition_not_allowed: A vendor cannot move from Blocked to Prospect.', 'a Blocked vendor cannot return to Prospect');
select pg_temp.as_user('dave');
select throws_ok($$select app.transition_vendor((select id from world where key = 'ven'), 'Active', 'Blocked', 'x')$$, '42501', null, 'a Member cannot change vendor state');
select throws_ok($$insert into app.vendors (counterparty_id) values ((select id from world where key = 'cp_v'))$$, '42501', null, 'a Member cannot create vendors');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.vendors where org_id = pg_temp.id('org_a')), 0, 'another org reads no vendors');
select pg_temp.as_anon();
select throws_ok('select 1 from app.vendors', '42501', null, 'anon cannot read vendors');
select throws_ok('select 1 from app.purchase_orders', '42501', null, 'anon cannot read purchase orders');
select throws_ok('select 1 from app.vendor_bank_accounts_masked', '42501', null, 'anon cannot read the masked bank view');
select pg_temp.as_platform();

-- Bank details: Restricted and masked (Section 8.3) ------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$select app.set_vendor_bank_account((select id from world where key = 'ven'), 'Gulf Coast Bank', 'Harborline Staging', '0001-2345-6789', '063100277')$$,
  'a Manager records bank details through the encrypting RPC (2010)');
select throws_ok($$insert into app.vendor_bank_accounts (vendor_id, bank_name, account_holder, account_last4) values ((select id from world where key = 'ven'), 'B', 'H', '1111')$$,
  '42501', null, 'bank details are never inserted directly');
select pg_temp.as_user('dave');
select throws_ok($$select account_number from app.vendor_bank_accounts$$, '42501', null, 'a Restricted column is not selectable directly');
select is((select account_last4 from app.vendor_bank_accounts), '6789', 'the last four stay readable');
select is((select account_number from app.vendor_bank_accounts_masked), null, 'without data.restricted.read.banking the number is masked');
select is((select is_masked from app.vendor_bank_accounts_masked), true, 'and the view says it is masked');
select pg_temp.as_user('alice');
select is((select account_number from app.vendor_bank_accounts_masked), '000123456789', 'the holder of data.restricted.read.banking reads the number, its letters and digits');
select is((select is_masked from app.vendor_bank_accounts_masked), false, 'unmasked for them');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.vendor_bank_accounts_masked), 0, 'a Viewer without vendors.vendor.read sees no bank rows');
select pg_temp.as_platform();
select is((select count(*)::int from app.column_classifications where classification = 'Restricted' and table_name = 'app.vendor_bank_accounts'), 2, 'both bank numbers are registered as Restricted');
select is((select changed_by from app.vendor_bank_detail_changes where vendor_id = pg_temp.id('ven')), pg_temp.id('carol'), 'the bank detail editor is logged');

-- sod_vendor_payment ----------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
with x as (insert into app.payments (counterparty_id, direction, amount_minor, currency_code, paid_on)
  values (pg_temp.id('cp_v'), 'Payable', 5000, 'USD', '2027-07-01') returning id) insert into world select 'pay', id from x;
select pg_temp.as_user('carol');
select throws_ok($$select app.approve_payment((select id from world where key = 'pay'), 'Pay.')$$,
  'XR001', 'sod_vendor_payment: A person who creates a vendor or edits its bank details cannot approve payment to it.', 'a bank detail editor cannot approve payment to the vendor');
select pg_temp.as_user('alice');
select throws_ok($$select app.approve_payment((select id from world where key = 'pay'), 'Pay.')$$, 'XR001', null, 'the person who created the counterparty cannot either');
select pg_temp.as_platform();

-- Prequalification ---------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.prequalifications (vendor_id, scope_note) values (pg_temp.id('ven'), 'Staging up to 40 ft.') returning id)
  insert into world select 'pq', id from x;
select throws_ok($$update app.prequalifications set decision = 'Approved' where id = (select id from world where key = 'pq')$$, 'XR001', null, 'a decision is written only by its RPC');
select throws_ok($$select app.decide_prequalification((select id from world where key = 'pq'), 'Approved')$$,
  'XR001', 'sod_approval_requester: An approval is decided by an eligible approver, never the requester.', 'the requester cannot decide');
select pg_temp.as_user('bob');
select lives_ok($$select app.decide_prequalification((select id from world where key = 'pq'), 'Approved', '2028-06-30')$$, 'another approver decides');
select throws_ok($$select app.decide_prequalification((select id from world where key = 'pq'), 'Rejected')$$, 'XR001', null, 'a decision is final');
select pg_temp.as_platform();

-- RFQs and sealed responses ------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.rfqs (project_id, title) values (pg_temp.id('prj_a'), 'Stage Package') returning id) insert into world select 'rfq', id from x;
select throws_ok($$select app.transition_rfq((select id from world where key = 'rfq'), 'Proposed', 'Issued', 'Out.')$$,
  'XR001', 'rfq_no_invitations: Invite at least one vendor before issuing an RFQ.', 'an RFQ needs an invitation before it is issued');
insert into app.rfq_invitations (rfq_id, vendor_id) values (pg_temp.id('rfq'), pg_temp.id('ven'));
select throws_ok($$insert into app.rfq_responses (rfq_id, vendor_id) values ((select id from world where key = 'rfq'), (select id from world where key = 'ven'))$$,
  'XR001', null, 'no responses before the RFQ is issued');
select lives_ok($$select app.transition_rfq((select id from world where key = 'rfq'), 'Proposed', 'Issued', 'Out.')$$, 'Proposed to Issued');
select lives_ok($$insert into app.rfq_responses (rfq_id, vendor_id) values ((select id from world where key = 'rfq'), (select id from world where key = 'ven'))$$, 'an invited vendor responds');
select throws_ok($$insert into app.rfq_responses (rfq_id, vendor_id) values ((select id from world where key = 'rfq'), (select id from world where key = 'ven2'))$$,
  'XR001', 'rfq_not_invited: Only an invited vendor responds to an RFQ.', 'an uninvited vendor cannot respond');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.rfq_responses), 0, 'responses stay sealed while the RFQ is Issued');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_rfq((select id from world where key = 'rfq'), 'Issued', 'Closed', 'Deadline passed.')$$, 'Issued to Closed unseals responses');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.rfq_responses), 1, 'a project member reads responses once unsealed');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_rfq((select id from world where key = 'rfq'), 'Closed', 'Awarded', 'Best value.')$$, 'Closed to Awarded');
select throws_ok($$select app.transition_rfq((select id from world where key = 'rfq'), 'Awarded', 'Issued', 'Again.')$$,
  'XR001', 'rfq_transition_not_allowed: A rfq cannot move from Awarded to Issued.', 'an Awarded RFQ is not issued again');
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'rfq'), 6, 'the RFQ lifecycle declares six moves');
select pg_temp.as_platform();

-- Purchase orders, sod_po_creator, spend authority -----------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po', id from x;
with x as (insert into app.po_lines (purchase_order_id, line_number, description, budget_line_id, element_id, quantity)
  values (pg_temp.id('po'), 1, 'Stage deck sections.', pg_temp.id('bl'), '0000.01.01-XOS-001', 2) returning id) insert into world select 'pol', id from x;
select throws_ok($$insert into app.purchase_orders (project_id, vendor_id, currency_code) values ((select id from world where key = 'prj_a'), (select id from world where key = 'ven2'), 'USD')$$,
  'XR001', 'vendor_blocked: A Blocked or Canceled vendor takes no new purchase orders.', 'a Blocked vendor takes no purchase order');
select pg_temp.as_user('bob');
select throws_ok($$select app.approve_purchase_order((select id from world where key = 'po'), 'Go.')$$,
  'XR001', 'purchase_order_unpriced: Every line of a purchase order needs a price before it is approved.', 'an unpriced purchase order cannot be approved');
select pg_temp.as_user('carol');
update app.po_lines set unit_price_minor = 20000 where id = pg_temp.id('pol');
select throws_ok($$select app.approve_purchase_order((select id from world where key = 'po'), 'Mine.')$$,
  'XR001', 'sod_po_creator: The creator of a purchase order cannot approve it.', 'the creator cannot approve their purchase order');
select pg_temp.as_user('bob');
select throws_ok($$select app.approve_purchase_order((select id from world where key = 'po'), 'Go.')$$,
  'XR001', 'spend_authority_missing: No spend authority lets this person approve a Purchase Order in USD.', 'without spend authority approval is refused');
select pg_temp.as_user('alice');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Purchase Order', 'USD', 30000);
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Invoice Approval', 'USD', 1000000);
select pg_temp.as_user('bob');
select throws_ok($$select app.approve_purchase_order((select id from world where key = 'po'), 'Go.')$$,
  'XR001', null, 'an order above the approver''s limit is refused');
select pg_temp.as_platform();
update app.spend_authorities set limit_minor = 100000 where document_type = 'Purchase Order';
select pg_temp.as_user('bob');
select is(app.approve_purchase_order(pg_temp.id('po'), 'Within limit.'), true, 'an eligible approver within limit approves');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'po.approved' and subject_id = pg_temp.id('po')), 1, 'po.approved was emitted');
select pg_temp.as_user('carol');
select throws_ok($$update app.po_lines set unit_price_minor = 1 where id = (select id from world where key = 'pol')$$, 'XR001', null, 'approved order lines are locked');
select throws_ok($$select app.transition_purchase_order((select id from world where key = 'po'), 'Approved', 'Closed', 'Skip.')$$, 'XR001', 'purchase_order_transition_not_allowed: A purchase order cannot move from Approved to Closed.', 'an Approved order cannot close before it is sent');
select lives_ok($$select app.transition_purchase_order((select id from world where key = 'po'), 'Approved', 'Sent', 'Emailed.')$$, 'Approved to Sent');
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'purchase_order'), 6, 'the purchase order lifecycle declares six moves');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.purchase_orders), 1, 'a project member reads the project''s purchase orders');
select throws_ok($$insert into app.purchase_orders (project_id, vendor_id, currency_code) values ((select id from world where key = 'prj_a'), (select id from world where key = 'ven'), 'USD')$$,
  '42501', null, 'a Member cannot write purchase orders');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.purchase_orders), 0, 'a Viewer outside the project reads none');
select pg_temp.as_platform();

-- PO change orders ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.po_change_orders (purchase_order_id, description) values (pg_temp.id('po'), 'Add stair units.') returning id) insert into world select 'pco', id from x;
select pg_temp.as_user('bob');
select throws_ok($$select app.decide_po_change_order((select id from world where key = 'pco'), 'Approved', 'Go.')$$,
  'XR001', 'po_change_order_unpriced: An unpriced PO change order cannot be approved.', 'an unpriced PO change order cannot be approved');
select pg_temp.as_user('carol');
update app.po_change_orders set amount_delta_minor = 5000 where id = pg_temp.id('pco');
select pg_temp.as_user('bob');
select is(app.decide_po_change_order(pg_temp.id('pco'), 'Approved', 'Go.'), true, 'a priced PO change order is approved');
select throws_ok($$select app.decide_po_change_order((select id from world where key = 'pco'), 'Rejected', 'Second thoughts.')$$,
  'XR001', 'po_change_order_state_conflict: The po change order is not in the expected state Proposed.', 'a decided PO change order takes no second decision');
select is((select approved_changes_minor from app.purchase_order_totals where purchase_order_id = pg_temp.id('po')), 5000::bigint, 'the approved delta sits beside the order total');
select pg_temp.as_platform();

-- Receipts ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.goods_receipts (purchase_order_id, note) values (pg_temp.id('po'), 'Arrived complete.') returning id) insert into world select 'gr', id from x;
select lives_ok($$insert into app.receipt_lines (goods_receipt_id, po_line_id, quantity_received) values ((select id from world where key = 'gr'), (select id from world where key = 'pol'), 2)$$, 'the full quantity is received');
select is((select received_by from app.goods_receipts where id = pg_temp.id('gr')), pg_temp.id('carol'), 'the receiver is the session person');
with x as (insert into app.goods_receipts (purchase_order_id) values (pg_temp.id('po')) returning id) insert into world select 'gr2', id from x;
select throws_ok($$insert into app.receipt_lines (goods_receipt_id, po_line_id, quantity_received) values ((select id from world where key = 'gr2'), (select id from world where key = 'pol'), 1)$$,
  'XR001', 'receipt_exceeds_order: Receipts never exceed the quantity ordered.', 'receipts never exceed the order');
select pg_temp.as_platform();

-- Three-way match (invariant 17) --------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.accounting_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-01', '2027-06-30');
with x as (insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code, issued_on) values (pg_temp.id('prj_a'), 'Payable', pg_temp.id('cp_v'), 'HS-1001', 'USD', '2027-06-12') returning id)
  insert into world select 'inv', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor, urid) values (pg_temp.id('inv'), 1, 'Stage deck sections.', 2, 21000, '0000.01.01');
with x as (insert into app.invoice_matches (invoice_id, purchase_order_id, goods_receipt_id) values (pg_temp.id('inv'), pg_temp.id('po'), pg_temp.id('gr')) returning id)
  insert into world select 'match', id from x;
select pg_temp.as_platform();
select is((select variance_minor from app.invoice_match_results where invoice_match_id = pg_temp.id('match')), 2000::bigint, 'the variance between invoice and receipt is derived');
select is((select is_matched from app.invoice_match_results where invoice_match_id = pg_temp.id('match')), false, 'a priced difference is a mismatch');
select is((select invoice_state::text from app.invoices where id = pg_temp.id('inv')), 'Proposed', 'inv_17_three_way_match: matching never approves an invoice by itself');
select pg_temp.as_user('carol');
with x as (insert into app.invoices (project_id, direction, counterparty_id, currency_code) values (pg_temp.id('prj_a'), 'Payable', pg_temp.id('cp_v'), 'USD') returning id)
  insert into world select 'inv_dup', id from x;
select throws_ok($$insert into app.invoice_matches (invoice_id, purchase_order_id, goods_receipt_id) values ((select id from world where key = 'inv_dup'), (select id from world where key = 'po'), (select id from world where key = 'gr'))$$,
  '23505', null, 'inv_17_three_way_match: a goods receipt is matched to one invoice once (invariant 17)');
select pg_temp.as_user('bob');
select throws_ok($$select app.approve_invoice((select id from world where key = 'inv'), 'Pay.')$$,
  'XR001', 'invoice_match_mismatch: The invoice does not match its purchase order and receipt; resolve the mismatch before approving.', 'inv_17_three_way_match: a mismatched invoice is never approved (invariant 17)');
select pg_temp.as_user('carol');
select throws_ok($$update app.invoice_matches set resolution_note = 'Freight surcharge agreed.' where id = (select id from world where key = 'match')$$,
  'XR001', null, 'the matcher cannot accept their own mismatch');
select pg_temp.as_user('bob');
select lives_ok($$update app.invoice_matches set resolution_note = 'Freight surcharge agreed by phone.' where id = (select id from world where key = 'match')$$, 'another person accepts the mismatch with a reason');
select is(app.approve_invoice(pg_temp.id('inv'), 'Resolved and approved.'), true, 'a resolved mismatch can then be approved explicitly');
select pg_temp.as_platform();

-- Invariant 10, catalog -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.catalog_bindings (org_id, element_id, name, unit_basis) values (pg_temp.id('org_a'), '0000.01.01-XOS-001', 'Full Venue Hire', 'event') returning id)
  insert into world select 'cat', id from x;
select is((select item_id from app.catalog_bindings where id = pg_temp.id('cat')), '0000.01.01-NORTHW-001', 'an item ID is {URID}-{ORG}-{SEQ}');
select throws_ok($$update app.catalog_bindings set item_id = 'X' where id = (select id from world where key = 'cat')$$, 'XR001', null, 'an item ID never changes');
select lives_ok($$insert into app.vendor_products (vendor_id, catalog_binding_id, vendor_sku, unit_price_minor, currency_code) values ((select id from world where key = 'ven'), (select id from world where key = 'cat'), 'HS-DECK-4X8', 9000, 'USD')$$, 'a vendor product binds to the catalog item');
select pg_temp.as_user('alice');
select app.transition_production(pg_temp.id('prj_a'), 'Proposed', 'Active', 'Live.');
select app.transition_production(pg_temp.id('prj_a'), 'Active', 'Complete', 'Wrapped.');
select app.transition_production(pg_temp.id('prj_a'), 'Complete', 'Closed', 'Closed.');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.purchase_orders (project_id, vendor_id, currency_code) values ((select id from world where key = 'prj_a'), (select id from world where key = 'ven'), 'USD')$$,
  'XR001', 'production_closed: A closed production refuses new invoices, purchase orders, expenses, time entries and change orders.', 'a closed production refuses a new purchase order (invariant 10)');
select pg_temp.as_platform();

select * from finish();
rollback;
