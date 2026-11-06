-- 2862_approval_reminders.sql
-- P9 Approval reminders (RRR-223, gap G-261, ADR 0138). An approval that waits reminds the approvers of the step it
-- waits on, and its requester may nudge them, within a rate limit:
--
--   * Settings (packages/schemas/settings/p9.yaml): approvals.reminders_enabled (default on),
--     approvals.reminder_interval_hours (default 24, 4 to 168) and approvals.reminder_limit (default 3, 1 to 10), read
--     through private.approval_reminder_settings.
--   * app.approval_reminders: the append-only ledger of reminders, per approval and step. A spend approval instance
--     In Review, a submitted timesheet and a subject approval In Review (2860) are reminded.
--   * app.approval_reminder_status: per pending approval and step, when it began to wait, when its approvers were last
--     notified (the later of that and the newest reminder), how many reminders went out, and when the next automatic
--     one is due.
--   * private.send_approval_reminders runs hourly (pg_cron, minute 53): a reminder is due when reminders are on, the
--     interval has passed since the approvers were last notified, and the limit is not reached. It writes the ledger
--     row before it sends anything, so a second run sends nothing. approval.reminder goes through private.notify, so
--     preferences and quiet hours apply, and each email mints fresh one-tap links (A127, 2861).
--   * app.remind_approvers: the requester's manual nudge, at most every 4 hours, counting toward the limit.

-- 1. Settings (packages/schemas/settings/p9.yaml) ----------------------------------------------------------------------------

select private.define_setting('approvals.reminders_enabled', 'Boolean', 'org.approval_policies.write', array['organization'], false, p_default_boolean => true);
select private.define_setting('approvals.reminder_interval_hours', 'Integer', 'org.approval_policies.write', array['organization'], false, p_default_integer => 24, p_min_integer => 4, p_max_integer => 168);
select private.define_setting('approvals.reminder_limit', 'Integer', 'org.approval_policies.write', array['organization'], false, p_default_integer => 3, p_min_integer => 1, p_max_integer => 10);

create or replace function private.approval_reminder_settings(p_org_id uuid)
returns table (enabled boolean, interval_hours integer, reminder_limit integer)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((select v.value_boolean from app.setting_values v
              where v.org_id = p_org_id and v.setting_key = 'approvals.reminders_enabled'
                and v.scope_kind = 'Organization' and v.scope_id = p_org_id and v.deleted_at is null limit 1), true),
    coalesce((select v.value_integer::integer from app.setting_values v
              where v.org_id = p_org_id and v.setting_key = 'approvals.reminder_interval_hours'
                and v.scope_kind = 'Organization' and v.scope_id = p_org_id and v.deleted_at is null limit 1), 24),
    coalesce((select v.value_integer::integer from app.setting_values v
              where v.org_id = p_org_id and v.setting_key = 'approvals.reminder_limit'
                and v.scope_kind = 'Organization' and v.scope_id = p_org_id and v.deleted_at is null limit 1), 3)
  where p_org_id in (select private.my_org_ids()) or private.current_person_id() is null;
$$;

comment on function private.approval_reminder_settings(uuid) is 'The org settings approvals.reminders_enabled (default true), approvals.reminder_interval_hours (default 24) and approvals.reminder_limit (default 3), P9. Answers for an org of the signed-in person, or for the reminder job, which runs with no person; no row otherwise. Granted to signed-in callers because app.approval_reminder_status, a security_invoker view, reads it.';
revoke all on function private.approval_reminder_settings(uuid) from public, anon;
grant execute on function private.approval_reminder_settings(uuid) to authenticated, service_role;

-- 2. The reminder ledger ---------------------------------------------------------------------------------------------------------

