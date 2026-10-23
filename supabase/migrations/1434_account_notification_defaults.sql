-- 1434_account_notification_defaults.sql
-- A86 Settings surfaces (RRR-131, finding A65-004, WP3), Section 4.5.6 external company account settings item 7:
-- Notifications Defaults. Gateway's company section was an empty state: nothing stored a company's defaults.
--   * app.account_notification_defaults: a company account's default per category and outside channel (Email or
--     Push, as 1131's person preferences), set by its Account Owners and Admins.
--   * private.person_channel_enabled, replaced from 1131 (its only definition): a person's own preference first,
--     then the defaults of the company accounts they are an active member of (on when any of them has it on), then
--     the platform channel default. Members of tenant orgs are unaffected: their path is 1362's.
--   * app.set_account_notification_defaults: records them; each change is audited.

create table app.account_notification_defaults (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  category_code text not null references private.notification_categories (code),
  channel app.notification_channel not null,
  enabled boolean not null,
  constraint account_notification_defaults_channel check (channel in ('Email', 'Push'))
);

call private.install_domain_table('app.account_notification_defaults');
create unique index account_notification_defaults_key on app.account_notification_defaults (org_id, category_code, channel)
  where deleted_at is null;
create index account_notification_defaults_category_idx on app.account_notification_defaults (category_code);
call private.describe('app.account_notification_defaults', 'A company account''s notification default per category and outside channel (Section 4.5.6 company settings item 7): what its team members receive from the organizations they work with until they choose for themselves. Set in Gateway, Company, Notifications Defaults.', array[
  'org_id', 'The company account (an external organization).',
  'category_code', 'Notification category.',
  'channel', 'Email or Push.',
  'enabled', 'True when team members receive the category on the channel by default.'
]);

call private.install_policies('app.account_notification_defaults',
  $$org_id in (select private.my_account_ids())$$,
  $$org_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))$$);
call private.install_audit_trail('app.account_notification_defaults');

-- Resolution ----------------------------------------------------------------------------------------------------------

create or replace function private.person_channel_enabled(p_person_id uuid, p_category text, p_channel app.notification_channel)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.enabled from app.person_notification_preferences p
     where p.person_id = p_person_id and p.category_code = p_category and p.channel = p_channel and p.deleted_at is null),
    (select bool_or(d.enabled) from app.account_notification_defaults d
     join app.account_memberships m on m.org_id = d.org_id and m.person_id = p_person_id and m.deleted_at is null
       and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
     where d.category_code = p_category and d.channel = p_channel and d.deleted_at is null),
    (select d.enabled_by_default from private.channel_defaults d where d.channel = p_channel));
$$;

comment on function private.person_channel_enabled(uuid, text, app.notification_channel) is 'Whether an external party receives a category on a channel: their own preference, else the defaults of their company accounts (on when any has it on), else the channel default.';

-- RPC -----------------------------------------------------------------------------------------------------------------

create or replace function app.set_account_notification_defaults(p_account_id uuid, p_defaults jsonb)
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
  if p_account_id is null
     or p_account_id not in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[])) then
    raise exception using errcode = '42501', message = 'an Account Owner or Admin sets the company''s notification defaults';
  end if;
  if jsonb_typeof(p_defaults) <> 'array' then
    perform private.refuse('notification_defaults_invalid', 'Defaults come as a list.');
  end if;
  for v_d in select * from jsonb_array_elements(p_defaults) loop
    if (v_d ->> 'channel') not in ('Email', 'Push') then
      perform private.refuse('notification_channel_outside', 'A company sets Email and Push only.');
    end if;
    update app.account_notification_defaults set enabled = (v_d ->> 'enabled')::boolean
    where org_id = p_account_id and category_code = v_d ->> 'category'
      and channel = (v_d ->> 'channel')::app.notification_channel and deleted_at is null;
    if not found then
      insert into app.account_notification_defaults (org_id, category_code, channel, enabled)
      values (p_account_id, v_d ->> 'category', (v_d ->> 'channel')::app.notification_channel, (v_d ->> 'enabled')::boolean);
    end if;
  end loop;
end;
$$;

comment on function app.set_account_notification_defaults(uuid, jsonb) is 'Sets a company account''s notification defaults, [{category, channel, enabled}] for Email and Push (Account Owner or Admin). Each change is audited.';

-- Retention -----------------------------------------------------------------------------------------------------------

call private.install_default_retention('app.account_notification_defaults', interval '90 days');

-- Privileges ----------------------------------------------------------------------------------------------------------

revoke all on function private.person_channel_enabled(uuid, text, app.notification_channel) from public, anon, authenticated;
revoke all on function app.set_account_notification_defaults(uuid, jsonb) from public, anon;
grant execute on function app.set_account_notification_defaults(uuid, jsonb) to authenticated;
