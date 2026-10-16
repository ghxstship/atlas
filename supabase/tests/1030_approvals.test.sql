-- pgTAP: approvals (Section 4.10 workflow engine, A33). Same-tenant allow, cross-tenant deny, anon
-- deny, role bands (Owner and Admin edit policies, Manager and below read them), the policy and
-- approval state machines (allowed and refused moves), steps frozen outside Draft, one Active policy
-- per document type, sod_approval_requester, one step per approver, a reason on rejection, the
-- spend authority gate on purchase orders and requisitions, thresholds, supersession when the amount
-- grows, the requester-may-cancel setting and the append-only decision ledger.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(80);

-- World -----------------------------------------------------------------------------------------------
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
  insert into world select 'po', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, budget_line_id, element_id, quantity, unit_price_minor)
  values (pg_temp.id('po'), 1, 'Stage deck sections.', pg_temp.id('bl'), '0000.01.01-XOS-001', 2, 20000);
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po2', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, budget_line_id, element_id, quantity, unit_price_minor)
  values (pg_temp.id('po2'), 1, 'Truss.', pg_temp.id('bl'), '0000.01.01-XOS-001', 1, 15000);
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po3', id from x;
with x as (insert into app.po_lines (purchase_order_id, line_number, description, budget_line_id, element_id, quantity, unit_price_minor)
  values (pg_temp.id('po3'), 1, 'Barricade.', pg_temp.id('bl'), '0000.01.01-XOS-001', 1, 10000) returning id) insert into world select 'po3_line', id from x;
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po_unpriced', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, budget_line_id, element_id, quantity)
  values (pg_temp.id('po_unpriced'), 1, 'Quote pending.', pg_temp.id('bl'), '0000.01.01-XOS-001', 1);
with x as (insert into app.requisitions (project_id, role_code, worker_classification, pay_basis, arrangement, headcount, units_per_head, rate_minor, currency_code, justification)
  values (pg_temp.id('prj_a'), '5000.50.01', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Retainer', 1, 4, 60000, 'USD', 'Production manager.') returning id)
  insert into world select 'req', id from x;
with x as (insert into app.requisitions (project_id, role_code, worker_classification, pay_basis, arrangement, headcount, units_per_head, rate_minor, currency_code, justification)
  values (pg_temp.id('prj_a'), '5000.50.01', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Retainer', 50, 10, 60000, 'USD', 'Fifty stagehands.') returning id)
  insert into world select 'req_big', id from x;
select pg_temp.as_user('alice');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor)
  values (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Purchase Order', 'USD', 1000000),
         (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Requisition', 'USD', 1000000);
select pg_temp.as_platform();

-- Policies: role bands, tenancy, anon ------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok($$with x as (insert into app.approval_policies (org_id, name, document_type) values ((select id from world where key = 'org_a'), 'Purchase orders', 'Purchase Order') returning id) insert into world select 'pol', id from x$$,
  'an Admin creates an approval policy');
select is((select policy_state::text from app.approval_policies where id = pg_temp.id('pol')), 'Draft', 'a policy starts as a Draft');
select throws_ok($$insert into app.approval_policies (org_id, name, document_type, applies_above_minor) values ((select id from world where key = 'org_a'), 'Half', 'Expense', 100)$$,
  '23514', null, 'a threshold needs its currency');
select throws_ok($$insert into app.approval_policies (org_id, name, document_type) values ((select id from world where key = 'org_a'), 'Rounds', 'Contract')$$,
  '23514', null, 'settlement rounds (Contract) are not gated by policies');
select throws_ok($$insert into app.approval_policies (org_id, name, document_type, policy_state) values ((select id from world where key = 'org_a'), 'Skip', 'Expense', 'Active')$$,
  'XR001', null, 'a policy cannot be created Active');
select lives_ok($$with x as (insert into app.approval_policies (org_id, name, document_type) values ((select id from world where key = 'org_a'), 'Expenses', 'Expense') returning id) insert into world select 'pol_empty', id from x$$,
  'a second Draft policy');
select lives_ok($$with x as (insert into app.approval_policies (org_id, name, document_type, currency_code, applies_above_minor) values ((select id from world where key = 'org_a'), 'Large requisitions', 'Requisition', 'USD', 500000) returning id) insert into world select 'pol_req', id from x$$,
  'a policy with a threshold');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.approval_policies (org_id, name, document_type) values ((select id from world where key = 'org_a'), 'Mine', 'Expense')$$,
  '42501', null, 'a Manager cannot create approval policies');
select is((select count(*)::int from app.approval_policies), 3, 'a Manager reads the org''s policies');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.approval_policies), 3, 'a Viewer reads them too, to know what a document will go through');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.approval_policies where org_id = pg_temp.id('org_a')), 0, 'another org reads no policies');
select throws_ok($$insert into app.approval_policies (org_id, name, document_type) values ((select id from world where key = 'org_a'), 'Cross', 'Expense')$$,
  '42501', null, 'another org cannot create a policy here');
