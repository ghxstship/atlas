-- 0600_integration_framework.sql
-- A19 Integrations (ADR 0004 range 0600 to 0649). The one integration framework of Section 17:
--   * private.integration_providers, the closed provider catalog with its category and plan gate
--   * app.integration_connections, one org's connection to one provider account, with a lifecycle
--     (Pending, Connected, Error, Paused, Disconnected) driven by the shared transition engine
--   * credentials in Supabase Vault (Section 9): the secret lives in vault.secrets, the connection keeps
--     only non-secret metadata, and only the service role reads the decrypted secret
--   * app.integration_external_ids, the map between local rows and provider identifiers
--   * app.integration_sync_runs, sync runs with attempts, exponential backoff, retry and error states,
--     plus the append-only item error ledger app.integration_sync_errors
-- Every table is tenant data under row level security; only holders of org.integrations.manage read or
-- change it. The connector runner acts with the service role through the runner RPCs below.

-- Enums ---------------------------------------------------------------------------------------------------------

create type app.integration_category as enum (
  'Accounting', 'Calendar', 'Storage', 'Communication', 'Payroll', 'Shipping', 'Ticketing'
);
comment on type app.integration_category is 'Integration categories of Section 17, in catalog order.';

create type app.integration_connection_state as enum ('Pending', 'Connected', 'Error', 'Paused', 'Disconnected');
comment on type app.integration_connection_state is 'Connection lifecycle: created (Pending), Connected once a credential is stored, Error when the provider refuses the credential, Paused by an admin, Disconnected for good (the Vault secret is destroyed).';

create type app.integration_entity as enum (
  'Record', 'Shift', 'Payment', 'Invoice', 'Journal Entry', 'Journal Line', 'Document', 'Shipment',
  'Payroll Run', 'Counterparty', 'Membership', 'Earning Code'
);
comment on type app.integration_entity is 'Kinds of local rows an external identifier can map to. Each kind names one app table (private.integration_entity_table).';

create type app.integration_sync_scope as enum (
  'Ledger Export', 'Payment Sync', 'Calendar Sync', 'File Import', 'Notification Delivery', 'Payroll Export',
  'Tracking Refresh', 'Attendance Import'
);
comment on type app.integration_sync_scope is 'What a sync run moves. Each scope belongs to one provider category (private.integration_scope_category).';

create type app.integration_sync_direction as enum ('Inbound', 'Outbound', 'Two Way');
comment on type app.integration_sync_direction is 'Direction of a sync run: from the provider into XOS, from XOS to the provider, or both.';

create type app.integration_sync_run_state as enum ('Queued', 'Running', 'Succeeded', 'Retrying', 'Failed', 'Canceled');
comment on type app.integration_sync_run_state is 'Sync run lifecycle: Queued, Running, then Succeeded, Retrying (a retryable failure with attempts left, due again at next_attempt_at) or Failed (attempts exhausted or a permanent error). A Failed run can be queued again by an admin; Queued and Retrying runs can be canceled.';

create type app.integration_credential_kind as enum ('OAuth Token', 'API Key', 'Service Account');
comment on type app.integration_credential_kind is 'Kind of secret stored in Vault for a connection.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('integration_connection', 'Pending', 'Connected'),
  ('integration_connection', 'Pending', 'Disconnected'),
  ('integration_connection', 'Connected', 'Error'),
  ('integration_connection', 'Connected', 'Paused'),
  ('integration_connection', 'Connected', 'Disconnected'),
  ('integration_connection', 'Error', 'Connected'),
  ('integration_connection', 'Error', 'Disconnected'),
  ('integration_connection', 'Paused', 'Connected'),
  ('integration_connection', 'Paused', 'Disconnected'),
  ('integration_sync_run', 'Queued', 'Running'),
  ('integration_sync_run', 'Queued', 'Canceled'),
  ('integration_sync_run', 'Running', 'Succeeded'),
  ('integration_sync_run', 'Running', 'Retrying'),
  ('integration_sync_run', 'Running', 'Failed'),
  ('integration_sync_run', 'Retrying', 'Running'),
  ('integration_sync_run', 'Retrying', 'Canceled'),
  ('integration_sync_run', 'Failed', 'Queued');

insert into private.domain_event_types (code, subject, description) values
  ('integration.state_changed', 'integration_connections', 'An integration connection moved to another connection state.'),
  ('integration_sync.finished', 'integration_sync_runs', 'An integration sync run succeeded or failed for good.');

-- Provider catalog ------------------------------------------------------------------------------------------------

create table private.integration_providers (
  provider_code text primary key,
  category app.integration_category not null,
  sort_order smallint not null unique,
  required_feature app.plan_feature_code,
  needs_credential boolean not null default true,
  constraint integration_providers_code_format check (provider_code ~ '^[a-z][a-z0-9_]*$')
);

comment on table private.integration_providers is 'The closed catalog of Section 17 connectors. Display names come from the integrations i18n namespace keyed by provider_code.';
comment on column private.integration_providers.provider_code is 'Stable provider code, for example xero or google_calendar.';
comment on column private.integration_providers.category is 'Section 17 category.';
comment on column private.integration_providers.sort_order is 'Numeric catalog order.';
comment on column private.integration_providers.required_feature is 'Plan feature the org needs before connecting, or NULL when every plan may connect.';
comment on column private.integration_providers.needs_credential is 'False for connectors that run without a provider secret (CSV import).';

insert into private.integration_providers (provider_code, category, sort_order, required_feature, needs_credential) values
  ('xero', 'Accounting', 10, 'upl_export', true),
  ('quickbooks_online', 'Accounting', 11, 'upl_export', true),
  ('netsuite', 'Accounting', 12, 'upl_export', true),
  ('ramp', 'Accounting', 13, 'upl_export', true),
  ('google_calendar', 'Calendar', 20, null, true),
  ('microsoft_365', 'Calendar', 21, null, true),
  ('google_drive', 'Storage', 30, null, true),
  ('onedrive_sharepoint', 'Storage', 31, null, true),
  ('dropbox', 'Storage', 32, null, true),
  ('slack', 'Communication', 40, null, true),
  ('microsoft_teams', 'Communication', 41, null, true),
  ('gusto', 'Payroll', 50, 'payroll_export', true),
  ('adp', 'Payroll', 51, 'payroll_export', true),
  ('rippling', 'Payroll', 52, 'payroll_export', true),
  ('ups', 'Shipping', 60, null, true),
  ('fedex', 'Shipping', 61, null, true),
  ('dhl', 'Shipping', 62, null, true),
  ('ticketing_csv', 'Ticketing', 70, null, false),
  ('ticketing_api', 'Ticketing', 71, null, true);

