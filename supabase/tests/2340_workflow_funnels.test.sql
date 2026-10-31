-- pgTAP: migration 2340, workflow funnels and their regression alerts (A146, RRR-178, trace row S11.14-03). Every
-- workflow of Sections 11.11 to 11.13 has a funnel with a target; a funnel counts distinct sessions per hourly bucket
-- summed over its window; the hourly check raises one alert for the owning team when the last 24 hours fall below the
-- target or well below the 7 days before, refreshes it while the regression lasts and resolves it on recovery, and
-- judges nothing on too few sessions. Only operators read the funnels in the console and acknowledge an alert, which
-- writes the console ledger.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(30);

create function pg_temp.as_op(p_key text, p_aal text default 'aal2') returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', p_aal)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- n sessions, each sending one event of a workflow at an instant (as the platform, past the record RPC's clock rule).
create function pg_temp.sessions(p_workflow text, p_event text, p_step smallint, p_n integer, p_at timestamptz,
  p_first integer default 1) returns void
language sql as $$
  insert into app.product_events (occurred_at, received_at, app_code, event_name, workflow_code, step, session_key)
  select p_at, p_at, initcap(split_part(p_workflow, '.', 1)), p_event, p_workflow, p_step,
    ('00000000-0000-4000-8000-' || lpad(to_hex(abs(hashtext(p_workflow || p_event || coalesce(p_step, 0) || i))), 12, '0'))::uuid
  from generate_series(p_first, p_first + p_n - 1) i
$$;

-- The same n sessions (by number) for every stage, so started and completed sessions are the same people's visits.
create function pg_temp.funnel(p_workflow text, p_started integer, p_stepped integer, p_completed integer,
  p_at timestamptz) returns void
language plpgsql as $$
begin
  insert into app.product_events (occurred_at, received_at, app_code, event_name, workflow_code, step, session_key)
  select p_at, p_at, initcap(split_part(p_workflow, '.', 1)), x.event_name, p_workflow, x.step,
    ('00000000-0000-4000-8000-' || lpad(to_hex(abs(hashtext(p_workflow || p_at::text || i))), 12, '0'))::uuid
  from (values ('Workflow Started', null::smallint, p_started), ('Workflow Step', 1::smallint, p_stepped),
               ('Workflow Completed', null::smallint, p_completed)) as x (event_name, step, n)
  cross join lateral generate_series(1, x.n) i;
end $$;

create temporary table t (key text primary key, at timestamptz not null);
grant select on t to public;
insert into t values
  ('end', date_bin('1 hour', now(), timestamptz '2000-01-01 00:00:00+00')),
  ('current', date_bin('1 hour', now(), timestamptz '2000-01-01 00:00:00+00') - interval '2 hours'),
  ('baseline', date_bin('1 hour', now(), timestamptz '2000-01-01 00:00:00+00') - interval '3 days');
create function pg_temp.at(p_key text) returns timestamptz language sql stable as $$ select at from t where key = p_key $$;

-- Funnels and targets ------------------------------------------------------------------------------------------------
select is_empty($$select w.code from private.product_workflows w
  left join private.product_funnels f on f.workflow_code = w.code where f.workflow_code is null$$,
  'every workflow of Sections 11.11 to 11.13 has a funnel');
select is((select count(*)::int from private.product_funnels where target_completion > 0 and steps >= 1), 29,
  'each with a target completion rate and at least one step');
select is((select count(distinct owning_team)::int from private.product_funnels where owning_team is not null) > 1, true,
  'each owned by a team');
select ok(exists (select 1 from cron.job where jobname = 'xos_check_product_funnels' and schedule = '23 * * * *'),
  'the check runs hourly');
select ok(exists (select 1 from private.retention_policies where table_name = 'app.product_funnel_alerts'),
  'alerts have a retention policy');

-- Funnel computation -------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
delete from app.product_events where workflow_code in ('atlas.finance', 'atlas.crew', 'atlas.reports', 'atlas.show');
select pg_temp.funnel('atlas.finance', 100, 90, 80, pg_temp.at('baseline'));
select pg_temp.funnel('atlas.finance', 40, 35, 30, pg_temp.at('current'));

select results_eq($$select sessions::int from private.product_funnel_stages('atlas.finance',
    pg_temp.at('end') - interval '24 hours', pg_temp.at('end')) order by stage$$,
  array[40, 35, 30], 'a funnel counts the sessions of each stage in order: started, step 1, completed');
select results_eq($$select event_name from private.product_funnel_stages('atlas.finance', pg_temp.at('baseline'),
    pg_temp.at('end')) order by stage$$,
  array['Workflow Started', 'Workflow Step', 'Workflow Completed'], 'named by event');

-- A session counts once per hourly bucket, as app.product_funnel_hourly counts it.
select pg_temp.sessions('atlas.show', 'Workflow Started', null, 1, pg_temp.at('current'));
select pg_temp.sessions('atlas.show', 'Workflow Started', null, 1, pg_temp.at('current') + interval '10 minutes');
select pg_temp.sessions('atlas.show', 'Workflow Started', null, 1, pg_temp.at('current') + interval '1 hour');
select is((select sessions::int from private.product_funnel_stages('atlas.show', pg_temp.at('end') - interval '24 hours',
    pg_temp.at('end')) where stage = 0), 2, 'twice in one hour counts once, in two hours twice');
