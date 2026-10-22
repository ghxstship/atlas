-- pgTAP: migration 1393, fixes to the notification dispatcher and the SMS senders (RRR-125): a Twilio status callback
-- settles every held text a summary carried; held texts honor a category-scoped SMS suppression; every notification
-- names its actor; a held shift change goes once its bypass window opens; senders read the recipient's language and
-- zone in the org, live values only; texts count their billed segments. Zones are pinned with Etc/GMT offsets where
-- it is now night (inside 21:00 to 08:00) or day, or with quiet hours relative to now, so the suite never depends on
-- the clock.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(43);

-- A fixed-offset zone where it is now night (22:00 to 06:00) or day (10:00 to 16:00).
create function pg_temp.zone(p_night boolean) returns text
language sql stable as $$
  select z.name from pg_catalog.pg_timezone_names z
  where z.name ~ '^Etc/GMT[+-][0-9]+$'
    and case when p_night then (now() at time zone z.name)::time >= time '22:00' or (now() at time zone z.name)::time < time '06:00'
             else (now() at time zone z.name)::time between time '10:00' and time '16:00' end
  order by z.name limit 1
$$;

create function pg_temp.sms(p_notification uuid) returns app.notification_deliveries
language sql as $$
  select d.* from app.notification_deliveries d where d.notification_id = p_notification and d.channel = 'SMS'
$$;

-- Night for Dave, then the held texts come due in the morning.
create function pg_temp.morning() returns void
language sql as $$
  update app.notification_settings set time_zone = pg_temp.zone(false) where membership_id = pg_temp.id('dave@org_a');
  update app.sms_summary_queue set due_at = now() - interval '1 minute' where membership_id = pg_temp.id('dave@org_a') and sent_at is null;
$$;
create function pg_temp.night() returns void
language sql as $$
  update app.notification_settings set time_zone = pg_temp.zone(true) where membership_id = pg_temp.id('dave@org_a');
$$;

create temporary table n (key text primary key, id uuid);
grant select on n to public;

select pg_temp.as_platform();
update auth.users set phone = '15555550122', phone_confirmed_at = now() where id = pg_temp.id('dave_user');
insert into app.sms_consent_events (org_id, person_id, phone_e164, action, source)
values (pg_temp.id('org_a'), pg_temp.id('dave'), '+15555550122', 'Opt In', 'Web');
insert into app.notification_settings (membership_id, time_zone) values (pg_temp.id('dave@org_a'), pg_temp.zone(true));
select pg_temp.as_user('dave');
select app.set_my_notification_preferences(pg_temp.id('org_a'), '[
  {"category": "approvals", "channel": "SMS", "enabled": true},
  {"category": "account", "channel": "SMS", "enabled": true},
  {"category": "schedule", "channel": "SMS", "enabled": true}]'::jsonb);
select pg_temp.as_platform();

-- 1. A status callback settles every held text of the summary ------------------------------------------------------------
insert into n values ('a1', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested', null, null, null,
  '{"title": "Rigging rental", "actorName": "Bob Okafor"}'));
insert into n values ('a2', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested', null, null, null,
  '{"title": "Catering", "actorName": "Bob Okafor"}'));
select pg_temp.morning();
create temporary table s1 as select * from app.claim_sms_summaries();
select is((select held_count from s1), 2, 'one summary carries both held texts');
select app.record_sms_summary((select delivery_ids from s1), 'Sent', 'SM-1393-summary', null);
select ok(app.record_sms_status('SM-1393-summary', 'undelivered', '30003 Unreachable destination handset'), 'the callback names a known text');
select is((select count(*)::integer from app.notification_deliveries d
           where d.id = any ((select delivery_ids from s1)::uuid[]) and d.message_status = 'Bounced'
             and d.last_error = '30003 Unreachable destination handset'), 2,
  'an undelivered summary bounces every held text it carried, not only the newest');
select ok(not app.record_sms_status('SM-unknown', 'delivered', null), 'an unknown SID is reported');

-- 2. A category-scoped suppression drops only that category's held texts -------------------------------------------------
select pg_temp.night();
insert into app.suppression_list (org_id, channel, address, reason, category_code)
values (pg_temp.id('org_a'), 'SMS', '+15555550122', 'Unsubscribe', 'approvals');
insert into n values ('a3', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested', null, null, null,
  '{"title": "Lighting rental", "actorName": "Bob Okafor"}'));