alter table private.integration_providers enable row level security;
revoke all on private.integration_providers from public, anon, authenticated;
grant select on private.integration_providers to service_role;

create view app.integration_providers as
select p.provider_code, p.category, p.sort_order, p.required_feature, p.needs_credential
from private.integration_providers p;

call private.describe('app.integration_providers', 'The Section 17 connector catalog in numeric order, so the settings page lists only connectors the database accepts.', array[
  'provider_code', 'Stable provider code.',
  'category', 'Section 17 category.',
  'sort_order', 'Numeric catalog order.',
  'required_feature', 'Plan feature needed to connect, or NULL.',
  'needs_credential', 'Whether connecting needs a Vault credential.'
]);

revoke all on app.integration_providers from public, anon;
grant select on app.integration_providers to authenticated, service_role;

create or replace function private.integration_scope_category(p_scope app.integration_sync_scope)
returns app.integration_category
language sql
immutable
set search_path = ''
as $$
  select case p_scope
    when 'Ledger Export' then 'Accounting'
    when 'Payment Sync' then 'Accounting'
    when 'Calendar Sync' then 'Calendar'
    when 'File Import' then 'Storage'
    when 'Notification Delivery' then 'Communication'
    when 'Payroll Export' then 'Payroll'
    when 'Tracking Refresh' then 'Shipping'
    when 'Attendance Import' then 'Ticketing'
  end::app.integration_category;
$$;

comment on function private.integration_scope_category(app.integration_sync_scope) is 'Provider category a sync scope belongs to; a run refuses a scope outside its connection''s category.';

create or replace function private.integration_entity_table(p_entity app.integration_entity)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_entity
    when 'Record' then 'app.records'
    when 'Shift' then 'app.shifts'
    when 'Payment' then 'app.payments'
    when 'Invoice' then 'app.invoices'
    when 'Journal Entry' then 'app.journal_entries'
    when 'Journal Line' then 'app.journal_lines'
    when 'Document' then 'app.documents'
    when 'Shipment' then 'app.shipments'
    when 'Payroll Run' then 'app.payroll_runs'
    when 'Counterparty' then 'app.counterparties'
    when 'Membership' then 'app.memberships'
    when 'Earning Code' then 'app.earning_codes'
  end;
$$;

comment on function private.integration_entity_table(app.integration_entity) is 'App table holding the local rows of an external identifier entity kind.';

create or replace function private.integration_backoff(p_attempt integer)
returns interval
language sql
immutable
set search_path = ''
as $$
  select least(interval '1 hour', interval '30 seconds' * power(2, greatest(p_attempt, 1) - 1));
$$;

comment on function private.integration_backoff(integer) is 'Delay before retrying a failed sync attempt: 30 seconds doubled per attempt, capped at one hour. @xos/integrations mirrors this formula.';

-- Connections -------------------------------------------------------------------------------------------------------

create table app.integration_connections (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  provider_code text not null references private.integration_providers (provider_code),
  display_name text not null,
  external_account_id text,
  external_account_name text,
  provider_settings jsonb not null default '{}'::jsonb,
  connection_state app.integration_connection_state not null default 'Pending',
  credential_kind app.integration_credential_kind,
  credential_stored_at timestamptz,
  credential_expires_at timestamptz,
  last_synced_at timestamptz,
  last_error_code text,
  last_error_message text,
  deleted_at timestamptz,
  constraint integration_connections_display_name_length check (char_length(btrim(display_name)) between 1 and 120),
  constraint integration_connections_settings_object check (jsonb_typeof(provider_settings) = 'object'),
  constraint integration_connections_account_length check (external_account_id is null or char_length(external_account_id) between 1 and 255),
  constraint integration_connections_error_code_format check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]*$'),
  constraint integration_connections_error_message_length check (last_error_message is null or char_length(last_error_message) <= 1000),
  constraint integration_connections_credential_pair check ((credential_kind is null) = (credential_stored_at is null))
);

create index integration_connections_provider_code_idx on app.integration_connections (provider_code);
create unique index integration_connections_account_key on app.integration_connections (org_id, provider_code, coalesce(external_account_id, ''))
  where deleted_at is null and connection_state <> 'Disconnected';

call private.install_domain_table('app.integration_connections');
call private.describe('app.integration_connections', 'An org''s connection to one provider account (Section 17). Holds non-secret metadata only: the credential itself lives in Supabase Vault (Section 9) and is read only by the service role. One live connection per org, provider and provider account.', array[
  'org_id', 'Org that owns the connection.',
  'provider_code', 'Connector from the provider catalog. Fixed after insert.',
  'display_name', 'Name the org gives the connection.',
  'external_account_id', 'Provider tenant, company, workspace or account identifier.',
  'external_account_name', 'Provider account name, as the provider reports it.',
  'provider_settings', 'Provider configuration payload (calendar ids, default accounts, channel routing defaults), validated by the connector. Never holds secrets.',
  'connection_state', 'Connection state. Changes only through app.transition_integration_connection and the runner RPCs.',
  'credential_kind', 'Kind of the stored Vault credential, or NULL when none is stored. Set only by app.store_integration_credential.',
  'credential_stored_at', 'When the current credential was stored. Set only by app.store_integration_credential.',
  'credential_expires_at', 'When the stored credential expires, when the provider says.',
  'last_synced_at', 'When a sync run last succeeded.',
  'last_error_code', 'Rule code of the last connection error, cleared on success.',
  'last_error_message', 'Provider message of the last connection error, cleared on success.'
]);

call private.install_policies('app.integration_connections',
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$,
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$);

call private.install_lifecycle('app.integration_connections', 'integration_connection_id', 'connection_state', 'integration_connection', 'Pending',
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$);

create trigger t90_emit_integration_state after insert on app.integration_connection_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('integration.state_changed', 'integration_connections', 'integration_connection_id', 'from_state', 'to_state', 'reason');

