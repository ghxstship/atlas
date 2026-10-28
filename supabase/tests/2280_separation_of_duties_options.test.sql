-- pgTAP: orgs tighten separation of duties (A135, RRR-197, Section 8.2, ADR 0113, migrations 2280 and 2281). The three
-- options are registered beside the built-in rules and listed apart from them; only an option can be switched, so
-- the built-in rules cannot be removed; switching needs org.separation_of_duties.write; each option, once on, refuses
-- with its code and sentence and stops refusing once off:
--   sod_receiver_po_approver          bob approves carol's purchase order, then cannot receive against it;
--   sod_document_creator              bob created a purchase order carol put through a policy, and cannot decide its step;
--   sod_change_order_requester_steps  bob requested a change order alice put through a policy, and cannot decide its step.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(30);

-- World -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into world values ('cp_v', app.create_counterparty(pg_temp.id('org_a'), 'Harborline Staging', 'Equipment Rental'));
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v')) returning id) insert into world select 'ven', id from x;
select app.transition_vendor(pg_temp.id('ven'), 'Prospect', 'Onboarded', 'Paperwork in.');
select app.transition_vendor(pg_temp.id('ven'), 'Onboarded', 'Active', 'Approved for use.');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD') returning id)
  insert into world select 'bud', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 1, 'Stage rental.', '0000.01.01', 1, 100000, 'X', 'Declared') returning id) insert into world select 'bl', id from x;
-- carol's order, which bob approves and then tries to receive.
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po_recv', id from x;
with x as (insert into app.po_lines (purchase_order_id, line_number, description, budget_line_id, element_id, quantity, unit_price_minor)
  values (pg_temp.id('po_recv'), 1, 'Stage deck sections.', pg_temp.id('bl'), '0000.01.01-XOS-001', 4, 20000) returning id)
  insert into world select 'po_recv_line', id from x;
select pg_temp.as_user('bob');
-- bob's order, which carol puts through the policy.
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po_bob', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, budget_line_id, element_id, quantity, unit_price_minor)
  values (pg_temp.id('po_bob'), 1, 'Truss.', pg_temp.id('bl'), '0000.01.01-XOS-001', 1, 15000);
-- bob's change order, which alice puts through the policy.
with x as (insert into app.change_orders (project_id, budget_id, title, order_type_enum_id, reason)
  values (pg_temp.id('prj_a'), pg_temp.id('bud'), 'Add a second stage', 'ENM-092', 'Client asked for a second stage.') returning id)
  insert into world select 'co', id from x;
insert into app.change_order_lines (change_order_id, description, urid, quantity, unit_price_minor)
  values (pg_temp.id('co'), 'Second stage deck.', '0000.01.01', 1, 25000);
select app.price_change_order(pg_temp.id('co'), 'Priced.');
select pg_temp.as_user('alice');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor)
  values (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Purchase Order', 'USD', 1000000),
         (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Change Order', 'USD', 1000000);
select pg_temp.as_platform();

-- Registry ---------------------------------------------------------------------------------------------------------------
select set_eq($$select code || ' tightens ' || tightens from app.separation_of_duties_options$$,
  array['sod_document_creator tightens sod_approval_requester', 'sod_receiver_po_approver tightens sod_po_creator',
        'sod_change_order_requester_steps tightens sod_change_order_requester'],
  'three options are offered, each tightening a built-in rule');
select is_empty($$select code from app.separation_of_duties_rules intersect select code from app.separation_of_duties_options$$,
  'the rules every org keeps are listed apart from the options');
select is((select count(*)::int from app.separation_of_duties_rules),
  (select count(*)::int from private.separation_of_duties_rules where tightens is null), 'every built-in rule is still listed');

-- The capability is required ---------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select app.set_separation_of_duties_option((select id from world where key = 'org_a'), 'sod_document_creator', true)$$,
  '42501', null, 'a Manager cannot switch an option on');
select throws_ok($$insert into app.org_separation_of_duties_options (org_id, rule_code) values ((select id from world where key = 'org_a'), 'sod_document_creator')$$,
  '42501', null, 'nor write the row directly');
select pg_temp.as_user('xavier');
select throws_ok($$select app.set_separation_of_duties_option((select id from world where key = 'org_a'), 'sod_document_creator', true)$$,
  '42501', null, 'another org''s Owner cannot switch this org''s options');
select pg_temp.as_anon();
select throws_ok('select 1 from app.org_separation_of_duties_options', '42501', null, 'anon cannot read the options');

-- The built-in rules cannot be removed -----------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$select app.set_separation_of_duties_option((select id from world where key = 'org_a'), 'sod_po_creator', false)$$,
  'XR001', 'separation_option_unknown: sod_po_creator is not an option an org can switch; the built-in rules are always on.',
  'a built-in rule cannot be switched off');
select throws_ok($$insert into app.org_separation_of_duties_options (org_id, rule_code) values ((select id from world where key = 'org_a'), 'sod_approval_requester')$$,
  'XR001', 'separation_option_unknown: sod_approval_requester is not an option an org can switch; the built-in rules are always on.',
  'nor given a row of its own');
select throws_ok($$select app.set_separation_of_duties_option((select id from world where key = 'org_a'), 'sod_made_up', true)$$,
  'XR001', 'separation_option_unknown: sod_made_up is not an option an org can switch; the built-in rules are always on.',
  'an unknown code is refused');

-- sod_receiver_po_approver -----------------------------------------------------------------------------------------------
select is(app.approve_purchase_order(pg_temp.id('po_recv'), 'Approved.'), true, 'bob approves carol''s order');
select lives_ok($$with x as (insert into app.goods_receipts (purchase_order_id, note) values ((select id from world where key = 'po_recv'), 'First drop.') returning id) insert into world select 'gr_off', id from x$$,
  'with the option off, the approver may receive');