insert into n values ('sec', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'account.security_changed', null, null, null,
  '{"change": "password"}'));
select pg_temp.morning();
create temporary table s2 as select * from app.claim_sms_summaries();
select is((select concat_ws('|', held_count, kind) from s2), '1|account.security_changed',
  'the summary leaves out the held text of the unsubscribed category');
select is((select concat_ws('|', message_status, last_error) from pg_temp.sms((select id from n where key = 'a3'))),
  'Suppressed|Address is on the suppression list.', 'that text is suppressed, as a single text would be');
select app.record_sms_summary((select delivery_ids from s2), 'Sent', 'SM-1393-summary-2', null);

select pg_temp.night();
insert into n values ('a4', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested', null, null, null,
  '{"title": "Staging rental", "actorName": "Bob Okafor"}'));
select pg_temp.morning();
select is((select count(*)::integer from app.claim_sms_summaries()), 0, 'no summary goes when every held text is unsubscribed');
select is((pg_temp.sms((select id from n where key = 'a4'))).message_status::text, 'Suppressed', 'and the held text is settled');

-- 3. Every notification names its actor ------------------------------------------------------------------------------------
create function pg_temp.actor(p_recipient text, p_kind text) returns text
language sql as $$
  select n.message_args ->> 'actorName' from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_recipient) and n.kind = p_kind order by n.created_at desc, n.id desc limit 1
$$;

create temporary table c (key text primary key, id uuid);
grant select, insert on c to public;
select pg_temp.as_user('dave');
insert into c values ('dm', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('erin@org_a')));
select app.send_chat_message((select id from c where key = 'dm'), 'Truck two is at the dock.');
select pg_temp.as_platform();
select is(pg_temp.actor('erin', 'message.received'), 'Dave Lindqvist', 'a chat message names its sender');

select pg_temp.as_user('erin');
select app.set_personal_setting('me.out_of_office.enabled', null, p_value_boolean => true);
select app.set_personal_setting('me.out_of_office.auto_reply', null, p_value_text => 'Off until Monday. Ask Carol.');
select pg_temp.as_user('dave');
select app.send_chat_message((select id from c where key = 'dm'), 'Can you check the rider?');
select pg_temp.as_platform();
select is(pg_temp.actor('dave', 'message.received'), 'Erin Castillo', 'an automatic reply names the person away, not the sender it answers');

select pg_temp.as_user('alice');
insert into c values ('post', app.create_feed_post(pg_temp.id('org_a'), 'Announcement', 'Gate C opens at noon.', 'Gate C',
  p_publish_at => now() + interval '1 hour'));
select pg_temp.as_platform();
update app.feed_posts set publish_at = now() - interval '1 minute' where id = (select id from c where key = 'post');
select private.publish_due_feed_posts();
select is(pg_temp.actor('dave', 'announcement.posted'), 'Alice Moreno', 'a scheduled post published by the job names its author');

select private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'survey.opened', null, null, null, '{"title": "Load-in pulse"}');
select is(pg_temp.actor('dave', 'survey.opened'), 'Northwind Live', 'with nobody signed in, the org is the actor');
select pg_temp.claims('carol');
select private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'recognition.received', null, null, null, '{"title": "Great save"}');
select is(pg_temp.actor('dave', 'recognition.received'), 'Carol Nguyen', 'otherwise the signed-in person is');
select private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested', null, null, null,
  '{"title": "Catering", "actorName": "Bob Okafor"}');
select is(pg_temp.actor('dave', 'approval.requested'), 'Bob Okafor', 'an emitter''s own actor is kept');
-- private.notify_step_approvers passes the requester's full_name, null until they give one, and runs as the approver
-- whose decision moved the request on; 0580 and 1140 pass an empty name the same way.
select private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested', null, null, null,
  jsonb_build_object('title', 'Barricade rental', 'actorName', null::text));
select is(pg_temp.actor('dave', 'approval.requested'), 'Northwind Live',
  'an emitter''s actor with no name yet reads as the org, not as the signed-in person');
select private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'comment.created', null, null, null,
  '{"title": "Advance sheet", "actorName": ""}');
