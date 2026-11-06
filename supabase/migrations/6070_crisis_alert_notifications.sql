-- 6070_crisis_alert_notifications.sql
-- Launch flag (owner, 2026-11-06, RRR-247): a crisis alert wrote app.crisis_alerts and a subject event and told nobody,
-- while Atlas said "Alert announced." Announcing one now sends crisis_alert.issued through private.notify, so Inbox,
-- email, text and push all follow the channels that system already uses, and the alert records how many people it
-- reached. The all-clear sends crisis_alert.ended to the same people, so nobody told of an emergency is left without
-- word that it ended.
--
-- Who is told (private.crisis_alert_recipients), from the project's own data, and why:
--   * People clocked in on the project now: they are the ones in the building. An open time entry from the last 24 hours
--     counts, as in the directory's on-site test (1010), but a geofence check is not asked for, because telling someone
--     whose clock-in had no location is better than leaving them out. These are the on-site count of the alert.
--   * People on a published or accepted shift of the project that covers now or starts within 12 hours, the window
--     shift.changed already treats as urgent (1393): they may be on the way in or between clock-ins.
--   * Everyone assigned to the project: project members, active role assignments for today, the person on an Active or
--     Closing engagement, a live roster entry on one, and an account member assigned to one.
--   * The project's dispatchers (safety.incident.dispatch, 0806), who run the response wherever they are.
-- Not the rest of the org, and not guests or patrons: they have no assignment here and many have no account. The person
-- announcing is left out, as a reported incident leaves out its reporter (1394), since they already know; so an alert
-- only its issuer could receive reads as reaching nobody, which is what happened. B8's weather holds (2977, on its own
-- branch) tell their own lists under their own kinds; nothing here reads or changes them.
--
-- Notifying happens in a BEFORE INSERT trigger so that the insert's RETURNING carries the counts Atlas shows. A refused
-- insert (row security, a tenant guard) rolls the notifications back with it. A person counts as told only when a
-- notification reached a live channel: an Inbox row left unarchived, or a delivery. Someone with every channel of the
-- safety category off is not counted. Delivery itself happens after the commit; the count is what was sent, not what
-- was read. An alert written as already ended, such as a seed or an import of history, tells nobody and records NULL.

alter table app.crisis_alerts add column people_told integer;
alter table app.crisis_alerts add column people_told_on_site integer;
comment on column app.crisis_alerts.people_told is 'People the alert reached when it was announced, each once, not counting who announced it; NULL for an alert from before 6070 or one written as already ended. Set by the database.';
comment on column app.crisis_alerts.people_told_on_site is 'How many of people_told were clocked in on the project when it was announced. Set by the database.';

