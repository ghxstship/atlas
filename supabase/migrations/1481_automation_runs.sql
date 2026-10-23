-- 1481_automation_runs.sql
-- A91 (RRR-136), finding A65-010, Section 7.3 (automation_runs), ADR 0047. The engine that runs the automations 1480
-- defines:
--   * app.automation_runs and app.automation_run_steps: the runs ledger, one run per automation and domain event
--     (idempotent per event) with its inputs, each action's request and response, errors and durations
--   * private.fan_out_automations, after insert on app.domain_events (t88, beside the webhook fan-out t87): starts a
--     run for every enabled automation of the org whose trigger and conditions match, and queues an automation.run job
--     on the A18 job queue (0510), whose finish_job retries with exponential backoff
--   * loop protection: an event raised by an automation's action carries the run in the request's JWT claims
--     (xos_automation_run_id, minted by the worker), so the new run's depth is its cause's plus one; past
--     private.automation_max_depth() (3) it is recorded Skipped (loop_depth) and does not run
--   * per-org rate limit: past private.automation_hourly_run_limit() (1,000) runs started in an hour, new runs are
--     recorded Skipped (rate_limited)
--   * the worker API (service role): app.begin_automation_run checks, fail closed, that the owner still belongs to the
--     org and holds org.automations.write, else the run fails and the automation pauses with a notice;
--     app.record_automation_step and app.finish_automation_run write the ledger and settle the job
--   * the run-scoped operations the notify and call_webhook actions call through the public API as the owner:
--     app.send_automation_notice and app.queue_automation_webhook (which reuses the signed webhook deliveries of 0510)
--   * app.retry_automation_run: queues a failed run again from its failed step
-- The worker (supabase/functions/automation-run, packages/data/src/automation-runner.ts) never writes domain rows with
-- the service role: every action is a public API call with a short-lived token for the owner, so row level security and
-- capabilities decide (ADR 0047).

-- Enums ---------------------------------------------------------------------------------------------------------------

create type app.automation_run_status as enum ('Queued', 'Running', 'Retrying', 'Succeeded', 'Failed', 'Skipped');
comment on type app.automation_run_status is 'Run status of an automation run (a run status, not a lifecycle; ADR 0002): Queued, Running, Retrying after a failure the job queue retries, Succeeded, Failed, or Skipped (not run: loop protection, rate limit, or the automation was off).';

create type app.automation_step_status as enum ('Succeeded', 'Failed', 'Skipped');
comment on type app.automation_step_status is 'Outcome of one action of an automation run. Skipped means there was nothing to do, such as a record already in the target state.';

-- Limits --------------------------------------------------------------------------------------------------------------

create or replace function private.automation_max_depth()
returns smallint
language sql
immutable
set search_path = ''
as $$
  select 3::smallint;
$$;

comment on function private.automation_max_depth() is 'Deepest run an automation-caused event may start (ADR 0047): a run started by a person''s event is depth 0, a run started by an event its action caused is one deeper; deeper runs are Skipped (loop_depth).';

create or replace function private.automation_hourly_run_limit()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 1000;
$$;

comment on function private.automation_hourly_run_limit() is 'Runs an org may start in an hour (ADR 0047); further runs are recorded Skipped (rate_limited).';

-- Runs ----------------------------------------------------------------------------------------------------------------

create table app.automation_runs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  automation_id uuid not null references app.automations (id),
  domain_event_id uuid not null references app.domain_events (id),
  parent_run_id uuid references app.automation_runs (id),
  depth smallint not null default 0,
  run_status app.automation_run_status not null default 'Queued',
  event_payload jsonb not null,
  owner_person_id uuid references app.people (id),
  job_id uuid references app.job_queue (id),
  attempts smallint not null default 0,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  constraint automation_runs_depth check (depth >= 0),
  constraint automation_runs_event_object check (jsonb_typeof(event_payload) = 'object'),
  constraint automation_runs_attempts check (attempts >= 0),
  constraint automation_runs_error_code_format check (error_code is null or error_code ~ '^[a-z][a-z0-9_]*$'),
  constraint automation_runs_error_message_length check (error_message is null or char_length(error_message) <= 2000),
  constraint automation_runs_finished check ((finished_at is not null) = (run_status in ('Succeeded', 'Failed', 'Skipped'))),
  constraint automation_runs_duration check (duration_ms is null or duration_ms >= 0)
);

