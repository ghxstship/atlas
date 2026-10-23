-- pgTAP: migration 1590, the batch-c audit fixes joined with A89's 1461 (RRR-125). private.notify and
-- app.claim_notification_deliveries keep 1461's marketplace match and personal quiet hours and get back 1393's actor and
-- bypass window, which now also caps the push of someone with no membership. The 1393 and 1461 suites run against
-- these definitions too: this one covers what only the join does. ivy works with org_a through an engagement and has
-- no membership; her quiet hours are set relative to now in UTC, so the suite never depends on the clock.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(7);

create function pg_temp.push(p_notification uuid) returns app.notification_deliveries
language sql as $$
  select d.* from app.notification_deliveries d where d.notification_id = p_notification and d.channel = 'Push'
$$;

create function pg_temp.shift_change(p_starts_in interval) returns uuid
language sql as $$
  select private.notify(pg_temp.id('org_a'), pg_temp.id('ivy'), 'shift.changed', null, null, null,
    jsonb_build_object('title', 'Load in', 'startsAt', now() + p_starts_in));
$$;

create function pg_temp.quiet(p_on boolean) returns void
language sql as $$
  select app.set_my_quiet_hours('UTC',
    case when p_on then ((now() at time zone 'UTC') - interval '1 hour')::time end,
    case when p_on then ((now() at time zone 'UTC') + interval '10 hours')::time end);
$$;

-- Quiet hours from an hour ago to ten hours from now: longer than a shift 12.5 hours away leaves before its window.
select pg_temp.as_user('ivy');
select pg_temp.quiet(true);
select pg_temp.as_platform();

-- 1. The actor (1393) reaches a notification to an external party, through 1461's path for people with no membership.
select pg_temp.shift_change(interval '12 hours 30 minutes') as v_window \gset
select is((select n.message_args ->> 'actorName' from app.notifications n where n.id = :'v_window'), 'Northwind Live',
  'with nobody signed in, the org is the actor of a notification to someone with no membership');

-- 2. At queue time her push waits out her own quiet hours (1461), no later than the bypass window's opening (1393).
select is((pg_temp.push(:'v_window')).message_status::text, 'Deferred', 'her push about a shift 12.5 hours away waits');
select is((pg_temp.push(:'v_window')).deliver_after, now() + interval '30 minutes',
  'only until the shift is 12 hours away, as a member''s would');
select is((pg_temp.push(pg_temp.shift_change(interval '30 hours'))).deliver_after, now() + interval '10 hours',
  'a shift further away waits for the end of her quiet hours');

-- 3. At claim time: quiet hours that began after the push was queued hold it again, no later than the window.
select pg_temp.as_user('ivy');
select pg_temp.quiet(false);
select pg_temp.as_platform();
select pg_temp.shift_change(interval '12 hours 30 minutes') as v_claimed \gset
select is((pg_temp.push(:'v_claimed')).message_status::text, 'Queued', 'without quiet hours her push is queued at once');
select pg_temp.as_user('ivy');
select pg_temp.quiet(true);
select pg_temp.as_platform();
select is((select count(*)::integer from app.claim_notification_deliveries('Push', 500) c
           where c.delivery_id = (pg_temp.push(:'v_claimed')).id), 0,
  'claimed inside her quiet hours, it is not handed to the sender');
select is((pg_temp.push(:'v_claimed')).message_status::text || ' ' || (pg_temp.push(:'v_claimed')).deliver_after::text,
  'Deferred ' || (now() + interval '30 minutes')::text, 'it waits again, only until the window opens');

select * from finish();
rollback;
