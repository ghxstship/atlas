-- 6800_crisis_alert_notifications.sql
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
-- Notifying starts in a BEFORE INSERT trigger so that the insert's RETURNING carries the counts Atlas shows. A refused
-- insert (row security, a tenant guard) rolls the notifications back with it. A person counts as told when a notification
-- reached a live channel: an Inbox row they can see (a member with In App off has none; an engaged external person
-- always has one, because their Inbox cannot be turned off, so they count even with Email and Push off), or a delivery
-- that can go: not Suppressed, to a device or an address that exists and is not blocked. Delivery itself happens after
-- the commit; the count is what was sent, not what was read. An alert written as already ended, such as a seed or an
-- import of history, tells nobody and records NULL.
--
-- The alert must never depend on the fan-out. private.notify costs about 1.7 ms a person on a laptop stack, and the
-- authenticated role has an 8 second statement timeout: measured before this design, 1,005 people took 2.2 s, 5,005 took
-- 8.8 s and 20,005 took 33.7 s, so a project of about 5,000 lost the whole alert, row and notifications, with a generic
-- error. So the trigger sends for private.crisis_alert_inline_budget() from the start of the statement, in order of who
-- most needs it (clocked in, on a shift, dispatchers, then everyone assigned), and leaves the rest in
-- private.crisis_alert_sends. A person whose notification raises an error is left there too, instead of losing the alert.
-- private.send_waiting_crisis_alerts drains that table every 15 seconds and updates the counts, trying a person three
-- times. So the alert commits whatever the size, and people_waiting and people_not_sent say honestly what is left.

alter table app.crisis_alerts add column people_told integer;
alter table app.crisis_alerts add column people_told_on_site integer;
comment on column app.crisis_alerts.people_told is 'People the alert reached when it was announced, each once, not counting who announced it; NULL for an alert from before 6800 or one written as already ended. Set by the database.';
comment on column app.crisis_alerts.people_told_on_site is 'How many of people_told were clocked in on the project when it was announced. Set by the database.';
alter table app.crisis_alerts add column people_waiting integer;
alter table app.crisis_alerts add column people_not_sent integer;
comment on column app.crisis_alerts.people_waiting is 'People still to be told by the worker, for an alert too large to send in its own statement or a send that failed and will be tried again. Set by the database.';
comment on column app.crisis_alerts.people_not_sent is 'People the alert could not be sent to after three tries. Set by the database.';

create table private.crisis_alert_sends (
  id uuid primary key default private.uuid_v7(),
  -- No foreign key: the announcement's row is written after this one, in the same statement.
  alert_id uuid not null,
  org_id uuid not null,
  project_id uuid not null,
  person_id uuid not null,
  kind text not null,
  on_site boolean not null default false,
  priority smallint not null default 3,
  message_args jsonb not null,
  attempts smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint crisis_alert_sends_kind check (kind in ('crisis_alert.issued', 'crisis_alert.ended')),
  constraint crisis_alert_sends_attempts check (attempts >= 0)
);
create unique index crisis_alert_sends_person_key on private.crisis_alert_sends (alert_id, kind, person_id);
comment on table private.crisis_alert_sends is 'People a crisis alert or its all-clear has still to reach, for private.send_waiting_crisis_alerts. A row lives seconds (6800).';
comment on column private.crisis_alert_sends.id is 'Send id.';
comment on column private.crisis_alert_sends.alert_id is 'The crisis alert.';
comment on column private.crisis_alert_sends.org_id is 'Org of the alert.';
comment on column private.crisis_alert_sends.project_id is 'Project of the alert.';
comment on column private.crisis_alert_sends.person_id is 'Who is still to be told.';
comment on column private.crisis_alert_sends.kind is 'crisis_alert.issued or crisis_alert.ended.';
comment on column private.crisis_alert_sends.on_site is 'Whether they were clocked in on the project when it was announced.';
comment on column private.crisis_alert_sends.priority is 'Who goes first: 0 clocked in, 1 on a shift, 2 dispatcher, 3 anyone else assigned.';
comment on column private.crisis_alert_sends.message_args is 'What the notification says, fixed when it was announced.';
comment on column private.crisis_alert_sends.attempts is 'Failed tries so far; the third is the last.';
comment on column private.crisis_alert_sends.created_at is 'When it was left for the worker.';
alter table private.crisis_alert_sends enable row level security;
revoke all on private.crisis_alert_sends from public, anon, authenticated;