call private.install_domain_table('app.automation_runs', 'app.automations', 'automation_id',
  array['app.domain_events', 'domain_event_id', 'app.automation_runs', 'parent_run_id', 'app.job_queue', 'job_id']);
create unique index automation_runs_event_key on app.automation_runs (automation_id, domain_event_id);
create index automation_runs_org_created_idx on app.automation_runs (org_id, created_at);
create index automation_runs_automation_created_idx on app.automation_runs (automation_id, created_at desc);
create index automation_runs_domain_event_id_idx on app.automation_runs (domain_event_id);
create index automation_runs_parent_run_id_idx on app.automation_runs (parent_run_id);
create index automation_runs_owner_person_id_idx on app.automation_runs (owner_person_id);
create index automation_runs_job_id_idx on app.automation_runs (job_id);

call private.describe('app.automation_runs', 'The automation runs ledger (Section 7.3, ADR 0047): one run per automation and domain event, so an event never runs an automation twice. Written by the fan-out trigger and the worker RPCs only; readable by holders of org.automations.write.', array[
  'automation_id', 'Automation that ran.',
  'domain_event_id', 'Domain event that started the run.',
  'parent_run_id', 'Run whose action raised the event, when an automation caused it.',
  'depth', 'How many automation runs led to this one: 0 for an event a person or the system raised.',
  'run_status', 'Queued, Running, Retrying, Succeeded, Failed or Skipped.',
  'event_payload', 'The event as webhooks send it (id, type, occurred_at, project_id, subject, data): the run''s input, a provider payload (ADR 0002).',
  'owner_person_id', 'Person the run acted as, set when it started.',
  'job_id', 'automation.run job that carries the run and its retries.',
  'attempts', 'Times the worker started the run.',
  'error_code', 'Rule code of the failure or skip, such as owner_left_org, loop_depth or rate_limited.',
  'error_message', 'Why the run failed or was skipped, in words.',
  'started_at', 'When the worker first started the run.',
  'finished_at', 'When the run reached Succeeded, Failed or Skipped.',
  'duration_ms', 'Milliseconds from the first start to the end.'
]);

call private.install_policies('app.automation_runs',
  $$org_id in (select private.orgs_with_capability('org.automations.write'))$$);

create table app.automation_run_steps (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  automation_run_id uuid not null references app.automation_runs (id),
  automation_action_id uuid references app.automation_actions (id),
  position smallint not null,
  action_type app.automation_action_type not null,
  operation_id text,
  step_status app.automation_step_status not null,
  request_body jsonb,
  response_body jsonb,
  http_status smallint,
  error_code text,
  error_message text,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  duration_ms integer not null,
  constraint automation_run_steps_position check (position between 1 and 10),
  constraint automation_run_steps_operation_format check (operation_id is null or operation_id ~ '^[a-z][A-Za-z]*\.[a-z][A-Za-z]*$'),
  constraint automation_run_steps_error_code_format check (error_code is null or error_code ~ '^[a-z][a-z0-9_]*$'),
  constraint automation_run_steps_error_message_length check (error_message is null or char_length(error_message) <= 2000),
  constraint automation_run_steps_http_status check (http_status is null or http_status between 100 and 599),
  constraint automation_run_steps_duration check (duration_ms >= 0),
  constraint automation_run_steps_window check (finished_at >= started_at)
);

call private.install_domain_table('app.automation_run_steps', 'app.automation_runs', 'automation_run_id',
  array['app.automation_actions', 'automation_action_id']);
create unique index automation_run_steps_position_key on app.automation_run_steps (automation_run_id, position);
create index automation_run_steps_automation_action_id_idx on app.automation_run_steps (automation_action_id);

call private.describe('app.automation_run_steps', 'One action of an automation run (ADR 0047): the public API operation called as the owner, what was sent and answered, and how long it took. A retried run rewrites the step of the action that failed; finished steps are not run again.', array[
  'automation_run_id', 'Run the step belongs to.',
  'automation_action_id', 'Action the step ran, as it was defined when the run started.',
  'position', 'Position of the action in the automation, 1 first.',
  'action_type', 'What the action does.',
  'operation_id', 'Public API operation called, such as records.create.',
  'step_status', 'Succeeded, Failed or Skipped.',
  'request_body', 'Body sent to the operation, with templates filled in from the event: a provider payload (ADR 0002).',
  'response_body', 'Answer of the operation, trimmed to its identifying fields or the problem it reported: a provider payload.',
  'http_status', 'HTTP status the API answered; null when no answer arrived.',
  'error_code', 'Rule code of the failure, such as the API refusal rule.',
  'error_message', 'Why the step failed, in words.',
  'started_at', 'When the step started.',
  'finished_at', 'When the step ended.',
  'duration_ms', 'Milliseconds the step took.'
]);