create table app.approval_reminders (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  subject_table text not null,
  subject_id uuid not null,
  step_order smallint,
  reminder_number smallint not null,
  trigger text not null,
  sent_by uuid references app.people (id),
  sent_at timestamptz not null default now(),
  constraint approval_reminders_subject_table check (subject_table in ('approval_instances', 'timesheets', 'subject_approvals')),
  constraint approval_reminders_step check ((step_order is null) = (subject_table = 'timesheets') and (step_order is null or step_order between 1 and 10)),
  constraint approval_reminders_number_range check (reminder_number between 1 and 10),
  constraint approval_reminders_trigger check (trigger in ('Automatic', 'Manual')),
  constraint approval_reminders_sent_by check ((trigger = 'Manual') = (sent_by is not null))
);

create unique index approval_reminders_number_key on app.approval_reminders (subject_table, subject_id, coalesce(step_order, 0), reminder_number);
create index approval_reminders_sent_by_idx on app.approval_reminders (sent_by);

call private.install_domain_table('app.approval_reminders', null, null, '{}', true);
call private.describe('app.approval_reminders', 'Append-only ledger of approval reminders (P9, G-261): one row per reminder sent to the approvers of the step a spend approval, a submitted timesheet or a pass, dock booking or equipment approval waits on. Written only by private.send_approval_reminders and app.remind_approvers, before anything is sent, so a reminder is never sent twice. Read by whoever may read the approval.', array[
  'subject_table', 'Kind of approval: approval_instances, timesheets or subject_approvals.',
  'subject_id', 'The approval instance, timesheet or subject approval.',
  'step_order', 'Step whose approvers were reminded; NULL for a timesheet, which has no steps.',
  'reminder_number', 'Count of reminders for the approval and step, 1 first; never above the org''s reminder limit when sent.',
  'trigger', 'Automatic (the hourly sweep) or Manual (the requester''s Remind approvers).',
  'sent_by', 'Who sent a Manual reminder; NULL for an Automatic one.',
  'sent_at', 'When the reminder was sent.'
]);

call private.install_policies('app.approval_reminders',
  $$(subject_table = 'approval_instances' and subject_id in (select private.readable_approval_ids()))
    or (subject_table = 'timesheets' and exists (select 1 from app.timesheets t where t.id = subject_id))
    or (subject_table = 'subject_approvals' and exists (select 1 from app.subject_approvals a where a.id = subject_id))$$);

call private.install_default_retention('app.approval_reminders');

-- 3. What waits, and since when ---------------------------------------------------------------------------------------------------