select is((select sum(f.sessions)::int from app.product_funnel_hourly f where f.workflow_code = 'atlas.show'
    and f.event_name = 'Workflow Started'), 2, 'the same figure the hourly aggregates give');

select is((select completion_rate from private.product_funnel_reading('atlas.finance', now())), 0.7500::numeric,
  'the completion rate is completed over started sessions in the last 24 hours');
select is((select baseline_rate from private.product_funnel_reading('atlas.finance', now())), 0.8000::numeric,
  'against the 7 days before them');

-- The regression check -----------------------------------------------------------------------------------------------
-- atlas.crew (target 0.4): 0.6 a week, now 0.3, below its target and its baseline.
select pg_temp.funnel('atlas.crew', 100, 80, 60, pg_temp.at('baseline'));
select pg_temp.funnel('atlas.crew', 40, 30, 12, pg_temp.at('current'));
-- atlas.reports (target 0.25): 0.9 a week, now 0.5, on target but far below its baseline.
select pg_temp.funnel('atlas.reports', 100, 95, 90, pg_temp.at('baseline'));
select pg_temp.funnel('atlas.reports', 40, 30, 20, pg_temp.at('current'));
-- atlas.show: two sessions, too few to judge.

select is(private.check_product_funnels(now()), 2, 'the check raises an alert for each regressed funnel');
select is((select owning_team || ' ' || below_target || ' ' || below_baseline || ' ' || completion_rate
    from app.product_funnel_alerts where workflow_code = 'atlas.crew' and resolved_at is null),
  'Crew true true 0.3000', 'below target and baseline, for the owning team');
select is((select below_target::text || ' ' || below_baseline || ' ' || baseline_rate
    from app.product_funnel_alerts where workflow_code = 'atlas.reports' and resolved_at is null),
  'false true 0.9000', 'a fall well below its own last week is a regression even on target');
select is_empty($$select 1 from app.product_funnel_alerts where workflow_code in ('atlas.finance', 'atlas.show')$$,
  'a funnel on target, or with too few sessions, raises nothing');

select is(private.check_product_funnels(now() + interval '1 minute'), 0, 'the next check raises no second alert');
select is((select count(*)::int from app.product_funnel_alerts where resolved_at is null), 2, 'one open alert per workflow');
select is((select last_checked_at from app.product_funnel_alerts where workflow_code = 'atlas.crew'),
  now() + interval '1 minute', 'the open alert is refreshed');

-- Who reads them -----------------------------------------------------------------------------------------------------
select pg_temp.new_user('olga', 'olga@platform.test', 'Olga Brandt');
select pg_temp.as_platform();
select private.grant_platform_operator('olga@platform.test', 'Support', 'Reviews workflow funnels.');

select pg_temp.as_user('alice');
select is((select count(*)::int from app.product_funnel_alerts), 0, 'an org member reads no alerts');
select throws_ok($$select app.console_product_funnels()$$, '42501', 'the operator console is for the platform team',
  'nor the console funnels');
select pg_temp.as_anon();
select throws_ok($$select app.console_product_funnels()$$, '42501', null, 'anon cannot call it');

select pg_temp.as_op('olga');
select is((select count(*)::int from app.product_funnel_alerts where resolved_at is null), 2, 'an operator reads the alerts');
select is(jsonb_array_length(app.console_product_funnels() -> 'funnels'), 29, 'the console lists every funnel');
select is((select f ->> 'status' from jsonb_array_elements(app.console_product_funnels() -> 'funnels') f
    where f ->> 'workflow' = 'atlas.crew'), 'Regressed', 'with its status');
select is((select (f -> 'stages')::text from jsonb_array_elements(app.console_product_funnels() -> 'funnels') f
    where f ->> 'workflow' = 'atlas.finance'), '[40, 35, 30]', 'and its stages');

select lives_ok(format('select app.console_acknowledge_funnel_alert(%L)',
    (select id from app.product_funnel_alerts where workflow_code = 'atlas.reports')), 'an operator acknowledges an alert');
select is((select count(*)::int from app.platform_operator_actions where action = 'funnel_alert.acknowledge'
    and operator_person_id = pg_temp.id('olga')), 1, 'which the console ledger records');

-- Recovery -----------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select pg_temp.funnel('atlas.crew', 0, 0, 30, pg_temp.at('current') + interval '1 hour');
select private.check_product_funnels(now() + interval '2 minutes');
select isnt((select resolved_at from app.product_funnel_alerts where workflow_code = 'atlas.crew'), null,
  'a recovered funnel resolves its alert');
select is((select resolved_at from app.product_funnel_alerts where workflow_code = 'atlas.reports'), null,
  'while one still regressed stays open');

select pg_temp.as_op('olga');
select throws_ok(format('select app.console_acknowledge_funnel_alert(%L)',
    (select id from app.product_funnel_alerts where workflow_code = 'atlas.crew')), 'XR001',
  'funnel_alert_resolved: The funnel recovered and the alert is closed.', 'a resolved alert cannot be acknowledged');

select * from finish();
rollback;