call private.install_policies('app.automation_run_steps',
  $$org_id in (select private.orgs_with_capability('org.automations.write'))$$);

insert into private.job_kinds (code, subject_table, max_attempts, description) values
  ('automation.run', 'app.automation_runs', 5, 'Runs an automation''s actions for one domain event, as the automation''s owner, through the public API.');

-- Fan-out -------------------------------------------------------------------------------------------------------------

create or replace function private.automation_event_body(p_event app.domain_events)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('id', p_event.id, 'type', p_event.event_type, 'occurred_at', p_event.occurred_at,
    'project_id', p_event.project_id, 'subject', jsonb_build_object('table', p_event.subject_table, 'id', p_event.subject_id),
    'data', p_event.data);
$$;

comment on function private.automation_event_body(app.domain_events) is 'A domain event as automations see it: the body webhooks send (private.webhook_body), as JSON.';

create or replace function private.automation_cause_run_id()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_claim text;
begin
  v_claim := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'xos_automation_run_id';
  if v_claim ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v_claim::uuid;
  end if;
  return null;
exception when others then
  return null;
end;
$$;

comment on function private.automation_cause_run_id() is 'The automation run whose action is making the current request: the xos_automation_run_id claim the worker signs into the owner''s short-lived token (ADR 0047), or null for any other session.';

create or replace function private.fan_out_automations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cause uuid;
  v_parent uuid;
  v_depth smallint := 0;
  v_event jsonb;
  v_automation uuid;
  v_run uuid;
  v_status app.automation_run_status;
  v_code text;
  v_message text;
  v_recent integer;
begin
  if not exists (select 1 from app.automations a where a.org_id = new.org_id and a.trigger_event_type = new.event_type
                 and a.enabled and a.deleted_at is null) then
    return null;
  end if;
  if not private.org_has_feature(new.org_id, 'automations') or private.org_read_only(new.org_id) then
    return null;
  end if;
  v_cause := private.automation_cause_run_id();
  if v_cause is not null then
    select r.id, r.depth + 1 into v_parent, v_depth from app.automation_runs r where r.id = v_cause and r.org_id = new.org_id;
    v_depth := coalesce(v_depth, 0);
  end if;
  v_event := private.automation_event_body(new);
  for v_automation in
    select a.id from app.automations a
    where a.org_id = new.org_id and a.trigger_event_type = new.event_type and a.enabled and a.deleted_at is null
    order by a.id
  loop
    if not private.automation_conditions_match(private.automation_conditions_doc(v_automation), v_event) then
      continue;
    end if;
    if v_recent is null then
      select count(*)::integer into v_recent from app.automation_runs r
      where r.org_id = new.org_id and r.created_at > now() - interval '1 hour' and r.run_status <> 'Skipped';
    end if;
    v_status := 'Queued';
    v_code := null;
    v_message := null;
    if v_depth > private.automation_max_depth() then
      v_status := 'Skipped';
      v_code := 'loop_depth';
      v_message := format('Automations caused this event %s runs deep, past the limit of %s, so it did not run again.',
        v_depth, private.automation_max_depth());
    elsif v_recent >= private.automation_hourly_run_limit() then
      v_status := 'Skipped';
      v_code := 'rate_limited';
      v_message := format('The organization started %s automation runs in the past hour, the limit, so this one did not run.',
        private.automation_hourly_run_limit());
    end if;
    v_run := null;
    insert into app.automation_runs (org_id, automation_id, domain_event_id, parent_run_id, depth, run_status, event_payload,
      error_code, error_message, finished_at, duration_ms)
    values (new.org_id, v_automation, new.id, v_parent, v_depth, v_status, v_event, v_code, v_message,
      case when v_status = 'Skipped' then now() end, case when v_status = 'Skipped' then 0 end)
    on conflict (automation_id, domain_event_id) do nothing
    returning id into v_run;
    if v_run is not null and v_status = 'Queued' then
      update app.automation_runs set job_id = private.enqueue_job(new.org_id, 'automation.run', v_run) where id = v_run;
      v_recent := v_recent + 1;
    end if;
  end loop;
  return null;