create or replace function private.guard_integration_connection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_feature app.plan_feature_code;
begin
  if tg_op = 'INSERT' then
    select p.required_feature into v_feature from private.integration_providers p where p.provider_code = new.provider_code;
    if v_feature is not null and not private.org_has_feature(new.org_id, v_feature) then
      perform private.refuse('integration_plan_feature',
        format('Connecting %s needs a plan with the %s feature.', new.provider_code, v_feature));
    end if;
    if not private.in_trusted_operation('integration_credential') then
      new.credential_kind := null;
      new.credential_stored_at := null;
      new.credential_expires_at := null;
    end if;
    new.last_synced_at := null;
    new.last_error_code := null;
    new.last_error_message := null;
    return new;
  end if;
  if new.provider_code <> old.provider_code then
    perform private.refuse('integration_provider_fixed', 'A connection keeps its provider; connect the other provider separately.');
  end if;
  if old.connection_state = 'Disconnected' and not private.in_trusted_operation('integration_connection_transition') then
    perform private.refuse('integration_disconnected', 'A disconnected connection is kept for its history and cannot change.');
  end if;
  if not private.in_trusted_operation('integration_credential')
     and (new.credential_kind is distinct from old.credential_kind
       or new.credential_stored_at is distinct from old.credential_stored_at
       or new.credential_expires_at is distinct from old.credential_expires_at) then
    perform private.refuse('integration_credential_rpc_only', 'Credential details change only through app.store_integration_credential.');
  end if;
  if not private.in_trusted_operation('integration_sync_runner')
     and (new.last_synced_at is distinct from old.last_synced_at
       or new.last_error_code is distinct from old.last_error_code
       or new.last_error_message is distinct from old.last_error_message) then
    perform private.refuse('integration_sync_fields_runner_only', 'Sync results are written only by the integration runner.');
  end if;
  return new;
end;
$$;

comment on function private.guard_integration_connection() is 'Connections: the provider''s plan feature is required on insert; the provider is fixed; a Disconnected connection is frozen; credential metadata changes only through app.store_integration_credential and sync results only through the runner RPCs.';

create trigger t40_guard_integration_connection before insert or update on app.integration_connections
  for each row execute function private.guard_integration_connection();

-- Credentials in Vault -------------------------------------------------------------------------------------------------

create table private.integration_credentials (
  integration_connection_id uuid primary key references app.integration_connections (id),
  vault_secret_id uuid not null
);

comment on table private.integration_credentials is 'Pointer from a connection to its secret in vault.secrets. The secret is never copied out of Vault except by the service role through app.read_integration_credential.';
comment on column private.integration_credentials.integration_connection_id is 'Connection the secret belongs to.';
comment on column private.integration_credentials.vault_secret_id is 'Id of the vault.secrets row holding the encrypted secret.';

alter table private.integration_credentials enable row level security;
revoke all on private.integration_credentials from public, anon, authenticated;

