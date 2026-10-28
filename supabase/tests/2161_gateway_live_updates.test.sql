-- pgTAP: 2161, Gateway lists update live and a person receives only their own rows (A122, RRR-166, ADR 0082). The
-- published tables confine each external person to their rows through row level security, which is what Realtime
-- applies to every change; engagements, invoices and payments ping the private channel gateway:<person id> of the
-- people on the row's side, with no row data; and the channel rule lets only that person receive on it, checked the
-- way Realtime authorizes a private channel (realtime.topic set, then reading channel messages as the person).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(24);

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Publication entries --------------------------------------------------------------------------------------------------
select is(
  (select array_agg(p.tablename::text order by p.tablename) from pg_catalog.pg_publication_tables p
   where p.pubname = 'supabase_realtime' and p.schemaname = 'app'
     and p.tablename in ('engagement_documents', 'timesheets', 'applications', 'offers', 'tax_forms', 'saved_opportunities',
       'passed_opportunities')),
  array['applications', 'engagement_documents', 'offers', 'passed_opportunities', 'saved_opportunities', 'tax_forms', 'timesheets'],
  'the tables behind Gateway''s documents, timesheets, applications, tax documents and saved lists stream their changes');
select is_empty($$
  select c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and c.relname in ('engagement_documents', 'timesheets', 'applications', 'offers', 'tax_forms',
      'saved_opportunities', 'passed_opportunities')
    and not c.relrowsecurity
$$, 'each keeps row level security on, which Realtime applies to every change with the subscriber''s JWT');
select is(
  pg_temp.n('ivy', 'select 1 from app.engagements') + pg_temp.n('ivy', 'select 1 from app.invoices')
    + pg_temp.n('ivy', 'select 1 from app.payments'),
  0, 'external people read engagements, invoices and payments only through api_external, so no change of them streams to Gateway');

-- A person's published rows are their own -------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
with t as (insert into app.timesheets (project_id, engagement_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-06-01', '2027-06-07') returning id) insert into world select 'ts1', id from t;
insert into app.engagement_documents (engagement_id, document_kind, title) values (pg_temp.id('eng_ivy_a'), 'Agreement', 'Crew Agreement');
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, starts_on, ends_on, requisition_id)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Summer Series Riggers', 'Invited', '2027-06-01', '2027-06-03', pg_temp.id('requisition_a'))
  returning id) insert into world select 'opp', id from o;
insert into app.opportunity_invitations (opportunity_id, person_id) values (pg_temp.id('opp'), pg_temp.id('ivy'));
select app.transition_opportunity(pg_temp.id('opp'), 'Draft', 'Pending Approval', 'Ready.');
select app.transition_opportunity(pg_temp.id('opp'), 'Pending Approval', 'Published', 'Approved.');
select pg_temp.as_user('ivy');
insert into app.applications (opportunity_id, applicant_person_id, availability_confirmed) values (pg_temp.id('opp'), pg_temp.id('ivy'), true);
insert into app.saved_opportunities (opportunity_id) values (pg_temp.id('opp'));
select app.submit_tax_form(pg_temp.id('org_a'), 'W-9', '123-45-6789');
select pg_temp.as_platform();

