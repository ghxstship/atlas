-- pgTAP: the owner's refinements of the SMS quiet hours (A80, RRR-125, ADR 0033 decision 35): the registry's bypass
-- list (safety alerts and imminent shift changes only; an urgent or mandatory category alone never bypasses), the
-- recipient's time zone fallback (never UTC), and held texts sent together as one summary when quiet hours end.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(29);

create function pg_temp.status(p_notification uuid, p_channel app.notification_channel) returns text
language sql as $$
  select d.message_status::text from app.notification_deliveries d where d.notification_id = p_notification and d.channel = p_channel
$$;

-- A zone where it is now night (inside 21:00 to 08:00) and one where it is now day.
create function pg_temp.zone(p_night boolean) returns text
language sql stable as $$
  select z.name from pg_timezone_names z
  where z.name like '%/%' and z.name not like 'posix/%' and z.name not like 'Etc/%'
    and case when p_night then (now() at time zone z.name)::time >= time '21:30' or (now() at time zone z.name)::time < time '07:30'
             else (now() at time zone z.name)::time between time '10:00' and time '18:00' end
  order by z.name limit 1
$$;

create temporary table n (key text primary key, id uuid);
grant select on n to public;

-- 1. The bypass list --------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok(private.bypasses_quiet_hours('weather.alert', '{}'::jsonb, now())
  and private.bypasses_quiet_hours('incident.reported', '{}'::jsonb, now())
  and private.bypasses_quiet_hours('occupancy.threshold', '{}'::jsonb, now()), 'safety alerts bypass quiet hours');
select ok(private.bypasses_quiet_hours('shift.changed', jsonb_build_object('startsAt', now() + interval '3 hours'), now()),
  'a change to a shift starting within 12 hours bypasses');
select ok(not private.bypasses_quiet_hours('shift.changed', jsonb_build_object('startsAt', now() + interval '20 hours'), now()),
  'a change to a shift starting later waits');
select ok(not private.bypasses_quiet_hours('shift.changed', '{}'::jsonb, now())
  and not private.bypasses_quiet_hours('shift.changed', '{"startsAt": "soon"}'::jsonb, now()),
  'a shift change without a readable start waits');
select ok(not private.bypasses_quiet_hours('account.recovery_code_used', '{}'::jsonb, now())
  and not private.bypasses_quiet_hours('billing.payment_failed', '{}'::jsonb, now()),
  'an urgent category alone does not bypass quiet hours');
-- Owner decision 24 (1620) added a new shift within 12 hours, security changes and emergency access.
select is((select count(*)::integer from private.notification_quiet_hours_bypass), 7, 'the list is short: seven kinds');

-- 2. The recipient's time zone, never UTC -----------------------------------------------------------------------------
select is(private.recipient_time_zone(pg_temp.id('org_p'), pg_temp.id('paul'), null), null::text,
  'with no zone and no project anywhere there is no zone, never UTC by default');
update app.projects set time_zone = 'America/Chicago' where id = pg_temp.id('prj_a2');
select ok(private.recipient_time_zone(pg_temp.id('org_a'), pg_temp.id('dave'), null) in ('America/Chicago', 'America/New_York'),
  'with nothing else, the zone of one of the org''s projects (the newest)');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'locale.time_zone', 'Organization', pg_temp.id('org_a'), 'Europe/Lisbon', null, null, false);