select is(pg_temp.actor('dave', 'comment.created'), 'Northwind Live', 'and so does an empty name');
select pg_temp.as_platform();

-- 4. A held shift change goes when its bypass window opens ------------------------------------------------------------------
-- Frank's own quiet hours run from an hour ago to ten hours from now, longer than the 12-hour window leaves.
update auth.users set phone = '15555550133', phone_confirmed_at = now() where id = pg_temp.id('frank_user');
insert into app.sms_consent_events (org_id, person_id, phone_e164, action, source)
values (pg_temp.id('org_a'), pg_temp.id('frank'), '+15555550133', 'Opt In', 'Web');
insert into app.notification_settings (membership_id, time_zone, quiet_hours_start, quiet_hours_end)
values (pg_temp.id('frank@org_a'), 'UTC', ((now() at time zone 'UTC') - interval '1 hour')::time,
  ((now() at time zone 'UTC') + interval '10 hours')::time);
select pg_temp.as_user('frank');
select app.set_my_notification_preferences(pg_temp.id('org_a'), '[{"category": "schedule", "channel": "SMS", "enabled": true}]'::jsonb);
select pg_temp.as_platform();
insert into n values ('shift_window', private.notify(pg_temp.id('org_a'), pg_temp.id('frank'), 'shift.changed', null, null, null,
  jsonb_build_object('title', 'Load in', 'startsAt', now() + interval '12 hours 30 minutes')));
insert into n values ('shift_later', private.notify(pg_temp.id('org_a'), pg_temp.id('frank'), 'shift.changed', null, null, null,
  jsonb_build_object('title', 'Load out', 'startsAt', now() + interval '30 hours')));
select is((select q.due_at from app.sms_summary_queue q where q.notification_delivery_id = (pg_temp.sms((select id from n where key = 'shift_window'))).id),
  now() + interval '30 minutes', 'a text about a shift 12.5 hours away waits only until the shift is 12 hours away');
select is((select d.message_status::text || ' ' || (d.deliver_after = now() + interval '30 minutes')::text from app.notification_deliveries d
           where d.notification_id = (select id from n where key = 'shift_window') and d.channel = 'Push'), 'Deferred true',
  'and so does its push, which the worker then claims and sends while the bypass holds');
select is((select q.due_at from app.sms_summary_queue q where q.notification_delivery_id = (pg_temp.sms((select id from n where key = 'shift_later'))).id),
  now() + interval '10 hours', 'a shift further away waits for the end of quiet hours');

-- Half an hour later the shift starts within 12 hours (simulated by moving its start nearer).
set local session_replication_role = replica;
update app.notifications set message_args = jsonb_set(message_args, '{startsAt}', to_jsonb(now() + interval '11 hours 30 minutes'))
where id = (select id from n where key = 'shift_window');
set local session_replication_role = origin;
update app.sms_summary_queue set due_at = now() - interval '1 minute'
where notification_delivery_id = (pg_temp.sms((select id from n where key = 'shift_window'))).id;
select is((select count(*)::integer from app.claim_sms_summaries() s where s.recipient_person_id = pg_temp.id('frank')), 0,
  'once its window opens the held text leaves the summary');
select is((pg_temp.sms((select id from n where key = 'shift_window'))).message_status::text, 'Queued', 'and is queued on its own');
select is((select count(*)::integer from app.claim_notification_deliveries('SMS', 50) c where c.recipient_person_id = pg_temp.id('frank')), 1,
  'the sender claims it at once, inside quiet hours');

-- A released text whose shift starts before it goes (a send that failed is retried after startsAt, or the sender was
-- down) is held again while Frank is still in quiet hours. Its released queue row was retired, so holding it opens a
-- new one, and the claim goes on to everyone else's texts instead of failing on the queue's unique key every time.
insert into n values ('shift_late', private.notify(pg_temp.id('org_a'), pg_temp.id('frank'), 'shift.changed', null, null, null,
  jsonb_build_object('title', 'Strike', 'startsAt', now() + interval '12 hours 30 minutes')));
