-- 1362_org_notification_defaults.sql
-- A80 (RRR-125), finding A65-021, Section 4.5.6 item 29 (Notifications Defaults: org-wide defaults and mandatory
-- categories) and personal settings item 8 (a matrix of categories by channel, quiet hours, digest frequency):
--   * app.org_notification_defaults: the org's default per category and channel, which applies to every member
--     who stated no preference (before it, only the platform channel default applied)
--   * app.org_mandatory_notification_categories: categories members cannot turn off; every channel the org's
--     default (or the platform default) has on is locked on for them
--   * private.channel_enabled, replaced: mandatory first, then the member's preference, the org default and the
--     platform default. A member's choice to turn a locked channel off is refused
--   * private.notify, replaced: also honours the In App column. With In App off the notification is still
--     recorded, already archived, so it stays out of the Inbox while its email, SMS and push still go
--   * app.my_notification_matrix, app.set_my_notification_preferences, app.set_my_notification_settings and
--     app.set_org_notification_defaults: what the Atlas settings pages read and write
-- Org defaults and mandatory categories apply to members. External parties keep their own Email and Push
-- choices (1131): an org does not set them.

-- Org defaults ------------------------------------------------------------------------------------------------------

create table app.org_notification_defaults (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  category_code text not null references private.notification_categories (code),
  channel app.notification_channel not null,
  enabled boolean not null
);

call private.install_domain_table('app.org_notification_defaults');
create unique index org_notification_defaults_key on app.org_notification_defaults (org_id, category_code, channel) where deleted_at is null;
create index org_notification_defaults_category_idx on app.org_notification_defaults (category_code);
call private.describe('app.org_notification_defaults', 'The org''s notification default per category and channel (Section 4.5.6 item 29): what a member receives until they choose. Without a row the platform channel default applies. Set in Settings, Notifications.', array[
  'category_code', 'Notification category.',
  'channel', 'In App, Email, SMS or Push.',
  'enabled', 'True when members receive the category on the channel by default.'
]);

call private.install_policies('app.org_notification_defaults',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.notifications.write'))$$);
call private.install_audit_trail('app.org_notification_defaults');

create table app.org_mandatory_notification_categories (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  category_code text not null references private.notification_categories (code)
);

call private.install_domain_table('app.org_mandatory_notification_categories');
create unique index org_mandatory_notification_categories_key on app.org_mandatory_notification_categories (org_id, category_code) where deleted_at is null;
create index org_mandatory_notification_categories_category_idx on app.org_mandatory_notification_categories (category_code);
call private.describe('app.org_mandatory_notification_categories', 'Notification categories an org makes mandatory (Section 4.5.6 item 29), for example safety: every channel the org default has on stays on for every member. SMS still needs the member''s consent, and STOP still stops it (Section 14.5).', array[
  'category_code', 'Mandatory category.'
]);

call private.install_policies('app.org_mandatory_notification_categories',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.notifications.write'))$$);
call private.install_audit_trail('app.org_mandatory_notification_categories');

-- Resolution --------------------------------------------------------------------------------------------------------

create or replace function private.org_channel_default(p_org_id uuid, p_category text, p_channel app.notification_channel)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select d.enabled from app.org_notification_defaults d
     where d.org_id = p_org_id and d.category_code = p_category and d.channel = p_channel and d.deleted_at is null),
    (select c.enabled_by_default from private.channel_defaults c where c.channel = p_channel));
$$;

comment on function private.org_channel_default(uuid, text, app.notification_channel) is 'An org''s default for a category on a channel: its own row, or the platform channel default.';

create or replace function private.notification_locked(p_org_id uuid, p_category text, p_channel app.notification_channel)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.org_mandatory_notification_categories m
                 where m.org_id = p_org_id and m.category_code = p_category and m.deleted_at is null)
    and private.org_channel_default(p_org_id, p_category, p_channel);
$$;

comment on function private.notification_locked(uuid, text, app.notification_channel) is 'True when the org made the category mandatory and its default has the channel on, so members cannot turn it off.';

