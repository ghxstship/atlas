-- pgTAP: Inbox (Section 11.10 rule 5, A36). Approval requests land in Needs You for the step's approver,
-- who approves or rejects from the Inbox without opening the record; Done and snoozed items leave the
-- Inbox; nobody acts on another person's notification.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(20);

-- World: a purchase order policy (Admins, then the Owner) and two orders in review ------------------------
select pg_temp.as_user('alice');
insert into world values ('cp_v', app.create_counterparty(pg_temp.id('org_a'), 'Harborline Staging', 'Equipment Rental'));
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v')) returning id) insert into world select 'ven', id from x;
select app.transition_vendor(pg_temp.id('ven'), 'Prospect', 'Onboarded', 'Paperwork in.');
select app.transition_vendor(pg_temp.id('ven'), 'Onboarded', 'Active', 'Approved for use.');
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po1', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor) values (pg_temp.id('po1'), 1, 'Stage deck.', 2, 20000);
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po2', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor) values (pg_temp.id('po2'), 1, 'Truss.', 1, 15000);
select pg_temp.as_user('bob');
with x as (insert into app.approval_policies (org_id, name, document_type) values (pg_temp.id('org_a'), 'Purchase orders', 'Purchase Order') returning id)
  insert into world select 'pol', id from x;
insert into app.approval_steps (approval_policy_id, step_order, name, approver_role_id) values (pg_temp.id('pol'), 1, 'Finance review', pg_temp.system_role('admin'));
insert into app.approval_steps (approval_policy_id, step_order, name, approver_membership_id) values (pg_temp.id('pol'), 2, 'Owner sign-off', pg_temp.id('alice@org_a'));
select app.transition_approval_policy(pg_temp.id('pol'), 'Draft', 'Active', 'Ready.');
select pg_temp.as_user('carol');
insert into world select 'ap1', app.request_approval('Purchase Order', pg_temp.id('po1'));
insert into world select 'ap2', app.request_approval('Purchase Order', pg_temp.id('po2'));
select pg_temp.as_platform();
insert into world select 'n1', id from app.notifications where subject_id = pg_temp.id('ap1') and recipient_person_id = pg_temp.id('bob');
insert into world select 'n2', id from app.notifications where subject_id = pg_temp.id('ap2') and recipient_person_id = pg_temp.id('bob');
create temporary table world_times (key text primary key, created_at timestamptz);
grant select on world_times to public;
insert into world_times select 'n1', created_at from app.notifications where id = pg_temp.id('n1');

-- Reading the Inbox ------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select is((select count(*)::int from app.inbox_items where section = 'Needs You' and kind = 'approval.requested'), 2,
  'both approval requests wait on the Admin in Needs You');
select is((select amount_minor from app.inbox_items where id = pg_temp.id('n1')), 40000::bigint,
  'with the amount of the order, so no record needs opening');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.inbox_items where id in (pg_temp.id('n1'), pg_temp.id('n2'))), 0, 'another member sees none of them');
select throws_ok($$select app.act_on_notification((select id from world where key = 'n1'), 'approve')$$, '42501', null,
  'nor approves from someone else''s notification');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.inbox_items), 0, 'another org''s Owner sees nothing of the org');
select pg_temp.as_anon();
select throws_ok('select 1 from app.inbox_items', '42501', null, 'anon cannot read an Inbox');

-- Acting from the Inbox --------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$select app.act_on_notification((select id from world where key = 'n1'), 'escalate')$$, 'XR001',
  'inbox_action_unknown: An Inbox item is approved, rejected, accepted, declined, answered or marked Done.', 'an unknown action is refused');
select throws_ok($$select app.act_on_notification((select id from world where key = 'n2'), 'reject')$$, 'XR001',
  'approval_rejection_reason: Say why when you reject an approval.', 'a rejection needs a reason, and the item stays');
select is((select count(*)::int from app.inbox_items where id = pg_temp.id('n2')), 1, 'the refused item is still in the Inbox');
select lives_ok($$select app.act_on_notification((select id from world where key = 'n1'), 'approve')$$, 'the Admin approves with A');
select is((select current_step from app.approval_instances where id = pg_temp.id('ap1')), 2::smallint, 'the order moves to the Owner''s step');
select is((select count(*)::int from app.inbox_items where id = pg_temp.id('n1')), 0, 'and leaves the Admin''s Inbox');
select lives_ok($$select app.act_on_notification((select id from world where key = 'n2'), 'reject', 'Over the truss budget.')$$,
  'the Admin rejects the other with a reason');
select is((select approval_state::text from app.approval_instances where id = pg_temp.id('ap2')), 'Rejected', 'the order is rejected');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.inbox_items where kind = 'approval.requested' and subject_id = pg_temp.id('ap1')), 1,
  'the Owner now has the first order in Needs You');
select is((select count(*)::int from app.inbox_items where kind = 'approval.requested' and subject_id = pg_temp.id('ap2')), 0,
  'but not the rejected one');

-- Done and snooze ---------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select count(*)::int from app.inbox_items where kind = 'approval.decided' and section = 'For Your Information'), 1,
  'the requester is told of the rejection under For Your Information');
insert into app.inbox_snoozes (notification_id, notification_created_at, snoozed_until)
select id, created_at, now() + interval '1 day' from app.inbox_items where kind = 'approval.decided';
select is((select count(*)::int from app.inbox_items where kind = 'approval.decided'), 0, 'snoozing hides it until tomorrow');
select throws_ok($$insert into app.inbox_snoozes (notification_id, notification_created_at, snoozed_until)
  select id, created_at, now() + interval '40 days' from app.notifications where recipient_person_id = pg_temp.id('carol') limit 1$$,
  'XR001', null, 'a snooze lasts at most 30 days');
select pg_temp.as_user('dave');
select throws_ok(format($$insert into app.inbox_snoozes (notification_id, notification_created_at, snoozed_until)
  values ('%s', '%s', now() + interval '1 day')$$, pg_temp.id('n1'), (select created_at from world_times where key = 'n1')),
  '42501', null, 'nobody snoozes another person''s notification');

select * from finish();
rollback;
