-- 0520_notifications.sql
-- A18 Platform Services. Notifications and messaging (Section 7.3 Messaging, Section 14.5, Section 7.5
-- invariant 3):
--   * notification categories, channels, the email template registry and the notification template map
--     (platform reference data in private, shown through app views; ADR 0016 rule 5)
--   * notifications and notification_deliveries in monthly partitions (deliveries partition on their
--     notification's month so both expire together)
--   * notification_preferences (category by channel), notification_settings (quiet hours and digests),
--     suppression_list, push_subscriptions and email_digest_queue
--   * private.notify, which resolves preferences, suppressions, SMS consent, quiet hours and digests into
--     deliveries, and the worker API that claims and records them
-- Copy never lives here: subjects and bodies come from the packages/i18n email namespace keyed by kind.

create type app.notification_channel as enum ('In App', 'Email', 'SMS', 'Push');
comment on type app.notification_channel is 'Channels a notification can reach a person on.';

create type app.message_status as enum ('Queued', 'Deferred', 'Digest', 'Sent', 'Delivered', 'Bounced', 'Failed', 'Suppressed');
comment on type app.message_status is 'Delivery status of one notification on one channel (a delivery status, ADR 0002). Deferred waits for quiet hours to end; Digest waits for the next digest email; Suppressed was never sent.';

create type app.digest_frequency as enum ('Off', 'Daily', 'Weekly');
comment on type app.digest_frequency is 'How often a person receives non-urgent email as one digest.';

create type app.suppression_reason as enum ('Hard Bounce', 'Complaint', 'Unsubscribe', 'STOP', 'Manual');
comment on type app.suppression_reason is 'Why an address receives nothing: provider feedback, the person''s opt-out, or an admin.';

-- Reference data -----------------------------------------------------------------------------------------

create table private.notification_categories (
  code text primary key,
  urgent boolean not null,
  sort_order smallint not null unique,
  constraint notification_categories_code_format check (code ~ '^[a-z][a-z_]*$')
);

comment on table private.notification_categories is 'Notification categories a person sets preferences for, by channel. Urgent categories bypass quiet hours and digests. Labels come from the i18n catalogs keyed by code.';
comment on column private.notification_categories.code is 'Category code.';
comment on column private.notification_categories.urgent is 'True for safety and account security, which reach the person at once on every enabled channel.';
comment on column private.notification_categories.sort_order is 'Display order in the preference matrix.';

insert into private.notification_categories (code, urgent, sort_order) values
  ('mentions', false, 1),
  ('assignments', false, 2),
  ('approvals', false, 3),
  ('comments', false, 4),
  ('schedule', false, 5),
  ('finance', false, 6),
  ('safety', true, 7),
  ('account', true, 8),
  ('reports', false, 9),
  ('imports', false, 10);

create table private.channel_defaults (
  channel app.notification_channel primary key,
  enabled_by_default boolean not null
);

comment on table private.channel_defaults is 'Whether a channel is on when a person has stated no preference. SMS is off until the person opts in (Section 14.5).';
comment on column private.channel_defaults.channel is 'Channel.';
comment on column private.channel_defaults.enabled_by_default is 'True when the channel is on without a preference row.';

insert into private.channel_defaults (channel, enabled_by_default) values
  ('In App', true), ('Email', true), ('SMS', false), ('Push', true);

create table private.email_templates (
  code text primary key,
  description text not null,
  transactional boolean not null,
  constraint email_templates_code_format check (code ~ '^[a-z][a-z_]*$'),
  constraint email_templates_description_length check (char_length(btrim(description)) between 1 and 300)
);

comment on table private.email_templates is 'React Email templates in packages/email. Copy comes from the i18n email namespace under the same code.';
comment on column private.email_templates.code is 'Template code, matching the packages/email template and the email.{code} catalog keys.';
comment on column private.email_templates.description is 'What the email is for.';
comment on column private.email_templates.transactional is 'True for transactional email, which carries no unsubscribe link (CAN-SPAM and CASL treat it separately).';

insert into private.email_templates (code, description, transactional) values
  ('notification', 'One notification: what happened, on which record, with a link to open it.', false),
  ('digest', 'Several notifications gathered into one daily or weekly email.', false),
  ('invite', 'An invitation to join an organization.', true),
  ('report_delivery', 'A scheduled report attached as PDF, CSV or .xlsx.', false),
  ('export_ready', 'A requested export is ready to download.', true),
  ('import_finished', 'An import finished validating or committing.', true),
  ('dsar_received', 'Acknowledges a data subject request and states its due date.', true);

create table private.notification_templates (
  kind text not null,
  channel app.notification_channel not null,
  category_code text not null references private.notification_categories (code),
  email_template_code text references private.email_templates (code),
  primary key (kind, channel),
  constraint notification_templates_kind_format check (kind ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  constraint notification_templates_email_template check ((channel = 'Email') = (email_template_code is not null))
);

create index notification_templates_category_code_idx on private.notification_templates (category_code);
create index notification_templates_email_template_code_idx on private.notification_templates (email_template_code);

comment on table private.notification_templates is 'Which category each notification kind belongs to and which email template renders it. Copy for every channel comes from the i18n catalogs keyed by kind.';
comment on column private.notification_templates.kind is 'Notification kind, subject first, for example approval.requested.';
comment on column private.notification_templates.channel is 'Channel the row applies to.';
comment on column private.notification_templates.category_code is 'Preference category of the kind.';
comment on column private.notification_templates.email_template_code is 'React Email template for the Email channel.';

insert into private.notification_templates (kind, channel, category_code, email_template_code)
select k.kind, c.channel, k.category, case when c.channel = 'Email' then 'notification' end
from (values
  ('mention.created', 'mentions'),
  ('assignment.created', 'assignments'),
  ('approval.requested', 'approvals'),
  ('approval.decided', 'approvals'),
  ('comment.created', 'comments'),
  ('shift.assigned', 'schedule'),
  ('shift.changed', 'schedule'),
  ('invoice.approved', 'finance'),
  ('incident.reported', 'safety'),
  ('account.security_changed', 'account'),
  ('report.delivered', 'reports'),
  ('import.finished', 'imports'),
  ('export.ready', 'imports')
) as k (kind, category)
cross join (values ('In App'::app.notification_channel), ('Email'), ('SMS'), ('Push')) as c (channel);

update private.notification_templates set email_template_code = 'report_delivery' where kind = 'report.delivered' and channel = 'Email';
update private.notification_templates set email_template_code = 'import_finished' where kind = 'import.finished' and channel = 'Email';
update private.notification_templates set email_template_code = 'export_ready' where kind = 'export.ready' and channel = 'Email';

alter table private.notification_categories enable row level security;
alter table private.channel_defaults enable row level security;
alter table private.email_templates enable row level security;
alter table private.notification_templates enable row level security;
revoke all on private.notification_categories, private.channel_defaults, private.email_templates, private.notification_templates
  from public, anon, authenticated;
grant select on private.notification_categories, private.channel_defaults, private.email_templates, private.notification_templates
  to service_role;

create view app.notification_categories as
select c.code, c.urgent, c.sort_order from private.notification_categories c;
comment on view app.notification_categories is 'Notification categories for the preference matrix.';
comment on column app.notification_categories.code is 'Category code.';
comment on column app.notification_categories.urgent is 'True when quiet hours and digests do not apply.';
comment on column app.notification_categories.sort_order is 'Display order.';

create view app.email_templates as
select t.code, t.description, t.transactional from private.email_templates t;
comment on view app.email_templates is 'Email templates in packages/email.';
comment on column app.email_templates.code is 'Template code.';
comment on column app.email_templates.description is 'What the email is for.';
comment on column app.email_templates.transactional is 'True for transactional email.';

create view app.notification_templates as
select t.kind, t.channel, t.category_code, t.email_template_code from private.notification_templates t;
comment on view app.notification_templates is 'Category and email template of every notification kind and channel.';
comment on column app.notification_templates.kind is 'Notification kind.';
comment on column app.notification_templates.channel is 'Channel.';
comment on column app.notification_templates.category_code is 'Preference category.';
comment on column app.notification_templates.email_template_code is 'Email template for the Email channel.';

revoke all on app.notification_categories, app.email_templates, app.notification_templates from public, anon;
grant select on app.notification_categories, app.email_templates, app.notification_templates to authenticated, service_role;

-- Notifications (partitioned) --------------------------------------------------------------------------

create table app.notifications (
  id uuid not null default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  recipient_person_id uuid not null references app.people (id),
  kind text not null,
  actor_person_id uuid references app.people (id),
  subject_table text,
  subject_id uuid,
  project_id uuid references app.projects (id),
  message_args jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (id, created_at),
  constraint notifications_message_args_object check (jsonb_typeof(message_args) = 'object'),
  constraint notifications_subject_pair check ((subject_table is null) = (subject_id is null))
) partition by range (created_at);

create index notifications_recipient_idx on app.notifications (recipient_person_id, org_id, created_at);
create index notifications_actor_person_id_idx on app.notifications (actor_person_id);
create index notifications_project_id_idx on app.notifications (project_id);
create index notifications_unread_idx on app.notifications (recipient_person_id) where read_at is null and archived_at is null;

call private.install_domain_table('app.notifications');
call private.describe('app.notifications', 'Inbox notifications (Section 7.3), one per recipient, in monthly partitions. Readable only by the recipient while they belong to the org (invariant 3). Copy is rendered from the i18n catalogs by kind with message_args.', array[
  'id', 'Notification id, UUID v7.',
  'recipient_person_id', 'Person the notification is for.',
  'kind', 'Notification kind from app.notification_templates.',
  'actor_person_id', 'Person whose action caused it, when one did.',
  'subject_table', 'Table of the record it is about.',
  'subject_id', 'Id of the record it is about.',
  'project_id', 'Project of the record, when it belongs to one.',
  'message_args', 'ICU message arguments for the kind''s catalog messages (display values such as a record title). Never relational data.',
  'read_at', 'When the recipient read it.',
  'archived_at', 'When the recipient archived it.'
]);

insert into private.partitioned_tables (table_name, partition_column, premake_months, maintenance_order)
values ('app.notifications', 'created_at', 3, 50);
select private.ensure_partitions('app.notifications');

create or replace function private.guard_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from private.notification_templates t where t.kind = new.kind) then
      perform private.refuse('notification_kind_unknown', format('%s is not a notification kind.', new.kind));
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['read_at', 'archived_at', 'updated_at', 'updated_by'])
     <> (to_jsonb(old) - array['read_at', 'archived_at', 'updated_at', 'updated_by']) then
    perform private.refuse('notification_immutable', 'A notification is only marked read or archived.');
  end if;
  return new;
