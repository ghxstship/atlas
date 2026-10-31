-- 2741_advance_reminders.sql
-- R11 Automatic advance reminders (RRR-192; Section 11.11, owner decision 6).
--
--   1. The three settings of packages/schemas/settings/r11.yaml, pasted from `pnpm --filter @xos/schemas settings:sql
--      r11`: advancing.reminders (on by default), advancing.reminder_days_before (3, 1 to 30) and
--      advancing.overdue_reminder_every_days (2, 0 to 14; 0 sends no overdue reminder). Org lockable, per project,
--      edited with advancing.packet.send.
--   2. Ledgers private.advance_reminders_sent and private.roster_fact_reminders_sent (as 1463): a reminder is written
--      before it is queued, so no run sends it twice.
--   3. private.advance_reminder_recipients(recipient): the person answering when they can sign in, the account's live
--      Account Owners and Admins, and the Advancing Leads assigned to the recipient's engagement. Never an unassigned
--      Account Member (decision 6).
--   4. private.send_advance_reminders, hourly: 'due' once, days_before ahead of the due date, and 'overdue:k' every N
--      days after it, the highest k reached up to five, for each recipient with a Missing or Returned section.
--   5. private.send_roster_fact_reminders, hourly: the person on an accepted roster entry with a future arrival is
--      asked for the uniform sizes, travel request or vehicle an offering needs, days_before and one day ahead.
--   6. app.send_advance_reminder_now: a coordinator reminds chosen recipients, at most once a day each.
-- The kinds are advance_packet.reminder and roster_entry.facts_requested (2749 seeds them).

-- 1. Settings -----------------------------------------------------------------------------------------------------------------

select private.define_setting('advancing.reminders', 'Boolean', 'advancing.packet.send', array['organization', 'project'], true, p_default_boolean => true);
select private.define_setting('advancing.reminder_days_before', 'Integer', 'advancing.packet.send', array['organization', 'project'], true, p_default_integer => 3, p_min_integer => 1, p_max_integer => 30);
select private.define_setting('advancing.overdue_reminder_every_days', 'Integer', 'advancing.packet.send', array['organization', 'project'], true, p_default_integer => 2, p_min_integer => 0, p_max_integer => 14);

-- 2. Ledgers ------------------------------------------------------------------------------------------------------------------

create table private.advance_reminders_sent (
  advance_recipient_id uuid not null references app.advance_recipients (id),
  recipient_person_id uuid not null references app.people (id),
  reminder text not null,
  due_at timestamptz not null,
  sent_at timestamptz not null default now(),
  primary key (advance_recipient_id, recipient_person_id, reminder, due_at),
  constraint advance_reminders_sent_reminder check (reminder in ('due', 'manual') or reminder ~ '^overdue:[1-5]$')
);

create index advance_reminders_sent_person_idx on private.advance_reminders_sent (recipient_person_id);

comment on table private.advance_reminders_sent is 'Every advance reminder already sent, per recipient, person reminded, reminder and due date (R11). Written before the notification is queued, so no run of private.send_advance_reminders or app.send_advance_reminder_now sends it twice.';
comment on column private.advance_reminders_sent.advance_recipient_id is 'Recipient of the packet reminded.';
comment on column private.advance_reminders_sent.recipient_person_id is 'Person reminded.';
comment on column private.advance_reminders_sent.reminder is 'due (ahead of the due date), overdue:<k> (the k-th overdue reminder, 1 to 5) or manual (a coordinator''s).';
comment on column private.advance_reminders_sent.due_at is 'Due date the reminder was for; a moved due date is reminded again. For a manual reminder, the start of the UTC day it was sent, so a recipient is reminded by hand at most once a day.';
comment on column private.advance_reminders_sent.sent_at is 'When it was sent.';

alter table private.advance_reminders_sent enable row level security;
revoke all on private.advance_reminders_sent from public, anon, authenticated;
grant select on private.advance_reminders_sent to service_role;

create table private.roster_fact_reminders_sent (
  roster_entry_id uuid not null references app.engagement_roster_entries (id),
  threshold_days smallint not null,
  arrival_starts_at timestamptz not null,
  sent_at timestamptz not null default now(),
  primary key (roster_entry_id, threshold_days, arrival_starts_at),
  constraint roster_fact_reminders_sent_days check (threshold_days between 1 and 30)
);

comment on table private.roster_fact_reminders_sent is 'Every project facts reminder already sent, per roster entry, threshold and arrival (R11). Written before the notification is queued, so private.send_roster_fact_reminders never reminds a threshold twice.';
comment on column private.roster_fact_reminders_sent.roster_entry_id is 'Roster entry whose person was reminded.';
comment on column private.roster_fact_reminders_sent.threshold_days is 'Days before arrival the reminder was for: advancing.reminder_days_before, or 1.';
comment on column private.roster_fact_reminders_sent.arrival_starts_at is 'Start of the arrival window the reminder was for; a moved arrival is reminded again.';
comment on column private.roster_fact_reminders_sent.sent_at is 'When it was sent.';

