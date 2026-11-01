-- 2210_a128.sql
-- A128 the role lens (RRR-173, S4.8.1-06, ADR 0107). Demo Multi-Role (multi@example.com, 1080_a38) is a Producer
-- (Manager) and a Member of the demo org, Admin of Demo Bayside Studios, crew for Demo Harbor Events and an artist
-- for Demo Night Festival. So the role lens journeys can see things leave and come back, this seed:
--   * gives the person two Inbox items in the demo org: a timesheet approval request, which reaches them through
--     crew.timesheet.approve (the Manager role holds it and the Member role does not, so the Member lens hides it),
--     and a mention, addressed to the person, which every lens shows
--   * adds the Field role to their Demo Bayside Studios membership, so the Field lens hides the Admin's navigation
--     (Finance among it); the Admin role still decides everything they can do there
-- Idempotent: each notification and the role are written once, and their email and push copies are never sent.
-- Guarded on 1080_a38's person and membership and on 1490_a92's timesheet; loads cleanly without them.

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  p_multi constant uuid := '01920000-0000-7000-8000-000010800110';
  m_bayside constant uuid := '01920000-0000-7000-8000-000010800905';
  t_sheet constant uuid := '01920000-0000-7000-8000-000014900801';
  r_record uuid;
begin
  if not exists (select 1 from app.people where id = p_multi) then
    return;
  end if;
  insert into app.membership_roles (membership_id, role_id)
  select m.id, r.id
  from app.memberships m
  join app.roles r on r.org_id is null and r.code = 'field'
  where m.id = m_bayside and m.person_id = p_multi and m.deleted_at is null
    and not exists (
      select 1 from app.membership_roles mr
      where mr.membership_id = m.id and mr.role_id = r.id and mr.deleted_at is null
    );
  if exists (select 1 from app.timesheets where id = t_sheet and org_id = c_org)
     and not exists (
       select 1 from app.notifications n
       where n.recipient_person_id = p_multi and n.kind = 'approval.requested' and n.subject_id = t_sheet
     ) then
    perform private.notify(c_org, p_multi, 'approval.requested', 'timesheets', t_sheet, null,
      jsonb_build_object('title', 'Timesheet for Demo Road Crew', 'actorName', 'Demo Road Crew'));
  end if;
  select r.id into r_record from app.records r
  where r.org_id = c_org and r.project_id = c_project and r.deleted_at is null
  order by r.record_number limit 1;
  if r_record is not null and not exists (
    select 1 from app.notifications n
    where n.recipient_person_id = p_multi and n.kind = 'mention.created' and n.subject_id = r_record
  ) then
    perform private.notify(c_org, p_multi, 'mention.created', 'records', r_record, c_project,
      jsonb_build_object('title', 'Load-in plan', 'actorName',
        (select p.full_name from app.people p where p.id = c_owner)));
  end if;
  -- The journeys read the Inbox only; the email and push copies are marked never sent, so the delivery worker
  -- (and 0520's claim test, which claims 50 at a time) never sees them.
  update app.notification_deliveries d set message_status = 'Suppressed', last_error = 'Demo seed: Inbox only.'
  from app.notifications n
  where n.id = d.notification_id and n.created_at = d.notification_created_at and n.recipient_person_id = p_multi
    and n.org_id = c_org and n.kind in ('approval.requested', 'mention.created')
    and d.message_status in ('Queued', 'Deferred');
end;
$$;
