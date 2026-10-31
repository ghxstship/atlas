-- 2340_workflow_funnels.sql
-- A146 (RRR-178), trace row S11.14-03, finding A65-022, Section 11.14 ("Consent-gated product analytics track the funnel
-- for each workflow in Sections 11.11 to 11.13 against its target. Regressions alert the owning team."), ADR 0052
-- amended. A96's pipeline (1532) records Workflow Started, Workflow Step and Workflow Completed events; this defines the
-- funnel of each workflow, checks it every hour and raises an alert in the operator console when it regresses. Nothing
-- leaves the database: no outside alerting service, and an alert names a workflow, never a person or an org.
--   * private.product_funnels: the funnel of each of the 26 workflows of private.product_workflows (1532): the team
--     that owns it, how many steps lie between its start and its completion, its target completion rate (the share of
--     started sessions that complete), how far below its own last week it may fall, and how many started sessions an
--     hour's check needs before it judges. The browser registry (packages/data/src/product-workflows.ts) names the same
--     funnels; a unit test holds the two together.
--   * private.product_funnel_stages: a funnel's stages over a window, as app.product_funnel_hourly counts them: distinct
--     sessions per hourly bucket, summed over the window's hours.
--   * private.product_funnel_reading: the last 24 hours against the target and against the 7 days before them.
--   * app.product_funnel_alerts: one open alert per regressed workflow, with the figures that raised it; resolved by the
--     check once the funnel recovers. Platform staff read it; the console acknowledges it.
--   * private.check_product_funnels: hourly (xos_check_product_funnels), raises, refreshes and resolves alerts.
--   * app.console_product_funnels and app.console_acknowledge_funnel_alert: the console's Funnels page, for operators
--     holding tenants.read (every operator role, as A137's platform metrics). Acknowledging writes the console ledger.
-- Hours are instants (date_bin over UTC), as app.product_funnel_hourly buckets them; no calendar day is involved.

-- 1. The funnels -------------------------------------------------------------------------------------------------------

create table private.product_funnels (
  workflow_code text primary key references private.product_workflows (code),
  owning_team text not null,
  steps smallint not null,
  target_completion numeric(4, 3) not null,
  regression_drop numeric(4, 3) not null default 0.25,
  min_started_sessions integer not null default 20,
  constraint product_funnels_owning_team check (owning_team in ('Projects', 'Work', 'Schedule', 'Show', 'Advancing',
    'Crew', 'Finance', 'Procurement', 'Safety', 'Reports', 'Platform', 'Marketplace', 'Onboarding', 'Engagements',
    'Payments', 'Profiles', 'Messaging', 'Field')),
  constraint product_funnels_steps check (steps between 1 and 10),
  constraint product_funnels_target check (target_completion > 0 and target_completion <= 1),
  constraint product_funnels_regression_drop check (regression_drop > 0 and regression_drop < 1),
  constraint product_funnels_min_started check (min_started_sessions >= 1)
);

comment on table private.product_funnels is 'The funnel of each Sections 11.11 to 11.13 workflow (A146, 2340): Workflow Started, Workflow Step 1 to steps, Workflow Completed, with the team that owns it and its target. private.check_product_funnels judges it hourly. Mirrors packages/data/src/product-workflows.ts.';
comment on column private.product_funnels.workflow_code is 'Workflow of private.product_workflows (1532), app.name.';
comment on column private.product_funnels.owning_team is 'Team that owns the workflow and is alerted when its funnel regresses.';
comment on column private.product_funnels.steps is 'Steps between the start and the completion, numbered from 1 in Workflow Step events.';
comment on column private.product_funnels.target_completion is 'Target completion rate: the share of started sessions that complete, from 0 to 1.';
comment on column private.product_funnels.regression_drop is 'How far, as a share of its own rate, the last 24 hours may fall below the 7 days before them before it counts as a regression.';
comment on column private.product_funnels.min_started_sessions is 'Started sessions a window needs before the check judges it; fewer means not enough data.';

alter table private.product_funnels enable row level security;
revoke all on private.product_funnels from public, anon, authenticated;
grant select on private.product_funnels to service_role;

insert into private.product_funnels (workflow_code, owning_team, steps, target_completion) values
  ('atlas.projects_gates', 'Projects', 1, 0.600),
  ('atlas.work_records', 'Work', 1, 0.500),
  ('atlas.schedule', 'Schedule', 1, 0.200),
  ('atlas.show', 'Show', 1, 0.700),
  ('atlas.advancing', 'Advancing', 1, 0.300),
  ('atlas.crew', 'Crew', 1, 0.400),
  ('atlas.finance', 'Finance', 1, 0.500),
  ('atlas.procurement', 'Procurement', 1, 0.500),
  ('atlas.safety', 'Safety', 1, 0.800),
  ('atlas.reports', 'Reports', 1, 0.250),
  ('atlas.settings', 'Platform', 1, 0.150),
  ('gateway.discover', 'Marketplace', 1, 0.400),
  ('gateway.apply', 'Marketplace', 1, 0.500),
  ('gateway.onboard', 'Onboarding', 1, 0.600),
  ('gateway.work', 'Engagements', 1, 0.500),
  ('gateway.get_paid', 'Payments', 1, 0.700),
  ('gateway.reputation', 'Profiles', 1, 0.300),
  ('gateway.communicate', 'Messaging', 1, 0.600),
  ('compass.clock', 'Field', 1, 0.900),
  ('compass.tasks', 'Field', 1, 0.700),
  ('compass.scan', 'Field', 1, 0.800),
  ('compass.incidents', 'Safety', 1, 0.800),
  ('compass.inspections', 'Field', 1, 0.800),
  ('compass.show', 'Show', 1, 0.700),
  ('compass.supervisor', 'Field', 1, 0.700),
  ('compass.credentials', 'Field', 1, 0.900);

-- 2. Funnel computation ------------------------------------------------------------------------------------------------

create or replace function private.product_funnel_stages(p_workflow_code text, p_from timestamptz, p_to timestamptz)
returns table (stage smallint, event_name text, step smallint, sessions bigint)
language sql
stable
security definer
set search_path = ''
as $$
  -- The same buckets as app.product_funnel_hourly (distinct sessions per hour), read from the events through
  -- product_events_workflow_idx so the window, not the whole year, is scanned. p_from and p_to are hour boundaries.
  with funnel as (
    select f.steps from private.product_funnels f where f.workflow_code = p_workflow_code
  ),
  stages as (
    select 0::smallint as stage, 'Workflow Started'::text as event_name, null::smallint as step from funnel
    union all
    select s::smallint, 'Workflow Step', s::smallint from funnel, generate_series(1, funnel.steps) s
    union all
    select (funnel.steps + 1)::smallint, 'Workflow Completed', null::smallint from funnel
  ),
  hourly as (
    select date_bin('1 hour', e.occurred_at, timestamptz '2000-01-01 00:00:00+00') as hour_start, e.event_name, e.step,
      count(distinct e.session_key) as sessions
    from app.product_events e
    where e.workflow_code = p_workflow_code and e.occurred_at >= p_from and e.occurred_at < p_to
    group by 1, 2, 3
  )
  select st.stage, st.event_name, st.step, coalesce(sum(h.sessions), 0)::bigint
  from stages st
  left join hourly h on h.event_name = st.event_name and h.step is not distinct from st.step
  group by st.stage, st.event_name, st.step
  order by st.stage;
$$;

comment on function private.product_funnel_stages(text, timestamptz, timestamptz) is 'A workflow''s funnel over [p_from, p_to): its stages in order (0 Workflow Started, 1 to steps Workflow Step, then Workflow Completed) with the distinct sessions of each hourly bucket summed over the window, as app.product_funnel_hourly counts them (A146, 2340).';
revoke all on function private.product_funnel_stages(text, timestamptz, timestamptz) from public, anon, authenticated;

create or replace function private.product_funnel_reading(p_workflow_code text, p_now timestamptz default now())
returns table (
  window_start timestamptz, window_end timestamptz, started_sessions bigint, completed_sessions bigint,
  completion_rate numeric, baseline_started_sessions bigint, baseline_rate numeric, enough_data boolean,
  below_target boolean, below_baseline boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_funnel private.product_funnels;
  v_end timestamptz := date_bin('1 hour', p_now, timestamptz '2000-01-01 00:00:00+00');
  v_start timestamptz := v_end - interval '24 hours';
  v_base_start timestamptz := v_start - interval '7 days';
  v_started bigint;
  v_completed bigint;
  v_base_started bigint;
  v_base_completed bigint;
begin
  select f.* into v_funnel from private.product_funnels f where f.workflow_code = p_workflow_code;
  if v_funnel.workflow_code is null then
    return;
  end if;
  select coalesce(sum(s.sessions) filter (where s.event_name = 'Workflow Started'), 0),
    coalesce(sum(s.sessions) filter (where s.event_name = 'Workflow Completed'), 0)
  into v_started, v_completed
  from private.product_funnel_stages(p_workflow_code, v_start, v_end) s;
  select coalesce(sum(s.sessions) filter (where s.event_name = 'Workflow Started'), 0),
    coalesce(sum(s.sessions) filter (where s.event_name = 'Workflow Completed'), 0)
  into v_base_started, v_base_completed
  from private.product_funnel_stages(p_workflow_code, v_base_start, v_start) s;

  window_start := v_start;
  window_end := v_end;
  started_sessions := v_started;
  completed_sessions := v_completed;
  -- A completion without its start in the hour (a session that started the hour before) can push a rate past 1.
  completion_rate := case when v_started > 0 then least(round(v_completed::numeric / v_started, 4), 1) end;
  baseline_started_sessions := v_base_started;
  baseline_rate := case when v_base_started >= v_funnel.min_started_sessions
    then least(round(v_base_completed::numeric / v_base_started, 4), 1) end;
  enough_data := v_started >= v_funnel.min_started_sessions;
  below_target := enough_data and completion_rate < v_funnel.target_completion;
  below_baseline := enough_data and baseline_rate is not null
    and completion_rate < baseline_rate * (1 - v_funnel.regression_drop);
  return next;
end;
$$;

comment on function private.product_funnel_reading(text, timestamptz) is 'A workflow''s funnel judged at p_now (A146, 2340): the 24 hours before the last hour boundary against its target completion rate and against the 7 days before them. Below baseline means the rate fell by more than the funnel''s regression_drop share of the baseline rate. With fewer started sessions than min_started_sessions nothing is judged.';
revoke all on function private.product_funnel_reading(text, timestamptz) from public, anon, authenticated;

-- 3. Alerts ------------------------------------------------------------------------------------------------------------

create table app.product_funnel_alerts (
  id uuid primary key default private.uuid_v7(),
  workflow_code text not null,
  owning_team text not null,
  raised_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now(),
  window_start timestamptz not null,
  window_end timestamptz not null,
  started_sessions integer not null,
  completed_sessions integer not null,
  completion_rate numeric(5, 4) not null,
  baseline_rate numeric(5, 4),
  target_completion numeric(4, 3) not null,
  below_target boolean not null,
  below_baseline boolean not null,
  acknowledged_at timestamptz,
  acknowledged_by uuid references app.people (id),
  resolved_at timestamptz,
  constraint product_funnel_alerts_workflow_format check (workflow_code ~ '^(atlas|gateway|compass)\.[a-z][a-z_]*$'),
  constraint product_funnel_alerts_regressed check (below_target or below_baseline),
  constraint product_funnel_alerts_window check (window_end > window_start),
  constraint product_funnel_alerts_sessions check (started_sessions >= 0 and completed_sessions >= 0),
  constraint product_funnel_alerts_rates check (completion_rate between 0 and 1 and (baseline_rate is null or baseline_rate between 0 and 1)),
  constraint product_funnel_alerts_acknowledged check ((acknowledged_at is null) = (acknowledged_by is null))
);

create unique index product_funnel_alerts_one_open on app.product_funnel_alerts (workflow_code) where resolved_at is null;
create index product_funnel_alerts_raised_idx on app.product_funnel_alerts (raised_at);
create index product_funnel_alerts_acknowledged_by_idx on app.product_funnel_alerts (acknowledged_by);

call private.describe('app.product_funnel_alerts', 'Regressions of the Sections 11.11 to 11.13 workflow funnels (A146, Section 11.14 "Regressions alert the owning team"): one open alert per workflow whose last 24 hours fell below its target completion rate or well below its own previous 7 days, with the figures that raised it. Raised, refreshed and resolved hourly by private.check_product_funnels; read by platform staff in the operator console, which acknowledges it. Names a workflow and counts, never a person or an org.', array[
  'id', 'Alert id, UUID v7.',
  'workflow_code', 'Workflow whose funnel regressed (private.product_workflows).',
  'owning_team', 'Team that owns the workflow, as private.product_funnels named it when the alert was raised.',
  'raised_at', 'When the hourly check raised the alert.',
  'last_checked_at', 'When the hourly check last found the funnel still regressed.',
  'window_start', 'Start of the 24 hours the latest figures cover.',
  'window_end', 'End of the 24 hours the latest figures cover, an hour boundary.',
  'started_sessions', 'Sessions that started the workflow in the window, summed over its hours.',
  'completed_sessions', 'Sessions that completed the workflow in the window, summed over its hours.',
  'completion_rate', 'Completed over started sessions in the window, from 0 to 1.',
  'baseline_rate', 'Completion rate of the 7 days before the window; null with too few sessions to judge.',
  'target_completion', 'Target completion rate of the funnel when the figures were taken.',
  'below_target', 'The window''s rate is below the target.',
  'below_baseline', 'The window''s rate fell further below the baseline than the funnel allows.',
  'acknowledged_at', 'When an operator acknowledged the alert in the console.',
  'acknowledged_by', 'Operator who acknowledged it.',
  'resolved_at', 'When the hourly check found the funnel recovered; the alert is then closed.'
]);

alter table app.product_funnel_alerts enable row level security;
revoke all on app.product_funnel_alerts from public, anon, authenticated;
grant select on app.product_funnel_alerts to authenticated;
grant all on app.product_funnel_alerts to service_role;
create policy product_funnel_alerts_staff_read on app.product_funnel_alerts for select to authenticated
  using ((select private.is_platform_staff()));

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.product_funnel_alerts', 'Age', 'raised_at', interval '13 months', 'Delete',
   'Alerts are read beside the funnel events they came from, which are kept 13 months.');

-- 4. The hourly check --------------------------------------------------------------------------------------------------

create or replace function private.check_product_funnels(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_funnel private.product_funnels;
  v_reading record;
  v_open uuid;
  v_raised integer := 0;
begin
  for v_funnel in select f.* from private.product_funnels f order by f.workflow_code loop
    select r.* into v_reading from private.product_funnel_reading(v_funnel.workflow_code, p_now) r;
    select a.id into v_open from app.product_funnel_alerts a
    where a.workflow_code = v_funnel.workflow_code and a.resolved_at is null
    for update;
    if v_reading.below_target or v_reading.below_baseline then
      if v_open is null then
        insert into app.product_funnel_alerts (workflow_code, owning_team, raised_at, last_checked_at, window_start,
          window_end, started_sessions, completed_sessions, completion_rate, baseline_rate, target_completion,
          below_target, below_baseline)
        values (v_funnel.workflow_code, v_funnel.owning_team, p_now, p_now, v_reading.window_start, v_reading.window_end,
          v_reading.started_sessions, v_reading.completed_sessions, v_reading.completion_rate, v_reading.baseline_rate,
          v_funnel.target_completion, v_reading.below_target, v_reading.below_baseline);
        v_raised := v_raised + 1;
      else
        update app.product_funnel_alerts set last_checked_at = p_now, window_start = v_reading.window_start,
          window_end = v_reading.window_end, started_sessions = v_reading.started_sessions,
          completed_sessions = v_reading.completed_sessions, completion_rate = v_reading.completion_rate,
          baseline_rate = v_reading.baseline_rate, target_completion = v_funnel.target_completion,
          below_target = v_reading.below_target, below_baseline = v_reading.below_baseline
        where id = v_open;
      end if;
    elsif v_open is not null and v_reading.enough_data then
      -- Recovered: judged with enough sessions and neither below target nor below baseline. A quiet hour with too few
      -- sessions keeps the alert open rather than calling the funnel healthy.
      update app.product_funnel_alerts set resolved_at = p_now, last_checked_at = p_now where id = v_open;
    end if;
  end loop;
  return v_raised;
end;
$$;

comment on function private.check_product_funnels(timestamptz) is 'Hourly (xos_check_product_funnels, A146): judges every workflow funnel at p_now (private.product_funnel_reading). A regressed funnel with no open alert raises one in app.product_funnel_alerts for its owning team, shown in the operator console; one already open is refreshed with the latest figures; an open alert whose funnel recovered with enough sessions is resolved. Never calls an outside service. Returns how many alerts it raised.';
revoke all on function private.check_product_funnels(timestamptz) from public, anon, authenticated;

select cron.schedule('xos_check_product_funnels', '23 * * * *', 'select private.check_product_funnels()');

-- 5. The console -------------------------------------------------------------------------------------------------------

create or replace function app.console_product_funnels()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_result jsonb;
begin
  perform private.require_platform_operator('tenants.read');
  select jsonb_build_object(
    'checkedAt', v_now,
    'funnels', coalesce((
      select jsonb_agg(jsonb_build_object(
          'workflow', f.workflow_code,
          'app', w.app_code,
          'owningTeam', f.owning_team,
          'stepCount', f.steps,
          'targetCompletion', f.target_completion,
          'stages', (select jsonb_agg(s.sessions order by s.stage)
                     from private.product_funnel_stages(f.workflow_code, r.window_start, r.window_end) s),
          'startedSessions', r.started_sessions,
          'completedSessions', r.completed_sessions,
          'completionRate', r.completion_rate,
          'baselineRate', r.baseline_rate,
          'status', case when not r.enough_data then 'Not Enough Data'
                         when r.below_baseline then 'Regressed'
                         when r.below_target then 'Below Target'
                         else 'On Target' end)
        order by w.app_code, f.workflow_code)
      from private.product_funnels f
      join private.product_workflows w on w.code = f.workflow_code
      cross join lateral private.product_funnel_reading(f.workflow_code, v_now) r), '[]'::jsonb),
    'alerts', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', a.id,
          'workflow', a.workflow_code,
          'owningTeam', a.owning_team,
          'raisedAt', a.raised_at,
          'lastCheckedAt', a.last_checked_at,
          'startedSessions', a.started_sessions,
          'completedSessions', a.completed_sessions,
          'completionRate', a.completion_rate,
          'baselineRate', a.baseline_rate,
          'targetCompletion', a.target_completion,
          'belowTarget', a.below_target,
          'belowBaseline', a.below_baseline,
          'acknowledgedAt', a.acknowledged_at,
          'acknowledgedByName', p.full_name,
          'resolvedAt', a.resolved_at)
        order by (a.resolved_at is null) desc, a.raised_at desc)
      from app.product_funnel_alerts a
      left join app.people p on p.id = a.acknowledged_by
      where a.resolved_at is null or a.resolved_at > v_now - interval '30 days'), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

comment on function app.console_product_funnels() is 'Operator console Funnels page (A146): every Sections 11.11 to 11.13 workflow funnel over the last 24 hours (sessions per stage, completion rate, the previous 7 days'' rate, its target and status: On Target, Below Target, Regressed or Not Enough Data), with the open alerts and those resolved in the last 30 days. Counts only, never a person, an org or a path. Operators holding tenants.read (every role).';
revoke all on function app.console_product_funnels() from public, anon;
grant execute on function app.console_product_funnels() to authenticated;

create or replace function app.console_acknowledge_funnel_alert(p_alert_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_platform_operator('tenants.read');
  v_alert app.product_funnel_alerts;
begin
  select a.* into v_alert from app.product_funnel_alerts a where a.id = p_alert_id for update;
  if v_alert.id is null then
    perform private.refuse('funnel_alert_missing', 'The funnel alert does not exist.');
  end if;
  if v_alert.resolved_at is not null then
    perform private.refuse('funnel_alert_resolved', 'The funnel recovered and the alert is closed.');
  end if;
  if v_alert.acknowledged_at is not null then
    return v_alert.id;
  end if;
  update app.product_funnel_alerts set acknowledged_at = now(), acknowledged_by = v_person where id = v_alert.id;
  perform private.log_operator_action('funnel_alert.acknowledge', null, 'app.product_funnel_alerts', v_alert.id, null,
    jsonb_build_object('workflow', v_alert.workflow_code, 'owningTeam', v_alert.owning_team));
  return v_alert.id;
end;
$$;

comment on function app.console_acknowledge_funnel_alert(uuid) is 'Operator console (A146): marks an open funnel alert seen by the signed-in operator and writes funnel_alert.acknowledge to the console ledger. Acknowledging again changes nothing; a resolved alert is refused (funnel_alert_resolved). Operators holding tenants.read.';
revoke all on function app.console_acknowledge_funnel_alert(uuid) from public, anon;
grant execute on function app.console_acknowledge_funnel_alert(uuid) to authenticated;