create or replace function private.channel_enabled(p_membership_id uuid, p_category text, p_channel app.notification_channel)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with m as (select ms.org_id from app.memberships ms where ms.id = p_membership_id)
  select case
    when private.notification_locked((select org_id from m), p_category, p_channel) then true
    else coalesce(
      (select p.enabled from app.notification_preferences p
       where p.membership_id = p_membership_id and p.category_code = p_category and p.channel = p_channel and p.deleted_at is null),
      private.org_channel_default((select org_id from m), p_category, p_channel))
  end;
$$;

comment on function private.channel_enabled(uuid, text, app.notification_channel) is 'Whether a member receives a category on a channel (1362): on when the org made the category mandatory and its default has the channel on; otherwise the member''s preference, else the org default, else the platform channel default.';

create or replace function private.guard_notification_preference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null and not new.enabled
     and private.notification_locked((select m.org_id from app.memberships m where m.id = new.membership_id), new.category_code, new.channel) then
    perform private.refuse('notification_category_mandatory',
      'Your organization made this category mandatory on this channel, so it stays on.');
  end if;
  return new;
end;
$$;

comment on function private.guard_notification_preference() is 'Refuses a member''s choice to turn off a channel the org locked on (mandatory category, 1362).';

create trigger t40_guard_notification_preference before insert or update on app.notification_preferences
  for each row execute function private.guard_notification_preference();

-- private.notify, honouring the In App column -----------------------------------------------------------------------

create or replace function private.notify(
  p_org_id uuid,
  p_recipient_person_id uuid,
  p_kind text,
  p_subject_table text default null,
  p_subject_id uuid default null,
  p_project_id uuid default null,
  p_message_args jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
  v_category text := (select distinct t.category_code from private.notification_templates t where t.kind = p_kind);
  v_urgent boolean;
  v_id uuid;
  v_created timestamptz;
  v_channel app.notification_channel;
  v_quiet timestamptz;
  v_digest timestamptz;
  v_delivery uuid;
begin
  select m.id into v_membership from app.memberships m
  where m.org_id = p_org_id and m.person_id = p_recipient_person_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  order by m.valid_from desc limit 1;
  if v_membership is null and p_org_id not in (select private.party_org_ids(p_recipient_person_id)) then
    return null;
  end if;
  v_urgent := (select c.urgent from private.notification_categories c where c.code = v_category);
  insert into app.notifications (org_id, recipient_person_id, kind, actor_person_id, subject_table, subject_id, project_id, message_args,
    archived_at)
  values (p_org_id, p_recipient_person_id, p_kind, private.current_person_id(), p_subject_table, p_subject_id, p_project_id,
    coalesce(p_message_args, '{}'::jsonb),
    case when v_membership is not null and v_category is not null and not private.channel_enabled(v_membership, v_category, 'In App')
         then now() end)
  returning id, created_at into v_id, v_created;

  if v_membership is null then
    -- An external party: their own Email and Push choices; quiet hours and digests are membership settings.
    foreach v_channel in array array['Email', 'Push']::app.notification_channel[] loop
      if private.person_channel_enabled(p_recipient_person_id, v_category, v_channel) then
        insert into app.notification_deliveries (notification_id, notification_created_at, channel, message_status, deliver_after)
        values (v_id, v_created, v_channel, 'Queued', now());
      end if;
    end loop;
    return v_id;
  end if;

  foreach v_channel in array array['Email', 'SMS', 'Push']::app.notification_channel[] loop
    if private.channel_enabled(v_membership, v_category, v_channel) then
      v_quiet := case when v_channel in ('SMS', 'Push') and not v_urgent then private.local_quiet_until(v_membership, now()) end;
      v_digest := case when v_channel = 'Email' and not v_urgent then private.next_digest_at(v_membership, now()) end;
      insert into app.notification_deliveries (notification_id, notification_created_at, channel, message_status, deliver_after)
      values (v_id, v_created, v_channel,
        (case when v_digest is not null then 'Digest' when v_quiet is not null then 'Deferred' else 'Queued' end)::app.message_status,
        coalesce(v_digest, v_quiet, now()))
      returning id into v_delivery;
      if v_digest is not null then
        insert into app.email_digest_queue (notification_delivery_id, notification_created_at, membership_id, due_at)
        values (v_delivery, v_created, v_membership, v_digest);
      end if;
    end if;
  end loop;
  return v_id;
end;
$$;

comment on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) is 'Creates a notification and its outside deliveries. An active member gets one delivery per channel they receive the category on (their preference, the org default and mandatory categories, 1362): SMS and push wait out quiet hours and non-urgent email joins the digest when the member chose one; urgent categories go at once. With In App off the notification is recorded already archived, so it stays out of the Inbox. An external party of the org (1131) gets the notification and an Email and a Push delivery as their own preferences allow, at once. Anyone else gets nothing (invariant 3). Returns the notification id, or null.';