create or replace function private.pending_approvals()
returns table (
  org_id uuid,
  project_id uuid,
  subject_table text,
  subject_id uuid,
  step_order smallint,
  requested_by uuid,
  waiting_since timestamptz,
  title text
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.org_id, i.project_id, 'approval_instances'::text, i.id, i.current_step, i.requested_by,
    coalesce((select max(d.decided_at) from app.approval_decisions d where d.approval_instance_id = i.id), i.created_at),
    i.document_type::text || coalesce(' ' || i.subject_reference, '')
  from app.approval_instances i
  where i.approval_state = 'In Review' and i.deleted_at is null
  union all
  select t.org_id, t.project_id, 'timesheets', t.id, null::smallint, t.submitted_by,
    coalesce((select max(x.created_at) from app.timesheet_state_transitions x
              where x.timesheet_id = t.id and x.to_state = 'Submitted'), t.updated_at),
    format('Timesheet %s, %s to %s',
      coalesce((select p.full_name from app.people p where p.id = private.worker_person_id(t.membership_id, t.engagement_id)), ''),
      t.period_start, t.period_end)
  from app.timesheets t
  where t.timesheet_state = 'Submitted' and t.deleted_at is null
  union all
  select a.org_id, a.project_id, 'subject_approvals', a.id, p.current_step, a.requested_by, p.waiting_since,
    private.subject_approval_title(a.id)
  from app.subject_approvals a
  cross join lateral private.subject_approval_progress(a.id, a.approval_rule_id, a.canceled_at, a.created_at) p
  where a.deleted_at is null and a.canceled_at is null and p.approval_state = 'In Review';
$$;

comment on function private.pending_approvals() is 'Every approval waiting on a decision now, for the reminder job and the manual nudge (P9): spend approval instances In Review at their current step, waiting since their last decision or since they were requested; submitted timesheets, waiting since their latest Submitted transition; and subject approvals In Review at their current step (2860). With the requester and a title for the reminder.';
revoke all on function private.pending_approvals() from public, anon, authenticated;

create view app.approval_reminder_status with (security_invoker = true) as
with pending as (
  select i.org_id, 'approval_instances'::text as subject_table, i.id as subject_id, i.current_step as step_order,
    i.requested_by, coalesce((select max(d.decided_at) from app.approval_decisions d where d.approval_instance_id = i.id), i.created_at) as waiting_since
  from app.approval_instances i
  where i.approval_state = 'In Review' and i.deleted_at is null
  union all
  select t.org_id, 'timesheets', t.id, null::smallint, t.submitted_by,
    coalesce((select max(x.created_at) from app.timesheet_state_transitions x
              where x.timesheet_id = t.id and x.to_state = 'Submitted'), t.updated_at)
  from app.timesheets t
  where t.timesheet_state = 'Submitted' and t.deleted_at is null
  union all
  select s.org_id, 'subject_approvals', s.id, s.current_step, s.requested_by, s.waiting_since
  from app.subject_approval_status s
  where s.approval_state = 'In Review'
)
select p.org_id, p.subject_table, p.subject_id, p.step_order, p.requested_by, p.waiting_since,
  greatest(p.waiting_since, r.last_sent_at) as last_notified_at,
  coalesce(r.sent, 0)::integer as reminders_sent,
  coalesce(c.reminder_limit, 3) as reminder_limit,
  coalesce(c.enabled, true) as reminders_enabled,
  case when coalesce(c.enabled, true) and coalesce(r.sent, 0) < coalesce(c.reminder_limit, 3)
       then greatest(p.waiting_since, r.last_sent_at) + make_interval(hours => coalesce(c.interval_hours, 24)) end as next_reminder_at,
  case when coalesce(r.sent, 0) < coalesce(c.reminder_limit, 3)
       then greatest(p.waiting_since, r.last_sent_at) + interval '4 hours' end as next_manual_at
from pending p
left join lateral (
  select count(*) as sent, max(x.sent_at) as last_sent_at from app.approval_reminders x
  where x.subject_table = p.subject_table and x.subject_id = p.subject_id and coalesce(x.step_order, 0) = coalesce(p.step_order, 0)
) r on true
left join lateral private.approval_reminder_settings(p.org_id) c on true;

call private.describe('app.approval_reminder_status', 'Reminder state of every pending approval the signed-in person may read (P9, G-261): per spend approval and step, submitted timesheet, and pass, dock booking or equipment approval and step, when it began to wait, when its approvers were last notified, how many reminders went out of the org''s limit, and when the next automatic reminder and the next manual nudge may go. Read with the person''s own row level security on the approvals.', array[
  'org_id', 'Org of the approval.',
  'subject_table', 'approval_instances, timesheets or subject_approvals.',
  'subject_id', 'The approval instance, timesheet or subject approval.',
  'step_order', 'Step it waits on; NULL for a timesheet.',
  'requested_by', 'Who requested or submitted it.',
  'waiting_since', 'When the step began to wait: the last decision, or the request; for a timesheet, its latest submission.',
  'last_notified_at', 'When the step''s approvers were last told: the later of waiting_since and the newest reminder for the step.',
  'reminders_sent', 'Reminders sent for the step so far, automatic and manual.',
  'reminder_limit', 'The org''s reminder limit (approvals.reminder_limit).',
  'reminders_enabled', 'Whether automatic reminders are on (approvals.reminders_enabled).',
  'next_reminder_at', 'When the next automatic reminder is due; NULL when automatic reminders are off or the limit is reached.',
  'next_manual_at', 'When Remind approvers may next be pressed, 4 hours after the last notice; NULL once the limit is reached.'
]);

revoke all on app.approval_reminder_status from public, anon;
grant select on app.approval_reminder_status to authenticated, service_role;
revoke select on app.approval_reminder_status from xos_backup;

-- 4. Sending ------------------------------------------------------------------------------------------------------------------------

create or replace function private.approval_step_recipients(p_subject_table text, p_subject_id uuid)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_instance app.approval_instances;
  v_unavailable uuid[];
begin
  if p_subject_table = 'approval_instances' then
    select * into v_instance from app.approval_instances i where i.id = p_subject_id;
    v_unavailable := array[v_instance.requested_by] || coalesce(
      (select array_agg(d.approver_id) from app.approval_decisions d where d.approval_instance_id = v_instance.id), '{}'::uuid[]);
    return query select x from private.step_approver_person_ids(v_instance.approval_policy_id, v_instance.current_step, v_unavailable) x
      where x is distinct from v_instance.requested_by and x <> all (v_unavailable);
  elsif p_subject_table = 'timesheets' then
    return query select x from private.timesheet_approver_person_ids(p_subject_id) x;
  elsif p_subject_table = 'subject_approvals' then
    return query select x from private.subject_step_approver_person_ids(p_subject_id) x;
  end if;
end;
$$;

comment on function private.approval_step_recipients(text, uuid) is 'Who a reminder of a pending approval goes to (P9): the approvers of the step it waits on, never its requester or anyone who already decided a step. A spend approval''s step approvers (private.step_approver_person_ids, with an away approver''s delegates, 1395), a timesheet''s org-wide approvers other than its submitter and worker (private.timesheet_approver_person_ids, 1140), or a subject approval''s current step approvers (private.subject_step_approver_person_ids, 2860).';
revoke all on function private.approval_step_recipients(text, uuid) from public, anon, authenticated;

create or replace function private.send_approval_reminder(
  p_org_id uuid,
  p_project_id uuid,
  p_subject_table text,
  p_subject_id uuid,
  p_step_order smallint,
  p_requested_by uuid,
  p_waiting_since timestamptz,
  p_title text,
  p_number smallint,
  p_limit integer,
  p_trigger text,
  p_sent_by uuid,
  p_at timestamptz
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid;
  v_sent integer := 0;
  v_args jsonb;
  v_claimed uuid;
begin
  -- The ledger row first: a second run, or a nudge racing the sweep, finds the number taken and sends nothing.
  insert into app.approval_reminders (org_id, subject_table, subject_id, step_order, reminder_number, trigger, sent_by, sent_at)
  values (p_org_id, p_subject_table, p_subject_id, p_step_order, p_number, p_trigger, p_sent_by, p_at)
  on conflict do nothing
  returning id into v_claimed;
  if v_claimed is null then
    return 0;
  end if;
  v_args := jsonb_build_object('title', p_title,
    'actorName', coalesce((select p.full_name from app.people p where p.id = p_requested_by),
                          (select o.name from app.organizations o where o.id = p_org_id), ''),
    'waitingSince', to_char(p_waiting_since at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'reminderNumber', p_number, 'reminderLimit', p_limit);
  if p_subject_table = 'subject_approvals' then
    v_args := v_args || jsonb_build_object('stepOrder', p_step_order);
  end if;
  for v_person in select x from private.approval_step_recipients(p_subject_table, p_subject_id) x loop
    -- A new reminder replaces the person's earlier one for the same approval, and its links stop working.
    update private.notification_action_tokens t set revoked_at = now()
    where t.used_at is null and t.revoked_at is null and t.notification_id in (
      select n.id from app.notifications n
      where n.recipient_person_id = v_person and n.kind = 'approval.reminder' and n.subject_table = p_subject_table
        and n.subject_id = p_subject_id and n.archived_at is null and n.deleted_at is null);
    update app.notifications n set archived_at = now()
    where n.recipient_person_id = v_person and n.kind = 'approval.reminder' and n.subject_table = p_subject_table
      and n.subject_id = p_subject_id and n.archived_at is null and n.deleted_at is null;
    if private.notify(p_org_id, v_person, 'approval.reminder', p_subject_table, p_subject_id,
         p_project_id, v_args) is not null then
      v_sent := v_sent + 1;
    end if;
  end loop;
  return v_sent;
end;
$$;

comment on function private.send_approval_reminder(uuid, uuid, text, uuid, smallint, uuid, timestamptz, text, smallint, integer, text, uuid, timestamptz) is 'Records reminder p_number of a pending approval''s step in app.approval_reminders, then sends approval.reminder through private.notify to each of the step''s approvers (private.approval_step_recipients), replacing each person''s earlier open reminder for the approval and revoking its links. Arguments: title, actorName (the requester, or the org), waitingSince (ISO instant), reminderNumber, reminderLimit, and stepOrder for a subject approval. Sends nothing when the number is already recorded. Returns the notifications created (P9).';
revoke all on function private.send_approval_reminder(uuid, uuid, text, uuid, smallint, uuid, timestamptz, text, smallint, integer, text, uuid, timestamptz) from public, anon, authenticated;

create or replace function private.reminder_subject_live(p_subject_table text, p_subject_id uuid, p_now timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_subject_table <> 'subject_approvals' then true
    else exists (
      select 1 from app.subject_approvals a
      left join app.credentials c on c.id = a.credential_id
      left join app.dock_slots d on d.id = a.dock_slot_id
      where a.id = p_subject_id
        and (a.credential_id is null or (c.revoked_at is null and c.deleted_at is null))
        and (a.dock_slot_id is null or (d.deleted_at is null and d.ends_at > p_now)))
  end;
$$;

comment on function private.reminder_subject_live(text, uuid, timestamptz) is 'False for a subject approval whose pass is revoked or deleted, or whose dock slot is deleted or has ended, so nobody is reminded about it (P9; 2863 adds a Withdrawn allocation). True for every other approval.';
revoke all on function private.reminder_subject_live(text, uuid, timestamptz) from public, anon, authenticated;

create or replace function private.send_approval_reminders(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pending record;
  v_settings record;
  v_count integer;
  v_last timestamptz;
  v_sent integer := 0;
begin
  for v_pending in select * from private.pending_approvals() loop
    select * into v_settings from private.approval_reminder_settings(v_pending.org_id);
    if not coalesce(v_settings.enabled, true) or not private.reminder_subject_live(v_pending.subject_table, v_pending.subject_id, p_now) then
      continue;
    end if;
    select count(*), max(r.sent_at) into v_count, v_last from app.approval_reminders r
    where r.subject_table = v_pending.subject_table and r.subject_id = v_pending.subject_id
      and coalesce(r.step_order, 0) = coalesce(v_pending.step_order, 0);
    if v_count >= coalesce(v_settings.reminder_limit, 3)
       or p_now < greatest(v_pending.waiting_since, v_last) + make_interval(hours => coalesce(v_settings.interval_hours, 24)) then
      continue;
    end if;
    v_sent := v_sent + private.send_approval_reminder(v_pending.org_id, v_pending.project_id, v_pending.subject_table,
      v_pending.subject_id, v_pending.step_order, v_pending.requested_by, v_pending.waiting_since, v_pending.title, (v_count + 1)::smallint, coalesce(v_settings.reminder_limit, 3),
      'Automatic', null, p_now);
  end loop;
  return v_sent;
end;
$$;

comment on function private.send_approval_reminders(timestamptz) is 'The hourly reminder job (pg_cron xos_send_approval_reminders, minute 53; P9, G-261). For every pending approval (private.pending_approvals) of an org with approvals.reminders_enabled, whose subject is still live, sends the next reminder once approvals.reminder_interval_hours have passed since its approvers were last notified, until approvals.reminder_limit reminders went out. p_now is the time the job runs at (the default, now(), outside tests). Returns the notifications created.';
revoke all on function private.send_approval_reminders(timestamptz) from public, anon, authenticated;

-- 5. The manual nudge -------------------------------------------------------------------------------------------------------------

create or replace function app.remind_approvers(p_subject_table text, p_subject_id uuid)
returns smallint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_pending record;
  v_settings record;
  v_count integer;
  v_last timestamptz;
  v_next timestamptz;
  v_allowed boolean;
  v_org uuid;
begin
  v_org := case p_subject_table
    when 'approval_instances' then (select i.org_id from app.approval_instances i where i.id = p_subject_id and i.deleted_at is null)
    when 'timesheets' then (select t.org_id from app.timesheets t where t.id = p_subject_id and t.deleted_at is null)
    when 'subject_approvals' then (select a.org_id from app.subject_approvals a where a.id = p_subject_id and a.deleted_at is null)
  end;
  if v_org is null or v_org not in (select private.my_org_ids()) then
    raise exception using errcode = '42501', message = 'approval not found';
  end if;
  select * into v_pending from private.pending_approvals() x where x.subject_table = p_subject_table and x.subject_id = p_subject_id;
  v_allowed := private.has_capability(v_org, 'org.approval_policies.write')
    or (v_pending.subject_id is not null and v_pending.requested_by = v_person)
    or (p_subject_table = 'subject_approvals' and exists (
          select 1 from app.subject_approvals a where a.id = p_subject_id
            and (a.requested_by = v_person or private.can_write_approval_rule(a.org_id, a.project_id))))
    or (p_subject_table = 'timesheets' and (
          exists (select 1 from app.timesheets t where t.id = p_subject_id and t.submitted_by = v_person)
          or private.person_capability_reach(v_person, v_org, 'crew.timesheet.approve', true) = 'organization'))
    or (p_subject_table = 'approval_instances' and exists (
          select 1 from app.approval_instances i where i.id = p_subject_id and i.requested_by = v_person));
  if not coalesce(v_allowed, false) then
    raise exception using errcode = '42501', message = 'only the requester or an approval administrator reminds the approvers';
  end if;
  if v_pending.subject_id is null then
    perform private.refuse('approval_not_in_review', 'This approval is no longer waiting on a decision.');
  end if;
  select * into v_settings from private.approval_reminder_settings(v_org);
  select count(*), max(r.sent_at) into v_count, v_last from app.approval_reminders r
  where r.subject_table = p_subject_table and r.subject_id = p_subject_id and coalesce(r.step_order, 0) = coalesce(v_pending.step_order, 0);
  if v_count >= coalesce(v_settings.reminder_limit, 3) then
    perform private.refuse('approval_reminder_limit',
      format('The approvers were reminded %s times, the most your organization allows for one step.', v_count));
  end if;
  v_next := greatest(v_pending.waiting_since, v_last) + interval '4 hours';
  if now() < v_next then
    perform private.refuse('approval_reminder_too_soon',
      format('The approvers were notified less than 4 hours ago. Remind them again after %s UTC.',
        to_char(v_next at time zone 'UTC', 'YYYY-MM-DD HH24:MI')));
  end if;
  perform private.send_approval_reminder(v_pending.org_id, v_pending.project_id, v_pending.subject_table, v_pending.subject_id,
    v_pending.step_order, v_pending.requested_by, v_pending.waiting_since, v_pending.title, (v_count + 1)::smallint,
    coalesce(v_settings.reminder_limit, 3),
    'Manual', v_person, now());
  return (v_count + 1)::smallint;
end;
$$;

comment on function app.remind_approvers(text, uuid) is 'Remind approvers (P9, G-261): sends a Manual reminder to the approvers of the step a pending approval waits on (approval_instances, timesheets or subject_approvals), counting toward the org''s reminder limit. Sent by the requester or a holder of org.approval_policies.write; for a subject approval also a rule writer, for a timesheet its submitter or an org-wide timesheet approver. Refuses an approval no longer pending (approval_not_in_review), a nudge within 4 hours of the last notice, naming the next allowed time (approval_reminder_too_soon), and one past the limit (approval_reminder_limit). Returns the reminder number.';
revoke all on function app.remind_approvers(text, uuid) from public, anon;
grant execute on function app.remind_approvers(text, uuid) to authenticated, service_role;

-- 6. The hourly job ----------------------------------------------------------------------------------------------------------------

-- Minute 53: minute 23 already runs the hourly org lifecycle and the advance reminders.
select cron.schedule('xos_send_approval_reminders', '53 * * * *', 'select private.send_approval_reminders()');
