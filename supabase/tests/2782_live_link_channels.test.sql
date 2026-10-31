-- pgTAP: migration 2782, P1 (RRR-215, ADR 0130). Live link channels: api_public.live_channel_open is true only for the
-- channel of a link that is not revoked, deleted or expired, and follows regeneration; the anon channel rule is on
-- realtime.messages for anon only, registered with a roles column while 2060's rules keep authenticated; the ping
-- triggers are in place, three per table; and a write pings the link's channel with an empty message, or goes on
-- without one where Realtime cannot store it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(24);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update, delete on k to public;

create function pg_temp.val(p_key text) returns text
language sql stable as $$ select val from k where key = p_key $$;

create function pg_temp.topic(p_key text) returns text
language sql stable as $$
  select 'xlink:' || c.channel_key from private.live_link_channels c where c.live_link_id = (select id from k where key = p_key)
$$;

select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Opening Night', current_date + 5) returning id)
  insert into world select 'ros', id from x;
insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros'), 1, 'House to Half');
insert into k select 'd', l.live_link_id, l.token from app.create_display_link(pg_temp.id('ros')) l;
select pg_temp.as_platform();
insert into k values ('d:topic', null, pg_temp.topic('d'));

-- The channel lifecycle ---------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is(api_public.live_channel_open(pg_temp.val('d:topic')), true, 'a live link''s channel is open to anon');
select is(api_public.live_channel_open('xlink:xlch_' || repeat('0', 64)), false, 'an unknown channel key is not');
select is(api_public.live_channel_open('live:1'), false, 'nor a topic of another shape');
select is(api_public.live_channel_open(null), false, 'nor no topic');
select pg_temp.as_platform();

select pg_temp.as_user('dave');
select app.regenerate_live_link((select id from k where key = 'd'));
select pg_temp.as_platform();
insert into k values ('d:topic2', null, pg_temp.topic('d'));
select pg_temp.as_anon();
select is(api_public.live_channel_open(pg_temp.val('d:topic')), false, 'regenerating closes the old channel');
select is(api_public.live_channel_open(pg_temp.val('d:topic2')), true, 'and opens a new one');
select pg_temp.as_platform();

select pg_temp.as_user('dave');
select app.revoke_live_link((select id from k where key = 'd'));
select pg_temp.as_platform();
select pg_temp.as_anon();
select is(api_public.live_channel_open(pg_temp.val('d:topic2')), false, 'revoking closes the channel for good');
select pg_temp.as_platform();

select pg_temp.as_user('dave');
insert into k select 'd2', l.live_link_id, l.token from app.create_display_link(pg_temp.id('ros')) l;
select pg_temp.as_platform();
insert into k values ('d2:topic', null, pg_temp.topic('d2'));
-- Expire it as the platform would see it later: the guard lets only the RPCs write, so move the clock instead.
select is((select api_public.live_channel_open(pg_temp.val('d2:topic'))), true, 'a new link''s channel is open');
select ok(not exists (select 1 from app.live_links l join private.live_link_channels c on c.live_link_id = l.id
  where 'xlink:' || c.channel_key = pg_temp.val('d2:topic') and l.expires_at <= now()), 'until its expiry, which is ahead');

-- The rule --------------------------------------------------------------------------------------------------------------
select has_column('private', 'realtime_channel_policies', 'roles', 'the channel rule registry names each rule''s roles');
select is((select roles from private.realtime_channel_policies where policy_name = 'xos_live_link_channel_read'), array['anon'],
  'the live link rule is registered for anon');
select is((select count(*)::int from private.realtime_channel_policies where policy_name <> 'xos_live_link_channel_read' and roles <> array['authenticated']), 0,
  'every other rule keeps authenticated');
select has_table('realtime', 'messages', 'Realtime''s messages table exists on this stack');
select policy_cmd_is('realtime', 'messages', 'xos_live_link_channel_read', 'select', 'receiving on a live link channel has its rule');
select policy_roles_are('realtime', 'messages', 'xos_live_link_channel_read', array['anon'], 'for anon, the publishable key a screen joins with');
select policy_roles_are('realtime', 'messages', 'xos_doc_channel_read', array['authenticated'], 'while 2060''s document rule keeps authenticated');
select policy_roles_are('realtime', 'messages', 'xos_gateway_channel_read', array['authenticated'], 'and 2161''s Gateway rule too');

-- Triggers -------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and t.tgname like 't96_live_link_ping_%'
    and c.relname in ('records', 'run_of_show', 'cues', 'day_sheets', 'saved_views', 'saved_view_filters', 'saved_view_sorts')), 21,
  'records, running orders, cues, day sheets, saved views, filters and sorts each have insert, update and delete ping triggers');
select has_trigger('app', 'live_links', 't96_live_link_ping_update', 'a revoked or regenerated link pings its screens');
select lives_ok($$select private.live_link_ping(array['xlink:xlch_' || repeat('0', 64)])$$, 'a ping never fails, with or without Realtime');

-- Pings -----------------------------------------------------------------------------------------------------------------
create function pg_temp.pings(p_topic text) returns integer
language sql as $$ select count(*)::int from realtime.messages where topic = p_topic and event = 'changed' $$;

create function pg_temp.pings_applied() returns setof text
language plpgsql as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null or not exists (
    select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'realtime.messages'::regclass
      and localtimestamp >= substring(pg_get_expr(c.relpartbound, c.oid) from $re$FROM \('([^']+)'\)$re$)::timestamp
      and localtimestamp < substring(pg_get_expr(c.relpartbound, c.oid) from $re$TO \('([^']+)'\)$re$)::timestamp
  ) then
    return next skip('Realtime has made no partition of realtime.messages for today on this database', 3);
    return;
  end if;
  delete from realtime.messages where topic like 'xlink:%';
  perform pg_temp.as_user('dave');
  update app.cues set label = 'House to Half (slow)' where run_of_show_id = pg_temp.id('ros');
  perform pg_temp.as_platform();
  return next is(pg_temp.pings(pg_temp.val('d2:topic')), 1, 'a cue change pings its display link''s channel once per statement');
  return next is((select payload - 'id' from realtime.messages where topic = pg_temp.val('d2:topic') limit 1), '{}'::jsonb,
    'with an empty message');
  return next is(pg_temp.pings(pg_temp.val('d:topic2')), 0, 'and never a revoked link''s');
end $$;

select * from pg_temp.pings_applied();

-- Without any live link a write is untouched.
select pg_temp.as_user('dave');
select lives_ok($$update app.cues set label = 'House to Half' where run_of_show_id = (select id from world where key = 'ros')$$,
  'a write with live links present goes on');

select * from finish();
rollback;
