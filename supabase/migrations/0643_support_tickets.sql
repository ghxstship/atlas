-- 0643_support_tickets.sql
-- A31 support (Section 11.16, Section 7.3 "support_tickets, support_ticket_messages"):
--   * Internal support: any member contacts their own org's admins through Help, Contact Support. The
--     ticket goes to the Organization queue, which holders of org.help.write answer.
--   * Platform support: org admins (org.help.write) contact the platform team. The ticket goes to the
--     Platform queue; its channel and first response target follow the org's plan (the Access plan has
--     the help center only and opens no platform tickets).
--   * Diagnostics are attached only with the requester's consent, in their own append-only table:
--     route, app version, device, recent errors and a screenshot's storage path.
--   * The platform team works the Platform queue with the service role (the operator console). A
--     ticket carries what the requester chose to send; reading any other tenant data still needs a
--     support session (Section 8).

create type app.support_queue as enum ('Organization', 'Platform');
comment on type app.support_queue is 'Who answers a support ticket: the org''s own admins (Organization) or the platform team (Platform).';

create type app.support_ticket_state as enum ('Open', 'Waiting', 'Resolved', 'Closed');
comment on type app.support_ticket_state is 'Support ticket states: Open (with the responders), Waiting (on the requester), Resolved (answer given, can reopen) and Closed (final).';

create type app.support_severity as enum ('Severity 1', 'Severity 2', 'Severity 3', 'Severity 4');
comment on type app.support_severity is 'Support severity: 1 is a production outage, 2 a major feature broken, 3 a problem with a workaround, 4 a question.';

create type app.support_category as enum ('Question', 'Problem', 'Access', 'Billing', 'Account', 'Feature Request');
comment on type app.support_category is 'What a support ticket is about.';

create type app.support_channel as enum ('In App', 'Email', 'Chat', 'Priority Queue', 'Dedicated Channel');
comment on type app.support_channel is 'How a ticket is answered: In App for the Organization queue; for the Platform queue, by plan (Core Email, Pro Chat, Team Priority Queue, Enterprise Dedicated Channel).';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('support_ticket', 'Open', 'Waiting'),
  ('support_ticket', 'Open', 'Resolved'),
  ('support_ticket', 'Open', 'Closed'),
  ('support_ticket', 'Waiting', 'Open'),
  ('support_ticket', 'Waiting', 'Resolved'),
  ('support_ticket', 'Waiting', 'Closed'),
  ('support_ticket', 'Resolved', 'Open'),
  ('support_ticket', 'Resolved', 'Closed');

insert into private.domain_event_types (code, subject, description) values
  ('support_ticket.opened', 'support_tickets', 'A support ticket was opened in the Organization or Platform queue.'),
  ('support_ticket.answered', 'support_tickets', 'A responder posted the first answer to a support ticket.'),
  ('support_ticket.resolved', 'support_tickets', 'A support ticket was resolved.');

-- Helpers -------------------------------------------------------------------------------------------------

-- True for the platform team: the service role, or a direct database session without a JWT.
create or replace function private.is_platform_operator()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
    or (nullif(current_setting('request.jwt.claims', true), '') is null and private.current_person_id() is null);
$$;

comment on function private.is_platform_operator() is 'True when the caller is the platform team: the service role, or a database session without a signed-in person.';
revoke all on function private.is_platform_operator() from public, anon;
grant execute on function private.is_platform_operator() to authenticated, service_role;

-- Adds business hours, counting weekdays around the clock (UTC) and skipping Saturdays and Sundays.
create or replace function private.add_business_hours(p_from timestamptz, p_hours integer)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_at timestamptz := p_from;
  v_left integer := p_hours;
begin
  while v_left > 0 loop
    v_at := v_at + interval '1 hour';
    if extract(isodow from v_at at time zone 'UTC') < 6 then
      v_left := v_left - 1;
    end if;
  end loop;
  return v_at;
end;
$$;

comment on function private.add_business_hours(timestamptz, integer) is 'The time a number of business hours after a start, counting weekday hours (UTC) and skipping weekends. Two business days are 48 business hours.';

