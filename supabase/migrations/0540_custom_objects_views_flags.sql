-- 0540_custom_objects_views_flags.sql
-- A18 Platform Services. Custom objects and custom fields (Section 4.6.3, Section 7.3 Workflow engine and
-- the 1.3 additions), saved views and feature flags (Section 5 stack, Section 5.1 change safety):
--   * custom_object_types, custom_object_fields (with choices), custom_object_records,
--     custom_object_values with one typed value column per data type, and custom_object_relations;
--     no JSON documents anywhere
--   * fields marked filterable get a partial index of their own, created and dropped with the flag
--   * custom_field_definitions and custom_field_values on built-in tables, with the same typed columns
--   * plan limits read through private.org_plan_limits
--   * saved_views with normalized filters and sorts
--   * feature_flags with plan gating and a kill switch, and per-org overrides

create type app.custom_data_type as enum ('Text', 'Number', 'Money', 'Date', 'Timestamp', 'Boolean', 'Choice', 'Person', 'Email', 'URL');
comment on type app.custom_data_type is 'Data types of custom object fields and custom fields; each maps to one typed value column.';

create type app.view_type as enum ('List', 'Board', 'Table', 'Calendar', 'Timeline');
comment on type app.view_type is 'View types a collection can be shown in (Section 4.6.3, Section 11.15).';

create type app.sort_direction as enum ('Ascending', 'Descending');
comment on type app.sort_direction is 'Sort direction.';