select pg_temp.as_platform();
select is(private.recipient_time_zone(pg_temp.id('org_a'), pg_temp.id('dave'), null), 'Europe/Lisbon', 'then the org''s own zone');
set local session_replication_role = replica;
insert into app.engagements (org_id, project_id, person_id, role_type, role_code, worker_classification, start_date, engagement_state)
values (pg_temp.id('org_a'), pg_temp.id('prj_a2'), pg_temp.id('dave'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', current_date, 'Active');
set local session_replication_role = origin;
select is(private.recipient_time_zone(pg_temp.id('org_a'), pg_temp.id('dave'), null), 'America/Chicago',
  'the engagement''s project zone comes before the org''s');
select is(private.recipient_time_zone(pg_temp.id('org_a'), pg_temp.id('dave'), pg_temp.id('prj_a')), 'America/New_York',
  'the zone of the project the notification is about comes before the engagement''s');
select pg_temp.as_user('dave');
select app.set_personal_setting('locale.time_zone', null, 'Asia/Tokyo', null, null);
select pg_temp.as_platform();
select is(private.recipient_time_zone(pg_temp.id('org_a'), pg_temp.id('dave'), pg_temp.id('prj_a')), 'Asia/Tokyo',
  'the person''s own locale.time_zone comes before any project');
select pg_temp.as_user('dave');
select app.set_my_notification_settings(pg_temp.id('org_a'), pg_temp.zone(true), null, null, 'Off', 8::smallint);
select is(app.my_notification_time_zone(pg_temp.id('org_a')), pg_temp.zone(true),
  'the zone of their own notification settings comes first, and it is the form''s default');

-- 3. Held texts become one summary; bypass kinds and push go at once ------------------------------------------------------
select pg_temp.as_platform();
update auth.users set phone = '15555550122', phone_confirmed_at = now() where id = pg_temp.id('dave_user');
insert into app.sms_consent_events (org_id, person_id, phone_e164, action, source)
values (pg_temp.id('org_a'), pg_temp.id('dave'), '+15555550122', 'Opt In', 'Web');
insert into app.org_mandatory_notification_categories (org_id, category_code) values (pg_temp.id('org_a'), 'approvals');
insert into app.org_notification_defaults (org_id, category_code, channel, enabled) values (pg_temp.id('org_a'), 'approvals', 'SMS', true);
select pg_temp.as_user('dave');
select app.set_my_notification_preferences(pg_temp.id('org_a'), '[
  {"category": "account", "channel": "SMS", "enabled": true},
  {"category": "schedule", "channel": "SMS", "enabled": true},
  {"category": "safety", "channel": "SMS", "enabled": true}]'::jsonb);
select pg_temp.as_platform();

insert into n values ('approval_1', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested', null, null, null, '{"title": "Rigging rental"}'));
insert into n values ('approval_2', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested', null, null, null, '{"title": "Catering"}'));
insert into n values ('security', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'billing.payment_failed', null, null, null, '{"days": 1}'));
insert into n values ('shift_far', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'shift.changed', null, null, null,
  jsonb_build_object('title', 'Load out', 'startsAt', now() + interval '30 hours')));
insert into n values ('shift_soon', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'shift.changed', null, null, null,
  jsonb_build_object('title', 'Load in', 'startsAt', now() + interval '2 hours')));
insert into n values ('weather', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'weather.alert', null, null, null, '{"title": "Lightning"}'));

select is(pg_temp.status((select id from n where key = 'approval_1'), 'SMS'), 'Digest',
  'at night a text is held for the summary, even in a mandatory category');
select is(pg_temp.status((select id from n where key = 'security'), 'SMS'), 'Digest', 'and in an urgent category');
select is(pg_temp.status((select id from n where key = 'shift_far'), 'SMS'), 'Digest', 'and for a shift starting tomorrow');
select is(pg_temp.status((select id from n where key = 'shift_soon'), 'SMS'), 'Queued', 'a change to a shift starting soon goes at once');
select is(pg_temp.status((select id from n where key = 'weather'), 'SMS'), 'Queued', 'a safety alert goes at once');
select is(pg_temp.status((select id from n where key = 'approval_1'), 'Push'), 'Queued',
  'push is never held for the summary (no quiet hours of their own)');
select is((select count(*)::integer from app.sms_summary_queue where membership_id = pg_temp.id('dave@org_a') and sent_at is null), 4,
  'four held texts wait in the summary queue');
select ok((select bool_and((q.due_at at time zone pg_temp.zone(true))::time = time '08:00') from app.sms_summary_queue q
           where q.membership_id = pg_temp.id('dave@org_a')), 'due at 08:00 in the recipient''s zone');
select is((select count(*)::integer from app.claim_notification_deliveries('SMS', 50)), 2,
  'only the two bypassing texts are claimed on their own');
select is((select count(*)::integer from app.claim_sms_summaries()), 0, 'no summary while it is night');

-- Morning: the member's zone is now in daytime and the held texts are due.
update app.notification_settings set time_zone = pg_temp.zone(false) where membership_id = pg_temp.id('dave@org_a');
update app.sms_summary_queue set due_at = now() - interval '1 minute' where membership_id = pg_temp.id('dave@org_a');
create temporary table summary as select * from app.claim_sms_summaries();
select is((select concat_ws('|', address, held_count, cardinality(delivery_ids)) from summary), '+15555550122|4|4',
  'one summary per member and org carries all four held texts');
select is((select kind from summary), 'billing.payment_failed', 'its line is the most important text: an urgent category first');
select is((select count(*)::integer from app.claim_sms_summaries()), 0, 'a claimed summary is not claimed twice');
select app.record_sms_summary((select delivery_ids from summary), 'Sent', 'SM-summary-1', null);
select ok((select bool_and(d.message_status = 'Sent' and d.provider_message_id = 'SM-summary-1') from app.notification_deliveries d
           where d.id = any ((select delivery_ids from summary)::uuid[])), 'one text settles every held delivery');
select is((select count(*)::integer from app.usage_events where meter_code = 'sms_segments' and org_id = pg_temp.id('org_a')), 1,
  'and counts as one text');
select throws_ok($$select app.record_sms_summary('{}'::uuid[], 'Sent')$$, 'XR001', null, 'a summary carries at least one held text');

select * from finish();
rollback;