end;
$$;

comment on function private.fan_out_automations() is 'After insert trigger on app.domain_events (ADR 0047): for each enabled automation of the org with the event''s type as trigger whose conditions hold, records one run (idempotent per event) and queues an automation.run job. Runs too deep in an automation-caused chain, or past the org''s hourly limit, are recorded Skipped. Orgs without the automations feature, or read-only, start nothing.';

create trigger t88_fan_out_automations after insert on app.domain_events
  for each row execute function private.fan_out_automations();

-- Settling, notices and pausing ---------------------------------------------------------------------------------------

create or replace function private.automation_managers(p_org_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.person_id from app.memberships m
  where m.org_id = p_org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    and private.person_capability_reach(m.person_id, p_org_id, 'org.automations.write', true) = 'organization';
$$;

comment on function private.automation_managers(uuid) is 'Active members who hold org.automations.write org-wide: who hears that an automation paused.';

create or replace function private.settle_automation_run(p_run_id uuid, p_status app.automation_run_status, p_code text,
  p_message text, p_notify boolean default false)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.automation_runs;
  v_automation app.automations;
begin
  update app.automation_runs set
    run_status = p_status,
    error_code = p_code,
    error_message = left(p_message, 2000),
    finished_at = case when p_status in ('Succeeded', 'Failed', 'Skipped') then now() end,
    duration_ms = case when p_status in ('Succeeded', 'Failed', 'Skipped')
      then coalesce(greatest((extract(epoch from now() - started_at) * 1000)::integer, 0), 0) end
  where id = p_run_id
  returning * into v_run;
  if p_notify and p_status = 'Failed' then
    -- A failure tells the owner at most once an hour per automation.
    update app.automations set failure_notified_at = now()
    where id = v_run.automation_id and (failure_notified_at is null or failure_notified_at < now() - interval '1 hour')
    returning * into v_automation;
    if v_automation.id is not null and private.automation_member_active(v_run.org_id, v_automation.owner_person_id) then
      perform private.notify(v_run.org_id, v_automation.owner_person_id, 'automation.failed', 'automations', v_automation.id, null,
        jsonb_build_object('automationName', v_automation.name, 'error', coalesce(left(p_message, 300), p_code, '')));
    end if;
  end if;
end;
$$;

comment on function private.settle_automation_run(uuid, app.automation_run_status, text, text, boolean) is 'Sets a run''s status with its error, end time and duration. A failure with p_notify tells the owner (automation.failed), at most once an hour per automation.';

create or replace function private.pause_automation(p_automation_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_automation app.automations;
  v_owner_name text;
  v_person uuid;
begin
  update app.automations set enabled = false, paused_at = now(), pause_reason = p_reason
  where id = p_automation_id and deleted_at is null and paused_at is null
  returning * into v_automation;
  if v_automation.id is null then
    return;
  end if;
  v_owner_name := (select p.full_name from app.people p where p.id = v_automation.owner_person_id);
  for v_person in
    select private.automation_managers(v_automation.org_id)
    union
    select v_automation.owner_person_id where private.automation_member_active(v_automation.org_id, v_automation.owner_person_id)
  loop
    perform private.notify(v_automation.org_id, v_person, 'automation.paused', 'automations', v_automation.id, null,
      jsonb_build_object('automationName', v_automation.name, 'ownerName', coalesce(v_owner_name, ''), 'reason', p_reason));
  end loop;
end;
$$;

comment on function private.pause_automation(uuid, text) is 'Fail closed (ADR 0047): turns an automation off with the reason and tells the org''s automation managers and the owner, if still a member (automation.paused). Turning it on again, by someone who may, makes them the owner.';

-- The worker API (service role) ---------------------------------------------------------------------------------------

create or replace function private.finish_automation_job(p_job_id uuid, p_succeeded boolean, p_error text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_job_id is null or not exists (select 1 from app.job_queue j where j.id = p_job_id and j.job_status = 'Running') then
    return;
  end if;
  if p_succeeded then
    perform app.finish_job(p_job_id, true);
  else
    -- A failure retrying cannot fix ends the job now; app.finish_job would retry it.
    update app.job_queue set job_status = 'Failed', finished_at = now(), locked_by = null, locked_at = null,
      last_error = left(coalesce(p_error, 'Failed without an error message.'), 2000)
    where id = p_job_id;
  end if;
end;
$$;

comment on function private.finish_automation_job(uuid, boolean, text) is 'Ends an automation.run job: done, or failed for good when no retry can help (a refusal, a lost owner).';

create or replace function app.begin_automation_run(p_run_id uuid, p_job_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.automation_runs;
  v_automation app.automations;
  v_user uuid;
  v_reason text;
  v_message text;
begin
  select * into v_run from app.automation_runs where id = p_run_id for update;
  if v_run.id is null then
    perform private.finish_automation_job(p_job_id, true, null);
    return jsonb_build_object('outcome', 'missing');
  end if;
  if v_run.run_status not in ('Queued', 'Retrying', 'Running') then
    perform private.finish_automation_job(p_job_id, true, null);
    return jsonb_build_object('outcome', 'settled', 'run_status', v_run.run_status);
  end if;
  select * into v_automation from app.automations where id = v_run.automation_id;
  if v_automation.deleted_at is not null or not v_automation.enabled then
    v_reason := 'automation_off';
    v_message := 'The automation was turned off or deleted before the run started.';
  elsif not private.org_has_feature(v_run.org_id, 'automations') then
    v_reason := 'plan_feature_required';
    v_message := 'Automations need the Pro plan or above.';
  elsif private.org_read_only(v_run.org_id) then
    v_reason := 'org_read_only';
    v_message := 'The organization is read-only.';
  end if;
  if v_reason is not null then
    perform private.settle_automation_run(v_run.id, 'Skipped', v_reason, v_message);
    perform private.finish_automation_job(p_job_id, true, null);
    return jsonb_build_object('outcome', 'skipped', 'error_code', v_reason);
  end if;

  -- Fail closed: the owner must still belong to the org, hold org.automations.write and be able to sign in.
  if not private.automation_member_active(v_run.org_id, v_automation.owner_person_id) then
    v_reason := 'owner_left_org';
    v_message := 'The person this automation runs as is no longer a member of the organization.';
  elsif private.person_capability_reach(v_automation.owner_person_id, v_run.org_id, 'org.automations.write', true) is null then
    v_reason := 'owner_lost_capability';
    v_message := 'The person this automation runs as can no longer manage automations.';
  else
    v_user := (select p.user_id from app.people p where p.id = v_automation.owner_person_id);
    if v_user is null then
      v_reason := 'owner_cannot_sign_in';
      v_message := 'The person this automation runs as has no sign-in.';
    end if;
  end if;
  if v_reason is not null then
    update app.automation_runs set owner_person_id = v_automation.owner_person_id, attempts = attempts + 1 where id = v_run.id;
    perform private.settle_automation_run(v_run.id, 'Failed', v_reason, v_message);
    perform private.pause_automation(v_automation.id, v_reason);
    perform private.finish_automation_job(p_job_id, false, v_message);
    return jsonb_build_object('outcome', 'refused', 'error_code', v_reason);
  end if;

  update app.automation_runs set run_status = 'Running', started_at = coalesce(started_at, now()), attempts = attempts + 1,
    owner_person_id = v_automation.owner_person_id, job_id = coalesce(p_job_id, job_id), error_code = null, error_message = null
  where id = v_run.id;
  return jsonb_build_object(
    'outcome', 'run',
    'run_id', v_run.id,
    'org_id', v_run.org_id,
    'automation_id', v_automation.id,
    'automation_name', v_automation.name,
    'owner_person_id', v_automation.owner_person_id,
    'owner_user_id', v_user,
    'depth', v_run.depth,
    'event', v_run.event_payload,
    'actions', (
      select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'position', a.position, 'action_id', a.id, 'type', a.action_type::text, 'title', a.title_template, 'body', a.body_template,
        'project_id', a.project_id, 'phase_code', a.phase_code, 'xyz', a.xyz::text,
        'due_at', case when a.due_in_days is not null then
          ((private.org_today(v_run.org_id) + a.due_in_days)::timestamp + time '17:00') at time zone private.org_time_zone(v_run.org_id) end,
        'to_state', a.to_state, 'assignee_person_id', a.assignee_person_id, 'recipient_person_id', a.recipient_person_id,
        'webhook_endpoint_id', a.webhook_endpoint_id)) order by a.position), '[]'::jsonb)
      from app.automation_actions a where a.automation_id = v_automation.id and a.deleted_at is null),
    'completed', (
      select coalesce(jsonb_agg(s.position order by s.position), '[]'::jsonb)
      from app.automation_run_steps s where s.automation_run_id = v_run.id and s.step_status in ('Succeeded', 'Skipped')));