create type app.filter_operator as enum ('eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'is_null', 'contains');
comment on type app.filter_operator is 'Filter operators, the same set as the API (ADR 0003).';

-- Shared helpers ----------------------------------------------------------------------------------------

create or replace function private.custom_writer_orgs()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select o from private.my_org_ids() o
  where private.best_band(private.current_person_id(), o) <= 5;
$$;

comment on function private.custom_writer_orgs() is 'Orgs where the signed-in person may write custom object records and custom field values: Collaborator band or higher. Field and Viewer members read only.';

create or replace function private.custom_limit(p_org_id uuid, p_limit text)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select l.limit_value from private.org_plan_limits l where l.org_id = p_org_id and l.limit_code::text = p_limit;
$$;

comment on function private.custom_limit(uuid, text) is 'Custom object limit in force for an org from private.org_plan_limits (Section 4.6.3), or null when the plan sets none (unlimited).';

create or replace function private.check_typed_value(p_type app.custom_data_type, p_row jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_expected text := case p_type
    when 'Text' then 'value_text' when 'Email' then 'value_text' when 'URL' then 'value_text'
    when 'Number' then 'value_number' when 'Money' then 'value_money_minor' when 'Date' then 'value_date'
    when 'Timestamp' then 'value_timestamp' when 'Boolean' then 'value_boolean' when 'Choice' then 'value_choice_id'
    when 'Person' then 'value_person_id' end;
  v_col text;
begin
  foreach v_col in array array['value_text', 'value_number', 'value_money_minor', 'value_date', 'value_timestamp',
                               'value_boolean', 'value_choice_id', 'value_person_id'] loop
    if v_col <> v_expected and p_row ->> v_col is not null then
      perform private.refuse('custom_value_type', format('A %s field stores its value in %s only.', p_type, v_expected));
    end if;
  end loop;
  if (p_type = 'Money') <> (p_row ->> 'value_currency' is not null) and p_row ->> 'value_money_minor' is not null then
    perform private.refuse('custom_value_currency', 'A money value carries its currency, and only money values do.');
  end if;
  if p_type = 'Email' and p_row ->> 'value_text' is not null and p_row ->> 'value_text' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform private.refuse('custom_value_email', 'The value is not an email address.');
  end if;
  if p_type = 'URL' and p_row ->> 'value_text' is not null and p_row ->> 'value_text' !~ '^https?://[^\s]+$' then
    perform private.refuse('custom_value_url', 'The value is not an http or https URL.');
  end if;
end;
$$;

comment on function private.check_typed_value(app.custom_data_type, jsonb) is 'Refuses a value row that fills any typed column other than the one its data type uses, money without its currency, or a malformed email or URL. NULL in the typed column means no value.';

-- Custom object types and fields ------------------------------------------------------------------------------

create table app.custom_object_types (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  object_key text not null,
  label text not null,
  icon text not null,
  default_view app.view_type not null default 'Table',
  constraint custom_object_types_key_format check (object_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  constraint custom_object_types_label_title_case check (label ~ '^[A-Z0-9][^\s]*( [^\s]+)*$' and char_length(label) between 1 and 100),
  constraint custom_object_types_icon_format check (icon ~ '^[a-z][a-z0-9-]{1,63}$')
);

call private.install_domain_table('app.custom_object_types');
call private.describe('app.custom_object_types', 'Org-defined entity types beyond custom fields (Section 4.6.3). Each gets list, board, table and calendar views and API routes at /api/v1/objects/{objectKey}.', array[
  'object_key', 'Lowercase key used in URLs and the API, unique per org.',
  'label', 'Title Case display name, the org''s own text.',
  'icon', 'Icon name from the XOS icon set.',
  'default_view', 'View the object opens in.'
]);

create unique index custom_object_types_org_key on app.custom_object_types (org_id, object_key) where deleted_at is null;

create or replace function private.guard_custom_object_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit bigint;
begin
  if tg_op = 'INSERT' then
    v_limit := private.custom_limit(new.org_id, 'custom_object_types');
    if v_limit is not null and (select count(*) from app.custom_object_types t where t.org_id = new.org_id and t.deleted_at is null) >= v_limit then
      perform private.refuse('plan_limit_exceeded', format('The plan allows %s custom objects.', v_limit));
    end if;
  elsif new.object_key <> old.object_key then
    perform private.refuse('custom_object_key_immutable', 'An object key is part of its API routes and never changes.');
  end if;
  return new;
end;
$$;

comment on function private.guard_custom_object_type() is 'Custom object types: the plan''s custom_object_types limit on insert, and the key never changes.';

create trigger t40_guard_custom_object_type before insert or update on app.custom_object_types
  for each row execute function private.guard_custom_object_type();

call private.install_policies('app.custom_object_types',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.custom_objects.write'))$$);
call private.install_audit_trail('app.custom_object_types');

create table app.custom_object_fields (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  custom_object_type_id uuid not null references app.custom_object_types (id),
  field_key text not null,
  label text not null,
  data_type app.custom_data_type not null,
  required boolean not null default false,
  filterable boolean not null default false,
  sort_order integer not null,
  constraint custom_object_fields_key_format check (field_key ~ '^[a-z][a-z0-9_]{0,47}$'),
  constraint custom_object_fields_label_length check (char_length(btrim(label)) between 1 and 100)
);

create index custom_object_fields_type_idx on app.custom_object_fields (custom_object_type_id, sort_order);

call private.install_domain_table('app.custom_object_fields', 'app.custom_object_types', 'custom_object_type_id');
call private.describe('app.custom_object_fields', 'Typed fields of a custom object (Section 4.6.3). A filterable field gets its own partial index on its value column.', array[
  'custom_object_type_id', 'Object the field belongs to.',
  'field_key', 'Lowercase key, unique within the object.',
  'label', 'Display label, the org''s own text.',
  'data_type', 'Data type; decides the value column.',
  'required', 'True when every record needs a value.',
  'filterable', 'True when views filter on the field; adds a partial index.',
  'sort_order', 'Position in forms and tables.'
]);

create unique index custom_object_fields_key on app.custom_object_fields (custom_object_type_id, field_key) where deleted_at is null;

call private.install_policies('app.custom_object_fields',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.custom_objects.write'))$$);
call private.install_audit_trail('app.custom_object_fields');

create table app.custom_object_field_choices (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  custom_object_field_id uuid not null references app.custom_object_fields (id),
  choice_key text not null,
  label text not null,
  sort_order integer not null,
  constraint custom_object_field_choices_key_format check (choice_key ~ '^[a-z][a-z0-9_]{0,47}$'),
  constraint custom_object_field_choices_label_length check (char_length(btrim(label)) between 1 and 100)
);

create index custom_object_field_choices_field_idx on app.custom_object_field_choices (custom_object_field_id, sort_order);

call private.install_domain_table('app.custom_object_field_choices', 'app.custom_object_fields', 'custom_object_field_id');
call private.describe('app.custom_object_field_choices', 'Allowed options of a Choice field, one row each.', array[
  'custom_object_field_id', 'Choice field.',
  'choice_key', 'Stable key, unique within the field.',
  'label', 'Display label.',
  'sort_order', 'Option order.'
]);

create unique index custom_object_field_choices_key on app.custom_object_field_choices (custom_object_field_id, choice_key) where deleted_at is null;

call private.install_policies('app.custom_object_field_choices',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.custom_objects.write'))$$);

-- Records, values and relations --------------------------------------------------------------------------------------

create table app.custom_object_records (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  custom_object_type_id uuid not null references app.custom_object_types (id),
  title text not null,
  constraint custom_object_records_title_length check (char_length(btrim(title)) between 1 and 300)
);

create index custom_object_records_type_idx on app.custom_object_records (custom_object_type_id);

call private.install_domain_table('app.custom_object_records', 'app.custom_object_types', 'custom_object_type_id');
call private.describe('app.custom_object_records', 'Records of a custom object (Section 4.6.3). Field values live in custom_object_values, one row per field.', array[
  'custom_object_type_id', 'Object the record is an instance of.',
  'title', 'Record title shown in lists and the side peek.'
]);

create or replace function private.guard_custom_object_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit bigint;
begin
  if tg_op = 'INSERT' then
    v_limit := private.custom_limit(new.org_id, 'custom_object_records');
    if v_limit is not null and (select count(*) from app.custom_object_records r where r.org_id = new.org_id and r.deleted_at is null) >= v_limit then
      perform private.refuse('plan_limit_exceeded', format('The plan allows %s custom object records.', v_limit));
    end if;
  elsif new.custom_object_type_id <> old.custom_object_type_id then
    perform private.refuse('custom_record_type_immutable', 'A record keeps its object type.');
  end if;
  return new;
end;
$$;

comment on function private.guard_custom_object_record() is 'Custom object records: the plan''s custom_object_records limit on insert, and a record never changes type.';

create trigger t40_guard_custom_object_record before insert or update on app.custom_object_records
  for each row execute function private.guard_custom_object_record();

call private.install_policies('app.custom_object_records',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.custom_writer_orgs())$$);

create table app.custom_object_values (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  custom_object_record_id uuid not null references app.custom_object_records (id),
  custom_object_field_id uuid not null references app.custom_object_fields (id),
  value_text text,
  value_number numeric,
  value_money_minor bigint,
  value_currency char(3) references private.currencies (currency_code),
  value_date date,
  value_timestamp timestamptz,
  value_boolean boolean,
  value_choice_id uuid references app.custom_object_field_choices (id),
  value_person_id uuid references app.people (id),
  constraint custom_object_values_text_length check (value_text is null or char_length(value_text) <= 10000)
);

create index custom_object_values_record_idx on app.custom_object_values (custom_object_record_id);
create index custom_object_values_field_idx on app.custom_object_values (custom_object_field_id);
create index custom_object_values_currency_idx on app.custom_object_values (value_currency);
create index custom_object_values_choice_idx on app.custom_object_values (value_choice_id);
create index custom_object_values_person_idx on app.custom_object_values (value_person_id);

call private.install_domain_table('app.custom_object_values', 'app.custom_object_records', 'custom_object_record_id',
  array['app.custom_object_fields', 'custom_object_field_id', 'app.custom_object_field_choices', 'value_choice_id']);
call private.describe('app.custom_object_values', 'One value of one field of one custom object record (Section 4.6.3), in the typed column of the field''s data type. NULL money is unpriced, never zero.', array[
  'custom_object_record_id', 'Record.',
  'custom_object_field_id', 'Field the value is for.',
  'value_text', 'Text, Email and URL values.',
  'value_number', 'Number values.',
  'value_money_minor', 'Money values in minor units of value_currency.',
  'value_currency', 'ISO 4217 currency of a money value.',
  'value_date', 'Date values.',
  'value_timestamp', 'Timestamp values.',
  'value_boolean', 'Boolean values.',
  'value_choice_id', 'Choice values: an option of the field.',
  'value_person_id', 'Person values.'
]);

create unique index custom_object_values_one_per_field on app.custom_object_values (custom_object_record_id, custom_object_field_id) where deleted_at is null;

create or replace function private.guard_custom_object_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_field app.custom_object_fields;
begin
  select * into v_field from app.custom_object_fields f where f.id = new.custom_object_field_id and f.deleted_at is null;
  if v_field.id is null or v_field.custom_object_type_id <> (select r.custom_object_type_id from app.custom_object_records r where r.id = new.custom_object_record_id) then
    perform private.refuse('custom_value_field', 'The field belongs to another object.');
  end if;
  perform private.check_typed_value(v_field.data_type, to_jsonb(new));
  if new.value_choice_id is not null and (select c.custom_object_field_id from app.custom_object_field_choices c where c.id = new.value_choice_id) <> new.custom_object_field_id then
    perform private.refuse('custom_value_choice', 'The option belongs to another field.');
  end if;
  if new.value_person_id is not null and new.org_id not in (select private.person_org_ids(new.value_person_id)) then
    perform private.refuse('custom_value_person', 'A person value names a member of the org.');
  end if;
  return new;
end;
$$;

comment on function private.guard_custom_object_value() is 'Custom object values: the field belongs to the record''s object, only the field type''s column is filled, choices belong to the field and people belong to the org.';

create trigger t40_guard_custom_object_value before insert or update on app.custom_object_values
  for each row execute function private.guard_custom_object_value();

call private.install_policies('app.custom_object_values',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.custom_writer_orgs())$$);

create table app.custom_object_relations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  from_record_id uuid not null references app.custom_object_records (id),
  relation_key text not null,
  to_custom_record_id uuid references app.custom_object_records (id),
  to_record_id uuid references app.records (id),
  to_project_id uuid references app.projects (id),
  to_counterparty_id uuid references app.counterparties (id),
  to_person_id uuid references app.people (id),
  constraint custom_object_relations_one_target check (num_nonnulls(to_custom_record_id, to_record_id, to_project_id, to_counterparty_id, to_person_id) = 1),
  constraint custom_object_relations_key_format check (relation_key ~ '^[a-z][a-z0-9_]{0,47}$'),
  constraint custom_object_relations_not_self check (to_custom_record_id is distinct from from_record_id)
);

create index custom_object_relations_from_idx on app.custom_object_relations (from_record_id, relation_key);
create index custom_object_relations_to_custom_idx on app.custom_object_relations (to_custom_record_id);
create index custom_object_relations_to_record_idx on app.custom_object_relations (to_record_id);
create index custom_object_relations_to_project_idx on app.custom_object_relations (to_project_id);
create index custom_object_relations_to_counterparty_idx on app.custom_object_relations (to_counterparty_id);
create index custom_object_relations_to_person_idx on app.custom_object_relations (to_person_id);

call private.install_domain_table('app.custom_object_relations', 'app.custom_object_records', 'from_record_id',
  array['app.custom_object_records', 'to_custom_record_id', 'app.records', 'to_record_id', 'app.projects', 'to_project_id',
        'app.counterparties', 'to_counterparty_id']);
call private.describe('app.custom_object_relations', 'Links from a custom object record to records, projects, parties, people or other custom object records (Section 4.6.3), one row per link.', array[
  'from_record_id', 'Custom object record the link starts from.',
  'relation_key', 'Name of the relation, such as sponsor or venue.',
  'to_custom_record_id', 'Linked custom object record.',
  'to_record_id', 'Linked record.',
  'to_project_id', 'Linked project.',
  'to_counterparty_id', 'Linked party (counterparty organization).',
  'to_person_id', 'Linked person.'
]);

call private.install_policies('app.custom_object_relations',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.custom_writer_orgs())$$);

-- Filterable partial indexes -------------------------------------------------------------------------------------------

create or replace function private.value_column(p_type app.custom_data_type)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type
    when 'Text' then 'value_text' when 'Email' then 'value_text' when 'URL' then 'value_text'
    when 'Number' then 'value_number' when 'Money' then 'value_money_minor' when 'Date' then 'value_date'
    when 'Timestamp' then 'value_timestamp' when 'Boolean' then 'value_boolean' when 'Choice' then 'value_choice_id'
    when 'Person' then 'value_person_id' end;
$$;

comment on function private.value_column(app.custom_data_type) is 'Typed value column a data type uses.';

create or replace function private.sync_filterable_index()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_values text := tg_argv[0];
  v_field_column text := tg_argv[1];
  v_index text := tg_argv[2] || replace(new.id::text, '-', '');
  v_wanted boolean := new.filterable and new.deleted_at is null;
begin
  if v_wanted then
    execute format('create index if not exists %I on %s (%I) where %I = %L and deleted_at is null',
      v_index, v_values, private.value_column(new.data_type), v_field_column, new.id);
  elsif tg_op = 'UPDATE' then
    execute format('drop index if exists app.%I', v_index);
  end if;
  return null;
end;
$$;

comment on function private.sync_filterable_index() is 'After insert or update trigger on field definitions: keeps one partial index on the value column for every filterable field (Section 4.6.3) and drops it when the field stops being filterable. Arguments: value table, field id column, index name prefix.';

create trigger t70_sync_filterable_index after insert or update of filterable, deleted_at, data_type on app.custom_object_fields
  for each row execute function private.sync_filterable_index('app.custom_object_values', 'custom_object_field_id', 'cov_f_');

create or replace function private.guard_custom_field_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.data_type <> old.data_type then
    perform private.refuse('custom_field_type_immutable', 'A field keeps its data type; add a new field instead.');
  end if;
  if new.field_key <> old.field_key then
    perform private.refuse('custom_field_key_immutable', 'A field keeps its key.');
  end if;
  return new;
end;
$$;

comment on function private.guard_custom_field_type() is 'Fields keep their data type and key, so stored values stay in the right column.';

create trigger t40_guard_custom_field_type before update on app.custom_object_fields
  for each row execute function private.guard_custom_field_type();

-- Custom fields on built-in tables -------------------------------------------------------------------------------------

create table private.custom_field_targets (
  table_name text primary key,
  constraint custom_field_targets_table_format check (table_name ~ '^app\.[a-z][a-z0-9_]*$')
);

comment on table private.custom_field_targets is 'Built-in tables orgs may add custom fields to.';
comment on column private.custom_field_targets.table_name is 'Schema-qualified table.';

alter table private.custom_field_targets enable row level security;
revoke all on private.custom_field_targets from public, anon, authenticated;
grant select on private.custom_field_targets to service_role;

insert into private.custom_field_targets (table_name) values
  ('app.records'), ('app.projects'), ('app.vendors'), ('app.venues'), ('app.counterparties'), ('app.asset_units'),
  ('app.purchase_orders'), ('app.invoices'), ('app.incidents');

create table app.custom_field_definitions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  target_table text not null references private.custom_field_targets (table_name),
  field_key text not null,
  label text not null,
  data_type app.custom_data_type not null,
  required boolean not null default false,
  filterable boolean not null default false,
  sort_order integer not null,
  constraint custom_field_definitions_key_format check (field_key ~ '^[a-z][a-z0-9_]{0,47}$'),
  constraint custom_field_definitions_label_length check (char_length(btrim(label)) between 1 and 100)
);

create index custom_field_definitions_target_idx on app.custom_field_definitions (target_table);

call private.install_domain_table('app.custom_field_definitions');
call private.describe('app.custom_field_definitions', 'Org-defined fields on built-in tables (Section 7.3 Workflow engine). Values live in custom_field_values with typed columns.', array[
  'target_table', 'Built-in table the field extends.',
  'field_key', 'Lowercase key, unique per org and table.',
  'label', 'Display label, the org''s own text.',
  'data_type', 'Data type; decides the value column.',
  'required', 'True when forms require a value.',
  'filterable', 'True when views filter on the field; adds a partial index.',
  'sort_order', 'Position in forms.'
]);

create unique index custom_field_definitions_key on app.custom_field_definitions (org_id, target_table, field_key) where deleted_at is null;

create trigger t40_guard_custom_field_type before update on app.custom_field_definitions
  for each row execute function private.guard_custom_field_type();

call private.install_policies('app.custom_field_definitions',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.custom_fields.write'))$$);
call private.install_audit_trail('app.custom_field_definitions');

create table app.custom_field_choices (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  custom_field_definition_id uuid not null references app.custom_field_definitions (id),
  choice_key text not null,
  label text not null,
  sort_order integer not null,
  constraint custom_field_choices_key_format check (choice_key ~ '^[a-z][a-z0-9_]{0,47}$'),
  constraint custom_field_choices_label_length check (char_length(btrim(label)) between 1 and 100)
);

create index custom_field_choices_definition_idx on app.custom_field_choices (custom_field_definition_id, sort_order);

call private.install_domain_table('app.custom_field_choices', 'app.custom_field_definitions', 'custom_field_definition_id');
call private.describe('app.custom_field_choices', 'Allowed options of a Choice custom field.', array[
  'custom_field_definition_id', 'Choice field.',
  'choice_key', 'Stable key, unique within the field.',
  'label', 'Display label.',
  'sort_order', 'Option order.'
]);

create unique index custom_field_choices_key on app.custom_field_choices (custom_field_definition_id, choice_key) where deleted_at is null;

call private.install_policies('app.custom_field_choices',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.custom_fields.write'))$$);

create table app.custom_field_values (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  custom_field_definition_id uuid not null references app.custom_field_definitions (id),
  target_id uuid not null,
  value_text text,
  value_number numeric,
  value_money_minor bigint,
  value_currency char(3) references private.currencies (currency_code),
  value_date date,
  value_timestamp timestamptz,
  value_boolean boolean,
  value_choice_id uuid references app.custom_field_choices (id),
  value_person_id uuid references app.people (id),
  constraint custom_field_values_text_length check (value_text is null or char_length(value_text) <= 10000)
);

create index custom_field_values_definition_idx on app.custom_field_values (custom_field_definition_id);
create index custom_field_values_target_idx on app.custom_field_values (target_id);
create index custom_field_values_currency_idx on app.custom_field_values (value_currency);
create index custom_field_values_choice_idx on app.custom_field_values (value_choice_id);
create index custom_field_values_person_idx on app.custom_field_values (value_person_id);

call private.install_domain_table('app.custom_field_values', 'app.custom_field_definitions', 'custom_field_definition_id',
  array['app.custom_field_choices', 'value_choice_id']);
call private.describe('app.custom_field_values', 'Value of one custom field on one row of a built-in table, in the typed column of the field''s data type. Readable only where the row itself is readable.', array[
  'custom_field_definition_id', 'Field the value is for.',
  'target_id', 'Row of the field''s target table the value belongs to.',
  'value_text', 'Text, Email and URL values.',
  'value_number', 'Number values.',
  'value_money_minor', 'Money values in minor units of value_currency.',
  'value_currency', 'ISO 4217 currency of a money value.',
  'value_date', 'Date values.',
  'value_timestamp', 'Timestamp values.',
  'value_boolean', 'Boolean values.',
  'value_choice_id', 'Choice values: an option of the field.',
  'value_person_id', 'Person values.'
]);

create unique index custom_field_values_one_per_target on app.custom_field_values (custom_field_definition_id, target_id) where deleted_at is null;

create or replace function private.custom_field_target_visible(p_definition_id uuid, p_target_id uuid)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_table text := (select d.target_table from app.custom_field_definitions d where d.id = p_definition_id);
  v_found boolean;
begin
  if v_table is null then
    return false;
  end if;
  execute format('select exists (select 1 from %s t where t.id = $1)', v_table) into v_found using p_target_id;
  return v_found;
end;
$$;

comment on function private.custom_field_target_visible(uuid, uuid) is 'True when the caller can read the row a custom field value belongs to. Runs as the caller, so the target table''s own policies decide (invariant 2); takes the ids as arguments (ADR 0016 rule 14).';

create or replace function private.guard_custom_field_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_def app.custom_field_definitions;
  v_org uuid;
begin
  select * into v_def from app.custom_field_definitions d where d.id = new.custom_field_definition_id and d.deleted_at is null;
  if v_def.id is null then
    perform private.refuse('custom_value_field', 'The field does not exist.');
  end if;
  execute format('select org_id from %s where id = $1', v_def.target_table) into v_org using new.target_id;
  if v_org is distinct from new.org_id then
    perform private.refuse('cross_org_reference', 'custom_field_values.target_id points to a row of another org.');
  end if;
  if tg_op = 'UPDATE' and new.target_id <> old.target_id then
    perform private.refuse('custom_value_target_immutable', 'A value stays on its row.');
  end if;
  perform private.check_typed_value(v_def.data_type, to_jsonb(new));
  if new.value_choice_id is not null and (select c.custom_field_definition_id from app.custom_field_choices c where c.id = new.value_choice_id) <> new.custom_field_definition_id then
    perform private.refuse('custom_value_choice', 'The option belongs to another field.');
  end if;
  if new.value_person_id is not null and new.org_id not in (select private.person_org_ids(new.value_person_id)) then
    perform private.refuse('custom_value_person', 'A person value names a member of the org.');
  end if;
  return new;
end;
$$;

comment on function private.guard_custom_field_value() is 'Custom field values: the target row exists in the same org and the value stays on it, only the field type''s column is filled, choices belong to the field and people belong to the org.';

create trigger t40_guard_custom_field_value before insert or update on app.custom_field_values
  for each row execute function private.guard_custom_field_value();

call private.install_policies('app.custom_field_values',
  $$org_id in (select private.my_org_ids()) and private.custom_field_target_visible(custom_field_definition_id, target_id)$$,
  $$org_id in (select private.custom_writer_orgs()) and private.custom_field_target_visible(custom_field_definition_id, target_id)$$);

create trigger t70_sync_filterable_index after insert or update of filterable, deleted_at, data_type on app.custom_field_definitions
  for each row execute function private.sync_filterable_index('app.custom_field_values', 'custom_field_definition_id', 'cfv_f_');

-- Saved views ---------------------------------------------------------------------------------------------------

create table app.saved_views (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  collection_key text not null,
  name text not null,
  view_type app.view_type not null,
  group_by_field text,
  search_text text,
  shared boolean not null default false,
  constraint saved_views_collection_format check (collection_key ~ '^[a-z][a-z0-9_]*(/[a-z][a-z0-9_]*)?$'),
  constraint saved_views_name_length check (char_length(btrim(name)) between 1 and 100),
  constraint saved_views_search_length check (search_text is null or char_length(search_text) <= 200)
);

create index saved_views_collection_idx on app.saved_views (org_id, collection_key);
create index saved_views_membership_idx on app.saved_views (membership_id);

call private.install_domain_table('app.saved_views', 'app.memberships', 'membership_id');
call private.describe('app.saved_views', 'A person''s saved view of a collection (Section 7.3, Section 11.15): view type, grouping and search, with filters and sorts in their own tables. Shared views are readable by the whole org.', array[
  'membership_id', 'Member who owns the view.',
  'collection_key', 'Collection the view shows, such as records or objects/sponsors.',
  'name', 'View name.',
  'view_type', 'List, Board, Table, Calendar or Timeline.',
  'group_by_field', 'Field rows are grouped by, if any.',
  'search_text', 'Saved search text.',
  'shared', 'True when every member of the org can use the view.'
]);

call private.install_policies('app.saved_views',
  $$membership_id in (select private.my_membership_ids()) or (shared and org_id in (select private.my_org_ids()))$$,
  $$membership_id in (select private.my_membership_ids())$$);

create or replace function private.my_saved_view_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select v.id from app.saved_views v
  where v.deleted_at is null and v.membership_id in (select private.my_membership_ids());
$$;

comment on function private.my_saved_view_ids() is 'Saved views the signed-in person owns.';

create or replace function private.readable_saved_view_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select v.id from app.saved_views v
  where v.deleted_at is null
    and (v.membership_id in (select private.my_membership_ids()) or (v.shared and v.org_id in (select private.my_org_ids())));
$$;

comment on function private.readable_saved_view_ids() is 'Saved views the signed-in person owns or that are shared in their orgs.';

create table app.saved_view_filters (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  saved_view_id uuid not null references app.saved_views (id),
  field text not null,
  operator app.filter_operator not null,
  value_text text,
  constraint saved_view_filters_field_format check (field ~ '^[a-z][a-z0-9_.]*$'),
  constraint saved_view_filters_value check (operator = 'is_null' or value_text is not null),
  constraint saved_view_filters_value_length check (value_text is null or char_length(value_text) <= 1000)
);

create index saved_view_filters_view_idx on app.saved_view_filters (saved_view_id);

call private.install_domain_table('app.saved_view_filters', 'app.saved_views', 'saved_view_id');
call private.describe('app.saved_view_filters', 'One filter of a saved view, in the API filter grammar (ADR 0003).', array[
  'saved_view_id', 'View.',
  'field', 'Field filtered on.',
  'operator', 'Filter operator.',
  'value_text', 'Filter value as the API receives it; null for is_null.'
]);

call private.install_policies('app.saved_view_filters',
  $$saved_view_id in (select private.readable_saved_view_ids())$$,
  $$saved_view_id in (select private.my_saved_view_ids())$$);

create table app.saved_view_sorts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  saved_view_id uuid not null references app.saved_views (id),
  field text not null,
  direction app.sort_direction not null,
  position smallint not null,
  constraint saved_view_sorts_field_format check (field ~ '^[a-z][a-z0-9_.]*$'),
  constraint saved_view_sorts_position check (position between 1 and 10)
);

create index saved_view_sorts_view_idx on app.saved_view_sorts (saved_view_id, position);

call private.install_domain_table('app.saved_view_sorts', 'app.saved_views', 'saved_view_id');
call private.describe('app.saved_view_sorts', 'One sort key of a saved view, in priority order.', array[
  'saved_view_id', 'View.',
  'field', 'Field sorted by.',
  'direction', 'Ascending or Descending.',
  'position', 'Priority, 1 first.'
]);

create unique index saved_view_sorts_position_key on app.saved_view_sorts (saved_view_id, position) where deleted_at is null;

call private.install_policies('app.saved_view_sorts',
  $$saved_view_id in (select private.readable_saved_view_ids())$$,
  $$saved_view_id in (select private.my_saved_view_ids())$$);

-- Feature flags -------------------------------------------------------------------------------------------------------

create table private.feature_flags (
  flag_key text primary key,
  description text not null,
  default_enabled boolean not null,
  required_plan_feature app.plan_feature_code,
  kill_switch boolean not null default false,
  constraint feature_flags_key_format check (flag_key ~ '^[a-z][a-z0-9_.]*$'),
  constraint feature_flags_description_length check (char_length(btrim(description)) between 1 and 300)
);

comment on table private.feature_flags is 'Database-backed feature flags (Section 5): a default, plan gating and a kill switch that turns the feature off everywhere at once (Section 5.1). Platform staff manage them with the service role.';
comment on column private.feature_flags.flag_key is 'Flag key, such as imports.google_sheets.';
comment on column private.feature_flags.description is 'What the flag turns on.';
comment on column private.feature_flags.default_enabled is 'Whether the feature is on for an org without an override.';
comment on column private.feature_flags.required_plan_feature is 'Plan feature an org needs for the flag to be on, if any.';
comment on column private.feature_flags.kill_switch is 'True turns the feature off for every org, overriding everything.';

alter table private.feature_flags enable row level security;
revoke all on private.feature_flags from public, anon, authenticated;
grant select, insert, update on private.feature_flags to service_role;

insert into private.feature_flags (flag_key, description, default_enabled, required_plan_feature) values
  ('imports.google_sheets', 'Import from a Google Sheets link through the Google Drive integration.', true, null),
  ('imports.ai_mapping', 'Let the assistant suggest column mappings when the org has AI features on.', false, null),
  ('reports.warehouse_delivery', 'Nightly Parquet delivery to the customer''s own bucket (Enterprise).', false, null),
  ('webhooks.delivery', 'Outbound webhook deliveries.', true, 'webhooks'),
  ('email.reply_by_email', 'Post replies to notification emails as comments.', true, null),
  ('custom_objects.enabled', 'Org-defined custom objects.', true, null);

create view app.feature_flags as
select f.flag_key, f.description, f.default_enabled, f.required_plan_feature, f.kill_switch from private.feature_flags f;
comment on view app.feature_flags is 'Feature flags and their defaults.';
comment on column app.feature_flags.flag_key is 'Flag key.';
comment on column app.feature_flags.description is 'What the flag turns on.';
comment on column app.feature_flags.default_enabled is 'Default for orgs without an override.';
comment on column app.feature_flags.required_plan_feature is 'Plan feature the flag needs.';
comment on column app.feature_flags.kill_switch is 'True when the feature is off everywhere.';
revoke all on app.feature_flags from public, anon;
grant select on app.feature_flags to authenticated, service_role;

create table app.feature_flag_overrides (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  flag_key text not null references private.feature_flags (flag_key),
  enabled boolean not null,
  reason text not null,
  expires_at timestamptz,
  constraint feature_flag_overrides_reason_length check (char_length(btrim(reason)) between 1 and 300)
);

create index feature_flag_overrides_flag_idx on app.feature_flag_overrides (flag_key);

call private.install_domain_table('app.feature_flag_overrides');
call private.describe('app.feature_flag_overrides', 'Per-org flag overrides set by platform staff, for progressive rollout and support. An override never beats the kill switch or the plan.', array[
  'flag_key', 'Flag overridden.',
  'enabled', 'Value for the org.',
  'reason', 'Why the override exists.',
  'expires_at', 'When the override stops applying, if ever.'
]);

create unique index feature_flag_overrides_key on app.feature_flag_overrides (org_id, flag_key) where deleted_at is null;

call private.install_policies('app.feature_flag_overrides', $$org_id in (select private.my_org_ids())$$);
call private.install_audit_trail('app.feature_flag_overrides');

create or replace function private.flag_enabled(p_org_id uuid, p_flag_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when f.flag_key is null then false
    when f.kill_switch then false
    when f.required_plan_feature is not null and not private.org_has_feature(p_org_id, f.required_plan_feature) then false
    else coalesce(
      (select o.enabled from app.feature_flag_overrides o
       where o.org_id = p_org_id and o.flag_key = f.flag_key and o.deleted_at is null and (o.expires_at is null or o.expires_at > now())),
      f.default_enabled)
  end
  from (select 1) one left join private.feature_flags f on f.flag_key = p_flag_key;
$$;

comment on function private.flag_enabled(uuid, text) is 'Whether a flag is on for an org: off under the kill switch or without the required plan feature, otherwise the unexpired override or the default. Unknown flags are off.';

create or replace function app.org_feature_flags(p_org_id uuid)
returns table (flag_key text, enabled boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select f.flag_key, private.flag_enabled(p_org_id, f.flag_key)
  from private.feature_flags f
  where private.is_member(p_org_id)
  order by f.flag_key;
$$;

comment on function app.org_feature_flags(uuid) is 'Every flag''s effective value for an org the signed-in person belongs to; nothing for anyone else.';

-- Retention -----------------------------------------------------------------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale)
select t, 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Deleted custom definitions and values are recoverable from Trash for a year.'
from unnest(array['app.custom_object_types', 'app.custom_object_fields', 'app.custom_object_field_choices', 'app.custom_object_records',
  'app.custom_object_values', 'app.custom_object_relations', 'app.custom_field_definitions', 'app.custom_field_choices',
  'app.custom_field_values']) t;

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.saved_views', 'Soft Deleted', 'deleted_at', interval '90 days', 'Delete', 'Deleted views carry no history value.'),
  ('app.saved_view_filters', 'Soft Deleted', 'deleted_at', interval '90 days', 'Delete', 'Kept as long as their view.'),
  ('app.saved_view_sorts', 'Soft Deleted', 'deleted_at', interval '90 days', 'Delete', 'Kept as long as their view.'),
  ('app.feature_flag_overrides', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Rollout history kept a year.');

-- Privileges ------------------------------------------------------------------------------------------------------

revoke all on function private.custom_writer_orgs() from public, anon;
grant execute on function private.custom_writer_orgs() to authenticated;
revoke all on function private.custom_limit(uuid, text) from public, anon, authenticated;
revoke all on function private.check_typed_value(app.custom_data_type, jsonb) from public, anon, authenticated;
revoke all on function private.guard_custom_object_type() from public, anon, authenticated;
revoke all on function private.guard_custom_object_record() from public, anon, authenticated;
revoke all on function private.guard_custom_object_value() from public, anon, authenticated;
revoke all on function private.value_column(app.custom_data_type) from public, anon, authenticated;
revoke all on function private.sync_filterable_index() from public, anon, authenticated;
revoke all on function private.guard_custom_field_type() from public, anon, authenticated;
revoke all on function private.custom_field_target_visible(uuid, uuid) from public, anon;
grant execute on function private.custom_field_target_visible(uuid, uuid) to authenticated;
revoke all on function private.guard_custom_field_value() from public, anon, authenticated;
revoke all on function private.my_saved_view_ids() from public, anon;
grant execute on function private.my_saved_view_ids() to authenticated;
revoke all on function private.readable_saved_view_ids() from public, anon;
grant execute on function private.readable_saved_view_ids() to authenticated;
revoke all on function private.flag_enabled(uuid, text) from public, anon, authenticated;
revoke all on function app.org_feature_flags(uuid) from public, anon;
grant execute on function app.org_feature_flags(uuid) to authenticated, service_role;
