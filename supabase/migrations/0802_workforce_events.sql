-- 0802_workforce_events.sql
-- A29 Workforce Suite (Section 4.9 Events; managed in Atlas Schedule): briefings, crew calls and meetings
-- with RSVP, location, agenda and check-in.
--   * Org-wide events need schedule.timeline.write at organization reach; project events need it on the
--     project. The organizer or such a manager edits or cancels an event (a cancel names its reason).
--   * The audience (0800) reads the event, RSVPs Going, Maybe or Declined, and checks in from an hour before
--     the start until the end. The organizer checks in anyone in the audience, by hand or from a scan.
--   * Creating an event notifies its audience (event.invited).

create type app.workforce_event_kind as enum ('Briefing', 'Crew Call', 'Meeting');
comment on type app.workforce_event_kind is 'Workforce event kinds: a briefing, a crew call or a meeting.';

create type app.rsvp_response as enum ('Going', 'Maybe', 'Declined');
comment on type app.rsvp_response is 'An RSVP answer.';

create type app.check_in_method as enum ('Self', 'Organizer', 'Scan');
comment on type app.check_in_method is 'How an attendee was checked in: by themselves, by the organizer, or from a badge or code scan.';

insert into private.domain_event_types (code, subject, description) values
  ('workforce_event.scheduled', 'workforce_events', 'A briefing, crew call or meeting was scheduled.'),
  ('workforce_event.canceled', 'workforce_events', 'A briefing, crew call or meeting was canceled.'),
  ('workforce_event.checked_in', 'event_check_ins', 'An attendee checked in to a briefing, crew call or meeting.');

