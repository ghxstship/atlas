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

create temporary table channel (topic text);
grant all on channel to public;
insert into channel values ('doc:' || pg_temp.id('doc'));

create function pg_temp.join_channel(p_key text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(p_key);
  perform set_config('realtime.topic', (select topic from channel), true);
end $$;

-- Realtime stamps each message now; the message lands in today's partition.
create function pg_temp.send(p_extension text) returns void
language sql as $$
  insert into realtime.messages (topic, extension, event, payload, private)
  select topic, p_extension, 'yjs', '{"update": "AQI="}'::jsonb, true from channel;
$$;

create function pg_temp.received() returns integer
language sql as $$
  select count(*)::int from realtime.messages where topic = (select topic from channel);
$$;

-- Messages are partitioned by day. Realtime makes the partitions from yesterday to a few days ahead (the CLI's schema
-- setup does too, so `supabase db start` has them), and only realtime.messages' owner may add one. Where no partition
-- covers today, no message can be stored and Realtime authorizes nothing, so these checks are skipped.
create function pg_temp.channel_rules_applied() returns setof text
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

  perform pg_temp.join_channel('carol');
  return next lives_ok($q$select pg_temp.send('broadcast')$q$, 'a writer broadcasts on the document''s channel');
  return next lives_ok($q$select pg_temp.send('presence')$q$, 'and tracks presence there');
  return next is(pg_temp.received(), 2, 'and receives both');

  perform pg_temp.join_channel('gina');
  return next is(pg_temp.received(), 2, 'a reader receives the broadcasts and presence');
  return next throws_ok($q$select pg_temp.send('broadcast')$q$, '42501', null, 'but a reader''s broadcast is refused');
  return next lives_ok($q$select pg_temp.send('presence')$q$, 'while a reader may track presence');

  perform pg_temp.join_channel('xavier');
  return next is(pg_temp.received(), 0, 'a non-reader of the document receives nothing on its channel');
  return next throws_ok($q$select pg_temp.send('presence')$q$, '42501', null, 'and cannot join it with presence');
  return next throws_ok($q$select pg_temp.send('broadcast')$q$, '42501', null, 'nor broadcast on it');
  perform pg_temp.as_platform();
end $$;

select * from pg_temp.channel_rules_applied();

select * from finish();
rollback;
