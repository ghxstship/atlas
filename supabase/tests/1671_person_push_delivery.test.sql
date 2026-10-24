-- pgTAP: migration 1671 (A101, RRR-147, trace rows S4.3-15 and S4.4-20). A push reaches an external party's own
-- Compass device and a marketplace user's own browser when they have no device registered with the org, and only for
-- an org they work with or a listing open to them (invariant 3). A member's push still goes to the devices registered
-- with the org, exactly as before. A marketplace match open to a person who works with no org is no longer suppressed.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(23);

create function pg_temp.deliveries(p_notification uuid, p_channel app.notification_channel default 'Push')
returns setof app.notification_deliveries
language sql as $$
  select d.* from app.notification_deliveries d where d.notification_id = p_notification and d.channel = p_channel
$$;

create function pg_temp.due(p_notification uuid) returns void
language sql as $$
  update app.notification_deliveries set message_status = 'Queued', deliver_after = now() where notification_id = p_notification
$$;

create temporary table keys (endpoint text, p256dh text, auth text);
insert into keys values ('https://push.example.test/send/gateway-nina', 'B' || repeat('Nn', 43), repeat('Au', 11));
grant select on keys to authenticated;

-- ivy works with org_a and org_b as freelance crew; nina works with no org; alice and dave are members of org_a.
select pg_temp.as_user('ivy');
select app.register_push_device('ExponentPushToken[ivy-compass-0001]', 'ios') as v_ivy \gset
select pg_temp.as_user('nina');
select app.register_push_device('ExponentPushToken[nina-compass-001]', 'android') as v_nina \gset
select app.register_web_push('Gateway', (select endpoint from keys), (select p256dh from keys), (select auth from keys));
select pg_temp.as_user('alice');
select app.register_push_device('ExponentPushToken[alice-own-00001]', 'ios') as v_alice_own \gset
insert into app.push_subscriptions (membership_id, expo_push_token, platform)
values (pg_temp.id('alice@org_a'), 'ExponentPushToken[alice-org-a-0001]', 'ios') returning id as v_alice_org \gset
select pg_temp.as_user('dave');
select app.register_push_device('ExponentPushToken[dave-own-000001]', 'ios');
select pg_temp.as_platform();

-- 1. The fallback rule.
select ok(private.person_push_fallback(pg_temp.id('ivy'), pg_temp.id('org_a'), 'invoice.paid', 'invoices', null),
  'ivy has no device registered with org_a and works with it: her own devices take its pushes');
select ok(not private.person_push_fallback(pg_temp.id('nina'), pg_temp.id('org_b'), 'invoice.paid', 'invoices', null),
  'nina works with org_b in no way: her devices never carry its pushes');
select ok(not private.person_push_fallback(pg_temp.id('alice'), pg_temp.id('org_a'), 'approval.requested', null, null),
  'alice has a device registered with org_a: it takes the push, not her own');

-- 2. An external party's Compass device.
insert into world select 'n_ivy', private.notify(pg_temp.id('org_a'), pg_temp.id('ivy'), 'invoice.paid', 'invoices', gen_random_uuid(), null, '{}');
create temporary table ivy1 as select * from app.claim_notification_deliveries('Push', 500) c where c.notification_id = pg_temp.id('n_ivy');
select is((select push_devices from ivy1), jsonb_build_array(jsonb_build_object('subscriptionId', :'v_ivy', 'token', 'ExponentPushToken[ivy-compass-0001]')),
  'the claim hands the sender ivy''s own Compass device, where it suppressed the push as having no device');
select lives_ok($$select app.record_push_tickets((select delivery_id from ivy1), jsonb_build_array(jsonb_build_object(
  'subscriptionId', (select push_devices -> 0 ->> 'subscriptionId' from ivy1), 'status', 'ok', 'ticketId', 'tkt-ivy-1')))$$,
  'the sender records Expo''s ticket for it');
select is((select t.person_push_device_id::text || ' ' || t.org_id::text || ' ' || t.message_status::text from app.push_tickets t where t.expo_ticket_id = 'tkt-ivy-1'),
  :'v_ivy' || ' ' || pg_temp.id('org_a')::text || ' Sent', 'a ticket names her device and takes the delivery''s org');
select pg_temp.due(pg_temp.id('n_ivy'));
create temporary table ivy2 as select * from app.claim_notification_deliveries('Push', 500) c where c.notification_id = pg_temp.id('n_ivy');
select is((select push_devices from ivy2), '[]'::jsonb, 'a retry never pushes her device twice');
select is((select count(*)::int from ivy2), 1, 'and only needs its outcome recorded');

-- 3. An org the party no longer works with gets nothing.
insert into world select 'n_ivy_b', private.notify(pg_temp.id('org_b'), pg_temp.id('ivy'), 'invoice.paid', 'invoices', gen_random_uuid(), null, '{}');
select isnt(pg_temp.id('n_ivy_b'), null, 'org_b notifies ivy while she works with it');
update app.engagements set deleted_at = now() where id = pg_temp.id('eng_ivy_b');
select is((select count(*)::int from app.claim_notification_deliveries('Push', 500) c where c.notification_id = pg_temp.id('n_ivy_b')), 0,
  'once she no longer does, the claim hands over nothing');
