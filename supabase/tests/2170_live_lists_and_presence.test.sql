-- pgTAP: 2170, live lists and presence (A123, RRR-168, ADR 0083). The tables behind the projects, procurement,
-- vendors, work orders, advancing and people lists are in the Realtime publication with row level security on, and the
-- presence channels presence:<table>:<row id> admit only people who can read the row: Realtime authorizes a private
-- channel by setting realtime.topic and the caller's role, then reading (to receive) and inserting (to track presence)
-- channel messages, so a non-reader sees nobody and cannot join.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(30);

-- Live lists -----------------------------------------------------------------------------------------------------------
create temporary table live_tables (table_name text);
insert into live_tables values ('projects'), ('purchase_orders'), ('po_lines'), ('goods_receipts'), ('rfqs'),
  ('vendors'), ('work_orders'), ('advance_packets'), ('advance_submissions'), ('memberships'), ('role_assignments'),
  ('requisitions'), ('agreements');

select is(
  (select count(*)::int from pg_catalog.pg_publication_tables p
   where p.pubname = 'supabase_realtime' and p.schemaname = 'app' and p.tablename in (select table_name from live_tables)),
  13, 'the projects, procurement, vendors, work order, advancing and people lists stream their changes');
select is(
  (select count(*)::int from pg_catalog.pg_publication_tables p
   where p.pubname = 'supabase_realtime' and p.schemaname = 'app'
     and p.tablename in ('shipments', 'dock_slots', 'marshalling_log', 'incidents', 'dispatch_assignments')),
  5, 'the logistics lists and the dispatch board follow tables published before (0440, 0470)');
select is_empty($$
  select t.table_name from live_tables t
  join pg_catalog.pg_class c on c.relname = t.table_name and c.relnamespace = 'app'::regnamespace
  where not c.relrowsecurity
     or not exists (select 1 from pg_catalog.pg_policy pol where pol.polrelid = c.oid and pol.polcmd in ('r', '*'))
$$, 'each newly published table keeps row level security and a read policy, so a change reaches only its readers');
select is_empty($$
  select t.table_name from live_tables t
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'app' and c.table_name = t.table_name and c.column_name = 'org_id')
$$, 'and has the org_id a page narrows its subscription by');

-- The presence registry and its rule ---------------------------------------------------------------------------------------
select is((select count(*)::int from private.presence_subjects
           where table_name in ('app.records', 'app.documents', 'app.sops', 'app.incidents', 'app.purchase_orders',
                                'app.goods_receipts', 'app.rfqs', 'app.vendors')),
  8, 'eight tables show presence on their record pages, peeks and documents');
select is_empty($$
  select s.table_name from private.presence_subjects s
  where to_regclass(s.table_name) is null
     or not exists (select 1 from pg_catalog.pg_policy pol where pol.polrelid = to_regclass(s.table_name) and pol.polcmd in ('r', '*'))
$$, 'each is an existing table with a read policy to decide who may join');
select ok((select prosecdef and proconfig @> array['search_path=""']
           from pg_proc where oid = 'private.presence_can_join(text)'::regprocedure),
  'the join rule runs with owner rights and an empty search path');
select ok(not has_function_privilege('anon', 'private.presence_can_join(text)', 'execute')
  and has_function_privilege('authenticated', 'private.presence_can_join(text)', 'execute'),
  'signed-in people''s channel joins may evaluate it; anonymous callers may not');

-- Records follow invariant 2: project members and assigned people read them, not the whole org.
select pg_temp.as_user('dave');
with x as (
  insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Hang the banner', 'Y', 'Declared') returning id
) insert into world select 'task', id from x;
select pg_temp.as_user('carol');
with x as (
  insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a2'), 'Meeting', 'Gala Planning Session', 'Y', 'Declared') returning id
) insert into world select 'gala', id from x;
select pg_temp.as_platform();

create temporary table topic (key text, value text);
grant all on topic to public;
insert into topic values
  ('task', 'presence:records:' || pg_temp.id('task')),
  ('gala', 'presence:records:' || pg_temp.id('gala')),
  ('unlisted', 'presence:organizations:' || pg_temp.id('org_a')),
  ('document', 'doc:' || pg_temp.id('task'));
create function pg_temp.topic(p_key text) returns text language sql as $$ select value from topic where key = p_key $$;