select pg_temp.as_anon();
select throws_ok('select 1 from app.approval_policies', '42501', null, 'anon cannot read policies');
select throws_ok('select 1 from app.approval_instances', '42501', null, 'anon cannot read approvals');
select throws_ok('select 1 from app.approval_decisions', '42501', null, 'anon cannot read decisions');
select throws_ok($$select app.request_approval('Purchase Order', gen_random_uuid())$$, '42501', null, 'anon cannot request approval');
select pg_temp.as_platform();

-- Steps -------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok($$insert into app.approval_steps (approval_policy_id, step_order, name, approver_role_id) values ((select id from world where key = 'pol'), 1, 'Admin review', pg_temp.system_role('admin'))$$,
  'step 1 names a role');
select lives_ok($$insert into app.approval_steps (approval_policy_id, step_order, name, approver_membership_id) values ((select id from world where key = 'pol'), 2, 'Owner sign-off', (select id from world where key = 'alice@org_a'))$$,
  'step 2 names one member');
select throws_ok($$insert into app.approval_steps (approval_policy_id, step_order, name, approver_role_id, approver_membership_id) values ((select id from world where key = 'pol'), 3, 'Both', pg_temp.system_role('admin'), (select id from world where key = 'alice@org_a'))$$,
  '23514', null, 'a step names a role or a member, not both');
select throws_ok($$insert into app.approval_steps (approval_policy_id, step_order, name, approver_role_id) values ((select id from world where key = 'pol'), 1, 'Again', pg_temp.system_role('admin'))$$,
  '23505', null, 'step orders are unique within a policy');
select is((select org_id from app.approval_steps where approval_policy_id = pg_temp.id('pol') limit 1), pg_temp.id('org_a'), 'a step''s org is derived from its policy');
insert into app.approval_steps (approval_policy_id, step_order, name, approver_membership_id) values (pg_temp.id('pol_req'), 1, 'Viewer sign-off', pg_temp.id('gina@org_a'));
select pg_temp.as_user('carol');
select throws_ok($$insert into app.approval_steps (approval_policy_id, step_order, name, approver_role_id) values ((select id from world where key = 'pol'), 3, 'Manager', pg_temp.system_role('manager'))$$,
  '42501', null, 'a Manager cannot add steps');
select pg_temp.as_platform();

-- Policy state machine ----------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$select app.transition_approval_policy((select id from world where key = 'pol_empty'), 'Draft', 'Active', 'Go.')$$,
  'XR001', 'approval_policy_no_steps: A policy needs at least one step before it is activated.', 'a policy without steps cannot be activated');
select throws_ok($$update app.approval_policies set policy_state = 'Active' where id = (select id from world where key = 'pol')$$,
  'XR001', null, 'the policy state changes only through its RPC');
select lives_ok($$select app.transition_approval_policy((select id from world where key = 'pol'), 'Draft', 'Active', 'Ready.')$$, 'Draft to Active');
select lives_ok($$select app.transition_approval_policy((select id from world where key = 'pol_req'), 'Draft', 'Active', 'Ready.')$$, 'the requisition policy is Active');
select throws_ok($$select app.transition_approval_policy((select id from world where key = 'pol'), 'Active', 'Draft', 'Back.')$$,
  'XR001', null, 'an Active policy cannot return to Draft');