alter table private.roster_fact_reminders_sent enable row level security;
revoke all on private.roster_fact_reminders_sent from public, anon, authenticated;
grant select on private.roster_fact_reminders_sent to service_role;

-- 3. Who is reminded ----------------------------------------------------------------------------------------------------------

create or replace function private.advance_reminder_recipients(p_recipient_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from app.advance_recipients r
  join app.people p on p.id = r.person_id and p.user_id is not null and p.deleted_at is null
  where r.id = p_recipient_id
  union
  select m.person_id from app.advance_recipients r
  join app.counterparties c on c.id = r.counterparty_id
  join app.account_memberships m on m.org_id = c.organization_id and m.deleted_at is null and m.accepted_at is not null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  join app.account_membership_roles x on x.account_membership_id = m.id and x.deleted_at is null
    and x.account_role in ('Account Owner', 'Account Admin')
  where r.id = p_recipient_id
  union
  select m.person_id from app.advance_recipients r
  join app.account_engagement_assignments a on a.engagement_id = r.engagement_id and a.deleted_at is null and a.duty = 'Advancing Lead'
  join app.account_memberships m on m.id = a.account_membership_id and m.deleted_at is null and m.accepted_at is not null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  where r.id = p_recipient_id;
$$;

comment on function private.advance_reminder_recipients(uuid) is 'Who an advance reminder or notice about a recipient reaches (R11, owner decision 6): the recipient person when they can sign in; for a counterparty recipient, its account''s live, accepted Account Owners and Account Admins; and the Advancing Leads assigned to the recipient''s engagement. Never an unassigned Account Member.';
revoke all on function private.advance_reminder_recipients(uuid) from public, anon, authenticated;

create or replace function private.advance_reminder_args(p_recipient_id uuid, p_reminder text, p_outstanding integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'title', p.title,
    'reminder', split_part(p_reminder, ':', 1),
    'due', case when p.due_at is null then 'none' else 'set' end,
    'outstanding', p_outstanding,
    'orgName', o.name,
    'projectName', j.name)
    || case when p.due_at is null then '{}'::jsonb
         else jsonb_build_object('dueAt', to_char(p.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) end
    || case when r.engagement_id is null then '{}'::jsonb
         else jsonb_build_object('gatewayPath', '/work/engagements/' || private.gateway_display_key('ENG', r.engagement_id) || '/advance') end
  from app.advance_recipients r
  join app.advance_packets p on p.id = r.advance_packet_id
  join app.projects j on j.id = p.project_id
  join app.organizations o on o.id = p.org_id
  where r.id = p_recipient_id;
$$;

comment on function private.advance_reminder_args(uuid, text, integer) is 'The arguments of an advance_packet.reminder: the packet title, the reminder (due, overdue or manual), whether a due date is set, dueAt as an ISO instant, how many sections are outstanding, the org and project names, and the Gateway path of the engagement''s Advance tab when the recipient answers under one.';
revoke all on function private.advance_reminder_args(uuid, text, integer) from public, anon, authenticated;

create or replace function private.advance_outstanding(p_recipient_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from app.advance_progress g
  where g.advance_recipient_id = p_recipient_id and g.cell_state in ('Missing', 'Returned');
$$;

comment on function private.advance_outstanding(uuid) is 'How many sections of a sent packet a recipient still has to answer: Missing or Returned in app.advance_progress.';
revoke all on function private.advance_outstanding(uuid) from public, anon, authenticated;

-- Queues one reminder to everyone it reaches, writing the ledger first; returns how many people it newly reached.
create or replace function private.queue_advance_reminder(p_recipient_id uuid, p_reminder text, p_due_at timestamptz, p_outstanding integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_packet app.advance_packets;
  v_person uuid;
  v_args jsonb;
  v_count integer := 0;
begin
  select p.* into v_packet from app.advance_recipients r join app.advance_packets p on p.id = r.advance_packet_id
  where r.id = p_recipient_id;
  v_args := private.advance_reminder_args(p_recipient_id, p_reminder, p_outstanding);
  for v_person in select x from private.advance_reminder_recipients(p_recipient_id) x loop
    -- The coordinator who reminds by hand is never reminded themselves.
    continue when v_person = private.current_person_id();
    insert into private.advance_reminders_sent (advance_recipient_id, recipient_person_id, reminder, due_at)
    values (p_recipient_id, v_person, p_reminder, p_due_at)
    on conflict do nothing;
    if found then
      perform private.notify(v_packet.org_id, v_person, 'advance_packet.reminder', 'advance_packets', v_packet.id,
        v_packet.project_id, v_args);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

comment on function private.queue_advance_reminder(uuid, text, timestamptz, integer) is 'Sends one advance_packet.reminder about a recipient to each person private.advance_reminder_recipients names, except the signed-in person, writing private.advance_reminders_sent first and skipping anyone already reminded of the same reminder and due date. Returns how many people it newly reached.';
revoke all on function private.queue_advance_reminder(uuid, text, timestamptz, integer) from public, anon, authenticated;

-- 4. Packet reminders ---------------------------------------------------------------------------------------------------------

create or replace function private.send_advance_reminders()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_days bigint;
  v_every bigint;
  v_k integer;
  v_reminder text;
  v_sent integer := 0;
begin
  for v_row in
    select r.id as recipient_id, p.due_at, p.org_id, j.workspace_id, j.id as project_id,
      private.advance_outstanding(r.id) as outstanding
    from app.advance_packets p
    join app.projects j on j.id = p.project_id and j.deleted_at is null and j.project_state not in ('Complete', 'Canceled')
    join app.advance_recipients r on r.advance_packet_id = p.id and r.deleted_at is null
    where p.deleted_at is null and p.sent_at is not null and p.due_at is not null
      and private.project_setting_boolean(j.id, 'advancing.reminders')
  loop
    continue when v_row.outstanding = 0;
    v_days := private.setting_integer(v_row.org_id, 'advancing.reminder_days_before', v_row.workspace_id, v_row.project_id);
    v_every := private.setting_integer(v_row.org_id, 'advancing.overdue_reminder_every_days', v_row.workspace_id, v_row.project_id);
    v_reminder := null;
    if now() >= v_row.due_at - make_interval(days => v_days::integer) and now() < v_row.due_at then
      v_reminder := 'due';
    elsif now() >= v_row.due_at and v_every > 0 then
      v_k := least(floor(extract(epoch from now() - v_row.due_at) / (v_every * 86400))::integer, 5);
      if v_k >= 1 then
        v_reminder := 'overdue:' || v_k;
      end if;
    end if;
    continue when v_reminder is null;
    v_sent := v_sent + private.queue_advance_reminder(v_row.recipient_id, v_reminder, v_row.due_at, v_row.outstanding);
  end loop;
  return v_sent;
end;
$$;

comment on function private.send_advance_reminders() is 'Hourly (pg_cron xos_send_advance_reminders): for each recipient of a sent packet with a due date, on a project that is not Complete or Canceled and where advancing.reminders is on, with a section Missing or Returned, sends advance_packet.reminder once when advancing.reminder_days_before days or less are left, and after the due date the k-th overdue reminder every advancing.overdue_reminder_every_days days (0 sends none), the highest k reached, up to five. Each reaches private.advance_reminder_recipients once, through private.advance_reminders_sent. Returns how many reminders it queued.';
revoke all on function private.send_advance_reminders() from public, anon, authenticated;

-- 5. Project facts reminders --------------------------------------------------------------------------------------------------

create or replace function private.roster_missing_facts(p_roster_entry_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[
    case when private.project_fact_offered(r.engagement_id, 'Uniforms')
      and not exists (select 1 from app.roster_uniform_sizes u where u.roster_entry_id = r.id and u.deleted_at is null) then 'uniform' end,
    case when private.project_fact_offered(r.engagement_id, 'Travel')
      and not exists (select 1 from app.roster_travel_requests t where t.roster_entry_id = r.id and t.deleted_at is null) then 'travel' end,
    case when private.project_fact_offered(r.engagement_id, 'Parking')
      and not exists (select 1 from app.roster_vehicles v where v.roster_entry_id = r.id and v.deleted_at is null) then 'vehicle' end
  ], null)
  from app.engagement_roster_entries r where r.id = p_roster_entry_id;
$$;

comment on function private.roster_missing_facts(uuid) is 'The project facts (R5) an offering asks of a roster entry that are not entered yet: uniform (Uniforms), travel (Travel), vehicle (Parking). Presence only; no value is read.';
revoke all on function private.roster_missing_facts(uuid) from public, anon, authenticated;

create or replace function private.send_roster_fact_reminders()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_days bigint;
  v_threshold integer;
  v_missing text[];
  v_sent integer := 0;
begin
  for v_row in
    select r.id, r.org_id, r.engagement_id, e.project_id, j.workspace_id, lower(r.arrival_window) as arrives_at,
      private.roster_entry_person_id(r.is_self, r.person_id, e.person_id) as person_id
    from app.engagement_roster_entries r
    join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
      and e.engagement_state not in ('Complete', 'Canceled')
    join app.projects j on j.id = e.project_id and j.deleted_at is null and j.project_state not in ('Complete', 'Canceled')
    where r.deleted_at is null and r.entry_state = 'Accepted' and (r.is_self or r.person_response = 'Accepted')
      and r.arrival_window is not null and lower(r.arrival_window) > now()
      and private.project_setting_boolean(j.id, 'advancing.reminders')
  loop
    continue when v_row.person_id is null;
    v_missing := private.roster_missing_facts(v_row.id);
    continue when cardinality(v_missing) = 0;
    v_days := private.setting_integer(v_row.org_id, 'advancing.reminder_days_before', v_row.workspace_id, v_row.project_id);
    -- The nearer threshold reached wins: one day ahead, else days_before ahead.
    v_threshold := case
      when v_row.arrives_at - now() <= interval '1 day' then 1
      when v_row.arrives_at - now() <= make_interval(days => v_days::integer) then v_days::integer
    end;
    continue when v_threshold is null;
    insert into private.roster_fact_reminders_sent (roster_entry_id, threshold_days, arrival_starts_at)
    values (v_row.id, v_threshold, v_row.arrives_at)
    on conflict do nothing;
    continue when not found;
    perform private.notify(v_row.org_id, v_row.person_id, 'roster_entry.facts_requested', 'engagement_roster_entries', v_row.id,
      v_row.project_id, private.roster_notification_args(v_row.id) || jsonb_build_object(
        'missing', array_to_string(v_missing, ','),
        'kind', case when cardinality(v_missing) = 1 then v_missing[1] else 'several' end,
        'arrivesAt', to_char(v_row.arrives_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end;
$$;

comment on function private.send_roster_fact_reminders() is 'Hourly (pg_cron xos_send_roster_fact_reminders): for each live roster entry Accepted by the reviewer and by the person (or the self entry), with an arrival still ahead, on a project where advancing.reminders is on, while the Uniforms, Travel or Parking offering reaches the engagement and its project fact (R5) is missing, sends roster_entry.facts_requested to the person once advancing.reminder_days_before days and once one day before arrival, through private.roster_fact_reminders_sent. Returns how many it queued.';
revoke all on function private.send_roster_fact_reminders() from public, anon, authenticated;

-- 6. The jobs -----------------------------------------------------------------------------------------------------------------

select cron.schedule('xos_send_advance_reminders', '23 * * * *', 'select private.send_advance_reminders()');
select cron.schedule('xos_send_roster_fact_reminders', '27 * * * *', 'select private.send_roster_fact_reminders()');

-- 7. Reminding by hand --------------------------------------------------------------------------------------------------------

create or replace function app.send_advance_reminder_now(p_packet_id uuid, p_recipient_ids uuid[])
returns table (sent integer, skipped integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_packet app.advance_packets;
  v_id uuid;
  v_outstanding integer;
  v_sent integer := 0;
  v_skipped integer := 0;
begin
  perform private.require_person();
  select p.* into v_packet from app.advance_packets p where p.id = p_packet_id and p.deleted_at is null;
  if v_packet.id is null or not private.can_on_project(v_packet.project_id, 'advancing.packet.send') then
    raise exception using errcode = '42501', message = 'reminders for this packet are not allowed';
  end if;
  if p_recipient_ids is null or cardinality(p_recipient_ids) not between 1 and 200 then
    perform private.refuse('advance_reminder_batch', 'Remind 1 to 200 recipients at a time.');
  end if;
  if v_packet.sent_at is null then
    perform private.refuse('advance_packet_unsent', 'Send the packet before reminding its recipients.');
  end if;
  for v_id in select distinct x from unnest(p_recipient_ids) x loop
    v_outstanding := case when exists (
        select 1 from app.advance_recipients r where r.id = v_id and r.advance_packet_id = v_packet.id and r.deleted_at is null)
      then private.advance_outstanding(v_id) else 0 end;
    if v_outstanding > 0
       and private.queue_advance_reminder(v_id, 'manual', date_trunc('day', now(), 'UTC'), v_outstanding) > 0 then
      v_sent := v_sent + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;
  return query select v_sent, v_skipped;
end;
$$;

comment on function app.send_advance_reminder_now(uuid, uuid[]) is 'A coordinator with advancing.packet.send on the project reminds chosen recipients of a sent packet (1 to 200, advance_reminder_batch) now: advance_packet.reminder to everyone private.advance_reminder_recipients names, at most once a UTC day per recipient. A recipient with nothing outstanding, not on the packet, or already reminded by hand today is skipped. Returns how many were reminded and how many skipped.';
revoke all on function app.send_advance_reminder_now(uuid, uuid[]) from public, anon;
grant execute on function app.send_advance_reminder_now(uuid, uuid[]) to authenticated, service_role;
