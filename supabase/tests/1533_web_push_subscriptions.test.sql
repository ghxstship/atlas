-- pgTAP: browsers registered for Web Push (A96, RRR-141, A65-023, Section 4.10). A browser is registered for every org
-- the person belongs to, belongs to one person at a time, is listed by A80's claim function as a device with no token,
-- and the sender reads its endpoint and keys and records what the push service answered.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(20);

select has_column('app', 'push_subscriptions', 'web_endpoint', 'a browser keeps its push endpoint');
select has_column('app', 'push_subscriptions', 'web_app', 'and the app it subscribed in');
select has_column('app', 'push_tickets', 'push_service', 'tickets say which push service took them');

create temporary table keys (endpoint text, p256dh text, auth text);
insert into keys values ('https://push.example.test/send/browser-one', 'B' || repeat('Kq', 43), repeat('Au', 11));
grant select on keys to authenticated;

select pg_temp.as_user('alice');
select is(app.register_web_push('Atlas', (select endpoint from keys), (select p256dh from keys), (select auth from keys)),
  (select count(*)::int from app.memberships m where m.person_id = pg_temp.id('alice') and m.deleted_at is null),
  'turning browser notifications on registers the browser for each org alice belongs to');
select is((select count(*)::int from app.push_subscriptions ps
           where ps.web_endpoint = (select endpoint from keys) and ps.platform = 'web' and ps.expo_push_token is null
             and ps.web_app = 'Atlas'), 1, 'as a web row with no Expo token');
select throws_ok($$select app.register_web_push('Atlas', 'https://push.example.test/send/two', 'short', 'short')$$, '23514', null,
  'keys of the wrong length are refused');
select throws_ok($$select app.register_web_push('Compass', 'https://push.example.test/send/two', 'x', 'y')$$, 'XR001',
  'web_push_invalid: A browser subscription needs its app, its endpoint and both keys.', 'only Atlas and Gateway subscribe browsers');
select throws_ok(format($$insert into app.push_subscriptions (membership_id, platform, expo_push_token, web_endpoint, web_p256dh, web_auth, web_app)
  values (%L, 'web', 'ExponentPushToken[abcdefghijklmnop]', 'https://push.example.test/send/both', %L, %L, 'Atlas')$$,
  pg_temp.id('alice@org_a'), (select p256dh from keys), (select auth from keys)), '23514', null,
  'a row is a Compass device or a browser, never both');
select is(app.sync_web_push('Atlas', (select endpoint from keys), (select p256dh from keys), (select auth from keys)), 'active',
  'on her next visit the browser is still hers');

-- bob signs in on the same browser.
select pg_temp.as_user('bob');
select is(app.sync_web_push('Atlas', (select endpoint from keys), (select p256dh from keys), (select auth from keys)), 'unknown',
  'for bob the browser is not registered, so it unsubscribes');
select pg_temp.as_platform();
select is((select count(*)::int from app.push_subscriptions ps where ps.web_endpoint = (select endpoint from keys) and ps.revoked_at is null),
  0, 'and alice''s pushes no longer reach a browser bob is signed in to');
select pg_temp.as_user('bob');
select ok(app.register_web_push('Atlas', (select endpoint from keys), (select p256dh from keys), (select auth from keys)) > 0,
  'bob turns them on for himself');
select ok(app.revoke_web_push((select endpoint from keys)) > 0, 'and off again');

-- alice registers again; a notification's push goes to her browser.
select pg_temp.as_user('alice');
select ok(app.register_web_push('Atlas', (select endpoint from keys), (select p256dh from keys), (select auth from keys)) > 0,
  'alice registers the browser again');
select pg_temp.as_platform();
insert into world select 'note', private.notify(pg_temp.id('org_a'), pg_temp.id('alice'), 'approval.requested');
create temporary table claimed as select * from app.claim_notification_deliveries('Push', 500) c
  where c.notification_id = pg_temp.id('note');
select ok((select bool_or(d ->> 'token' is null) from claimed c, jsonb_array_elements(c.push_devices) d),
  'A80''s claim lists the browser as a device with no token');
select is((select w.endpoint from claimed c, app.web_push_devices(c.delivery_id) w), (select endpoint from keys),
  'the sender reads its endpoint');
select lives_ok($$select app.record_web_push_tickets((select delivery_id from claimed), jsonb_build_array(jsonb_build_object(
  'subscriptionId', (select w.subscription_id from claimed c, app.web_push_devices(c.delivery_id) w), 'status', 'ok')))$$,
  'and records the push service''s 201');
select is((select t.message_status::text || ' ' || t.push_service from app.push_tickets t join claimed c on c.delivery_id = t.notification_delivery_id),
  'Delivered Web Push', 'as Delivered by Web Push, with no receipt to wait for');
select is((select count(*)::int from claimed c, app.web_push_devices(c.delivery_id) w), 0, 'so a retry never pushes it twice');

select pg_temp.as_user('alice');
select throws_ok($$select * from app.web_push_devices(gen_random_uuid())$$, '42501', null, 'only the sender reads endpoints and keys');

select * from finish();
rollback;