create function private.crisis_alert_inline_budget()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '3 seconds' $$;
comment on function private.crisis_alert_inline_budget() is 'How long a statement that announces a crisis alert or gives its all-clear spends sending, from its start, before leaving the rest to the worker: well inside the 8 second statement timeout of authenticated, with room for a slower host (6800).';
revoke all on function private.crisis_alert_inline_budget() from public, anon, authenticated;

create function private.crisis_alert_recipients(p_project_id uuid)
returns table (person_id uuid, on_site boolean, priority smallint)
language sql
stable
security definer
set search_path = ''
as $$
  with on_project as (
    -- Clocked in now.
    select private.shift_worker_person_id(te.membership_id, te.engagement_id, te.roster_entry_id) as person_id, true as on_site, 0::smallint as priority
    from app.time_entries te
    where te.project_id = p_project_id and te.clock_out is null and te.deleted_at is null
      and te.clock_in >= now() - interval '24 hours'
    union all
    -- On a shift now, or soon.
    select private.shift_worker_person_id(s.membership_id, s.engagement_id, s.roster_entry_id), false, 1::smallint
    from app.shifts s
    where s.project_id = p_project_id and s.deleted_at is null and s.shift_state in ('Published', 'Accepted')
      and s.ends_at > now() and s.starts_at <= now() + interval '12 hours'
    union all
    -- Project members.
    select m.person_id, false, 3::smallint
    from app.project_members pm
    join app.memberships m on m.id = pm.membership_id and m.deleted_at is null and m.valid_from <= now()
      and (m.valid_to is null or m.valid_to > now())
    where pm.project_id = p_project_id and pm.deleted_at is null and pm.valid_from <= now()
      and (pm.valid_to is null or pm.valid_to > now())
    union all
    -- Active role assignments for today, on the org's calendar.
    select ra.person_id, false, 3::smallint
    from app.role_assignments ra
    where ra.project_id = p_project_id and ra.deleted_at is null and ra.assignment_state = 'Active'
      and (ra.starts_on is null or ra.starts_on <= private.org_today(ra.org_id))
      and (ra.ends_on is null or ra.ends_on >= private.org_today(ra.org_id))
    union all
    -- Engaged people, their account's assigned members and rostered crew.
    select e.person_id, false, 3::smallint
    from app.engagements e
    where e.project_id = p_project_id and e.deleted_at is null and e.engagement_state in ('Active', 'Closing')
    union all
    select am.person_id, false, 3::smallint
    from app.account_engagement_assignments a
    join app.engagements e on e.id = a.engagement_id and e.deleted_at is null and e.engagement_state in ('Active', 'Closing')
    join app.account_memberships am on am.id = a.account_membership_id and am.deleted_at is null and am.valid_from <= now()
      and (am.valid_to is null or am.valid_to > now())
    where e.project_id = p_project_id and a.deleted_at is null
    union all
    select rp.person_id, false, 3::smallint
    from app.engagement_roster_entries r
    join app.engagements e on e.id = r.engagement_id and e.deleted_at is null and e.engagement_state in ('Active', 'Closing')
    join private.roster_people rp on rp.roster_entry_id = r.id
    where e.project_id = p_project_id and r.deleted_at is null and r.entry_state <> 'Withdrawn' and r.person_response <> 'Declined'
    union all
    -- The org-wide dispatchers. A dispatcher on the project alone is a project member, above.
    select m.person_id, false, 2::smallint
    from app.memberships m
    join app.projects p on p.id = p_project_id and p.org_id = m.org_id
    where m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      and private.person_capability_reach(m.person_id, p.org_id, 'safety.incident.dispatch', true) = 'organization'
  )
  select op.person_id, bool_or(op.on_site), min(op.priority)
  from on_project op
  where op.person_id is not null
  group by op.person_id;
$$;
comment on function private.crisis_alert_recipients(uuid) is 'Everyone a crisis alert on a project reaches, each once, and whether they are clocked in on it now: people clocked in, on a shift now or within 12 hours, assigned to the project (members, role assignments, engagements, account assignments, roster entries) and its dispatchers, with who goes first (6800).';
revoke all on function private.crisis_alert_recipients(uuid) from public, anon, authenticated;

