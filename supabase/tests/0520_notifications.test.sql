-- pgTAP: notifications, deliveries, preferences, quiet hours, digests, suppression, push subscriptions
-- (Section 7.3 Messaging, Section 14.5, Section 7.5 invariant 3).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(40);

create function pg_temp.channels(p_notification uuid) returns text
language sql as $$
  select coalesce(string_agg(d.channel::text || ':' || d.message_status::text, ',' order by d.channel), '')
  from app.notification_deliveries d where d.notification_id = p_notification
$$;

-- Defaults and preferences ----------------------------------------------------------------------------
select pg_temp.as_platform();
create temporary table n (key text primary key, id uuid);
grant select on n to public;
insert into n values ('dave_1', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested', 'app.expenses', gen_random_uuid(), pg_temp.id('prj_a'), '{"title": "Rigging rental"}'));
select is(pg_temp.channels((select id from n where key = 'dave_1')), 'Email:Queued,Push:Queued',
  'by default a member gets email and push; SMS waits for an opt-in');
select is(private.notify(pg_temp.id('org_a'), pg_temp.id('xavier'), 'approval.requested'), null::uuid,
  'a person outside the org is never notified');
select throws_ok($$select private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'no.such_kind')$$, 'XR001', null,
  'only catalogued kinds are notified');

select pg_temp.as_user('dave');
insert into app.notification_preferences (membership_id, category_code, channel, enabled) values
  (pg_temp.id('dave@org_a'), 'approvals', 'Email', false),
  (pg_temp.id('dave@org_a'), 'approvals', 'SMS', true);
select throws_ok($$insert into app.notification_preferences (membership_id, category_code, channel, enabled)
  values (pg_temp.id('bob@org_a'), 'approvals', 'Email', false)$$, '42501', null, 'nobody sets another member''s preferences');
select pg_temp.as_platform();
insert into n values ('dave_2', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested'));
select is(pg_temp.channels((select id from n where key = 'dave_2')), 'SMS:Queued,Push:Queued',
  'preferences decide the channels by category');

-- Quiet hours and digests --------------------------------------------------------------------------------
select pg_temp.as_user('erin');
insert into app.notification_settings (membership_id, time_zone, quiet_hours_start, quiet_hours_end, digest_frequency, digest_hour)
values (pg_temp.id('erin@org_a'), 'UTC',
  ((now() at time zone 'UTC') - interval '1 hour')::time, ((now() at time zone 'UTC') + interval '1 hour')::time, 'Daily', 7);
select throws_ok($$insert into app.notification_settings (membership_id, time_zone) values (pg_temp.id('erin@org_a'), 'Mars/Olympus')$$,
  'XR001', null, 'settings need an IANA time zone');
select pg_temp.as_platform();
insert into n values ('erin_1', private.notify(pg_temp.id('org_a'), pg_temp.id('erin'), 'comment.created'));
select is(pg_temp.channels((select id from n where key = 'erin_1')), 'Email:Digest,Push:Deferred',
  'non-urgent push waits out quiet hours and email joins the digest');
select ok((select deliver_after > now() from app.notification_deliveries where notification_id = (select id from n where key = 'erin_1') and channel = 'Push'),
  'a deferred push is due when quiet hours end');
select is((select count(*)::integer from app.email_digest_queue where membership_id = pg_temp.id('erin@org_a')), 1,
  'the digest queue holds the email');
select ok((select extract(hour from due_at at time zone 'UTC') = 7 from app.email_digest_queue where membership_id = pg_temp.id('erin@org_a')),
  'the digest is due at the member''s digest hour');
insert into n values ('erin_2', private.notify(pg_temp.id('org_a'), pg_temp.id('erin'), 'incident.reported'));
select is(pg_temp.channels((select id from n where key = 'erin_2')), 'Email:Queued,Push:Queued',
  'urgent categories ignore quiet hours and digests');
select is(private.local_quiet_until(pg_temp.id('erin@org_a'), now() + interval '3 hours'), null::timestamptz,
  'outside quiet hours nothing waits');

-- Reading the inbox ------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.notifications), 2, 'a person reads their own notifications');
select is((select count(*)::integer from app.notification_deliveries), 4, 'and the deliveries of them');
select lives_ok($$update app.notifications set read_at = now() where id = (select id from n where key = 'dave_1')$$, 'a person marks one read');
select throws_ok($$update app.notifications set kind = 'comment.created' where id = (select id from n where key = 'dave_1')$$, 'XR001', null,
  'a notification is only marked read or archived');
select is(app.mark_notifications_read(pg_temp.id('org_a')), 1, 'a person marks the rest read');
select throws_ok($$insert into app.notifications (org_id, recipient_person_id, kind) values (pg_temp.id('org_a'), pg_temp.id('dave'), 'comment.created')$$,
  '42501', null, 'nobody inserts notifications directly');
