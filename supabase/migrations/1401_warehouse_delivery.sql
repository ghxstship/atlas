-- 1401_warehouse_delivery.sql
-- A83 Warehouse delivery (RRR-128, finding A65-029, Section 4.6.4 and Section 7.3): nightly files of an org's data
-- in the customer's own bucket, with a published schema. No customer receives database credentials.
--   * private.warehouse_tables: the delivered tables, in a fixed order. Columns come from the catalog at delivery
--     time and go through the column registry (Section 8.3): Restricted columns are never delivered, because Section
--     8.6 lets Restricted data leave only with the restricted export capability and step-up authentication, which an
--     unattended nightly job cannot give. Confidential columns go only when a holder of data.export.confidential
--     turned them on for the destination. Encrypted values (bytea) never go.
--   * private.warehouse_providers: S3 (any S3-compatible service) is available; Google Cloud Storage, Azure Blob,
--     BigQuery and Snowflake are named and refused until their providers are built (packages/integrations warehouse).
--   * app.warehouse_destinations: a customer bucket, its credential in Supabase Vault, the format (Parquet or CSV)
--     and the hour of the nightly delivery. Enterprise plan only, behind the reports.warehouse_delivery flag, managed
--     by holders of reports.schedule.write ("Schedule report delivery and warehouse delivery", 0203).
--   * app.warehouse_deliveries and app.warehouse_delivery_files: every delivery and every file it wrote, audited.
--     The integration worker claims warehouse.deliver jobs, reads rows through app.warehouse_table_rows (the org's
--     own rows, delivered columns only) and records each file.

-- Enums ---------------------------------------------------------------------------------------------------------

create type app.warehouse_provider as enum ('S3', 'Google Cloud Storage', 'Azure Blob', 'BigQuery', 'Snowflake');
comment on type app.warehouse_provider is 'Where warehouse files go: S3 or an S3-compatible service, Google Cloud Storage, Azure Blob, BigQuery or Snowflake (private.warehouse_providers says which are available).';

create type app.warehouse_file_format as enum ('Parquet', 'CSV');
comment on type app.warehouse_file_format is 'File format of a warehouse delivery: Parquet (Section 4.6.4) or CSV.';

create type app.warehouse_destination_state as enum ('Active', 'Paused');
comment on type app.warehouse_destination_state is 'A destination receives its nightly delivery while Active; a Paused one receives nothing.';

create type app.warehouse_delivery_state as enum ('Queued', 'Running', 'Delivered', 'Retrying', 'Failed');
comment on type app.warehouse_delivery_state is 'Delivery lifecycle: Queued, Running, then Delivered, Retrying (a retryable failure with attempts left) or Failed.';

insert into private.domain_event_types (code, subject, description) values
  ('warehouse_delivery.finished', 'warehouse_deliveries', 'A warehouse delivery was Delivered or Failed for good.');

insert into private.job_kinds (code, subject_table, max_attempts, description) values
  ('warehouse.deliver', 'app.warehouse_deliveries', 3, 'Runs one attempt of a warehouse delivery; the delivery owns its own attempts and backoff.');

-- The flag existed since 0540 with nothing behind it; the plan check below keeps it to Enterprise.
update private.feature_flags set default_enabled = true where flag_key = 'reports.warehouse_delivery';

-- Catalogs -------------------------------------------------------------------------------------------------------

create table private.warehouse_providers (
  provider app.warehouse_provider primary key,
  available boolean not null,
  sort_order smallint not null unique
);

comment on table private.warehouse_providers is 'Warehouse providers and whether XOS can deliver to them yet; a destination for an unavailable provider is refused.';
comment on column private.warehouse_providers.provider is 'Provider.';
comment on column private.warehouse_providers.available is 'True once the provider is built end to end in packages/integrations.';
comment on column private.warehouse_providers.sort_order is 'Display order.';

insert into private.warehouse_providers (provider, available, sort_order) values
  ('S3', true, 1), ('Google Cloud Storage', false, 2), ('Azure Blob', false, 3), ('BigQuery', false, 4), ('Snowflake', false, 5);

alter table private.warehouse_providers enable row level security;
revoke all on private.warehouse_providers from public, anon, authenticated;
grant select on private.warehouse_providers to service_role;

create view app.warehouse_providers as
select p.provider, p.available, p.sort_order from private.warehouse_providers p;
call private.describe('app.warehouse_providers', 'Warehouse providers and whether XOS can deliver to them yet.', array[
  'provider', 'Provider.',
  'available', 'True when destinations for the provider are accepted.',
  'sort_order', 'Display order.'
]);
revoke all on app.warehouse_providers from public, anon;
grant select on app.warehouse_providers to authenticated, service_role;

create table private.warehouse_tables (
  table_key text primary key,
  table_name text not null unique,
  sort_order smallint not null unique,
  description text not null,
  constraint warehouse_tables_key_format check (table_key ~ '^[a-z][a-z0-9_]*$'),
  constraint warehouse_tables_name_format check (table_name ~ '^app\.[a-z][a-z0-9_]*$')
);

comment on table private.warehouse_tables is 'Tables a warehouse delivery writes, one file each, in order. Every table has id, org_id, created_at and deleted_at; columns come from the catalog and the column registry at delivery time.';
comment on column private.warehouse_tables.table_key is 'File and schema name of the table in the delivery, for example records.';
comment on column private.warehouse_tables.table_name is 'Schema-qualified source table.';
comment on column private.warehouse_tables.sort_order is 'Order of the files in a delivery.';
comment on column private.warehouse_tables.description is 'What a row is, as the published schema says it.';