create table app.workforce_events (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  organizer_membership_id uuid references app.memberships (id),
  event_kind app.workforce_event_kind not null,
  title text not null,
  agenda text,
  location text,
  venue_id uuid references app.venues (id),
  space_id uuid references app.spaces (id),
  audience_kind app.audience_kind not null default 'Organization',
  project_id uuid references app.projects (id),
  team_id uuid references app.teams (id),
  role_id uuid references app.roles (id),
  group_id uuid references app.groups (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  rsvp_required boolean not null default true,
  canceled_at timestamptz,
  cancel_reason text,
  constraint workforce_events_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint workforce_events_agenda_length check (agenda is null or char_length(agenda) <= 10000),
  constraint workforce_events_location_length check (location is null or char_length(btrim(location)) between 1 and 300),
  constraint workforce_events_window check (ends_at > starts_at and ends_at <= starts_at + interval '7 days'),
  constraint workforce_events_cancel check ((canceled_at is null) = (cancel_reason is null)),
  constraint workforce_events_cancel_length check (cancel_reason is null or char_length(btrim(cancel_reason)) between 1 and 500),
  constraint workforce_events_audience check (
    (audience_kind = 'Team') = (team_id is not null) and (audience_kind = 'Role') = (role_id is not null)
    and (audience_kind = 'Group') = (group_id is not null) and (audience_kind <> 'Project' or project_id is not null))
);
create index workforce_events_organizer_idx on app.workforce_events (organizer_membership_id);
create index workforce_events_venue_idx on app.workforce_events (venue_id);
create index workforce_events_space_idx on app.workforce_events (space_id);
create index workforce_events_project_idx on app.workforce_events (project_id);
create index workforce_events_team_idx on app.workforce_events (team_id);
create index workforce_events_role_idx on app.workforce_events (role_id);
create index workforce_events_group_idx on app.workforce_events (group_id);
create index workforce_events_starts_idx on app.workforce_events (org_id, starts_at);
call private.install_domain_table('app.workforce_events', null, null,
  array['app.memberships', 'organizer_membership_id', 'app.venues', 'venue_id', 'app.spaces', 'space_id', 'app.projects', 'project_id',
        'app.teams', 'team_id', 'app.groups', 'group_id']);
call private.describe('app.workforce_events', 'A briefing, crew call or meeting (Section 4.9 Events) for an audience, with RSVP, location, agenda and check-in.', array[
  'organizer_membership_id', 'Member who organizes the event.',
  'event_kind', 'Briefing, Crew Call or Meeting.',
  'title', 'Event title.',
  'agenda', 'Agenda, in order.',
  'location', 'Where to meet, in words.',
  'venue_id', 'Venue of the event, when it is at one.',
  'space_id', 'Space within the venue.',
  'audience_kind', 'Who is invited: Organization, Project, Team, Role or Group.',
  'project_id', 'Project audience, or the project the event belongs to.',
  'team_id', 'Team audience.',
  'role_id', 'Org role audience.',
  'group_id', 'Group audience.',
  'starts_at', 'Start.',
  'ends_at', 'End, at most seven days after the start.',
  'rsvp_required', 'Whether invitees are asked to RSVP.',
  'canceled_at', 'When the event was canceled.',
  'cancel_reason', 'Why it was canceled.'
]);

create or replace function private.can_manage_workforce_events(p_org_id uuid, p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_project_id is null then private.has_capability(p_org_id, 'schedule.timeline.write')
              else private.can_on_project(p_project_id, 'schedule.timeline.write') end;
$$;
comment on function private.can_manage_workforce_events(uuid, uuid) is 'Whether the signed-in person schedules events: schedule.timeline.write org-wide for org events, or on the project for project events.';
revoke all on function private.can_manage_workforce_events(uuid, uuid) from public, anon;
grant execute on function private.can_manage_workforce_events(uuid, uuid) to authenticated, service_role;

call private.install_policies('app.workforce_events',
  $$organizer_membership_id = any (array(select private.my_membership_ids()))
    or private.can_manage_workforce_events(org_id, project_id)
    or private.in_audience(org_id, audience_kind, project_id, team_id, role_id, group_id)$$,
  $$organizer_membership_id = any (array(select private.my_membership_ids())) and private.can_manage_workforce_events(org_id, project_id)$$,
  $$organizer_membership_id = any (array(select private.my_membership_ids())) or private.can_manage_workforce_events(org_id, project_id)$$);

create or replace function private.readable_workforce_event_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from app.workforce_events e
  where e.deleted_at is null and e.org_id in (select private.my_org_ids())
    and (e.organizer_membership_id in (select private.my_membership_ids())
      or private.can_manage_workforce_events(e.org_id, e.project_id)
      or private.in_audience(e.org_id, e.audience_kind, e.project_id, e.team_id, e.role_id, e.group_id));
$$;
comment on function private.readable_workforce_event_ids() is 'Workforce events the signed-in person reads.';
revoke all on function private.readable_workforce_event_ids() from public, anon;
grant execute on function private.readable_workforce_event_ids() to authenticated, service_role;

create or replace function private.guard_workforce_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_audience(new.org_id, new.audience_kind, new.project_id, new.team_id, new.role_id, new.group_id);
  if new.space_id is not null and (new.venue_id is null or not exists (select 1 from app.spaces s where s.id = new.space_id and s.venue_id = new.venue_id)) then
    perform private.refuse('workforce_event_space_venue', 'The space must belong to the event''s venue.');
  end if;
  if tg_op = 'UPDATE' then
    if new.organizer_membership_id is distinct from old.organizer_membership_id then
      perform private.refuse('workforce_event_organizer_fixed', 'An event keeps its organizer.');
    end if;
    if old.canceled_at is not null then
      perform private.refuse('workforce_event_canceled', 'A canceled event does not change; schedule a new one.');
    end if;
  elsif new.canceled_at is not null then
    perform private.refuse('workforce_event_canceled', 'An event is scheduled active.');
  end if;
  return new;
end;
$$;
comment on function private.guard_workforce_event() is 'Workforce events: audience within the org, space within the venue, a fixed organizer, and cancellation is final.';
revoke all on function private.guard_workforce_event() from public, anon, authenticated;
create trigger t42_guard_workforce_event before insert or update on app.workforce_events
  for each row execute function private.guard_workforce_event();

create or replace function private.announce_workforce_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid;
begin
  if tg_op = 'INSERT' then
    perform private.emit_event(new.org_id, 'workforce_event.scheduled', 'workforce_events', new.id, new.project_id,
      jsonb_build_object('event_kind', new.event_kind, 'starts_at', new.starts_at, 'audience_kind', new.audience_kind));
    for v_person in
      select m.person_id from app.memberships m
      where m.id in (select private.audience_membership_ids(new.org_id, new.audience_kind, new.project_id, new.team_id, new.role_id, new.group_id))
        and m.id is distinct from new.organizer_membership_id
    loop
      perform private.notify(new.org_id, v_person, 'event.invited', 'app.workforce_events', new.id, new.project_id,
        jsonb_build_object('title', new.title, 'startsAt', new.starts_at, 'event_kind', new.event_kind));
    end loop;
  elsif old.canceled_at is null and new.canceled_at is not null then
    perform private.emit_event(new.org_id, 'workforce_event.canceled', 'workforce_events', new.id, new.project_id,
      jsonb_build_object('reason', new.cancel_reason));
  end if;
  return null;
end;
$$;
comment on function private.announce_workforce_event() is 'After insert or cancel of a workforce event: emits the domain event and, on insert, invites the audience.';
revoke all on function private.announce_workforce_event() from public, anon, authenticated;
create trigger t90_announce_workforce_event after insert or update of canceled_at on app.workforce_events
  for each row execute function private.announce_workforce_event();

create table app.event_rsvps (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  workforce_event_id uuid not null references app.workforce_events (id),
  membership_id uuid not null references app.memberships (id),
  response app.rsvp_response not null,
  responded_at timestamptz not null default now()
);
create unique index event_rsvps_key on app.event_rsvps (workforce_event_id, membership_id);
create index event_rsvps_membership_idx on app.event_rsvps (membership_id);
call private.install_domain_table('app.event_rsvps', 'app.workforce_events', 'workforce_event_id', array['app.memberships', 'membership_id']);
call private.describe('app.event_rsvps', 'RSVPs to workforce events, one per invitee, changed through app.rsvp_to_event.', array[
  'workforce_event_id', 'Event.',
  'membership_id', 'Invitee who answered.',
  'response', 'Going, Maybe or Declined.',
  'responded_at', 'When they last answered.'
]);
call private.install_policies('app.event_rsvps', $$workforce_event_id in (select private.readable_workforce_event_ids())$$);

create table app.event_check_ins (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  workforce_event_id uuid not null references app.workforce_events (id),
  membership_id uuid not null references app.memberships (id),
  check_in_method app.check_in_method not null,
  checked_in_at timestamptz not null default now()
);
create unique index event_check_ins_key on app.event_check_ins (workforce_event_id, membership_id);
create index event_check_ins_membership_idx on app.event_check_ins (membership_id);
call private.install_domain_table('app.event_check_ins', 'app.workforce_events', 'workforce_event_id', array['app.memberships', 'membership_id'], true);
call private.describe('app.event_check_ins', 'Append-only attendance of workforce events, one per attendee.', array[
  'workforce_event_id', 'Event attended.',
  'membership_id', 'Attendee.',
  'check_in_method', 'Self, Organizer or Scan.',
  'checked_in_at', 'When they checked in.'
]);
call private.install_policies('app.event_check_ins', $$workforce_event_id in (select private.readable_workforce_event_ids())$$);

create or replace function app.rsvp_to_event(p_event_id uuid, p_response app.rsvp_response)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event app.workforce_events;
  v_mine uuid;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_event from app.workforce_events e where e.id = p_event_id and e.deleted_at is null;
  if v_event.id is null or not private.in_audience(v_event.org_id, v_event.audience_kind, v_event.project_id, v_event.team_id,
       v_event.role_id, v_event.group_id) then
    raise exception using errcode = '42501', message = 'the event does not exist or you are not invited';
  end if;
  if v_event.canceled_at is not null then
    perform private.refuse('workforce_event_canceled', 'This event was canceled.');
  end if;
  if v_event.ends_at <= now() then
    perform private.refuse('workforce_event_over', 'This event is over.');
  end if;
  v_mine := private.my_membership_in(v_event.org_id);
  insert into app.event_rsvps (workforce_event_id, membership_id, response) values (p_event_id, v_mine, p_response)
  on conflict (workforce_event_id, membership_id) do update set response = excluded.response, responded_at = now()
  returning id into v_id;
  return v_id;
end;
$$;
comment on function app.rsvp_to_event(uuid, app.rsvp_response) is 'Records or changes the signed-in invitee''s RSVP to an upcoming event. Returns the RSVP id.';
revoke all on function app.rsvp_to_event(uuid, app.rsvp_response) from public, anon;
grant execute on function app.rsvp_to_event(uuid, app.rsvp_response) to authenticated, service_role;

create or replace function app.check_in_to_event(
  p_event_id uuid,
  p_membership_id uuid default null,
  p_method app.check_in_method default 'Self'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event app.workforce_events;
  v_mine uuid;
  v_target uuid;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_event from app.workforce_events e where e.id = p_event_id and e.deleted_at is null;
  if v_event.id is null or v_event.id not in (select private.readable_workforce_event_ids()) then
    raise exception using errcode = '42501', message = 'the event does not exist or is not visible';
  end if;
  if v_event.canceled_at is not null then
    perform private.refuse('workforce_event_canceled', 'This event was canceled.');
  end if;
  if now() < v_event.starts_at - interval '1 hour' or now() > v_event.ends_at then
    perform private.refuse('workforce_event_check_in_window', 'Check-in opens an hour before the start and closes at the end.');
  end if;
  v_mine := private.my_membership_in(v_event.org_id);
  v_target := coalesce(p_membership_id, v_mine);
  if v_target = v_mine and p_method = 'Self' then
    if not private.in_audience(v_event.org_id, v_event.audience_kind, v_event.project_id, v_event.team_id, v_event.role_id, v_event.group_id) then
      perform private.refuse('workforce_event_not_invited', 'You are not invited to this event.');
    end if;
  else
    if p_method = 'Self' or not (v_event.organizer_membership_id = v_mine or private.can_manage_workforce_events(v_event.org_id, v_event.project_id)) then
      perform private.refuse('workforce_event_check_in_authority', 'Only the organizer or an event manager checks someone else in.');
    end if;
    if v_target not in (select private.audience_membership_ids(v_event.org_id, v_event.audience_kind, v_event.project_id,
         v_event.team_id, v_event.role_id, v_event.group_id)) then
      perform private.refuse('workforce_event_not_invited', 'That person is not invited to this event.');
    end if;
  end if;
  select c.id into v_id from app.event_check_ins c where c.workforce_event_id = p_event_id and c.membership_id = v_target;
  if v_id is null then
    insert into app.event_check_ins (workforce_event_id, membership_id, check_in_method) values (p_event_id, v_target, p_method)
    returning id into v_id;
    perform private.emit_event(v_event.org_id, 'workforce_event.checked_in', 'event_check_ins', v_id, v_event.project_id,
      jsonb_build_object('workforce_event_id', p_event_id, 'method', p_method));
  end if;
  return v_id;
end;
$$;
comment on function app.check_in_to_event(uuid, uuid, app.check_in_method) is 'Checks an invitee in to an event from an hour before the start until the end: the invitee themselves (Self), or anyone in the audience by the organizer or an event manager (Organizer or Scan). Checking in twice returns the first record. Returns the check-in id.';
revoke all on function app.check_in_to_event(uuid, uuid, app.check_in_method) from public, anon;
grant execute on function app.check_in_to_event(uuid, uuid, app.check_in_method) to authenticated, service_role;

call private.install_default_retention('app.workforce_events');
call private.install_default_retention('app.event_rsvps');
call private.install_default_retention('app.event_check_ins');