select throws_ok($$insert into app.approval_steps (approval_policy_id, step_order, name, approver_role_id) values ((select id from world where key = 'pol'), 3, 'Late', pg_temp.system_role('admin'))$$,
  'XR001', null, 'steps are frozen once the policy leaves Draft');
select throws_ok($$update app.approval_steps set name = 'Renamed' where approval_policy_id = (select id from world where key = 'pol')$$,
  'XR001', null, 'and are not edited either');
select throws_ok($$update app.approval_policies set document_type = 'Expense' where id = (select id from world where key = 'pol')$$,
  'XR001', null, 'an Active policy keeps its document type');
select lives_ok($$update app.approval_policies set name = 'Purchase orders, every amount' where id = (select id from world where key = 'pol')$$, 'an Active policy can be renamed');
select throws_ok($$update app.approval_policies set deleted_at = now() where id = (select id from world where key = 'pol')$$,
  'XR001', null, 'an Active policy is retired before it is deleted');
with x as (insert into app.approval_policies (org_id, name, document_type) values (pg_temp.id('org_a'), 'Second PO policy', 'Purchase Order') returning id) insert into world select 'pol_dup', id from x;
insert into app.approval_steps (approval_policy_id, step_order, name, approver_role_id) values (pg_temp.id('pol_dup'), 1, 'Admin', pg_temp.system_role('admin'));
select throws_ok($$select app.transition_approval_policy((select id from world where key = 'pol_dup'), 'Draft', 'Active', 'Go.')$$,
  'XR001', null, 'only one policy per document type is Active');
select lives_ok($$select app.transition_approval_policy((select id from world where key = 'pol_dup'), 'Draft', 'Retired', 'Not needed.')$$, 'Draft to Retired');
select throws_ok($$select app.transition_approval_policy((select id from world where key = 'pol_dup'), 'Retired', 'Active', 'Again.')$$,
  'XR001', null, 'a Retired policy stays retired');
select pg_temp.as_user('carol');
select throws_ok($$select app.transition_approval_policy((select id from world where key = 'pol_empty'), 'Draft', 'Retired', 'x')$$,
  '42501', null, 'a Manager cannot move policies');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'approval_policy.state_changed' and subject_id = pg_temp.id('pol')), 1, 'activation emitted approval_policy.state_changed');

-- The spend authority gate ------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$select app.approve_purchase_order((select id from world where key = 'po'), 'Go.')$$,
  'XR001', 'approval_policy_pending: This Purchase Order needs approval under the policy Purchase orders, every amount before it is approved; request approval first.', 'an order an Active policy covers is refused until its approval is Approved');
select pg_temp.as_platform();

-- Requesting --------------------------------------------------------------------------------------------
select pg_temp.as_user('xavier');
select throws_ok($$select app.request_approval('Purchase Order', (select id from world where key = 'po'))$$, '42501', null, 'another org cannot request approval of the order');
select pg_temp.as_user('gina');
select throws_ok($$select app.request_approval('Purchase Order', (select id from world where key = 'po'))$$, '42501', null, 'a Viewer cannot request approval');
select pg_temp.as_user('carol');
select throws_ok($$select app.request_approval('Purchase Order', (select id from world where key = 'po_unpriced'))$$,
  'XR001', 'approval_unpriced: Price every line of the document before requesting approval.', 'an unpriced order cannot be submitted');
select throws_ok($$select app.request_approval('Requisition', (select id from world where key = 'req'))$$,
  'XR001', 'approval_policy_none: No Active approval policy applies to this Requisition; approve it directly.', 'a requisition below the policy threshold needs no approval');
select lives_ok($$insert into world values ('ai', app.request_approval('Purchase Order', (select id from world where key = 'po')))$$, 'the preparer requests approval');
select is((select approval_state::text || ' ' || amount_minor || ' ' || currency_code || ' ' || current_step from app.approval_instances where id = pg_temp.id('ai')),
  'In Review 40000 USD 1', 'the approval carries the order''s amount and currency and waits on step 1');
