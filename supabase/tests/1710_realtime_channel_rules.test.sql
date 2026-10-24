-- pgTAP: 1710, the co-editing channel rules are present on every environment (A106, RRR-151, ADR 0044). The policies
-- on realtime.messages exist, private.ensure_realtime_channel_policies puts back any that a recreated table lost, and
-- the rules work as Realtime applies them: Realtime authorizes a private channel by setting realtime.topic and the
-- caller's role, then reading (to receive) and inserting (to send) channel messages, so a non-reader of the document
-- sees nothing and sends nothing.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(21);

-- The rules and the function that ensures them ---------------------------------------------------------------------
select is((select array_agg(policy_name order by policy_name) from private.realtime_channel_policies),
  array['xos_doc_channel_read', 'xos_doc_channel_write'], 'the document channel rules are registered');
select ok((select prosecdef and proconfig @> array['search_path=""']
           from pg_proc where oid = 'private.ensure_realtime_channel_policies()'::regprocedure),
  'ensure runs with owner rights and an empty search path');
select ok(not has_function_privilege('authenticated', 'private.ensure_realtime_channel_policies()', 'execute')
  and not has_function_privilege('anon', 'private.ensure_realtime_channel_policies()', 'execute'),
  'and no signed-in or anonymous caller may run it');
select ok(exists (select 1 from cron.job where jobname = 'xos_ensure_realtime_channel_policies'
                  and schedule = '* * * * *' and command like '%private.ensure_realtime_channel_policies()%'),
  'pg_cron checks the rules every minute');

-- Present after the migrations ----------------------------------------------------------------------------------------
select has_table('realtime', 'messages', 'Realtime''s messages table exists on this stack');
select policy_cmd_is('realtime', 'messages', 'xos_doc_channel_read', 'select', 'receiving on doc:<id> has its rule');
select policy_roles_are('realtime', 'messages', 'xos_doc_channel_read', array['authenticated'], 'for signed-in people');
select policy_cmd_is('realtime', 'messages', 'xos_doc_channel_write', 'insert', 'sending on doc:<id> has its rule');
select policy_roles_are('realtime', 'messages', 'xos_doc_channel_write', array['authenticated'], 'for signed-in people');
select is(private.ensure_realtime_channel_policies(), '{}'::text[], 'with every rule present, ensure creates nothing');

-- A recreated table: the rules come back ------------------------------------------------------------------------------
create temporary table written as
select policyname, cmd, qual, with_check from pg_policies where schemaname = 'realtime' and tablename = 'messages';
drop policy xos_doc_channel_read on realtime.messages;
drop policy xos_doc_channel_write on realtime.messages;
select is(private.ensure_realtime_channel_policies(), array['xos_doc_channel_read', 'xos_doc_channel_write'],
  'after the table lost its policies, ensure creates both');
select results_eq(
  $$select policyname::text, cmd::text, qual, with_check from pg_policies
    where schemaname = 'realtime' and tablename = 'messages' order by 1$$,
  $$select policyname::text, cmd::text, qual, with_check from written order by 1$$,
  'exactly as 1453 wrote them');

-- The rules as Realtime applies them -----------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.sops (org_id, code, title, body) values (pg_temp.id('org_a'), 'SOP-171', 'Rigging Inspection', 'Inspect every shackle.') returning id)
insert into world select 'sop', id from x;
insert into world select 'doc', (app.open_doc('app.sops', pg_temp.id('sop'), 'body') ->> 'doc_id')::uuid;
select pg_temp.as_platform();

-- Messages are partitioned by inserted_at, and the running Realtime service makes the partitions for the days around
-- today; a database started without it (CI's `supabase db start`) has none. The test makes its own partition, far
-- ahead of any Realtime makes, and stamps every message inside it, so it depends on neither the clock nor the service.
-- Inserts and reads go through realtime.messages, whose policies are the ones applied.
create table realtime.messages_xos_1710_test partition of realtime.messages
  for values from ('2099-01-01') to ('2099-01-02');
create temporary table channel (topic text, stamp timestamp);
grant all on channel to public;
insert into channel values ('doc:' || pg_temp.id('doc'), '2099-01-01 12:00');

create function pg_temp.join_channel(p_key text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(p_key);
  perform set_config('realtime.topic', (select topic from channel), true);
end $$;

create function pg_temp.send(p_extension text) returns void
language sql as $$
  insert into realtime.messages (topic, extension, event, payload, private, inserted_at)
  select topic, p_extension, 'yjs', '{"update": "AQI="}'::jsonb, true, stamp from channel;
$$;

select pg_temp.join_channel('carol');
select lives_ok($$select pg_temp.send('broadcast')$$, 'a writer broadcasts on the document''s channel');
select lives_ok($$select pg_temp.send('presence')$$, 'and tracks presence there');
select is((select count(*)::int from realtime.messages where topic = (select topic from channel)), 2,
  'and receives both');

select pg_temp.join_channel('gina');
select is((select count(*)::int from realtime.messages where topic = (select topic from channel)), 2,
  'a reader receives the broadcasts and presence');
select throws_ok($$select pg_temp.send('broadcast')$$, '42501', null, 'but a reader''s broadcast is refused');
select lives_ok($$select pg_temp.send('presence')$$, 'while a reader may track presence');

select pg_temp.join_channel('xavier');
select is((select count(*)::int from realtime.messages where topic = (select topic from channel)), 0,
  'a non-reader of the document receives nothing on its channel');
select throws_ok($$select pg_temp.send('presence')$$, '42501', null, 'and cannot join it with presence');
select throws_ok($$select pg_temp.send('broadcast')$$, '42501', null, 'nor broadcast on it');
select pg_temp.as_platform();

select * from finish();
rollback;
