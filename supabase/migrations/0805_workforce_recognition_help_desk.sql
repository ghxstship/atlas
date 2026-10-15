-- 0805_workforce_recognition_help_desk.sql
-- A29 Workforce Suite (Section 4.9 Recognition and Help desk):
--   * Recognition: shout-outs from one member to another, tied to a project or a shift, posted to the feed
--     as a Recognition post and notified to the person recognized. No points currency. The count appears
--     on a profile only with the person's consent (consent purpose recognition_profile, Section 14).
--   * Help desk: requests to internal teams (operations, IT, HR, facilities) with categories, assignment and
--     response times, built on A31's Organization support queue (0643) without changing its columns or
--     policies. Teams are set up by org.help.write holders (Settings, Help and Support); team members read
--     and answer their team's requests through their own RPCs and additive read policies.

create type app.help_desk_team_kind as enum ('Operations', 'IT', 'HR', 'Facilities', 'Other');
comment on type app.help_desk_team_kind is 'Which internal team a help desk queue belongs to.';

insert into private.consent_purposes (code, lawful_basis, sort_order) values ('recognition_profile', 'consent', 50);

insert into private.domain_event_types (code, subject, description) values
  ('recognition.given', 'recognitions', 'A member recognized a colleague with a shout-out.'),
  ('help_desk_request.routed', 'support_tickets', 'A help desk request was routed to an internal team.'),
  ('help_desk_request.assigned', 'support_tickets', 'A help desk request was assigned to a team member.');

-- Recognition ---------------------------------------------------------------------------------------------------

create table app.recognitions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  from_membership_id uuid not null references app.memberships (id),
  to_membership_id uuid not null references app.memberships (id),
  project_id uuid references app.projects (id),
  shift_id uuid references app.shifts (id),
  message text not null,
  feed_post_id uuid references app.feed_posts (id),
  constraint recognitions_message_length check (char_length(btrim(message)) between 1 and 1000),
  constraint recognitions_not_self check (from_membership_id <> to_membership_id)
);
create index recognitions_from_idx on app.recognitions (from_membership_id);
create index recognitions_to_idx on app.recognitions (to_membership_id);
create index recognitions_project_idx on app.recognitions (project_id);
create index recognitions_shift_idx on app.recognitions (shift_id);
create index recognitions_feed_post_idx on app.recognitions (feed_post_id);
call private.install_domain_table('app.recognitions', null, null,
  array['app.memberships', 'from_membership_id', 'app.memberships', 'to_membership_id', 'app.projects', 'project_id',
        'app.shifts', 'shift_id', 'app.feed_posts', 'feed_post_id'], true);
call private.describe('app.recognitions', 'Append-only shout-outs (Section 4.9 Recognition) from one member to another, tied to a project or shift and posted to the feed. No points currency.', array[
  'from_membership_id', 'Member who gave the recognition.',
  'to_membership_id', 'Member recognized.',
  'project_id', 'Project the recognition is for.',
  'shift_id', 'Shift the recognition is for.',
  'message', 'What they did well.',
  'feed_post_id', 'Recognition post in the feed.'
]);
call private.install_policies('app.recognitions',
  $$from_membership_id = any (array(select private.my_membership_ids()))
    or to_membership_id = any (array(select private.my_membership_ids()))
    or feed_post_id in (select private.readable_feed_post_ids())$$);

