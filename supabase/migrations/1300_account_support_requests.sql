-- 1300_account_support_requests.sql
-- A70 help in every shell (Section 11.16, RRR-115). External users contact the org that engaged them
-- through Messages, and contact platform support only about their own account. A31's support tickets
-- (0643) belong to an org and a membership, which an external party does not have, so a request
-- about one's own account needs a home of its own:
--   * private.account_support_requests: one row per request, owned by the person who sent it, never
--     by an org. It is in private, so no API reads it; the person reads their own requests through
--     app.my_account_support_requests, and the platform team works them with the service role, as it
--     does the Platform queue. Platform support answers by email at the person's sign-in address.
--   * Only account matters: Account, Access (signing in), Problem and Question. Billing and feature
--     requests belong to an org, so they go to the org through Messages.
--   * Diagnostics are attached only with consent, as on a support ticket: route, app version,
--     device, recent errors and a screenshot from the person's own support-screenshots folder (1034).
--   * Five requests per person in any 24 hours, so a signed-up account cannot flood the queue.
-- Reuses A31's support enums (category, state, channel) and A33's screenshot owner rule.

create sequence private.account_support_request_number_seq;

create table private.account_support_requests (
  id uuid primary key default private.uuid_v7(),
  person_id uuid not null references app.people (id),
  request_number text not null default ('ACC-' || lpad(nextval('private.account_support_request_number_seq')::text, 6, '0')),
  category app.support_category not null,
  subject text not null,
  body text not null,
  request_state app.support_ticket_state not null default 'Open',
  channel app.support_channel not null default 'Email',
  diagnostics_consented_at timestamptz,
  route text,
  app_version text,
  device text,
  recent_errors text,
  screenshot_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_support_requests_number_key unique (request_number),
  constraint account_support_requests_category check (category in ('Account', 'Access', 'Problem', 'Question')),
  constraint account_support_requests_subject_length check (char_length(btrim(subject)) between 1 and 200),
  constraint account_support_requests_body_length check (char_length(btrim(body)) between 1 and 10000),
  constraint account_support_requests_channel check (channel = 'Email'),
  constraint account_support_requests_route_length check (route is null or char_length(route) <= 500),
  constraint account_support_requests_version_length check (app_version is null or char_length(app_version) <= 50),
  constraint account_support_requests_device_length check (device is null or char_length(device) <= 300),
  constraint account_support_requests_errors_length check (recent_errors is null or char_length(recent_errors) <= 4000),
  constraint account_support_requests_screenshot_path check (screenshot_path is null
    or (screenshot_path ~ '^[a-z0-9][a-z0-9/_.-]*$' and char_length(screenshot_path) <= 500)),
  constraint account_support_requests_diagnostics_consent check (diagnostics_consented_at is not null
    or coalesce(route, app_version, device, recent_errors, screenshot_path) is null)
);

create index account_support_requests_person_idx on private.account_support_requests (person_id, created_at desc);
create index account_support_requests_open_idx on private.account_support_requests (request_state, created_at);

comment on table private.account_support_requests is 'Requests to platform support about the sender''s own account (Section 11.16): sign-in, email and account deletion. Owned by a person, never an org; sent through app.open_account_support_request, read by the sender through app.my_account_support_requests and worked by the platform team with the service role. Answered by email.';
comment on column private.account_support_requests.person_id is 'Person who asked for help.';
comment on column private.account_support_requests.request_number is 'Display number, ACC-000001 upward across the platform.';
comment on column private.account_support_requests.category is 'Account, Access (signing in), Problem or Question.';
comment on column private.account_support_requests.subject is 'One-line summary.';
comment on column private.account_support_requests.body is 'What happened and what the person needs.';
comment on column private.account_support_requests.request_state is 'Open, Waiting, Resolved or Closed, moved by the platform team.';
comment on column private.account_support_requests.channel is 'How the request is answered: Email, at the person''s sign-in address.';
comment on column private.account_support_requests.diagnostics_consented_at is 'When the person agreed to send the diagnostics; NULL when none were sent.';
comment on column private.account_support_requests.route is 'Page or screen the person was on.';
comment on column private.account_support_requests.app_version is 'App version and build.';
comment on column private.account_support_requests.device is 'Browser or device and operating system.';
comment on column private.account_support_requests.recent_errors is 'Recent client errors, newest first, without record contents.';
comment on column private.account_support_requests.screenshot_path is 'Storage path of a screenshot in the person''s own support-screenshots folder.';

