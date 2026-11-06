-- pgTAP: migration 2862, approval reminders (P9, G-261, ADR 0138). A spend approval, a submitted timesheet and a subject
-- approval that wait past the interval remind exactly the approvers of the step they wait on, once per run, up to the
-- limit; reminders off sends nothing; the requester's manual nudge is rate-limited and counts toward the limit; the status
-- view says when the approvers were last notified, to readers only; the job is scheduled hourly at minute 53.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(38);

create function pg_temp.reminders(p_subject text, p_person text default null) returns integer language sql as $$
  select count(*)::integer from app.notifications n
  where n.kind = 'approval.reminder' and n.subject_id = pg_temp.id(p_subject)
    and (p_person is null or n.recipient_person_id = pg_temp.id(p_person))
$$;
create function pg_temp.requests(p_subject text) returns integer language sql as $$
  select count(*)::integer from app.notifications n where n.kind = 'approval.requested' and n.subject_id = pg_temp.id(p_subject)
$$;
create function pg_temp.issue(p_key text, p_holder text) returns void language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat_all'), pg_temp.id(p_holder))
  returning id into v_id;
  insert into world values (p_key, v_id);
  perform pg_temp.as_platform();
  insert into world select 'appr_' || p_key, a.id from app.subject_approvals a where a.credential_id = v_id;
end $$;
create function pg_temp.backdate_approval(p_key text, p_age interval) returns void language plpgsql as $$
begin
  perform pg_temp.as_platform();
  alter table app.subject_approvals disable trigger user;
  update app.subject_approvals set created_at = now() - p_age where id = pg_temp.id(p_key);
  alter table app.subject_approvals enable trigger user;
end $$;

-- World: a purchase order in review (Admins decide step 1), a submitted timesheet, a pass in review ---------------------------
select pg_temp.as_user('alice');
insert into world values ('cp_h', app.create_counterparty(pg_temp.id('org_a'), 'Harborline Staging', 'Equipment Rental'));
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_h')) returning id) insert into world select 'ven', id from x;
select app.transition_vendor(pg_temp.id('ven'), 'Prospect', 'Onboarded', 'Paperwork in.');
select app.transition_vendor(pg_temp.id('ven'), 'Onboarded', 'Active', 'Approved for use.');
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'USD') returning id)
  insert into world select 'po', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor) values (pg_temp.id('po'), 1, 'Stage deck.', 2, 20000);
select pg_temp.as_user('bob');
with x as (insert into app.approval_policies (org_id, name, document_type) values (pg_temp.id('org_a'), 'Purchase orders', 'Purchase Order') returning id)
  insert into world select 'pol', id from x;
insert into app.approval_steps (approval_policy_id, step_order, name, approver_role_id) values (pg_temp.id('pol'), 1, 'Finance review', pg_temp.system_role('admin'));
insert into app.approval_steps (approval_policy_id, step_order, name, approver_membership_id) values (pg_temp.id('pol'), 2, 'Owner sign-off', pg_temp.id('alice@org_a'));
select app.transition_approval_policy(pg_temp.id('pol'), 'Draft', 'Active', 'Ready.');
select pg_temp.as_user('carol');
insert into world select 'ap', app.request_approval('Purchase Order', pg_temp.id('po'));

select pg_temp.as_user('frank');
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
           values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-07-05', '2027-07-11') returning id)
  insert into world select 'ts', id from x;
select app.submit_timesheet(pg_temp.id('ts'), 'Week of the load-in.');

select pg_temp.as_user('alice');
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'ALL', 'All Access') returning id) insert into world select 'cat_all', id from x;
with x as (insert into app.approval_rules (project_id, subject, name, credential_category_id)
           values (pg_temp.id('prj_a'), 'Pass', 'All Access passes', pg_temp.id('cat_all')) returning id) insert into world select 'rule', id from x;
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id)
values (pg_temp.id('rule'), 1, 'Production manager', pg_temp.id('bob@org_a'));
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id)
values (pg_temp.id('rule'), 2, 'Owner', pg_temp.id('alice@org_a'));
select app.transition_approval_rule(pg_temp.id('rule'), 'Draft', 'Active', 'Gate All Access.');
select pg_temp.issue('p1', 'frank');