set local session_replication_role = replica;
update app.notifications set message_args = jsonb_set(message_args, '{startsAt}', to_jsonb(now() + interval '11 hours 30 minutes'))
where id = (select id from n where key = 'shift_late');
set local session_replication_role = origin;
update app.sms_summary_queue set due_at = now() - interval '1 minute'
where notification_delivery_id = (pg_temp.sms((select id from n where key = 'shift_late'))).id;
select is((select count(*)::integer from app.claim_sms_summaries() s where s.recipient_person_id = pg_temp.id('frank')), 0,
  'a second shift change is released the same way');
select is((select concat_ws('|', count(*) filter (where q.deleted_at is null), count(*) filter (where q.sent_at is not null))
           from app.sms_summary_queue q where q.notification_delivery_id = (pg_temp.sms((select id from n where key = 'shift_late'))).id),
  '0|0', 'its queue row is retired, not marked sent');
select is((select count(*)::integer from app.claim_notification_deliveries('SMS', 50) c where c.delivery_id = (pg_temp.sms((select id from n where key = 'shift_late'))).id), 1,
  'the sender claims it');
select app.record_notification_delivery((pg_temp.sms((select id from n where key = 'shift_late'))).id, 'Failed', null, '503 Service Unavailable');
set local session_replication_role = replica;
update app.notifications set message_args = jsonb_set(message_args, '{startsAt}', to_jsonb(now() - interval '5 minutes'))
where id = (select id from n where key = 'shift_late');
set local session_replication_role = origin;
update app.notification_deliveries set deliver_after = now() - interval '1 second'
where id = (pg_temp.sms((select id from n where key = 'shift_late'))).id;
insert into n values ('dave_day', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'account.security_changed', null, null, null,
  '{"change": "password"}'));
select lives_ok($$select * from app.claim_notification_deliveries('SMS', 50)$$,
  'the retry, after the shift started and inside quiet hours, does not fail the claim');
select is((select concat_ws('|', d.message_status, (d.deliver_after = now() + interval '10 hours')::text) from app.notification_deliveries d
           where d.id = (pg_temp.sms((select id from n where key = 'shift_late'))).id), 'Digest|true',
  'the text is held for the summary again');
select is((select string_agg(concat_ws('|', (q.due_at = now() + interval '10 hours')::text, (q.sent_at is null)::text), ',')
           from app.sms_summary_queue q
           where q.notification_delivery_id = (pg_temp.sms((select id from n where key = 'shift_late'))).id and q.deleted_at is null),
  'true|true', 'in one new live queue row, due when quiet hours end');
select is((pg_temp.sms((select id from n where key = 'dave_day'))).attempt_count::integer, 1,
  'and the same claim sends the texts that came after it');

-- A queue row settled before a text is held again (as the release once left it) is retired, not a duplicate.
insert into n values ('shift_settled', private.notify(pg_temp.id('org_a'), pg_temp.id('frank'), 'shift.changed', null, null, null,
  jsonb_build_object('title', 'Doors', 'startsAt', now() + interval '40 hours')));
update app.sms_summary_queue set sent_at = now()
where notification_delivery_id = (pg_temp.sms((select id from n where key = 'shift_settled'))).id;
select lives_ok(format($$select private.hold_sms_for_summary(%L, %L, %L, %L)$$,
  (pg_temp.sms((select id from n where key = 'shift_settled'))).id, (pg_temp.sms((select id from n where key = 'shift_settled'))).notification_created_at,
  pg_temp.id('frank@org_a'), now() + interval '10 hours'), 'holding a text with a settled queue row does not fail');
select is((select concat_ws('|', count(*) filter (where q.deleted_at is null and q.sent_at is null), count(*) filter (where q.deleted_at is not null))
           from app.sms_summary_queue q where q.notification_delivery_id = (pg_temp.sms((select id from n where key = 'shift_settled'))).id),
  '1|1', 'it opens one live row and retires the settled one');

-- 5. A recipient's language and zone in the org, live values only -------------------------------------------------------
create function pg_temp.profile(p_person text, p_org text) returns text
language sql as $$
  select concat_ws('|', coalesce(app.recipient_setting(pg_temp.id(p_person), pg_temp.id(p_org), 'locale.language'), '-'),
    coalesce(app.recipient_setting(pg_temp.id(p_person), pg_temp.id(p_org), 'locale.time_zone'), '-'))