-- What the settings pages read and write -------------------------------------------------------------------------------

create or replace function app.my_notification_matrix(p_org_id uuid)
returns table (
  category_code text, urgent boolean, sort_order smallint, channel app.notification_channel,
  enabled boolean, org_default boolean, locked boolean, chosen boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select private.my_membership_in(p_org_id) as membership_id)
  select c.code, c.urgent, c.sort_order, ch.channel,
    private.channel_enabled(me.membership_id, c.code, ch.channel),
    private.org_channel_default(p_org_id, c.code, ch.channel),
    private.notification_locked(p_org_id, c.code, ch.channel),
    exists (select 1 from app.notification_preferences p where p.membership_id = me.membership_id and p.category_code = c.code
            and p.channel = ch.channel and p.deleted_at is null)
  from me
  cross join private.notification_categories c
  cross join unnest(enum_range(null::app.notification_channel)) as ch (channel)
  where me.membership_id is not null
  order by c.sort_order, ch.channel;
$$;

comment on function app.my_notification_matrix(uuid) is 'The signed-in member''s preference matrix in an org (Section 4.5.6 personal settings item 8): every category by channel with what they receive, the org default, whether the org locked it (mandatory) and whether they chose it themselves. Empty for someone who is not a member.';

create or replace function app.set_my_notification_preferences(p_org_id uuid, p_preferences jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership uuid := private.require_membership_in(p_org_id);
  v_p jsonb;
  v_count integer := 0;
begin
  if jsonb_typeof(p_preferences) <> 'array' then
    perform private.refuse('notification_preferences_invalid', 'Preferences come as a list of category, channel and enabled.');
  end if;
  for v_p in select * from jsonb_array_elements(p_preferences) loop
    update app.notification_preferences set enabled = (v_p ->> 'enabled')::boolean
    where membership_id = v_membership and category_code = v_p ->> 'category' and channel = (v_p ->> 'channel')::app.notification_channel
      and deleted_at is null;
    if not found then
      insert into app.notification_preferences (membership_id, category_code, channel, enabled)
      values (v_membership, v_p ->> 'category', (v_p ->> 'channel')::app.notification_channel, (v_p ->> 'enabled')::boolean);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function app.set_my_notification_preferences(uuid, jsonb) is 'Records the signed-in member''s choices in an org, [{category, channel, enabled}], updating a live row or adding one. A channel the org locked on cannot be turned off. Returns how many choices were recorded.';

create or replace function app.set_my_notification_settings(
  p_org_id uuid,
  p_time_zone text,
  p_quiet_hours_start time,
  p_quiet_hours_end time,
  p_digest_frequency app.digest_frequency,
  p_digest_hour smallint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership uuid := private.require_membership_in(p_org_id);
begin
  update app.notification_settings
  set time_zone = p_time_zone, quiet_hours_start = p_quiet_hours_start, quiet_hours_end = p_quiet_hours_end,
    digest_frequency = p_digest_frequency, digest_hour = p_digest_hour
  where membership_id = v_membership and deleted_at is null;
  if not found then
    insert into app.notification_settings (membership_id, time_zone, quiet_hours_start, quiet_hours_end, digest_frequency, digest_hour)
    values (v_membership, p_time_zone, p_quiet_hours_start, p_quiet_hours_end, p_digest_frequency, p_digest_hour);
  end if;
end;
$$;

comment on function app.set_my_notification_settings(uuid, text, time, time, app.digest_frequency, smallint) is 'Records the signed-in member''s quiet hours, the time zone they are read in, and their digest choice in an org (Section 14.5: quiet hours by recipient time zone).';

create or replace function app.set_org_notification_defaults(p_org_id uuid, p_defaults jsonb, p_mandatory jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_d jsonb;
begin
  perform private.require_person();
  if p_org_id not in (select private.orgs_with_capability('org.notifications.write')) then
    raise exception using errcode = '42501', message = 'org.notifications.write is required to set notification defaults';
  end if;
  if jsonb_typeof(p_defaults) <> 'array' or jsonb_typeof(p_mandatory) <> 'array' then
    perform private.refuse('notification_defaults_invalid', 'Defaults and mandatory categories come as lists.');
  end if;
  for v_d in select * from jsonb_array_elements(p_defaults) loop
    update app.org_notification_defaults set enabled = (v_d ->> 'enabled')::boolean
    where org_id = p_org_id and category_code = v_d ->> 'category' and channel = (v_d ->> 'channel')::app.notification_channel
      and deleted_at is null;
    if not found then
      insert into app.org_notification_defaults (org_id, category_code, channel, enabled)
      values (p_org_id, v_d ->> 'category', (v_d ->> 'channel')::app.notification_channel, (v_d ->> 'enabled')::boolean);
    end if;
  end loop;
  update app.org_mandatory_notification_categories set deleted_at = now()
  where org_id = p_org_id and deleted_at is null
    and category_code not in (select jsonb_array_elements_text(p_mandatory));
  insert into app.org_mandatory_notification_categories (org_id, category_code)
  select p_org_id, c.value from jsonb_array_elements_text(p_mandatory) c (value)
  where not exists (select 1 from app.org_mandatory_notification_categories m
                    where m.org_id = p_org_id and m.category_code = c.value and m.deleted_at is null);
end;
$$;

comment on function app.set_org_notification_defaults(uuid, jsonb, jsonb) is 'Sets an org''s notification defaults, [{category, channel, enabled}], and replaces its mandatory categories with the given list of codes (org.notifications.write). Each change is audited.';

-- Retention -------------------------------------------------------------------------------------------------------------

call private.install_default_retention('app.org_notification_defaults', interval '90 days');
call private.install_default_retention('app.org_mandatory_notification_categories', interval '90 days');

-- Privileges ------------------------------------------------------------------------------------------------------------

revoke all on function private.org_channel_default(uuid, text, app.notification_channel) from public, anon, authenticated;
revoke all on function private.notification_locked(uuid, text, app.notification_channel) from public, anon, authenticated;
revoke all on function private.channel_enabled(uuid, text, app.notification_channel) from public, anon, authenticated;
revoke all on function private.guard_notification_preference() from public, anon, authenticated;
revoke all on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function app.my_notification_matrix(uuid) from public, anon;
grant execute on function app.my_notification_matrix(uuid) to authenticated, service_role;
revoke all on function app.set_my_notification_preferences(uuid, jsonb) from public, anon;
grant execute on function app.set_my_notification_preferences(uuid, jsonb) to authenticated;
revoke all on function app.set_my_notification_settings(uuid, text, time, time, app.digest_frequency, smallint) from public, anon;
grant execute on function app.set_my_notification_settings(uuid, text, time, time, app.digest_frequency, smallint) to authenticated;
revoke all on function app.set_org_notification_defaults(uuid, jsonb, jsonb) from public, anon;
grant execute on function app.set_org_notification_defaults(uuid, jsonb, jsonb) to authenticated;
