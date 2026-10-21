-- pgTAP: migration 1395, Out of Office delegation for approvals follows what was delegated (RRR-121, audit of A76).
-- A delegation that covers another capability (timesheets) neither lets the delegate decide or read an away
-- approver's purchase order steps nor takes the notification away from the approver. A delegation that covers
-- approvals still does. When the away approver's only delegate is the requester, the approver is notified, so the
-- approval never goes unseen.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(13);

-- World: three priced purchase orders and an Active policy whose one step names Bob ---------------------------------
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
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po1', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, budget_line_id, element_id, quantity, unit_price_minor)
  values (pg_temp.id('po1'), 1, 'Stage deck sections.', pg_temp.id('bl'), '0000.01.01-XOS-001', 2, 20000);
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po2', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, budget_line_id, element_id, quantity, unit_price_minor)
  values (pg_temp.id('po2'), 1, 'Truss.', pg_temp.id('bl'), '0000.01.01-XOS-001', 1, 15000);
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po3', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, budget_line_id, element_id, quantity, unit_price_minor)
  values (pg_temp.id('po3'), 1, 'Barricade.', pg_temp.id('bl'), '0000.01.01-XOS-001', 1, 10000);

select pg_temp.as_user('bob');
with x as (insert into app.approval_policies (org_id, name, document_type) values (pg_temp.id('org_a'), 'Purchase orders', 'Purchase Order') returning id)
  insert into world select 'pol', id from x;
insert into app.approval_steps (approval_policy_id, step_order, name, approver_membership_id)
  values (pg_temp.id('pol'), 1, 'Bob signs off', pg_temp.id('bob@org_a'));
select app.transition_approval_policy(pg_temp.id('pol'), 'Draft', 'Active', 'Ready.');

-- Bob is out of office and delegated only timesheet approvals to Carol.
select app.set_personal_setting('me.out_of_office.enabled', null, p_value_boolean => true);
insert into app.delegations (delegator_membership_id, delegate_membership_id, capability_code, valid_from, valid_to, reason)
values (pg_temp.id('bob@org_a'), pg_temp.id('carol@org_a'), 'crew.timesheet.approve', now() - interval '1 hour', now() + interval '7 days',
  'Timesheets while I am at the Harbor show.');
select pg_temp.as_platform();
select is(private.spend_approve_capability('Purchase Order'),
  (select f.approve_capability from private.spend_document_facts('Purchase Order', pg_temp.id('po1')) f),
  'the policy''s approval capability is the one its documents are approved with');

-- A delegation of another capability does not reach the purchase order step --------------------------------------
select pg_temp.as_user('alice');
insert into world values ('ai1', app.request_approval('Purchase Order', pg_temp.id('po1')));
select pg_temp.as_platform();
select set_eq($$select private.step_approver_person_ids((select id from world where key = 'pol'), 1::smallint)$$,
  $$values ((select id from world where key = 'bob'))$$, 'a timesheet delegate does not replace the away approver of a purchase order step');
select is((select count(*)::int from app.notifications where subject_id = pg_temp.id('ai1') and kind = 'approval.requested' and recipient_person_id = pg_temp.id('bob')), 1,
  'the away approver is still notified');
select is((select count(*)::int from app.notifications where subject_id = pg_temp.id('ai1') and kind = 'approval.requested' and recipient_person_id = pg_temp.id('carol')), 0,
  'the timesheet delegate is not');
select pg_temp.claims('carol');
select is(private.is_step_approver(pg_temp.id('org_a'), null, pg_temp.id('bob@org_a'), 'finance.po.approve'), false,
  'the timesheet delegate may not decide the purchase order step');
select is(private.is_step_approver(pg_temp.id('org_a'), null, pg_temp.id('bob@org_a'), 'crew.timesheet.approve'), true,
  'the delegation still covers what it names');
select is(private.is_policy_approver(pg_temp.id('pol')), false, 'nor is she an approver of the policy');
select pg_temp.as_user('carol');
select throws_ok($$select app.decide_approval((select id from world where key = 'ai1'), true, 'Looks fine.')$$,
  'XR001', 'approval_not_step_approver: You are not an approver of the step this approval is waiting on.',
  'Carol''s own finance.po.approve does not make her the decider of a step reserved for Bob');

-- A delegation of every approval reaches it -----------------------------------------------------------------------
select pg_temp.as_user('bob');
insert into app.delegations (delegator_membership_id, delegate_membership_id, valid_from, valid_to, reason)
values (pg_temp.id('bob@org_a'), pg_temp.id('carol@org_a'), now() - interval '1 hour', now() + interval '7 days',
  'Every approval while I am at the Harbor show.');
select pg_temp.claims('carol');
select is(private.is_step_approver(pg_temp.id('org_a'), null, pg_temp.id('bob@org_a'), 'finance.po.approve'), true,
  'a delegation of every approve-class capability covers the purchase order step');
select pg_temp.as_user('alice');
insert into world values ('ai2', app.request_approval('Purchase Order', pg_temp.id('po2')));
select pg_temp.as_platform();
select is((select array_agg(recipient_person_id) from app.notifications where subject_id = pg_temp.id('ai2') and kind = 'approval.requested'),
  array[pg_temp.id('carol')], 'the covering delegate is notified in the away approver''s place');

-- The away approver's only delegate requests the approval --------------------------------------------------------
select pg_temp.as_user('carol');
insert into world values ('ai3', app.request_approval('Purchase Order', pg_temp.id('po3')));
select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where subject_id = pg_temp.id('ai3') and kind = 'approval.requested' and recipient_person_id = pg_temp.id('bob')), 1,
  'when the delegate is the requester, the away approver is notified');
select is((select count(*)::int from app.notifications where subject_id = pg_temp.id('ai3') and kind = 'approval.requested' and recipient_person_id = pg_temp.id('carol')), 0,
  'and the requester is not');
select set_eq($$select private.step_approver_person_ids((select id from world where key = 'pol'), 1::smallint, array[(select id from world where key = 'carol')])$$,
  $$values ((select id from world where key = 'bob'))$$, 'an approver whose delegates are all unavailable stays on the list');

select * from finish();
rollback;