create function private.crisis_alert_reached(p_notification uuid, p_person uuid, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from app.notifications n
      where n.id = p_notification and n.created_at >= now() - interval '1 minute' and n.archived_at is null)
    or exists (
      select 1 from app.notification_deliveries d
      join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
      left join private.notification_templates t on t.kind = n.kind and t.channel = d.channel
      left join lateral (select private.recipient_address(p_person, d.channel) as address where d.channel <> 'Push') a on true
      where d.notification_id = p_notification and d.notification_created_at >= now() - interval '1 minute'
        and d.message_status <> 'Suppressed'
        and case
          when d.channel = 'Push' then
            exists (select 1 from app.push_subscriptions ps join app.memberships m on m.id = ps.membership_id
                    where m.person_id = p_person and ps.org_id = p_org and ps.revoked_at is null and ps.deleted_at is null)
            or (private.person_push_fallback(p_person, p_org, 'crisis_alert.issued', 'app.crisis_alerts', null)
                and exists (select 1 from app.person_push_devices pd
                            where pd.person_id = p_person and pd.revoked_at is null and pd.deleted_at is null))
          else
            a.address is not null
            and not exists (select 1 from app.suppression_list s
                            where s.org_id = p_org and s.channel = d.channel and s.address = a.address
                              and s.lifted_at is null and s.deleted_at is null
                              and (s.reason in ('Hard Bounce', 'Complaint', 'STOP', 'Manual')
                                   -- An unsubscribe from all mail, or from the kind's category, stops a mail that is not
                                   -- transactional, as the claim (1671) does.
                                   or (not coalesce((select e.transactional from private.email_templates e
                                                     where e.code = t.email_template_code), false)
                                       and (s.category_code is null or s.category_code = t.category_code))))
            and (d.channel <> 'SMS' or coalesce((select c.may_text from app.sms_consent_status c
                                                 where c.org_id = p_org and c.phone_e164 = a.address), false))
        end);
$$;
comment on function private.crisis_alert_reached(uuid, uuid, uuid) is 'Whether a notification just sent has a live channel: an Inbox row the person can see, or a delivery that is not Suppressed and has a device or an address to go to, by the tests the sender applies at claim time (6800).';
revoke all on function private.crisis_alert_reached(uuid, uuid, uuid) from public, anon, authenticated;

create function private.send_crisis_alert_note(
  p_org uuid, p_person uuid, p_kind text, p_alert uuid, p_project uuid, p_args jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note uuid;
begin
  v_note := private.notify(p_org, p_person, p_kind, 'app.crisis_alerts', p_alert, p_project, p_args);
  return v_note is not null and private.crisis_alert_reached(v_note, p_person, p_org);
exception when others then
  -- One person's failure never costs the others their alert. The caller leaves them for another try.
  raise warning 'crisis alert % could not notify a person: %', p_alert, sqlstate;
  return null;
end;
$$;
comment on function private.send_crisis_alert_note(uuid, uuid, text, uuid, uuid, jsonb) is 'Sends one crisis alert notification through private.notify. True when it reached a live channel, false when it did not, null when it raised an error, which rolls back that person alone (6800).';
revoke all on function private.send_crisis_alert_note(uuid, uuid, text, uuid, uuid, jsonb) from public, anon, authenticated;

create function private.notify_crisis_alert_issued()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_deadline timestamptz := statement_timestamp() + private.crisis_alert_inline_budget();
  v_org uuid;
  v_project text;
  v_args jsonb;
  v_recipient record;
  v_sent boolean;
  v_told integer := 0;
  v_on_site integer := 0;
  v_waiting integer := 0;
begin
  -- Only the database writes these.
  new.people_told := null;
  new.people_told_on_site := null;
  new.people_waiting := null;
  new.people_not_sent := null;
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
    'message', new.message,
    -- Named here because the worker has nobody signed in.
    'actorName', coalesce((select p.full_name from app.people p where p.id = v_me), (select o.name from app.organizations o where o.id = v_org), ''));
  for v_recipient in
    select r.person_id, r.on_site, r.priority from private.crisis_alert_recipients(new.project_id) r
    order by r.priority, r.person_id
  loop
    continue when v_recipient.person_id is not distinct from v_me;
    v_sent := case when clock_timestamp() < v_deadline
      then private.send_crisis_alert_note(v_org, v_recipient.person_id, 'crisis_alert.issued', new.id, new.project_id, v_args) end;
    if v_sent is null then
      insert into private.crisis_alert_sends (alert_id, org_id, project_id, person_id, kind, on_site, priority, message_args)
      values (new.id, v_org, new.project_id, v_recipient.person_id, 'crisis_alert.issued', v_recipient.on_site, v_recipient.priority, v_args);
      v_waiting := v_waiting + 1;
    elsif v_sent then
      v_told := v_told + 1;
      if v_recipient.on_site then
        v_on_site := v_on_site + 1;
      end if;
    end if;
  end loop;
  new.people_told := v_told;
  new.people_told_on_site := v_on_site;
  new.people_waiting := v_waiting;
  new.people_not_sent := 0;
  return new;
