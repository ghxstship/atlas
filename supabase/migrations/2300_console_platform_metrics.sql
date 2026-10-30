-- 2300_console_platform_metrics.sql
-- A137 platform metrics in the operator console (RRR-200, trace row S4.10-09; Section 4.10 "platform metrics", ADR 0046
-- amended). The console's org page showed one tenant's usage; nothing showed the platform as a whole. The figures come
-- from data XOS already holds in its own database, so no metrics service, warehouse or third-party analytics tool is
-- added and no tenant data leaves the database (ADR 0046, Platform metrics):
--   * app.console_platform_metrics(p_weeks): one document of platform-wide aggregates for operators holding
--     tenants.read (every operator role), checked first by private.require_platform_operator (1470): new orgs, sign-ups
--     and Aurora requests by week; people with an account and how many were active in the last 1, 7 and 30 days; the
--     plan mix of live subscriptions with their states, and trials; the closed monthly usage_rollups totals per meter;
--     Aurora outcomes, features and tokens over 30 days; job queue health per job kind; and notification deliveries
--     per channel over 7 days, failures included.
--   * Aggregates only: counts and sums, never an org, a person, a record or an error text, so it opens no tenant
--     content and needs no support session (1472). Reading it is not written to the console ledger, which records
--     actions on tenants and their rows.
-- Weeks start on Monday and months on the 1st, both in UTC, like every instant the console shows (ADR 0046, Times).