create function private.crisis_alert_recipients(p_project_id uuid)
returns table (person_id uuid, on_site boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with on_project as (
    -- Clocked in now.
    select private.shift_worker_person_id(te.membership_id, te.engagement_id, te.roster_entry_id) as person_id, true as on_site
    from app.time_entries te
    where te.project_id = p_project_id and te.clock_out is null and te.deleted_at is null
      and te.clock_in >= now() - interval '24 hours'
    union all
    -- On a shift now, or soon.
    select private.shift_worker_person_id(s.membership_id, s.engagement_id, s.roster_entry_id), false
    from app.shifts s
    where s.project_id = p_project_id and s.deleted_at is null and s.shift_state in ('Published', 'Accepted')
      and s.ends_at > now() and s.starts_at <= now() + interval '12 hours'
    union all
    -- Project members.
    select m.person_id, false
    from app.project_members pm
    join app.memberships m on m.id = pm.membership_id and m.deleted_at is null and m.valid_from <= now()
      and (m.valid_to is null or m.valid_to > now())
    where pm.project_id = p_project_id and pm.deleted_at is null and pm.valid_from <= now()
      and (pm.valid_to is null or pm.valid_to > now())
    union all
    -- Active role assignments for today, on the org's calendar.
    select ra.person_id, false
    from app.role_assignments ra
    where ra.project_id = p_project_id and ra.deleted_at is null and ra.assignment_state = 'Active'
      and (ra.starts_on is null or ra.starts_on <= private.org_today(ra.org_id))
      and (ra.ends_on is null or ra.ends_on >= private.org_today(ra.org_id))
    union all
    -- Engaged people, their account's assigned members and rostered crew.
    select e.person_id, false
    from app.engagements e
    where e.project_id = p_project_id and e.deleted_at is null and e.engagement_state in ('Active', 'Closing')
    union all
    select am.person_id, false
    from app.account_engagement_assignments a
    join app.engagements e on e.id = a.engagement_id and e.deleted_at is null and e.engagement_state in ('Active', 'Closing')
    join app.account_memberships am on am.id = a.account_membership_id and am.deleted_at is null and am.valid_from <= now()
      and (am.valid_to is null or am.valid_to > now())
    where e.project_id = p_project_id and a.deleted_at is null
    union all
    select rp.person_id, false
    from app.engagement_roster_entries r
    join app.engagements e on e.id = r.engagement_id and e.deleted_at is null and e.engagement_state in ('Active', 'Closing')
    join private.roster_people rp on rp.roster_entry_id = r.id
    where e.project_id = p_project_id and r.deleted_at is null and r.entry_state <> 'Withdrawn' and r.person_response <> 'Declined'
    union all
    -- The project's dispatchers.
    select d, false from private.project_member_people_with(p_project_id, 'safety.incident.dispatch') d
  )
  select op.person_id, bool_or(op.on_site)
  from on_project op
  where op.person_id is not null
  group by op.person_id;
$$;
comment on function private.crisis_alert_recipients(uuid) is 'Everyone a crisis alert on a project reaches, each once, and whether they are clocked in on it now: people clocked in, on a shift now or within 12 hours, assigned to the project (members, role assignments, engagements, account assignments, roster entries) and its dispatchers (6070).';
revoke all on function private.crisis_alert_recipients(uuid) from public, anon, authenticated;

create function private.notify_crisis_alert_issued()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_org uuid;
  v_project text;
  v_args jsonb;
  v_recipient record;
  v_note uuid;
  v_told integer := 0;
  v_on_site integer := 0;
begin
  -- Only the database writes these.
  new.people_told := null;
  new.people_told_on_site := null;
  if new.deleted_at is not null or new.ended_at is not null then
    return new;
  end if;
  select p.org_id, p.name into v_org, v_project from app.projects p where p.id = new.project_id;
  v_args := jsonb_build_object(
    'title', coalesce(
      (select c.label from app.emergency_codes c where c.org_id = v_org and c.code = new.emergency_code and c.deleted_at is null),
      (select c.label from xpms.emergency_code c where c.code = new.emergency_code),
      new.emergency_code),
    'project', v_project,
    'message', new.message);
  for v_recipient in select r.person_id, r.on_site from private.crisis_alert_recipients(new.project_id) r loop
    continue when v_recipient.person_id is not distinct from v_me;
    v_note := private.notify(v_org, v_recipient.person_id, 'crisis_alert.issued', 'app.crisis_alerts', new.id, new.project_id, v_args);
    if v_note is not null and (
      exists (select 1 from app.notifications n where n.id = v_note and n.archived_at is null)
      or exists (select 1 from app.notification_deliveries d where d.notification_id = v_note)
    ) then
      v_told := v_told + 1;
      if v_recipient.on_site then
        v_on_site := v_on_site + 1;
      end if;
    end if;
  end loop;
  new.people_told := v_told;
  new.people_told_on_site := v_on_site;
  return new;
end;
$$;
comment on function private.notify_crisis_alert_issued() is 'Sends crisis_alert.issued to everyone private.crisis_alert_recipients names except who announced it, and records on the alert how many were reached through a live channel and how many of them were clocked in (6070). The kind bypasses quiet hours.';
revoke all on function private.notify_crisis_alert_issued() from public, anon, authenticated;

-- After every guard of the table (their triggers sort first), before the row is written.
create trigger t95_notify_crisis_alert_issued before insert on app.crisis_alerts
  for each row execute function private.notify_crisis_alert_issued();

create function private.keep_crisis_alert_reach()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.people_told := old.people_told;
  new.people_told_on_site := old.people_told_on_site;
  return new;
end;
$$;
comment on function private.keep_crisis_alert_reach() is 'What an alert reached is a record of its announcement: an update never changes it (6070).';
revoke all on function private.keep_crisis_alert_reach() from public, anon, authenticated;

create trigger t95_keep_crisis_alert_reach before update on app.crisis_alerts
  for each row execute function private.keep_crisis_alert_reach();

create function private.notify_crisis_alert_ended()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_person uuid;
  v_project text;
  v_args jsonb;
begin
  if new.deleted_at is not null then
    return null;
  end if;
  v_project := (select p.name from app.projects p where p.id = new.project_id);
  v_args := jsonb_build_object(
    'title', coalesce(
      (select c.label from app.emergency_codes c where c.org_id = new.org_id and c.code = new.emergency_code and c.deleted_at is null),
      (select c.label from xpms.emergency_code c where c.code = new.emergency_code),
      new.emergency_code),
    'project', v_project);
  for v_person in
    select n.recipient_person_id from app.notifications n
    where n.org_id = new.org_id and n.created_at >= new.created_at and n.kind = 'crisis_alert.issued'
      and n.subject_table = 'app.crisis_alerts' and n.subject_id = new.id
    union
    select new.created_by where new.created_by is not null
  loop
    continue when v_person is not distinct from v_me;
    perform private.notify(new.org_id, v_person, 'crisis_alert.ended', 'app.crisis_alerts', new.id, new.project_id, v_args);
  end loop;
  return null;
end;
$$;
comment on function private.notify_crisis_alert_ended() is 'Sends crisis_alert.ended to the people told of the alert and who announced it, except who gave the all-clear (6070). The kind bypasses quiet hours.';
revoke all on function private.notify_crisis_alert_ended() from public, anon, authenticated;

create trigger t92_notify_crisis_alert_ended after update on app.crisis_alerts
  for each row when (old.ended_at is null and new.ended_at is not null)
  execute function private.notify_crisis_alert_ended();