insert into private.warehouse_tables (table_key, table_name, sort_order, description) values
  ('projects', 'app.projects', 1, 'One row per project.'),
  ('records', 'app.records', 2, 'One row per work record: tasks, schedule items and work orders.'),
  ('venues', 'app.venues', 3, 'One row per venue.'),
  ('counterparties', 'app.counterparties', 4, 'One row per client, vendor or partner organization the org deals with.'),
  ('vendors', 'app.vendors', 5, 'One row per vendor facet of a counterparty.'),
  ('budget_lines', 'app.budget_lines', 6, 'One row per budget line.'),
  ('purchase_orders', 'app.purchase_orders', 7, 'One row per purchase order.'),
  ('po_lines', 'app.po_lines', 8, 'One row per purchase order line.'),
  ('change_orders', 'app.change_orders', 9, 'One row per change order.'),
  ('invoices', 'app.invoices', 10, 'One row per invoice issued or received.'),
  ('payments', 'app.payments', 11, 'One row per payment.'),
  ('expenses', 'app.expenses', 12, 'One row per expense.'),
  ('shipments', 'app.shipments', 13, 'One row per shipment.'),
  ('asset_units', 'app.asset_units', 14, 'One row per tracked asset unit.'),
  ('shifts', 'app.shifts', 15, 'One row per crew shift.'),
  ('timesheets', 'app.timesheets', 16, 'One row per timesheet.'),
  ('incidents', 'app.incidents', 17, 'One row per incident.'),
  ('engagements', 'app.engagements', 18, 'One row per external engagement (Section 4.8); the agreed rate is Restricted and never delivered.'),
  ('pay_rates', 'app.pay_rates', 19, 'One row per pay rate of a member; the rate itself is Restricted and never delivered.');

alter table private.warehouse_tables enable row level security;
revoke all on private.warehouse_tables from public, anon, authenticated;
grant select on private.warehouse_tables to service_role;