end;
$$;

comment on function app.begin_automation_run(uuid, uuid) is 'Worker API (service role): starts a claimed run. Returns outcome run with what the worker needs (the owner''s user id to mint a short-lived token for, the event, the actions in order with due dates on the org''s calendar, and the positions already done), or settles the run first: skipped when the automation is off, the plan lacks the feature or the org is read-only; refused, failing the run and pausing the automation with a notice, when the owner left the org or lost org.automations.write (fail closed, ADR 0047).';

create or replace function app.record_automation_step(
  p_run_id uuid,
  p_position smallint,
  p_action_id uuid,
  p_action_type app.automation_action_type,
  p_operation_id text,
  p_step_status app.automation_step_status,
  p_request_body jsonb,
  p_response_body jsonb,
  p_http_status smallint,
  p_error_code text,
  p_error_message text,
  p_started_at timestamptz,
  p_duration_ms integer
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from app.automation_runs r where r.id = p_run_id and r.run_status = 'Running') then
    perform private.refuse('automation_run_not_running', 'Only a running automation run records its steps.');
  end if;
  insert into app.automation_run_steps (automation_run_id, automation_action_id, position, action_type, operation_id, step_status,
    request_body, response_body, http_status, error_code, error_message, started_at, finished_at, duration_ms)
  values (p_run_id, p_action_id, p_position, p_action_type, p_operation_id, p_step_status, p_request_body, p_response_body,
    p_http_status, p_error_code, left(p_error_message, 2000), p_started_at,
    p_started_at + make_interval(secs => greatest(coalesce(p_duration_ms, 0), 0) / 1000.0), greatest(coalesce(p_duration_ms, 0), 0))
  on conflict (automation_run_id, position) do update set
    automation_action_id = excluded.automation_action_id, action_type = excluded.action_type, operation_id = excluded.operation_id,
    step_status = excluded.step_status, request_body = excluded.request_body, response_body = excluded.response_body,
    http_status = excluded.http_status, error_code = excluded.error_code, error_message = excluded.error_message,
    started_at = excluded.started_at, finished_at = excluded.finished_at, duration_ms = excluded.duration_ms
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.record_automation_step(uuid, smallint, uuid, app.automation_action_type, text, app.automation_step_status, jsonb, jsonb, smallint, text, text, timestamptz, integer) is 'Worker API (service role): records one action of a running run; a retried action rewrites its step.';