select pg_temp.claims('carol');
select ok(private.presence_can_join(pg_temp.topic('task')), 'a Manager, who reads every project''s records, may join a record''s channel');
select ok(not private.presence_can_join(pg_temp.topic('unlisted')), 'but not a channel of a table that shows no presence');
select ok(not private.presence_can_join(pg_temp.topic('document')), 'nor a topic that is not a presence channel');
select ok(not private.presence_can_join('presence:records:not-a-uuid'), 'and a malformed topic answers false');
select pg_temp.claims('frank');
select ok(private.presence_can_join(pg_temp.topic('task')), 'a Field member joins a record of the project they work on');
select ok(not private.presence_can_join(pg_temp.topic('gala')), 'but not one of a project they are not in');
select pg_temp.claims('dave');
select ok(not private.presence_can_join(pg_temp.topic('gala')), 'nor does a Member outside the project');
select pg_temp.claims('gina');
select ok(not private.presence_can_join(pg_temp.topic('task')), 'a Viewer in no project may not join, though in the org');
select pg_temp.claims('xavier');
select ok(not private.presence_can_join(pg_temp.topic('task')), 'nor may another org''s owner');
select pg_temp.as_platform();

-- The rules call the function by its oid, so a policy needs no usage on the private schema; calling it by name above
-- took the claims under the postgres role.

-- The channel rules ----------------------------------------------------------------------------------------------------------
select policy_cmd_is('realtime', 'messages', 'xos_presence_channel_read', 'select', 'receiving on presence:<table>:<id> has its rule');
select policy_cmd_is('realtime', 'messages', 'xos_presence_channel_write', 'insert', 'tracking presence there has its rule');

create function pg_temp.join_channel(p_user text, p_topic text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(p_user);
  perform set_config('realtime.topic', pg_temp.topic(p_topic), true);
end $$;

-- Realtime stamps each message now; the message lands in today's partition.
create function pg_temp.send(p_extension text) returns void
language sql as $$
  insert into realtime.messages (topic, extension, event, payload, private)
  values (current_setting('realtime.topic'), p_extension, 'presence', '{"name": "Carol"}'::jsonb, true);
$$;

create function pg_temp.received() returns integer
language sql as $$
  select count(*)::int from realtime.messages where topic = current_setting('realtime.topic');
$$;

-- Messages are partitioned by day and only realtime.messages' owner may add a partition (see 2060's test). Where no
-- partition covers today, no message can be stored and Realtime authorizes nothing, so these checks are skipped.
create function pg_temp.channel_rules_applied() returns setof text
language plpgsql as $$
begin
  if not exists (
    select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'realtime.messages'::regclass
      and localtimestamp >= substring(pg_get_expr(c.relpartbound, c.oid) from $re$FROM \('([^']+)'\)$re$)::timestamp
      and localtimestamp < substring(pg_get_expr(c.relpartbound, c.oid) from $re$TO \('([^']+)'\)$re$)::timestamp
  ) then
    return next skip('Realtime has made no partition of realtime.messages for today on this database', 11);
    return;
  end if;

  perform pg_temp.join_channel('carol', 'task');
  return next lives_ok($q$select pg_temp.send('presence')$q$, 'a reader of the record tracks presence on its channel');
  return next is(pg_temp.received(), 1, 'and receives it');
  return next throws_ok($q$select pg_temp.send('broadcast')$q$, '42501', null, 'but nobody broadcasts on a presence channel');

  perform pg_temp.join_channel('frank', 'task');
  return next is(pg_temp.received(), 1, 'another reader sees who is present');
  return next lives_ok($q$select pg_temp.send('presence')$q$, 'and joins with presence too');

  perform pg_temp.join_channel('gina', 'task');
  return next is(pg_temp.received(), 0, 'a non-reader of the record sees nobody on its channel');
  return next throws_ok($q$select pg_temp.send('presence')$q$, '42501', null, 'and cannot join it');

  perform pg_temp.join_channel('frank', 'gala');
  return next throws_ok($q$select pg_temp.send('presence')$q$, '42501', null, 'nor can a member join the channel of a record they cannot read');

  perform pg_temp.join_channel('xavier', 'task');
  return next is(pg_temp.received(), 0, 'another org sees nobody on it either');
  return next throws_ok($q$select pg_temp.send('presence')$q$, '42501', null, 'and cannot join it');

  perform pg_temp.join_channel('carol', 'unlisted');
  return next throws_ok($q$select pg_temp.send('presence')$q$, '42501', null, 'nor can anyone join a channel of a table without presence');
  perform pg_temp.as_platform();
end $$;

select * from pg_temp.channel_rules_applied();

select * from finish();
rollback;