select is((select requested_by from app.approval_instances where id = pg_temp.id('ai')), pg_temp.id('carol'), 'the requester is the session person');
select throws_ok($$select app.request_approval('Purchase Order', (select id from world where key = 'po'))$$,
  'XR001', 'approval_in_review: This document is already in review.', 'a document is in review once at a time');
select throws_ok($$update app.approval_instances set amount_minor = 1 where id = (select id from world where key = 'ai')$$,
  '42501', null, 'approvals are not written directly');
select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where subject_id = pg_temp.id('ai') and recipient_person_id = pg_temp.id('bob') and kind = 'approval.requested'), 1,
  'the step 1 approver is notified');

-- Reading approvals -------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select count(*)::int from app.approval_instances), 1, 'the requester reads the approval');
select pg_temp.as_user('bob');
select is((select count(*)::int from app.approval_instances), 1, 'an approver reads it');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.approval_instances), 0, 'a member who is neither requester nor approver does not');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.approval_instances where org_id = pg_temp.id('org_a')), 0, 'another org reads no approvals');

-- Deciding ----------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select app.decide_approval((select id from world where key = 'ai'), true, null)$$,
  'XR001', 'sod_approval_requester: An approval is decided by an eligible approver, never the requester.', 'the requester never decides');
select pg_temp.as_user('alice');
select throws_ok($$select app.decide_approval((select id from world where key = 'ai'), true, null)$$,
  'XR001', 'approval_not_step_approver: You are not an approver of the step this approval is waiting on.', 'only step 1''s approvers decide step 1');
select pg_temp.as_user('bob');
select throws_ok($$select app.decide_approval((select id from world where key = 'ai'), false, ' ')$$,
  'XR001', 'approval_rejection_reason: Say why when you reject an approval.', 'a rejection needs a reason');
select throws_ok($$insert into app.approval_decisions (approval_instance_id, step_order, approver_id, approved) values ((select id from world where key = 'ai'), 1, (select id from world where key = 'bob'), true)$$,
  '42501', null, 'decisions are written only through the RPC');
select lives_ok($$select app.decide_approval((select id from world where key = 'ai'), true, 'Within budget.')$$, 'the Admin approves step 1');
select is((select approval_state::text || ' ' || current_step from app.approval_instances where id = pg_temp.id('ai')), 'In Review 2', 'the approval moves to step 2');
select throws_ok($$select app.decide_approval((select id from world where key = 'ai'), true, null)$$,
  'XR001', null, 'step 2 needs its own approver');
select pg_temp.as_user('alice');
select lives_ok($$select app.decide_approval((select id from world where key = 'ai'), true, null)$$, 'the Owner approves the last step');
select is((select approval_state::text from app.approval_instances where id = pg_temp.id('ai')), 'Approved', 'the last approving step approves the approval');
select isnt((select decided_at from app.approval_instances where id = pg_temp.id('ai')), null, 'and stamps when');
select throws_ok($$select app.decide_approval((select id from world where key = 'ai'), true, null)$$,
  'XR001', null, 'an Approved approval takes no more decisions');
select pg_temp.as_platform();
select throws_ok($$update app.approval_decisions set approved = false where approval_instance_id = (select id from world where key = 'ai')$$,
  'XR001', null, 'decisions are append-only');
select is((select count(*)::int from app.domain_events where event_type = 'approval.approved' and subject_id = pg_temp.id('ai')), 1, 'approval.approved was emitted');
select is((select count(*)::int from app.notifications where subject_id = pg_temp.id('ai') and recipient_person_id = pg_temp.id('carol') and kind = 'approval.decided'), 1,
  'the requester is told the outcome');
select pg_temp.as_user('bob');
select is(app.approve_purchase_order(pg_temp.id('po'), 'Approved under policy.'), true, 'with the approval Approved, the order''s own approval goes through');
select pg_temp.as_platform();