end;
$$;

comment on function private.guard_notification() is 'Notifications: the kind must exist; afterwards only read and archived times change.';

create trigger t40_guard_notification before insert or update on app.notifications
  for each row execute function private.guard_notification();

call private.install_policies('app.notifications',
  $$recipient_person_id = (select private.current_person_id()) and org_id in (select private.my_org_ids())$$,
  null,
  $$recipient_person_id = (select private.current_person_id()) and org_id in (select private.my_org_ids())$$);

-- Deliveries (partitioned on the notification's month) ---------------------------------------------------

create table app.notification_deliveries (
  id uuid not null default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  notification_id uuid not null,
  notification_created_at timestamptz not null,
  channel app.notification_channel not null,
  message_status app.message_status not null default 'Queued',
  deliver_after timestamptz not null default now(),
  attempt_count smallint not null default 0,
  provider_message_id text,
  last_error text,
  sent_at timestamptz,
  primary key (id, notification_created_at),
  foreign key (notification_id, notification_created_at) references app.notifications (id, created_at),
  constraint notification_deliveries_not_in_app check (channel <> 'In App'),
  constraint notification_deliveries_provider_id_length check (provider_message_id is null or char_length(provider_message_id) <= 200),
  constraint notification_deliveries_last_error_length check (last_error is null or char_length(last_error) <= 2000)
) partition by range (notification_created_at);

create index notification_deliveries_notification_idx on app.notification_deliveries (notification_id, notification_created_at);
create index notification_deliveries_due_idx on app.notification_deliveries (channel, deliver_after) where message_status in ('Queued', 'Deferred');
create index notification_deliveries_provider_idx on app.notification_deliveries (provider_message_id);

call private.install_domain_table('app.notification_deliveries', 'app.notifications', 'notification_id');
call private.describe('app.notification_deliveries', 'One notification on one outside channel (Email, SMS, Push), partitioned on the notification''s month so both expire together. Written by private.notify and the delivery worker.', array[
  'id', 'Delivery id, UUID v7.',
  'notification_id', 'Notification delivered.',
  'notification_created_at', 'Creation time of the notification: its partition key, checked by the foreign key.',
  'channel', 'Email, SMS or Push.',
  'message_status', 'Queued, Deferred, Digest, Sent, Delivered, Bounced, Failed or Suppressed.',
  'deliver_after', 'Earliest send time: now, or the end of the recipient''s quiet hours.',
  'attempt_count', 'Send attempts so far.',
  'provider_message_id', 'Message id returned by Resend, Twilio or Expo.',
  'last_error', 'Error of the latest failed attempt, or why the delivery was suppressed.',
  'sent_at', 'When the provider accepted the message.'
]);

insert into private.partitioned_tables (table_name, partition_column, premake_months, maintenance_order)
values ('app.notification_deliveries', 'notification_created_at', 3, 40);
select private.ensure_partitions('app.notification_deliveries');

create or replace function private.is_my_notification(p_notification_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.notifications n
    where n.id = p_notification_id and n.recipient_person_id = private.current_person_id()
      and n.org_id in (select private.my_org_ids())
  );
$$;

comment on function private.is_my_notification(uuid) is 'True when the signed-in person is the recipient of a notification and still belongs to its org. Takes the id as an argument (ADR 0016 rule 14).';

call private.install_policies('app.notification_deliveries', $$private.is_my_notification(notification_id)$$);

-- Preferences and settings -----------------------------------------------------------------------------------

create table app.notification_preferences (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  category_code text not null references private.notification_categories (code),
  channel app.notification_channel not null,
  enabled boolean not null
);

create index notification_preferences_membership_idx on app.notification_preferences (membership_id);
create index notification_preferences_category_code_idx on app.notification_preferences (category_code);

call private.install_domain_table('app.notification_preferences', 'app.memberships', 'membership_id');
call private.describe('app.notification_preferences', 'The preference matrix: one row per member, category and channel the member set. Without a row the channel default applies.', array[
  'membership_id', 'Membership whose preference this is; preferences are per org.',
  'category_code', 'Notification category.',
  'channel', 'Channel.',
  'enabled', 'True to receive the category on the channel.'
]);

create unique index notification_preferences_unique on app.notification_preferences (membership_id, category_code, channel) where deleted_at is null;

call private.install_policies('app.notification_preferences',
  $$membership_id in (select private.my_membership_ids())$$,
  $$membership_id in (select private.my_membership_ids())$$);

create table app.notification_settings (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  time_zone text not null,
  quiet_hours_start time,
  quiet_hours_end time,
  digest_frequency app.digest_frequency not null default 'Off',
  digest_hour smallint not null default 8,
  constraint notification_settings_quiet_pair check ((quiet_hours_start is null) = (quiet_hours_end is null)),
  constraint notification_settings_quiet_distinct check (quiet_hours_start is distinct from quiet_hours_end or quiet_hours_start is null),
  constraint notification_settings_digest_hour check (digest_hour between 0 and 23)
);

call private.install_domain_table('app.notification_settings', 'app.memberships', 'membership_id');
create unique index notification_settings_membership_key on app.notification_settings (membership_id) where deleted_at is null;
call private.describe('app.notification_settings', 'Quiet hours and digest choice of a member (Section 14.5: quiet hours by recipient time zone). SMS and push wait while quiet hours last; non-urgent email joins the digest when one is chosen.', array[
  'membership_id', 'Membership the settings belong to.',
  'time_zone', 'IANA time zone quiet hours and the digest hour are read in.',
  'quiet_hours_start', 'Local time quiet hours begin; may be later than the end to span midnight.',
  'quiet_hours_end', 'Local time quiet hours end.',
  'digest_frequency', 'Off, Daily or Weekly.',
  'digest_hour', 'Local hour the digest is sent.'
]);

create or replace function private.guard_notification_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_time_zone(new.time_zone);
  return new;
end;
$$;

comment on function private.guard_notification_settings() is 'Notification settings carry a known IANA time zone.';

create trigger t40_guard_notification_settings before insert or update on app.notification_settings
  for each row execute function private.guard_notification_settings();

call private.install_policies('app.notification_settings',
  $$membership_id in (select private.my_membership_ids())$$,
  $$membership_id in (select private.my_membership_ids())$$);

-- Suppression list -------------------------------------------------------------------------------------------

create table app.suppression_list (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  channel app.notification_channel not null,
  address text not null,
  reason app.suppression_reason not null,
  category_code text references private.notification_categories (code),
  suppressed_at timestamptz not null default now(),
  lifted_at timestamptz,
  constraint suppression_list_channel check (channel in ('Email', 'SMS')),
  constraint suppression_list_address_format check (
    (channel = 'Email' and address = lower(address) and address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
    or (channel = 'SMS' and address ~ '^\+[1-9][0-9]{6,14}$')),
  constraint suppression_list_lift_after check (lifted_at is null or lifted_at >= suppressed_at)
);

create index suppression_list_category_code_idx on app.suppression_list (category_code);

call private.install_domain_table('app.suppression_list');
create index suppression_list_lookup_idx on app.suppression_list (org_id, channel, address) where lifted_at is null and deleted_at is null;
call private.describe('app.suppression_list', 'Addresses an org sends nothing to on a channel (Section 14.5 CAN-SPAM, CASL and TCPA): hard bounces and complaints from the provider, unsubscribes, STOP replies and manual entries. A category limits an unsubscribe to that category.', array[
  'channel', 'Email or SMS.',
  'address', 'Lowercased email address or E.164 phone number.',
  'reason', 'Why the address is suppressed.',
  'category_code', 'Category the suppression covers, or null for every non-transactional message.',
  'suppressed_at', 'When the suppression began. Set by the database.',
  'lifted_at', 'When an admin lifted it, for example after a fixed mailbox.'
]);

create trigger t40_stamp_suppressed_at before insert on app.suppression_list
  for each row execute function private.stamp_received_now('suppressed_at');

call private.install_policies('app.suppression_list',
  $$org_id in (select private.orgs_with_capability('org.notifications.write'))$$,
  $$org_id in (select private.orgs_with_capability('org.notifications.write'))$$);
call private.install_audit_trail('app.suppression_list');

-- Push subscriptions -------------------------------------------------------------------------------------------

create table app.push_subscriptions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  expo_push_token text not null,
  platform text not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint push_subscriptions_token_format check (expo_push_token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$'),
  constraint push_subscriptions_platform check (platform in ('ios', 'android', 'web'))
);

call private.install_domain_table('app.push_subscriptions', 'app.memberships', 'membership_id');
create unique index push_subscriptions_token_key on app.push_subscriptions (membership_id, expo_push_token) where deleted_at is null;
call private.describe('app.push_subscriptions', 'Compass devices registered for push through Expo Notifications, per membership, so leaving an org stops its pushes (invariant 3).', array[
  'membership_id', 'Membership the device receives pushes for.',
  'expo_push_token', 'Expo push token of the device.',
  'platform', 'ios, android or web.',
  'last_seen_at', 'Last time the device re-registered.',
  'revoked_at', 'When the token was revoked by the person or rejected by Expo.'
]);

call private.install_policies('app.push_subscriptions',
  $$membership_id in (select private.my_membership_ids())$$,
  $$membership_id in (select private.my_membership_ids())$$);

-- Email digest queue -------------------------------------------------------------------------------------------

create table app.email_digest_queue (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  notification_delivery_id uuid not null,
  notification_created_at timestamptz not null,
  membership_id uuid not null references app.memberships (id),
  due_at timestamptz not null,
  sent_at timestamptz,
  foreign key (notification_delivery_id, notification_created_at) references app.notification_deliveries (id, notification_created_at)
);

create index email_digest_queue_delivery_idx on app.email_digest_queue (notification_delivery_id, notification_created_at);
create index email_digest_queue_membership_due_idx on app.email_digest_queue (membership_id, due_at) where sent_at is null;

call private.install_domain_table('app.email_digest_queue', 'app.memberships', 'membership_id');
call private.describe('app.email_digest_queue', 'Email deliveries waiting for a member''s next digest. The digest job sends one email per member when due_at passes and marks the rows sent.', array[
  'notification_delivery_id', 'Email delivery the digest carries.',
  'notification_created_at', 'Partition key of the delivery, checked by the foreign key.',
  'membership_id', 'Member the digest goes to.',
  'due_at', 'When the digest that carries this delivery is due.',
  'sent_at', 'When the digest was sent.'
]);

call private.install_policies('app.email_digest_queue', $$membership_id in (select private.my_membership_ids())$$);

-- Resolution and sending -----------------------------------------------------------------------------------

create or replace function private.local_quiet_until(p_membership_id uuid, p_at timestamptz)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_s app.notification_settings;
  v_local timestamp;
  v_t time;
  v_end_local timestamp;
begin
  select * into v_s from app.notification_settings s where s.membership_id = p_membership_id and s.deleted_at is null;
  if v_s.id is null or v_s.quiet_hours_start is null then
    return null;
  end if;
  v_local := p_at at time zone v_s.time_zone;
  v_t := v_local::time;
  if v_s.quiet_hours_start < v_s.quiet_hours_end then
    if v_t >= v_s.quiet_hours_start and v_t < v_s.quiet_hours_end then
      v_end_local := v_local::date + v_s.quiet_hours_end;
    end if;
  elsif v_t >= v_s.quiet_hours_start then
    v_end_local := (v_local::date + 1) + v_s.quiet_hours_end;
  elsif v_t < v_s.quiet_hours_end then
    v_end_local := v_local::date + v_s.quiet_hours_end;
  end if;
  if v_end_local is null then
    return null;
  end if;
  return v_end_local at time zone v_s.time_zone;
end;
$$;

comment on function private.local_quiet_until(uuid, timestamptz) is 'When the member''s quiet hours end, if p_at falls inside them in the member''s time zone; null otherwise. Handles quiet hours that span midnight.';

create or replace function private.next_digest_at(p_membership_id uuid, p_at timestamptz)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_s app.notification_settings;
  v_local timestamp;
  v_next timestamp;
begin
  select * into v_s from app.notification_settings s where s.membership_id = p_membership_id and s.deleted_at is null;
  if v_s.id is null or v_s.digest_frequency = 'Off' then
    return null;
  end if;
  v_local := p_at at time zone v_s.time_zone;
  v_next := v_local::date + make_time(v_s.digest_hour, 0, 0);
  if v_next <= v_local then
    v_next := v_next + interval '1 day';
  end if;
  if v_s.digest_frequency = 'Weekly' then
    while extract(isodow from v_next) <> 1 loop
      v_next := v_next + interval '1 day';
    end loop;
  end if;
  return v_next at time zone v_s.time_zone;
end;
$$;

comment on function private.next_digest_at(uuid, timestamptz) is 'Next digest time of a member after p_at: their digest hour today or tomorrow, on Monday for weekly digests; null when digests are off.';

create or replace function private.channel_enabled(p_membership_id uuid, p_category text, p_channel app.notification_channel)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.enabled from app.notification_preferences p
     where p.membership_id = p_membership_id and p.category_code = p_category and p.channel = p_channel and p.deleted_at is null),
    (select d.enabled_by_default from private.channel_defaults d where d.channel = p_channel));
