-- pgTAP: migration 1393, fixes to the notification dispatcher and the SMS senders (RRR-125): a Twilio status callback
-- settles every held text a summary carried, and held texts honor a category-scoped SMS suppression. Zones are pinned
-- with Etc/GMT offsets where it is now night (inside 21:00 to 08:00) or day, so the suite never depends on the clock.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(8);

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

select * from finish();
rollback;
