-- pgTAP: migration 2300, platform metrics in the operator console (A137, RRR-200, trace row S4.10-09). Only a live
-- operator with a second factor reads app.console_platform_metrics; tenants, anon, a revoked operator and a session
-- without a second factor are refused. The figures count what the fixtures add: orgs and sign-ups by week, active
-- people, the plan mix and trials, closed usage totals, Aurora requests and tokens, job queue health and notification
-- delivery failures. The stack holds other orgs (the demo seed, Standard Library copies), so each figure is checked
-- as the change from a reading taken before the fixtures, and the document names no org or person.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(33);

create function pg_temp.as_op(p_key text, p_aal text default 'aal2') returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', p_aal)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create temporary table readings (key text primary key, doc jsonb not null);
grant select, insert on readings to public;

-- One figure of a reading: a path into the document, or a field of the array element that contains p_match.
create function pg_temp.fig(p_key text, p_path text[]) returns numeric
language sql stable as $$ select coalesce((select (r.doc #>> p_path)::numeric from readings r where r.key = p_key), 0) $$;
create function pg_temp.fig(p_key text, p_array text, p_match jsonb, p_field text) returns numeric
language sql stable as $$
  select coalesce((select (e ->> p_field)::numeric from readings r, jsonb_array_elements(r.doc -> p_array) e
                   where r.key = p_key and e @> p_match), 0)
$$;
create function pg_temp.delta(p_path text[]) returns numeric
language sql stable as $$ select pg_temp.fig('after', p_path) - pg_temp.fig('before', p_path) $$;
create function pg_temp.delta(p_array text, p_match jsonb, p_field text) returns numeric
language sql stable as $$ select pg_temp.fig('after', p_array, p_match, p_field) - pg_temp.fig('before', p_array, p_match, p_field) $$;

select pg_temp.new_user('olga', 'olga@platform.test', 'Olga Brandt');
select pg_temp.new_user('omar', 'omar@platform.test', 'Omar Haddad');
select pg_temp.new_user('tess', 'tess@platform.test', 'Tess Morales');
select pg_temp.new_user('rudi', 'rudi@platform.test', 'Rudi Kask');
select pg_temp.as_platform();
select private.grant_platform_operator('olga@platform.test', 'Administrator', 'First platform administrator.');
select private.grant_platform_operator('omar@platform.test', 'Support', 'Support on call.');
select private.grant_platform_operator('tess@platform.test', 'Trust and Safety', 'Marketplace reviews.');
select private.grant_platform_operator('rudi@platform.test', 'Support', 'Support for the summer.');
update app.platform_operators set revoked_at = now(), revoke_reason = 'Summer ended.'
where person_id = pg_temp.id('rudi');

-- Who may read it --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok($$select app.console_platform_metrics()$$, '42501', 'the operator console is for the platform team',
  'an org Owner is refused');
select pg_temp.as_user('nina');
select throws_ok($$select app.console_platform_metrics()$$, '42501', null, 'so is a person with no org');
select pg_temp.as_anon();
select throws_ok($$select app.console_platform_metrics()$$, '42501', null, 'anon cannot call it');
select pg_temp.as_op('rudi');
select throws_ok($$select app.console_platform_metrics()$$, '42501', null, 'nor can a revoked operator');
select pg_temp.as_op('olga', 'aal1');
select throws_ok($$select app.console_platform_metrics()$$, 'XR001', null,
  'an operator without a second factor is refused (step_up_required)');
select pg_temp.as_op('omar');
select lives_ok($$select app.console_platform_metrics()$$, 'Support reads the platform metrics');
select pg_temp.as_op('tess');
select lives_ok($$select app.console_platform_metrics()$$, 'and so does Trust and Safety');
select pg_temp.as_op('olga');
select is(jsonb_array_length(app.console_platform_metrics() -> 'weeks'), 12, 'twelve weeks by default');
select is(jsonb_array_length(app.console_platform_metrics(0) -> 'weeks'), 1, 'at least one week');
select is(jsonb_array_length(app.console_platform_metrics(500) -> 'weeks'), 52, 'and at most a year of weeks');
select is((app.console_platform_metrics(4) #>> '{weeks,3,week_start}')::date,
  date_trunc('week', now() at time zone 'UTC')::date, 'the last week is this one, starting on Monday in UTC');
select is((select string_agg(e ->> 'plan_code', ',') from jsonb_array_elements(app.console_platform_metrics() -> 'plans') e),
  (select string_agg(code, ',' order by sort_order) from app.plans), 'the plan mix lists every plan in order');
select is((select string_agg(e ->> 'channel', ',') from jsonb_array_elements(app.console_platform_metrics() -> 'notifications') e),
  'Email,SMS,Push', 'and deliveries every outside channel');

insert into readings values ('before', app.console_platform_metrics(4));

-- Fixtures ----------------------------------------------------------------------------------------------------------------
-- Fern signs up this week and creates an org on a Pro trial ending in three days; Gus signed up last week.
select pg_temp.new_user('fern', 'fern@ridgeline.test', 'Fern Abara');
select pg_temp.new_user('gus', 'gus@ridgeline.test', 'Gus Marlow');
select pg_temp.as_platform();
update auth.users set created_at = now() - interval '7 days' where id = pg_temp.id('gus_user');
select pg_temp.as_user('fern');
insert into world values ('org_r', app.create_organization('Ridgeline Audio', 'ridgeline-audio'));
select pg_temp.as_platform();
update app.subscriptions set plan_code = 'pro', subscription_state = 'trialing', trial_ends_at = now() + interval '3 days'
where org_id = pg_temp.id('org_r') and subscription_state <> 'canceled' and deleted_at is null;

-- Activity: Fern signed in an hour ago, Gus ten days ago; Cora last signed in 40 days ago but used a session 3 days ago.
update auth.users set last_sign_in_at = now() - interval '1 hour' where id = pg_temp.id('fern_user');
update auth.users set last_sign_in_at = now() - interval '10 days' where id = pg_temp.id('gus_user');
update auth.users set last_sign_in_at = now() - interval '40 days' where id = pg_temp.id('cora_user');
insert into world values ('cora_session', gen_random_uuid());
insert into auth.sessions (id, user_id, created_at, updated_at)
values (pg_temp.id('cora_session'), pg_temp.id('cora_user'), now() - interval '40 days', now() - interval '3 days');
insert into private.session_devices (session_id, user_id, surface, first_seen_at, last_seen_at)
values (pg_temp.id('cora_session'), pg_temp.id('cora_user'), 'Atlas', now() - interval '40 days', now() - interval '3 days');

-- Last month's closed usage: two orgs made API requests.
insert into app.usage_rollups (org_id, meter_code, period_start, quantity) values
  (pg_temp.id('org_a'), 'api_requests', (date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date, 1200),
  (pg_temp.id('org_b'), 'api_requests', (date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date, 300);

-- Aurora: two answered assistant requests, one failed summary, and the tokens of one of them.
with r as (
  insert into app.ai_requests (org_id, person_id, feature, model, outcome, completed_at, failure_code)
  values (pg_temp.id('org_a'), pg_temp.id('dave'), 'assistant', 'claude-haiku-5-5', 'Answered', now(), null),
         (pg_temp.id('org_a'), pg_temp.id('dave'), 'assistant', 'claude-haiku-5-5', 'Answered', now(), null),
         (pg_temp.id('org_a'), pg_temp.id('dave'), 'summaries', 'claude-haiku-5-5', 'Failed', now(), 'provider_error')
  returning id, feature)
insert into app.ai_usage (org_id, request_id, input_tokens, output_tokens)
select pg_temp.id('org_a'), r.id, 1000, 250 from r where r.feature = 'summaries';

-- The job queue: one ready report, one waiting on a retry, one running for an hour, one failed an hour ago.
insert into app.job_queue (org_id, job_kind, subject_id, job_status, run_after, attempts, locked_by, locked_at, finished_at, last_error) values
  (pg_temp.id('org_a'), 'report.run', gen_random_uuid(), 'Queued', now() - interval '10 minutes', 0, null, null, null, null),
  (pg_temp.id('org_a'), 'report.run', gen_random_uuid(), 'Queued', now() + interval '1 hour', 1, null, null, null, 'timeout'),
  (pg_temp.id('org_a'), 'report.run', gen_random_uuid(), 'Running', now() - interval '1 hour', 1, 'worker-1', now() - interval '1 hour', null, null),
  (pg_temp.id('org_b'), 'report.run', gen_random_uuid(), 'Failed', now() - interval '2 hours', 5, null, null, now() - interval '1 hour', 'gave up');

-- Notifications: Dave's approval request bounced by email and failed by push.
insert into world values ('dave_note', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested'));
update app.notification_deliveries
set message_status = case channel when 'Email' then 'Bounced'::app.message_status else 'Failed'::app.message_status end,
  attempt_count = 1, last_error = 'Rejected by the provider.'
where notification_id = pg_temp.id('dave_note');

select pg_temp.as_op('olga');
insert into readings values ('after', app.console_platform_metrics(4));

-- The figures --------------------------------------------------------------------------------------------------------------
select is(pg_temp.delta('{weeks,3,new_orgs}'), 1::numeric, 'this week has one new org');
select is(pg_temp.delta('{weeks,3,sign_ups}'), 1::numeric, 'and one sign-up');
select is(pg_temp.delta('{weeks,2,sign_ups}'), 1::numeric, 'last week has the other');
select is(pg_temp.delta('{orgs,live}'), 1::numeric, 'live orgs count the new one');
select is(pg_temp.delta('{people,with_account}'), 2::numeric, 'people with an account count both sign-ups');
select is(pg_temp.delta('{people,active_1d}'), 1::numeric, 'one more person was active today');
select is(pg_temp.delta('{people,active_7d}'), 2::numeric, 'two this week, counting a session seen after the last sign-in');
select is(pg_temp.delta('{people,active_30d}'), 3::numeric, 'three this month');
select is(pg_temp.delta('plans', '{"plan_code": "pro"}', 'trialing'), 1::numeric, 'the plan mix shows one more Pro trial');
select is(pg_temp.delta('{trials,trialing}') || ' ' || pg_temp.delta('{trials,ending_7d}'), '1 1',
  'one more trial, ending within a week');
select is(pg_temp.delta('usage', jsonb_build_object('meter_code', 'api_requests',
    'period_start', (date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date), 'quantity'), 1500::numeric,
  'last month''s API requests add up across orgs');
select is(pg_temp.delta('usage', jsonb_build_object('meter_code', 'api_requests',
    'period_start', (date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date), 'orgs'), 2::numeric,
  'from two orgs');
select is(pg_temp.delta('{weeks,3,aurora_requests}') || ' ' || pg_temp.delta('{aurora,requests_30d}'), '3 3',
  'Aurora requests count this week and over 30 days');
select is(pg_temp.delta('{aurora,input_tokens_30d}') || ' ' || pg_temp.delta('{aurora,output_tokens_30d}'), '1000 250',
  'and the tokens they used');
select is(
  (select (e ->> 'requests')::int from readings r, jsonb_array_elements(r.doc #> '{aurora,outcomes}') e
   where r.key = 'after' and e ->> 'outcome' = 'Failed')
  - coalesce((select (e ->> 'requests')::int from readings r, jsonb_array_elements(r.doc #> '{aurora,outcomes}') e
   where r.key = 'before' and e ->> 'outcome' = 'Failed'), 0), 1, 'one failed');
select is(pg_temp.delta('jobs', '{"job_kind": "report.run"}', 'ready') || ' ' || pg_temp.delta('jobs', '{"job_kind": "report.run"}', 'scheduled')
  || ' ' || pg_temp.delta('jobs', '{"job_kind": "report.run"}', 'stalled') || ' ' || pg_temp.delta('jobs', '{"job_kind": "report.run"}', 'failed_24h'),
  '1 1 1 1', 'job health counts ready, scheduled, stalled and failed jobs of the kind');
select ok((select (e ->> 'oldest_ready_at')::timestamptz <= now() - interval '10 minutes'
  from readings r, jsonb_array_elements(r.doc -> 'jobs') e where r.key = 'after' and e ->> 'job_kind' = 'report.run'),
  'and how long the oldest ready job has waited');
select is(pg_temp.delta('notifications', '{"channel": "Email"}', 'bounced') || ' ' || pg_temp.delta('notifications', '{"channel": "Push"}', 'failed'),
  '1 1', 'delivery failures show by channel');
select is(pg_temp.delta('notifications', '{"channel": "Email"}', 'total'), 1::numeric, 'within each channel''s total');

-- Aggregates only -------------------------------------------------------------------------------------------------------
select ok((select position(pg_temp.id('org_a')::text in r.doc::text) = 0 and position('Northwind' in r.doc::text) = 0
  and position('Rejected by the provider' in r.doc::text) = 0 and position('fern@' in r.doc::text) = 0
  from readings r where r.key = 'after'), 'the document names no org, person or error');

select * from finish();
rollback;
