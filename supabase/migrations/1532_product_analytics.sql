-- 1532_product_analytics.sql
-- A96 (RRR-141), finding A65-022, Section 11.14 ("Consent-gated product analytics track the funnel for each workflow
-- in Sections 11.11 to 11.13 against its target"), ADR 0052. First-party only: no outside analytics provider, which
-- would be a new subprocessor and needs an owner decision.
--   * private.product_workflows: the workflows of Sections 11.11 to 11.13 a funnel event may name
--   * app.product_events: the minimal event: when, which app, what happened, the page's route template (never its
--     path, so no org slug, record key or token), the workflow and step, and a random key for the browser session.
--     No person, no org, no free text: nothing in an event identifies anyone
--   * app.record_product_events: the only write path, called by the apps' event route after their consent seam
--     allows it (the person's performance consent and no Global Privacy Control signal; nothing is sent by default).
--     At most 25 events a call and 300 per person every 10 minutes
--   * app.product_funnel_hourly: hourly counts and distinct sessions per workflow step, for platform staff
--   * kept 13 months, so a year's funnel compares with the last

create table private.product_workflows (
  code text primary key,
  app_code text not null,
  target text not null,
  constraint product_workflows_code_format check (code ~ '^(atlas|gateway|compass)\.[a-z][a-z_]*$'),
  constraint product_workflows_app check (app_code in ('Atlas', 'Gateway', 'Compass')),
  constraint product_workflows_target_length check (char_length(target) between 1 and 200)
);

comment on table private.product_workflows is 'Workflows of Sections 11.11 to 11.13 whose funnels product analytics measure against their target (1532). An event may name only these.';
comment on column private.product_workflows.code is 'Workflow code, app.name.';
comment on column private.product_workflows.app_code is 'Shell the workflow belongs to.';
comment on column private.product_workflows.target is 'The measured target from the spec, for the funnel review.';

alter table private.product_workflows enable row level security;
revoke all on private.product_workflows from public, anon, authenticated;
grant select on private.product_workflows to service_role;

insert into private.product_workflows (code, app_code, target) values
  ('atlas.projects_gates', 'Atlas', 'New project from template in under 60 s; gate readiness loads in under 500 ms'),
  ('atlas.work_records', 'Atlas', 'Create and fully classify a record in under 10 s, keyboard only'),
  ('atlas.schedule', 'Atlas', 'Reschedule with dependency preview in under 3 interactions'),
  ('atlas.show', 'Atlas', 'Cue sync to every connected device in under 500 ms'),
  ('atlas.advancing', 'Atlas', 'Every outstanding item visible on one screen'),
  ('atlas.crew', 'Atlas', 'Staff a 50-position call in under 10 minutes'),
  ('atlas.finance', 'Atlas', 'Approve a queue of 20 items in under 60 s'),
  ('atlas.procurement', 'Atlas', 'Award to PO in 1 action'),
  ('atlas.safety', 'Atlas', 'New incident visible to dispatch in under 2 s'),
  ('atlas.reports', 'Atlas', 'Any number to its records in 1 click'),
  ('atlas.settings', 'Atlas', 'Any setting reached in 1 search'),
  ('gateway.discover', 'Gateway', 'First relevant opportunity in under 10 s from Home'),
  ('gateway.apply', 'Gateway', 'Apply in 3 taps or fewer with a complete profile'),
  ('gateway.onboard', 'Gateway', 'Median onboarding packet completed in under 10 minutes'),
  ('gateway.work', 'Gateway', 'Every engagement detail reachable from Home in 1 tap'),
  ('gateway.get_paid', 'Gateway', 'Submit an invoice in under 60 s'),
  ('gateway.reputation', 'Gateway', 'Profile completed to 100 percent in under 15 minutes'),
  ('gateway.communicate', 'Gateway', 'Reply from the push notification without opening the app'),
  ('compass.clock', 'Compass', 'Clock in with 1 tap in under 2 s from unlock'),
  ('compass.tasks', 'Compass', 'Complete a task with photo in under 10 s'),
  ('compass.scan', 'Compass', '30 items received in under 60 s'),
  ('compass.incidents', 'Compass', 'Report filed in under 30 s, including offline'),
  ('compass.inspections', 'Compass', 'Average under 5 s per item'),
  ('compass.show', 'Compass', 'Next cue readable from arm''s length'),
  ('compass.supervisor', 'Compass', 'Approve a crew''s timesheets in under 60 s'),
  ('compass.credentials', 'Compass', 'Badge shown in 1 tap from the lock screen');

create table app.product_events (
  id uuid primary key default private.uuid_v7(),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  app_code text not null,
  event_name text not null,
  route_template text,
  workflow_code text,
  step smallint,
  session_key uuid not null,
  constraint product_events_app check (app_code in ('Atlas', 'Gateway', 'Compass')),
  constraint product_events_name check (event_name in ('Page Viewed', 'Workflow Started', 'Workflow Step', 'Workflow Completed')),
  constraint product_events_route_format check (route_template is null
    or (char_length(route_template) <= 200 and route_template ~ '^/[A-Za-z0-9/_.\[\]-]*$')),
  constraint product_events_workflow_format check (workflow_code is null or workflow_code ~ '^(atlas|gateway|compass)\.[a-z][a-z_]*$'),
  constraint product_events_step_range check (step is null or step between 0 and 50),
  constraint product_events_shape check (
    (event_name = 'Page Viewed' and route_template is not null and workflow_code is null and step is null)
    or (event_name <> 'Page Viewed' and workflow_code is not null)),
  constraint product_events_step_events check (event_name <> 'Workflow Step' or step is not null),
  constraint product_events_occurred_window check (occurred_at between received_at - interval '1 day' and received_at + interval '5 minutes')
);

create index product_events_occurred_idx on app.product_events (occurred_at);
create index product_events_workflow_idx on app.product_events (workflow_code, occurred_at) where workflow_code is not null;

alter table app.product_events enable row level security;
revoke all on app.product_events from public, anon, authenticated;
grant select on app.product_events to authenticated;
grant all on app.product_events to service_role;
create policy product_events_staff_read on app.product_events for select to authenticated
  using ((select private.is_platform_staff()));

comment on table app.product_events is 'Consent-gated, first-party product analytics events (Section 11.14, A65-022): what happened in which app, on which route template or workflow step, keyed to a random browser session. No person, org, path or free text, so no event identifies anyone. Recorded only through app.record_product_events after the person consented; read by platform staff.';
comment on column app.product_events.id is 'Primary key, UUID v7.';
comment on column app.product_events.occurred_at is 'When it happened, by the browser''s clock, held to the day before it was received.';
comment on column app.product_events.received_at is 'When the platform received it. Set by the database.';
comment on column app.product_events.app_code is 'App it happened in: Atlas, Gateway or Compass.';
comment on column app.product_events.event_name is 'Page Viewed, Workflow Started, Workflow Step or Workflow Completed.';
comment on column app.product_events.route_template is 'Route template of the page, with every org slug, key, id and token replaced by its parameter name; never the path itself.';
comment on column app.product_events.workflow_code is 'Workflow of Sections 11.11 to 11.13 (private.product_workflows) a funnel event belongs to.';
comment on column app.product_events.step is 'Step of the workflow a Workflow Step event reached, from 0.';
comment on column app.product_events.session_key is 'Random key the browser makes for its session and forgets when the session ends, so a funnel follows one visit without knowing whose it is.';

create table private.product_event_windows (
  person_id uuid not null,
  window_start timestamptz not null,
  events integer not null,
  primary key (person_id, window_start),
  constraint product_event_windows_events check (events >= 0)
);

create index product_event_windows_start_idx on private.product_event_windows (window_start);

comment on table private.product_event_windows is 'Event counts per person in 10-minute windows, only to cap how many events one person sends (300 per window). Kept for an hour, never joined to events.';
comment on column private.product_event_windows.person_id is 'Person sending events.';
comment on column private.product_event_windows.window_start is 'Start of the 10-minute window.';
comment on column private.product_event_windows.events is 'Events the person sent in the window.';

alter table private.product_event_windows enable row level security;
revoke all on private.product_event_windows from public, anon, authenticated;

create or replace function app.record_product_events(p_app_code text, p_session_key uuid, p_events jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_count integer;
  v_window timestamptz := date_bin('10 minutes', now(), timestamptz '2000-01-01 00:00:00+00');
  v_sent integer;
  v_event jsonb;
begin
  if p_app_code is null or p_app_code not in ('Atlas', 'Gateway', 'Compass') then
    perform private.refuse('product_events_app', 'Events come from Atlas, Gateway or Compass.');
  end if;
  if p_session_key is null or p_events is null or jsonb_typeof(p_events) <> 'array' then
    perform private.refuse('product_events_invalid', 'Events come as an array with a session key.');
  end if;
  v_count := jsonb_array_length(p_events);
  if v_count = 0 then
    return 0;
  end if;
  if v_count > 25 then
    perform private.refuse('product_events_batch', 'Send at most 25 events at a time.');
  end if;

  delete from private.product_event_windows w where w.window_start < now() - interval '1 hour';
  insert into private.product_event_windows (person_id, window_start, events) values (v_person, v_window, v_count)
  on conflict (person_id, window_start) do update set events = private.product_event_windows.events + excluded.events
  returning events into v_sent;
  if v_sent > 300 then
    perform private.refuse('product_events_limit', 'Too many events from one person; the rest are dropped.');
  end if;

  for v_event in select * from jsonb_array_elements(p_events) loop
    if v_event ->> 'workflow' is not null
       and not exists (select 1 from private.product_workflows w where w.code = v_event ->> 'workflow') then
      perform private.refuse('product_events_workflow', 'An event may name only a workflow of Sections 11.11 to 11.13.');
    end if;
  end loop;

  insert into app.product_events (occurred_at, app_code, event_name, route_template, workflow_code, step, session_key)
  select least(greatest(coalesce((e ->> 'occurredAt')::timestamptz, now()), now() - interval '1 day'), now()), p_app_code,
    e ->> 'name', e ->> 'route', e ->> 'workflow', (e ->> 'step')::smallint, p_session_key
  from jsonb_array_elements(p_events) e;
  return v_count;
end;
$$;

comment on function app.record_product_events(text, uuid, jsonb) is 'Records product analytics events, [{occurredAt, name, route, workflow, step}], for one browser session. The apps call it only after their consent seam allows analytics (performance consent and no Global Privacy Control); the person is never stored with the events. At most 25 events a call and 300 per person every 10 minutes; a workflow must be one of Sections 11.11 to 11.13. Returns how many it recorded.';
revoke all on function app.record_product_events(text, uuid, jsonb) from public, anon;
grant execute on function app.record_product_events(text, uuid, jsonb) to authenticated;

create view app.product_funnel_hourly with (security_invoker = on) as
select date_bin('1 hour', e.occurred_at, timestamptz '2000-01-01 00:00:00+00') as hour_start,
  e.app_code, e.event_name, e.workflow_code, e.step, e.route_template,
  count(*)::bigint as events,
  count(distinct e.session_key)::bigint as sessions
from app.product_events e
group by 1, 2, 3, 4, 5, 6;

comment on view app.product_funnel_hourly is 'Product analytics in hourly buckets (instants, not calendar days): events and distinct browser sessions per app, event, workflow step and route template, the funnel the platform team checks against the Sections 11.11 to 11.13 targets. Platform staff only, through the product_events policy.';
grant select on app.product_funnel_hourly to authenticated;

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.product_events', 'Age', 'occurred_at', interval '13 months', 'Delete',
   'Funnels compare a year with the last; nothing in an event identifies a person.');
