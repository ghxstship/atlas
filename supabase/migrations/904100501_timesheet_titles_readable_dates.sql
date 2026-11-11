-- 4.10 fix (C-24): a timesheet's approval request and its reminders name the period in words, "Nov 8 to Nov 10",
-- where the title read "2026-11-08 to 2026-11-10". Compass and Atlas show message_args.title as it is, and push and
-- email carry it too. private.date_range_label writes a range of days in the English the server's titles are in (the
-- month as three letters, the year only when the range is not in one year); Compass composes the request's title in the
-- person's own language from workerName, periodStart and periodEnd, which the request has carried since 4755.
--
-- private.timesheet_approval_requests starts from 4755 and private.pending_approvals from 5862; each changes only the
-- title and keeps its signature, owner, description and grants. Notifications sent before this keep their title.

create or replace function private.date_range_label(p_start date, p_end date)
returns text
language sql
immutable
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
      coalesce((select p.full_name from app.people p where p.id = private.worker_person_id(t.membership_id, t.engagement_id)), ''),
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