create or replace function private.warehouse_table_columns(p_include_confidential boolean)
returns table (
  table_key text,
  table_name text,
  column_name text,
  ordinal integer,
  data_type text,
  classification app.data_classification,
  delivered boolean,
  withheld_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.table_key, t.table_name, a.attname::text, a.attnum::integer,
    case
      when a.atttypid in ('smallint'::regtype, 'integer'::regtype) then 'int32'
      when a.atttypid = 'bigint'::regtype then 'int64'
      when a.atttypid in ('numeric'::regtype, 'real'::regtype, 'double precision'::regtype) then 'double'
      when a.atttypid = 'boolean'::regtype then 'boolean'
      when a.atttypid = 'date'::regtype then 'date'
      when a.atttypid in ('timestamp with time zone'::regtype, 'timestamp without time zone'::regtype) then 'timestamp'
      when a.atttypid = 'bytea'::regtype then 'binary'
      else 'string'
    end,
    c.classification,
    case
      when a.atttypid = 'bytea'::regtype then false
      when c.classification = 'Restricted' then false
      when c.classification = 'Confidential' then p_include_confidential
      else true
    end,
    case
      when a.atttypid = 'bytea'::regtype then 'encrypted'
      when c.classification = 'Restricted' then 'restricted'
      when c.classification = 'Confidential' and not p_include_confidential then 'confidential'
    end
  from private.warehouse_tables t
  join pg_catalog.pg_attribute a on a.attrelid = to_regclass(t.table_name) and a.attnum > 0 and not a.attisdropped
  left join private.column_classifications c on c.table_name = t.table_name and c.column_name = a.attname::text
  order by t.sort_order, a.attnum;
$$;

comment on function private.warehouse_table_columns(boolean) is 'Every column of every delivered table with its warehouse type and classification, and whether a delivery writes it: never a Restricted or encrypted column, a Confidential one only when the destination includes Confidential columns.';
revoke all on function private.warehouse_table_columns(boolean) from public, anon, authenticated;

create or replace function app.warehouse_published_schema()
returns table (
  table_key text,
  description text,
  column_name text,
  ordinal integer,
  data_type text,
  classification app.data_classification,
  delivered_by_default boolean,
  delivered_with_confidential boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.table_key, t.description, c.column_name, c.ordinal, c.data_type, c.classification,
    c.delivered, w.delivered
  from private.warehouse_table_columns(false) c
  join private.warehouse_table_columns(true) w on w.table_key = c.table_key and w.column_name = c.column_name
  join private.warehouse_tables t on t.table_key = c.table_key
  where w.delivered or c.classification is not null
  order by t.sort_order, c.ordinal;
$$;

comment on function app.warehouse_published_schema() is 'The published warehouse schema (Section 4.6.4): every delivered table and column with its type and classification, and the withheld classified columns, so a customer can see what arrives and what never does. Catalog only, no data.';

-- Destinations ---------------------------------------------------------------------------------------------------

create or replace function private.warehouse_delivery_allowed(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.flag_enabled(p_org_id, 'reports.warehouse_delivery')
    and coalesce((select distinct l.plan_code from private.org_plan_limits l where l.org_id = p_org_id), 'access') = 'enterprise';
$$;

comment on function private.warehouse_delivery_allowed(uuid) is 'Warehouse delivery is an Enterprise feature (Section 4.6.4): true when the org is on the Enterprise plan and the reports.warehouse_delivery flag is on for it.';
revoke all on function private.warehouse_delivery_allowed(uuid) from public, anon, authenticated;

create or replace function private.next_warehouse_slot(p_hour smallint, p_after timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
    when date_trunc('day', p_after at time zone 'UTC') + make_interval(hours => p_hour) > (p_after at time zone 'UTC')
      then (date_trunc('day', p_after at time zone 'UTC') + make_interval(hours => p_hour)) at time zone 'UTC'
    else (date_trunc('day', p_after at time zone 'UTC') + interval '1 day' + make_interval(hours => p_hour)) at time zone 'UTC'
  end;
$$;

comment on function private.next_warehouse_slot(smallint, timestamptz) is 'The next nightly delivery time after a moment: the given hour (UTC) today if it is still ahead, else tomorrow.';
revoke all on function private.next_warehouse_slot(smallint, timestamptz) from public, anon, authenticated;

create table app.warehouse_destinations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  provider app.warehouse_provider not null references private.warehouse_providers (provider),
  display_name text not null,
  bucket_name text not null,
  region text,
  endpoint_url text,
  path_prefix text not null default 'xos',
  file_format app.warehouse_file_format not null default 'Parquet',
  include_confidential boolean not null default false,
  delivery_hour_utc smallint not null default 2,
  destination_state app.warehouse_destination_state not null default 'Active',
  next_delivery_at timestamptz,
  credential_stored_at timestamptz,
  last_delivered_at timestamptz,
  last_error_code text,
  last_error_message text,
  constraint warehouse_destinations_name_length check (char_length(btrim(display_name)) between 1 and 120),
  constraint warehouse_destinations_bucket_format check (bucket_name ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' and bucket_name !~ '\.\.'),
  constraint warehouse_destinations_region_format check (region is null or region ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  constraint warehouse_destinations_endpoint_format check (endpoint_url is null or (endpoint_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{2,5})?/?$' and char_length(endpoint_url) <= 300)),
  constraint warehouse_destinations_prefix_format check (path_prefix ~ '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+){0,5}$' and char_length(path_prefix) <= 200),
  constraint warehouse_destinations_hour_range check (delivery_hour_utc between 0 and 23),
  constraint warehouse_destinations_error_length check (last_error_message is null or char_length(last_error_message) <= 2000)
);

create index warehouse_destinations_provider_idx on app.warehouse_destinations (provider);

call private.install_domain_table('app.warehouse_destinations');
create index warehouse_destinations_due_idx on app.warehouse_destinations (next_delivery_at) where destination_state = 'Active' and deleted_at is null;
call private.describe('app.warehouse_destinations', 'A customer''s own bucket that receives the org''s nightly warehouse files (Section 4.6.4, Enterprise). The bucket credential lives in Supabase Vault and is never shown again.', array[
  'provider', 'S3 (or S3-compatible), Google Cloud Storage, Azure Blob, BigQuery or Snowflake.',
  'display_name', 'Name the org knows the destination by.',
  'bucket_name', 'Bucket or container the files go to.',
  'region', 'Bucket region, for example us-east-1.',
  'endpoint_url', 'HTTPS endpoint of an S3-compatible service other than AWS; NULL for AWS S3. Private and internal hosts are refused.',
  'path_prefix', 'Folder inside the bucket; each delivery writes <prefix>/<date>/<delivery id>/.',
  'file_format', 'Parquet or CSV.',
  'include_confidential', 'Whether Confidential columns are delivered; only a holder of data.export.confidential turns it on. Restricted columns are never delivered.',
  'delivery_hour_utc', 'Hour of the nightly delivery, UTC.',
  'destination_state', 'Active or Paused.',
  'next_delivery_at', 'When the next nightly delivery is queued.',
  'credential_stored_at', 'When the bucket credential was stored in Vault, or NULL.',
  'last_delivered_at', 'When the last delivery finished.',
  'last_error_code', 'Rule code of the last failed delivery.',
  'last_error_message', 'Message of the last failed delivery.'
]);

call private.install_policies('app.warehouse_destinations',
  $$org_id in (select private.orgs_with_capability('reports.schedule.write'))$$,
  $$org_id in (select private.orgs_with_capability('reports.schedule.write'))$$);
call private.install_audit_trail('app.warehouse_destinations');
call private.install_default_retention('app.warehouse_destinations', interval '1 year');

create or replace function private.guard_warehouse_destination()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trusted boolean := private.in_trusted_operation('warehouse_delivery');
begin
  if tg_op = 'UPDATE' and new.provider <> old.provider then
    perform private.refuse('warehouse_provider_fixed', 'A destination keeps its provider; add another destination instead.');
  end if;
  if tg_op = 'INSERT' or new.deleted_at is null then
    if not private.warehouse_delivery_allowed(new.org_id) then
      perform private.refuse('warehouse_plan', 'Warehouse delivery is part of the Enterprise plan.');
    end if;
    if not (select p.available from private.warehouse_providers p where p.provider = new.provider) then
      perform private.refuse('warehouse_provider_unavailable', format('Delivery to %s is not available yet. Use S3 or an S3-compatible bucket.', new.provider));
    end if;
  end if;
  if new.endpoint_url is not null and (tg_op = 'INSERT' or new.endpoint_url is distinct from old.endpoint_url) then
    begin
      perform private.assert_public_webhook_host(new.endpoint_url);
    exception when sqlstate 'XR001' then
      perform private.refuse('warehouse_private_endpoint', 'A bucket endpoint must be a public HTTPS host.');
    end;
  end if;
  if new.include_confidential and (tg_op = 'INSERT' or not old.include_confidential)
     and private.current_person_id() is not null and not private.has_capability(new.org_id, 'data.export.confidential') then
    perform private.refuse('warehouse_confidential_capability', 'Delivering Confidential columns needs the confidential export capability.');
  end if;
  if not v_trusted then
    if tg_op = 'INSERT' then
      new.credential_stored_at := null;
      new.last_delivered_at := null;
      new.last_error_code := null;
      new.last_error_message := null;
    elsif new.credential_stored_at is distinct from old.credential_stored_at
       or new.last_delivered_at is distinct from old.last_delivered_at
       or new.last_error_code is distinct from old.last_error_code
       or new.last_error_message is distinct from old.last_error_message
       or new.next_delivery_at is distinct from old.next_delivery_at and new.delivery_hour_utc = old.delivery_hour_utc
          and new.destination_state = old.destination_state then
      perform private.refuse('warehouse_fields_service_only', 'Credential and delivery details change only through the warehouse RPCs.');
    end if;
    if tg_op = 'INSERT' or new.delivery_hour_utc <> old.delivery_hour_utc
       or (new.destination_state = 'Active' and old.destination_state = 'Paused') then
      new.next_delivery_at := private.next_warehouse_slot(new.delivery_hour_utc, now());
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_warehouse_destination() is 'Warehouse destinations: Enterprise plan and the reports.warehouse_delivery flag; an available provider, fixed once chosen; a public HTTPS endpoint (the webhook SSRF guard); Confidential columns only by a holder of data.export.confidential; credential and delivery details only through the warehouse RPCs; the next delivery follows the chosen hour.';
revoke all on function private.guard_warehouse_destination() from public, anon, authenticated;

create trigger t40_guard_warehouse_destination before insert or update on app.warehouse_destinations
  for each row execute function private.guard_warehouse_destination();

create table private.warehouse_credentials (
  warehouse_destination_id uuid primary key references app.warehouse_destinations (id),
  vault_secret_id uuid not null
);

comment on table private.warehouse_credentials is 'Pointer from a warehouse destination to its bucket credential in vault.secrets (xos_warehouse_<destination id>). Only the service role decrypts it, through app.read_warehouse_credential.';
comment on column private.warehouse_credentials.warehouse_destination_id is 'Destination the credential belongs to.';
comment on column private.warehouse_credentials.vault_secret_id is 'Id of the vault.secrets row holding the encrypted credential.';

alter table private.warehouse_credentials enable row level security;
revoke all on private.warehouse_credentials from public, anon, authenticated;

create or replace function private.authorize_warehouse_manage(p_org_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_org_id is null then
    raise exception using errcode = '42501', message = 'the destination does not exist';
  end if;
  if private.current_person_id() is not null and not private.has_capability(p_org_id, 'reports.schedule.write') then
    raise exception using errcode = '42501', message = 'reports.schedule.write is required';
  end if;
end;
$$;

comment on function private.authorize_warehouse_manage(uuid) is 'Raises 42501 unless the signed-in person holds reports.schedule.write in the org; the service role passes.';
revoke all on function private.authorize_warehouse_manage(uuid) from public, anon, authenticated;

create or replace function app.store_warehouse_credential(p_destination_id uuid, p_secret text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_destination app.warehouse_destinations;
  v_secret_id uuid;
begin
  select * into v_destination from app.warehouse_destinations d where d.id = p_destination_id and d.deleted_at is null for update;
  perform private.authorize_warehouse_manage(v_destination.org_id);
  if not private.warehouse_delivery_allowed(v_destination.org_id) then
    perform private.refuse('warehouse_plan', 'Warehouse delivery is part of the Enterprise plan.');
  end if;
  if p_secret is null or char_length(btrim(p_secret)) = 0 then
    perform private.refuse('warehouse_credential_empty', 'A bucket credential needs a value.');
  end if;
  if char_length(p_secret) > 16384 then
    perform private.refuse('warehouse_credential_too_large', 'A bucket credential is at most 16 KB.');
  end if;
  select c.vault_secret_id into v_secret_id from private.warehouse_credentials c where c.warehouse_destination_id = p_destination_id;
  if v_secret_id is null then
    v_secret_id := vault.create_secret(p_secret, 'xos_warehouse_' || p_destination_id::text,
      format('Bucket credential of warehouse destination %s (%s).', p_destination_id, v_destination.provider));
    insert into private.warehouse_credentials (warehouse_destination_id, vault_secret_id) values (p_destination_id, v_secret_id);
  else
    perform vault.update_secret(v_secret_id, p_secret);
  end if;
  perform private.begin_trusted_operation('warehouse_delivery');
  update app.warehouse_destinations set credential_stored_at = now() where id = p_destination_id;
  perform private.end_trusted_operation('warehouse_delivery');
end;
$$;

comment on function app.store_warehouse_credential(uuid, text) is 'Stores or rotates a warehouse destination''s bucket credential in Supabase Vault (Section 9). Needs reports.schedule.write and the Enterprise plan; the credential is never returned to signed-in callers.';

create or replace function app.read_warehouse_credential(p_destination_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  select s.decrypted_secret into v_secret
  from private.warehouse_credentials c
  join app.warehouse_destinations d on d.id = c.warehouse_destination_id and d.deleted_at is null
  join vault.decrypted_secrets s on s.id = c.vault_secret_id
  where c.warehouse_destination_id = p_destination_id;
  if v_secret is null then
    perform private.refuse('warehouse_credential_required', 'The destination has no stored bucket credential.');
  end if;
  return v_secret;
end;
$$;

comment on function app.read_warehouse_credential(uuid) is 'Decrypts a warehouse destination''s bucket credential for the delivery worker. Service role only.';

create or replace function private.destroy_warehouse_credential()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  delete from private.warehouse_credentials c where c.warehouse_destination_id = new.id
  returning c.vault_secret_id into v_secret_id;
  if v_secret_id is not null then
    delete from vault.secrets s where s.id = v_secret_id;
  end if;
  return null;
end;
$$;

comment on function private.destroy_warehouse_credential() is 'Destroys a warehouse destination''s Vault credential when the destination is deleted, so no bucket credential outlives it.';
revoke all on function private.destroy_warehouse_credential() from public, anon, authenticated;

create trigger t91_destroy_warehouse_credential after update of deleted_at on app.warehouse_destinations
  for each row when (new.deleted_at is not null and old.deleted_at is null)
  execute function private.destroy_warehouse_credential();

-- Deliveries -----------------------------------------------------------------------------------------------------

create table app.warehouse_deliveries (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  warehouse_destination_id uuid not null references app.warehouse_destinations (id),
  delivery_state app.warehouse_delivery_state not null default 'Queued',
  requested_manually boolean not null default false,
  file_format app.warehouse_file_format not null,
  include_confidential boolean not null,
  attempt smallint not null default 0,
  max_attempts smallint not null default 5,
  next_attempt_at timestamptz,
  snapshot_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  object_prefix text,
  schema_version text,
  tables_delivered integer not null default 0,
  rows_delivered bigint not null default 0,
  bytes_delivered bigint not null default 0,
  columns_withheld integer not null default 0,
  error_code text,
  error_message text,
  constraint warehouse_deliveries_attempts check (attempt >= 0 and max_attempts between 1 and 10 and attempt <= max_attempts),
  constraint warehouse_deliveries_counts check (tables_delivered >= 0 and rows_delivered >= 0 and bytes_delivered >= 0 and columns_withheld >= 0),
  constraint warehouse_deliveries_prefix_length check (object_prefix is null or char_length(object_prefix) <= 400),
  constraint warehouse_deliveries_error_length check (error_message is null or char_length(error_message) <= 2000),
  constraint warehouse_deliveries_finished check ((delivery_state in ('Delivered', 'Failed')) = (finished_at is not null))
);


call private.install_domain_table('app.warehouse_deliveries', 'app.warehouse_destinations', 'warehouse_destination_id');
create index warehouse_deliveries_destination_idx on app.warehouse_deliveries (warehouse_destination_id, created_at desc);
create unique index warehouse_deliveries_one_active on app.warehouse_deliveries (warehouse_destination_id)
  where delivery_state in ('Queued', 'Running', 'Retrying') and deleted_at is null;
call private.describe('app.warehouse_deliveries', 'Every warehouse delivery (Section 7.3 warehouse_deliveries): when it ran, what it wrote and how many classified columns it withheld. Audited; written only by the delivery RPCs.', array[
  'warehouse_destination_id', 'Destination the files went to.',
  'delivery_state', 'Queued, Running, Delivered, Retrying or Failed.',
  'requested_manually', 'True when a person asked for it with Deliver now; false for the nightly schedule.',
  'file_format', 'Format the delivery writes, fixed when it is queued.',
  'include_confidential', 'Whether Confidential columns are delivered, fixed when it is queued.',
  'attempt', 'Attempts started so far.',
  'max_attempts', 'Attempts before the delivery is Failed.',
  'next_attempt_at', 'When a Queued or Retrying delivery is due.',
  'snapshot_at', 'Cut-off of the delivery: rows created after it wait for the next delivery.',
  'started_at', 'When the current or last attempt started.',
  'finished_at', 'When the delivery was Delivered or Failed.',
  'object_prefix', 'Folder in the bucket the files were written to.',
  'schema_version', 'Version of the published schema the files follow.',
  'tables_delivered', 'Tables written.',
  'rows_delivered', 'Rows written across all files.',
  'bytes_delivered', 'Bytes written across all files.',
  'columns_withheld', 'Classified or encrypted columns left out across all tables.',
  'error_code', 'Rule code of the last failure.',
  'error_message', 'Message of the last failure.'
]);

call private.install_policies('app.warehouse_deliveries',
  $$org_id in (select private.orgs_with_capability('reports.schedule.write'))$$);
call private.install_audit_trail('app.warehouse_deliveries');
insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.warehouse_deliveries', 'Age', 'created_at', interval '2 years', 'Delete', 'Delivery history is kept two years as evidence of what left XOS; the audit ledger keeps it longer.');

create table app.warehouse_delivery_files (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  warehouse_delivery_id uuid not null references app.warehouse_deliveries (id),
  table_key text not null references private.warehouse_tables (table_key),
  object_key text not null,
  row_count bigint not null,
  byte_count bigint not null,
  sha256 text not null,
  columns_delivered smallint not null,
  columns_withheld smallint not null,
  constraint warehouse_delivery_files_key_length check (char_length(object_key) between 1 and 600),
  constraint warehouse_delivery_files_counts check (row_count >= 0 and byte_count >= 0 and columns_delivered >= 1 and columns_withheld >= 0),
  constraint warehouse_delivery_files_sha256_format check (sha256 ~ '^[0-9a-f]{64}$')
);

create index warehouse_delivery_files_delivery_idx on app.warehouse_delivery_files (warehouse_delivery_id);
create index warehouse_delivery_files_table_key_idx on app.warehouse_delivery_files (table_key);
create unique index warehouse_delivery_files_object_key on app.warehouse_delivery_files (warehouse_delivery_id, object_key);

call private.install_domain_table('app.warehouse_delivery_files', 'app.warehouse_deliveries', 'warehouse_delivery_id', '{}', true);
call private.describe('app.warehouse_delivery_files', 'One file a warehouse delivery wrote: its object key, rows, bytes and SHA-256, and how many columns it delivered and withheld. A large table is written in parts, one row each. Append-only.', array[
  'warehouse_delivery_id', 'Delivery that wrote the file.',
  'table_key', 'Table the file holds (all of it, or one part of it).',
  'object_key', 'Object key in the destination bucket.',
  'row_count', 'Rows in the file.',
  'byte_count', 'Size of the file in bytes.',
  'sha256', 'SHA-256 of the file, lowercase hex.',
  'columns_delivered', 'Columns written.',
  'columns_withheld', 'Classified or encrypted columns left out.'
]);

call private.install_policies('app.warehouse_delivery_files',
  $$org_id in (select private.orgs_with_capability('reports.schedule.write'))$$);
call private.install_default_retention('app.warehouse_delivery_files', interval '2 years');

-- Queueing --------------------------------------------------------------------------------------------------------

create or replace function private.queue_warehouse_delivery(p_destination app.warehouse_destinations, p_manual boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into app.warehouse_deliveries (warehouse_destination_id, requested_manually, file_format, include_confidential, next_attempt_at)
  values (p_destination.id, p_manual, p_destination.file_format, p_destination.include_confidential, now())
  returning id into v_id;
  perform private.enqueue_job(p_destination.org_id, 'warehouse.deliver', v_id, now());
  return v_id;
end;
$$;

comment on function private.queue_warehouse_delivery(app.warehouse_destinations, boolean) is 'Queues one delivery of a destination and its warehouse.deliver job. Callers check eligibility first.';
revoke all on function private.queue_warehouse_delivery(app.warehouse_destinations, boolean) from public, anon, authenticated;

create or replace function app.request_warehouse_delivery(p_destination_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_destination app.warehouse_destinations;
begin
  select * into v_destination from app.warehouse_destinations d where d.id = p_destination_id and d.deleted_at is null for update;
  perform private.authorize_warehouse_manage(v_destination.org_id);
  if not private.warehouse_delivery_allowed(v_destination.org_id) then
    perform private.refuse('warehouse_plan', 'Warehouse delivery is part of the Enterprise plan.');
  end if;
  if v_destination.destination_state <> 'Active' then
    perform private.refuse('warehouse_destination_paused', 'Resume the destination before delivering to it.');
  end if;
  if v_destination.credential_stored_at is null then
    perform private.refuse('warehouse_credential_required', 'Store the bucket credential before the first delivery.');
  end if;
  if exists (select 1 from app.warehouse_deliveries w where w.warehouse_destination_id = p_destination_id
             and w.delivery_state in ('Queued', 'Running', 'Retrying') and w.deleted_at is null) then
    perform private.refuse('warehouse_delivery_in_progress', 'A delivery to this destination is already on its way.');
  end if;
  return private.queue_warehouse_delivery(v_destination, true);
end;
$$;

comment on function app.request_warehouse_delivery(uuid) is 'Deliver now: queues a delivery of an Active destination with a stored credential, unless one is already on its way. Needs reports.schedule.write and the Enterprise plan.';

create or replace function app.queue_due_warehouse_deliveries()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_destination app.warehouse_destinations;
  v_count integer := 0;
begin
  for v_destination in
    select d.* from app.warehouse_destinations d
    where d.destination_state = 'Active' and d.deleted_at is null and d.credential_stored_at is not null
      and d.next_delivery_at <= now()
    order by d.next_delivery_at
    for update skip locked
  loop
    perform private.begin_trusted_operation('warehouse_delivery');
    update app.warehouse_destinations set next_delivery_at = private.next_warehouse_slot(v_destination.delivery_hour_utc, now())
    where id = v_destination.id;
    perform private.end_trusted_operation('warehouse_delivery');
    if private.warehouse_delivery_allowed(v_destination.org_id)
       and not exists (select 1 from app.warehouse_deliveries w where w.warehouse_destination_id = v_destination.id
                       and w.delivery_state in ('Queued', 'Running', 'Retrying') and w.deleted_at is null) then
      perform private.queue_warehouse_delivery(v_destination, false);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

comment on function app.queue_due_warehouse_deliveries() is 'Scheduler (service role, pg_cron hourly): queues the nightly delivery of every due Active destination with a stored credential on an eligible org, and moves its next delivery to the same hour tomorrow. Returns the deliveries queued.';

-- Running a delivery -----------------------------------------------------------------------------------------------

create or replace function app.claim_warehouse_delivery(p_delivery_id uuid)
returns table (
  delivery_id uuid,
  org_id uuid,
  destination_id uuid,
  provider app.warehouse_provider,
  bucket_name text,
  region text,
  endpoint_url text,
  path_prefix text,
  file_format app.warehouse_file_format,
  include_confidential boolean,
  attempt smallint,
  snapshot_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_delivery app.warehouse_deliveries;
  v_destination app.warehouse_destinations;
begin
  select * into v_delivery from app.warehouse_deliveries w where w.id = p_delivery_id and w.deleted_at is null for update;
  if v_delivery.id is null then
    raise exception using errcode = '42501', message = 'the delivery does not exist';
  end if;
  if v_delivery.delivery_state not in ('Queued', 'Retrying') then
    perform private.refuse('warehouse_delivery_not_pending', 'Only a Queued or Retrying delivery can run.');
  end if;
  if v_delivery.next_attempt_at is not null and v_delivery.next_attempt_at > now() then
    perform private.refuse('warehouse_delivery_not_due', 'The delivery is not due yet.');
  end if;
  select * into v_destination from app.warehouse_destinations d where d.id = v_delivery.warehouse_destination_id;
  if v_destination.deleted_at is not null or v_destination.destination_state <> 'Active'
     or not private.warehouse_delivery_allowed(v_delivery.org_id) then
    update app.warehouse_deliveries
    set delivery_state = 'Failed', finished_at = now(), error_code = 'warehouse_destination_unavailable',
        error_message = 'The destination was paused or deleted, or the org left the Enterprise plan, before the delivery ran.'
    where id = p_delivery_id;
    return;
  end if;
  update app.warehouse_deliveries w
  set delivery_state = 'Running', attempt = w.attempt + 1, started_at = now(), next_attempt_at = null,
      snapshot_at = coalesce(w.snapshot_at, now())
  where w.id = p_delivery_id
  returning * into v_delivery;
  return query select v_delivery.id, v_delivery.org_id, v_destination.id, v_destination.provider, v_destination.bucket_name,
    v_destination.region, v_destination.endpoint_url, v_destination.path_prefix, v_delivery.file_format,
    v_delivery.include_confidential, v_delivery.attempt, v_delivery.snapshot_at;
end;
$$;

comment on function app.claim_warehouse_delivery(uuid) is 'Delivery worker: starts the next attempt of a Queued or due Retrying delivery and returns where it goes. A delivery whose destination was paused or deleted, or whose org left the Enterprise plan, is Failed instead and nothing is returned. Service role only.';

create or replace function app.warehouse_delivery_columns(p_delivery_id uuid)
returns table (
  table_key text,
  column_name text,
  ordinal integer,
  data_type text,
  classification app.data_classification,
  delivered boolean,
  withheld_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.table_key, c.column_name, c.ordinal, c.data_type, c.classification, c.delivered, c.withheld_reason
  from app.warehouse_deliveries w
  cross join lateral private.warehouse_table_columns(w.include_confidential) c
  where w.id = p_delivery_id
  order by (select t.sort_order from private.warehouse_tables t where t.table_key = c.table_key), c.ordinal;
$$;

comment on function app.warehouse_delivery_columns(uuid) is 'Delivery worker: the columns of every delivered table for one delivery, delivered or withheld with the reason. Service role only.';

create or replace function app.warehouse_table_rows(p_delivery_id uuid, p_table_key text, p_after uuid, p_limit integer)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_delivery app.warehouse_deliveries;
  v_table text;
  v_columns text;
begin
  select * into v_delivery from app.warehouse_deliveries w where w.id = p_delivery_id;
  if v_delivery.id is null or v_delivery.delivery_state <> 'Running' then
    perform private.refuse('warehouse_delivery_not_running', 'Rows are read only for a running delivery.');
  end if;
  select t.table_name into v_table from private.warehouse_tables t where t.table_key = p_table_key;
  if v_table is null then
    perform private.refuse('warehouse_table_unknown', 'The table is not part of the warehouse schema.');
  end if;
  select string_agg(format('t.%I', c.column_name), ', ' order by c.ordinal) into v_columns
  from private.warehouse_table_columns(v_delivery.include_confidential) c
  where c.table_key = p_table_key and c.delivered;
  return query execute format(
    'select to_jsonb(x) from (select %s from %s t where t.org_id = $1 and t.deleted_at is null and t.created_at <= $2 and ($3::uuid is null or t.id > $3) order by t.id limit $4) x',
    v_columns, v_table)
  using v_delivery.org_id, v_delivery.snapshot_at, p_after, least(greatest(coalesce(p_limit, 1000), 1), 5000);
end;
$$;

comment on function app.warehouse_table_rows(uuid, text, uuid, integer) is 'Delivery worker: one page of a running delivery''s table, ordered by id after p_after: the org''s own live rows created by the snapshot time, delivered columns only (never Restricted or encrypted, Confidential only when included). Service role only.';

create or replace function app.record_warehouse_delivery_file(
  p_delivery_id uuid,
  p_table_key text,
  p_object_key text,
  p_row_count bigint,
  p_byte_count bigint,
  p_sha256 text,
  p_columns_delivered smallint,
  p_columns_withheld smallint
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
  if not exists (select 1 from app.warehouse_deliveries w where w.id = p_delivery_id and w.delivery_state = 'Running') then
    perform private.refuse('warehouse_delivery_not_running', 'Files are recorded only for a running delivery.');
  end if;
  insert into app.warehouse_delivery_files (warehouse_delivery_id, table_key, object_key, row_count, byte_count, sha256, columns_delivered, columns_withheld)
  values (p_delivery_id, p_table_key, p_object_key, p_row_count, p_byte_count, p_sha256, p_columns_delivered, p_columns_withheld)
  on conflict (warehouse_delivery_id, object_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.record_warehouse_delivery_file(uuid, text, text, bigint, bigint, text, smallint, smallint) is 'Delivery worker: records one file a running delivery wrote. A retried attempt that writes the same object again keeps the first record. Service role only.';

create or replace function app.complete_warehouse_delivery(p_delivery_id uuid, p_object_prefix text, p_schema_version text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_delivery app.warehouse_deliveries;
begin
  update app.warehouse_deliveries w
  set delivery_state = 'Delivered', finished_at = now(), object_prefix = left(p_object_prefix, 400),
      schema_version = left(p_schema_version, 40), error_code = null, error_message = null,
      tables_delivered = (select count(distinct f.table_key) from app.warehouse_delivery_files f where f.warehouse_delivery_id = w.id),
      rows_delivered = (select coalesce(sum(f.row_count), 0) from app.warehouse_delivery_files f where f.warehouse_delivery_id = w.id),
      bytes_delivered = (select coalesce(sum(f.byte_count), 0) from app.warehouse_delivery_files f where f.warehouse_delivery_id = w.id),
      columns_withheld = (select coalesce(sum(x.columns_withheld), 0) from (select distinct on (f.table_key) f.columns_withheld
                          from app.warehouse_delivery_files f where f.warehouse_delivery_id = w.id order by f.table_key) x)
  where w.id = p_delivery_id and w.delivery_state = 'Running'
  returning * into v_delivery;
  if v_delivery.id is null then
    perform private.refuse('warehouse_delivery_not_running', 'Only a running delivery can be completed.');
  end if;
  perform private.begin_trusted_operation('warehouse_delivery');
  update app.warehouse_destinations
  set last_delivered_at = now(), last_error_code = null, last_error_message = null
  where id = v_delivery.warehouse_destination_id;
  perform private.end_trusted_operation('warehouse_delivery');
  perform private.emit_event(v_delivery.org_id, 'warehouse_delivery.finished', 'warehouse_deliveries', v_delivery.id, null,
    jsonb_build_object('delivery_state', 'Delivered', 'tables_delivered', v_delivery.tables_delivered,
      'rows_delivered', v_delivery.rows_delivered, 'columns_withheld', v_delivery.columns_withheld));
end;
$$;

comment on function app.complete_warehouse_delivery(uuid, text, text) is 'Delivery worker: marks a running delivery Delivered with the totals of its recorded files, stamps the destination and emits warehouse_delivery.finished. Service role only.';

create or replace function app.fail_warehouse_delivery(p_delivery_id uuid, p_error_code text, p_error_message text, p_retryable boolean)
returns app.warehouse_delivery_state
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_delivery app.warehouse_deliveries;
  v_due timestamptz;
  v_state app.warehouse_delivery_state;
begin
  select * into v_delivery from app.warehouse_deliveries w where w.id = p_delivery_id for update;
  if v_delivery.id is null or v_delivery.delivery_state <> 'Running' then
    perform private.refuse('warehouse_delivery_not_running', 'Only a running delivery can fail.');
  end if;
  if p_retryable and v_delivery.attempt < v_delivery.max_attempts then
    v_due := now() + private.integration_backoff(v_delivery.attempt);
    update app.warehouse_deliveries
    set delivery_state = 'Retrying', next_attempt_at = v_due, error_code = left(p_error_code, 100), error_message = left(p_error_message, 2000)
    where id = p_delivery_id;
    perform private.enqueue_job(v_delivery.org_id, 'warehouse.deliver', p_delivery_id, v_due);
    v_state := 'Retrying';
  else
    update app.warehouse_deliveries
    set delivery_state = 'Failed', finished_at = now(), error_code = left(p_error_code, 100), error_message = left(p_error_message, 2000)
    where id = p_delivery_id;
    perform private.emit_event(v_delivery.org_id, 'warehouse_delivery.finished', 'warehouse_deliveries', p_delivery_id, null,
      jsonb_build_object('delivery_state', 'Failed', 'error_code', left(p_error_code, 100)));
    v_state := 'Failed';
  end if;
  perform private.begin_trusted_operation('warehouse_delivery');
  update app.warehouse_destinations
  set last_error_code = left(p_error_code, 100), last_error_message = left(p_error_message, 2000)
  where id = v_delivery.warehouse_destination_id;
  perform private.end_trusted_operation('warehouse_delivery');
  return v_state;
end;
$$;

comment on function app.fail_warehouse_delivery(uuid, text, text, boolean) is 'Delivery worker: records a failed attempt. A retryable failure with attempts left moves the delivery to Retrying after private.integration_backoff; otherwise it is Failed and warehouse_delivery.finished is emitted. The destination shows the last error. Service role only.';

select cron.schedule('xos_queue_due_warehouse_deliveries', '7 * * * *', 'select app.queue_due_warehouse_deliveries()');

-- Privileges --------------------------------------------------------------------------------------------------------

revoke all on function app.warehouse_published_schema() from public, anon;
grant execute on function app.warehouse_published_schema() to authenticated, service_role;
revoke all on function app.store_warehouse_credential(uuid, text) from public, anon;
grant execute on function app.store_warehouse_credential(uuid, text) to authenticated, service_role;
revoke all on function app.read_warehouse_credential(uuid) from public, anon, authenticated;
grant execute on function app.read_warehouse_credential(uuid) to service_role;
revoke all on function app.request_warehouse_delivery(uuid) from public, anon;
grant execute on function app.request_warehouse_delivery(uuid) to authenticated, service_role;
revoke all on function app.queue_due_warehouse_deliveries() from public, anon, authenticated;
grant execute on function app.queue_due_warehouse_deliveries() to service_role;
revoke all on function app.claim_warehouse_delivery(uuid) from public, anon, authenticated;
grant execute on function app.claim_warehouse_delivery(uuid) to service_role;
revoke all on function app.warehouse_delivery_columns(uuid) from public, anon, authenticated;
grant execute on function app.warehouse_delivery_columns(uuid) to service_role;
revoke all on function app.warehouse_table_rows(uuid, text, uuid, integer) from public, anon, authenticated;
grant execute on function app.warehouse_table_rows(uuid, text, uuid, integer) to service_role;
revoke all on function app.record_warehouse_delivery_file(uuid, text, text, bigint, bigint, text, smallint, smallint) from public, anon, authenticated;
grant execute on function app.record_warehouse_delivery_file(uuid, text, text, bigint, bigint, text, smallint, smallint) to service_role;
revoke all on function app.complete_warehouse_delivery(uuid, text, text) from public, anon, authenticated;
grant execute on function app.complete_warehouse_delivery(uuid, text, text) to service_role;
revoke all on function app.fail_warehouse_delivery(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function app.fail_warehouse_delivery(uuid, text, text, boolean) to service_role;
