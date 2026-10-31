-- pgTAP: consent-gated product analytics (A96, RRR-141, A65-022, Section 11.14). Events reach the table only through
-- app.record_product_events, carry no person, org, path or free text, name only the Sections 11.11 to 11.13 workflows,
-- are capped per person, and are read in hourly aggregates by platform staff only.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(17);

select has_table('app', 'product_events', 'events live in app.product_events');
select is((select relrowsecurity from pg_class where oid = 'app.product_events'::regclass), true, 'row level security is on');
-- 26 from 1532, and R11's three advancing workflows (2745).
select is((select count(*)::int from private.product_workflows), 29, 'every workflow of Sections 11.11 to 11.13 is named');
select is_empty($$
  select a.attname from pg_attribute a where a.attrelid = 'app.product_events'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attname in ('person_id', 'org_id', 'user_id', 'path', 'url', 'properties', 'email', 'ip')
$$, 'no column could carry a person, an org, a path or free properties');
select ok(exists (select 1 from private.retention_policies r where r.table_name = 'app.product_events'
  and r.retention = interval '13 months'), 'events are kept 13 months');

select pg_temp.as_anon();
select throws_ok($$select app.record_product_events('Atlas', gen_random_uuid(), '[]')$$, '42501', null,
  'anonymous visitors record nothing');

select pg_temp.as_user('alice');
select is(app.record_product_events('Atlas', '00000000-0000-4000-8000-000000000001', jsonb_build_array(
    jsonb_build_object('occurredAt', now(), 'name', 'Page Viewed', 'route', '/[org]/projects'),
    jsonb_build_object('occurredAt', now(), 'name', 'Workflow Started', 'workflow', 'atlas.projects_gates'),
    jsonb_build_object('occurredAt', now(), 'name', 'Workflow Step', 'workflow', 'atlas.projects_gates', 'step', 1),
    jsonb_build_object('occurredAt', now(), 'name', 'Workflow Completed', 'workflow', 'atlas.projects_gates'))), 4,
  'a consented session records page views and a workflow funnel');
select throws_ok($$select app.record_product_events('Atlas', gen_random_uuid(), jsonb_build_array(
    jsonb_build_object('name', 'Workflow Started', 'workflow', 'atlas.anything')))$$, 'XR001',
  'product_events_workflow: An event may name only a workflow of Sections 11.11 to 11.13.', 'an unknown workflow is refused');
select throws_ok($$select app.record_product_events('Atlas', gen_random_uuid(), jsonb_build_array(
    jsonb_build_object('name', 'Page Viewed', 'route', '/northwind-live/p/NWS?token=1')))$$, '23514', null,
  'a path with a query string is refused');
select throws_ok($$select app.record_product_events('Atlas', gen_random_uuid(), jsonb_build_array(
    jsonb_build_object('name', 'Clicked Button', 'route', '/home')))$$, '23514', null, 'an unknown event is refused');
select throws_ok($$select app.record_product_events('Atlas', gen_random_uuid(),
    (select jsonb_agg(jsonb_build_object('name', 'Page Viewed', 'route', '/home')) from generate_series(1, 26)))$$, 'XR001',
  'product_events_batch: Send at most 25 events at a time.', 'at most 25 events a call');
select is(app.record_product_events('Atlas', gen_random_uuid(), jsonb_build_array(
    jsonb_build_object('occurredAt', now() - interval '3 days', 'name', 'Page Viewed', 'route', '/[org]/home'))), 1,
  'an event with a stale clock is still recorded');
select pg_temp.as_platform();
select ok((select max(e.received_at - e.occurred_at) <= interval '1 day' from app.product_events e),
  'its time held to the day before it arrived');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.product_events), 0, 'a member reads no events');
select is((select count(*)::int from app.product_funnel_hourly), 0, 'nor the aggregates');

-- The per-person cap: 300 events every 10 minutes.
select pg_temp.as_platform();
update private.product_event_windows set events = 299 where person_id = pg_temp.id('alice');
select pg_temp.as_user('alice');
select throws_ok($$select app.record_product_events('Atlas', gen_random_uuid(), jsonb_build_array(
    jsonb_build_object('name', 'Page Viewed', 'route', '/home'), jsonb_build_object('name', 'Page Viewed', 'route', '/home')))$$,
  'XR001', 'product_events_limit: Too many events from one person; the rest are dropped.', 'one person sends at most 300 events');

-- Platform staff read the aggregates.
select pg_temp.as_platform();
do $$
begin
  if to_regclass('app.platform_operators') is not null then
    perform private.grant_platform_operator('dave@northwind.test', 'Support', 'Reviews workflow funnels.');
  else
    insert into private.platform_staff (person_id, reason) values (pg_temp.id('dave'), 'Reviews workflow funnels.');
  end if;
end;
$$;
select pg_temp.as_user('dave');
select is((select sum(f.sessions)::int from app.product_funnel_hourly f
           where f.workflow_code = 'atlas.projects_gates' and f.event_name = 'Workflow Completed'), 1,
  'staff count the sessions that completed a workflow');

select * from finish();
rollback;
