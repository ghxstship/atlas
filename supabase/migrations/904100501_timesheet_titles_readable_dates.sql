-- 4.10 fix (C-24): a timesheet's approval request and its reminders name the period in words, "Nov 8 to Nov 10",
-- where the title read "2026-11-08 to 2026-11-10". Compass and Atlas show message_args.title as it is, and push and
-- email carry it too. private.date_range_label writes a range of days in the English the server's titles are in (the
-- month as three letters, the year only when the range is not in one year); Compass composes the request's title in the
-- person's own language from workerName, periodStart and periodEnd, which the request has carried since 4755.
--
-- A timesheet's reminder carries workerName, periodStart and periodEnd as its request does, so Compass writes the
-- reminder in the person's language too, and its title names a roster-entry worker, whom 5862's two-argument
-- private.worker_person_id left blank ("Timesheet , Nov 8 to Nov 10").
--
-- private.timesheet_approval_requests starts from 4755, private.pending_approvals and private.send_approval_reminder from
-- 5862; each keeps its signature, owner and grants. Notifications sent before this keep their title and arguments.

create or replace function private.date_range_label(p_start date, p_end date)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_start is null or p_end is null then coalesce(p_start::text, p_end::text, '')
    when p_start = p_end then to_char(p_start, 'Mon FMDD')
    when extract(year from p_start) = extract(year from p_end)
      then to_char(p_start, 'Mon FMDD') || ' to ' || to_char(p_end, 'Mon FMDD')
    else to_char(p_start, 'Mon FMDD, YYYY') || ' to ' || to_char(p_end, 'Mon FMDD, YYYY')
  end;
$$;

comment on function private.date_range_label(date, date) is 'A range of days in words for a server-written title (C-24): "Nov 8" for one day, "Nov 8 to Nov 10" within a year, "Dec 29, 2026 to Jan 4, 2027" across years. English month abbreviations whatever the session''s lc_time; Compass writes the person''s own language from the dates.';
revoke all on function private.date_range_label(date, date) from public, anon, authenticated;

-- A submitted timesheet asks its approvers (latest: 4755) --------------------------------------------------------------------------

create or replace function private.timesheet_approval_requests()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sheet record;
  v_person uuid;
  v_title text;
begin
  if new.from_state = 'Submitted' and new.to_state <> 'Submitted' then
    update app.notifications set archived_at = now()
    where subject_table = 'timesheets' and subject_id = new.timesheet_id
      and kind = 'approval.requested' and archived_at is null and deleted_at is null;
  end if;
  if new.to_state = 'Submitted' then
    select t.id, t.org_id, t.project_id, t.period_start, t.period_end, t.submitted_by,
      (select p.full_name from app.people p
       where p.id = private.worker_person_id(t.membership_id, t.engagement_id, t.roster_entry_id)) as worker_name,
      (select p.full_name from app.people p where p.id = t.submitted_by) as submitter_name
    into v_sheet
    from app.timesheets t where t.id = new.timesheet_id;
    v_title := format('Timesheet %s, %s', coalesce(v_sheet.worker_name, ''),
      private.date_range_label(v_sheet.period_start, v_sheet.period_end));
    for v_person in select x from private.timesheet_approver_person_ids(new.timesheet_id) x loop
      perform private.notify(v_sheet.org_id, v_person, 'approval.requested', 'timesheets', v_sheet.id, v_sheet.project_id,
        jsonb_build_object('title', v_title, 'actorName', coalesce(v_sheet.submitter_name, ''),
          'workerName', coalesce(v_sheet.worker_name, ''), 'periodStart', v_sheet.period_start::text,
          'periodEnd', v_sheet.period_end::text));
    end loop;
  end if;
  return null;
end;
$$;

comment on function private.timesheet_approval_requests() is 'On a timesheet transition: Submitted notifies every org-wide approver except the submitter and the worker, member, external or agency staff member (approval.requested about the timesheet, named for the worker); leaving Submitted takes the open requests out of every Inbox.';
revoke all on function private.timesheet_approval_requests() from public, anon, authenticated;

-- What waits, and since when, for the reminders (latest: 5862) ---------------------------------------------------------------------

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
    format('Timesheet %s, %s',
      coalesce((select p.full_name from app.people p
                where p.id = private.worker_person_id(t.membership_id, t.engagement_id, t.roster_entry_id)), ''),
      private.date_range_label(t.period_start, t.period_end))
  from app.timesheets t
  where t.timesheet_state = 'Submitted' and t.deleted_at is null
  union all
  select a.org_id, a.project_id, 'subject_approvals', a.id, p.current_step, a.requested_by, p.waiting_since,
    private.subject_approval_title(a.id)
  from app.subject_approvals a
  cross join lateral private.subject_approval_progress(a.id, a.approval_rule_id, a.canceled_at, a.created_at) p
  where a.deleted_at is null and a.canceled_at is null and p.approval_state = 'In Review';
$$;

comment on function private.pending_approvals() is 'Every approval waiting on a decision now, for the reminder job and the manual nudge (P9): spend approval instances In Review at their current step, waiting since their last decision or since they were requested; submitted timesheets, waiting since their latest Submitted transition; and subject approvals In Review at their current step (5860). With the requester and a title for the reminder.';
revoke all on function private.pending_approvals() from public, anon, authenticated;

-- A reminder carries what its request carries (latest: 5862) -----------------------------------------------------------------------

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
  elsif p_subject_table = 'timesheets' then
    -- The worker and the period, as the request carries them, for Compass to write in the person's language (C-24).
    v_args := v_args || coalesce((
      select jsonb_build_object(
        'workerName', coalesce((select p.full_name from app.people p
                                where p.id = private.worker_person_id(t.membership_id, t.engagement_id, t.roster_entry_id)), ''),
        'periodStart', t.period_start::text, 'periodEnd', t.period_end::text)
      from app.timesheets t where t.id = p_subject_id), '{}'::jsonb);
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

comment on function private.send_approval_reminder(uuid, uuid, text, uuid, smallint, uuid, timestamptz, text, smallint, integer, text, uuid, timestamptz) is 'Records reminder p_number of a pending approval''s step in app.approval_reminders, then sends approval.reminder through private.notify to each of the step''s approvers (private.approval_step_recipients), replacing each person''s earlier open reminder for the approval and revoking its links. Arguments: title, actorName (the requester, or the org), waitingSince (ISO instant), reminderNumber, reminderLimit, stepOrder for a subject approval, and workerName, periodStart and periodEnd (ISO days) for a timesheet (C-24). Sends nothing when the number is already recorded. Returns the notifications created (P9).';
revoke all on function private.send_approval_reminder(uuid, uuid, text, uuid, smallint, uuid, timestamptz, text, smallint, integer, text, uuid, timestamptz) from public, anon, authenticated;