-- 10. The hourly sweep ----------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(private.send_approval_reminders(), 0, 'nothing is due before the interval');
select ok(private.send_approval_reminders(now() + interval '25 hours') > 0, 'after 25 hours reminders go out');
select is(pg_temp.reminders('ap'), pg_temp.requests('ap'), 'the purchase order reminds each approver of its current step once');
select is(pg_temp.reminders('ts'), pg_temp.requests('ts'), 'the timesheet reminds each of its approvers once');
select is(pg_temp.reminders('appr_p1'), 1, 'the pass reminds its step''s one approver once');
select is(pg_temp.reminders('appr_p1', 'bob'), 1, 'and that is bob');
select is(pg_temp.reminders('appr_p1', 'alice'), 0, 'never the approver of a step that is not current');
select is(pg_temp.reminders('ap', 'carol') + pg_temp.reminders('ts', 'frank') + pg_temp.reminders('appr_p1', 'carol'), 0,
  'never the requester or the submitter');
select is((select message_args ->> 'reminderNumber' || ' of ' || (message_args ->> 'reminderLimit') from app.notifications
           where kind = 'approval.reminder' and subject_id = pg_temp.id('appr_p1')), '1 of 3', 'the reminder says which it is');
select is(private.send_approval_reminders(now() + interval '25 hours 30 minutes'), 0, 'a second run in the same hour sends nothing');
select is((select count(*)::integer from app.approval_reminders where subject_id = pg_temp.id('appr_p1')), 1, 'one ledger row per reminder');

select ok(private.send_approval_reminders(now() + interval '50 hours') > 0, 'the interval later, the second reminder goes');
select is((select count(*)::integer from app.notifications where kind = 'approval.reminder' and subject_id = pg_temp.id('appr_p1')
           and archived_at is null), 1, 'and replaces the person''s first, which leaves the Inbox');
select ok(private.send_approval_reminders(now() + interval '75 hours') > 0, 'the third goes');
select is(private.send_approval_reminders(now() + interval '100 hours'), 0, 'and reminders stop at the limit');
select is((select max(reminder_number)::integer from app.approval_reminders where subject_id = pg_temp.id('appr_p1')), 3,
  'three reminders, the default limit');

-- A step decided resets the clock and moves the reminder on --------------------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.issue('p2', 'dave');
select pg_temp.as_user('bob');
select app.decide_subject_approval(pg_temp.id('appr_p2'), true);
select pg_temp.as_platform();
select ok(private.send_approval_reminders(now() + interval '25 hours') > 0, 'after the first step, its waiting restarts');
select is(pg_temp.reminders('appr_p2', 'alice') || ' ' || pg_temp.reminders('appr_p2', 'bob'), '1 0',
  'the second step''s approver is reminded, never the one who decided');

-- One-tap links on a reminder --------------------------------------------------------------------------------------------------------
select is((select string_agg(action, ',' order by action) from private.notification_link_actions(
  (select id from app.notifications where kind = 'approval.reminder' and subject_id = pg_temp.id('appr_p2') and archived_at is null))),
  'approve,reject', 'a reminder''s email offers Approve and Reject, as the request does');
select pg_temp.as_user('alice');
select is((select section from app.inbox_items where kind = 'approval.reminder' and subject_id = pg_temp.id('appr_p2')), 'Needs You',
  'and it waits in Needs You');

-- Reminders off ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_boolean)
values (pg_temp.id('org_a'), 'approvals.reminders_enabled', 'Organization', pg_temp.id('org_a'), false);
select pg_temp.issue('p3', 'erin');
select is(private.send_approval_reminders(now() + interval '25 hours'), 0, 'with reminders off, nothing is sent');
delete from app.setting_values where setting_key = 'approvals.reminders_enabled';


-- 11. The manual nudge -----------------------------------------------------------------------------------------------------------------
select pg_temp.backdate_approval('appr_p3', interval '5 hours');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.remind_approvers('subject_approvals', %L)$$, pg_temp.id('appr_p3')), '42501', null,
  'someone who neither asked nor administers approvals does not nudge');
select pg_temp.as_user('carol');
select is(app.remind_approvers('subject_approvals', pg_temp.id('appr_p3'))::integer, 1, 'the requester sends a manual reminder');
select pg_temp.as_platform();
select is((select trigger || ' ' || sent_by::text from app.approval_reminders where subject_id = pg_temp.id('appr_p3')),
  'Manual ' || pg_temp.id('carol')::text, 'recorded as hers');