create or replace function app.console_platform_metrics(p_weeks integer default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_weeks integer := least(greatest(coalesce(p_weeks, 12), 1), 52);
  v_this_week date := date_trunc('week', now() at time zone 'UTC')::date;
  v_first_week date;
  v_first_instant timestamptz;
  v_month date := date_trunc('month', now() at time zone 'UTC')::date;
  v_result jsonb;
begin
  perform private.require_platform_operator('tenants.read');
  v_first_week := v_this_week - (v_weeks - 1) * 7;
  v_first_instant := v_first_week::timestamp at time zone 'UTC';

  with weeks as (
    select (v_first_week + i * 7) as week_start from generate_series(0, v_weeks - 1) i
  ),
  new_orgs as (
    select date_trunc('week', o.created_at at time zone 'UTC')::date as week_start, count(*) as n
    from app.organizations o
    where o.created_at >= v_first_instant
    group by 1
  ),
  sign_ups as (
    select date_trunc('week', u.created_at at time zone 'UTC')::date as week_start, count(*) as n
    from auth.users u
    join app.people p on p.user_id = u.id and p.deleted_at is null
    where u.created_at >= v_first_instant
    group by 1
  ),
  aurora as (
    select date_trunc('week', r.created_at at time zone 'UTC')::date as week_start, count(*) as n
    from app.ai_requests r
    where r.created_at >= v_first_instant and r.deleted_at is null
    group by 1
  ),
  activity as (
    select greatest(u.last_sign_in_at, d.last_seen_at) as last_active_at
    from app.people p
    join auth.users u on u.id = p.user_id
    left join lateral (
      select max(x.last_seen_at) as last_seen_at from private.session_devices x where x.user_id = u.id
    ) d on true
    where p.deleted_at is null
  ),
  live_subscriptions as (
    select s.plan_code, s.subscription_state, s.trial_ends_at
    from app.subscriptions s
    join app.organizations o on o.id = s.org_id and o.deleted_at is null
    where s.subscription_state <> 'canceled' and s.deleted_at is null
  ),
  job_rows as (
    select j.job_kind, j.job_status, j.run_after, j.locked_at, j.finished_at
    from app.job_queue j
    where j.deleted_at is null
      and (j.job_status in ('Queued', 'Running') or j.finished_at >= now() - interval '24 hours')
  ),
  deliveries as (
    select d.channel, d.message_status
    from app.notification_deliveries d
    where d.notification_created_at >= now() - interval '7 days' and d.deleted_at is null
  )
  select jsonb_build_object(
    'generated_at', now(),
    'weeks', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'week_start', w.week_start,
        'new_orgs', coalesce(no.n, 0),
        'sign_ups', coalesce(su.n, 0),
        'aurora_requests', coalesce(au.n, 0)) order by w.week_start), '[]'::jsonb)
      from weeks w
      left join new_orgs no on no.week_start = w.week_start
      left join sign_ups su on su.week_start = w.week_start
      left join aurora au on au.week_start = w.week_start),
    'orgs', (
      select jsonb_build_object(
        'live', count(*),
        'clients', count(*) filter (where o.parent_org_id is not null),
        'without_subscription', count(*) filter (where not exists (
          select 1 from app.subscriptions s
          where s.org_id = o.id and s.subscription_state <> 'canceled' and s.deleted_at is null)))
      from app.organizations o
      where o.deleted_at is null),
    'people', (
      select jsonb_build_object(
        'with_account', count(*),
        'active_1d', count(*) filter (where a.last_active_at >= now() - interval '1 day'),
        'active_7d', count(*) filter (where a.last_active_at >= now() - interval '7 days'),
        'active_30d', count(*) filter (where a.last_active_at >= now() - interval '30 days'))
      from activity a),
    'plans', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'plan_code', pl.code,
        'orgs', coalesce(m.orgs, 0),
        'trialing', coalesce(m.trialing, 0),
        'active', coalesce(m.active, 0),
        'past_due', coalesce(m.past_due, 0),
        'read_only', coalesce(m.read_only, 0)) order by pl.sort_order), '[]'::jsonb)
      from app.plans pl
      left join (
        select ls.plan_code, count(*) as orgs,
          count(*) filter (where ls.subscription_state = 'trialing') as trialing,
          count(*) filter (where ls.subscription_state = 'active') as active,
          count(*) filter (where ls.subscription_state = 'past_due') as past_due,
          count(*) filter (where ls.subscription_state = 'read_only') as read_only
        from live_subscriptions ls
        group by ls.plan_code
      ) m on m.plan_code = pl.code),
    'trials', (
      select jsonb_build_object(
        'trialing', count(*),
        'ending_7d', count(*) filter (where ls.trial_ends_at < now() + interval '7 days'))
      from live_subscriptions ls
      where ls.subscription_state = 'trialing'),
    'usage', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'period_start', u.period_start,
        'meter_code', u.meter_code,
        'unit', u.unit,
        'quantity', u.quantity,
        'orgs', u.orgs) order by u.period_start desc, u.sort_order), '[]'::jsonb)
      from (
        select r.period_start, r.meter_code, um.unit, um.sort_order, sum(r.quantity) as quantity,
          count(distinct r.org_id) as orgs
        from app.usage_rollups r
        join private.usage_meters um on um.code = r.meter_code
        where r.period_start >= (v_month - interval '3 months')::date and r.deleted_at is null
        group by r.period_start, r.meter_code, um.unit, um.sort_order
      ) u),
    'aurora', (
      select jsonb_build_object(
        'requests_30d', (select count(*) from app.ai_requests r
          where r.created_at >= now() - interval '30 days' and r.deleted_at is null),
        'outcomes', (
          select coalesce(jsonb_agg(jsonb_build_object('outcome', x.outcome, 'requests', x.n) order by x.outcome), '[]'::jsonb)
          from (select r.outcome, count(*) as n from app.ai_requests r
                where r.created_at >= now() - interval '30 days' and r.deleted_at is null group by r.outcome) x),
        'features', (
          select coalesce(jsonb_agg(jsonb_build_object('feature', x.feature, 'requests', x.n) order by x.feature), '[]'::jsonb)
          from (select r.feature, count(*) as n from app.ai_requests r
                where r.created_at >= now() - interval '30 days' and r.deleted_at is null group by r.feature) x),
        'input_tokens_30d', (select coalesce(sum(u.input_tokens), 0) from app.ai_usage u
          where u.metered_at >= now() - interval '30 days' and u.deleted_at is null),
        'output_tokens_30d', (select coalesce(sum(u.output_tokens), 0) from app.ai_usage u
          where u.metered_at >= now() - interval '30 days' and u.deleted_at is null))),
    'jobs', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'job_kind', k.job_kind,
        'ready', k.ready,
        'scheduled', k.scheduled,
        'running', k.running,
        'stalled', k.stalled,
        'failed_24h', k.failed_24h,
        'succeeded_24h', k.succeeded_24h,
        'oldest_ready_at', k.oldest_ready_at) order by k.job_kind), '[]'::jsonb)
      from (
        select j.job_kind,
          count(*) filter (where j.job_status = 'Queued' and j.run_after <= now()) as ready,
          count(*) filter (where j.job_status = 'Queued' and j.run_after > now()) as scheduled,
          count(*) filter (where j.job_status = 'Running') as running,
          count(*) filter (where j.job_status = 'Running' and j.locked_at < now() - interval '30 minutes') as stalled,
          count(*) filter (where j.job_status = 'Failed') as failed_24h,
          count(*) filter (where j.job_status = 'Succeeded') as succeeded_24h,
          min(j.run_after) filter (where j.job_status = 'Queued' and j.run_after <= now()) as oldest_ready_at
        from job_rows j
        group by j.job_kind
      ) k),
    'notifications', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'channel', n.channel,
        'total', n.total,
        'sent', n.sent,
        'pending', n.pending,
        'failed', n.failed,
        'bounced', n.bounced,
        'suppressed', n.suppressed) order by n.channel), '[]'::jsonb)
      from (
        select c.channel,
          count(d.message_status) as total,
          count(*) filter (where d.message_status in ('Sent', 'Delivered')) as sent,
          count(*) filter (where d.message_status in ('Queued', 'Deferred', 'Digest')) as pending,
          count(*) filter (where d.message_status = 'Failed') as failed,
          count(*) filter (where d.message_status = 'Bounced') as bounced,
          count(*) filter (where d.message_status = 'Suppressed') as suppressed
        from unnest(enum_range(null::app.notification_channel)) c (channel)
        left join deliveries d on d.channel = c.channel
        where c.channel <> 'In App'
        group by c.channel
      ) n)
  ) into v_result;
  return v_result;
end;
$$;

comment on function app.console_platform_metrics(integer) is 'Platform-wide metrics for the operator console (A137, tenants.read): new orgs, sign-ups and Aurora requests by UTC week for the last p_weeks weeks (1 to 52, default 12); people with an account and those active (signed in or seen on a session) in 1, 7 and 30 days; the plan mix of live subscriptions by state, and trials; closed usage_rollups totals per meter for the last three months; Aurora outcomes, features and tokens over 30 days; job queue health per job kind; notification deliveries per channel over 7 days. Aggregates only, never an org, person, record or error text. Read from the database itself (ADR 0046).';
revoke all on function app.console_platform_metrics(integer) from public, anon;
grant execute on function app.console_platform_metrics(integer) to authenticated;