select pg_temp.as_user('bob');
select is((select count(*)::integer from app.notifications where recipient_person_id = pg_temp.id('dave')), 0,
  'even an admin cannot read someone else''s notifications');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.notifications where org_id = pg_temp.id('org_a')), 0, 'no cross-tenant notification reads');

-- Leaving ends access, including notifications (invariant 3) --------------------------------------------------
select pg_temp.as_platform();
insert into n values ('gina_1', private.notify(pg_temp.id('org_a'), pg_temp.id('gina'), 'mention.created'));
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.notifications), 1, 'a member reads their notification');
select app.leave_organization(pg_temp.id('org_a'));
select is((select count(*)::integer from app.notifications), 0, 'inv_03_leaving_ends_access: after leaving, the notification is gone at once');
select pg_temp.as_platform();

-- Claiming and sending ------------------------------------------------------------------------------------------
create temporary table claimed as select * from app.claim_notification_deliveries('Email', 50);
grant select on claimed to public;
select ok((select count(*) from claimed where recipient_person_id = pg_temp.id('dave')) = 1, 'a due email is claimed for sending');
select is((select address from claimed where recipient_person_id = pg_temp.id('dave')), 'dave@northwind.test',
  'email goes only to the verified sign-in address');
select is((select email_template_code from claimed where recipient_person_id = pg_temp.id('dave')), 'notification',
  'the claim names the React Email template');
select is((select message_status from app.notification_deliveries where notification_id = (select id from n where key = 'gina_1') and channel = 'Email'),
  'Suppressed'::app.message_status, 'inv_03_leaving_ends_access: a delivery to someone who left the org is suppressed');
select is((select count(*)::integer from app.claim_notification_deliveries('Email', 50)), 0, 'a claimed delivery is not claimed twice');
select lives_ok($$select app.record_notification_delivery((select delivery_id from claimed where recipient_person_id = pg_temp.id('dave')), 'Sent', 're_123', null)$$,
  'the sender records a sent email');
select is((select count(*)::integer from app.usage_events where meter_code = 'emails_sent' and org_id = pg_temp.id('org_a')), 1,
  'a sent email counts toward usage');
select throws_ok($$select app.record_notification_delivery((select delivery_id from claimed where recipient_person_id = pg_temp.id('dave')), 'Queued')$$,
  'XR001', null, 'a sender records only outcomes');

select app.record_email_feedback(pg_temp.id('org_a'), 'Erin@Northwind.test', 'Hard Bounce');
select app.record_email_feedback(pg_temp.id('org_a'), 'erin@northwind.test', 'Hard Bounce');
select is((select count(*)::integer from app.suppression_list where address = 'erin@northwind.test'), 1, 'a bounce suppresses the address once');
update app.notification_deliveries set deliver_after = now() where notification_id = (select id from n where key = 'erin_2');
create temporary table claimed2 as select * from app.claim_notification_deliveries('Email', 50);
select is((select message_status from app.notification_deliveries where notification_id = (select id from n where key = 'erin_2') and channel = 'Email'),
  'Suppressed'::app.message_status, 'a suppressed address receives nothing');

create temporary table sms as select * from app.claim_notification_deliveries('SMS', 50);
select is((select last_error from app.notification_deliveries where notification_id = (select id from n where key = 'dave_2') and channel = 'SMS'),
  'No verified address on the channel.', 'SMS needs a verified phone number');

-- Suppression list and push subscriptions -----------------------------------------------------------------------
select pg_temp.as_user('bob');
select is((select count(*)::integer from app.suppression_list), 1, 'an admin reads the org''s suppression list');
select lives_ok($$insert into app.suppression_list (org_id, channel, address, reason) values (pg_temp.id('org_a'), 'Email', 'old@northwind.test', 'Manual')$$,
  'an admin suppresses an address');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.suppression_list), 0, 'a member reads no suppression list');
select lives_ok($$insert into app.push_subscriptions (membership_id, expo_push_token, platform)
  values (pg_temp.id('dave@org_a'), 'ExponentPushToken[abcdefghij0123456789]', 'ios')$$, 'a member registers a device');
select throws_ok($$insert into app.push_subscriptions (membership_id, expo_push_token, platform)
  values (pg_temp.id('dave@org_a'), 'not-a-token', 'ios')$$, '23514', null, 'only Expo push tokens are accepted');
select pg_temp.as_platform();
select is((select push_tokens[1] from app.claim_notification_deliveries('Push', 50) where recipient_person_id = pg_temp.id('dave') limit 1),
  'ExponentPushToken[abcdefghij0123456789]', 'push claims carry the member''s device tokens');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.push_subscriptions), 0, 'no cross-tenant device reads');

select * from finish();
rollback;
