-- pgTAP: migration 6900, A145 follow-up (RRR-243, ADR 0119 amendment). A running order's channel show:<run id>:
-- private.show_channel_can_join is true only for a reader of the running order; the channel rule is registered for
-- authenticated, receiving only; a cue call, by app.call_cue or a cue inserted called, sends one called message with the
-- cue's id and call time and nothing else; other writes send none; and readers receive the message where non-readers
-- see nothing.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Opening Night', current_date + 5) returning id)
  insert into world select 'ros', id from x;
with x as (insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros'), 1, 'House to Half') returning id)
  insert into world select 'cue1', id from x;
with x as (insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros'), 2, 'Walk-in Music Out') returning id)
  insert into world select 'cue2', id from x;
select pg_temp.as_user('carol');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a2'), 'Gala Night', current_date + 6) returning id)
  insert into world select 'gala', id from x;
select pg_temp.as_platform();

create temporary table topic (key text, value text);
grant all on topic to public;
insert into topic values
  ('ros', 'show:' || pg_temp.id('ros')),
  ('gala', 'show:' || pg_temp.id('gala')),
  ('presence', 'presence:records:' || pg_temp.id('ros'));
create function pg_temp.topic(p_key text) returns text language sql as $$ select value from topic where key = p_key $$;

-- The join rule ------------------------------------------------------------------------------------------------------------
select ok((select prosecdef and proconfig @> array['search_path=""']
           from pg_proc where oid = 'private.show_channel_can_join(text)'::regprocedure),
  'the join rule runs with owner rights and an empty search path');
select ok(not has_function_privilege('anon', 'private.show_channel_can_join(text)', 'execute')
  and has_function_privilege('authenticated', 'private.show_channel_can_join(text)', 'execute'),
  'signed-in people''s channel joins may evaluate it; anonymous callers may not');

select pg_temp.claims('frank');
select ok(private.show_channel_can_join(pg_temp.topic('ros')), 'a member of the project joins its running order''s channel');
select ok(not private.show_channel_can_join(pg_temp.topic('gala')), 'but not one of a project they are not in');
select pg_temp.claims('carol');
select ok(private.show_channel_can_join(pg_temp.topic('ros')), 'a Manager, who reads every project, joins it too');
select ok(not private.show_channel_can_join(pg_temp.topic('presence')), 'a topic that is not a show channel answers false');
select ok(not private.show_channel_can_join('show:not-a-uuid'), 'and so does a malformed one');
select pg_temp.claims('gina');
select ok(not private.show_channel_can_join(pg_temp.topic('ros')), 'a Viewer in no project may not join, though in the org');
select pg_temp.claims('xavier');
select ok(not private.show_channel_can_join(pg_temp.topic('ros')), 'nor may another org''s owner');
select pg_temp.as_platform();

-- The rule -----------------------------------------------------------------------------------------------------------------
select is((select roles from private.realtime_channel_policies where policy_name = 'xos_show_channel_read'), array['authenticated'],
  'the show channel rule is registered for authenticated');
select is((select command from private.realtime_channel_policies where policy_name = 'xos_show_channel_read'), 'select',
  'to receive only');
select has_table('realtime', 'messages', 'Realtime''s messages table exists on this stack');
select policy_cmd_is('realtime', 'messages', 'xos_show_channel_read', 'select', 'receiving on a show channel has its rule');
select policy_roles_are('realtime', 'messages', 'xos_show_channel_read', array['authenticated'], 'for signed-in people');
select is((select count(*)::int from pg_policy p where p.polrelid = 'realtime.messages'::regclass
  and pg_get_expr(coalesce(p.polqual, p.polwithcheck), p.polrelid) like '%show_channel_can_join%' and p.polcmd <> 'r'), 0,
  'and there is no send rule: only the database sends');
select has_trigger('app', 'cues', 't97_broadcast_cue_called', 'a cue call sends its message');
select has_trigger('app', 'cues', 't97_broadcast_cue_called_insert', 'so does a cue inserted called');

-- Messages -------------------------------------------------------------------------------------------------------------------
create function pg_temp.calls(p_topic text) returns integer
language sql as $$ select count(*)::int from realtime.messages where topic = p_topic and event = 'called' $$;

create function pg_temp.join_channel(p_user text, p_topic text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(p_user);
  perform set_config('realtime.topic', pg_temp.topic(p_topic), true);
end $$;

create function pg_temp.received() returns integer
language sql as $$
  select count(*)::int from realtime.messages where topic = current_setting('realtime.topic') and event = 'called';
$$;

-- Messages are partitioned by day and only realtime.messages' owner may add a partition (see 2060's test). Where no
-- partition covers today, no message can be stored, so these checks are skipped.
create function pg_temp.calls_sent() returns setof text
language plpgsql as $$
declare
  v_called timestamptz;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null or not exists (
    select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'realtime.messages'::regclass
      and localtimestamp >= substring(pg_get_expr(c.relpartbound, c.oid) from $re$FROM \('([^']+)'\)$re$)::timestamp
      and localtimestamp < substring(pg_get_expr(c.relpartbound, c.oid) from $re$TO \('([^']+)'\)$re$)::timestamp
  ) then
    return next skip('Realtime has made no partition of realtime.messages for today on this database', 12);
    return;
  end if;
  delete from realtime.messages where topic like 'show:%';

  perform pg_temp.as_user('dave');
  update app.cues set label = 'House to Half (slow)' where id = pg_temp.id('cue1');
  perform pg_temp.as_platform();
  return next is(pg_temp.calls(pg_temp.topic('ros')), 0, 'editing a cue sends no call');

  perform pg_temp.as_user('dave');
  v_called := app.call_cue(pg_temp.id('cue1'));
  perform pg_temp.as_platform();
  return next is(pg_temp.calls(pg_temp.topic('ros')), 1, 'calling a cue sends one called message to its running order''s channel');
  return next is((select payload - 'id' from realtime.messages where topic = pg_temp.topic('ros') and event = 'called'),
    jsonb_build_object('cue_id', pg_temp.id('cue1'), 'called_at', v_called),
    'carrying the cue''s id and its call time, nothing else');
  return next is((select private from realtime.messages where topic = pg_temp.topic('ros') and event = 'called'), true,
    'on the private channel');
  return next is((select extension from realtime.messages where topic = pg_temp.topic('ros') and event = 'called'), 'broadcast',
    'as a broadcast');

  perform pg_temp.as_user('dave');
  update app.cues set label = 'House to Half' where id = pg_temp.id('cue1');
  perform pg_temp.as_platform();
  return next is(pg_temp.calls(pg_temp.topic('ros')), 1, 'a later edit of the called cue sends nothing more');

  perform pg_temp.as_user('dave');
  insert into app.cues (run_of_show_id, position, label, called_at, called_by)
    values (pg_temp.id('ros'), 3, 'Host Welcome', now(), (select id from world where key = 'dave'));
  perform pg_temp.as_platform();
  return next is(pg_temp.calls(pg_temp.topic('ros')), 2, 'a cue inserted called sends its message too');
  return next is(pg_temp.calls(pg_temp.topic('gala')), 0, 'and another running order''s channel hears none of it');

  perform pg_temp.join_channel('frank', 'ros');
  return next is(pg_temp.received(), 2, 'a member of the project receives the calls');
  perform pg_temp.join_channel('gina', 'ros');
  return next is(pg_temp.received(), 0, 'a Viewer in no project receives none');
  perform pg_temp.join_channel('xavier', 'ros');
  return next is(pg_temp.received(), 0, 'nor does another org');
  perform pg_temp.join_channel('frank', 'ros');
  return next throws_ok($q$insert into realtime.messages (topic, extension, event, payload, private)
      values (current_setting('realtime.topic'), 'broadcast', 'called', '{}'::jsonb, true)$q$, '42501', null,
    'and nobody sends on the channel: only the database does');
  perform pg_temp.as_platform();
end $$;

select * from pg_temp.calls_sent();

select pg_temp.as_user('dave');
select lives_ok($$select app.call_cue((select id from world where key = 'cue2'))$$,
  'a call goes on whether or not a message could be sent');

select * from finish();
rollback;
