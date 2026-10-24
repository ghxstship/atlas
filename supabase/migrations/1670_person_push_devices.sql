-- 1670_person_push_devices.sql
--
-- A101 (RRR-147), trace rows S4.3-15 and S4.4-20, ADR 0045. Devices registered for push only per membership
-- (app.push_subscriptions, 0520 and 1533), so the push private.notify queues for an external party (1131) or a
-- marketplace user (1461) was claimed and suppressed as "No registered device". This adds the person's own devices;
-- 1671 delivers to them.
--   * app.person_push_devices: a person's own devices, owned by the person (install_person_table, decision 69): a
--     Compass device's Expo push token, or a Gateway browser's Web Push endpoint and keys. A row belongs to no org and
--     carries no org's pushes by itself: 1671's claim uses it only for an org the person works with as a party, or a
--     marketplace match about a listing open to them, and only when they have no device in that org (invariant 3)
--   * app.push_tickets names the device it pushed in either table, and takes its org from the delivery instead of
--     from the membership device, which a person's device does not have
--   * app.register_push_device: Compass registers the device for the signed-in person. A device belongs to one person
--     at a time: registering it revokes any other person's row for the same token, as 1533 does for browsers
--   * app.register_web_push, app.sync_web_push, app.revoke_web_push and private.claim_web_push_endpoint (from 1533,
--     which no later migration redefines): a Gateway browser is registered for the person as well as for each org they
--     belong to, so a person with no membership keeps their subscription instead of being told to drop it. Atlas
--     browsers stay per membership, since Atlas pages open only for members
--   * app.delete_my_account and private.account_deletion_tables (from 1112, which no later migration redefines):
--     deleting an account removes the person's own devices and the tickets of every device it removes. Deleting the
--     membership devices alone failed on the push_tickets foreign key once any of them had been pushed

-- 1. A person's own devices -------------------------------------------------------------------------------------------

