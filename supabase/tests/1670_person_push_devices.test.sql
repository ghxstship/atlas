-- pgTAP: migration 1670 (A101, RRR-147). A person registers their own devices for push: a Compass device by its Expo
-- token and a Gateway browser by its endpoint, each owned by the person alone and held by one person at a time. Atlas
-- browsers stay per membership. Deleting an account removes the person's devices and the tickets that name them.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(24);

select has_table('app', 'person_push_devices', 'a person keeps devices of their own');
select has_column('app', 'push_tickets', 'person_push_device_id', 'and a ticket can name one');
select policies_are('app', 'person_push_devices',
  array['person_push_devices_owner_read', 'person_push_devices_owner_insert', 'person_push_devices_owner_update'],
  'only the owner reads and writes them');

create temporary table keys (endpoint text, p256dh text, auth text);
insert into keys values ('https://push.example.test/send/gateway-one', 'B' || repeat('Gw', 43), repeat('Au', 11));
grant select on keys to authenticated;

-- 1. Compass: ivy works with org_a and org_b as freelance crew and belongs to neither.
select pg_temp.as_user('ivy');
select app.register_push_device('ExponentPushToken[ivy-compass-0001]', 'ios') as v_ivy \gset
select is((select count(*)::int from app.person_push_devices where id = :'v_ivy' and person_id = pg_temp.id('ivy') and platform = 'ios'),
  1, 'ivy registers her Compass device for herself, with no membership');
select is(app.register_push_device('ExponentPushToken[ivy-compass-0001]', 'ios'), :'v_ivy'::uuid,
  'registering it again keeps the one row');
select throws_ok($$select app.register_push_device('ExponentPushToken[ivy-compass-0001]', 'web')$$, 'XR001',
  'push_device_invalid: A device registers with its Expo push token and its platform, ios or android.',
  'a Compass device is ios or android');
select throws_ok($$select app.register_push_device('not a token', 'ios')$$, '23514', null, 'and carries an Expo push token');
select throws_ok(format($$insert into app.person_push_devices (person_id, platform, expo_push_token, web_endpoint, web_p256dh, web_auth, web_app)
  values (%L, 'web', 'ExponentPushToken[ivy-compass-0002]', 'https://push.example.test/send/both', %L, %L, 'Gateway')$$,
  pg_temp.id('ivy'), (select p256dh from keys), (select auth from keys)), '23514', null,
  'a row is a Compass device or a browser, never both');
select throws_ok(format($$insert into app.person_push_devices (person_id, platform, expo_push_token) values (%L, 'ios', 'ExponentPushToken[quinn-compass-01]')$$,
  pg_temp.id('quinn')), '42501', null, 'nobody registers a device for someone else');

select pg_temp.as_user('quinn');
select is((select count(*)::int from app.person_push_devices), 0, 'quinn sees none of ivy''s devices');
-- quinn signs in to Compass on ivy's phone: the device is quinn's now.
select app.register_push_device('ExponentPushToken[ivy-compass-0001]', 'android') as v_quinn \gset
select pg_temp.as_platform();
select ok((select revoked_at is not null from app.person_push_devices where id = :'v_ivy'),
  'a device belongs to the person signed in to it: ivy''s row for the same token is revoked');
select pg_temp.as_user('ivy');
select is(app.register_push_device('ExponentPushToken[ivy-compass-0001]', 'ios'), :'v_ivy'::uuid, 'ivy signs in again');
select pg_temp.as_platform();
select ok((select revoked_at is null from app.person_push_devices where id = :'v_ivy')
          and (select revoked_at is not null from app.person_push_devices where id = :'v_quinn'),
  'and the device is hers again');

-- 2. Gateway: nina works with no org; her browser registers for her, where it registered for nothing before.
select pg_temp.as_user('nina');
select is(app.register_web_push('Gateway', (select endpoint from keys), (select p256dh from keys), (select auth from keys)), 1,
  'a Gateway browser registers for the person, though she belongs to no org');
select is((select count(*)::int from app.person_push_devices
           where web_endpoint = (select endpoint from keys) and platform = 'web' and web_app = 'Gateway' and expo_push_token is null),
  1, 'as her own browser row');
select is(app.sync_web_push('Gateway', (select endpoint from keys), (select p256dh from keys), (select auth from keys)), 'active',
  'on her next visit it is still hers, so Gateway keeps the subscription');
select is(app.register_web_push('Atlas', 'https://push.example.test/send/atlas-nina', (select p256dh from keys), (select auth from keys)), 0,
  'an Atlas browser stays per membership: Atlas pages open only for members');

select pg_temp.as_user('alice');
select is(app.register_web_push('Gateway', 'https://push.example.test/send/gateway-alice', (select p256dh from keys), (select auth from keys)),
  (select count(*)::int + 1 from app.memberships m where m.person_id = pg_temp.id('alice') and m.deleted_at is null),
  'a member''s Gateway browser registers for each org and for her');

-- bob signs in to Gateway on nina's browser.
select pg_temp.as_user('bob');
select is(app.sync_web_push('Gateway', (select endpoint from keys), (select p256dh from keys), (select auth from keys)), 'unknown',
  'for bob the browser is not registered, so it unsubscribes');
select pg_temp.as_platform();
select is((select count(*)::int from app.person_push_devices where web_endpoint = (select endpoint from keys) and revoked_at is null), 0,
  'and nina''s pushes no longer reach a browser bob is signed in to');
select pg_temp.as_user('nina');
select app.register_web_push('Gateway', (select endpoint from keys), (select p256dh from keys), (select auth from keys));
select is(app.revoke_web_push((select endpoint from keys)), 1, 'turning browser notifications off revokes her own row');

-- 3. Deleting an account removes the person's devices and the tickets that name them.
select pg_temp.as_platform();
insert into world select 'note_ivy', private.notify(pg_temp.id('org_a'), pg_temp.id('ivy'), 'invoice.paid', 'invoices', gen_random_uuid(), null, '{}');
create temporary table ivy_claim as select * from app.claim_notification_deliveries('Push', 500) c where c.notification_id = pg_temp.id('note_ivy');
select app.record_push_tickets((select delivery_id from ivy_claim), jsonb_build_array(jsonb_build_object(
  'subscriptionId', :'v_ivy', 'status', 'ok', 'ticketId', 'tkt-ivy-delete')));
-- dave, a member, has a pushed membership device too.
insert into app.push_subscriptions (membership_id, expo_push_token, platform)
values (pg_temp.id('dave@org_a'), 'ExponentPushToken[dave-compass-0001]', 'ios');
insert into world select 'note_dave', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested');
create temporary table dave_claim as select * from app.claim_notification_deliveries('Push', 500) c where c.notification_id = pg_temp.id('note_dave');
select app.record_push_tickets((select delivery_id from dave_claim), jsonb_build_array(jsonb_build_object(
  'subscriptionId', (select push_devices -> 0 ->> 'subscriptionId' from dave_claim), 'status', 'ok', 'ticketId', 'tkt-dave-delete')));

select pg_temp.as_user('ivy');
select lives_ok($$select app.delete_my_account('ivy@freelance.test')$$, 'ivy deletes her account');
select pg_temp.as_platform();
select is((select count(*)::int from app.person_push_devices where person_id = pg_temp.id('ivy'))
          + (select count(*)::int from app.push_tickets where expo_ticket_id = 'tkt-ivy-delete'), 0,
  'her devices and their tickets are gone');
select pg_temp.as_user('dave');
select lives_ok($$select app.delete_my_account('dave@northwind.test')$$,
  'a member whose device was pushed deletes his account: its tickets no longer hold the device');

select * from finish();
rollback;