-- The Platform queue channel and first response target of a plan (Section 11.16 table); a null target
-- is best effort.
create or replace function private.platform_support_terms(p_plan_code text, p_severity app.support_severity, p_from timestamptz)
returns table (channel app.support_channel, first_response_due_at timestamptz)
language sql
immutable
set search_path = ''
as $$
  select case p_plan_code
           when 'core' then 'Email'::app.support_channel
           when 'pro' then 'Chat'::app.support_channel
           when 'team' then 'Priority Queue'::app.support_channel
           when 'enterprise' then 'Dedicated Channel'::app.support_channel
         end,
         case
           when p_plan_code = 'core' then private.add_business_hours(p_from, 48)
           when p_plan_code = 'pro' then private.add_business_hours(p_from, 24)
           when p_plan_code = 'team' then private.add_business_hours(p_from, 8)
           when p_plan_code = 'enterprise' and p_severity = 'Severity 1' then p_from + interval '1 hour'
           when p_plan_code = 'enterprise' then private.add_business_hours(p_from, 8)
         end;
$$;

comment on function private.platform_support_terms(text, app.support_severity, timestamptz) is 'Platform support channel and first response deadline by plan: Core email in 2 business days, Pro chat in 1, Team priority queue in 8 business hours, Enterprise dedicated channel in 1 hour for severity 1. Access has no platform channel (null).';

-- Support tickets ------------------------------------------------------------------------------------------

create table app.support_tickets (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  ticket_number text not null,
  queue app.support_queue not null,
  category app.support_category not null,
  severity app.support_severity not null default 'Severity 3',
  subject text not null,
  body text not null,
  ticket_state app.support_ticket_state not null default 'Open',
  channel app.support_channel not null,
  first_response_due_at timestamptz,
  first_responded_at timestamptz,
  constraint support_tickets_subject_length check (char_length(btrim(subject)) between 1 and 200),
  constraint support_tickets_body_length check (char_length(btrim(body)) between 1 and 10000),
  constraint support_tickets_number_format check (ticket_number ~ '^SUP-[0-9]{4,}$'),
  constraint support_tickets_channel_queue check ((queue = 'Organization') = (channel = 'In App')),
  constraint support_tickets_due_queue check (queue = 'Platform' or first_response_due_at is null)
);

create index support_tickets_membership_idx on app.support_tickets (membership_id);
create index support_tickets_queue_idx on app.support_tickets (org_id, queue, ticket_state);
create unique index support_tickets_number_key on app.support_tickets (org_id, ticket_number);

call private.install_domain_table('app.support_tickets', 'app.memberships', 'membership_id');
call private.describe('app.support_tickets', 'A request for help (Section 11.16): to the org''s own admins (Organization queue) or to the platform team (Platform queue). Opened only through app.open_support_ticket.', array[
  'membership_id', 'Member who asked for help.',
  'ticket_number', 'Display number, SUP-0001 upward per org.',
  'queue', 'Organization or Platform.',
  'category', 'What the ticket is about.',
  'severity', 'Severity 1 (outage) to Severity 4 (question).',
  'subject', 'One-line summary.',
  'body', 'What happened and what the requester needs.',
  'ticket_state', 'Open, Waiting, Resolved or Closed.',
  'channel', 'How the ticket is answered: In App for the Organization queue, by plan for the Platform queue.',
  'first_response_due_at', 'Platform first response deadline from the plan; NULL for best effort and for the Organization queue.',
  'first_responded_at', 'When a responder first answered.'
]);

