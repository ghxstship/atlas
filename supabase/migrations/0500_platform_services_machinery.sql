-- 0500_platform_services_machinery.sql
-- A18 Platform Services (ADR 0004 range 0500 to 0599). Machinery the platform service tables reuse:
--   * monthly partitions (Section 5.1): a registry of partitioned tables, partition creation ahead of
--     time and detachment of partitions past their retention, run nightly by pg_cron
--   * retention (Section 7.1, Section 14.3, ADR 0002): one retention policy per table, legal holds
--     that suspend purge for an org, and the purge job that enforces both
--   * personal data redaction (Section 7.5 invariant 23): a redactor that walks JSON at every depth
--
-- Partitions live in the private schema: rows are read and written through the partitioned parent in
-- app, whose policies apply; a partition itself grants nothing to anyone.

-- Append-only ledgers end at their retention ----------------------------------------------------------
-- A ledger is append-only until its retention period ends. Only the purge job, marked by the
-- retention_purge trusted operation, may then delete its rows. Updates stay refused.

create or replace function private.refuse_ledger_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and private.in_trusted_operation('retention_purge') then
    return old;
  end if;
  perform private.refuse('append_only', format('%s is an append-only ledger.', tg_table_name));
  return null;
end;
$$;

comment on function private.refuse_ledger_change() is 'Before update or delete trigger on append-only ledgers: refuses the change, except deletes by the retention purge job once a row is past its retention period.';

-- Retention policies ------------------------------------------------------------------------------------

create type app.retention_basis as enum ('Soft Deleted', 'Age');
comment on type app.retention_basis is 'What starts a row''s retention clock: its soft delete time, or the age of the time column.';

create type app.purge_method as enum ('Delete', 'Drop Partition', 'Account Lifecycle');
comment on type app.purge_method is 'How expired rows leave: row deletes by the purge job, detaching whole monthly partitions, or the account lifecycle (Section 14.7) for identity roots.';

create table private.retention_policies (
  table_name text primary key,
  basis app.retention_basis not null,
  time_column text not null,
  retention interval not null,
  purge_method app.purge_method not null,
  redact_personal_data_after interval,
  rationale text not null,
  constraint retention_policies_table_format check (table_name ~ '^app\.[a-z][a-z0-9_]*$'),
  constraint retention_policies_retention_positive check (retention > interval '0'),
  constraint retention_policies_redaction_before_purge check (
    redact_personal_data_after is null or redact_personal_data_after < retention),
  constraint retention_policies_soft_delete_column check (basis <> 'Soft Deleted' or time_column = 'deleted_at'),
  constraint retention_policies_rationale_length check (char_length(btrim(rationale)) between 1 and 300)
);

comment on table private.retention_policies is 'One retention policy per app table (ADR 0002, Section 14.3). The purge job enforces it nightly; an active legal hold on an org suspends it for that org.';
comment on column private.retention_policies.table_name is 'Schema-qualified app table the policy governs.';
comment on column private.retention_policies.basis is 'Soft Deleted: rows count from deleted_at and only soft-deleted rows expire. Age: every row expires once time_column is older than the retention.';
comment on column private.retention_policies.time_column is 'Column whose time starts the retention clock.';
comment on column private.retention_policies.retention is 'How long a row is kept after its clock starts.';
comment on column private.retention_policies.purge_method is 'How expired rows leave the table.';
comment on column private.retention_policies.redact_personal_data_after is 'For ledgers that keep personal data in plaintext: when that data is redacted (Section 7.5 invariant 23). Null when the table needs no redaction.';
comment on column private.retention_policies.rationale is 'Why the period was chosen: the legal or operational basis.';

alter table private.retention_policies enable row level security;
revoke all on private.retention_policies from public, anon, authenticated;
grant select on private.retention_policies to service_role;

create or replace function private.guard_retention_policy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if to_regclass(new.table_name) is null then
    perform private.refuse('retention_table_unknown', format('%s is not a table.', new.table_name));
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = to_regclass(new.table_name) and a.attname = new.time_column and not a.attisdropped
  ) then
    perform private.refuse('retention_column_unknown', format('%s has no column %s.', new.table_name, new.time_column));
  end if;
  if new.purge_method = 'Drop Partition' and new.table_name not in (select p.table_name from private.partitioned_tables p) then
    perform private.refuse('retention_not_partitioned', format('%s is not a registered partitioned table.', new.table_name));
  end if;
  return new;