select lives_ok($$select app.set_separation_of_duties_option((select id from world where key = 'org_a'), 'sod_receiver_po_approver', true)$$,
  'an Admin switches on sod_receiver_po_approver');
select throws_ok($$insert into app.goods_receipts (purchase_order_id) values ((select id from world where key = 'po_recv'))$$,
  'XR001', 'sod_receiver_po_approver: Goods are received by someone other than a person who approved the purchase order or a change to it.',
  'sod_receiver_po_approver: once on, the approver cannot receive against the order');
select pg_temp.as_user('carol');
select lives_ok($$with x as (insert into app.goods_receipts (purchase_order_id, note) values ((select id from world where key = 'po_recv'), 'Second drop.') returning id) insert into world select 'gr_carol', id from x$$,
  'someone who did not approve it receives');
select pg_temp.as_user('bob');
select throws_ok($$insert into app.receipt_lines (goods_receipt_id, po_line_id, quantity_received) values ((select id from world where key = 'gr_carol'), (select id from world where key = 'po_recv_line'), 1)$$,
  'XR001', 'sod_receiver_po_approver: Goods are received by someone other than a person who approved the purchase order or a change to it.',
  'nor add a line to someone else''s receipt');
select pg_temp.as_user('carol');
select lives_ok($$insert into app.receipt_lines (goods_receipt_id, po_line_id, quantity_received) values ((select id from world where key = 'gr_carol'), (select id from world where key = 'po_recv_line'), 1)$$,
  'the receiver records the line');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.org_separation_of_duties_options where rule_code = 'sod_receiver_po_approver'), 1,
  'every member reads which options are on');
select pg_temp.as_platform();

-- sod_document_creator ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
with x as (insert into app.approval_policies (org_id, name, document_type) values (pg_temp.id('org_a'), 'Purchase orders', 'Purchase Order') returning id)
  insert into world select 'pol_po', id from x;
insert into app.approval_steps (approval_policy_id, step_order, name, approver_role_id) values (pg_temp.id('pol_po'), 1, 'Admin review', pg_temp.system_role('admin'));
select app.transition_approval_policy(pg_temp.id('pol_po'), 'Draft', 'Active', 'Ready.');
with x as (insert into app.approval_policies (org_id, name, document_type) values (pg_temp.id('org_a'), 'Change orders', 'Change Order') returning id)
  insert into world select 'pol_co', id from x;
insert into app.approval_steps (approval_policy_id, step_order, name, approver_role_id) values (pg_temp.id('pol_co'), 1, 'Admin review', pg_temp.system_role('admin'));
select app.transition_approval_policy(pg_temp.id('pol_co'), 'Draft', 'Active', 'Ready.');
select pg_temp.as_user('carol');
insert into world values ('ai_po', app.request_approval('Purchase Order', pg_temp.id('po_bob')));
select pg_temp.as_user('bob');
select lives_ok($$select app.set_separation_of_duties_option((select id from world where key = 'org_a'), 'sod_document_creator', true)$$,
  'an Admin switches on sod_document_creator');
select lives_ok($$select app.set_separation_of_duties_option((select id from world where key = 'org_a'), 'sod_document_creator', true)$$,
  'switching it on again changes nothing');
select is((select count(*)::int from app.org_separation_of_duties_options where rule_code = 'sod_document_creator' and deleted_at is null), 1,
  'the option has one row');
select throws_ok($$select app.decide_approval((select id from world where key = 'ai_po'), true, null)$$,
  'XR001', 'sod_document_creator: Whoever created an approvable document cannot approve it or decide a step of its approval.',
  'sod_document_creator: once on, the order''s creator cannot decide a step of its approval, though someone else requested it');
select throws_ok($$select app.approve_purchase_order((select id from world where key = 'po_bob'), 'Go.')$$,
  'XR001', 'sod_po_creator: The creator of a purchase order cannot approve it.', 'the built-in rule still answers first on a direct approval');

-- sod_change_order_requester_steps ---------------------------------------------------------------------------------------
select lives_ok($$select app.set_separation_of_duties_option((select id from world where key = 'org_a'), 'sod_change_order_requester_steps', true)$$,
  'an Admin switches on sod_change_order_requester_steps');
select lives_ok($$select app.set_separation_of_duties_option((select id from world where key = 'org_a'), 'sod_document_creator', false)$$,
  'and switches sod_document_creator off again');
select pg_temp.as_user('alice');
insert into world values ('ai_co', app.request_approval('Change Order', pg_temp.id('co')));
select pg_temp.as_user('bob');
select throws_ok($$select app.decide_approval((select id from world where key = 'ai_co'), true, null)$$,
  'XR001', 'sod_change_order_requester_steps: The requester of a change order cannot decide any step of its approval.',
  'sod_change_order_requester_steps: once on, the change order''s requester cannot decide a step, though someone else requested the approval');
select lives_ok($$select app.set_separation_of_duties_option((select id from world where key = 'org_a'), 'sod_change_order_requester_steps', false)$$,
  'an Admin switches sod_change_order_requester_steps off');
select lives_ok($$select app.decide_approval((select id from world where key = 'ai_co'), true, null)$$,
  'with it off, the requester decides the step as before');
select lives_ok($$select app.decide_approval((select id from world where key = 'ai_po'), true, null)$$,
  'and with sod_document_creator off, the order''s creator decides its step as before');
select pg_temp.as_platform();

-- Audit ------------------------------------------------------------------------------------------------------------------
select ok((select count(*) from app.audit_events where subject_table in ('org_separation_of_duties_options', 'app.org_separation_of_duties_options')) >= 5,
  'every switch on and off is audited');

select * from finish();
rollback;