end;
$$;
comment on function private.notify_crisis_alert_issued() is 'Sends crisis_alert.issued to everyone private.crisis_alert_recipients names except who announced it, most urgent first, for as long as the statement may spend, leaves the rest to the worker, and records on the alert how many were reached through a live channel, how many of them were clocked in and how many wait (6800). The kind bypasses quiet hours.';
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
  -- The worker's own update runs as the owner of its function. No client role is that owner.
  if current_user <> 'postgres' then
    new.people_told := old.people_told;
    new.people_told_on_site := old.people_told_on_site;
    new.people_waiting := old.people_waiting;
    new.people_not_sent := old.people_not_sent;
  end if;
  return new;
end;
$$;
comment on function private.keep_crisis_alert_reach() is 'What an alert reached is a record of its announcement: only the database''s own worker changes it (6800).';
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
  v_deadline timestamptz := statement_timestamp() + private.crisis_alert_inline_budget();
  v_person uuid;
  v_project text;
  v_args jsonb;
  v_sent boolean;
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
    'project', v_project,
    'actorName', coalesce((select p.full_name from app.people p where p.id = v_me), (select o.name from app.organizations o where o.id = new.org_id), ''));
  for v_person in
    select n.recipient_person_id from app.notifications n
    where n.org_id = new.org_id and n.created_at >= new.created_at and n.kind = 'crisis_alert.issued'
      and n.subject_table = 'app.crisis_alerts' and n.subject_id = new.id
    union
    select new.created_by where new.created_by is not null
  loop
    continue when v_person is not distinct from v_me;
    v_sent := case when clock_timestamp() < v_deadline
      then private.send_crisis_alert_note(new.org_id, v_person, 'crisis_alert.ended', new.id, new.project_id, v_args) end;
    if v_sent is null then
      insert into private.crisis_alert_sends (alert_id, org_id, project_id, person_id, kind, message_args)
      values (new.id, new.org_id, new.project_id, v_person, 'crisis_alert.ended', v_args)
      on conflict (alert_id, kind, person_id) do nothing;
    end if;
  end loop;
  -- Whoever the worker has still to tell, or is telling right now in a run not yet committed (whose notification this
  -- statement cannot see), gets the all-clear from the worker after the alert. If the worker drops them because the
  -- alert ended before their turn, it drops this too (private.send_waiting_crisis_alerts).
  insert into private.crisis_alert_sends (alert_id, org_id, project_id, person_id, kind, message_args)
  select new.id, new.org_id, new.project_id, s.person_id, 'crisis_alert.ended', v_args
  from private.crisis_alert_sends s
  where s.alert_id = new.id and s.kind = 'crisis_alert.issued' and s.person_id is distinct from v_me
  on conflict (alert_id, kind, person_id) do nothing;
  return null;
end;
$$;
comment on function private.notify_crisis_alert_ended() is 'Sends crisis_alert.ended to the people told of the alert and who announced it, except who gave the all-clear, leaving what its statement cannot send to the worker, and queues it after the alert for everyone the worker has still to tell or is telling (6800). The kind bypasses quiet hours.';
revoke all on function private.notify_crisis_alert_ended() from public, anon, authenticated;

create trigger t92_notify_crisis_alert_ended after update on app.crisis_alerts
  for each row when (old.ended_at is null and new.ended_at is not null)
  execute function private.notify_crisis_alert_ended();

create function private.send_waiting_crisis_alerts(p_budget interval default interval '12 seconds')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deadline timestamptz := clock_timestamp() + p_budget;
  v_alert_id uuid;
  v_row record;
  v_sent boolean;
  v_handled integer := 0;
  v_told integer;
  v_on_site integer;
  v_not_sent integer;
