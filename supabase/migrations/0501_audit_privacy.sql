-- 0501_audit_privacy.sql
-- A18 Platform Services. Audit and privacy (Section 7.3 Audit and privacy, Section 7.5 invariant 23,
-- Section 8.4, Section 14.3):
--   * audit_events: the append-only compliance ledger, kept 7 years in monthly partitions, with
--     personal data redacted at 90 days at every JSON depth
--   * activity_events: the user-facing feed, kept 18 months in monthly partitions, one row per domain
--     event with the person who caused it
--   * consent_records, cookie_consent_events, sms_consent_events, privacy_signals (Global Privacy
--     Control), dsar_requests with the 30-day clock, and file_access_log
--   * rate limits for public and token RPCs (Section 9)
--   * the audit trail installer, attached to the access tables and this range's sensitive tables
--   * retention policies for every platform and domain table that exists, and the nightly job

-- Request context -----------------------------------------------------------------------------------

create or replace function private.request_header(p_name text)
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('request.headers', true), '')::jsonb ->> lower(p_name);
$$;

comment on function private.request_header(text) is 'A header of the current API request as PostgREST passes it, or null outside a request.';

create or replace function private.request_ip()
returns inet
language plpgsql
stable
set search_path = ''
as $$
declare
  v_raw text := btrim(split_part(coalesce(private.request_header('x-forwarded-for'), private.request_header('x-real-ip'), ''), ',', 1));
begin
  if v_raw = '' then
    return null;
  end if;
  return v_raw::inet;
exception when invalid_text_representation then
  return null;
end;
$$;

comment on function private.request_ip() is 'Client IP address of the current API request from the proxy headers, or null when absent or malformed.';

-- Rate limits (Section 9) ------------------------------------------------------------------------------

create table private.rate_limit_events (
  id bigint generated always as identity primary key,
  bucket text not null,
  subject_hash bytea not null,
  occurred_at timestamptz not null default now(),
  constraint rate_limit_events_bucket_format check (bucket ~ '^[a-z][a-z0-9_.]*$')
);

create index rate_limit_events_lookup_idx on private.rate_limit_events (bucket, subject_hash, occurred_at);

comment on table private.rate_limit_events is 'Counted attempts per rate limit bucket and subject (a hashed IP, person, device or token), pruned after a day.';
comment on column private.rate_limit_events.id is 'Attempt id.';
comment on column private.rate_limit_events.bucket is 'What is limited, for example verify_certification.failure or kiosk_pin.failure.';
comment on column private.rate_limit_events.subject_hash is 'SHA-256 of the subject the limit applies to; the raw value is never stored.';
comment on column private.rate_limit_events.occurred_at is 'When the attempt happened.';

alter table private.rate_limit_events enable row level security;
revoke all on private.rate_limit_events from public, anon, authenticated;
grant select on private.rate_limit_events to service_role;

create or replace function private.rate_limit_exceeded(p_bucket text, p_subject text, p_limit integer, p_window interval)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) >= p_limit from private.rate_limit_events e
  where e.bucket = p_bucket and e.subject_hash = extensions.digest(coalesce(p_subject, 'unknown'), 'sha256')
    and e.occurred_at > now() - p_window;
$$;

comment on function private.rate_limit_exceeded(text, text, integer, interval) is 'True when a subject has used up a bucket: p_limit attempts within p_window.';