select is(pg_temp.n('ivy', 'select 1 from app.timesheets'), 1, 'Ivy reads her timesheet, so its changes reach her');
select is(pg_temp.n('quinn', 'select 1 from app.timesheets where engagement_id = ''' || pg_temp.id('eng_ivy_a') || ''''), 0,
  'while another freelancer reads none of hers, so none of their changes reach him');
select is(pg_temp.n('ivy', 'select 1 from app.engagement_documents'), 1, 'Ivy reads the documents of her engagement');
select is(pg_temp.n('quinn', 'select 1 from app.engagement_documents where engagement_id = ''' || pg_temp.id('eng_ivy_a') || ''''), 0,
  'and nobody else outside the org does');
select is(pg_temp.n('quinn', 'select 1 from app.applications where applicant_person_id = ''' || pg_temp.id('ivy') || ''''), 0,
  'her applications are hers');
select is(pg_temp.n('quinn', 'select 1 from app.saved_opportunities'), 0, 'her saved listings are hers');
select is(pg_temp.n('quinn', 'select 1 from app.tax_forms where person_id = ''' || pg_temp.id('ivy') || ''''), 0, 'and her tax forms');

-- The personal channel: triggers and rule ----------------------------------------------------------------------------------
select is(
  (select array_agg(c.relname || ' ' || t.tgname order by c.relname, t.tgname) from pg_catalog.pg_trigger t
   join pg_catalog.pg_class c on c.oid = t.tgrelid
   where t.tgname like 't95_gateway_live_%' and c.relnamespace = 'app'::regnamespace),
  array['engagements t95_gateway_live_delete', 'engagements t95_gateway_live_insert', 'engagements t95_gateway_live_update',
        'invoices t95_gateway_live_delete', 'invoices t95_gateway_live_insert', 'invoices t95_gateway_live_update',
        'payments t95_gateway_live_delete', 'payments t95_gateway_live_insert', 'payments t95_gateway_live_update'],
  'engagements, invoices and payments ping the Gateway channel after every statement that changes them');
select ok((select prosecdef and proconfig @> array['search_path=""'] and not has_function_privilege('authenticated', oid, 'execute')
           from pg_proc where oid = 'private.gateway_live_ping(uuid[], text)'::regprocedure),
  'the ping runs with owner rights, an empty search path, and never for a signed-in caller directly');
select has_table('realtime', 'messages', 'Realtime''s messages table exists on this stack');
select policy_cmd_is('realtime', 'messages', 'xos_gateway_channel_read', 'select', 'receiving on gateway:<person id> has its rule');
select policy_roles_are('realtime', 'messages', 'xos_gateway_channel_read', array['authenticated'], 'for signed-in people');

create temporary table channel (topic text);
grant all on channel to public;

create function pg_temp.received(p_who text, p_topic_person text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  perform set_config('realtime.topic', 'gateway:' || pg_temp.id(p_topic_person), true);
  select count(*)::int into v from realtime.messages where topic = 'gateway:' || pg_temp.id(p_topic_person);
  perform pg_temp.as_platform();
  perform set_config('realtime.topic', '', true);
  return v;
end $$;

create function pg_temp.pings(p_person text) returns integer
language sql as $$
  select count(*)::int from realtime.messages where topic = 'gateway:' || pg_temp.id(p_person) and event = 'changed';
$$;

-- Messages are partitioned by day, and Realtime makes the partitions. Where no partition covers today, no ping can be
-- stored (the write goes on without it), so these checks are skipped, as 1710's are.
create function pg_temp.pings_applied() returns setof text
language plpgsql as $$
begin
  if not exists (
    select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'realtime.messages'::regclass
      and localtimestamp >= substring(pg_get_expr(c.relpartbound, c.oid) from $re$FROM \('([^']+)'\)$re$)::timestamp
      and localtimestamp < substring(pg_get_expr(c.relpartbound, c.oid) from $re$TO \('([^']+)'\)$re$)::timestamp
  ) then
    return next skip('Realtime has made no partition of realtime.messages for today on this database', 9);
    return;
  end if;
  delete from realtime.messages where topic like 'gateway:%';

  perform pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
  return next is(pg_temp.pings('ivy'), 1, 'a change to Ivy''s engagement pings her channel once per statement');
  -- Realtime stamps each message with its own id; the rest is the ping.
  return next is((select payload - 'id' from realtime.messages where topic = 'gateway:' || pg_temp.id('ivy') limit 1),
    '{"table": "engagements"}'::jsonb, 'with the table''s name and nothing of the row');
  return next is(pg_temp.pings('quinn'), 0, 'and pings nobody else''s');

  perform pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
  return next is(pg_temp.pings('victor') + pg_temp.pings('fiona') + pg_temp.pings('sam'), 3,
    'a change to an account''s engagement pings its members');
  perform pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
  return next is(pg_temp.pings('rita'), 1, 'and one to an artist''s engagement pings the artist''s representative');

  perform pg_temp.as_user('carol');
  insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code, due_on)
  values (pg_temp.id('prj_a'), 'Payable', pg_temp.id('cp_v_a'), 'BA-2161', 'USD', '2027-08-01');
  perform pg_temp.as_platform();
  return next is(pg_temp.pings('fiona') - 1, 1, 'an invoice of the account pings its Finance member');
  return next is(pg_temp.pings('sam') - 1, 0, 'but not the technician it supplies, who never reads its invoices');

  return next is(pg_temp.received('ivy', 'ivy'), 1, 'Ivy receives on her own channel, as Realtime authorizes it');
  return next is(pg_temp.received('quinn', 'ivy'), 0, 'another person joining Ivy''s channel receives nothing');
end $$;

select * from pg_temp.pings_applied();

select * from finish();
rollback;