select is((select d.last_error from pg_temp.deliveries(pg_temp.id('n_ivy_b')) d), 'Recipient no longer belongs to the org or works with it.',
  'the push is suppressed with the reason');
select is((select count(*)::int from app.push_tickets t join pg_temp.deliveries(pg_temp.id('n_ivy_b')) d on d.id = t.notification_delivery_id), 0,
  'and her device is never pushed');

-- 4. A marketplace user's devices: an Invited listing of org_a for nina, who works with no org.
select pg_temp.as_user('carol');
insert into app.opportunities (project_id, role_type, title, visibility, rate_type, deadline_at, starts_on, ends_on)
values (pg_temp.id('prj_a'), 'Vendor', 'Summer Series Delay Towers', 'Invited', 'Bid', now() + interval '20 days', '2027-06-01', '2027-06-03')
returning id as v_opp \gset
insert into world values ('opp', :'v_opp');
insert into app.opportunity_invitations (opportunity_id, person_id) values (pg_temp.id('opp'), pg_temp.id('nina'));
select app.transition_opportunity(pg_temp.id('opp'), 'Draft', 'Pending Approval', 'Ready.');
select app.transition_opportunity(pg_temp.id('opp'), 'Pending Approval', 'Published', 'Approved.');
select pg_temp.as_platform();
insert into world select 'n_nina', private.notify(pg_temp.id('org_a'), pg_temp.id('nina'), 'opportunity.matched', 'opportunities',
  pg_temp.id('opp'), pg_temp.id('prj_a'), jsonb_build_object('title', 'Summer Series Delay Towers', 'count', 1, 'gatewayPath', '/explore/alerts'));
create temporary table nina_email as select * from app.claim_notification_deliveries('Email', 500) c where c.notification_id = pg_temp.id('n_nina');
select is((select address from nina_email), 'nina@nowhere.test',
  'the match''s email goes out: a listing open to her is reason enough, though she works with no org');
create temporary table nina_push as select * from app.claim_notification_deliveries('Push', 500) c where c.notification_id = pg_temp.id('n_nina');
select is((select jsonb_agg(d ->> 'token' order by d ->> 'token' nulls last) from nina_push, jsonb_array_elements(push_devices) d),
  jsonb_build_array('ExponentPushToken[nina-compass-001]', null),
  'the push goes to her own Compass device and her Gateway browser');
select is((select w.endpoint || ' ' || w.app from nina_push c, app.web_push_devices(c.delivery_id) w), (select endpoint from keys) || ' Gateway',
  'the Web Push sender reads her browser''s endpoint, which opens Gateway');
select lives_ok($$select app.record_web_push_tickets((select delivery_id from nina_push), jsonb_build_array(jsonb_build_object(
  'subscriptionId', (select w.subscription_id from nina_push c, app.web_push_devices(c.delivery_id) w), 'status', 'ok')))$$,
  'and records the push service''s 201');
select is((select t.message_status::text || ' ' || t.push_service from app.push_tickets t
           join nina_push c on c.delivery_id = t.notification_delivery_id where t.person_push_device_id is not null),
  'Delivered Web Push', 'as Delivered by Web Push');
select is((select count(*)::int from nina_push c, app.web_push_devices(c.delivery_id) w), 0, 'so a retry never pushes her browser twice');

-- 5. Members: the devices registered with the org, exactly as before.
insert into world select 'n_alice', private.notify(pg_temp.id('org_a'), pg_temp.id('alice'), 'approval.requested');
select is((select push_devices from app.claim_notification_deliveries('Push', 500) c where c.notification_id = pg_temp.id('n_alice')),
  jsonb_build_array(jsonb_build_object('subscriptionId', :'v_alice_org', 'token', 'ExponentPushToken[alice-org-a-0001]')),
  'alice''s push goes to her org_a device only, never also to her own');
insert into world select 'n_dave', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested');
select is((select count(*)::int from app.claim_notification_deliveries('Push', 500) c where c.notification_id = pg_temp.id('n_dave')), 0,
  'a member with no device registered with the org gets no push on his own devices');
select is((select d.last_error from pg_temp.deliveries(pg_temp.id('n_dave')) d), 'No registered device.', 'it is suppressed as before');

-- 6. Receipts prune a person's device Expo no longer knows.
set local session_replication_role = replica;
update app.push_tickets set created_at = now() - interval '20 minutes' where expo_ticket_id = 'tkt-ivy-1';
set local session_replication_role = origin;
select is(app.record_push_receipts('[{"ticketId": "tkt-ivy-1", "status": "error", "error": "DeviceNotRegistered", "message": "gone"}]'::jsonb), 1,
  'a receipt saying the device is gone prunes one device');
select ok((select revoked_at is not null from app.person_push_devices where id = :'v_ivy'), 'ivy''s own device, revoked for later claims');

select * from finish();
rollback;