create or replace function private.note_rate_event(p_bucket text, p_subject text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.rate_limit_events (bucket, subject_hash)
  values (p_bucket, extensions.digest(coalesce(p_subject, 'unknown'), 'sha256'));
$$;

comment on function private.note_rate_event(text, text) is 'Counts one attempt against a bucket for a subject.';

create or replace function private.prune_rate_limits()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count bigint;
begin
  delete from private.rate_limit_events where occurred_at < now() - interval '1 day';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function private.prune_rate_limits() is 'Deletes rate limit attempts older than a day; no window is longer.';

-- Audit events (append-only, partitioned) ---------------------------------------------------------------

create type app.actor_kind as enum ('Person', 'Service', 'System');
comment on type app.actor_kind is 'Who acted: a signed-in person, a platform service with the service role, or the database itself (scheduled jobs and triggers).';

create table app.audit_events (
  id uuid not null default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  actor_kind app.actor_kind not null,
  actor_person_id uuid references app.people (id),
  action text not null,
  subject_table text not null,
  subject_id uuid,
  diff jsonb not null default '{}'::jsonb,
  actor_ip inet,
  user_agent text,
  request_id text,
  redacted_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (id, created_at),
  constraint audit_events_diff_object check (jsonb_typeof(diff) = 'object'),
  constraint audit_events_action_format check (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint audit_events_person_actor check ((actor_kind = 'Person') = (actor_person_id is not null)),
  constraint audit_events_user_agent_length check (user_agent is null or char_length(user_agent) <= 500),
  constraint audit_events_request_id_length check (request_id is null or char_length(request_id) <= 200)
) partition by range (created_at);

create index audit_events_org_created_idx on app.audit_events (org_id, created_at);
create index audit_events_actor_person_id_idx on app.audit_events (actor_person_id);
create index audit_events_subject_idx on app.audit_events (subject_id);
create index audit_events_unredacted_idx on app.audit_events (created_at) where redacted_at is null;

call private.install_domain_table('app.audit_events');
call private.describe('app.audit_events', 'Append-only compliance ledger (Section 7.3, Section 8.4): who did what to which row, with a diff. Kept 7 years in monthly partitions; personal data in plaintext is redacted at 90 days at every JSON depth (invariant 23).', array[
  'id', 'Audit event id, UUID v7.',
  'actor_kind', 'Person, Service or System.',
  'actor_person_id', 'Person who acted, when a person acted.',
  'action', 'What happened, as table.operation (for example membership_roles.insert) or a named act (for example dsar.exported).',
  'subject_table', 'Table of the row acted on.',
  'subject_id', 'Id of the row acted on.',
  'diff', 'Audit diff: the new values on insert, the old and new values of changed columns on update, the old values on delete. Restricted columns and hashes are never included.',
  'actor_ip', 'Client IP address of the request. Removed at redaction.',
  'user_agent', 'Client user agent of the request. Removed at redaction.',
  'request_id', 'Request id from the API, for correlating with logs.',
  'redacted_at', 'When personal data in diff, actor_ip and user_agent was redacted.'
]);

insert into private.partitioned_tables (table_name, partition_column, premake_months, maintenance_order)
values ('app.audit_events', 'created_at', 3, 90);
select private.ensure_partitions('app.audit_events');

create or replace function private.guard_audit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.in_trusted_operation('audit_redaction')
     and tg_op = 'UPDATE'
     and (to_jsonb(new) - array['diff', 'actor_ip', 'user_agent', 'redacted_at', 'updated_at', 'updated_by'])
       = (to_jsonb(old) - array['diff', 'actor_ip', 'user_agent', 'redacted_at', 'updated_at', 'updated_by']) then
    return new;
  end if;
  perform private.refuse('append_only', 'audit_events is an append-only ledger; only redaction changes it.');
  return null;
end;
$$;

comment on function private.guard_audit_event() is 'Before update or delete trigger: the audit ledger is append-only (invariant 23); the redaction job alone may replace personal data. Expired months leave by partition detachment, never by delete.';

create trigger t95_append_only before update or delete on app.audit_events
  for each row execute function private.guard_audit_event();

call private.install_policies('app.audit_events',
  $$org_id in (select private.orgs_with_capability('audit.log.read'))$$);

create or replace function private.write_audit_event(
  p_org_id uuid,
  p_action text,
  p_subject_table text,
  p_subject_id uuid,
  p_diff jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
begin
  insert into app.audit_events (org_id, actor_kind, actor_person_id, action, subject_table, subject_id, diff,
    actor_ip, user_agent, request_id)
  values (
    p_org_id,
    case when v_person is not null then 'Person'
         when coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role' then 'Service'
         else 'System' end::app.actor_kind,
    v_person, p_action, p_subject_table, p_subject_id, coalesce(p_diff, '{}'::jsonb),
    private.request_ip(), left(private.request_header('user-agent'), 500), left(private.request_header('x-request-id'), 200));
end;
$$;

comment on function private.write_audit_event(uuid, text, text, uuid, jsonb) is 'Writes one audit event with the acting person, IP, user agent and request id taken from the session and request, never from the caller.';

-- Audit trail ---------------------------------------------------------------------------------------------
-- Columns never copied into a diff: the audit columns themselves, binary columns (hashes and secrets) and
-- columns classified Restricted (Section 8.3).

create or replace function private.audit_excluded_columns(p_table regclass)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array['created_at', 'created_by', 'updated_at', 'updated_by']
    || coalesce((select array_agg(a.attname::text) from pg_catalog.pg_attribute a
                 where a.attrelid = p_table and a.attnum > 0 and not a.attisdropped
                   and a.atttypid = 'bytea'::regtype), '{}')
    || coalesce((select array_agg(c.column_name) from private.column_classifications c
                 where c.table_name = p_table::text and c.classification = 'Restricted'), '{}');
$$;

comment on function private.audit_excluded_columns(regclass) is 'Columns an audit diff never carries for a table: audit columns, binary columns and Restricted columns.';

create or replace function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_excluded text[] := private.audit_excluded_columns(tg_relid);
  v_old jsonb;
  v_new jsonb;
  v_diff jsonb;
  v_row jsonb;
  v_key text;
begin
  if private.in_trusted_operation('retention_purge') then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := to_jsonb(old) - v_excluded;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := to_jsonb(new) - v_excluded;
  end if;
  v_row := coalesce(to_jsonb(new), to_jsonb(old));
  if (v_row ->> 'org_id') is null then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    v_diff := jsonb_build_object('old', '{}'::jsonb, 'new', '{}'::jsonb);
    for v_key in select k from jsonb_object_keys(v_new) k loop
      if (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_diff := jsonb_set(v_diff, array['old', v_key], coalesce(v_old -> v_key, 'null'::jsonb));
        v_diff := jsonb_set(v_diff, array['new', v_key], v_new -> v_key);
      end if;
    end loop;
    if v_diff -> 'new' = '{}'::jsonb then
      return null;
    end if;
  elsif tg_op = 'INSERT' then
    v_diff := jsonb_build_object('new', v_new);
  else
    v_diff := jsonb_build_object('old', v_old);
  end if;
  perform private.write_audit_event((v_row ->> 'org_id')::uuid, tg_table_name || '.' || lower(tg_op), tg_table_schema || '.' || tg_table_name,
    (v_row ->> 'id')::uuid, v_diff);
  return null;
end;
$$;

comment on function private.audit_row_change() is 'After insert, update or delete trigger: writes the row change to the audit ledger with a diff that leaves out audit columns, hashes and Restricted columns. Rows without an org and purge deletes are not audited.';

create or replace procedure private.install_audit_trail(p_table regclass)
language plpgsql
set search_path = ''
as $$
begin
  execute format('drop trigger if exists t85_audit_trail on %s', p_table);
  execute format('create trigger t85_audit_trail after insert or update or delete on %s for each row execute function private.audit_row_change()', p_table);
end;
$$;

comment on procedure private.install_audit_trail(regclass) is 'Attaches the audit trail trigger to a table so every change lands in app.audit_events.';

-- Access changes are compliance events (Section 8.4, Section 4.6.1: partner actions land in the client's ledger).
call private.install_audit_trail('app.subscriptions');
call private.install_audit_trail('app.memberships');
call private.install_audit_trail('app.roles');
call private.install_audit_trail('app.role_capabilities');
call private.install_audit_trail('app.membership_roles');
call private.install_audit_trail('app.user_capability_grants');
call private.install_audit_trail('app.record_grants');
call private.install_audit_trail('app.delegations');
call private.install_audit_trail('app.invites');
call private.install_audit_trail('app.legal_holds');

-- Activity events (partitioned) ------------------------------------------------------------------------------

create table app.activity_events (
  id uuid not null default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  domain_event_id uuid not null references app.domain_events (id),
  actor_person_id uuid references app.people (id),
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);

create index activity_events_org_created_idx on app.activity_events (org_id, created_at);
create index activity_events_domain_event_id_idx on app.activity_events (domain_event_id);
create index activity_events_actor_person_id_idx on app.activity_events (actor_person_id);

call private.install_domain_table('app.activity_events', 'app.domain_events', 'domain_event_id', '{}', true);
call private.describe('app.activity_events', 'User-facing activity feed (Section 7.3): one row per domain event with the person who caused it, kept 18 months in monthly partitions. What happened is read from the domain event, never restated.', array[
  'id', 'Activity id, UUID v7.',
  'domain_event_id', 'Domain event the activity shows.',
  'actor_person_id', 'Person whose action raised the event, or null for services and scheduled jobs.'
]);

insert into private.partitioned_tables (table_name, partition_column, premake_months, maintenance_order)
values ('app.activity_events', 'created_at', 3, 80);
select private.ensure_partitions('app.activity_events');

create or replace function private.can_read_domain_event(p_domain_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.domain_events e
    where e.id = p_domain_event_id
      and e.org_id in (select private.my_org_ids())
      and (e.project_id is null or e.project_id in (select private.readable_project_ids()))
  );
$$;

comment on function private.can_read_domain_event(uuid) is 'True when the signed-in person may see a domain event in their feed: a member of its org, and able to read its project when it has one (invariant 2). Takes the event id as an argument (ADR 0016 rule 14).';

call private.install_policies('app.activity_events', $$private.can_read_domain_event(domain_event_id)$$);

create or replace function private.record_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app.activity_events (domain_event_id, actor_person_id) values (new.id, private.current_person_id());
  return null;
end;
$$;

comment on function private.record_activity() is 'After insert trigger on app.domain_events: adds the event to the activity feed with the person whose action raised it.';

create trigger t86_record_activity after insert on app.domain_events
  for each row execute function private.record_activity();

-- Consent (Section 14.3, Section 14.5) -------------------------------------------------------------------

create table private.consent_purposes (
  code text primary key,
  lawful_basis text not null,
  sort_order smallint not null unique,
  constraint consent_purposes_code_format check (code ~ '^[a-z][a-z_]*$'),
  constraint consent_purposes_lawful_basis check (lawful_basis in ('consent', 'contract', 'legal_obligation', 'legitimate_interests'))
);

comment on table private.consent_purposes is 'Processing purposes that consent is recorded for, with their lawful basis (Section 14.3 lawful basis registry). Labels come from the i18n catalogs keyed by code.';
comment on column private.consent_purposes.code is 'Purpose code.';
comment on column private.consent_purposes.lawful_basis is 'GDPR Article 6 basis the purpose relies on.';
comment on column private.consent_purposes.sort_order is 'Display order.';

alter table private.consent_purposes enable row level security;
revoke all on private.consent_purposes from public, anon, authenticated;
grant select on private.consent_purposes to service_role;

insert into private.consent_purposes (code, lawful_basis, sort_order) values
  ('transactional_email', 'contract', 1),
  ('product_updates_email', 'consent', 2),
  ('marketing_email', 'consent', 3),
  ('sms_notifications', 'consent', 4),
  ('push_notifications', 'consent', 5),
  ('profile_sharing', 'consent', 6),
  ('ai_features', 'consent', 7),
  ('analytics', 'consent', 8),
  ('electronic_records', 'consent', 9);

create view app.consent_purposes as
select p.code, p.lawful_basis, p.sort_order from private.consent_purposes p;
comment on view app.consent_purposes is 'Processing purposes with their lawful basis.';
comment on column app.consent_purposes.code is 'Purpose code.';
comment on column app.consent_purposes.lawful_basis is 'Lawful basis.';
comment on column app.consent_purposes.sort_order is 'Display order.';
revoke all on app.consent_purposes from public, anon;
grant select on app.consent_purposes to authenticated, service_role;

create type app.consent_source as enum ('Web', 'Mobile', 'Email', 'SMS', 'Import', 'Support');
comment on type app.consent_source is 'Where a consent decision was captured.';

create table app.consent_records (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  purpose_code text not null references private.consent_purposes (code),
  notice_version text not null,
  source app.consent_source not null,
  captured_at timestamptz not null default now(),
  captured_ip inet,
  withdrawn_at timestamptz,
  constraint consent_records_notice_version_length check (char_length(btrim(notice_version)) between 1 and 50),
  constraint consent_records_withdrawn_after check (withdrawn_at is null or withdrawn_at >= captured_at)
);

create index consent_records_person_purpose_idx on app.consent_records (person_id, purpose_code);
create index consent_records_purpose_code_idx on app.consent_records (purpose_code);

call private.install_domain_table('app.consent_records');
call private.describe('app.consent_records', 'Consent given by a person to an org for one purpose (Section 14.3): the notice version shown, where and when it was captured, and its withdrawal. One row per grant; a withdrawal closes the row and a new grant opens a new row.', array[
  'person_id', 'Person who consented.',
  'purpose_code', 'Purpose consented to.',
  'notice_version', 'Version of the notice or policy shown when consent was given.',
  'source', 'Where consent was captured.',
  'captured_at', 'When consent was given. Set by the database.',
  'captured_ip', 'Client IP address at capture, as evidence. Set by the database.',
  'withdrawn_at', 'When the person withdrew consent, or null while it stands.'
]);

create unique index consent_records_one_standing on app.consent_records (org_id, person_id, purpose_code)
  where withdrawn_at is null and deleted_at is null;

create or replace function private.guard_consent_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.captured_at := now();
    new.captured_ip := private.request_ip();
    new.withdrawn_at := null;
    return new;
  end if;
  if (to_jsonb(new) - array['withdrawn_at', 'updated_at', 'updated_by']) <> (to_jsonb(old) - array['withdrawn_at', 'updated_at', 'updated_by']) then
    perform private.refuse('consent_immutable', 'A consent record is evidence; only its withdrawal is recorded.');
  end if;
  if old.withdrawn_at is not null and new.withdrawn_at is distinct from old.withdrawn_at then
    perform private.refuse('consent_already_withdrawn', 'Withdrawn consent stays withdrawn; record a new grant instead.');
  end if;
  if new.withdrawn_at is not null and old.withdrawn_at is null then
    new.withdrawn_at := now();
  end if;
  return new;
end;
$$;

comment on function private.guard_consent_record() is 'Consent records: capture time and IP come from the database; nothing changes afterwards except a one-time withdrawal stamped with the database time.';

create trigger t40_guard_consent_record before insert or update on app.consent_records
  for each row execute function private.guard_consent_record();

call private.install_policies('app.consent_records',
  $$person_id = (select private.current_person_id()) or org_id in (select private.orgs_with_capability('data.request.manage'))$$,
  $$person_id = (select private.current_person_id())$$);

create table app.cookie_consent_events (
  id uuid primary key default private.uuid_v7(),
  org_id uuid references app.organizations (id),
  person_id uuid references app.people (id),
  visitor_hash bytea not null,
  functional boolean not null,
  analytics boolean not null,
  marketing boolean not null,
  banner_version text not null,
  decided_at timestamptz not null default now(),
  constraint cookie_consent_events_visitor_hash_length check (octet_length(visitor_hash) = 32),
  constraint cookie_consent_events_banner_version_length check (char_length(btrim(banner_version)) between 1 and 50)
);

create index cookie_consent_events_person_id_idx on app.cookie_consent_events (person_id);
create index cookie_consent_events_visitor_idx on app.cookie_consent_events (visitor_hash, decided_at);

call private.install_domain_table('app.cookie_consent_events', null, null, '{}', true);
call private.describe('app.cookie_consent_events', 'Cookie banner decisions, stored server-side as the consent log (Section 14.3 ePrivacy). Strictly necessary cookies need no consent and are not recorded. Append-only; the latest decision per visitor applies.', array[
  'org_id', 'Org whose white-labeled surface showed the banner, or null on platform surfaces (sign-in, marketing site).',
  'person_id', 'Signed-in person who decided, or null for a visitor.',
  'visitor_hash', 'SHA-256 of the random visitor id the banner cookie holds; the id itself is never stored.',
  'functional', 'Functional cookies allowed.',
  'analytics', 'Analytics cookies allowed.',
  'marketing', 'Marketing cookies allowed.',
  'banner_version', 'Version of the banner and Cookie Policy shown.',
  'decided_at', 'When the decision was made. Set by the database.'
]);

call private.install_policies('app.cookie_consent_events',
  $$person_id = (select private.current_person_id()) or org_id in (select private.orgs_with_capability('data.request.manage'))$$);

create type app.privacy_signal_kind as enum ('Global Privacy Control', 'Do Not Sell or Share', 'Limit Sensitive Data Use');
comment on type app.privacy_signal_kind is 'Universal opt-out signals and requests honored under CCPA, CPRA and other US state laws (Section 14.3).';

create table app.privacy_signals (
  id uuid primary key default private.uuid_v7(),
  org_id uuid references app.organizations (id),
  person_id uuid references app.people (id),
  visitor_hash bytea,
  signal app.privacy_signal_kind not null,
  received_at timestamptz not null default now(),
  constraint privacy_signals_subject check (num_nonnulls(person_id, visitor_hash) >= 1),
  constraint privacy_signals_visitor_hash_length check (visitor_hash is null or octet_length(visitor_hash) = 32)
);

create index privacy_signals_person_id_idx on app.privacy_signals (person_id);
create index privacy_signals_visitor_idx on app.privacy_signals (visitor_hash);

call private.install_domain_table('app.privacy_signals', null, null, '{}', true);
call private.describe('app.privacy_signals', 'Opt-out signals received (Section 14.3): a Global Privacy Control header or an explicit Do Not Sell or Share request. Append-only; a signal applies from receipt and is honored as an opt-out of sale and sharing.', array[
  'org_id', 'Org whose surface received the signal, or null on platform surfaces.',
  'person_id', 'Signed-in person who sent it, when known.',
  'visitor_hash', 'SHA-256 of the visitor id, for a visitor who is not signed in.',
  'signal', 'Which signal or request.',
  'received_at', 'When it was received. Set by the database.'
]);

call private.install_policies('app.privacy_signals',
  $$person_id = (select private.current_person_id()) or org_id in (select private.orgs_with_capability('data.request.manage'))$$);

create or replace function private.stamp_received_now()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_column text := tg_argv[0];
begin
  new := jsonb_populate_record(new, jsonb_build_object(v_column, now()));
  return new;
end;
$$;

comment on function private.stamp_received_now() is 'Before insert trigger: sets the named time column to the database time, so callers cannot backdate evidence. Argument: column name.';

create trigger t40_stamp_decided_at before insert on app.cookie_consent_events
  for each row execute function private.stamp_received_now('decided_at');
create trigger t40_stamp_received_at before insert on app.privacy_signals
  for each row execute function private.stamp_received_now('received_at');

-- Public consent RPCs: the banner and the GPC header reach the database before sign-in.
create or replace function api_public.record_cookie_consent(
  p_visitor_id text,
  p_org_slug text,
  p_functional boolean,
  p_analytics boolean,
  p_marketing boolean,
  p_banner_version text,
  p_global_privacy_control boolean default false
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_client text := coalesce(host(private.request_ip()), 'unknown');
  v_hash bytea;
begin
  if p_visitor_id is null or char_length(p_visitor_id) not between 16 and 128 then
    return false;
  end if;
  if private.rate_limit_exceeded('cookie_consent', v_client, 30, interval '10 minutes') then
    return false;
  end if;
  perform private.note_rate_event('cookie_consent', v_client);
  if p_org_slug is not null then
    select o.id into v_org from app.organizations o where o.slug = p_org_slug and o.deleted_at is null;
  end if;
  v_hash := extensions.digest(p_visitor_id, 'sha256');
  insert into app.cookie_consent_events (org_id, person_id, visitor_hash, functional, analytics, marketing, banner_version)
  values (v_org, private.current_person_id(), v_hash, coalesce(p_functional, false), coalesce(p_analytics, false),
    coalesce(p_marketing, false) and not coalesce(p_global_privacy_control, false), left(coalesce(p_banner_version, 'unknown'), 50));
  if coalesce(p_global_privacy_control, false) then
    insert into app.privacy_signals (org_id, person_id, visitor_hash, signal)
    values (v_org, private.current_person_id(), v_hash, 'Global Privacy Control');
  end if;
  return true;
end;
$$;

comment on function api_public.record_cookie_consent(text, text, boolean, boolean, boolean, text, boolean) is 'Named public RPC for the cookie banner: stores the decision server-side (Section 14.3) and, when the browser sends Global Privacy Control, records the signal and refuses marketing cookies. Rate-limited per client IP. Returns false when refused.';

revoke all on function api_public.record_cookie_consent(text, text, boolean, boolean, boolean, text, boolean) from public;
grant execute on function api_public.record_cookie_consent(text, text, boolean, boolean, boolean, text, boolean) to anon, authenticated, service_role;

create type app.sms_consent_action as enum ('Opt In', 'Opt Out', 'Help');
comment on type app.sms_consent_action is 'SMS consent events under TCPA and 10DLC (Section 14.5): express opt-in, STOP opt-out, HELP request.';

create table app.sms_consent_events (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid references app.people (id),
  phone_e164 text not null,
  action app.sms_consent_action not null,
  keyword text,
  source app.consent_source not null,
  occurred_at timestamptz not null default now(),
  constraint sms_consent_events_phone_format check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  constraint sms_consent_events_keyword_length check (keyword is null or char_length(keyword) <= 20)
);

create index sms_consent_events_phone_idx on app.sms_consent_events (org_id, phone_e164, occurred_at);
create index sms_consent_events_person_id_idx on app.sms_consent_events (person_id);

call private.install_domain_table('app.sms_consent_events', null, null, '{}', true);
call private.describe('app.sms_consent_events', 'SMS consent ledger per org and phone number (Section 14.5): opt-ins with their source, STOP opt-outs and HELP requests. Append-only; the latest Opt In or Opt Out decides whether the org may text the number.', array[
  'person_id', 'Person the number belongs to, when known.',
  'phone_e164', 'Phone number in E.164 format.',
  'action', 'Opt In, Opt Out or Help.',
  'keyword', 'Keyword the person texted, for example STOP, when the event came by SMS.',
  'source', 'Where the event was captured.',
  'occurred_at', 'When it happened. Set by the database.'
]);

create trigger t40_stamp_occurred_at before insert on app.sms_consent_events
  for each row execute function private.stamp_received_now('occurred_at');

call private.install_policies('app.sms_consent_events',
  $$person_id = (select private.current_person_id()) or org_id in (select private.orgs_with_capability('data.request.manage'))$$,
  $$person_id = (select private.current_person_id()) and org_id in (select private.my_org_ids())$$);
revoke update on app.sms_consent_events from authenticated;
drop policy sms_consent_events_update on app.sms_consent_events;

create view app.sms_consent_status
with (security_invoker = true) as
select distinct on (e.org_id, e.phone_e164) e.org_id, e.phone_e164, e.person_id, (e.action = 'Opt In') as may_text, e.occurred_at as decided_at
from app.sms_consent_events e
where e.action in ('Opt In', 'Opt Out') and e.deleted_at is null
order by e.org_id, e.phone_e164, e.occurred_at desc, e.id desc;

comment on view app.sms_consent_status is 'Current SMS consent per org and phone number, derived from the latest Opt In or Opt Out.';
comment on column app.sms_consent_status.org_id is 'Org.';
comment on column app.sms_consent_status.phone_e164 is 'Phone number.';
comment on column app.sms_consent_status.person_id is 'Person on the deciding event.';
comment on column app.sms_consent_status.may_text is 'True when the latest decision is an opt-in.';
comment on column app.sms_consent_status.decided_at is 'When the deciding event happened.';
revoke all on app.sms_consent_status from public, anon;
grant select on app.sms_consent_status to authenticated, service_role;

-- Data subject requests (Section 14.3: 30-day clock) ----------------------------------------------------

create type app.dsar_request_type as enum (
  'Access', 'Rectification', 'Erasure', 'Restriction', 'Portability', 'Objection', 'Opt Out of Sale'
);
comment on type app.dsar_request_type is 'Data subject rights (GDPR, UK GDPR, CCPA and the state laws of Section 14.3).';

create type app.dsar_state as enum ('Received', 'Verifying', 'In Progress', 'Extended', 'Completed', 'Refused', 'Withdrawn');
comment on type app.dsar_state is 'Data subject request lifecycle. Extended adds 60 days to the 30-day clock and needs a reason.';

create table app.dsar_requests (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  subject_person_id uuid references app.people (id),
  subject_email text not null,
  request_type app.dsar_request_type not null,
  details text,
  received_at timestamptz not null default now(),
  dsar_state app.dsar_state not null default 'Received',
  constraint dsar_requests_email_format check (subject_email = lower(subject_email) and subject_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint dsar_requests_details_length check (details is null or char_length(details) <= 4000)
);

create index dsar_requests_subject_person_id_idx on app.dsar_requests (subject_person_id);
create index dsar_requests_open_idx on app.dsar_requests (org_id, received_at) where dsar_state not in ('Completed', 'Refused', 'Withdrawn');

call private.install_domain_table('app.dsar_requests');
call private.describe('app.dsar_requests', 'Data subject requests (Section 14.3) with the 30-day clock from receipt. The due date is derived in app.dsar_request_clock, never stored.', array[
  'subject_person_id', 'Person the request is about, when they have an account.',
  'subject_email', 'Lowercased email the requester gave, used to verify identity and to reply.',
  'request_type', 'Which right is exercised.',
  'details', 'What the requester asked for, in their words.',
  'received_at', 'When the request was received; the clock starts here. Set by the database.',
  'dsar_state', 'Lifecycle state, changed only by app.transition_dsar.'
]);

create trigger t40_stamp_received_at before insert on app.dsar_requests
  for each row execute function private.stamp_received_now('received_at');

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('dsar', 'Received', 'Verifying'),
  ('dsar', 'Received', 'In Progress'),
  ('dsar', 'Received', 'Refused'),
  ('dsar', 'Received', 'Withdrawn'),
  ('dsar', 'Verifying', 'In Progress'),
  ('dsar', 'Verifying', 'Refused'),
  ('dsar', 'Verifying', 'Withdrawn'),
  ('dsar', 'In Progress', 'Extended'),
  ('dsar', 'In Progress', 'Completed'),
  ('dsar', 'In Progress', 'Refused'),
  ('dsar', 'In Progress', 'Withdrawn'),
  ('dsar', 'Extended', 'Completed'),
  ('dsar', 'Extended', 'Refused'),
  ('dsar', 'Extended', 'Withdrawn');

call private.install_lifecycle('app.dsar_requests', 'dsar_request_id', 'dsar_state', 'dsar', 'Received',
  $$org_id in (select private.orgs_with_capability('data.request.manage'))$$);

call private.install_policies('app.dsar_requests',
  $$org_id in (select private.orgs_with_capability('data.request.manage')) or subject_person_id = (select private.current_person_id())$$,
  $$org_id in (select private.orgs_with_capability('data.request.manage'))$$);

create view app.dsar_request_clock
with (security_invoker = true) as
select r.id as dsar_request_id, r.org_id, r.dsar_state, r.received_at,
  r.received_at + interval '30 days'
    + case when exists (select 1 from app.dsar_state_transitions t where t.dsar_request_id = r.id and t.to_state = 'Extended')
           then interval '60 days' else interval '0' end as due_at,
  r.dsar_state not in ('Completed', 'Refused', 'Withdrawn')
    and now() > r.received_at + interval '30 days'
      + case when exists (select 1 from app.dsar_state_transitions t where t.dsar_request_id = r.id and t.to_state = 'Extended')
             then interval '60 days' else interval '0' end as is_overdue
from app.dsar_requests r
where r.deleted_at is null;

comment on view app.dsar_request_clock is 'The 30-day clock of every data subject request (Section 14.3): due 30 days after receipt, or 90 when extended, and whether an open request is overdue.';
comment on column app.dsar_request_clock.dsar_request_id is 'Request.';
comment on column app.dsar_request_clock.org_id is 'Org.';
comment on column app.dsar_request_clock.dsar_state is 'Current state.';
comment on column app.dsar_request_clock.received_at is 'When the clock started.';
comment on column app.dsar_request_clock.due_at is 'When the response is due.';
comment on column app.dsar_request_clock.is_overdue is 'True for an open request past its due time.';
revoke all on app.dsar_request_clock from public, anon;
grant select on app.dsar_request_clock to authenticated, service_role;

create or replace function app.transition_dsar(p_dsar_request_id uuid, p_expected app.dsar_state, p_next app.dsar_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select r.org_id from app.dsar_requests r where r.id = p_dsar_request_id and r.deleted_at is null);
begin
  if v_org is null or not private.has_capability(v_org, 'data.request.manage') then
    raise exception using errcode = '42501', message = 'data subject request not found';
  end if;
  return private.transition_lifecycle('dsar', 'app.dsar_requests', 'dsar_state', 'app.dsar_state_transitions',
    'dsar_request_id', p_dsar_request_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_dsar(uuid, app.dsar_state, app.dsar_state, text) is 'Moves a data subject request to another state with compare-and-set on the expected state; needs data.request.manage. Extending needs a reason like every move. Returns the ledger entry id.';

revoke all on function app.transition_dsar(uuid, app.dsar_state, app.dsar_state, text) from public, anon;
grant execute on function app.transition_dsar(uuid, app.dsar_state, app.dsar_state, text) to authenticated, service_role;

create or replace function app.submit_dsar(p_org_id uuid, p_request_type app.dsar_request_type, p_details text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_email text := (select lower(u.email) from auth.users u where u.id = (select auth.uid()));
  v_id uuid;
begin
  if not exists (select 1 from app.organizations o where o.id = p_org_id and o.deleted_at is null) then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if private.rate_limit_exceeded('dsar.submit', v_person::text, 5, interval '1 day') then
    perform private.refuse('dsar_rate_limited', 'Five requests a day is the limit; the org already has your earlier requests.');
  end if;
  perform private.note_rate_event('dsar.submit', v_person::text);
  insert into app.dsar_requests (org_id, subject_person_id, subject_email, request_type, details)
  values (p_org_id, v_person, v_email, p_request_type, nullif(btrim(p_details), ''))
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.submit_dsar(uuid, app.dsar_request_type, text) is 'Lets a signed-in person exercise a data subject right against an org, whether or not they are a member. The subject is the caller, verified by sign-in. Limited to five a day per person. Returns the request id.';

revoke all on function app.submit_dsar(uuid, app.dsar_request_type, text) from public, anon;
grant execute on function app.submit_dsar(uuid, app.dsar_request_type, text) to authenticated, service_role;

call private.install_audit_trail('app.dsar_requests');

-- File access log (Section 8.4, Section 8.6) -----------------------------------------------------------

create type app.file_access_action as enum ('View', 'Download', 'Export', 'Share Link Created', 'Share Link Opened');
comment on type app.file_access_action is 'What happened to a file.';

create table app.file_access_log (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid references app.people (id),
  bucket_id text not null,
  object_path text not null,
  action app.file_access_action not null,
  classification app.data_classification not null,
  watermarked boolean not null default false,
  accessed_ip inet,
  accessed_at timestamptz not null default now(),
  constraint file_access_log_bucket_length check (char_length(bucket_id) between 1 and 100),
  constraint file_access_log_path_length check (char_length(object_path) between 1 and 1024)
);

create index file_access_log_person_id_idx on app.file_access_log (person_id);
create index file_access_log_object_idx on app.file_access_log (org_id, bucket_id, object_path);

call private.install_domain_table('app.file_access_log', null, null, '{}', true);
call private.describe('app.file_access_log', 'Every view, download, export and share of a stored file (Section 8.4 access transparency, Section 8.6 data loss prevention). Append-only, written by the storage service.', array[
  'person_id', 'Person who accessed the file, or null for a share link opened without an account.',
  'bucket_id', 'Storage bucket.',
  'object_path', 'Object path inside the bucket.',
  'action', 'What happened.',
  'classification', 'Classification of the file at the time of access.',
  'watermarked', 'True when the delivered copy carried the viewer email and timestamp watermark.',
  'accessed_ip', 'Client IP address. Set by the database.',
  'accessed_at', 'When it happened. Set by the database.'
]);

create or replace function private.stamp_file_access()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.accessed_at := now();
  new.accessed_ip := coalesce(private.request_ip(), new.accessed_ip);
  return new;
end;
$$;

comment on function private.stamp_file_access() is 'Before insert trigger: stamps the database time and, inside an API request, the client IP.';

create trigger t40_stamp_file_access before insert on app.file_access_log
  for each row execute function private.stamp_file_access();

call private.install_policies('app.file_access_log',
  $$person_id = (select private.current_person_id()) or org_id in (select private.orgs_with_capability('audit.log.read'))$$);

-- Audit redaction (invariant 23) ----------------------------------------------------------------------

create or replace function private.redact_audit_events()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_after interval := (select r.redact_personal_data_after from private.retention_policies r where r.table_name = 'app.audit_events');
  v_count bigint := 0;
begin
  if v_after is null then
    return 0;
  end if;
  perform private.begin_trusted_operation('audit_redaction');
  begin
    update app.audit_events
    set diff = private.redact_personal_data(diff), actor_ip = null, user_agent = null, redacted_at = now()
    where redacted_at is null and created_at < now() - v_after;
    get diagnostics v_count = row_count;
    insert into private.retention_runs (table_name, action, rows_affected) values ('app.audit_events', 'redact', v_count);
  exception when others then
    insert into private.retention_runs (table_name, action, error_message) values ('app.audit_events', 'redact', sqlerrm);
    v_count := 0;
  end;
  perform private.end_trusted_operation('audit_redaction');
  return v_count;
end;
$$;

comment on function private.redact_audit_events() is 'Invariant 23: redacts personal data at every JSON depth in audit diffs older than the policy''s redaction age (90 days), and removes IP and user agent. The ledger keeps every event for 7 years.';

create or replace function private.run_nightly_retention()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.run_partition_maintenance();
  perform private.redact_audit_events();
  perform private.purge_expired_rows();
  perform private.prune_rate_limits();
end;
$$;

comment on function private.run_nightly_retention() is 'The nightly retention job: partition maintenance, audit redaction, row purge and rate limit pruning.';

select cron.schedule('xos_nightly_retention', '17 3 * * *', 'select private.run_nightly_retention()');

-- Retention policies for this range and every table before it -------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, redact_personal_data_after, rationale) values
  ('app.audit_events', 'Age', 'created_at', interval '7 years', 'Drop Partition', interval '90 days',
    'Compliance ledger kept 7 years; personal data redacted at 90 days (invariant 23).'),
  ('app.activity_events', 'Age', 'created_at', interval '18 months', 'Drop Partition', null,
    'User-facing feed kept 18 months (Section 7.3).'),
  ('app.legal_holds', 'Soft Deleted', 'deleted_at', interval '7 years', 'Delete', null,
    'Holds are released, never deleted; a soft-deleted hold is kept 7 years as evidence.'),
  ('app.consent_records', 'Soft Deleted', 'deleted_at', interval '7 years', 'Delete', null,
    'Consent evidence is kept while relied on and 7 years after.'),
  ('app.cookie_consent_events', 'Age', 'decided_at', interval '25 months', 'Delete', null,
    'Consent log kept for the 13-month banner life plus a year of evidence.'),
  ('app.privacy_signals', 'Age', 'received_at', interval '25 months', 'Delete', null,
    'Opt-out evidence kept two years beyond a year of honoring.'),
  ('app.sms_consent_events', 'Age', 'occurred_at', interval '5 years', 'Delete', null,
    'TCPA claims run 4 years; consent evidence is kept 5.'),
  ('app.dsar_requests', 'Age', 'received_at', interval '3 years', 'Delete', null,
    'Request records kept 3 years to evidence responses.'),
  ('app.dsar_state_transitions', 'Age', 'created_at', interval '3 years', 'Delete', null,
    'Kept as long as the request it records.'),
  ('app.file_access_log', 'Age', 'accessed_at', interval '2 years', 'Delete', null,
    'Access transparency log kept 2 years.'),
  ('app.organizations', 'Soft Deleted', 'deleted_at', interval '90 days', 'Account Lifecycle', null,
    'Org deletion follows Section 14.7: deleted at day 90 with a deletion certificate.'),
  ('app.people', 'Soft Deleted', 'deleted_at', interval '90 days', 'Account Lifecycle', null,
    'Account deletion follows Section 14.7 through the account lifecycle.'),
  ('app.invites', 'Age', 'expires_at', interval '90 days', 'Delete', null,
    'Invites are useless after expiry; kept 90 days for support.'),
  ('app.domain_events', 'Age', 'occurred_at', interval '25 months', 'Delete', null,
    'Event history outlives the 18-month activity feed that reads it.');

-- Every other table that exists: ledgers by age, other tables by soft delete, 7 years (US records default,
-- payroll per Section 14.3). Later migrations in this range add their own rows.
insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale)
select format('app.%s', c.relname),
  case when ledger then 'Age' else 'Soft Deleted' end::app.retention_basis,
  case when ledger then 'created_at' else 'deleted_at' end,
  interval '7 years', 'Delete',
  case when ledger then 'Append-only ledger kept 7 years as audit evidence.'
       else 'Soft-deleted business records kept 7 years (US records default; payroll per Section 14.3).' end
from (
  select c.relname, exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = c.oid and t.tgname in ('t95_append_only')) as ledger
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
    and exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'deleted_at' and not a.attisdropped)
) c
where format('app.%s', c.relname) not in (select r.table_name from private.retention_policies r);

-- Privileges -------------------------------------------------------------------------------------------

revoke all on function private.request_header(text) from public, anon, authenticated;
revoke all on function private.request_ip() from public, anon, authenticated;
revoke all on function private.rate_limit_exceeded(text, text, integer, interval) from public, anon, authenticated;
revoke all on function private.note_rate_event(text, text) from public, anon, authenticated;
revoke all on function private.prune_rate_limits() from public, anon, authenticated;
revoke all on function private.guard_audit_event() from public, anon, authenticated;
revoke all on function private.write_audit_event(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.audit_excluded_columns(regclass) from public, anon, authenticated;
revoke all on function private.audit_row_change() from public, anon, authenticated;
revoke all on procedure private.install_audit_trail(regclass) from public, anon, authenticated;
revoke all on function private.can_read_domain_event(uuid) from public, anon;
grant execute on function private.can_read_domain_event(uuid) to authenticated;
revoke all on function private.record_activity() from public, anon, authenticated;
revoke all on function private.guard_consent_record() from public, anon, authenticated;
revoke all on function private.stamp_received_now() from public, anon, authenticated;
revoke all on function private.stamp_file_access() from public, anon, authenticated;
revoke all on function private.redact_audit_events() from public, anon, authenticated;
revoke all on function private.run_nightly_retention() from public, anon, authenticated;