begin
  for v_alert_id in select distinct s.alert_id from private.crisis_alert_sends s loop
    exit when clock_timestamp() >= v_deadline;
    v_told := 0;
    v_on_site := 0;
    v_not_sent := 0;
    -- An alert over or removed before someone's turn: they are not told of it now, and so not of its all-clear.
    with dropped as (
      delete from private.crisis_alert_sends s
      where s.alert_id = v_alert_id and s.kind = 'crisis_alert.issued'
        and not exists (select 1 from app.crisis_alerts c where c.id = v_alert_id and c.ended_at is null and c.deleted_at is null)
      returning s.person_id)
    delete from private.crisis_alert_sends s
    where s.alert_id = v_alert_id and s.kind = 'crisis_alert.ended' and s.person_id in (select d.person_id from dropped d);
    for v_row in
      select s.* from private.crisis_alert_sends s
      where s.alert_id = v_alert_id
      order by s.priority, s.id
      for update of s skip locked
    loop
      exit when clock_timestamp() >= v_deadline;
      v_sent := private.send_crisis_alert_note(v_row.org_id, v_row.person_id, v_row.kind, v_row.alert_id, v_row.project_id, v_row.message_args);
      v_handled := v_handled + 1;
      if v_sent is null and v_row.attempts < 2 then
        update private.crisis_alert_sends s set attempts = s.attempts + 1 where s.id = v_row.id;
        continue;
      end if;
      delete from private.crisis_alert_sends s where s.id = v_row.id;
      if v_row.kind = 'crisis_alert.issued' then
        if v_sent is null then
          v_not_sent := v_not_sent + 1;
        elsif v_sent then
          v_told := v_told + 1;
          if v_row.on_site then
            v_on_site := v_on_site + 1;
          end if;
        end if;
      end if;
    end loop;
    begin
      update app.crisis_alerts c
      set people_told = coalesce(c.people_told, 0) + v_told,
          people_told_on_site = coalesce(c.people_told_on_site, 0) + v_on_site,
          people_not_sent = coalesce(c.people_not_sent, 0) + v_not_sent,
          people_waiting = (select count(*)::integer from private.crisis_alert_sends s
                            where s.alert_id = v_alert_id and s.kind = 'crisis_alert.issued')
      where c.id = v_alert_id;
    exception when others then
      -- A guard of the org, such as read-only, costs the record its numbers, never the people their notification.
      raise warning 'crisis alert % could not record its reach: %', v_alert_id, sqlstate;
    end;
  end loop;
  return v_handled;
end;
$$;
comment on function private.send_waiting_crisis_alerts(interval) is 'Worker: sends what a crisis alert or its all-clear left in private.crisis_alert_sends and updates the alert''s counts. A person whose send fails is tried three times and then counted in people_not_sent (6800).';
revoke all on function private.send_waiting_crisis_alerts(interval) from public, anon, authenticated;

-- Every run commits what it sent, so the next delivery run (each minute) takes it. A run with nothing waiting costs one read.
select cron.schedule('xos_send_waiting_crisis_alerts', '15 seconds', 'select private.send_waiting_crisis_alerts()');

-- Delivery order -------------------------------------------------------------------------------------------------------
-- The notification-dispatch worker sends what app.claim_notification_deliveries hands it, a batch at a time. It took the
-- oldest due first, so a crisis alert waited behind any backlog of every kind and org, and its clocked-in people went in
-- no particular order, since every delivery of one statement falls due at the same instant. The claim now takes the kinds
-- that always bypass quiet hours (safety alerts, a crisis alert and its all-clear among them) first, and ties in the order
-- the deliveries were written, to the millisecond. Otherwise this is its latest definition (1671), unchanged.