-- Who reads a ticket: the requester, and the org's responders (org.help.write). Takes the row's
-- column values, so the policy never re-reads app.support_tickets (ADR 0016 item 14).
create or replace function private.can_read_support_ticket(p_org_id uuid, p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_membership_id in (select private.my_membership_ids())
    or private.has_capability(p_org_id, 'org.help.write');
$$;

comment on function private.can_read_support_ticket(uuid, uuid) is 'Whether the signed-in person reads a support ticket: they asked, or they answer support for its org (org.help.write).';
revoke all on function private.can_read_support_ticket(uuid, uuid) from public, anon;
grant execute on function private.can_read_support_ticket(uuid, uuid) to authenticated, service_role;

call private.install_policies('app.support_tickets', $$private.can_read_support_ticket(org_id, membership_id)$$);

create or replace function private.readable_support_ticket_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from app.support_tickets t
  where t.deleted_at is null and private.can_read_support_ticket(t.org_id, t.membership_id);
$$;

comment on function private.readable_support_ticket_ids() is 'Support tickets the signed-in person reads.';
revoke all on function private.readable_support_ticket_ids() from public, anon;
grant execute on function private.readable_support_ticket_ids() to authenticated, service_role;

call private.install_lifecycle('app.support_tickets', 'support_ticket_id', 'ticket_state', 'support_ticket', 'Open',
  $$support_ticket_id in (select private.readable_support_ticket_ids())$$);


-- A ticket keeps who asked, where it went and what it said; only its state (through the transition
-- RPC) and the first response time change.
create or replace function private.guard_support_ticket()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.membership_id <> old.membership_id or new.queue <> old.queue or new.ticket_number <> old.ticket_number
     or new.channel <> old.channel or new.subject <> old.subject or new.body <> old.body
     or new.category <> old.category or new.severity <> old.severity
     or new.first_response_due_at is distinct from old.first_response_due_at then
    perform private.refuse('support_ticket_immutable', 'A support ticket keeps what was asked and where it went; add a message instead.');
  end if;
  if old.first_responded_at is not null and new.first_responded_at is distinct from old.first_responded_at then
    perform private.refuse('support_ticket_first_response_fixed', 'The first response time is recorded once.');
  end if;
  return new;
end;
$$;

comment on function private.guard_support_ticket() is 'Support tickets: requester, queue, number, channel, content and deadline never change; the first response time is set once.';
revoke all on function private.guard_support_ticket() from public, anon, authenticated;
create trigger t42_guard_support_ticket before update on app.support_tickets
  for each row execute function private.guard_support_ticket();

-- Diagnostics -----------------------------------------------------------------------------------------------

create table app.support_ticket_diagnostics (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  support_ticket_id uuid not null references app.support_tickets (id),
  consented_at timestamptz not null,
  route text,
  app_version text,
  device text,
  recent_errors text,
  screenshot_path text,
  constraint support_ticket_diagnostics_route_length check (route is null or char_length(route) <= 500),
  constraint support_ticket_diagnostics_version_length check (app_version is null or char_length(app_version) <= 50),
  constraint support_ticket_diagnostics_device_length check (device is null or char_length(device) <= 300),
  constraint support_ticket_diagnostics_errors_length check (recent_errors is null or char_length(recent_errors) <= 4000),
  constraint support_ticket_diagnostics_screenshot_path check (screenshot_path is null or screenshot_path ~ '^[a-z0-9][a-z0-9/_.-]{0,499}$'),
  constraint support_ticket_diagnostics_not_empty check (coalesce(route, app_version, device, recent_errors, screenshot_path) is not null)
);

create unique index support_ticket_diagnostics_ticket_key on app.support_ticket_diagnostics (support_ticket_id);

call private.install_domain_table('app.support_ticket_diagnostics', 'app.support_tickets', 'support_ticket_id', '{}', true);
call private.describe('app.support_ticket_diagnostics', 'Diagnostics a requester chose to attach to a support ticket (Section 11.16), with the moment they consented. Append-only; a ticket has at most one set.', array[
  'support_ticket_id', 'Ticket the diagnostics belong to.',
  'consented_at', 'When the requester agreed to send the diagnostics.',
  'route', 'Page the requester was on.',
  'app_version', 'App version and build.',
  'device', 'Browser or device and operating system.',
  'recent_errors', 'Recent client errors, newest first, without record contents.',
  'screenshot_path', 'Storage path of the screenshot, when one was taken.'
]);

call private.install_policies('app.support_ticket_diagnostics', $$support_ticket_id in (select private.readable_support_ticket_ids())$$);

-- Messages -----------------------------------------------------------------------------------------------------

create table app.support_ticket_messages (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  support_ticket_id uuid not null references app.support_tickets (id),
  author_membership_id uuid references app.memberships (id),
  body text not null,
  constraint support_ticket_messages_body_length check (char_length(btrim(body)) between 1 and 10000)
);

create index support_ticket_messages_author_idx on app.support_ticket_messages (author_membership_id);

call private.install_domain_table('app.support_ticket_messages', 'app.support_tickets', 'support_ticket_id', array['app.memberships', 'author_membership_id'], true);
create index support_ticket_messages_ticket_idx on app.support_ticket_messages (support_ticket_id, created_at);
call private.describe('app.support_ticket_messages', 'The conversation on a support ticket, oldest first. Append-only; written through app.post_support_message or by the platform team.', array[
  'support_ticket_id', 'Ticket the message belongs to.',
  'author_membership_id', 'Member who wrote it; NULL for the platform support team.',
  'body', 'Message text.'
]);

call private.install_policies('app.support_ticket_messages', $$support_ticket_id in (select private.readable_support_ticket_ids())$$);

-- RPCs ------------------------------------------------------------------------------------------------------------

create or replace function app.open_support_ticket(
  p_org_id uuid,
  p_queue app.support_queue,
  p_category app.support_category,
  p_subject text,
  p_body text,
  p_severity app.support_severity default 'Severity 3',
  p_diagnostics jsonb default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_membership uuid;
  v_plan text;
  v_channel app.support_channel := 'In App';
  v_due timestamptz;
  v_id uuid;
  v_number text;
begin
  select m.id into v_membership from app.memberships m
  where m.org_id = p_org_id and m.person_id = v_person and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  order by m.valid_from desc limit 1;
  if v_membership is null then
    raise exception using errcode = '42501', message = 'only a member of the org can open a support ticket';
  end if;

  if p_queue = 'Platform' then
    if not private.has_capability(p_org_id, 'org.help.write') then
      perform private.refuse('support_platform_admins_only', 'Only org admins contact platform support; ask your admins through Contact Support.');
    end if;
    select s.plan_code into v_plan from app.subscriptions s
    where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null;
    select t.channel, t.first_response_due_at into v_channel, v_due
    from private.platform_support_terms(v_plan, p_severity, now()) t;
    if v_channel is null then
      perform private.refuse('support_plan_no_channel', 'The Access plan includes the help center and community forum; upgrade to contact platform support.');
    end if;
  end if;

  if p_diagnostics is not null and coalesce(p_diagnostics ->> 'consent', '') <> 'true' then
    perform private.refuse('support_diagnostics_consent', 'Diagnostics are attached only when you agree to send them.');
  end if;

  v_number := 'SUP-' || lpad(private.next_sequence(p_org_id, 'support_ticket')::text, 4, '0');
  insert into app.support_tickets (membership_id, ticket_number, queue, category, severity, subject, body, channel, first_response_due_at)
  values (v_membership, v_number, p_queue, p_category, p_severity, btrim(p_subject), btrim(p_body), v_channel, v_due)
  returning id into v_id;

  if p_diagnostics is not null then
    insert into app.support_ticket_diagnostics (support_ticket_id, consented_at, route, app_version, device, recent_errors, screenshot_path)
    values (v_id, now(), nullif(p_diagnostics ->> 'route', ''), nullif(p_diagnostics ->> 'app_version', ''),
      nullif(p_diagnostics ->> 'device', ''), nullif(p_diagnostics ->> 'recent_errors', ''),
      nullif(p_diagnostics ->> 'screenshot_path', ''));
  end if;

  perform private.emit_event(p_org_id, 'support_ticket.opened', 'support_tickets', v_id, null,
    jsonb_build_object('ticket_number', v_number, 'queue', p_queue, 'category', p_category, 'severity', p_severity,
      'channel', v_channel, 'first_response_due_at', v_due, 'diagnostics', p_diagnostics is not null));
  return v_id;
end;
$$;

comment on function app.open_support_ticket(uuid, app.support_queue, app.support_category, text, text, app.support_severity, jsonb) is 'Opens a support ticket as the signed-in member. Organization queue: any member. Platform queue: holders of org.help.write on a plan with a platform channel, which sets the channel and the first response deadline. Diagnostics (route, app_version, device, recent_errors, screenshot_path) are stored only with "consent": true. Returns the ticket id.';
revoke all on function app.open_support_ticket(uuid, app.support_queue, app.support_category, text, text, app.support_severity, jsonb) from public, anon;
grant execute on function app.open_support_ticket(uuid, app.support_queue, app.support_category, text, text, app.support_severity, jsonb) to authenticated, service_role;

create or replace function app.post_support_message(p_support_ticket_id uuid, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ticket app.support_tickets;
  v_operator boolean := private.is_platform_operator();
  v_membership uuid;
  v_responder boolean;
  v_id uuid;
begin
  select * into v_ticket from app.support_tickets t where t.id = p_support_ticket_id and t.deleted_at is null;
  if v_ticket.id is null or not (v_operator or private.can_read_support_ticket(v_ticket.org_id, v_ticket.membership_id)) then
    raise exception using errcode = '42501', message = 'the support ticket does not exist or is not visible';
  end if;
  if v_ticket.ticket_state = 'Closed' then
    perform private.refuse('support_ticket_closed', 'A closed ticket takes no more messages; open a new ticket.');
  end if;
  if not v_operator then
    select m.id into v_membership from app.memberships m
    where m.org_id = v_ticket.org_id and m.id in (select private.my_membership_ids()) limit 1;
  end if;
  -- Responders: the platform team on the Platform queue, org.help.write holders other than the
  -- requester on the Organization queue.
  v_responder := case
    when v_operator then v_ticket.queue = 'Platform'
    else v_ticket.queue = 'Organization' and v_membership is distinct from v_ticket.membership_id
      and private.has_capability(v_ticket.org_id, 'org.help.write')
  end;
  if v_operator and not v_responder then
    perform private.refuse('support_platform_queue_only', 'The platform team answers only Platform queue tickets.');
  end if;
  if not v_responder and v_membership is distinct from v_ticket.membership_id then
    perform private.refuse('support_message_not_party', 'Only the requester and the ticket''s responders write on a ticket.');
  end if;

  insert into app.support_ticket_messages (support_ticket_id, author_membership_id, body)
  values (v_ticket.id, v_membership, btrim(p_body))
  returning id into v_id;

  if v_responder and v_ticket.first_responded_at is null then
    update app.support_tickets set first_responded_at = now() where id = v_ticket.id;
    perform private.emit_event(v_ticket.org_id, 'support_ticket.answered', 'support_tickets', v_ticket.id, null,
      jsonb_build_object('ticket_number', v_ticket.ticket_number, 'queue', v_ticket.queue));
  end if;
  -- A requester's reply hands a ticket that waited on them back to the responders.
  if not v_responder and v_ticket.ticket_state = 'Waiting' then
    perform private.transition_lifecycle('support_ticket', 'app.support_tickets', 'ticket_state', 'app.support_ticket_state_transitions',
      'support_ticket_id', v_ticket.id, 'Waiting', 'Open', 'The requester replied.');
  end if;
  return v_id;
end;
$$;

comment on function app.post_support_message(uuid, text) is 'Adds a message to a support ticket as the requester or a responder (org.help.write on the Organization queue, the platform team on the Platform queue). The first responder message records first_responded_at; a requester reply to a Waiting ticket reopens it. Returns the message id.';
revoke all on function app.post_support_message(uuid, text) from public, anon;
grant execute on function app.post_support_message(uuid, text) to authenticated, service_role;

create or replace function app.transition_support_ticket(
  p_support_ticket_id uuid,
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
  v_operator boolean := private.is_platform_operator();
  v_requester boolean;
  v_responder boolean;
  v_ledger uuid;
begin
  select * into v_ticket from app.support_tickets t where t.id = p_support_ticket_id and t.deleted_at is null;
  if v_ticket.id is null or not (v_operator or private.can_read_support_ticket(v_ticket.org_id, v_ticket.membership_id)) then
    raise exception using errcode = '42501', message = 'the support ticket does not exist or is not visible';
  end if;
  v_requester := not v_operator and v_ticket.membership_id in (select private.my_membership_ids());
  v_responder := case
    when v_operator then v_ticket.queue = 'Platform'
    else v_ticket.queue = 'Organization' and private.has_capability(v_ticket.org_id, 'org.help.write')
  end;
  -- The requester closes their ticket, reopens a resolved one, or takes it back from Waiting; only
  -- the ticket's responders mark it Waiting or Resolved.
  if not v_responder and not (v_requester and (p_next = 'Closed' or (p_next = 'Open' and p_expected in ('Resolved', 'Waiting')))) then
    perform private.refuse('support_ticket_transition_forbidden',
      format('Only the ticket''s responders move a ticket from %s to %s.', p_expected, p_next));
  end if;
  v_ledger := private.transition_lifecycle('support_ticket', 'app.support_tickets', 'ticket_state', 'app.support_ticket_state_transitions',
    'support_ticket_id', v_ticket.id, p_expected::text, p_next::text, p_reason);
  if p_next = 'Resolved' then
    perform private.emit_event(v_ticket.org_id, 'support_ticket.resolved', 'support_tickets', v_ticket.id, null,
      jsonb_build_object('ticket_number', v_ticket.ticket_number, 'queue', v_ticket.queue));
  end if;
  return v_ledger;
end;
$$;

comment on function app.transition_support_ticket(uuid, app.support_ticket_state, app.support_ticket_state, text) is 'Moves a support ticket through its lifecycle with a reason. Responders (org.help.write on the Organization queue, the platform team on the Platform queue) make any allowed move; the requester closes, reopens a resolved ticket or takes back a waiting one. Returns the ledger entry id.';
revoke all on function app.transition_support_ticket(uuid, app.support_ticket_state, app.support_ticket_state, text) from public, anon;
grant execute on function app.transition_support_ticket(uuid, app.support_ticket_state, app.support_ticket_state, text) to authenticated, service_role;

call private.install_default_retention('app.support_tickets');
call private.install_default_retention('app.support_ticket_state_transitions');
call private.install_default_retention('app.support_ticket_diagnostics', interval '2 years');
call private.install_default_retention('app.support_ticket_messages');
