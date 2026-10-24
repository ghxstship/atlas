-- 1533_web_push_subscriptions.sql
-- A96 (RRR-141), finding A65-023, Section 4.10 ("Gateway and Atlas are installable as progressive web apps, with web
-- push"), ADR 0052. Browsers subscribe to Web Push (RFC 8030) with VAPID (RFC 8292), alongside A80's Expo tokens:
--   * app.push_subscriptions gains a browser's push endpoint and its p256dh and auth keys (RFC 8291). A row is
--     either an Expo device or a browser, per membership as before, so leaving an org stops its pushes (invariant 3)
--   * app.register_web_push, app.sync_web_push and app.revoke_web_push: a browser is registered for every org the
--     person belongs to, re-checked on each visit, and belongs to one person at a time: registering or syncing it
--     revokes another person's rows for the same endpoint, so a shared browser never shows someone else's pushes
--   * the push sender (notification-dispatch, @xos/platform web-push.ts) keeps claiming Push deliveries through A80's
--     app.claim_notification_deliveries, unchanged: a browser row is listed there with a null token, counts as a
--     device, and keeps A80's quiet hours, preferences and per-device idempotency. app.web_push_devices gives the
--     sender the endpoint and keys, and app.record_web_push_tickets records the push service's answer
--   * app.push_tickets says which service took each push. A push service gives no receipt: 201 Created is recorded
--     Delivered at once, 404 and 410 revoke the browser (as Expo's DeviceNotRegistered does), 413 is Bounced

-- Browsers in push_subscriptions ---------------------------------------------------------------------------------------

alter table app.push_subscriptions
  alter column expo_push_token drop not null,
  add column web_endpoint text,
  add column web_p256dh text,
  add column web_auth text,
  add column web_app text,
  add constraint push_subscriptions_one_kind check ((expo_push_token is null) <> (web_endpoint is null)),
  add constraint push_subscriptions_web_keys check ((web_endpoint is null) = (web_p256dh is null) and (web_endpoint is null) = (web_auth is null)
    and (web_endpoint is null) = (web_app is null)),
  add constraint push_subscriptions_web_app check (web_app is null or web_app in ('Atlas', 'Gateway')),
  add constraint push_subscriptions_web_platform check ((web_endpoint is null) = (platform <> 'web')),
  add constraint push_subscriptions_web_endpoint_format check (web_endpoint is null
    or (char_length(web_endpoint) <= 1000 and web_endpoint ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[!-~]*$')),
  add constraint push_subscriptions_web_p256dh_format check (web_p256dh is null or web_p256dh ~ '^[A-Za-z0-9_-]{87}$'),
  add constraint push_subscriptions_web_auth_format check (web_auth is null or web_auth ~ '^[A-Za-z0-9_-]{22}$');

create unique index push_subscriptions_web_endpoint_key on app.push_subscriptions (membership_id, web_endpoint)
  where deleted_at is null and web_endpoint is not null;
create index push_subscriptions_web_endpoint_idx on app.push_subscriptions (web_endpoint) where web_endpoint is not null;

comment on table app.push_subscriptions is 'Devices registered for push, per membership, so leaving an org stops its pushes (invariant 3): Compass devices through Expo Notifications (an Expo push token), and browsers through Web Push with VAPID (an endpoint and its keys, 1533).';
comment on column app.push_subscriptions.expo_push_token is 'Expo push token of a Compass device; null for a browser.';
comment on column app.push_subscriptions.platform is 'ios, android or web; web exactly when the row is a browser.';
comment on column app.push_subscriptions.web_endpoint is 'Web Push endpoint of a browser (RFC 8030), an https URL of its push service; null for a Compass device.';
comment on column app.push_subscriptions.web_p256dh is 'The browser''s P-256 public key for message encryption (RFC 8291), base64url; null for a Compass device.';
comment on column app.push_subscriptions.web_auth is 'The browser''s 16-byte authentication secret (RFC 8291), base64url; null for a Compass device.';
comment on column app.push_subscriptions.web_app is 'App the browser subscribed in, Atlas or Gateway, whose service worker shows the push and opens its link; null for a Compass device.';
comment on column app.push_subscriptions.revoked_at is 'When the device was revoked: by the person, by a push service that no longer knows it (Expo DeviceNotRegistered, Web Push 404 or 410), or because another person registered the same browser.';

-- Which service took a push --------------------------------------------------------------------------------------------

alter table app.push_tickets
  add column push_service text not null default 'Expo',
  add constraint push_tickets_push_service check (push_service in ('Expo', 'Web Push')),
  drop constraint push_tickets_ticket_when_sent,
  add constraint push_tickets_ticket_when_sent check (message_status not in ('Sent', 'Delivered') or expo_ticket_id is not null
    or push_service = 'Web Push');

comment on column app.push_tickets.push_service is 'Service that took the push: Expo for a Compass device, Web Push for a browser. A Web Push service answers at once and gives no receipt, so its accepted pushes are Delivered without a ticket id.';

-- Registering a browser ------------------------------------------------------------------------------------------------

create or replace function private.claim_web_push_endpoint(p_person_id uuid, p_endpoint text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update app.push_subscriptions ps set revoked_at = now()
  where ps.web_endpoint = p_endpoint and ps.revoked_at is null and ps.deleted_at is null
    and ps.membership_id not in (select m.id from app.memberships m where m.person_id = p_person_id);
$$;

comment on function private.claim_web_push_endpoint(uuid, text) is 'Revokes every other person''s rows for a browser endpoint: a browser belongs to the one person signed in to it.';
revoke all on function private.claim_web_push_endpoint(uuid, text) from public, anon, authenticated;

create or replace function app.register_web_push(p_app text, p_endpoint text, p_p256dh text, p_auth text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_count integer := 0;
  v_membership record;
begin
  if p_endpoint is null or p_p256dh is null or p_auth is null or p_app is null or p_app not in ('Atlas', 'Gateway') then
    perform private.refuse('web_push_invalid', 'A browser subscription needs its app, its endpoint and both keys.');
  end if;
  perform private.claim_web_push_endpoint(v_person, p_endpoint);
  for v_membership in
    select m.id from app.memberships m
    where m.person_id = v_person and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  loop
    update app.push_subscriptions
    set web_p256dh = p_p256dh, web_auth = p_auth, web_app = p_app, last_seen_at = now(), revoked_at = null
    where membership_id = v_membership.id and web_endpoint = p_endpoint and deleted_at is null;
    if not found then
      insert into app.push_subscriptions (membership_id, platform, web_endpoint, web_p256dh, web_auth, web_app)
      values (v_membership.id, 'web', p_endpoint, p_p256dh, p_auth, p_app);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function app.register_web_push(text, text, text, text) is 'Registers this browser for Web Push for every org the signed-in person belongs to, after they turned browser notifications on, and revokes any other person''s rows for the same endpoint. Returns how many memberships it covers.';
revoke all on function app.register_web_push(text, text, text, text) from public, anon;
grant execute on function app.register_web_push(text, text, text, text) to authenticated;

create or replace function app.sync_web_push(p_app text, p_endpoint text, p_p256dh text, p_auth text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
begin
  if p_endpoint is null then
    return 'unknown';
  end if;
  perform private.claim_web_push_endpoint(v_person, p_endpoint);
  if not exists (
    select 1 from app.push_subscriptions ps join app.memberships m on m.id = ps.membership_id
    where ps.web_endpoint = p_endpoint and m.person_id = v_person and ps.revoked_at is null and ps.deleted_at is null) then
    return 'unknown';
  end if;
  perform app.register_web_push(p_app, p_endpoint, p_p256dh, p_auth);
  return 'active';
end;
$$;

comment on function app.sync_web_push(text, text, text, text) is 'Checks the browser''s push subscription on a visit: active when the signed-in person has it registered (it then covers any org they joined since and takes fresh keys), unknown otherwise, and the browser unsubscribes. Either way, another person''s rows for the endpoint are revoked.';
revoke all on function app.sync_web_push(text, text, text, text) from public, anon;
grant execute on function app.sync_web_push(text, text, text, text) to authenticated;

create or replace function app.revoke_web_push(p_endpoint text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update app.push_subscriptions ps set revoked_at = now()
  where ps.web_endpoint = p_endpoint and ps.revoked_at is null and ps.deleted_at is null
    and ps.membership_id in (select m.id from app.memberships m where m.person_id = private.require_person());
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.revoke_web_push(text) is 'Turns browser notifications off for this browser: revokes the signed-in person''s rows for the endpoint. Returns how many it revoked.';
revoke all on function app.revoke_web_push(text) from public, anon;
grant execute on function app.revoke_web_push(text) to authenticated;

-- The sender ------------------------------------------------------------------------------------------------------------

create or replace function app.web_push_devices(p_delivery_id uuid)
returns table (subscription_id uuid, endpoint text, p256dh text, auth text, app text)
language sql
stable
security definer
set search_path = ''
as $$
  select ps.id, ps.web_endpoint, ps.web_p256dh, ps.web_auth, ps.web_app
  from app.notification_deliveries d
  join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
  join app.memberships m on m.person_id = n.recipient_person_id
  join app.push_subscriptions ps on ps.membership_id = m.id and ps.org_id = n.org_id
  where d.id = p_delivery_id and d.channel = 'Push'
    and ps.web_endpoint is not null and ps.revoked_at is null and ps.deleted_at is null
    and not exists (select 1 from app.push_tickets pt
                    where pt.notification_delivery_id = d.id and pt.push_subscription_id = ps.id and pt.deleted_at is null
                      and pt.message_status in ('Sent', 'Delivered', 'Bounced'))
  order by ps.last_seen_at desc;
$$;

comment on function app.web_push_devices(uuid) is 'Push sender API (service role): the browsers a claimed Push delivery still goes to, with their endpoint and keys: the recipient''s unrevoked browser rows in the delivery''s org not yet pushed for it, as app.claim_notification_deliveries lists them, with the app each subscribed in.';
revoke all on function app.web_push_devices(uuid) from public, anon, authenticated;
grant execute on function app.web_push_devices(uuid) to service_role;

create or replace function app.record_web_push_tickets(p_delivery_id uuid, p_tickets jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_d record;
  v_t jsonb;
  v_status app.message_status;
  v_code text;
begin
  select d.id, d.notification_created_at, d.channel into v_d from app.notification_deliveries d where d.id = p_delivery_id;
  if v_d.id is null or v_d.channel <> 'Push' then
    perform private.refuse('delivery_unknown', 'No such push delivery.');
  end if;
  if jsonb_typeof(p_tickets) <> 'array' then
    perform private.refuse('push_tickets_invalid', 'Tickets come as an array.');
  end if;
  for v_t in select * from jsonb_array_elements(p_tickets) loop
    if not exists (select 1 from app.push_subscriptions ps where ps.id = (v_t ->> 'subscriptionId')::uuid and ps.web_endpoint is not null) then
      perform private.refuse('push_tickets_invalid', 'A Web Push ticket names a browser subscription.');
    end if;
    v_code := left(v_t #>> '{error}', 100);
    v_status := case
      when v_t ->> 'status' = 'ok' then 'Delivered'
      when v_code in ('DeviceNotRegistered', 'MessageTooBig') then 'Bounced'
      else 'Failed' end;
    insert into app.push_tickets (notification_delivery_id, notification_created_at, push_subscription_id, push_service,
      message_status, error_code, error_message, receipt_checked_at)
    values (v_d.id, v_d.notification_created_at, (v_t ->> 'subscriptionId')::uuid, 'Web Push', v_status, v_code,
      left(v_t ->> 'message', 1000), now())
    on conflict (notification_delivery_id, push_subscription_id) where deleted_at is null do update
      set push_service = 'Web Push', expo_ticket_id = null, message_status = excluded.message_status,
        error_code = excluded.error_code, error_message = excluded.error_message, receipt_checked_at = excluded.receipt_checked_at;
    if v_code = 'DeviceNotRegistered' then
      update app.push_subscriptions set revoked_at = now()
      where id = (v_t ->> 'subscriptionId')::uuid and revoked_at is null;
    end if;
  end loop;
end;
$$;

comment on function app.record_web_push_tickets(uuid, jsonb) is 'Push sender API (service role): records what each push service answered for one delivery, [{subscriptionId, status ok|error, error, message}]. 201 Created (ok) is Delivered, as push services give no receipt; DeviceNotRegistered (404 or 410) revokes the browser and MessageTooBig (413) are Bounced; anything else is Failed and the browser is pushed again on the retry.';
revoke all on function app.record_web_push_tickets(uuid, jsonb) from public, anon, authenticated;
grant execute on function app.record_web_push_tickets(uuid, jsonb) to service_role;