$$;
select pg_temp.as_user('erin');
select app.set_personal_setting('locale.language', null, 'es-US');
select app.set_personal_setting('locale.time_zone', null, 'Asia/Tokyo');
select pg_temp.as_platform();
select is(pg_temp.profile('erin', 'org_a'), 'es-US|Asia/Tokyo', 'a recipient is reached in their own language and zone');
select pg_temp.as_user('erin');
select app.clear_personal_setting('locale.language');
select app.clear_personal_setting('locale.time_zone');
select pg_temp.as_platform();
select is(pg_temp.profile('erin', 'org_a'), 'en-US|America/New_York',
  'cleared settings no longer apply: the default language, and the org''s project zone, never UTC');
select is(app.recipient_setting(pg_temp.id('erin'), null, 'locale.language'), null::text,
  'outside an org a cleared language is no value at all');
select pg_temp.as_user('bob');
select app.set_setting(pg_temp.id('org_a'), 'locale.language', 'Organization', pg_temp.id('org_a'), 'es-US');
select pg_temp.as_platform();
select is(app.recipient_setting(pg_temp.id('erin'), pg_temp.id('org_a'), 'locale.language'), 'es-US',
  'with no language of their own, the org''s applies');
select pg_temp.as_user('erin');
select app.set_personal_setting('locale.language', null, 'es-US');
select app.set_personal_setting('locale.language', pg_temp.id('org_a'), 'en-US');
select pg_temp.as_platform();
select is(pg_temp.profile('erin', 'org_a'), 'en-US|America/New_York',
  'a language kept for this org wins over the one for every org and over the org''s own');
select is(app.recipient_setting(pg_temp.id('erin'), pg_temp.id('org_b'), 'locale.language'), 'es-US',
  'and another org sees only the one for every org');
select pg_temp.as_user('bob');
select app.set_setting(pg_temp.id('org_a'), 'locale.language', 'Organization', pg_temp.id('org_a'), 'es-US', p_locked => true);
select pg_temp.as_platform();
select is(app.recipient_setting(pg_temp.id('erin'), pg_temp.id('org_a'), 'locale.language'), 'es-US',
  'an org that locks its language writes to everyone in it in that language');
select ok(not has_function_privilege('authenticated', 'app.recipient_setting(uuid, uuid, text)', 'execute'),
  'only the senders read a recipient''s settings');

-- 6. Texts count their billed segments --------------------------------------------------------------------------------------
create function pg_temp.usage(p_source uuid) returns text
language sql as $$
  select string_agg(u.meter_code || ' ' || u.quantity, ', ' order by u.meter_code) from app.usage_events u where u.source_id = p_source
$$;
select app.record_notification_delivery((pg_temp.sms((select id from n where key = 'shift_window'))).id, 'Sent', 'SM-1393-single', null, 3);
select is(pg_temp.usage((pg_temp.sms((select id from n where key = 'shift_window'))).id), 'sms_segments 3',
  'a single text counts the segments it was billed as');
select app.record_notification_delivery((select d.id from app.notification_deliveries d
  where d.notification_id = (select id from n where key = 'shift_window') and d.channel = 'Push'), 'Sent', 'tkt-1393', null, 5);
select is(pg_temp.usage((select d.id from app.notification_deliveries d
  where d.notification_id = (select id from n where key = 'shift_window') and d.channel = 'Push')), 'push_sent 1', 'a push still counts once');
select pg_temp.night();
insert into n values ('sec2', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'account.security_changed', null, null, null,
  '{"change": "email"}'));
insert into n values ('sec3', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'account.security_changed', null, null, null,
  '{"change": "phone"}'));
select pg_temp.morning();
create temporary table s3 as select * from app.claim_sms_summaries();
select app.record_sms_summary((select delivery_ids from s3), 'Sent', 'SM-1393-summary-3', null, 4);
select is(pg_temp.usage((select delivery_ids[1] from s3)), 'sms_segments 4', 'a summary text counts its segments, not one');
select app.record_notification_delivery((pg_temp.sms((select id from n where key = 'shift_later'))).id, 'Sent', 'SM-1393-zero', null, 0);
select is(pg_temp.usage((pg_temp.sms((select id from n where key = 'shift_later'))).id), 'sms_segments 1',
  'a text never counts less than one segment');

select * from finish();
rollback;