create or replace function app.claim_notification_deliveries(p_channel app.notification_channel, p_limit integer default 50)
returns table (
  delivery_id uuid, org_id uuid, recipient_person_id uuid, address text, kind text, email_template_code text,
  message_args jsonb, subject_table text, subject_id uuid, push_tokens text[],
  notification_id uuid, category_code text, push_devices jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_address text;
  v_reason text;
  v_transactional boolean;
  v_membership uuid;
  v_quiet timestamptz;
  v_opens timestamptz;
  v_devices jsonb;
  v_ticketed boolean;
begin
  for v_row in
    select d.id, d.notification_created_at, n.id as notification_id, n.org_id, n.recipient_person_id, n.kind, n.message_args,
      n.subject_table, n.subject_id, n.project_id, t.email_template_code, t.category_code
    from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    join private.notification_templates t on t.kind = n.kind and t.channel = d.channel
    -- The kinds that always bypass quiet hours are safety alerts: they go before any backlog (6800).
    left join private.notification_quiet_hours_bypass b on b.kind = n.kind and b.starts_within is null
    where d.channel = p_channel and d.message_status in ('Queued', 'Deferred') and d.deliver_after <= now()
    -- Then by when they fell due, and within one instant in the order they were written to the millisecond (ids are
    -- UUIDv7), which for a crisis alert puts whoever is clocked in first (private.notify_crisis_alert_issued) as near as
    -- that allows.
    order by (b.kind is not null) desc, d.deliver_after, d.id
    limit least(greatest(p_limit, 1), 500)
    for update of d skip locked
  loop
    v_reason := null;
    v_devices := null;
    v_address := private.recipient_address(v_row.recipient_person_id, p_channel);
    v_transactional := coalesce((select e.transactional from private.email_templates e where e.code = v_row.email_template_code), false);
    select m.id into v_membership from app.memberships m
    where m.org_id = v_row.org_id and m.person_id = v_row.recipient_person_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    order by m.valid_from desc limit 1;

    -- Quiet hours may have begun since private.notify queued the delivery: a member's (1367), or for someone with no
    -- membership their own (A89).
    if p_channel in ('SMS', 'Push') and not private.bypasses_quiet_hours(v_row.kind, v_row.message_args, now()) then
      if v_membership is not null then
        v_quiet := case when p_channel = 'SMS' then private.sms_quiet_until(v_membership, v_row.project_id, now())
                        else private.local_quiet_until(v_membership, now()) end;
      elsif p_channel = 'Push' then
        v_quiet := private.person_quiet_until(v_row.recipient_person_id, now());
      else
        v_quiet := null;
      end if;
      -- A shift change waits only until its bypass window opens, when that comes first (1393), member or not.
      v_opens := private.quiet_hours_bypass_opens(v_row.kind, v_row.message_args);
      if v_quiet is not null and v_opens > now() and v_opens < v_quiet then
        v_quiet := v_opens;
      end if;
      if v_quiet is not null then
        if p_channel = 'SMS' then
          perform private.hold_sms_for_summary(v_row.id, v_row.notification_created_at, v_membership, v_quiet);
        else
          update app.notification_deliveries set message_status = 'Deferred', deliver_after = v_quiet
          where id = v_row.id and notification_created_at = v_row.notification_created_at;
        end if;
        continue;
      end if;
    end if;

    -- A marketplace match that passes the first test is about a listing open to the recipient, who may work with no org
    -- at all (A89): only every other kind needs a membership or a party relationship (A101).
    if v_row.kind = 'opportunity.matched'
       and not private.marketplace_notice_open(v_row.kind, v_row.subject_table, v_row.subject_id, v_row.recipient_person_id) then
      v_reason := 'The listing is no longer open to the recipient.';
    elsif v_membership is null and v_row.kind <> 'opportunity.matched'
          and v_row.org_id not in (select private.party_org_ids(v_row.recipient_person_id)) then
      v_reason := 'Recipient no longer belongs to the org or works with it.';
    elsif p_channel in ('Email', 'SMS') and v_address is null then
      v_reason := 'No verified address on the channel.';
    elsif p_channel in ('Email', 'SMS') and exists (
      select 1 from app.suppression_list s
      where s.org_id = v_row.org_id and s.channel = p_channel and s.address = v_address and s.lifted_at is null and s.deleted_at is null
        and (s.reason in ('Hard Bounce', 'Complaint', 'STOP', 'Manual')
             or (not v_transactional and (s.category_code is null or s.category_code = v_row.category_code)))) then
      v_reason := 'Address is on the suppression list.';
    elsif p_channel = 'SMS' and not coalesce((select c.may_text from app.sms_consent_status c
                                              where c.org_id = v_row.org_id and c.phone_e164 = v_address), false) then
      v_reason := 'No SMS consent for the number.';
    elsif p_channel = 'Push' then
      -- The devices registered with the org take the push. With none, the person's own devices do, for an org they work
      -- with as a party or a match about a listing open to them (A101).
      if private.person_push_fallback(v_row.recipient_person_id, v_row.org_id, v_row.kind, v_row.subject_table, v_row.subject_id) then
        select coalesce(jsonb_agg(jsonb_build_object('subscriptionId', pd.id, 'token', pd.expo_push_token) order by pd.last_seen_at desc), '[]'::jsonb)
        into v_devices
        from app.person_push_devices pd
        where pd.person_id = v_row.recipient_person_id and pd.revoked_at is null and pd.deleted_at is null
          and not exists (select 1 from app.push_tickets pt
                          where pt.notification_delivery_id = v_row.id and pt.person_push_device_id = pd.id and pt.deleted_at is null
                            and pt.message_status in ('Sent', 'Delivered', 'Bounced'));
      else
        select coalesce(jsonb_agg(jsonb_build_object('subscriptionId', ps.id, 'token', ps.expo_push_token) order by ps.last_seen_at desc), '[]'::jsonb)
        into v_devices
        from app.push_subscriptions ps join app.memberships m on m.id = ps.membership_id
        where m.person_id = v_row.recipient_person_id and ps.org_id = v_row.org_id and ps.revoked_at is null and ps.deleted_at is null
          and not exists (select 1 from app.push_tickets pt
                          where pt.notification_delivery_id = v_row.id and pt.push_subscription_id = ps.id and pt.deleted_at is null
                            and pt.message_status in ('Sent', 'Delivered', 'Bounced'));
      end if;
      v_ticketed := exists (select 1 from app.push_tickets pt
                            where pt.notification_delivery_id = v_row.id and pt.deleted_at is null and pt.message_status in ('Sent', 'Delivered'));
      if jsonb_array_length(v_devices) = 0 and not v_ticketed then
        v_reason := 'No registered device.';
      end if;
    end if;
    if v_reason is not null then
      update app.notification_deliveries set message_status = 'Suppressed', last_error = v_reason
      where id = v_row.id and notification_created_at = v_row.notification_created_at;
      continue;
    end if;
    update app.notification_deliveries set attempt_count = attempt_count + 1, message_status = 'Queued', deliver_after = now() + interval '10 minutes'
    where id = v_row.id and notification_created_at = v_row.notification_created_at;
    delivery_id := v_row.id;
    org_id := v_row.org_id;
    recipient_person_id := v_row.recipient_person_id;
    address := v_address;
    kind := v_row.kind;
    email_template_code := v_row.email_template_code;
    message_args := v_row.message_args;
    subject_table := v_row.subject_table;
    subject_id := v_row.subject_id;
    push_tokens := case when p_channel = 'Push' then (select array_agg(d ->> 'token') from jsonb_array_elements(v_devices) d) end;
    notification_id := v_row.notification_id;
    category_code := v_row.category_code;
    push_devices := v_devices;
    return next;
  end loop;
end;
$$;

comment on function app.claim_notification_deliveries(app.notification_channel, integer) is 'Worker API (service role): claims due deliveries of a channel with SKIP LOCKED, the kinds that always bypass quiet hours first and then the oldest due, in the order written (6800). Quiet hours are checked again unless the kind is on the bypass list (ADR 0033 decision 35): a member''s push waits until they end (Deferred) and a text is held for the member''s summary (1367); the push of someone with no membership waits out their own quiet hours (A89); in every case no later than the opening of the kind''s bypass window, as for a shift starting within 12 hours (1393). Suppresses, with the reason, a marketplace match whose listing is no longer open to the recipient (A89), and any other delivery whose recipient neither belongs to the org nor works with it as an external party; a match about a listing open to them goes out though they work with no org (A101). Also suppresses a delivery with no verified address, a suppressed address, no SMS consent or no device. Push rows list the devices not yet pushed for the delivery (push_devices): those registered with the org, or, when the recipient has none there and works with the org as a party or the push is a marketplace match open to them, their own devices (app.person_push_devices, A101). A claimed delivery becomes due again after 10 minutes unless its outcome is recorded.';
revoke all on function app.claim_notification_deliveries(app.notification_channel, integer) from public, anon, authenticated;
grant execute on function app.claim_notification_deliveries(app.notification_channel, integer) to service_role;