create or replace function private.authorize_integration_manage(p_org_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- anon never reaches here (execute is revoked); a signed-in person needs the capability, and the
  -- service role (no person) acts for the platform.
  if private.current_person_id() is not null and (p_org_id is null or not private.has_capability(p_org_id, 'org.integrations.manage')) then
    raise exception using errcode = '42501', message = 'org.integrations.manage is required';
  end if;
  if p_org_id is null then
    raise exception using errcode = '42501', message = 'the connection does not exist';
  end if;
end;
$$;

comment on function private.authorize_integration_manage(uuid) is 'Raises 42501 unless the signed-in person holds org.integrations.manage in the org; the service role passes.';

create or replace function app.store_integration_credential(
  p_connection_id uuid,
  p_secret text,
  p_kind app.integration_credential_kind,
  p_expires_at timestamptz default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection app.integration_connections;
  v_secret_id uuid;
begin
  select * into v_connection from app.integration_connections c where c.id = p_connection_id and c.deleted_at is null for update;
  perform private.authorize_integration_manage(v_connection.org_id);
  if v_connection.connection_state = 'Disconnected' then
    perform private.refuse('integration_disconnected', 'A disconnected connection is kept for its history and cannot change.');
  end if;
  if p_secret is null or char_length(p_secret) = 0 then
    perform private.refuse('integration_credential_empty', 'A credential needs a secret value.');
  end if;
  if char_length(p_secret) > 16384 then
    perform private.refuse('integration_credential_too_large', 'A credential is at most 16 KB.');
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    perform private.refuse('integration_credential_expired', 'The credential has already expired.');
  end if;

  select c.vault_secret_id into v_secret_id from private.integration_credentials c where c.integration_connection_id = p_connection_id;
  if v_secret_id is null then
    v_secret_id := vault.create_secret(p_secret, 'xos_integration_' || p_connection_id::text,
      format('Credential of integration connection %s (%s).', p_connection_id, v_connection.provider_code));
    insert into private.integration_credentials (integration_connection_id, vault_secret_id) values (p_connection_id, v_secret_id);
  else
    perform vault.update_secret(v_secret_id, p_secret);
  end if;

  perform private.begin_trusted_operation('integration_credential');
  update app.integration_connections
  set credential_kind = p_kind, credential_stored_at = now(), credential_expires_at = p_expires_at
  where id = p_connection_id;
  perform private.end_trusted_operation('integration_credential');
end;
$$;

comment on function app.store_integration_credential(uuid, text, app.integration_credential_kind, timestamptz) is 'Stores or rotates a connection''s secret in Supabase Vault (Section 9) and records its kind and expiry on the connection. Needs org.integrations.manage; the secret is never returned to signed-in callers.';

create or replace function app.read_integration_credential(p_connection_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state app.integration_connection_state;
  v_secret text;
begin
  select c.connection_state into v_state from app.integration_connections c where c.id = p_connection_id and c.deleted_at is null;
  if v_state is null then
    raise exception using errcode = '42501', message = 'the connection does not exist';
  end if;
  if v_state in ('Paused', 'Disconnected') then
    perform private.refuse('integration_not_active', 'A paused or disconnected connection does not hand out its credential.');
  end if;
  select s.decrypted_secret into v_secret
  from private.integration_credentials c
  join vault.decrypted_secrets s on s.id = c.vault_secret_id
  where c.integration_connection_id = p_connection_id;
  if v_secret is null then
    perform private.refuse('integration_credential_required', 'The connection has no stored credential.');
  end if;
  return v_secret;
end;
$$;

comment on function app.read_integration_credential(uuid) is 'Decrypts a connection''s Vault secret for the connector runner. Executable only by the service role.';

create or replace function private.destroy_integration_credential(p_connection_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  delete from private.integration_credentials c where c.integration_connection_id = p_connection_id
  returning c.vault_secret_id into v_secret_id;
  if v_secret_id is not null then
    delete from vault.secrets s where s.id = v_secret_id;
  end if;
  perform private.begin_trusted_operation('integration_credential');
  update app.integration_connections
  set credential_kind = null, credential_stored_at = null, credential_expires_at = null
  where id = p_connection_id;
  perform private.end_trusted_operation('integration_credential');
end;
$$;

comment on function private.destroy_integration_credential(uuid) is 'Destroys a connection''s Vault secret when it is disconnected, so no credential outlives the connection.';

-- Connection transitions --------------------------------------------------------------------------------------------------

create or replace function app.transition_integration_connection(
  p_connection_id uuid,
  p_expected app.integration_connection_state,
  p_next app.integration_connection_state,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection app.integration_connections;
  v_needs_credential boolean;
  v_ledger uuid;
  v_run record;
begin
  select * into v_connection from app.integration_connections c where c.id = p_connection_id and c.deleted_at is null for update;
  perform private.authorize_integration_manage(v_connection.org_id);
  if v_connection.connection_state = 'Disconnected' then
    perform private.refuse('integration_disconnected', 'A disconnected connection is kept for its history and cannot change.');
  end if;
  if p_next = 'Error' then
    perform private.refuse('integration_error_runner_only', 'Only the integration runner marks a connection as failing.');
  end if;
  if p_next = 'Connected' then
    select p.needs_credential into v_needs_credential from private.integration_providers p where p.provider_code = v_connection.provider_code;
    if v_needs_credential and not exists (select 1 from private.integration_credentials c where c.integration_connection_id = p_connection_id) then
      perform private.refuse('integration_credential_required', 'Store the provider credential before connecting.');
    end if;
    if v_connection.credential_expires_at is not null and v_connection.credential_expires_at <= now() then
      perform private.refuse('integration_credential_expired', 'The stored credential has expired; reauthorize the connection.');
    end if;
  end if;
  if p_next = 'Disconnected' then
    perform private.destroy_integration_credential(p_connection_id);
    for v_run in
      select r.id, r.sync_run_state::text from app.integration_sync_runs r
      where r.integration_connection_id = p_connection_id and r.sync_run_state in ('Queued', 'Retrying') and r.deleted_at is null
    loop
      perform private.transition_sync_run(v_run.id, v_run.sync_run_state, 'Canceled', 'The connection was disconnected.');
      update app.integration_sync_runs set finished_at = now(), next_attempt_at = null where id = v_run.id;
    end loop;
  end if;
  v_ledger := private.transition_lifecycle('integration_connection', 'app.integration_connections', 'connection_state',
    'app.integration_connection_state_transitions', 'integration_connection_id', p_connection_id, p_expected::text, p_next::text, p_reason);
  return v_ledger;
end;
$$;

-- Comment added after app.integration_sync_runs exists (the body above refers to it).

-- External identifier map ------------------------------------------------------------------------------------------------

create table app.integration_external_ids (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  integration_connection_id uuid not null references app.integration_connections (id),
  entity app.integration_entity not null,
  local_id uuid not null,
  external_id text not null,
  external_version text,
  content_hash text,
  last_synced_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint integration_external_ids_external_length check (char_length(external_id) between 1 and 255),
  constraint integration_external_ids_version_length check (external_version is null or char_length(external_version) <= 255),
  constraint integration_external_ids_hash_format check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$')
);

create index integration_external_ids_connection_idx on app.integration_external_ids (integration_connection_id);
create unique index integration_external_ids_local_key on app.integration_external_ids (integration_connection_id, entity, local_id)
  where deleted_at is null;
create unique index integration_external_ids_external_key on app.integration_external_ids (integration_connection_id, entity, external_id)
  where deleted_at is null;
create index integration_external_ids_local_idx on app.integration_external_ids (entity, local_id);

call private.install_domain_table('app.integration_external_ids', 'app.integration_connections', 'integration_connection_id');
call private.describe('app.integration_external_ids', 'The external identifier map (Section 17): one row links a local row to its identifier in one connection. A local row maps to at most one external identifier per connection and entity kind, and the reverse, so syncs are idempotent and two-way changes find their partner.', array[
  'integration_connection_id', 'Connection the identifier belongs to.',
  'entity', 'Kind of the local row.',
  'local_id', 'Id of the local row in the entity''s table, checked to exist in the same org.',
  'external_id', 'Provider identifier.',
  'external_version', 'Provider version, ETag or change key last seen, for conflict detection.',
  'content_hash', 'SHA-256 of the normalized payload last synced, lowercase hex, to skip unchanged rows.',
  'last_synced_at', 'When the pair last synced.'
]);

call private.install_policies('app.integration_external_ids',
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$,
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$);

create or replace function private.guard_integration_external_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local_org uuid;
  v_found boolean := false;
begin
  if tg_op = 'UPDATE' and (new.entity <> old.entity or new.local_id <> old.local_id) then
    perform private.refuse('integration_external_id_rekey', 'An identifier pair keeps its local row; map the other row separately.');
  end if;
  execute format('select org_id, true from %s where id = $1', private.integration_entity_table(new.entity))
    into v_local_org, v_found using new.local_id;
  if v_found is not true then
    raise exception using errcode = '23503', message = format('integration_external_ids.local_id references a missing %s row', new.entity);
  end if;
  if v_local_org is distinct from new.org_id then
    perform private.refuse('cross_org_reference', 'integration_external_ids.local_id points to a row of another org.');
  end if;
  return new;
end;
$$;

comment on function private.guard_integration_external_id() is 'External identifiers: the local row must exist in the entity''s table and in the connection''s org, and a pair never moves to another local row.';

create trigger t40_guard_integration_external_id before insert or update on app.integration_external_ids
  for each row execute function private.guard_integration_external_id();

-- Sync runs ---------------------------------------------------------------------------------------------------------------

create table app.integration_sync_runs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  integration_connection_id uuid not null references app.integration_connections (id),
  project_id uuid references app.projects (id),
  sync_scope app.integration_sync_scope not null,
  direction app.integration_sync_direction not null,
  sync_run_state app.integration_sync_run_state not null default 'Queued',
  idempotency_key text not null,
  subject_entity app.integration_entity,
  subject_id uuid,
  source_uri text,
  attempt smallint not null default 0,
  max_attempts smallint not null default 5,
  next_attempt_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  cursor_before text,
  cursor_after text,
  items_read integer not null default 0,
  items_written integer not null default 0,
  items_skipped integer not null default 0,
  items_failed integer not null default 0,
  error_code text,
  error_message text,
  job_id uuid,
  deleted_at timestamptz,
  constraint integration_sync_runs_key_length check (char_length(idempotency_key) between 1 and 200),
  constraint integration_sync_runs_subject_pair check ((subject_entity is null) = (subject_id is null)),
  constraint integration_sync_runs_source_length check (source_uri is null or char_length(source_uri) between 1 and 1000),
  constraint integration_sync_runs_attempt_range check (attempt between 0 and max_attempts),
  constraint integration_sync_runs_max_attempts_range check (max_attempts between 1 and 10),
  constraint integration_sync_runs_counts_nonnegative check (items_read >= 0 and items_written >= 0 and items_skipped >= 0 and items_failed >= 0),
  constraint integration_sync_runs_error_code_format check (error_code is null or error_code ~ '^[a-z][a-z0-9_]*$'),
  constraint integration_sync_runs_error_message_length check (error_message is null or char_length(error_message) <= 1000),
  constraint integration_sync_runs_cursor_length check (char_length(coalesce(cursor_before, '')) <= 2000 and char_length(coalesce(cursor_after, '')) <= 2000),
  constraint integration_sync_runs_window check (finished_at is null or started_at is null or finished_at >= started_at)
);

create index integration_sync_runs_project_id_idx on app.integration_sync_runs (project_id);
create unique index integration_sync_runs_idempotency_key on app.integration_sync_runs (integration_connection_id, idempotency_key);
create unique index integration_sync_runs_one_active on app.integration_sync_runs (integration_connection_id, sync_scope)
  where sync_run_state in ('Queued', 'Running', 'Retrying') and deleted_at is null;
create index integration_sync_runs_due_idx on app.integration_sync_runs (next_attempt_at)
  where sync_run_state in ('Queued', 'Retrying');

call private.install_domain_table('app.integration_sync_runs', 'app.integration_connections', 'integration_connection_id',
  array['app.projects', 'project_id']);
create index integration_sync_runs_connection_idx on app.integration_sync_runs (integration_connection_id, created_at desc);
call private.describe('app.integration_sync_runs', 'Sync runs of a connection (Section 17): what moved, how many attempts it took and why it failed. A retryable failure moves the run to Retrying with exponential backoff until max_attempts, then Failed. One active run per connection and scope; the idempotency key makes enqueueing safe to repeat.', array[
  'integration_connection_id', 'Connection synced.',
  'project_id', 'Project the run is limited to, when it is.',
  'sync_scope', 'What the run moves; belongs to the connection''s category.',
  'direction', 'Inbound, Outbound or Two Way.',
  'sync_run_state', 'Run state. Changes only through the sync RPCs.',
  'idempotency_key', 'Caller key that makes enqueueing idempotent per connection.',
  'subject_entity', 'Kind of the one local row the run works on, when it works on one (a payroll run for Payroll Export).',
  'subject_id', 'Local row the run works on, checked to exist in the same org.',
  'source_uri', 'Platform storage path of the file the run imports (a ticketing CSV), when it imports one.',
  'attempt', 'Attempts started so far.',
  'max_attempts', 'Attempts allowed before the run fails for good (1 to 10).',
  'next_attempt_at', 'When a Queued or Retrying run is due.',
  'started_at', 'When the current or last attempt started.',
  'finished_at', 'When the run reached Succeeded, Failed or Canceled.',
  'cursor_before', 'Provider cursor or watermark the run started from.',
  'cursor_after', 'Provider cursor or watermark the next run starts from.',
  'items_read', 'Items read from the source.',
  'items_written', 'Items created or changed at the destination.',
  'items_skipped', 'Items unchanged since the last sync.',
  'items_failed', 'Items that failed; each has a row in app.integration_sync_errors.',
  'error_code', 'Rule code of the last attempt''s failure.',
  'error_message', 'Provider message of the last attempt''s failure.',
  'job_id', 'Latest integration.sync job on the platform job queue (app.job_queue) for the run''s next attempt.'
]);

call private.install_policies('app.integration_sync_runs',
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$);

call private.install_lifecycle('app.integration_sync_runs', 'integration_sync_run_id', 'sync_run_state', 'integration_sync_run', 'Queued',
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$);

create trigger t90_emit_integration_sync_finished after insert on app.integration_sync_run_state_transitions
  for each row when (new.to_state in ('Succeeded', 'Failed'))
  execute function private.emit_subject_event('integration_sync.finished', 'integration_sync_runs', 'integration_sync_run_id', 'to_state');

create or replace function private.guard_integration_sync_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_category app.integration_category;
  v_subject_org uuid;
  v_found boolean := false;
begin
  if tg_op = 'INSERT' then
    select p.category into v_category
    from app.integration_connections c join private.integration_providers p on p.provider_code = c.provider_code
    where c.id = new.integration_connection_id;
    if private.integration_scope_category(new.sync_scope) <> v_category then
      perform private.refuse('integration_scope_mismatch',
        format('A %s connection cannot run %s.', v_category, new.sync_scope));
    end if;
    if new.subject_id is not null then
      execute format('select org_id, true from %s where id = $1', private.integration_entity_table(new.subject_entity))
        into v_subject_org, v_found using new.subject_id;
      if v_found is not true then
        raise exception using errcode = '23503', message = format('integration_sync_runs.subject_id references a missing %s row', new.subject_entity);
      end if;
      if v_subject_org is distinct from new.org_id then
        perform private.refuse('cross_org_reference', 'integration_sync_runs.subject_id points to a row of another org.');
      end if;
    end if;
  elsif new.integration_connection_id <> old.integration_connection_id or new.sync_scope <> old.sync_scope
     or new.idempotency_key <> old.idempotency_key or new.subject_id is distinct from old.subject_id
     or new.source_uri is distinct from old.source_uri then
    perform private.refuse('integration_sync_run_fixed', 'A sync run keeps its connection, scope, idempotency key, subject and source.');
  end if;
  return new;
end;
$$;

comment on function private.guard_integration_sync_run() is 'Sync runs: the scope must belong to the connection''s category, the subject row must exist in the same org, and connection, scope, key, subject and source never change.';

create trigger t40_guard_integration_sync_run before insert or update on app.integration_sync_runs
  for each row execute function private.guard_integration_sync_run();

create table app.integration_sync_errors (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  integration_sync_run_id uuid not null references app.integration_sync_runs (id),
  attempt smallint not null,
  entity app.integration_entity,
  local_id uuid,
  external_id text,
  error_code text not null,
  error_message text not null,
  constraint integration_sync_errors_code_format check (error_code ~ '^[a-z][a-z0-9_]*$'),
  constraint integration_sync_errors_message_length check (char_length(btrim(error_message)) between 1 and 1000),
  constraint integration_sync_errors_external_length check (external_id is null or char_length(external_id) between 1 and 255)
);

create index integration_sync_errors_run_idx on app.integration_sync_errors (integration_sync_run_id);

call private.install_domain_table('app.integration_sync_errors', 'app.integration_sync_runs', 'integration_sync_run_id', '{}', true);
call private.describe('app.integration_sync_errors', 'Append-only per-item errors of sync runs, written by the connector runner, so an admin sees which rows failed and why.', array[
  'integration_sync_run_id', 'Run the error happened in.',
  'attempt', 'Attempt number the error happened on.',
  'entity', 'Kind of the local row that failed, when known.',
  'local_id', 'Local row that failed, when known.',
  'external_id', 'Provider identifier that failed, when known.',
  'error_code', 'Rule code of the failure.',
  'error_message', 'Provider or validation message.'
]);

call private.install_policies('app.integration_sync_errors',
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$);

comment on function app.transition_integration_connection(uuid, app.integration_connection_state, app.integration_connection_state, text) is 'Moves a connection with compare-and-set. Needs org.integrations.manage. Connected needs a stored, unexpired credential (unless the provider needs none); Error is set only by the runner; Disconnected destroys the Vault secret and cancels queued and retrying runs.';

-- Sync RPCs ----------------------------------------------------------------------------------------------------------------

create or replace function private.transition_sync_run(p_run_id uuid, p_expected text, p_next text, p_reason text)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $$
  select private.transition_lifecycle('integration_sync_run', 'app.integration_sync_runs', 'sync_run_state',
    'app.integration_sync_run_state_transitions', 'integration_sync_run_id', p_run_id, p_expected, p_next, p_reason);
$$;

comment on function private.transition_sync_run(uuid, text, text, text) is 'Sync run transition through the shared engine. Callers authorize first.';

insert into private.job_kinds (code, subject_table, max_attempts, description) values
  ('integration.sync', 'app.integration_sync_runs', 1, 'Runs one attempt of an integration sync run. The sync run keeps its own attempts and backoff, so the job itself is tried once.');

create or replace function private.schedule_integration_sync(p_run_id uuid, p_run_after timestamptz)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job uuid;
begin
  v_job := private.enqueue_job((select r.org_id from app.integration_sync_runs r where r.id = p_run_id), 'integration.sync', p_run_id, p_run_after);
  update app.integration_sync_runs set job_id = v_job where id = p_run_id;
  return v_job;
end;
$$;

comment on function private.schedule_integration_sync(uuid, timestamptz) is 'Queues an integration.sync job on the A18 job queue for the next attempt of a sync run and records it on the run.';

create or replace function app.enqueue_integration_sync(
  p_connection_id uuid,
  p_scope app.integration_sync_scope,
  p_direction app.integration_sync_direction,
  p_idempotency_key text,
  p_project_id uuid default null,
  p_max_attempts smallint default 5,
  p_subject_entity app.integration_entity default null,
  p_subject_id uuid default null,
  p_source_uri text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection app.integration_connections;
  v_run uuid;
begin
  select * into v_connection from app.integration_connections c where c.id = p_connection_id and c.deleted_at is null;
  perform private.authorize_integration_manage(v_connection.org_id);
  select r.id into v_run from app.integration_sync_runs r
  where r.integration_connection_id = p_connection_id and r.idempotency_key = p_idempotency_key;
  if v_run is not null then
    return v_run;
  end if;
  if v_connection.connection_state <> 'Connected' then
    perform private.refuse('integration_not_connected', 'Only a Connected connection can sync.');
  end if;
  if exists (select 1 from app.integration_sync_runs r where r.integration_connection_id = p_connection_id
      and r.sync_scope = p_scope and r.sync_run_state in ('Queued', 'Running', 'Retrying') and r.deleted_at is null) then
    perform private.refuse('integration_sync_in_progress', 'A run of this scope is already queued or running for the connection.');
  end if;
  insert into app.integration_sync_runs (integration_connection_id, project_id, sync_scope, direction, idempotency_key, max_attempts,
    next_attempt_at, subject_entity, subject_id, source_uri)
  values (p_connection_id, p_project_id, p_scope, p_direction, p_idempotency_key, coalesce(p_max_attempts, 5), now(),
    p_subject_entity, p_subject_id, p_source_uri)
  returning id into v_run;
  perform private.schedule_integration_sync(v_run, now());
  return v_run;
end;
$$;

comment on function app.enqueue_integration_sync(uuid, app.integration_sync_scope, app.integration_sync_direction, text, uuid, smallint, app.integration_entity, uuid, text) is 'Queues a sync run on a Connected connection. Needs org.integrations.manage (or the service role for scheduled runs). Repeating the idempotency key returns the first run; a second active run of the same scope is refused.';

create or replace function app.claim_integration_sync(p_run_id uuid, p_job_id uuid default null)
returns app.integration_sync_runs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.integration_sync_runs;
  v_state app.integration_connection_state;
begin
  select * into v_run from app.integration_sync_runs r where r.id = p_run_id and r.deleted_at is null for update;
  if v_run.id is null then
    raise exception using errcode = '42501', message = 'the sync run does not exist';
  end if;
  select c.connection_state into v_state from app.integration_connections c where c.id = v_run.integration_connection_id;
  if v_state <> 'Connected' then
    perform private.refuse('integration_not_connected', 'Only a Connected connection can sync.');
  end if;
  if v_run.sync_run_state = 'Retrying' and v_run.next_attempt_at > now() then
    perform private.refuse('integration_sync_not_due', 'The run is backing off until its next attempt time.');
  end if;
  perform private.transition_sync_run(p_run_id, v_run.sync_run_state::text, 'Running',
    format('Attempt %s started.', v_run.attempt + 1));
  update app.integration_sync_runs
  set attempt = attempt + 1, started_at = now(), next_attempt_at = null, job_id = coalesce(p_job_id, job_id)
  where id = p_run_id
  returning * into v_run;
  return v_run;
end;
$$;

comment on function app.claim_integration_sync(uuid, uuid) is 'Runner: starts the next attempt of a Queued or due Retrying run on a Connected connection. Service role only.';

create or replace function app.complete_integration_sync(
  p_run_id uuid,
  p_items_read integer,
  p_items_written integer,
  p_items_skipped integer,
  p_items_failed integer,
  p_cursor_after text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.integration_sync_runs;
begin
  select * into v_run from app.integration_sync_runs r where r.id = p_run_id and r.deleted_at is null for update;
  if v_run.id is null then
    raise exception using errcode = '42501', message = 'the sync run does not exist';
  end if;
  perform private.transition_sync_run(p_run_id, 'Running', 'Succeeded',
    format('Read %s, wrote %s, skipped %s, failed %s.', p_items_read, p_items_written, p_items_skipped, p_items_failed));
  update app.integration_sync_runs
  set items_read = p_items_read, items_written = p_items_written, items_skipped = p_items_skipped, items_failed = p_items_failed,
      cursor_after = p_cursor_after, finished_at = now(), error_code = null, error_message = null
  where id = p_run_id;
  perform private.begin_trusted_operation('integration_sync_runner');
  update app.integration_connections
  set last_synced_at = now(), last_error_code = null, last_error_message = null
  where id = v_run.integration_connection_id and connection_state <> 'Disconnected';
  perform private.end_trusted_operation('integration_sync_runner');
end;
$$;

comment on function app.complete_integration_sync(uuid, integer, integer, integer, integer, text) is 'Runner: marks a Running run Succeeded with its counts and next cursor, and clears the connection''s error. Service role only.';

create or replace function app.fail_integration_sync(
  p_run_id uuid,
  p_error_code text,
  p_error_message text,
  p_retryable boolean,
  p_connection_error boolean default false
)
returns app.integration_sync_run_state
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.integration_sync_runs;
  v_next app.integration_sync_run_state;
  v_message text := left(coalesce(nullif(btrim(p_error_message), ''), p_error_code), 1000);
begin
  select * into v_run from app.integration_sync_runs r where r.id = p_run_id and r.deleted_at is null for update;
  if v_run.id is null then
    raise exception using errcode = '42501', message = 'the sync run does not exist';
  end if;
  v_next := case when p_retryable and not p_connection_error and v_run.attempt < v_run.max_attempts then 'Retrying' else 'Failed' end;
  perform private.transition_sync_run(p_run_id, 'Running', v_next::text,
    format('Attempt %s failed: %s.', v_run.attempt, p_error_code));
  update app.integration_sync_runs
  set error_code = p_error_code, error_message = v_message,
      next_attempt_at = case when v_next = 'Retrying' then now() + private.integration_backoff(v_run.attempt) end,
      finished_at = case when v_next = 'Failed' then now() end
  where id = p_run_id;
  if v_next = 'Retrying' then
    perform private.schedule_integration_sync(p_run_id, now() + private.integration_backoff(v_run.attempt));
  end if;
  perform private.begin_trusted_operation('integration_sync_runner');
  update app.integration_connections set last_error_code = p_error_code, last_error_message = v_message
  where id = v_run.integration_connection_id and connection_state <> 'Disconnected';
  perform private.end_trusted_operation('integration_sync_runner');
  if p_connection_error and (select c.connection_state from app.integration_connections c where c.id = v_run.integration_connection_id) = 'Connected' then
    perform private.transition_lifecycle('integration_connection', 'app.integration_connections', 'connection_state',
      'app.integration_connection_state_transitions', 'integration_connection_id', v_run.integration_connection_id, 'Connected', 'Error',
      format('The provider refused the credential: %s.', p_error_code));
  end if;
  return v_next;
end;
$$;

comment on function app.fail_integration_sync(uuid, text, text, boolean, boolean) is 'Runner: records a failed attempt. A retryable failure with attempts left moves to Retrying, due after the backoff; otherwise the run is Failed. A connection error (refused credential) fails the run for good and moves the connection to Error. Service role only.';

create or replace function app.cancel_integration_sync(p_run_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.integration_sync_runs;
  v_ledger uuid;
begin
  select * into v_run from app.integration_sync_runs r where r.id = p_run_id and r.deleted_at is null for update;
  perform private.authorize_integration_manage(v_run.org_id);
  if v_run.sync_run_state not in ('Queued', 'Retrying') then
    perform private.refuse('integration_sync_not_cancelable', 'Only a Queued or Retrying run can be canceled.');
  end if;
  v_ledger := private.transition_sync_run(p_run_id, v_run.sync_run_state::text, 'Canceled', p_reason);
  update app.integration_sync_runs set finished_at = now(), next_attempt_at = null where id = p_run_id;
  return v_ledger;
end;
$$;

comment on function app.cancel_integration_sync(uuid, text) is 'Cancels a Queued or Retrying run. Needs org.integrations.manage.';

create or replace function app.retry_integration_sync(p_run_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.integration_sync_runs;
  v_ledger uuid;
begin
  select * into v_run from app.integration_sync_runs r where r.id = p_run_id and r.deleted_at is null for update;
  perform private.authorize_integration_manage(v_run.org_id);
  if v_run.sync_run_state <> 'Failed' then
    perform private.refuse('integration_sync_not_failed', 'Only a Failed run can be queued again.');
  end if;
  if (select c.connection_state from app.integration_connections c where c.id = v_run.integration_connection_id) <> 'Connected' then
    perform private.refuse('integration_not_connected', 'Only a Connected connection can sync.');
  end if;
  if exists (select 1 from app.integration_sync_runs r where r.integration_connection_id = v_run.integration_connection_id
      and r.sync_scope = v_run.sync_scope and r.sync_run_state in ('Queued', 'Running', 'Retrying') and r.deleted_at is null) then
    perform private.refuse('integration_sync_in_progress', 'A run of this scope is already queued or running for the connection.');
  end if;
  v_ledger := private.transition_sync_run(p_run_id, 'Failed', 'Queued', p_reason);
  update app.integration_sync_runs
  set attempt = 0, next_attempt_at = now(), finished_at = null, error_code = null, error_message = null
  where id = p_run_id;
  perform private.schedule_integration_sync(p_run_id, now());
  return v_ledger;
end;
$$;

comment on function app.retry_integration_sync(uuid, text) is 'Queues a Failed run again with fresh attempts. Needs org.integrations.manage and a Connected connection.';

create or replace function app.record_integration_sync_error(
  p_run_id uuid,
  p_error_code text,
  p_error_message text,
  p_entity app.integration_entity default null,
  p_local_id uuid default null,
  p_external_id text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.integration_sync_runs;
  v_id uuid;
begin
  select * into v_run from app.integration_sync_runs r where r.id = p_run_id and r.deleted_at is null;
  if v_run.id is null then
    raise exception using errcode = '42501', message = 'the sync run does not exist';
  end if;
  if v_run.sync_run_state <> 'Running' then
    perform private.refuse('integration_sync_not_running', 'Item errors are recorded only while the run is Running.');
  end if;
  insert into app.integration_sync_errors (integration_sync_run_id, attempt, entity, local_id, external_id, error_code, error_message)
  values (p_run_id, v_run.attempt, p_entity, p_local_id, p_external_id, p_error_code, left(p_error_message, 1000))
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.record_integration_sync_error(uuid, text, text, app.integration_entity, uuid, text) is 'Runner: records one item''s failure on a Running run. Service role only.';

create or replace function app.upsert_integration_external_id(
  p_connection_id uuid,
  p_entity app.integration_entity,
  p_local_id uuid,
  p_external_id text,
  p_external_version text default null,
  p_content_hash text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update app.integration_external_ids
  set external_id = p_external_id, external_version = p_external_version, content_hash = p_content_hash, last_synced_at = now()
  where integration_connection_id = p_connection_id and entity = p_entity and local_id = p_local_id and deleted_at is null
  returning id into v_id;
  if v_id is null then
    insert into app.integration_external_ids (integration_connection_id, entity, local_id, external_id, external_version, content_hash)
    values (p_connection_id, p_entity, p_local_id, p_external_id, p_external_version, p_content_hash)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

comment on function app.upsert_integration_external_id(uuid, app.integration_entity, uuid, text, text, text) is 'Runner: records or refreshes the identifier pair of a local row after a sync. Service role only.';

-- Privileges -----------------------------------------------------------------------------------------------------------------

revoke all on function private.integration_scope_category(app.integration_sync_scope) from public, anon;
revoke all on function private.integration_entity_table(app.integration_entity) from public, anon, authenticated;
revoke all on function private.integration_backoff(integer) from public, anon;
revoke all on function private.guard_integration_connection() from public, anon, authenticated;
revoke all on function private.guard_integration_external_id() from public, anon, authenticated;
revoke all on function private.guard_integration_sync_run() from public, anon, authenticated;
revoke all on function private.authorize_integration_manage(uuid) from public, anon, authenticated;
revoke all on function private.destroy_integration_credential(uuid) from public, anon, authenticated;
revoke all on function private.transition_sync_run(uuid, text, text, text) from public, anon, authenticated;
revoke all on function private.schedule_integration_sync(uuid, timestamptz) from public, anon, authenticated;
grant execute on function private.integration_scope_category(app.integration_sync_scope) to authenticated, service_role;
grant execute on function private.integration_backoff(integer) to authenticated, service_role;

revoke all on function app.store_integration_credential(uuid, text, app.integration_credential_kind, timestamptz) from public, anon;
revoke all on function app.transition_integration_connection(uuid, app.integration_connection_state, app.integration_connection_state, text) from public, anon;
revoke all on function app.enqueue_integration_sync(uuid, app.integration_sync_scope, app.integration_sync_direction, text, uuid, smallint, app.integration_entity, uuid, text) from public, anon;
revoke all on function app.cancel_integration_sync(uuid, text) from public, anon;
revoke all on function app.retry_integration_sync(uuid, text) from public, anon;
grant execute on function app.store_integration_credential(uuid, text, app.integration_credential_kind, timestamptz) to authenticated, service_role;
grant execute on function app.transition_integration_connection(uuid, app.integration_connection_state, app.integration_connection_state, text) to authenticated, service_role;
grant execute on function app.enqueue_integration_sync(uuid, app.integration_sync_scope, app.integration_sync_direction, text, uuid, smallint, app.integration_entity, uuid, text) to authenticated, service_role;
grant execute on function app.cancel_integration_sync(uuid, text) to authenticated, service_role;
grant execute on function app.retry_integration_sync(uuid, text) to authenticated, service_role;

revoke all on function app.read_integration_credential(uuid) from public, anon, authenticated;
revoke all on function app.claim_integration_sync(uuid, uuid) from public, anon, authenticated;
revoke all on function app.complete_integration_sync(uuid, integer, integer, integer, integer, text) from public, anon, authenticated;
revoke all on function app.fail_integration_sync(uuid, text, text, boolean, boolean) from public, anon, authenticated;
revoke all on function app.record_integration_sync_error(uuid, text, text, app.integration_entity, uuid, text) from public, anon, authenticated;
revoke all on function app.upsert_integration_external_id(uuid, app.integration_entity, uuid, text, text, text) from public, anon, authenticated;
grant execute on function app.read_integration_credential(uuid) to service_role;
grant execute on function app.claim_integration_sync(uuid, uuid) to service_role;
grant execute on function app.complete_integration_sync(uuid, integer, integer, integer, integer, text) to service_role;
grant execute on function app.fail_integration_sync(uuid, text, text, boolean, boolean) to service_role;
grant execute on function app.record_integration_sync_error(uuid, text, text, app.integration_entity, uuid, text) to service_role;
grant execute on function app.upsert_integration_external_id(uuid, app.integration_entity, uuid, text, text, text) to service_role;

-- Retention (ADR 0002) ---------------------------------------------------------------------------------------------------------

call private.install_default_retention('app.integration_connections');
call private.install_default_retention('app.integration_connection_state_transitions');
call private.install_default_retention('app.integration_external_ids');
call private.install_default_retention('app.integration_sync_runs');
call private.install_default_retention('app.integration_sync_run_state_transitions');
call private.install_default_retention('app.integration_sync_errors', interval '2 years');
