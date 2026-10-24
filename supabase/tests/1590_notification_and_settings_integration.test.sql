-- pgTAP: migration 1590, the batch-c audit fixes joined with A89's 1461 (RRR-125). private.notify and
-- app.claim_notification_deliveries keep 1461's marketplace match and personal quiet hours and get back 1393's actor and
-- bypass window, which now also caps the push of someone with no membership. The 1393 and 1461 suites run against
-- these definitions too: this one covers what only the join does. ivy works with org_a through an engagement and has
-- no membership; her quiet hours are set relative to now in UTC. Last, the SMS summary claim settles and claims only a
-- held text's live queue row, never the one a release retired; Dave's zone is pinned with an Etc/GMT offset where it is
-- now day. Neither part depends on the clock.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(10);

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

-- 4. The SMS summary touches only a held text's live queue row ---------------------------------------------------------
-- Each held text below has a row a release retired (as 1393's release leaves it: deleted, not sent) and a live row due
-- now, as when a released text is held again. Dave's zone is one where it is now day, outside the 21:00 to 08:00 text
-- window, so the summary claims his texts instead of holding them again (as 1393's suite pins it). Left to the org's
-- project zone, America/New_York, the claim would hold them again whenever the suite ran at night there.
create function pg_temp.day_zone() returns text
language sql stable as $$
  select z.name from pg_catalog.pg_timezone_names z
  where z.name ~ '^Etc/GMT[+-][0-9]+$' and (now() at time zone z.name)::time between time '10:00' and time '16:00'
  order by z.name limit 1
$$;

insert into app.notification_settings (membership_id, time_zone) values (pg_temp.id('dave@org_a'), pg_temp.day_zone());
update auth.users set phone = '15555550122', phone_confirmed_at = now() where id = pg_temp.id('dave_user');
insert into app.sms_consent_events (org_id, person_id, phone_e164, action, source)
values (pg_temp.id('org_a'), pg_temp.id('dave'), '+15555550122', 'Opt In', 'Web');
select pg_temp.as_user('dave');
select app.set_my_notification_preferences(pg_temp.id('org_a'), '[
  {"category": "approvals", "channel": "SMS", "enabled": true},
  {"category": "account", "channel": "SMS", "enabled": true}]'::jsonb);
select pg_temp.as_platform();

create function pg_temp.held_twice(p_kind text) returns uuid
language plpgsql as $$
declare
  v_notification uuid := private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), p_kind, null, null, null,
    '{"title": "Rigging rental", "actorName": "Bob Okafor", "days": 1}');
  v_delivery app.notification_deliveries;
begin
  select d.* into v_delivery from app.notification_deliveries d where d.notification_id = v_notification and d.channel = 'SMS';
  perform private.hold_sms_for_summary(v_delivery.id, v_delivery.notification_created_at, pg_temp.id('dave@org_a'), now());
  update app.sms_summary_queue set due_at = now() - interval '2 hours', deleted_at = now() - interval '1 hour'
  where notification_delivery_id = v_delivery.id;
  perform private.hold_sms_for_summary(v_delivery.id, v_delivery.notification_created_at, pg_temp.id('dave@org_a'),
    now() - interval '1 minute');
  return v_delivery.id;
end;
$$;

-- Both of a delivery's queue rows, the live one first: settled (sent_at set), claimed (due again in 10 minutes), or as
-- held_twice left it.
create function pg_temp.rows(p_delivery uuid) returns text
language sql as $$
  select string_agg(case when q.deleted_at is null then 'live ' else 'retired ' end
    || case when q.sent_at is not null then 'settled'
            when q.due_at = now() + interval '10 minutes' then 'claimed'
            when q.due_at in (now() - interval '2 hours', now() - interval '1 minute') then 'untouched'
            else 'due ' || q.due_at::text end, ', ' order by q.deleted_at nulls first)
  from app.sms_summary_queue q where q.notification_delivery_id = p_delivery
$$;

select pg_temp.held_twice('approval.requested') as v_claimed_text \gset
select is((select held_count from app.claim_sms_summaries() s where s.recipient_person_id = pg_temp.id('dave')), 1,
  'the summary claims the held text once');
select is(pg_temp.rows(:'v_claimed_text'), 'live claimed, retired untouched',
  'claiming it moves the live row on and leaves the retired row as it was');

-- A category-scoped unsubscribe drops the held text; the account text keeps the summary going.
insert into app.suppression_list (org_id, channel, address, reason, category_code)
values (pg_temp.id('org_a'), 'SMS', '+15555550122', 'Unsubscribe', 'approvals');
select pg_temp.held_twice('approval.requested') as v_dropped_text \gset
select pg_temp.held_twice('billing.payment_failed') as v_kept_text \gset
select app.claim_sms_summaries();
-- Dave loses his verified number: the next summary is suppressed.
update auth.users set phone_confirmed_at = null where id = pg_temp.id('dave_user');
select pg_temp.held_twice('billing.payment_failed') as v_suppressed_text \gset
select app.claim_sms_summaries();
select is(pg_temp.rows(:'v_dropped_text') || '; ' || pg_temp.rows(:'v_suppressed_text'),
  'live settled, retired untouched; live settled, retired untouched',
  'dropping a category''s text or suppressing the summary settles the live row only');

select * from finish();
rollback;
