-- pgTAP: migration 2925, B3 (RRR-227, ADR 0142). Showcaller link channels: api_public.showcaller_channel_open is true only
-- for the xcall: channel of a link that is not revoked, deleted or expired, and follows regeneration; the anon channel
-- rule is registered for anon and has no send rule; the ping triggers are in place on running orders, cues, department
-- calls, segment colors and custom field values; a write pings the link's channel with an empty message, or goes on
-- without one where Realtime cannot store it; and a link that expired, though never revoked, is pinged no more.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update, delete on k to public;

create function pg_temp.val(p_key text) returns text
language sql stable as $$ select val from k where key = p_key $$;

create function pg_temp.topic(p_key text) returns text
language sql stable as $$
  select 'xcall:' || c.channel_key from private.showcaller_link_channels c where c.showcaller_link_id = (select id from k where key = p_key)
$$;

select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Opening Night', current_date + 5) returning id)
  insert into world select 'ros', id from x;
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Second Night', current_date + 6) returning id)
  insert into world select 'ros2', id from x;
insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros'), 1, 'House to Half'), (pg_temp.id('ros2'), 1, 'Doors');
insert into k select 's', l.showcaller_link_id, l.token from app.create_showcaller_link(pg_temp.id('ros'), 'Sam Okafor') l;
insert into k select 'e', l.showcaller_link_id, l.token from app.create_showcaller_link(pg_temp.id('ros2'), 'Lee Park') l;
select pg_temp.as_platform();
insert into k values ('s:topic', null, pg_temp.topic('s')), ('e:topic', null, pg_temp.topic('e'));
-- The second night's only link has expired; expiry never revokes a link.
select private.begin_trusted_operation('showcaller_link_service');
update app.showcaller_links set expires_at = now() - interval '1 minute' where id = (select id from k where key = 'e');
select private.end_trusted_operation('showcaller_link_service');

-- The channel lifecycle -------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is(api_public.showcaller_channel_open(pg_temp.val('s:topic')), true, 'a live link''s channel is open to anon');
select is(api_public.showcaller_channel_open('xcall:xcch_' || repeat('0', 64)), false, 'an unknown channel key is not');
select is(api_public.showcaller_channel_open(replace(pg_temp.val('s:topic'), 'xcall:', 'xlink:')), false,
  'nor the key under a live link''s prefix');
select is(api_public.showcaller_channel_open(null), false, 'nor no topic');
select pg_temp.as_platform();

select pg_temp.as_user('dave');
select app.regenerate_showcaller_link((select id from k where key = 's'));
select pg_temp.as_platform();
insert into k values ('s:topic2', null, pg_temp.topic('s'));
select pg_temp.as_anon();
select is(api_public.showcaller_channel_open(pg_temp.val('s:topic')), false, 'regenerating closes the old channel');
select is(api_public.showcaller_channel_open(pg_temp.val('s:topic2')), true, 'and opens a new one');
select pg_temp.as_platform();

-- The rule ---------------------------------------------------------------------------------------------------------------------
select is((select roles from private.realtime_channel_policies where policy_name = 'xos_showcaller_channel_read'), array['anon'],
  'the showcaller rule is registered for anon');
select is((select command from private.realtime_channel_policies where policy_name = 'xos_showcaller_channel_read'), 'select',
  'to receive only');
select has_table('realtime', 'messages', 'Realtime''s messages table exists on this stack');
select policy_cmd_is('realtime', 'messages', 'xos_showcaller_channel_read', 'select', 'receiving on a showcaller channel has its rule');
select policy_roles_are('realtime', 'messages', 'xos_showcaller_channel_read', array['anon'], 'for anon, the publishable key a portal joins with');
select is((select count(*)::int from pg_policy p where p.polrelid = 'realtime.messages'::regclass
  and pg_get_expr(coalesce(p.polqual, p.polwithcheck), p.polrelid) like '%showcaller_channel_open%' and p.polcmd <> 'r'), 0,
  'and there is no send rule: only the database sends');

-- Triggers -----------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and t.tgname like 't96_showcaller_link_ping_%'
    and c.relname in ('run_of_show', 'cues', 'cue_calls', 'run_segment_colors', 'custom_field_values')), 15,
  'running orders, cues, department calls, segment colors and custom field values each have insert, update and delete ping triggers');
select has_trigger('app', 'showcaller_links', 't96_showcaller_link_ping_update', 'a revoked or regenerated link pings its portal');
select has_index('app', 'showcaller_links', 'showcaller_links_live_expiry_idx', 'the probe for an unexpired live link has its index');

-- Pings ------------------------------------------------------------------------------------------------------------------------------
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
    return next skip('Realtime has made no partition of realtime.messages for today on this database', 5);
    return;
  end if;
  delete from realtime.messages where topic like 'xcall:%';
  perform pg_temp.as_user('dave');
  update app.cues set label = 'House to Half (slow)' where run_of_show_id = pg_temp.id('ros');
  perform pg_temp.as_platform();
  return next is(pg_temp.pings(pg_temp.val('s:topic2')), 1, 'a cue change pings its link''s channel once per statement');
  return next is((select payload - 'id' from realtime.messages where topic = pg_temp.val('s:topic2') limit 1), '{}'::jsonb,
    'with an empty message');
  delete from realtime.messages where topic like 'xcall:%';
  perform pg_temp.as_user('dave');
  update app.cues set label = 'Doors (late)' where run_of_show_id = pg_temp.id('ros2');
  perform pg_temp.as_platform();
  return next is(pg_temp.pings(pg_temp.val('s:topic2')), 0, 'another running order''s change never pings it');
  perform pg_temp.as_user('dave');
  perform app.revoke_showcaller_link((select id from k where key = 's'));
  perform pg_temp.as_platform();
  return next is(pg_temp.pings(pg_temp.val('s:topic2')), 1, 'revoking pings the portal, which rereads and shows it is gone');
  -- Now no link is live anywhere: the second night's is expired, though not revoked.
  perform pg_temp.as_user('dave');
  update app.cues set label = 'Doors (later)' where run_of_show_id = pg_temp.id('ros2');
  perform pg_temp.as_platform();
  return next is(pg_temp.pings(pg_temp.val('e:topic')), 0, 'a running order whose only link has expired sends no ping');
end $$;

select * from pg_temp.pings_applied();

select pg_temp.as_user('dave');
select lives_ok($$update app.cues set label = 'House to Half' where run_of_show_id = (select id from world where key = 'ros')$$,
  'a write goes on whether or not a ping could be sent');

select * from finish();
rollback;