$$;

comment on function private.channel_enabled(uuid, text, app.notification_channel) is 'Whether a member receives a category on a channel: their preference, or the channel default.';

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
  if v_membership is null then
    return null;
  end if;
  v_urgent := (select c.urgent from private.notification_categories c where c.code = v_category);
  insert into app.notifications (org_id, recipient_person_id, kind, actor_person_id, subject_table, subject_id, project_id, message_args)
  values (p_org_id, p_recipient_person_id, p_kind, private.current_person_id(), p_subject_table, p_subject_id, p_project_id,
    coalesce(p_message_args, '{}'::jsonb))
  returning id, created_at into v_id, v_created;

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

comment on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) is 'Creates a notification for an active member and one delivery per outside channel they receive the category on: SMS and push wait out quiet hours and non-urgent email joins the digest when the member chose one. Urgent categories go at once. A person without an active membership gets nothing (invariant 3). Returns the notification id, or null.';

create or replace function private.recipient_address(p_person_id uuid, p_channel app.notification_channel)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case p_channel
    when 'Email' then (select lower(u.email) from auth.users u join app.people p on p.user_id = u.id where p.id = p_person_id)
    when 'SMS' then (select u.phone from auth.users u join app.people p on p.user_id = u.id where p.id = p_person_id and u.phone_confirmed_at is not null)
  end;