-- Rejection, re-request and cancellation -----------------------------------------------------------------
select pg_temp.as_user('carol');
insert into world values ('ai2', app.request_approval('Purchase Order', pg_temp.id('po2')));
select pg_temp.as_user('bob');
select lives_ok($$select app.decide_approval((select id from world where key = 'ai2'), false, 'Use the house truss.')$$, 'the Admin rejects');
select is((select approval_state::text from app.approval_instances where id = pg_temp.id('ai2')), 'Rejected', 'a rejection rejects the approval');
select pg_temp.as_user('carol');
select lives_ok($$insert into world values ('ai3', app.request_approval('Purchase Order', (select id from world where key = 'po2')))$$, 'a rejected document can be submitted again');
select pg_temp.as_user('dave');
select throws_ok($$select app.cancel_approval((select id from world where key = 'ai3'), 'Not mine.')$$, '42501', null, 'only the requester or an administrator cancels');
select pg_temp.as_platform();
insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_boolean)
  values (pg_temp.id('org_a'), 'approvals.requester_may_cancel', 'Organization', pg_temp.id('org_a'), false);
select pg_temp.as_user('carol');
select throws_ok($$select app.cancel_approval((select id from world where key = 'ai3'), 'Withdrawn.')$$,
  'XR001', 'approval_requester_cancel_off: Your organization lets only policy administrators withdraw approvals.', 'with approvals.requester_may_cancel off, a requester cannot withdraw');
select pg_temp.as_platform();
update app.setting_values set value_boolean = true where setting_key = 'approvals.requester_may_cancel' and org_id = pg_temp.id('org_a');
select pg_temp.as_user('carol');
select lives_ok($$select app.cancel_approval((select id from world where key = 'ai3'), 'Withdrawn.')$$, 'the requester withdraws');
select throws_ok($$select app.cancel_approval((select id from world where key = 'ai3'), 'Again.')$$, 'XR001', null, 'a Canceled approval stays canceled');
select pg_temp.as_platform();

-- Supersession when the amount grows ----------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into world values ('ai4', app.request_approval('Purchase Order', pg_temp.id('po3')));
select pg_temp.as_user('bob');
select app.decide_approval(pg_temp.id('ai4'), true, null);
select pg_temp.as_user('alice');
select app.decide_approval(pg_temp.id('ai4'), true, null);
select pg_temp.as_user('carol');
update app.po_lines set unit_price_minor = 90000 where id = pg_temp.id('po3_line');
select pg_temp.as_user('bob');
select throws_ok($$select app.approve_purchase_order((select id from world where key = 'po3'), 'Go.')$$,
  'XR001', 'approval_policy_pending: This Purchase Order needs approval under the policy Purchase orders, every amount before it is approved; request approval first.', 'an approval no longer covers an order whose amount grew');
select pg_temp.as_user('carol');
select lives_ok($$insert into world values ('ai5', app.request_approval('Purchase Order', (select id from world where key = 'po3')))$$, 'the grown order is submitted again');
select is((select approval_state::text from app.approval_instances where id = pg_temp.id('ai4')), 'Canceled', 'the outgrown approval is superseded');

-- A step's approver also needs the document's approval capability (A22-003) ------------------------------------
select pg_temp.as_user('carol');
insert into world values ('ai_req', app.request_approval('Requisition', pg_temp.id('req_big')));
select pg_temp.as_user('gina');
select throws_ok($$select app.decide_approval((select id from world where key = 'ai_req'), true, null)$$,
  'XR001', 'approval_approver_capability: Approving this document needs its approval capability; a step''s approver must also hold it.',
  'a Viewer named on a step cannot approve without the approval capability');
select is((select count(*)::int from app.approval_decisions where approval_instance_id = pg_temp.id('ai_req')), 0, 'and no decision is recorded');
select pg_temp.as_platform();

-- Threshold: below it, no policy applies -------------------------------------------------------------------
select pg_temp.as_user('bob');
select is(app.approve_requisition(pg_temp.id('req'), 'Below the threshold.'), true, 'a requisition below the threshold is approved without a policy approval');
select pg_temp.as_platform();

select * from finish();
rollback;