end;
$$;

comment on function private.guard_retention_policy() is 'Retention policies name an existing table and time column; partition drops apply only to registered partitioned tables.';

create view app.retention_policies as
select r.table_name, r.basis, r.time_column, r.retention, r.purge_method, r.redact_personal_data_after, r.rationale
from private.retention_policies r;

comment on view app.retention_policies is 'Retention period of every app table, for the Data Retention and Deletion Policy page and the data and privacy settings.';
comment on column app.retention_policies.table_name is 'Table the policy governs.';
comment on column app.retention_policies.basis is 'What starts the retention clock.';
comment on column app.retention_policies.time_column is 'Column that starts the clock.';
comment on column app.retention_policies.retention is 'How long rows are kept.';
comment on column app.retention_policies.purge_method is 'How expired rows leave.';
comment on column app.retention_policies.redact_personal_data_after is 'When personal data in the table is redacted, if ever.';
comment on column app.retention_policies.rationale is 'Why the period was chosen.';

revoke all on app.retention_policies from public, anon;
grant select on app.retention_policies to authenticated, service_role;

-- Partition registry -------------------------------------------------------------------------------------

create table private.partitioned_tables (
  table_name text primary key,
  partition_column text not null,
  premake_months smallint not null default 3,
  maintenance_order smallint not null,
  constraint partitioned_tables_table_format check (table_name ~ '^app\.[a-z][a-z0-9_]*$'),
  constraint partitioned_tables_premake_range check (premake_months between 1 and 24),
  constraint partitioned_tables_order_key unique (maintenance_order)
);

comment on table private.partitioned_tables is 'Tables partitioned by month (Section 5.1). The nightly maintenance job creates partitions ahead of time and detaches those past retention.';
comment on column private.partitioned_tables.table_name is 'Schema-qualified partitioned parent.';
comment on column private.partitioned_tables.partition_column is 'timestamptz column the table is partitioned on, by calendar month in UTC.';
comment on column private.partitioned_tables.premake_months is 'How many future months always have a partition ready.';
comment on column private.partitioned_tables.maintenance_order is 'Order of expiry: tables whose rows reference another partitioned table expire first.';

alter table private.partitioned_tables enable row level security;
revoke all on private.partitioned_tables from public, anon, authenticated;
grant select on private.partitioned_tables to service_role;

create trigger t40_guard_retention_policy before insert or update on private.retention_policies
  for each row execute function private.guard_retention_policy();

create table private.held_partitions (
  partition_name text primary key,
  parent_table text not null references private.partitioned_tables (table_name),
  detached_at timestamptz not null default now()
);

create index held_partitions_parent_table_idx on private.held_partitions (parent_table);

comment on table private.held_partitions is 'Partitions past retention that were detached but kept because an org with rows in them is under legal hold. Rows of orgs without a hold are deleted at once; the table is dropped when no held rows remain.';
comment on column private.held_partitions.partition_name is 'Schema-qualified detached partition.';
comment on column private.held_partitions.parent_table is 'Partitioned table it was detached from.';
comment on column private.held_partitions.detached_at is 'When it was detached.';

alter table private.held_partitions enable row level security;
revoke all on private.held_partitions from public, anon, authenticated;
grant select on private.held_partitions to service_role;

create or replace function private.partition_name(p_table text, p_month date)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'private.' || split_part(p_table, '.', 2) || '_p' || to_char(p_month, 'YYYYMM');
$$;

comment on function private.partition_name(text, date) is 'Name of the monthly partition of a table for the month starting on p_month, in the private schema.';

create or replace function private.create_month_partition(p_table text, p_month date)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_name text := private.partition_name(p_table, date_trunc('month', p_month)::date);
  v_col record;
