-- pgTAP: what the role lens reads to keep each Inbox item under the role that brought it (A128, ADR 0107, 2211).
-- app.inbox_items names the approver of the step an approval request waits on, a role or one member, as
-- private.step_approver_person_ids picks them; app.role_lens_personal_capabilities lists the capabilities a person
-- holds through no role, whose notices are theirs under every lens.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(12);

-- World: a purchase order policy (Admins, then the Owner by name) and an order in review, as in 1064 ---------------
select pg_temp.as_user('alice');
insert into world values ('cp_v', app.create_counterparty(pg_temp.id('org_a'), 'Harborline Staging', 'Equipment Rental'));
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v')) returning id) insert into world select 'ven', id from x;
select app.transition_vendor(pg_temp.id('ven'), 'Prospect', 'Onboarded', 'Paperwork in.');
select app.transition_vendor(pg_temp.id('ven'), 'Onboarded', 'Active', 'Approved for use.');
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po1', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor) values (pg_temp.id('po1'), 1, 'Stage deck.', 2, 20000);
select pg_temp.as_user('bob');
with x as (insert into app.approval_policies (org_id, name, document_type) values (pg_temp.id('org_a'), 'Purchase orders', 'Purchase Order') returning id)
  insert into world select 'pol', id from x;
insert into app.approval_steps (approval_policy_id, step_order, name, approver_role_id) values (pg_temp.id('pol'), 1, 'Finance review', pg_temp.system_role('admin'));
insert into app.approval_steps (approval_policy_id, step_order, name, approver_membership_id) values (pg_temp.id('pol'), 2, 'Owner sign-off', pg_temp.id('alice@org_a'));
select app.transition_approval_policy(pg_temp.id('pol'), 'Draft', 'Active', 'Ready.');
select pg_temp.as_user('carol');
insert into world select 'ap1', app.request_approval('Purchase Order', pg_temp.id('po1'));

-- The step an approval request waits on ----------------------------------------------------------------------------
select pg_temp.as_user('bob');
select is((select approver_role_id from app.inbox_items where kind = 'approval.requested' and subject_id = pg_temp.id('ap1')),
  pg_temp.system_role('admin'), 'a step naming a role names that role on the approver''s Inbox item');
select is((select approver_membership_id from app.inbox_items where kind = 'approval.requested' and subject_id = pg_temp.id('ap1')),
  null::uuid, 'and no member');
select lives_ok($$select app.act_on_notification((select id from app.inbox_items where kind = 'approval.requested'
  and subject_id = (select id from world where key = 'ap1')), 'approve')$$, 'the Admin approves the first step');
select pg_temp.as_user('alice');
select is((select approver_membership_id from app.inbox_items where kind = 'approval.requested' and subject_id = pg_temp.id('ap1')),
  pg_temp.id('alice@org_a'), 'a step naming one member names that member on their Inbox item');
select is((select approver_role_id from app.inbox_items where kind = 'approval.requested' and subject_id = pg_temp.id('ap1')),
  null::uuid, 'and no role, so it is theirs under every lens');
select is((select count(*)::int from app.inbox_items where (approver_role_id is not null or approver_membership_id is not null)
           and kind <> 'approval.requested'), 0, 'only approval requests name a step''s approver');

-- Capabilities held through no role --------------------------------------------------------------------------------
select pg_temp.as_user('mia');
select is((select count(*)::int from app.role_lens_personal_capabilities()), 0,
  'a Member and Field user holds nothing through no role: every capability comes from a role');
select pg_temp.as_user('bob');
insert into app.user_capability_grants (membership_id, capability_code, reason, valid_to)
values (pg_temp.id('mia@org_a'), 'org.members.manage', 'Covers member admin during the festival.', now() + interval '7 days');
select pg_temp.as_user('carol');
insert into app.delegations (delegator_membership_id, delegate_membership_id, capability_code, valid_from, valid_to, reason)
values (pg_temp.id('carol@org_a'), pg_temp.id('mia@org_a'), null, now() - interval '1 hour', now() + interval '1 day',
        'Out of office for the load-out.');
select pg_temp.as_user('mia');
select ok((select count(*) from app.role_lens_personal_capabilities()
           where org_id = pg_temp.id('org_a') and capability_code = 'org.members.manage') = 1,
  'a direct grant is held through no role');
select ok((select count(*) from app.role_lens_personal_capabilities()
           where org_id = pg_temp.id('org_a') and capability_code = 'crew.timesheet.approve') = 1,
  'nor is an approval delegated by an away manager');
select is((select count(*)::int from app.role_lens_personal_capabilities() p
           where p.capability_code = 'finance.budget.write' or p.org_id <> pg_temp.id('org_a')), 0,
  'a delegation of approvals passes on no write, and another org''s roles add nothing');
select pg_temp.as_anon();
select throws_ok('select * from app.role_lens_personal_capabilities()', '42501', null, 'anon cannot ask');

select pg_temp.as_platform();
select is(has_table_privilege('xos_backup', 'app.inbox_items', 'select'), false,
  'the read-only backup login still reads no view');

select * from finish();
rollback;