create table app.person_push_devices (
  id uuid primary key default private.uuid_v7(),
  deleted_at timestamptz,
  person_id uuid not null references app.people (id),
  platform text not null,
  expo_push_token text,
  web_endpoint text,
  web_p256dh text,
  web_auth text,
  web_app text,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint person_push_devices_platform check (platform in ('ios', 'android', 'web')),
  constraint person_push_devices_one_kind check ((expo_push_token is null) <> (web_endpoint is null)),
  constraint person_push_devices_web_keys check ((web_endpoint is null) = (web_p256dh is null) and (web_endpoint is null) = (web_auth is null)
    and (web_endpoint is null) = (web_app is null)),
  constraint person_push_devices_web_platform check ((web_endpoint is null) = (platform <> 'web')),
  constraint person_push_devices_web_app check (web_app is null or web_app = 'Gateway'),
  constraint person_push_devices_token_format check (expo_push_token is null or expo_push_token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$'),
  constraint person_push_devices_web_endpoint_format check (web_endpoint is null
    or (char_length(web_endpoint) <= 1000 and web_endpoint ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[!-~]*$')),
  constraint person_push_devices_web_p256dh_format check (web_p256dh is null or web_p256dh ~ '^[A-Za-z0-9_-]{87}$'),
  constraint person_push_devices_web_auth_format check (web_auth is null or web_auth ~ '^[A-Za-z0-9_-]{22}$')
);

create unique index person_push_devices_token_key on app.person_push_devices (person_id, expo_push_token)
  where deleted_at is null and expo_push_token is not null;
create unique index person_push_devices_web_endpoint_key on app.person_push_devices (person_id, web_endpoint)
  where deleted_at is null and web_endpoint is not null;
create index person_push_devices_expo_push_token_idx on app.person_push_devices (expo_push_token) where expo_push_token is not null;
create index person_push_devices_web_endpoint_idx on app.person_push_devices (web_endpoint) where web_endpoint is not null;

call private.install_person_table('app.person_push_devices');
call private.describe('app.person_push_devices', 'A person''s own devices for push (A101, decision 69): a Compass device''s Expo push token or a Gateway browser''s Web Push endpoint. They carry the pushes of an org only when the person has no device registered with that org and works with it as an external party, or the push is a marketplace match about a listing open to them (invariant 3). Members keep their per-org devices in app.push_subscriptions.', array[
  'id', 'Primary key, UUID v7.',
  'person_id', 'Owner.',
  'platform', 'ios, android or web; web exactly when the row is a browser.',
  'expo_push_token', 'Expo push token of a Compass device; null for a browser.',
  'web_endpoint', 'Web Push endpoint of a browser (RFC 8030), an https URL of its push service; null for a Compass device.',
  'web_p256dh', 'The browser''s P-256 public key for message encryption (RFC 8291), base64url; null for a Compass device.',
  'web_auth', 'The browser''s 16-byte authentication secret (RFC 8291), base64url; null for a Compass device.',
  'web_app', 'App the browser subscribed in, always Gateway, whose service worker shows the push and opens its link; null for a Compass device.',
  'last_seen_at', 'Last time the device registered again.',
  'revoked_at', 'When the device was revoked: by a push service that no longer knows it (Expo DeviceNotRegistered, Web Push 404 or 410), by the person turning browser notifications off, or because another person registered the same device.'
]);

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.person_push_devices', 'Soft Deleted', 'deleted_at', interval '90 days', 'Delete', 'Removed devices carry no history value.');

-- 2. Tickets name either device ---------------------------------------------------------------------------------------

alter table app.push_tickets
  alter column push_subscription_id drop not null,
  add column person_push_device_id uuid references app.person_push_devices (id),
  add constraint push_tickets_one_device check ((push_subscription_id is null) <> (person_push_device_id is null));

create index push_tickets_person_device_idx on app.push_tickets (person_push_device_id) where person_push_device_id is not null;
create unique index push_tickets_delivery_person_device_key on app.push_tickets (notification_delivery_id, person_push_device_id)
  where deleted_at is null;

-- A person's device has no org: the ticket's org is its delivery's, which for a membership device is the same org.
call private.install_tenant_guards('app.push_tickets', 'app.notification_deliveries', 'notification_delivery_id');

comment on column app.push_tickets.org_id is 'Owning org, derived from app.notification_deliveries on insert; never accepted from the caller and never changed.';
comment on column app.push_tickets.push_subscription_id is 'Membership device pushed (app.push_subscriptions); null when the push went to one of the person''s own devices.';
comment on column app.push_tickets.person_push_device_id is 'The person''s own device pushed (app.person_push_devices, A101); null when the push went to a membership device.';

-- 3. Registering a Compass device for the person ----------------------------------------------------------------------

create or replace function app.register_push_device(p_expo_push_token text, p_platform text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_id uuid;
begin
  if p_expo_push_token is null or p_platform is null or p_platform not in ('ios', 'android') then
    perform private.refuse('push_device_invalid', 'A device registers with its Expo push token and its platform, ios or android.');
  end if;
  update app.person_push_devices set revoked_at = now()
  where expo_push_token = p_expo_push_token and person_id <> v_person and revoked_at is null and deleted_at is null;
  update app.person_push_devices set platform = p_platform, last_seen_at = now(), revoked_at = null
  where person_id = v_person and expo_push_token = p_expo_push_token and deleted_at is null
  returning id into v_id;
  if v_id is null then
    insert into app.person_push_devices (person_id, platform, expo_push_token)
    values (v_person, p_platform, p_expo_push_token)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

comment on function app.register_push_device(text, text) is 'Registers this Compass device for the signed-in person''s own pushes (A101): the pushes of orgs they work with as an external party and of marketplace matches, whenever they have no device registered with the org. Revokes any other person''s row for the same token, since a device belongs to the person signed in to it. Returns the device id.';
revoke all on function app.register_push_device(text, text) from public, anon;
grant execute on function app.register_push_device(text, text) to authenticated;

-- 4. Browsers (from 1533) ---------------------------------------------------------------------------------------------

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
  update app.person_push_devices pd set revoked_at = now()
  where pd.web_endpoint = p_endpoint and pd.revoked_at is null and pd.deleted_at is null and pd.person_id <> p_person_id;
$$;

comment on function private.claim_web_push_endpoint(uuid, text) is 'Revokes every other person''s rows for a browser endpoint, per membership and their own (A101): a browser belongs to the one person signed in to it.';
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
  -- Gateway is where parties and marketplace users work, members or not: its browser is the person's own too (A101).
  if p_app = 'Gateway' then
    update app.person_push_devices
    set web_p256dh = p_p256dh, web_auth = p_auth, last_seen_at = now(), revoked_at = null
    where person_id = v_person and web_endpoint = p_endpoint and deleted_at is null;
    if not found then
      insert into app.person_push_devices (person_id, platform, web_endpoint, web_p256dh, web_auth, web_app)
      values (v_person, 'web', p_endpoint, p_p256dh, p_auth, 'Gateway');
    end if;
    v_count := v_count + 1;
  end if;
  return v_count;
end;
$$;

comment on function app.register_web_push(text, text, text, text) is 'Registers this browser for Web Push for every org the signed-in person belongs to, after they turned browser notifications on, and in Gateway for the person too (A101), so the pushes of orgs they work with as an external party and their marketplace matches reach it. Revokes any other person''s rows for the same endpoint. Returns how many registrations it covers: the memberships, plus one for the person in Gateway.';
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
    where ps.web_endpoint = p_endpoint and m.person_id = v_person and ps.revoked_at is null and ps.deleted_at is null)
     and not exists (
    select 1 from app.person_push_devices pd
    where pd.web_endpoint = p_endpoint and pd.person_id = v_person and pd.revoked_at is null and pd.deleted_at is null) then
    return 'unknown';
  end if;
  perform app.register_web_push(p_app, p_endpoint, p_p256dh, p_auth);
  return 'active';
end;
$$;

comment on function app.sync_web_push(text, text, text, text) is 'Checks the browser''s push subscription on a visit: active when the signed-in person has it registered, for an org or for themselves (A101; it then covers any org they joined since and takes fresh keys), unknown otherwise, and the browser unsubscribes. Either way, another person''s rows for the endpoint are revoked.';
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
  v_person uuid := private.require_person();
  v_count integer;
  v_own integer;
begin
  update app.push_subscriptions ps set revoked_at = now()
  where ps.web_endpoint = p_endpoint and ps.revoked_at is null and ps.deleted_at is null
    and ps.membership_id in (select m.id from app.memberships m where m.person_id = v_person);
  get diagnostics v_count = row_count;
  update app.person_push_devices pd set revoked_at = now()
  where pd.web_endpoint = p_endpoint and pd.person_id = v_person and pd.revoked_at is null and pd.deleted_at is null;
  get diagnostics v_own = row_count;
  return v_count + v_own;
end;
$$;

comment on function app.revoke_web_push(text) is 'Turns browser notifications off for this browser: revokes the signed-in person''s rows for the endpoint, per membership and their own (A101). Returns how many it revoked.';
revoke all on function app.revoke_web_push(text) from public, anon;
grant execute on function app.revoke_web_push(text) to authenticated;

-- 5. Account deletion (from 1112) -------------------------------------------------------------------------------------

create or replace function private.account_deletion_tables()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'app.people', 'app.person_profiles', 'app.person_links', 'app.person_languages', 'app.person_skills',
    'app.person_references', 'app.portfolio_items', 'app.profile_section_visibility', 'app.person_certifications',
    'app.certification_shares', 'app.availability_calendars', 'app.availability_blocks', 'app.saved_searches',
    'app.opportunity_alerts', 'app.saved_opportunities', 'app.favorites', 'app.personal_setting_values',
    'app.inbox_snoozes', 'app.record_watchers', 'app.thread_subscriptions', 'app.thread_reads',
    'app.comment_reactions', 'app.push_subscriptions', 'app.person_push_devices', 'app.push_tickets', 'app.oauth_grants',
    'app.memberships', 'app.account_memberships', 'app.engagements', 'app.dsar_requests']::text[];
$$;

comment on function private.account_deletion_tables() is 'The app tables an account deletion writes to (SIM-004), with the person''s own push devices and the tickets of every device it removes (A101). An active legal hold naming one of them, or naming no table, blocks the deletion.';
revoke all on function private.account_deletion_tables() from public, anon, authenticated;

create or replace function app.delete_my_account(p_confirm_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_done jsonb;
  v_person uuid;
  v_email text;
  v_blocker jsonb;
  v_orgs uuid[];
  v_memberships uuid[];
  v_engagement record;
  v_canceled integer := 0;
  v_ended integer;
  v_ended_total integer := 0;
  v_org uuid;
  v_dsar uuid;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  -- Idempotent: a repeat with the same session answers with the stored result.
  select d.result into v_done from private.account_deletions d where d.user_id = v_uid;
  if v_done is not null then
    return v_done || jsonb_build_object('replayed', true);
  end if;
  v_person := private.require_person();
  v_email := (select lower(u.email) from auth.users u where u.id = v_uid);
  if v_email is null or lower(btrim(coalesce(p_confirm_email, ''))) <> v_email then
    perform private.refuse('account_delete_confirmation', 'Type the email address you sign in with to confirm.');
  end if;

  v_blocker := private.account_deletion_blockers(v_person) -> 0;
  if v_blocker is not null then
    case v_blocker ->> 'code'
      when 'account_delete_legal_hold' then
        perform private.refuse('account_delete_legal_hold', format(
          '%s keeps your records under a legal hold (%s). Nothing was deleted. Ask %s to release the hold, then delete your account again.',
          v_blocker ->> 'org_name', v_blocker ->> 'matter', v_blocker ->> 'org_name'));
      when 'account_delete_on_shift' then
        perform private.refuse('account_delete_on_shift', format(
          'You are clocked in at %s. Clock out, then delete your account.', v_blocker ->> 'org_name'));
      else
        perform private.refuse('account_delete_sole_owner', format(
          'You are the only owner of %s. Make someone else an owner, then delete your account.', v_blocker ->> 'org_name'));
    end case;
  end if;

  v_orgs := array(select private.person_related_org_ids(v_person));
  v_memberships := array(select m.id from app.memberships m where m.person_id = v_person);

  -- Their own profile data.
  delete from app.certification_shares s using app.person_certifications c
    where s.person_certification_id = c.id and c.person_id = v_person;
  delete from app.person_certifications where person_id = v_person;
  delete from app.availability_blocks b using app.availability_calendars c
    where b.availability_calendar_id = c.id and c.person_id = v_person;
  delete from app.availability_calendars where person_id = v_person;
  delete from app.opportunity_alerts a using app.saved_searches s
    where a.saved_search_id = s.id and s.person_id = v_person;
  delete from app.saved_searches where person_id = v_person;
  delete from app.saved_opportunities where person_id = v_person;
  delete from app.person_profiles where person_id = v_person;
  delete from app.person_links where person_id = v_person;
  delete from app.person_languages where person_id = v_person;
  delete from app.person_skills where person_id = v_person;
  delete from app.person_references where person_id = v_person;
  delete from app.portfolio_items where person_id = v_person;
  delete from app.profile_section_visibility where person_id = v_person;
  delete from app.favorites where person_id = v_person;
  delete from app.personal_setting_values where person_id = v_person;
  delete from app.inbox_snoozes where person_id = v_person;
  delete from app.record_watchers where person_id = v_person;
  delete from app.thread_subscriptions where person_id = v_person;
  delete from app.thread_reads where person_id = v_person;
  delete from app.comment_reactions where person_id = v_person;
  -- Their devices, membership and own, with the tickets that name them (A101).
  delete from app.push_tickets t using app.push_subscriptions ps
    where t.push_subscription_id = ps.id and ps.membership_id = any (v_memberships);
  delete from app.push_tickets t using app.person_push_devices pd
    where t.person_push_device_id = pd.id and pd.person_id = v_person;
  delete from app.push_subscriptions where membership_id = any (v_memberships);
  delete from app.person_push_devices where person_id = v_person;
  delete from app.oauth_grants where person_id = v_person;

  -- Memberships end now. One that starts this instant is soft-deleted, since a period cannot be empty.
  update app.memberships m
    set valid_to = case when m.valid_from < now() then now() else m.valid_to end,
        deleted_at = case when m.valid_from < now() then m.deleted_at else now() end
    where m.person_id = v_person and m.deleted_at is null and (m.valid_to is null or m.valid_to > now());
  get diagnostics v_ended = row_count;
  v_ended_total := v_ended;
  update app.account_memberships a
    set valid_to = case when a.valid_from < now() then now() else a.valid_to end,
        deleted_at = case when a.valid_from < now() then a.deleted_at else now() end
    where a.person_id = v_person and a.deleted_at is null and (a.valid_to is null or a.valid_to > now());
  get diagnostics v_ended = row_count;
  v_ended_total := v_ended_total + v_ended;

  -- Engagements still under way are canceled; Closing and Complete stay for settlement and pay.
  for v_engagement in
    select e.id, e.engagement_state::text as state from app.engagements e
    where e.person_id = v_person and e.deleted_at is null and e.engagement_state in ('Onboarding', 'Blocked', 'Active')
  loop
    perform private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
      'engagement_id', v_engagement.id, v_engagement.state, 'Canceled', 'The person deleted their account.');
    v_canceled := v_canceled + 1;
  end loop;

  -- Every org they belonged to or worked for records the erasure in its DSAR register.
  foreach v_org in array v_orgs loop
    insert into app.dsar_requests (org_id, subject_person_id, subject_email, request_type, details)
    values (v_org, v_person, v_email, 'Erasure', 'Account deleted by the person from the app (account lifecycle, Section 14.7).')
    returning id into v_dsar;
    perform private.transition_lifecycle('dsar', 'app.dsar_requests', 'dsar_state', 'app.dsar_state_transitions',
      'dsar_request_id', v_dsar, 'Received', 'In Progress', 'Erasure runs at once when the person deletes their account.');
    perform private.transition_lifecycle('dsar', 'app.dsar_requests', 'dsar_state', 'app.dsar_state_transitions',
      'dsar_request_id', v_dsar, 'In Progress', 'Completed', 'Profile erased, memberships ended, sign-in deleted; retained records listed in the result.');
  end loop;

  v_result := jsonb_build_object(
    'deleted_at', now(),
    'replayed', false,
    'erased', jsonb_build_array('sign_in', 'name', 'profile', 'devices', 'preferences'),
    'kept', private.account_deletion_kept(v_person),
    'memberships_ended', v_ended_total,
    'engagements_canceled', v_canceled,
    'orgs_notified', coalesce(array_length(v_orgs, 1), 0));

  -- The person keeps no name; the records that name them keep a person with no name.
  update app.people set full_name = null, deleted_at = now() where id = v_person;
  insert into private.account_deletions (user_id, person_id, result) values (v_uid, v_person, v_result);
  delete from auth.users where id = v_uid;
  return v_result;
end;
$$;

comment on function app.delete_my_account(text) is 'Deletes the signed-in person''s account at once (SIM-004, journey 38): erases their profile data, name and push devices (their own and per membership, with the tickets that name them, A101), ends their memberships, cancels their open engagements, records a Completed Erasure request in every related org and deletes the sign-in. Confirm with the sign-in email. Refuses (XR001, nothing deleted) under a legal hold, while clocked in, or as the only Owner. Idempotent per session. Returns what was erased and what is kept.';
revoke all on function app.delete_my_account(text) from public, anon;
grant execute on function app.delete_my_account(text) to authenticated, service_role;