alter table private.account_support_requests enable row level security;
revoke all on private.account_support_requests from public, anon, authenticated;
grant select, update on private.account_support_requests to service_role;
revoke all on sequence private.account_support_request_number_seq from public, anon, authenticated;

-- A request keeps who asked and what was sent; the platform team moves only its state.
create or replace function private.guard_account_support_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.person_id <> old.person_id or new.request_number <> old.request_number or new.category <> old.category
     or new.subject <> old.subject or new.body <> old.body or new.channel <> old.channel
     or new.created_at <> old.created_at
     or new.diagnostics_consented_at is distinct from old.diagnostics_consented_at
     or new.route is distinct from old.route or new.app_version is distinct from old.app_version
     or new.device is distinct from old.device or new.recent_errors is distinct from old.recent_errors
     or new.screenshot_path is distinct from old.screenshot_path then
    perform private.refuse('account_support_immutable', 'An account support request keeps what was asked; only its state changes.');
  end if;
  new.updated_at := now();
  return new;
end;
$$;

comment on function private.guard_account_support_request() is 'Account support requests: the sender, number, content and diagnostics never change; only the state moves.';
revoke all on function private.guard_account_support_request() from public, anon, authenticated;
create trigger t42_guard_account_support_request before update on private.account_support_requests
  for each row execute function private.guard_account_support_request();

-- RPCs ------------------------------------------------------------------------------------------------------------

create or replace function app.open_account_support_request(
  p_category app.support_category,
  p_subject text,
  p_body text,
  p_diagnostics jsonb default null
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_screenshot text := nullif(p_diagnostics ->> 'screenshot_path', '');
  v_number text;
begin
  if p_category not in ('Account', 'Access', 'Problem', 'Question') then
    perform private.refuse('account_support_category', 'Platform support helps only with your own account; ask the organization about anything else in Messages.');
  end if;
  if char_length(btrim(coalesce(p_subject, ''))) not between 1 and 200
     or char_length(btrim(coalesce(p_body, ''))) not between 1 and 10000 then
    perform private.refuse('account_support_content', 'Write a subject of up to 200 characters and a message of up to 10,000.');
  end if;
  if p_diagnostics is not null and coalesce(p_diagnostics ->> 'consent', '') <> 'true' then
    perform private.refuse('support_diagnostics_consent', 'Diagnostics are attached only when you agree to send them.');
  end if;
  if v_screenshot is not null and private.support_screenshot_owner(v_screenshot) is distinct from v_person then
    perform private.refuse('support_screenshot_owner', 'A screenshot is attached only from the requester''s own uploads.');
  end if;
  if (select count(*) from private.account_support_requests r
      where r.person_id = v_person and r.created_at > now() - interval '24 hours') >= 5 then
    perform private.refuse('account_support_limit', 'You sent five requests in the last day. Platform support answers each by email; wait for those answers first.');
  end if;

  insert into private.account_support_requests (person_id, category, subject, body, diagnostics_consented_at,
    route, app_version, device, recent_errors, screenshot_path)
  values (v_person, p_category, btrim(p_subject), btrim(p_body),
    case when p_diagnostics is not null then now() end,
    nullif(p_diagnostics ->> 'route', ''), nullif(p_diagnostics ->> 'app_version', ''),
    nullif(p_diagnostics ->> 'device', ''), nullif(p_diagnostics ->> 'recent_errors', ''), v_screenshot)
  returning request_number into v_number;
  return v_number;
end;
$$;

comment on function app.open_account_support_request(app.support_category, text, text, jsonb) is 'Sends platform support a request about the signed-in person''s own account (Account, Access, Problem or Question). Diagnostics (route, app_version, device, recent_errors, screenshot_path from the person''s own folder) are stored only with "consent": true. At most five requests per person in 24 hours. Returns the request number; platform support answers by email.';
revoke all on function app.open_account_support_request(app.support_category, text, text, jsonb) from public, anon;
grant execute on function app.open_account_support_request(app.support_category, text, text, jsonb) to authenticated, service_role;

create or replace function app.my_account_support_requests()
returns table (
  request_number text,
  category app.support_category,
  subject text,
  request_state app.support_ticket_state,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.request_number, r.category, r.subject, r.request_state, r.created_at
  from private.account_support_requests r
  where r.person_id = private.current_person_id()
  order by r.created_at desc;
$$;

comment on function app.my_account_support_requests() is 'The signed-in person''s own account support requests, newest first: number, category, subject, state and when they were sent.';
revoke all on function app.my_account_support_requests() from public, anon;
grant execute on function app.my_account_support_requests() to authenticated, service_role;