select is(pg_temp.reminders('appr_p3', 'bob'), 1, 'and bob is reminded');
select pg_temp.as_user('carol');
select throws_like(format($$select app.remind_approvers('subject_approvals', %L)$$, pg_temp.id('appr_p3')),
  'approval_reminder_too_soon:%after ' || to_char((now() + interval '4 hours') at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC.',
  'a second nudge within 4 hours is refused, naming the next allowed time');

-- 12. What the requester sees, and who sees it -------------------------------------------------------------------------------------------
select is((select concat_ws(' ', reminders_sent, reminder_limit, last_notified_at = now(), next_reminder_at = now() + interval '24 hours',
           next_manual_at = now() + interval '4 hours')
           from app.approval_reminder_status where subject_id = pg_temp.id('appr_p3')),
  '1 3 t t t', 'the status view says one of three, notified now, and when the next reminder and nudge may go');
select is((select waiting_since from app.approval_reminder_status where subject_id = pg_temp.id('appr_p3')), now() - interval '5 hours',
  'and since when it waits');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.approval_reminder_status), 0, 'another org reads none of it');
select pg_temp.as_platform();
insert into app.approval_reminders (org_id, subject_table, subject_id, step_order, reminder_number, trigger, sent_by, sent_at)
values (pg_temp.id('org_a'), 'subject_approvals', pg_temp.id('appr_p3'), 1, 2, 'Manual', pg_temp.id('carol'), now()),
       (pg_temp.id('org_a'), 'subject_approvals', pg_temp.id('appr_p3'), 1, 3, 'Manual', pg_temp.id('carol'), now());
select pg_temp.as_user('carol');
select throws_like(format($$select app.remind_approvers('subject_approvals', %L)$$, pg_temp.id('appr_p3')), 'approval_reminder_limit:%',
  'a nudge past the limit is refused');
select app.cancel_subject_approval(pg_temp.id('appr_p3'), 'Not needed.');
select throws_like(format($$select app.remind_approvers('subject_approvals', %L)$$, pg_temp.id('appr_p3')), 'approval_not_in_review:%',
  'and a withdrawn approval is not nudged');

-- A shorter interval and a lower limit ---------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_integer) values
  (pg_temp.id('org_a'), 'approvals.reminder_interval_hours', 'Organization', pg_temp.id('org_a'), 4),
  (pg_temp.id('org_a'), 'approvals.reminder_limit', 'Organization', pg_temp.id('org_a'), 1);
select pg_temp.issue('p4', 'mia');
select ok(private.send_approval_reminders(now() + interval '5 hours') > 0, 'with a 4-hour interval, reminders go after 5 hours');
select is(pg_temp.reminders('appr_p4'), 1, 'to the pass waiting 5 hours');
select is(private.send_approval_reminders(now() + interval '10 hours'), 0, 'and with a limit of 1, nothing more goes');
delete from app.setting_values where setting_key in ('approvals.reminder_interval_hours', 'approvals.reminder_limit');

-- A delivery whose slot has ended is not reminded about -------------------------------------------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'DCK', 'Dock A') returning id) insert into world select 'dock', id from x;
with x as (insert into app.approval_rules (project_id, subject, name, zone_id)
           values (pg_temp.id('prj_a'), 'Delivery', 'Dock A bookings', pg_temp.id('dock')) returning id) insert into world select 'rule_dock', id from x;
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id)
values (pg_temp.id('rule_dock'), 1, 'Logistics', pg_temp.id('bob@org_a'));
select app.transition_approval_rule(pg_temp.id('rule_dock'), 'Draft', 'Active', 'Gate Dock A.');
with x as (insert into app.dock_slots (project_id, zone_id, starts_at, ends_at)
           values (pg_temp.id('prj_a'), pg_temp.id('dock'), now() + interval '1 hour', now() + interval '3 hours') returning id)
  insert into world select 'slot_ended', id from x;
with x as (insert into app.dock_slots (project_id, zone_id, starts_at, ends_at)
           values (pg_temp.id('prj_a'), pg_temp.id('dock'), now() + interval '3 days', now() + interval '3 days 2 hours') returning id)
  insert into world select 'slot_live', id from x;
select pg_temp.as_platform();
insert into world select 'appr_' || w.key, a.id from app.subject_approvals a join world w on w.id = a.dock_slot_id
where w.key in ('slot_ended', 'slot_live');
select private.send_approval_reminders(now() + interval '25 hours');
select is(pg_temp.reminders('appr_slot_ended'), 0, 'a booking whose slot ended before the reminder is due reminds no one');
select is(pg_temp.reminders('appr_slot_live', 'bob'), 1, 'one still to come reminds its approver');

-- 13. The schedule, and the backup login -----------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select schedule from cron.job where jobname = 'xos_send_approval_reminders'), '53 * * * *',
  'the sweep runs hourly at minute 53');
select ok(not has_table_privilege('xos_backup', 'app.approval_reminder_status', 'SELECT'), 'the backup login does not read the status view');

select * from finish();
rollback;
