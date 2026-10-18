-- A45 (RRR-89), journey 57: a Producer approves a timesheet from a push notification without opening it.
--
-- A submitted timesheet now asks for approval where approvals arrive (Section 11.10 rule 5): everyone who
-- may approve it org-wide is notified with approval.requested about the timesheet, except its submitter and
-- its worker (invariant 18). The notification lands in Needs You, goes out on push, and its Approve action
-- calls app.act_on_notification through notifications.act, which now decides a timesheet through
-- app.decide_timesheet (every timesheet rule still decides). Once the timesheet leaves Submitted, by any
-- path, the other approvers' requests leave their Inboxes.

create or replace function private.timesheet_approver_person_ids(p_timesheet_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.person_id
  from app.timesheets t
  join app.memberships m on m.org_id = t.org_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  where t.id = p_timesheet_id
    and private.person_capability_reach(m.person_id, t.org_id, 'crew.timesheet.approve', true) = 'organization'
    and m.person_id is distinct from t.submitted_by
    and m.person_id is distinct from private.worker_person_id(t.membership_id, t.engagement_id);
$$;

comment on function private.timesheet_approver_person_ids(uuid) is 'People who may approve a timesheet org-wide now, never its submitter or its worker (invariant 18), for approval request notifications.';
revoke all on function private.timesheet_approver_person_ids(uuid) from public, anon, authenticated;

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
      (select p.full_name from app.people p where p.id = private.worker_person_id(t.membership_id, t.engagement_id)) as worker_name,
      (select p.full_name from app.people p where p.id = t.submitted_by) as submitter_name
    into v_sheet
    from app.timesheets t where t.id = new.timesheet_id;
    v_title := format('Timesheet %s, %s to %s', coalesce(v_sheet.worker_name, ''), v_sheet.period_start, v_sheet.period_end);
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

comment on function private.timesheet_approval_requests() is 'On a timesheet transition: Submitted notifies every org-wide approver except the submitter and the worker (approval.requested about the timesheet); leaving Submitted takes the open requests out of every Inbox.';
revoke all on function private.timesheet_approval_requests() from public, anon, authenticated;

create trigger t91_timesheet_approval_requests after insert on app.timesheet_state_transitions
  for each row execute function private.timesheet_approval_requests();

create or replace function app.act_on_notification(p_notification_id uuid, p_action text, p_comment text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_note app.notifications;
begin
  select * into v_note from app.notifications n
  where n.id = p_notification_id and n.recipient_person_id = v_person
    and n.org_id in (select private.my_org_ids()) and n.deleted_at is null;
  if v_note.id is null then
    raise exception using errcode = '42501', message = 'notification not found';
  end if;
  if p_action not in ('approve', 'reject', 'done') or p_action is null then
    perform private.refuse('inbox_action_unknown', 'An Inbox item is approved, rejected or marked Done.');
  end if;
  if p_action in ('approve', 'reject') then
    if v_note.kind <> 'approval.requested' or v_note.subject_table not in ('approval_instances', 'timesheets') then
      perform private.refuse('inbox_action_not_offered', 'Only an approval request is approved or rejected from the Inbox.');
    end if;
    if v_note.subject_table = 'timesheets' then
      if p_action = 'reject' and nullif(btrim(coalesce(p_comment, '')), '') is null then
        perform private.refuse('timesheet_rejection_reason', 'Say why when you reject a timesheet.');
      end if;
      perform app.decide_timesheet(v_note.subject_id,
        (case when p_action = 'approve' then 'Approved' else 'Rejected' end)::app.approval_decision,
        coalesce(nullif(btrim(coalesce(p_comment, '')), ''), 'Approved from a notification.'));
    else
      perform app.decide_approval(v_note.subject_id, p_action = 'approve', p_comment);
    end if;
  end if;
  update app.notifications set read_at = coalesce(read_at, now()), archived_at = now()
  where id = v_note.id and created_at = v_note.created_at;
  return v_note.id;
end;
$$;

comment on function app.act_on_notification(uuid, text, text) is 'Acts on a notification where it arrives (Section 11.10 rule 5), for its recipient only: approve or reject the approval or the timesheet an approval request asks for (app.decide_approval and app.decide_timesheet decide every rule, so a refusal names it and the item stays), or mark it Done. A decided or Done item leaves the Inbox. Push notification actions call it through the API (notifications.act). Returns the notification id.';
revoke all on function app.act_on_notification(uuid, text, text) from public, anon;
grant execute on function app.act_on_notification(uuid, text, text) to authenticated, service_role;