create or replace function app.finish_automation_run(p_run_id uuid, p_job_id uuid, p_outcome text, p_error_code text default null,
  p_error_message text default null)
returns app.automation_run_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.automation_runs;
  v_job app.job_status;
begin
  select * into v_run from app.automation_runs where id = p_run_id for update;
  if v_run.id is null or v_run.run_status <> 'Running' then
    perform private.refuse('automation_run_not_running', 'Only a running automation run can be finished.');
  end if;
  case p_outcome
    when 'succeeded' then
      perform private.settle_automation_run(p_run_id, 'Succeeded', null, null);
      perform private.finish_automation_job(p_job_id, true, null);
      return 'Succeeded';
    when 'retry' then
      -- The job queue decides: another attempt after its backoff, or Failed when the attempts are used.
      if p_job_id is not null and exists (select 1 from app.job_queue j where j.id = p_job_id and j.job_status = 'Running') then
        v_job := app.finish_job(p_job_id, false, coalesce(p_error_message, p_error_code));
      end if;
      if v_job = 'Queued' then
        update app.automation_runs set run_status = 'Retrying', error_code = p_error_code, error_message = left(p_error_message, 2000)
        where id = p_run_id;
        return 'Retrying';
      end if;
      perform private.settle_automation_run(p_run_id, 'Failed', p_error_code, p_error_message, true);
      return 'Failed';
    when 'failed' then
      perform private.settle_automation_run(p_run_id, 'Failed', p_error_code, p_error_message, true);
      perform private.finish_automation_job(p_job_id, false, p_error_message);
      return 'Failed';
    when 'refused' then
      -- The API refused the owner's credential or access: fail closed and pause.
      perform private.settle_automation_run(p_run_id, 'Failed', coalesce(p_error_code, 'owner_access_refused'), p_error_message);
      perform private.pause_automation(v_run.automation_id, coalesce(p_error_code, 'owner_access_refused'));
      perform private.finish_automation_job(p_job_id, false, p_error_message);
      return 'Failed';
    else
      perform private.refuse('automation_outcome_unknown', 'An outcome is succeeded, retry, failed or refused.');
  end case;
  return null;
