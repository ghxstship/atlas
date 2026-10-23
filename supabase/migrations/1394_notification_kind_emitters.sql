-- 1394_notification_kind_emitters.sql
-- Orchestrator block (ADR 0022, 1390 to 1399), RRR-125. Emitters for four registry kinds nothing sent.
--
-- ADR 0033 decision 35 lets safety alerts and changes to a shift starting within 12 hours through quiet hours, and
-- the registry (packages/schemas/notification-kinds.yaml) flags shift.changed and incident.reported for it, but no
-- migration or service ever created those notifications: a reported incident only emitted a domain event, and a
-- moved shift nothing at all. Settings promised "Safety alerts and changes to a shift starting within 12 hours
-- always arrive at once" while none arrived. Assignments, which the Inbox lists under Needs You (1064), were never
-- sent either.
--   * shift.assigned: a shift is published with a worker, or a published or accepted shift gets a new worker (a
--     reassignment, an approved swap or an approved claim), and the worker is told.
--   * shift.changed: a published or accepted shift's start or end moves, and its worker is told. startsAt carries
--     the start instant, so a change to a shift starting within 12 hours bypasses quiet hours (1367, 1393).
--   * incident.reported: a new incident tells the project's dispatchers (safety.incident.dispatch), as occupancy
--     and weather alerts do (0806), except the reporter. It bypasses quiet hours.
--   * assignment.created: a member assigned to a record is told, with the record's title.
-- Nobody is told of their own act (claiming an open shift first-come, accepting a swap, assigning oneself). Draft,
-- canceled, deleted and finished shifts tell nobody; the registry has no kind for a canceled shift or for the person
-- a shift was taken from.

create or replace function private.shift_notification_title(p_shift_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select r.title from app.records r where r.id = s.record_id),
    (select ro.job_title || ' (' || pr.name || ')' from xpms.role ro where ro.role_code = s.role_code),
    pr.name)
  from app.shifts s join app.projects pr on pr.id = s.project_id
  where s.id = p_shift_id;
$$;

comment on function private.shift_notification_title(uuid) is 'The name a shift notification uses for a shift (1394): the Shift record it staffs, else its role and project, for example Rigger (Northwind Summer Series), else the project.';

create or replace function private.shift_worker_person_id(p_membership_id uuid, p_engagement_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select m.person_id from app.memberships m where m.id = p_membership_id),
    (select e.person_id from app.engagements e where e.id = p_engagement_id));
$$;

comment on function private.shift_worker_person_id(uuid, uuid) is 'The person who works a shift (1394): the member it is assigned to, or the engaged worker (0940).';

create or replace function private.notify_shift_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker uuid;
  v_kind text;
begin
  if new.deleted_at is not null or new.shift_state not in ('Published', 'Accepted') or new.ends_at <= now() then
    return null;
  end if;
  v_worker := private.shift_worker_person_id(new.membership_id, new.engagement_id);
  if v_worker is null or v_worker is not distinct from private.current_person_id() then
    return null;
  end if;
  if old.shift_state not in ('Published', 'Accepted')
     or v_worker is distinct from private.shift_worker_person_id(old.membership_id, old.engagement_id) then
    v_kind := 'shift.assigned';
  elsif new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at then
    v_kind := 'shift.changed';
  else
    return null;
  end if;
  perform private.notify(new.org_id, v_worker, v_kind, 'app.shifts', new.id, new.project_id,
    jsonb_build_object('title', private.shift_notification_title(new.id),
      'startsAt', to_char(new.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'endsAt', to_char(new.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
  return null;
end;
$$;

comment on function private.notify_shift_change() is 'Tells a shift''s worker about it (1394): shift.assigned when a shift is published with them or a published or accepted shift becomes theirs (a reassignment, an approved swap or an approved claim), shift.changed when a published or accepted shift''s times move. Arguments: title, startsAt and endsAt as ISO instants, so a change to a shift starting within 12 hours bypasses quiet hours. Draft, canceled, deleted and finished shifts tell nobody, nor does a person''s own act, such as claiming an open shift first-come.';

create trigger t92_notify_shift_change after update on app.shifts
  for each row execute function private.notify_shift_change();

create or replace function private.notify_incident_reported()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid;
  v_reporter text;
begin
  if new.deleted_at is not null then
    return null;
  end if;
  v_reporter := coalesce((select p.full_name from app.people p where p.id = new.reported_by),
                         (select o.name from app.organizations o where o.id = new.org_id));
  for v_person in
    select d from private.project_member_people_with(new.project_id, 'safety.incident.dispatch') d
    where d is distinct from new.reported_by
  loop
    perform private.notify(new.org_id, v_person, 'incident.reported', 'app.incidents', new.id, new.project_id,
      jsonb_build_object('title', new.title, 'actorName', v_reporter));
  end loop;
  return null;
end;
$$;

comment on function private.notify_incident_reported() is 'Tells the project''s dispatchers (safety.incident.dispatch), except the reporter, of a new incident (1394): incident.reported with the incident''s title and the reporter''s name. The kind bypasses quiet hours (ADR 0033 decision 35).';

create trigger t92_notify_incident_reported after insert on app.incidents
  for each row execute function private.notify_incident_reported();

create or replace function private.notify_record_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid;
  v_record record;
begin
  if new.deleted_at is not null then
    return null;
  end if;
  v_person := (select m.person_id from app.memberships m where m.id = new.membership_id);
  if v_person is null or v_person is not distinct from private.current_person_id() then
    return null;
  end if;
  select r.title, r.project_id into v_record from app.records r where r.id = new.record_id and r.deleted_at is null;
  if not found then
    return null;
  end if;
  perform private.notify(new.org_id, v_person, 'assignment.created', 'app.records', new.record_id, v_record.project_id,
    jsonb_build_object('title', v_record.title));
  return null;
end;
$$;

comment on function private.notify_record_assignment() is 'Tells a member assigned to a live record (1394): assignment.created with the record''s title; the actor is whoever assigned them. Assigning oneself tells nobody.';

create trigger t92_notify_record_assignment after insert on app.record_assignments
  for each row execute function private.notify_record_assignment();

revoke all on function private.shift_notification_title(uuid) from public, anon, authenticated;
revoke all on function private.shift_worker_person_id(uuid, uuid) from public, anon, authenticated;
revoke all on function private.notify_shift_change() from public, anon, authenticated;
revoke all on function private.notify_incident_reported() from public, anon, authenticated;
revoke all on function private.notify_record_assignment() from public, anon, authenticated;