begin
  if to_regclass(v_name) is not null then
    return v_name;
  end if;
  execute format('create table %s partition of %s for values from (%L) to (%L)',
    v_name, p_table, (v_month::timestamp at time zone 'UTC'), ((v_month + interval '1 month')::timestamp at time zone 'UTC'));
  execute format('alter table %s enable row level security', v_name);
  execute format('revoke all on %s from public, anon, authenticated', v_name);
  execute format('comment on table %s is %L', v_name,
    format('Monthly partition of %s for %s. Read and written only through the parent.', p_table, to_char(v_month, 'YYYY-MM')));
  for v_col in
    select a.attname, col_description(a.attrelid, a.attnum) as description
    from pg_catalog.pg_attribute a
    where a.attrelid = p_table::regclass and a.attnum > 0 and not a.attisdropped
  loop
    execute format('comment on column %s.%I is %L', v_name, v_col.attname, v_col.description);
  end loop;
  return v_name;
end;
$$;

comment on function private.create_month_partition(text, date) is 'Creates the monthly partition of a registered table for the month containing p_month, with row level security on, no privileges, and the parent''s comments.';

create or replace function private.ensure_partitions(p_table text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_premake smallint := (select p.premake_months from private.partitioned_tables p where p.table_name = p_table);
  v_month date := (date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date;
  v_created integer := 0;
begin
  if v_premake is null then
    perform private.refuse('partition_table_unknown', format('%s is not a registered partitioned table.', p_table));
  end if;
  while v_month <= (date_trunc('month', now() at time zone 'UTC') + make_interval(months => v_premake))::date loop
    if to_regclass(private.partition_name(p_table, v_month)) is null then
      perform private.create_month_partition(p_table, v_month);
      v_created := v_created + 1;
    end if;
    v_month := (v_month + interval '1 month')::date;
  end loop;
  return v_created;
end;
$$;

comment on function private.ensure_partitions(text) is 'Makes sure a registered table has partitions from last month through its premake horizon. Returns how many it created.';

-- Legal holds ------------------------------------------------------------------------------------------

create table app.legal_holds (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  table_name text,
  matter text not null,
  placed_at timestamptz not null default now(),
  released_at timestamptz,
  constraint legal_holds_table_format check (table_name is null or table_name ~ '^app\.[a-z][a-z0-9_]*$'),
  constraint legal_holds_matter_length check (char_length(btrim(matter)) between 1 and 300),
  constraint legal_holds_release_after_place check (released_at is null or released_at >= placed_at)
);

call private.install_domain_table('app.legal_holds');
create index legal_holds_active_idx on app.legal_holds (org_id, table_name) where released_at is null and deleted_at is null;
call private.describe('app.legal_holds', 'Legal holds (Section 14.3): while a hold is active, the purge job keeps the org''s rows in the held table, or in every table when no table is named, past their retention.', array[
  'table_name', 'Table the hold covers, or null for every table of the org.',
  'matter', 'Matter or request the hold preserves data for.',
  'placed_at', 'When the hold took effect. Set by the database.',
  'released_at', 'When the hold was released. Purge resumes for the org afterwards.'
]);

create or replace function private.guard_legal_hold()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.placed_at := now();
    new.released_at := null;
    if new.table_name is not null and new.table_name not in (select r.table_name from private.retention_policies r) then
      perform private.refuse('legal_hold_table_unknown', format('%s has no retention policy to hold.', new.table_name));
    end if;
    return new;
  end if;
  if new.table_name is distinct from old.table_name or new.matter <> old.matter or new.placed_at <> old.placed_at
     or new.deleted_at is distinct from old.deleted_at then
    perform private.refuse('legal_hold_immutable', 'A legal hold is released, never edited or deleted.');
  end if;
  if old.released_at is not null then
    perform private.refuse('legal_hold_released', 'A released legal hold stays released; place a new hold.');
  end if;
  if new.released_at is not null then
    new.released_at := now();
  end if;
  return new;
end;
$$;

comment on function private.guard_legal_hold() is 'Legal holds: the database sets the placement and release times; a hold covers a table with a retention policy, is never edited or deleted, and is released once.';

create trigger t40_guard_legal_hold before insert or update on app.legal_holds
  for each row execute function private.guard_legal_hold();

call private.install_policies('app.legal_holds',
  $$org_id in (select private.orgs_with_capability('data.legal_hold.manage'))$$,
  $$org_id in (select private.orgs_with_capability('data.legal_hold.manage'))$$);

create or replace function private.held_org_ids(p_table text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct h.org_id from app.legal_holds h
  where h.released_at is null and h.deleted_at is null and (h.table_name is null or h.table_name = p_table);
$$;

comment on function private.held_org_ids(text) is 'Orgs whose rows in a table are under an active legal hold.';

-- Purge runs -------------------------------------------------------------------------------------------

create table private.retention_runs (
  id uuid primary key default private.uuid_v7(),
  table_name text not null,
  action text not null,
  rows_affected bigint not null default 0,
  error_message text,
  ran_at timestamptz not null default now(),
  constraint retention_runs_action check (action in ('purge', 'detach', 'drop', 'hold', 'redact'))
);

create index retention_runs_table_ran_idx on private.retention_runs (table_name, ran_at);

comment on table private.retention_runs is 'Outcome of every purge, partition expiry and redaction step, including refusals, so no failure is silent. Reliability alerts read it.';
comment on column private.retention_runs.id is 'Run step id.';
comment on column private.retention_runs.table_name is 'Table or partition the step acted on.';
comment on column private.retention_runs.action is 'purge (row deletes), detach, drop, hold (partition kept for a legal hold) or redact.';
comment on column private.retention_runs.rows_affected is 'Rows deleted, redacted or kept.';
comment on column private.retention_runs.error_message is 'Error that stopped the step, or null when it succeeded. The step retries on the next run.';
comment on column private.retention_runs.ran_at is 'When the step ran.';

alter table private.retention_runs enable row level security;
revoke all on private.retention_runs from public, anon, authenticated;
grant select on private.retention_runs to service_role;

-- Purge by row ---------------------------------------------------------------------------------------------
-- Tables are purged children first: a pass deletes what it can, and a row still referenced by a younger
-- row stays until that row expires. Each table runs in its own subtransaction and records its outcome.

create or replace function private.purge_table(p_table text, p_batch integer default 10000)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_policy private.retention_policies;
  v_has_org boolean;
  v_sql text;
  v_id uuid;
  v_count bigint := 0;
  v_blocked bigint := 0;
  v_error text;
begin
  select * into v_policy from private.retention_policies r where r.table_name = p_table;
  if v_policy.table_name is null or v_policy.purge_method <> 'Delete' then
    return 0;
  end if;
  v_has_org := exists (
    select 1 from pg_catalog.pg_attribute a where a.attrelid = p_table::regclass and a.attname = 'org_id' and not a.attisdropped);
  v_sql := format('select t.id from %s t where t.%I < now() - $1', p_table, v_policy.time_column);
  if v_policy.basis = 'Soft Deleted' then
    v_sql := v_sql || ' and t.deleted_at is not null';
  end if;
  if v_has_org then
    v_sql := v_sql || ' and t.org_id not in (select private.held_org_ids($2))';
  end if;
  v_sql := v_sql || ' order by t.id limit $3';
  perform private.begin_trusted_operation('retention_purge');
  for v_id in execute v_sql using v_policy.retention, p_table, p_batch loop
    begin
      execute format('delete from %s where id = $1', p_table) using v_id;
      v_count := v_count + 1;
    exception when others then
      v_blocked := v_blocked + 1;
      v_error := sqlerrm;
    end;
  end loop;
  perform private.end_trusted_operation('retention_purge');
  insert into private.retention_runs (table_name, action, rows_affected, error_message)
  values (p_table, 'purge', v_count,
    case when v_blocked > 0 then format('%s expired rows kept: %s', v_blocked, v_error) end);
  return v_count;
end;
$$;

comment on function private.purge_table(text, integer) is 'Deletes up to p_batch rows of a table past retention, one row per subtransaction, skipping orgs under legal hold. A row that cannot go yet (still referenced by a younger row) is kept, counted and recorded in private.retention_runs, and retried on the next run.';

create or replace function private.purge_expired_rows()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_total bigint := 0;
  v_pass bigint;
  i integer;
begin
  for i in 1..3 loop
    v_pass := 0;
    for v_table in
      select r.table_name from private.retention_policies r where r.purge_method = 'Delete' order by r.table_name
    loop
      v_pass := v_pass + private.purge_table(v_table);
    end loop;
    v_total := v_total + v_pass;
    exit when v_pass = 0;
  end loop;
  return v_total;
end;
$$;

comment on function private.purge_expired_rows() is 'Runs the row purge over every Delete policy, up to three passes so children purged in one pass free their parents in the next. Returns the rows deleted.';

-- Partition expiry -----------------------------------------------------------------------------------------

create or replace function private.settle_held_partition(p_partition text, p_parent text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
  v_left bigint;
begin
  execute format('delete from %s where org_id not in (select private.held_org_ids($1))', p_partition)
    using p_parent;
  get diagnostics v_deleted = row_count;
  execute format('select count(*) from %s', p_partition) into v_left;
  if v_left = 0 then
    execute format('drop table %s', p_partition);
    delete from private.held_partitions where partition_name = p_partition;
    insert into private.retention_runs (table_name, action, rows_affected) values (p_partition, 'drop', v_deleted);
  else
    insert into private.held_partitions (partition_name, parent_table) values (p_partition, p_parent)
    on conflict (partition_name) do nothing;
    insert into private.retention_runs (table_name, action, rows_affected) values (p_partition, 'hold', v_left);
  end if;
end;
$$;

comment on function private.settle_held_partition(text, text) is 'For a detached partition: deletes rows of orgs without a legal hold, then drops the table when nothing is left or keeps it as a held partition.';

create or replace function private.expire_partitions(p_table text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_retention interval := (select r.retention from private.retention_policies r
                           where r.table_name = p_table and r.purge_method = 'Drop Partition');
  v_part record;
  v_fk record;
  v_expired integer := 0;
begin
  if v_retention is null then
    return 0;
  end if;
  for v_part in
    select c.oid::regclass::text as name, to_date(right(c.relname, 6), 'YYYYMM') as month
    from pg_catalog.pg_inherits i
    join pg_catalog.pg_class c on c.oid = i.inhrelid
    where i.inhparent = p_table::regclass and c.relname ~ '_p[0-9]{6}$'
  loop
    if (v_part.month + interval '1 month')::timestamp at time zone 'UTC' <= now() - v_retention then
      begin
        execute format('alter table %s detach partition %s', p_table, v_part.name);
        for v_fk in
          select con.conname from pg_catalog.pg_constraint con
          where con.conrelid = v_part.name::regclass and con.contype = 'f'
        loop
          execute format('alter table %s drop constraint %I', v_part.name, v_fk.conname);
        end loop;
        insert into private.retention_runs (table_name, action) values (v_part.name, 'detach');
        perform private.settle_held_partition(v_part.name, p_table);
        v_expired := v_expired + 1;
      exception when others then
        insert into private.retention_runs (table_name, action, error_message) values (v_part.name, 'detach', sqlerrm);
      end;
    end if;
  end loop;
  return v_expired;
end;
$$;

comment on function private.expire_partitions(text) is 'Detaches every partition of a table whose month ended more than its retention ago, drops its foreign keys (it is now an archive), and settles it against legal holds. Records each step.';

create or replace function private.run_partition_maintenance()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_table record;
  v_held record;
begin
  for v_table in select p.table_name from private.partitioned_tables p order by p.maintenance_order loop
    perform private.ensure_partitions(v_table.table_name);
    perform private.expire_partitions(v_table.table_name);
  end loop;
  for v_held in select h.partition_name, h.parent_table from private.held_partitions h loop
    perform private.settle_held_partition(v_held.partition_name, v_held.parent_table);
  end loop;
end;
$$;

comment on function private.run_partition_maintenance() is 'Nightly partition job (Section 5.1): creates future partitions, detaches expired ones in maintenance order, and re-settles held partitions as legal holds are released.';

-- Personal data redaction (invariant 23) ----------------------------------------------------------------

create table private.personal_data_keys (
  json_key text primary key,
  constraint personal_data_keys_lowercase check (json_key = lower(json_key) and json_key ~ '^[a-z][a-z0-9_]*$')
);

comment on table private.personal_data_keys is 'JSON keys whose values are personal data wherever they appear in an audit diff or payload. The redactor replaces their values at every depth.';
comment on column private.personal_data_keys.json_key is 'Lowercase key name, compared case-insensitively.';

alter table private.personal_data_keys enable row level security;
revoke all on private.personal_data_keys from public, anon, authenticated;
grant select on private.personal_data_keys to service_role;

insert into private.personal_data_keys (json_key) values
  ('email'), ('email_address'), ('phone'), ('phone_number'), ('mobile'), ('full_name'), ('first_name'), ('last_name'),
  ('given_name'), ('family_name'), ('display_name'), ('legal_name'), ('preferred_name'),
  ('address'), ('address_line1'), ('address_line2'), ('street'), ('postal_code'), ('city'),
  ('date_of_birth'), ('birth_date'), ('ip'), ('ip_address'), ('user_agent'), ('device_name'),
  ('emergency_contact'), ('notes'), ('note'), ('comment'), ('body'), ('message'), ('subject_line'),
  ('tax_id'), ('ssn'), ('passport_number'), ('government_id'), ('bank_account'), ('routing_number'), ('iban'),
  ('medical_notes'), ('signature'), ('photo_url'), ('avatar_url'), ('location'), ('latitude'), ('longitude');

create or replace function private.redact_personal_data(p_value jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_result jsonb;
  v_key text;
  v_item jsonb;
begin
  if p_value is null then
    return null;
  end if;
  case jsonb_typeof(p_value)
    when 'object' then
      v_result := '{}'::jsonb;
      for v_key, v_item in select e.key, e.value from jsonb_each(p_value) e loop
        if lower(v_key) in (select k.json_key from private.personal_data_keys k) and jsonb_typeof(v_item) <> 'null' then
          v_result := v_result || jsonb_build_object(v_key, '[redacted]');
        else
          v_result := v_result || jsonb_build_object(v_key, private.redact_personal_data(v_item));
        end if;
      end loop;
      return v_result;
    when 'array' then
      select coalesce(jsonb_agg(private.redact_personal_data(e.value) order by e.ordinality), '[]'::jsonb)
      into v_result from jsonb_array_elements(p_value) with ordinality e;
      return v_result;
    when 'string' then
      return to_jsonb(
        regexp_replace(
          regexp_replace(p_value #>> '{}', '[^@\s"<>]+@[^@\s"<>]+\.[A-Za-z]{2,}', '[redacted]', 'g'),
          '(\+[0-9][0-9 ().-]{7,}[0-9]|\(?[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4})', '[redacted]', 'g'));
    else
      return p_value;
  end case;
end;
$$;

comment on function private.redact_personal_data(jsonb) is 'Invariant 23: returns the JSON with personal data redacted at every depth: values under personal data keys become [redacted], and email addresses and phone numbers inside any string are replaced. Structure and other values are kept.';

-- Privileges -------------------------------------------------------------------------------------------

revoke all on function private.guard_retention_policy() from public, anon, authenticated;
revoke all on function private.partition_name(text, date) from public, anon, authenticated;
revoke all on function private.create_month_partition(text, date) from public, anon, authenticated;
revoke all on function private.ensure_partitions(text) from public, anon, authenticated;
revoke all on function private.guard_legal_hold() from public, anon, authenticated;
revoke all on function private.held_org_ids(text) from public, anon, authenticated;
revoke all on function private.purge_table(text, integer) from public, anon, authenticated;
revoke all on function private.purge_expired_rows() from public, anon, authenticated;
revoke all on function private.settle_held_partition(text, text) from public, anon, authenticated;
revoke all on function private.expire_partitions(text) from public, anon, authenticated;
revoke all on function private.run_partition_maintenance() from public, anon, authenticated;
revoke all on function private.redact_personal_data(jsonb) from public, anon, authenticated;
grant execute on function private.redact_personal_data(jsonb) to service_role;