end;
$$;

comment on function app.finish_automation_run(uuid, uuid, text, text, text) is 'Worker API (service role): settles a running run. succeeded ends it and its job; retry hands the failure to the job queue''s backoff (Retrying), failing the run once the attempts are used; failed ends it for good and tells the owner (at most hourly); refused, when the API refused the owner''s credential or access, fails it and pauses the automation with a notice.';

-- Run-scoped operations the actions call as the owner -----------------------------------------------------------------

create or replace function private.owned_running_automation_run(p_run_id uuid)
returns app.automation_runs
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_run app.automation_runs;
begin
  select r.* into v_run from app.automation_runs r
  join app.automations a on a.id = r.automation_id
  where r.id = p_run_id and r.run_status = 'Running' and a.owner_person_id = private.current_person_id();
  if v_run.id is null or not private.has_capability(v_run.org_id, 'org.automations.write') then
    raise exception using errcode = '42501', message = 'automation run not found';
  end if;
  return v_run;
end;
$$;

comment on function private.owned_running_automation_run(uuid) is 'A running automation run whose automation the signed-in person owns and may still manage; anything else is not found.';

create or replace function app.send_automation_notice(p_run_id uuid, p_recipient_person_id uuid, p_title text, p_body text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.automation_runs := private.owned_running_automation_run(p_run_id);
  v_name text := (select a.name from app.automations a where a.id = v_run.automation_id);
  v_subject_id text := v_run.event_payload -> 'subject' ->> 'id';
  v_project text := v_run.event_payload ->> 'project_id';
begin
  if not private.automation_member_active(v_run.org_id, p_recipient_person_id) then
    perform private.refuse('automation_person_not_member', 'Notify a member of this organization.');
  end if;
  if p_title is null or char_length(btrim(p_title)) not between 1 and 200 then
    perform private.refuse('automation_notice_title', 'A notification title is 1 to 200 characters.');
  end if;
  if p_body is not null and char_length(btrim(p_body)) > 2000 then
    perform private.refuse('automation_notice_body', 'A notification message is at most 2,000 characters.');
  end if;
  return private.notify(v_run.org_id, p_recipient_person_id, 'automation.notice',
    case when v_subject_id is not null then v_run.event_payload -> 'subject' ->> 'table' end,
    v_subject_id::uuid,
    case when exists (select 1 from app.projects p where p.id::text = v_project) then v_project::uuid end,
    jsonb_build_object('automationName', v_name, 'title', btrim(p_title), 'body', coalesce(nullif(btrim(p_body), ''), btrim(p_title))));
end;
$$;

comment on function app.send_automation_notice(uuid, uuid, text, text) is 'The notify action (automationRuns.notify, ADR 0047): during a run, its automation''s owner notifies a member of the org (automation.notice) about the event''s subject. Needs org.automations.write; the run must be running.';

create or replace function app.queue_automation_webhook(p_run_id uuid, p_webhook_endpoint_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.automation_runs := private.owned_running_automation_run(p_run_id);
  v_endpoint app.webhook_endpoints;
  v_id uuid;
begin
  if not private.has_capability(v_run.org_id, 'org.webhooks.manage') then
    raise exception using errcode = '42501', message = 'webhook endpoint not found';
  end if;
  if not private.org_has_feature(v_run.org_id, 'webhooks') then
    perform private.refuse('plan_feature_required', 'Webhooks need the Pro plan or above.');
  end if;
  select * into v_endpoint from app.webhook_endpoints e
  where e.id = p_webhook_endpoint_id and e.org_id = v_run.org_id and e.deleted_at is null;
  if v_endpoint.id is null then
    perform private.refuse('automation_webhook_unknown', 'Choose one of this organization''s webhook endpoints.');
  end if;
  if v_endpoint.disabled_at is not null then
    perform private.refuse('automation_webhook_disabled', 'The webhook endpoint is turned off.');
  end if;
  insert into app.webhook_deliveries (webhook_endpoint_id, domain_event_id)
  values (v_endpoint.id, v_run.domain_event_id)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.queue_automation_webhook(uuid, uuid) is 'The call_webhook action (automationRuns.deliverWebhook, ADR 0047): during a run, its owner queues a delivery of the run''s event to one of the org''s webhook endpoints. The 0510 dispatcher signs and retries it like every webhook. Needs org.automations.write, org.webhooks.manage and the webhooks plan feature.';

create or replace function app.retry_automation_run(p_run_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.automation_runs;
  v_automation app.automations;
begin
  select * into v_run from app.automation_runs where id = p_run_id;
  if v_run.id is null or not private.has_capability(v_run.org_id, 'org.automations.write') then
    raise exception using errcode = '42501', message = 'automation run not found';
  end if;
  if v_run.run_status <> 'Failed' then
    perform private.refuse('automation_run_not_failed', 'Only a failed run can be retried.');
  end if;
  select * into v_automation from app.automations where id = v_run.automation_id;
  if v_automation.deleted_at is not null or not v_automation.enabled then
    perform private.refuse('automation_off', 'Turn the automation on before retrying its runs.');
  end if;
  if not private.org_has_feature(v_run.org_id, 'automations') then
    perform private.refuse('plan_feature_required', 'Automations need the Pro plan or above.');
  end if;
  update app.automation_runs set run_status = 'Queued', error_code = null, error_message = null, finished_at = null,
    duration_ms = null, job_id = private.enqueue_job(v_run.org_id, 'automation.run', v_run.id)
  where id = p_run_id;
  return p_run_id;
end;
$$;

comment on function app.retry_automation_run(uuid) is 'Queues a failed run again (automationRuns.retry). Steps that succeeded are not run again. Needs org.automations.write, the automation on and the automations plan feature.';

-- Retention -------------------------------------------------------------------------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.automation_runs', 'Age', 'created_at', interval '1 year', 'Delete', 'Run history kept a year, within the 25 months of the events that started the runs.'),
  ('app.automation_run_steps', 'Age', 'created_at', interval '1 year', 'Delete', 'Kept as long as their run.');

-- Privileges ------------------------------------------------------------------------------------------------------------

revoke all on function private.automation_max_depth() from public, anon, authenticated;
revoke all on function private.automation_hourly_run_limit() from public, anon, authenticated;
revoke all on function private.automation_event_body(app.domain_events) from public, anon, authenticated;
revoke all on function private.automation_cause_run_id() from public, anon, authenticated;
revoke all on function private.fan_out_automations() from public, anon, authenticated;
revoke all on function private.automation_managers(uuid) from public, anon, authenticated;
revoke all on function private.settle_automation_run(uuid, app.automation_run_status, text, text, boolean) from public, anon, authenticated;
revoke all on function private.pause_automation(uuid, text) from public, anon, authenticated;
revoke all on function private.finish_automation_job(uuid, boolean, text) from public, anon, authenticated;
revoke all on function private.owned_running_automation_run(uuid) from public, anon, authenticated;

revoke all on function app.begin_automation_run(uuid, uuid) from public, anon, authenticated;
grant execute on function app.begin_automation_run(uuid, uuid) to service_role;
revoke all on function app.record_automation_step(uuid, smallint, uuid, app.automation_action_type, text, app.automation_step_status, jsonb, jsonb, smallint, text, text, timestamptz, integer) from public, anon, authenticated;
grant execute on function app.record_automation_step(uuid, smallint, uuid, app.automation_action_type, text, app.automation_step_status, jsonb, jsonb, smallint, text, text, timestamptz, integer) to service_role;
revoke all on function app.finish_automation_run(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function app.finish_automation_run(uuid, uuid, text, text, text) to service_role;

revoke all on function app.send_automation_notice(uuid, uuid, text, text) from public, anon;
grant execute on function app.send_automation_notice(uuid, uuid, text, text) to authenticated;
revoke all on function app.queue_automation_webhook(uuid, uuid) from public, anon;
grant execute on function app.queue_automation_webhook(uuid, uuid) to authenticated;
revoke all on function app.retry_automation_run(uuid) from public, anon;
grant execute on function app.retry_automation_run(uuid) to authenticated;