create or replace function app.recognize(
  p_org_id uuid,
  p_to_membership_id uuid,
  p_message text,
  p_project_id uuid default null,
  p_shift_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_mine uuid := private.require_membership_in(p_org_id);
  v_shift app.shifts;
  v_project uuid := p_project_id;
  v_post uuid;
  v_id uuid;
  v_name text;
begin
  if p_to_membership_id = v_mine then
    perform private.refuse('recognition_self', 'Recognize a colleague, not yourself.');
  end if;
  if not exists (select 1 from app.memberships m where m.id = p_to_membership_id and m.org_id = p_org_id and m.deleted_at is null
                 and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    perform private.refuse('recognition_member_inactive', 'You can recognize only active members of this org.');
  end if;
  if p_shift_id is not null then
    select * into v_shift from app.shifts s where s.id = p_shift_id and s.org_id = p_org_id and s.deleted_at is null;
    if v_shift.id is null or v_shift.project_id not in (select private.readable_project_ids()) then
      raise exception using errcode = '42501', message = 'the shift does not exist or is not visible';
    end if;
    if v_shift.membership_id is distinct from p_to_membership_id then
      perform private.refuse('recognition_shift_person', 'A shift recognition goes to the person who worked the shift.');
    end if;
    if v_project is not null and v_project <> v_shift.project_id then
      perform private.refuse('recognition_shift_project', 'The shift belongs to another project.');
    end if;
    v_project := v_shift.project_id;
  end if;
  if v_project is not null and not exists (select 1 from app.projects p where p.id = v_project and p.org_id = p_org_id
       and p.id in (select private.readable_project_ids())) then
    raise exception using errcode = '42501', message = 'the project does not exist or is not visible';
  end if;
  v_name := (select pe.full_name from app.memberships m join app.people pe on pe.id = m.person_id where m.id = p_to_membership_id);
  insert into app.feed_posts (org_id, author_membership_id, post_kind, title, body, audience_kind, project_id)
  values (p_org_id, v_mine, 'Recognition', left(coalesce(v_name, ''), 200), btrim(p_message),
    case when v_project is null then 'Organization'::app.audience_kind else 'Project'::app.audience_kind end, v_project)
  returning id into v_post;
  insert into app.recognitions (from_membership_id, to_membership_id, project_id, shift_id, message, feed_post_id, org_id)
  values (v_mine, p_to_membership_id, v_project, p_shift_id, btrim(p_message), v_post, p_org_id)
  returning id into v_id;
  update app.feed_posts set notified_at = now() where id = v_post;
  perform private.emit_event(p_org_id, 'recognition.given', 'recognitions', v_id, v_project,
    jsonb_build_object('to_membership_id', p_to_membership_id, 'shift_id', p_shift_id));
  perform private.notify(p_org_id, (select m.person_id from app.memberships m where m.id = p_to_membership_id), 'recognition.received',
    'app.recognitions', v_id, v_project, jsonb_build_object('title', left(btrim(p_message), 80)));
  return v_id;
end;
$$;
comment on function app.recognize(uuid, uuid, text, uuid, uuid) is 'Recognizes a colleague with a shout-out, optionally for a project or for a shift they worked, posts it to the feed (the project audience, or the org) and notifies them. Returns the recognition id.';
revoke all on function app.recognize(uuid, uuid, text, uuid, uuid) from public, anon;
grant execute on function app.recognize(uuid, uuid, text, uuid, uuid) to authenticated, service_role;

-- A person's recognition count, shown only when they consented in that org.
create or replace function app.recognition_count(p_org_id uuid, p_person_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case when private.my_membership_in(p_org_id) is not null
      and exists (select 1 from app.consent_records c where c.org_id = p_org_id and c.person_id = p_person_id
                  and c.purpose_code = 'recognition_profile' and c.withdrawn_at is null and c.deleted_at is null)
    then (select count(*)::integer from app.recognitions r join app.memberships m on m.id = r.to_membership_id
          where r.org_id = p_org_id and m.person_id = p_person_id and r.deleted_at is null)
  end;
$$;
comment on function app.recognition_count(uuid, uuid) is 'How many times a person was recognized in an org, for members of that org, only when the person consented to show it (recognition_profile); NULL otherwise.';
revoke all on function app.recognition_count(uuid, uuid) from public, anon;
grant execute on function app.recognition_count(uuid, uuid) to authenticated, service_role;

-- Help desk teams --------------------------------------------------------------------------------------------------

create table app.help_desk_teams (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  team_kind app.help_desk_team_kind not null,
  description text,
  first_response_hours smallint not null default 8,
  archived_at timestamptz,
  constraint help_desk_teams_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint help_desk_teams_description_length check (description is null or char_length(description) <= 1000),
  constraint help_desk_teams_response check (first_response_hours between 1 and 168)
);
call private.install_domain_table('app.help_desk_teams');
create unique index help_desk_teams_name_key on app.help_desk_teams (org_id, lower(btrim(name))) where deleted_at is null;
call private.describe('app.help_desk_teams', 'Internal teams that answer help desk requests (Section 4.9 Help desk), with their first response target in business hours.', array[
  'name', 'Team name, unique in the org.',
  'team_kind', 'Operations, IT, HR, Facilities or Other.',
  'description', 'What the team helps with.',
  'first_response_hours', 'Business hours within which the team answers a new request.',
  'archived_at', 'When the team stopped taking requests.'
]);
call private.install_policies('app.help_desk_teams',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.help.write'))$$);

create table app.help_desk_team_members (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  help_desk_team_id uuid not null references app.help_desk_teams (id),
  membership_id uuid not null references app.memberships (id)
);
create index help_desk_team_members_membership_idx on app.help_desk_team_members (membership_id);
call private.install_domain_table('app.help_desk_team_members', 'app.help_desk_teams', 'help_desk_team_id', array['app.memberships', 'membership_id']);
create unique index help_desk_team_members_key on app.help_desk_team_members (help_desk_team_id, membership_id) where deleted_at is null;
call private.describe('app.help_desk_team_members', 'Members who answer a help desk team''s requests. Removing a member soft deletes the row.', array[
  'help_desk_team_id', 'Team.',
  'membership_id', 'Member who answers for it.'
]);
call private.install_policies('app.help_desk_team_members',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.help.write'))$$);

create or replace function private.my_help_desk_team_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tm.help_desk_team_id from app.help_desk_team_members tm
  where tm.deleted_at is null and tm.membership_id in (select private.my_membership_ids());
$$;
comment on function private.my_help_desk_team_ids() is 'Help desk teams the signed-in person answers for.';
revoke all on function private.my_help_desk_team_ids() from public, anon;
grant execute on function private.my_help_desk_team_ids() to authenticated, service_role;

-- Help desk routing on support tickets (A31's 0643 table, new columns only) -------------------------------------------------

alter table app.support_tickets
  add column help_desk_team_id uuid references app.help_desk_teams (id),
  add column assignee_membership_id uuid references app.memberships (id),
  add column help_desk_response_due_at timestamptz;
create index support_tickets_help_desk_team_idx on app.support_tickets (help_desk_team_id, ticket_state);
create index support_tickets_assignee_idx on app.support_tickets (assignee_membership_id);
comment on column app.support_tickets.help_desk_team_id is 'Internal team a help desk request is routed to (Organization queue only; A29).';
comment on column app.support_tickets.assignee_membership_id is 'Team member the help desk request is assigned to (A29).';
comment on column app.support_tickets.help_desk_response_due_at is 'When the team''s first response is due, from its target in business hours (A29).';

create or replace function private.guard_help_desk_ticket()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.help_desk_team_id is not distinct from old.help_desk_team_id and new.assignee_membership_id is not distinct from old.assignee_membership_id
     and new.help_desk_response_due_at is not distinct from old.help_desk_response_due_at then
    return new;
  end if;
  if not private.in_trusted_operation('route_help_desk_request') then
    perform private.refuse('help_desk_routing_rpc', 'Help desk requests are routed and assigned through their RPCs.');
  end if;
  return new;
end;
$$;
comment on function private.guard_help_desk_ticket() is 'Help desk team, assignee and response deadline on a support ticket change only through the help desk RPCs.';
revoke all on function private.guard_help_desk_ticket() from public, anon, authenticated;
create trigger t43_guard_help_desk_ticket before update on app.support_tickets
  for each row execute function private.guard_help_desk_ticket();

-- Additive read policies: a team member reads the requests routed to their team, their messages and state history.
create policy support_tickets_help_desk_read on app.support_tickets for select to authenticated
  using (help_desk_team_id = any (array(select private.my_help_desk_team_ids())));

create or replace function private.help_desk_ticket_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from app.support_tickets t
  where t.deleted_at is null and t.help_desk_team_id in (select private.my_help_desk_team_ids());
$$;
comment on function private.help_desk_ticket_ids() is 'Support tickets routed to the help desk teams the signed-in person answers for.';
revoke all on function private.help_desk_ticket_ids() from public, anon;
grant execute on function private.help_desk_ticket_ids() to authenticated, service_role;

create policy support_ticket_messages_help_desk_read on app.support_ticket_messages for select to authenticated
  using (support_ticket_id in (select private.help_desk_ticket_ids()));
create policy support_ticket_state_transitions_help_desk_read on app.support_ticket_state_transitions for select to authenticated
  using (support_ticket_id in (select private.help_desk_ticket_ids()));

-- Whether the signed-in person answers a help desk request: a member of its team, or an org.help.write holder.
create or replace function private.can_answer_help_desk_request(p_org_id uuid, p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_team_id in (select private.my_help_desk_team_ids()) or private.has_capability(p_org_id, 'org.help.write');
$$;
comment on function private.can_answer_help_desk_request(uuid, uuid) is 'Whether the signed-in person answers a help desk request: a member of its team or a holder of org.help.write.';
revoke all on function private.can_answer_help_desk_request(uuid, uuid) from public, anon;
grant execute on function private.can_answer_help_desk_request(uuid, uuid) to authenticated, service_role;

create or replace function app.open_help_desk_request(
  p_org_id uuid,
  p_help_desk_team_id uuid,
  p_category app.support_category,
  p_subject text,
  p_body text,
  p_severity app.support_severity default 'Severity 3'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_team app.help_desk_teams;
  v_id uuid;
  v_person uuid;
begin
  select * into v_team from app.help_desk_teams t where t.id = p_help_desk_team_id and t.org_id = p_org_id and t.deleted_at is null;
  if v_team.id is null or v_team.archived_at is not null then
    perform private.refuse('help_desk_team_unavailable', 'Pick an active help desk team of this org.');
  end if;
  v_id := app.open_support_ticket(p_org_id, 'Organization', p_category, p_subject, p_body, p_severity, null);
  perform private.begin_trusted_operation('route_help_desk_request');
  update app.support_tickets
  set help_desk_team_id = p_help_desk_team_id,
      help_desk_response_due_at = private.add_business_hours(now(), v_team.first_response_hours)
  where id = v_id;
  perform private.end_trusted_operation('route_help_desk_request');
  perform private.emit_event(p_org_id, 'help_desk_request.routed', 'support_tickets', v_id, null,
    jsonb_build_object('help_desk_team_id', p_help_desk_team_id, 'team_kind', v_team.team_kind));
  for v_person in
    select m.person_id from app.help_desk_team_members tm join app.memberships m on m.id = tm.membership_id
    where tm.help_desk_team_id = p_help_desk_team_id and tm.deleted_at is null and m.person_id is distinct from private.current_person_id()
  loop
    perform private.notify(p_org_id, v_person, 'help_request.assigned', 'app.support_tickets', v_id, null,
      jsonb_build_object('title', btrim(p_subject), 'team', v_team.name));
  end loop;
  return v_id;
end;
$$;
comment on function app.open_help_desk_request(uuid, uuid, app.support_category, text, text, app.support_severity) is 'Opens an Organization queue support ticket as the signed-in member, routed to an internal help desk team with the team''s first response deadline, and notifies the team. Returns the ticket id.';
revoke all on function app.open_help_desk_request(uuid, uuid, app.support_category, text, text, app.support_severity) from public, anon;
grant execute on function app.open_help_desk_request(uuid, uuid, app.support_category, text, text, app.support_severity) to authenticated, service_role;

create or replace function app.assign_help_desk_request(p_ticket_id uuid, p_assignee_membership_id uuid, p_help_desk_team_id uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ticket app.support_tickets;
  v_team uuid;
  v_hours smallint;
begin
  perform private.require_person();
  select * into v_ticket from app.support_tickets t where t.id = p_ticket_id and t.deleted_at is null;
  if v_ticket.id is null or v_ticket.queue <> 'Organization'
     or not private.can_answer_help_desk_request(v_ticket.org_id, v_ticket.help_desk_team_id) then
    raise exception using errcode = '42501', message = 'the request does not exist or you do not answer it';
  end if;
  if v_ticket.ticket_state = 'Closed' then
    perform private.refuse('support_ticket_closed', 'A closed request is not reassigned.');
  end if;
  v_team := coalesce(p_help_desk_team_id, v_ticket.help_desk_team_id);
  select t.first_response_hours into v_hours from app.help_desk_teams t
  where t.id = v_team and t.org_id = v_ticket.org_id and t.deleted_at is null and t.archived_at is null;
  if v_hours is null then
    perform private.refuse('help_desk_team_unavailable', 'Pick an active help desk team of this org.');
  end if;
  if p_assignee_membership_id is not null and not exists (select 1 from app.help_desk_team_members tm
       where tm.help_desk_team_id = v_team and tm.membership_id = p_assignee_membership_id and tm.deleted_at is null) then
    perform private.refuse('help_desk_assignee_not_team', 'Assign the request to a member of its team.');
  end if;
  perform private.begin_trusted_operation('route_help_desk_request');
  update app.support_tickets
  set help_desk_team_id = v_team,
      assignee_membership_id = p_assignee_membership_id,
      help_desk_response_due_at = case when v_team is distinct from v_ticket.help_desk_team_id and v_ticket.first_responded_at is null
        then private.add_business_hours(now(), v_hours) else help_desk_response_due_at end
  where id = p_ticket_id;
  perform private.end_trusted_operation('route_help_desk_request');
  perform private.emit_event(v_ticket.org_id, 'help_desk_request.assigned', 'support_tickets', p_ticket_id, null,
    jsonb_build_object('help_desk_team_id', v_team, 'assignee_membership_id', p_assignee_membership_id));
  if p_assignee_membership_id is not null and p_assignee_membership_id not in (select private.my_membership_ids()) then
    perform private.notify(v_ticket.org_id, (select m.person_id from app.memberships m where m.id = p_assignee_membership_id),
      'help_request.assigned', 'app.support_tickets', p_ticket_id, null, jsonb_build_object('title', v_ticket.subject));
  end if;
  return p_ticket_id;
end;
$$;
comment on function app.assign_help_desk_request(uuid, uuid, uuid) is 'A team member or org.help.write holder assigns a help desk request to a member of its team, optionally moving it to another team (which resets an unanswered request''s response deadline). NULL unassigns. Returns the ticket id.';
revoke all on function app.assign_help_desk_request(uuid, uuid, uuid) from public, anon;
grant execute on function app.assign_help_desk_request(uuid, uuid, uuid) to authenticated, service_role;

create or replace function app.answer_help_desk_request(p_ticket_id uuid, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ticket app.support_tickets;
  v_mine uuid;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_ticket from app.support_tickets t where t.id = p_ticket_id and t.deleted_at is null;
  if v_ticket.id is null or v_ticket.help_desk_team_id is null
     or not private.can_answer_help_desk_request(v_ticket.org_id, v_ticket.help_desk_team_id) then
    raise exception using errcode = '42501', message = 'the request does not exist or you do not answer it';
  end if;
  v_mine := private.my_membership_in(v_ticket.org_id);
  if v_mine = v_ticket.membership_id then
    return app.post_support_message(p_ticket_id, p_body);
  end if;
  if v_ticket.ticket_state = 'Closed' then
    perform private.refuse('support_ticket_closed', 'A closed ticket takes no more messages; open a new ticket.');
  end if;
  insert into app.support_ticket_messages (support_ticket_id, author_membership_id, body) values (p_ticket_id, v_mine, btrim(p_body))
  returning id into v_id;
  if v_ticket.first_responded_at is null then
    update app.support_tickets set first_responded_at = now() where id = p_ticket_id;
    perform private.emit_event(v_ticket.org_id, 'support_ticket.answered', 'support_tickets', p_ticket_id, null,
      jsonb_build_object('ticket_number', v_ticket.ticket_number, 'queue', v_ticket.queue, 'help_desk_team_id', v_ticket.help_desk_team_id));
  end if;
  return v_id;
end;
$$;
comment on function app.answer_help_desk_request(uuid, text) is 'A member of the request''s help desk team (or an org.help.write holder) answers it; the first answer records the response time. The requester''s own reply goes through app.post_support_message. Returns the message id.';
revoke all on function app.answer_help_desk_request(uuid, text) from public, anon;
grant execute on function app.answer_help_desk_request(uuid, text) to authenticated, service_role;

create or replace function app.transition_help_desk_request(
  p_ticket_id uuid,
  p_expected app.support_ticket_state,
  p_next app.support_ticket_state,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ticket app.support_tickets;
  v_ledger uuid;
begin
  perform private.require_person();
  select * into v_ticket from app.support_tickets t where t.id = p_ticket_id and t.deleted_at is null;
  if v_ticket.id is null or v_ticket.help_desk_team_id is null
     or not private.can_answer_help_desk_request(v_ticket.org_id, v_ticket.help_desk_team_id) then
    raise exception using errcode = '42501', message = 'the request does not exist or you do not answer it';
  end if;
  v_ledger := private.transition_lifecycle('support_ticket', 'app.support_tickets', 'ticket_state', 'app.support_ticket_state_transitions',
    'support_ticket_id', p_ticket_id, p_expected::text, p_next::text, p_reason);
  if p_next = 'Resolved' then
    perform private.emit_event(v_ticket.org_id, 'support_ticket.resolved', 'support_tickets', p_ticket_id, null,
      jsonb_build_object('ticket_number', v_ticket.ticket_number, 'queue', v_ticket.queue, 'help_desk_team_id', v_ticket.help_desk_team_id));
  end if;
  return v_ledger;
end;
$$;
comment on function app.transition_help_desk_request(uuid, app.support_ticket_state, app.support_ticket_state, text) is 'A member of the request''s help desk team (or an org.help.write holder) moves it through the support ticket lifecycle with a reason. Returns the ledger entry id.';
revoke all on function app.transition_help_desk_request(uuid, app.support_ticket_state, app.support_ticket_state, text) from public, anon;
grant execute on function app.transition_help_desk_request(uuid, app.support_ticket_state, app.support_ticket_state, text) to authenticated, service_role;

call private.install_default_retention('app.recognitions');
call private.install_default_retention('app.help_desk_teams');
call private.install_default_retention('app.help_desk_team_members');