$$;

comment on function private.recipient_address(uuid, app.notification_channel) is 'Verified sign-in email or phone of a person, the only addresses notifications go to.';

create or replace function app.claim_notification_deliveries(p_channel app.notification_channel, p_limit integer default 50)
returns table (
  delivery_id uuid, org_id uuid, recipient_person_id uuid, address text, kind text, email_template_code text,
  message_args jsonb, subject_table text, subject_id uuid, push_tokens text[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_address text;
  v_reason text;
  v_category text;
  v_transactional boolean;
begin
  for v_row in
    select d.id, d.notification_created_at, n.org_id, n.recipient_person_id, n.kind, n.message_args, n.subject_table, n.subject_id,
      t.email_template_code, t.category_code
    from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    join private.notification_templates t on t.kind = n.kind and t.channel = d.channel
    where d.channel = p_channel and d.message_status in ('Queued', 'Deferred') and d.deliver_after <= now()
    order by d.deliver_after
    limit least(greatest(p_limit, 1), 500)
    for update of d skip locked
  loop
    v_reason := null;
    v_address := private.recipient_address(v_row.recipient_person_id, p_channel);
    v_transactional := coalesce((select e.transactional from private.email_templates e where e.code = v_row.email_template_code), false);
    if v_row.org_id not in (select private.person_org_ids(v_row.recipient_person_id)) then
      v_reason := 'Recipient no longer belongs to the org.';
    elsif p_channel in ('Email', 'SMS') and v_address is null then
      v_reason := 'No verified address on the channel.';
    elsif p_channel in ('Email', 'SMS') and exists (
      select 1 from app.suppression_list s
      where s.org_id = v_row.org_id and s.channel = p_channel and s.address = v_address and s.lifted_at is null and s.deleted_at is null
        and (s.reason in ('Hard Bounce', 'Complaint', 'STOP', 'Manual')
             or (not v_transactional and (s.category_code is null or s.category_code = v_row.category_code)))) then
      v_reason := 'Address is on the suppression list.';
    elsif p_channel = 'SMS' and not coalesce((select c.may_text from app.sms_consent_status c
                                              where c.org_id = v_row.org_id and c.phone_e164 = v_address), false) then
      v_reason := 'No SMS consent for the number.';
    elsif p_channel = 'Push' and not exists (
      select 1 from app.push_subscriptions ps join app.memberships m on m.id = ps.membership_id
      where m.person_id = v_row.recipient_person_id and ps.org_id = v_row.org_id and ps.revoked_at is null and ps.deleted_at is null) then
      v_reason := 'No registered device.';
    end if;
    if v_reason is not null then
      update app.notification_deliveries set message_status = 'Suppressed', last_error = v_reason
      where id = v_row.id and notification_created_at = v_row.notification_created_at;
      continue;
    end if;
    update app.notification_deliveries set attempt_count = attempt_count + 1, message_status = 'Queued', deliver_after = now() + interval '10 minutes'
    where id = v_row.id and notification_created_at = v_row.notification_created_at;
    delivery_id := v_row.id;
    org_id := v_row.org_id;
    recipient_person_id := v_row.recipient_person_id;
    address := v_address;
    kind := v_row.kind;
    email_template_code := v_row.email_template_code;
    message_args := v_row.message_args;
    subject_table := v_row.subject_table;
    subject_id := v_row.subject_id;
    push_tokens := case when p_channel = 'Push' then (
      select array_agg(ps.expo_push_token order by ps.last_seen_at desc) from app.push_subscriptions ps
      join app.memberships m on m.id = ps.membership_id
      where m.person_id = v_row.recipient_person_id and ps.org_id = v_row.org_id and ps.revoked_at is null and ps.deleted_at is null) end;
    return next;
  end loop;
end;
$$;

comment on function app.claim_notification_deliveries(app.notification_channel, integer) is 'Worker API (service role): claims due deliveries of a channel with SKIP LOCKED. Suppresses, with the reason, any delivery whose recipient left the org, has no verified address, is suppressed, lacks SMS consent or has no device. Returns what the sender needs; a claimed delivery becomes due again after 10 minutes unless its outcome is recorded.';

create or replace function app.record_notification_delivery(
  p_delivery_id uuid,
  p_status app.message_status,
  p_provider_message_id text default null,
  p_error text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_d record;
begin
  if p_status not in ('Sent', 'Delivered', 'Bounced', 'Failed') then
    perform private.refuse('delivery_status_invalid', 'A sender records Sent, Delivered, Bounced or Failed.');
  end if;
  select d.id, d.notification_created_at, d.org_id, d.channel, d.attempt_count into v_d
  from app.notification_deliveries d where d.id = p_delivery_id for update;
  if v_d.id is null then
    perform private.refuse('delivery_unknown', 'No such delivery.');
  end if;
  update app.notification_deliveries
  set message_status = case when p_status = 'Failed' and v_d.attempt_count < 5 then 'Queued'::app.message_status else p_status end,
    deliver_after = case when p_status = 'Failed' then now() + private.webhook_retry_delay(v_d.attempt_count) else deliver_after end,
    provider_message_id = coalesce(left(p_provider_message_id, 200), provider_message_id),
    last_error = left(p_error, 2000),
    sent_at = case when p_status in ('Sent', 'Delivered') then coalesce(sent_at, now()) else sent_at end
  where id = p_delivery_id and notification_created_at = v_d.notification_created_at;
  if p_status = 'Sent' then
    perform private.record_usage(v_d.org_id,
      case v_d.channel when 'Email' then 'emails_sent' when 'SMS' then 'sms_segments' else 'push_sent' end, 1, p_delivery_id);
  end if;
end;
$$;

comment on function app.record_notification_delivery(uuid, app.message_status, text, text) is 'Worker and provider webhook API (service role): records a send outcome. A failure retries with backoff up to 5 attempts. A sent message counts toward usage.';

create or replace function app.record_email_feedback(p_org_id uuid, p_address text, p_reason app.suppression_reason)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into app.suppression_list (org_id, channel, address, reason)
  select p_org_id, 'Email', lower(p_address), p_reason
  where not exists (select 1 from app.suppression_list s where s.org_id = p_org_id and s.channel = 'Email'
                    and s.address = lower(p_address) and s.lifted_at is null and s.deleted_at is null and s.reason = p_reason);
$$;

comment on function app.record_email_feedback(uuid, text, app.suppression_reason) is 'Resend webhook API (service role): suppresses an address after a hard bounce or complaint, once.';

create or replace function app.mark_notifications_read(p_org_id uuid, p_before timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update app.notifications set read_at = now()
  where recipient_person_id = private.require_person() and org_id = p_org_id and org_id in (select private.my_org_ids())
    and read_at is null and created_at <= p_before;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.mark_notifications_read(uuid, timestamptz) is 'Marks the signed-in person''s notifications in an org read up to a time. Returns how many changed.';

-- Retention -----------------------------------------------------------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.notifications', 'Age', 'created_at', interval '13 months', 'Drop Partition', 'Inbox history kept 13 months.'),
  ('app.notification_deliveries', 'Age', 'notification_created_at', interval '13 months', 'Drop Partition', 'Kept as long as their notification.'),
  ('app.notification_preferences', 'Soft Deleted', 'deleted_at', interval '90 days', 'Delete', 'Replaced preferences carry no history value.'),
  ('app.notification_settings', 'Soft Deleted', 'deleted_at', interval '90 days', 'Delete', 'Replaced settings carry no history value.'),
  ('app.suppression_list', 'Soft Deleted', 'deleted_at', interval '7 years', 'Delete', 'Opt-out evidence (CAN-SPAM, TCPA) kept 7 years.'),
  ('app.push_subscriptions', 'Soft Deleted', 'deleted_at', interval '90 days', 'Delete', 'Removed devices carry no history value.'),
  ('app.email_digest_queue', 'Age', 'due_at', interval '90 days', 'Delete', 'Digest bookkeeping kept 90 days.');

-- Privileges -----------------------------------------------------------------------------------------------

revoke all on function private.guard_notification() from public, anon, authenticated;
revoke all on function private.is_my_notification(uuid) from public, anon;
grant execute on function private.is_my_notification(uuid) to authenticated;
revoke all on function private.guard_notification_settings() from public, anon, authenticated;
revoke all on function private.local_quiet_until(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.next_digest_at(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.channel_enabled(uuid, text, app.notification_channel) from public, anon, authenticated;
revoke all on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.recipient_address(uuid, app.notification_channel) from public, anon, authenticated;
revoke all on function app.claim_notification_deliveries(app.notification_channel, integer) from public, anon, authenticated;
grant execute on function app.claim_notification_deliveries(app.notification_channel, integer) to service_role;
revoke all on function app.record_notification_delivery(uuid, app.message_status, text, text) from public, anon, authenticated;
grant execute on function app.record_notification_delivery(uuid, app.message_status, text, text) to service_role;
revoke all on function app.record_email_feedback(uuid, text, app.suppression_reason) from public, anon, authenticated;
grant execute on function app.record_email_feedback(uuid, text, app.suppression_reason) to service_role;
revoke all on function app.mark_notifications_read(uuid, timestamptz) from public, anon;
grant execute on function app.mark_notifications_read(uuid, timestamptz) to authenticated, service_role;
