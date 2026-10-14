-- 0530_imports_exports.sql
-- A18 Platform Services. The spreadsheet import wizard and exports (Section 4.6.2, Section 7.3 Import and
-- export and the 1.3 additions, Section 8.6):
--   * import targets and their fields (platform reference data)
--   * import_jobs, their confirmed column map, saved mapping profiles, import_batches and
--     import_row_results with the row states Valid, Invalid, Written, Refused and Skipped, plus per-cell
--     issues; every written row records its batch, so the batch id is on every imported row
--   * merge_reviews: fuzzy matches (pg_trgm similarity of name plus address at 0.85 or more) wait for a
--     person; nothing merges automatically
--   * undo of a whole batch within 7 days, except rows a later edit depends on, which are listed
--   * export_jobs with data loss prevention by column classification (Section 8.6)

create type app.import_source as enum ('CSV', 'XLSX', 'XLS', 'Google Sheets');
comment on type app.import_source is 'Where an import''s rows come from (Section 4.6.2 step 1).';

create type app.import_status as enum ('Uploaded', 'Detected', 'Mapped', 'Validated', 'Committing', 'Committed', 'Undone', 'Failed', 'Canceled');
comment on type app.import_status is 'Progress of an import through the wizard (a job status, ADR 0002).';

create type app.import_row_state as enum ('Valid', 'Invalid', 'Written', 'Refused', 'Skipped');
comment on type app.import_row_state is 'Import row states (Section 4.6.2 step 4, Section 7.3).';

create type app.import_write_action as enum ('Created', 'Updated', 'Merged');
comment on type app.import_write_action is 'What writing an import row did to its target.';

create type app.undo_outcome as enum ('Reverted', 'Kept');
comment on type app.undo_outcome is 'What undoing a batch did to a written row: reverted, or kept because a later edit depends on it.';

create type app.merge_decision as enum ('Pending', 'Merged', 'Kept Separate');
comment on type app.merge_decision is 'Decision on a fuzzy match. Only a person decides; Pending is the start.';

create type app.export_format as enum ('CSV', 'XLSX', 'PDF');
comment on type app.export_format is 'Export file formats (Section 4.6.4).';

create type app.export_status as enum ('Queued', 'Rendering', 'Ready', 'Failed', 'Expired');
comment on type app.export_status is 'Progress of an export (a job status, ADR 0002).';

-- Import targets -----------------------------------------------------------------------------------------

create table private.import_targets (
  code text primary key,
  target_table text not null,
  write_capability text not null references app.capabilities (code),
  fuzzy_match boolean not null,
  sort_order smallint not null unique,
  constraint import_targets_code_format check (code ~ '^[a-z][a-z_]*$'),
  constraint import_targets_table_format check (target_table ~ '^app\.[a-z][a-z0-9_]*$')
);

create index import_targets_write_capability_idx on private.import_targets (write_capability);

comment on table private.import_targets is 'Entities the import wizard writes, the table each writes to and the capability that authorizes it. Labels come from the i18n catalogs keyed by code.';
comment on column private.import_targets.code is 'Target code.';
comment on column private.import_targets.target_table is 'Table imported rows land in.';
comment on column private.import_targets.write_capability is 'Capability needed to import into, and undo imports of, the target.';
comment on column private.import_targets.fuzzy_match is 'True when rows are also matched on name plus address similarity and sent to merge review.';
comment on column private.import_targets.sort_order is 'Display order.';

insert into private.import_targets (code, target_table, write_capability, fuzzy_match, sort_order) values
  ('venues', 'app.venues', 'places.venue.write', true, 1),
  ('counterparties', 'app.counterparties', 'vendors.vendor.write', true, 2),
  ('vendor_products', 'app.vendor_products', 'vendors.vendor.write', false, 3),
  ('asset_units', 'app.asset_units', 'assets.asset.write', false, 4);

create table private.import_target_fields (
  target_code text not null references private.import_targets (code),
  field_name text not null,
  required boolean not null,
  strong_key boolean not null,
  primary key (target_code, field_name)
);

comment on table private.import_target_fields is 'Fields a column may map to per target, which are required, and which are strong keys matched exactly before any fuzzy match (Section 4.6.2 step 5).';
comment on column private.import_target_fields.target_code is 'Target.';
comment on column private.import_target_fields.field_name is 'Target field, a column of the target table or a resolved name such as counterparty name.';
comment on column private.import_target_fields.required is 'True when a row without it is Invalid.';
comment on column private.import_target_fields.strong_key is 'True for exact-match keys such as an asset tag or vendor SKU.';

insert into private.import_target_fields (target_code, field_name, required, strong_key) values
  ('venues', 'name', true, false),
  ('venues', 'street_address', false, false),
  ('venues', 'locality', false, false),
  ('venues', 'postal_code', false, false),
  ('venues', 'jurisdiction_id', true, false),
  ('venues', 'time_zone', true, false),
  ('counterparties', 'name', true, false),
  ('counterparties', 'counterparty_type', true, false),
  ('vendor_products', 'vendor_sku', true, true),
  ('vendor_products', 'element_id', false, false),
  ('vendor_products', 'unit_price_minor', false, false),
  ('vendor_products', 'currency_code', false, false),
  ('vendor_products', 'lead_time_days', false, false),
  ('asset_units', 'asset_tag', true, true),
  ('asset_units', 'asset_class_id', true, false),
  ('asset_units', 'home_venue_id', false, false);

alter table private.import_targets enable row level security;
alter table private.import_target_fields enable row level security;
revoke all on private.import_targets, private.import_target_fields from public, anon, authenticated;
grant select on private.import_targets, private.import_target_fields to service_role;

create view app.import_targets as
select t.code, t.write_capability, t.fuzzy_match, t.sort_order from private.import_targets t;
comment on view app.import_targets is 'Entities the import wizard can write.';
comment on column app.import_targets.code is 'Target code.';
comment on column app.import_targets.write_capability is 'Capability needed to import into it.';
comment on column app.import_targets.fuzzy_match is 'True when fuzzy matches go to merge review.';
comment on column app.import_targets.sort_order is 'Display order.';

create view app.import_target_fields as
select f.target_code, f.field_name, f.required, f.strong_key from private.import_target_fields f;
comment on view app.import_target_fields is 'Fields columns may map to, per target.';
comment on column app.import_target_fields.target_code is 'Target.';
comment on column app.import_target_fields.field_name is 'Field.';
comment on column app.import_target_fields.required is 'Required.';
comment on column app.import_target_fields.strong_key is 'Strong key.';

revoke all on app.import_targets, app.import_target_fields from public, anon;
grant select on app.import_targets, app.import_target_fields to authenticated, service_role;

create or replace function private.import_target_orgs(p_target_code text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.orgs_with_capability(t.write_capability) from private.import_targets t where t.code = p_target_code;
$$;

comment on function private.import_target_orgs(text) is 'Orgs where the signed-in person may import into a target: they hold its write capability org-wide.';

-- Mapping profiles ------------------------------------------------------------------------------------------

create table app.import_mapping_profiles (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  target_code text not null references private.import_targets (code),
  name text not null,
  constraint import_mapping_profiles_name_length check (char_length(btrim(name)) between 1 and 100)
);

create index import_mapping_profiles_target_code_idx on app.import_mapping_profiles (target_code);

call private.install_domain_table('app.import_mapping_profiles');
call private.describe('app.import_mapping_profiles', 'Saved column maps that make a repeat import one click (Section 4.6.2).', array[
  'target_code', 'Target the profile maps onto.',
  'name', 'Profile name, such as Crew roster from payroll export.'
]);

call private.install_policies('app.import_mapping_profiles',
  $$org_id in (select private.import_target_orgs(target_code))$$,
  $$org_id in (select private.import_target_orgs(target_code))$$);

create table app.import_mapping_profile_fields (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  import_mapping_profile_id uuid not null references app.import_mapping_profiles (id),
  source_header text not null,
  field_name text not null,
  constraint import_mapping_profile_fields_header_length check (char_length(btrim(source_header)) between 1 and 200)
);

create index import_mapping_profile_fields_profile_idx on app.import_mapping_profile_fields (import_mapping_profile_id);

call private.install_domain_table('app.import_mapping_profile_fields', 'app.import_mapping_profiles', 'import_mapping_profile_id');
call private.describe('app.import_mapping_profile_fields', 'One header-to-field pair of a saved mapping profile.', array[
  'import_mapping_profile_id', 'Profile.',
  'source_header', 'Spreadsheet header text, matched case-insensitively.',
  'field_name', 'Target field the header maps to.'
]);

create unique index import_mapping_profile_fields_unique on app.import_mapping_profile_fields (import_mapping_profile_id, lower(source_header)) where deleted_at is null;

create or replace function private.guard_import_field()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target text := tg_argv[0];
  v_code text;
begin
  execute format('select target_code from %s where id = $1', v_target)
    into v_code using (to_jsonb(new) ->> tg_argv[1])::uuid;
  if new.field_name is not null and not exists (
    select 1 from private.import_target_fields f where f.target_code = v_code and f.field_name = new.field_name) then
    perform private.refuse('import_field_unknown', format('%s is not a field of the %s target.', new.field_name, v_code));
  end if;
  return new;
end;
$$;

comment on function private.guard_import_field() is 'A mapped field must be a field of the import''s target. Arguments: parent table and parent id column.';

create trigger t40_guard_import_field before insert or update on app.import_mapping_profile_fields
  for each row execute function private.guard_import_field('app.import_mapping_profiles', 'import_mapping_profile_id');


create or replace function private.readable_import_profile_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from app.import_mapping_profiles p
  where p.deleted_at is null and p.org_id in (select private.import_target_orgs(p.target_code));
$$;

comment on function private.readable_import_profile_ids() is 'Mapping profiles the signed-in person may use: those of targets they may import into.';

call private.install_policies('app.import_mapping_profile_fields',
  $$import_mapping_profile_id in (select private.readable_import_profile_ids())$$,
  $$import_mapping_profile_id in (select private.readable_import_profile_ids())$$);

-- Import jobs ------------------------------------------------------------------------------------------------

create table app.import_jobs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  target_code text not null references private.import_targets (code),
  source app.import_source not null,
  original_filename text not null,
  storage_object_path text not null,
  import_mapping_profile_id uuid references app.import_mapping_profiles (id),
  import_status app.import_status not null default 'Uploaded',
  mapping_confirmed_at timestamptz,
  constraint import_jobs_filename_length check (char_length(btrim(original_filename)) between 1 and 255),
  constraint import_jobs_path_length check (char_length(storage_object_path) between 1 and 1024)
);

create index import_jobs_target_code_idx on app.import_jobs (target_code);
create index import_jobs_profile_idx on app.import_jobs (import_mapping_profile_id);

call private.install_domain_table('app.import_jobs', null, null, array['app.import_mapping_profiles', 'import_mapping_profile_id']);
call private.describe('app.import_jobs', 'One run of the import wizard (Section 4.6.2): the uploaded file, its target, the confirmed column map and its progress.', array[
  'target_code', 'Target entity the rows are written to.',
  'source', 'CSV, XLSX, XLS or a Google Sheets link.',
  'original_filename', 'File name as uploaded.',
  'storage_object_path', 'Object path of the uploaded file in the tenant import bucket.',
  'import_mapping_profile_id', 'Saved profile the map started from, if any.',
  'import_status', 'Wizard progress.',
  'mapping_confirmed_at', 'When the person confirmed every column mapping; nothing is validated before it.'
]);

create or replace function private.guard_import_job()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.current_person_id() is null or private.in_trusted_operation('import_undo') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.import_status := 'Uploaded';
    new.mapping_confirmed_at := null;
    return new;
  end if;
  if new.import_status is distinct from old.import_status and not (new.import_status = 'Canceled' and old.import_status not in ('Committing', 'Committed', 'Undone')) then
    perform private.refuse('import_status_service_only', 'Import progress is set by the import service; a person may only cancel an uncommitted import.');
  end if;
  if new.target_code <> old.target_code or new.storage_object_path <> old.storage_object_path or new.source <> old.source then
    perform private.refuse('import_job_immutable', 'An import keeps its file and target; start a new import instead.');
  end if;
  if new.mapping_confirmed_at is distinct from old.mapping_confirmed_at then
    if old.mapping_confirmed_at is not null or old.import_status <> 'Mapped' then
      perform private.refuse('import_mapping_confirmation', 'Mappings are confirmed once, after detection proposes them.');
    end if;
    new.mapping_confirmed_at := now();
  end if;
  return new;
end;
$$;

comment on function private.guard_import_job() is 'Import jobs: a person creates them as Uploaded, confirms the mapping once when it is Mapped (the database stamps the time) and may cancel before commit; all other progress comes from the import service.';

create trigger t40_guard_import_job before insert or update on app.import_jobs
  for each row execute function private.guard_import_job();

call private.install_policies('app.import_jobs',
  $$org_id in (select private.import_target_orgs(target_code))$$,
  $$org_id in (select private.import_target_orgs(target_code))$$);
call private.install_audit_trail('app.import_jobs');

create or replace function private.readable_import_job_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select j.id from app.import_jobs j
  where j.deleted_at is null and j.org_id in (select private.import_target_orgs(j.target_code));
$$;

comment on function private.readable_import_job_ids() is 'Imports the signed-in person may see and work on: those of targets they may import into. Child tables of an import authorize through it.';

create table app.import_job_columns (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  import_job_id uuid not null references app.import_jobs (id),
  sheet_name text not null,
  column_index integer not null,
  header text not null,
  field_name text,
  suggested_field_name text,
  constraint import_job_columns_index_nonnegative check (column_index >= 0),
  constraint import_job_columns_header_length check (char_length(header) <= 200)
);

create index import_job_columns_job_idx on app.import_job_columns (import_job_id);

call private.install_domain_table('app.import_job_columns', 'app.import_jobs', 'import_job_id');
call private.describe('app.import_job_columns', 'Detected columns of an import and their mapping (Section 4.6.2 steps 2 and 3): the suggestion from the column map, header similarity or the assistant, and the field the person confirmed.', array[
  'import_job_id', 'Import.',
  'sheet_name', 'Sheet the column is on.',
  'column_index', 'Zero-based column position.',
  'header', 'Header text found in the header row.',
  'field_name', 'Field the person mapped the column to, or null to skip it.',
  'suggested_field_name', 'Field the wizard suggested.'
]);

create unique index import_job_columns_unique on app.import_job_columns (import_job_id, sheet_name, column_index) where deleted_at is null;

create trigger t40_guard_import_field before insert or update on app.import_job_columns
  for each row execute function private.guard_import_field('app.import_jobs', 'import_job_id');

call private.install_policies('app.import_job_columns',
  $$import_job_id in (select private.readable_import_job_ids())$$,
  $$import_job_id in (select private.readable_import_job_ids())$$);

-- Batches and row results --------------------------------------------------------------------------------------

create table app.import_batches (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  import_job_id uuid not null references app.import_jobs (id),
  committed_at timestamptz,
  undone_at timestamptz,
  undo_reason text,
  constraint import_batches_undo_after_commit check (undone_at is null or (committed_at is not null and undone_at >= committed_at)),
  constraint import_batches_undo_reason check ((undone_at is null) = (undo_reason is null)),
  constraint import_batches_undo_reason_length check (undo_reason is null or char_length(btrim(undo_reason)) between 1 and 500)
);

create index import_batches_job_idx on app.import_batches (import_job_id);

call private.install_domain_table('app.import_batches', 'app.import_jobs', 'import_job_id');
call private.describe('app.import_batches', 'One commit of an import (Section 4.6.2 step 7): every row it writes records the batch id, and the whole batch can be undone within 7 days of committed_at.', array[
  'import_job_id', 'Import the batch commits.',
  'committed_at', 'When every row of the batch was written; null while committing.',
  'undone_at', 'When the batch was undone.',
  'undo_reason', 'Why it was undone.'
]);

call private.install_policies('app.import_batches', $$import_job_id in (select private.readable_import_job_ids())$$);

create table app.import_row_results (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  import_job_id uuid not null references app.import_jobs (id),
  import_batch_id uuid references app.import_batches (id),
  sheet_name text not null,
  row_number integer not null,
  row_state app.import_row_state not null,
  reason text,
  target_table text,
  target_id uuid,
  write_action app.import_write_action,
  before_image jsonb,
  undo_outcome app.undo_outcome,
  undo_reason text,
  constraint import_row_results_row_positive check (row_number > 0),
  constraint import_row_results_written check (
    (row_state = 'Written') = (import_batch_id is not null and target_id is not null and write_action is not null)),
  constraint import_row_results_target_pair check ((target_table is null) = (target_id is null)),
  constraint import_row_results_reason check (row_state not in ('Invalid', 'Refused') or reason is not null),
  constraint import_row_results_before_image check ((write_action in ('Updated', 'Merged')) = (before_image is not null)),
  constraint import_row_results_undo check ((undo_outcome is null) or row_state = 'Written'),
  constraint import_row_results_reason_length check (reason is null or char_length(reason) <= 1000)
);

create index import_row_results_job_idx on app.import_row_results (import_job_id, row_state);
create index import_row_results_batch_idx on app.import_row_results (import_batch_id);
create index import_row_results_target_idx on app.import_row_results (target_id);

call private.install_domain_table('app.import_row_results', 'app.import_jobs', 'import_job_id', array['app.import_batches', 'import_batch_id']);
call private.describe('app.import_row_results', 'Outcome of every source row of an import (Section 4.6.2 steps 4 to 8): its row state and reason, and for a Written row the batch, the row written and what the write did. This is where the import batch id of every imported row lives.', array[
  'import_job_id', 'Import.',
  'import_batch_id', 'Batch that wrote the row; set exactly when the row is Written.',
  'sheet_name', 'Source sheet.',
  'row_number', 'One-based row number in the sheet, as the person sees it.',
  'row_state', 'Valid, Invalid, Written, Refused or Skipped.',
  'reason', 'Why a row is Invalid, Refused or Skipped (refusal message or rule).',
  'target_table', 'Table the row was written to.',
  'target_id', 'Row written, created, updated or merged into.',
  'write_action', 'Created, Updated or Merged.',
  'before_image', 'Audit diff of an updated or merged target before the write (the columns the import changed), used to undo it.',
  'undo_outcome', 'Reverted or Kept when the batch was undone.',
  'undo_reason', 'Why a row was kept: the later edit or dependent row.'
]);

call private.install_policies('app.import_row_results', $$import_job_id in (select private.readable_import_job_ids())$$);

create table app.import_cell_issues (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  import_row_result_id uuid not null references app.import_row_results (id),
  column_index integer not null,
  issue_code text not null,
  constraint import_cell_issues_index_nonnegative check (column_index >= 0),
  constraint import_cell_issues_code_format check (issue_code ~ '^[a-z][a-z0-9_]*$')
);

create index import_cell_issues_row_idx on app.import_cell_issues (import_row_result_id);

call private.install_domain_table('app.import_cell_issues', 'app.import_row_results', 'import_row_result_id');
call private.describe('app.import_cell_issues', 'Per-cell validation issues of an import row (Section 4.6.2 step 4: the reason is shown per cell). Messages come from the i18n catalogs keyed by issue code.', array[
  'import_row_result_id', 'Row the cell is in.',
  'column_index', 'Zero-based column of the cell.',
  'issue_code', 'Issue code, for example required, invalid_currency or unknown_time_zone.'
]);

call private.install_policies('app.import_cell_issues',
  $$import_row_result_id in (select r.id from app.import_row_results r where r.import_job_id in (select private.readable_import_job_ids()))$$);

-- Merge reviews -----------------------------------------------------------------------------------------------

create table app.merge_reviews (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  import_row_result_id uuid not null references app.import_row_results (id),
  candidate_table text not null,
  candidate_id uuid not null,
  similarity numeric(4, 3) not null,
  decision app.merge_decision not null default 'Pending',
  decided_by uuid references app.people (id),
  decided_at timestamptz,
  constraint merge_reviews_similarity_threshold check (similarity >= 0.85 and similarity <= 1),
  constraint merge_reviews_decided check ((decision = 'Pending') = (decided_by is null and decided_at is null))
);

create index merge_reviews_row_idx on app.merge_reviews (import_row_result_id);
create index merge_reviews_candidate_idx on app.merge_reviews (candidate_id);
create index merge_reviews_decided_by_idx on app.merge_reviews (decided_by);

call private.install_domain_table('app.merge_reviews', 'app.import_row_results', 'import_row_result_id');
call private.describe('app.merge_reviews', 'Fuzzy matches waiting for a person (Section 4.6.2 step 5): an import row whose name plus address is at least 0.85 similar (pg_trgm) to an existing row. Fuzzy matches never merge automatically.', array[
  'import_row_result_id', 'Import row that matched.',
  'candidate_table', 'Table of the existing row.',
  'candidate_id', 'Existing row it may duplicate.',
  'similarity', 'pg_trgm similarity of name plus address, 0.85 to 1.',
  'decision', 'Pending, Merged or Kept Separate.',
  'decided_by', 'Person who decided, set from the session.',
  'decided_at', 'When they decided, set by the database.'
]);

create or replace function private.guard_merge_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
begin
  if tg_op = 'INSERT' then
    if new.decision <> 'Pending' then
      perform private.refuse('merge_review_pending', 'A fuzzy match starts Pending; a person decides it.');
    end if;
    return new;
  end if;
  if new.candidate_id <> old.candidate_id or new.candidate_table <> old.candidate_table or new.similarity <> old.similarity
     or new.import_row_result_id <> old.import_row_result_id then
    perform private.refuse('merge_review_immutable', 'A merge review keeps its match.');
  end if;
  if new.decision is distinct from old.decision then
    if old.decision <> 'Pending' then
      perform private.refuse('merge_review_decided', 'A decided merge review stays decided.');
    end if;
    if v_person is null then
      perform private.refuse('merge_review_person', 'Only a person decides a fuzzy match; it never merges automatically.');
    end if;
    new.decided_by := v_person;
    new.decided_at := now();
  else
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  end if;
  return new;
end;
$$;

comment on function private.guard_merge_review() is 'Merge reviews: start Pending, keep their match, and are decided once, by a signed-in person whose id and time the database records. No service or job can merge.';

create trigger t40_guard_merge_review before insert or update on app.merge_reviews
  for each row execute function private.guard_merge_review();

call private.install_policies('app.merge_reviews',
  $$import_row_result_id in (select r.id from app.import_row_results r where r.import_job_id in (select private.readable_import_job_ids()))$$,
  null,
  $$import_row_result_id in (select r.id from app.import_row_results r where r.import_job_id in (select private.readable_import_job_ids()))$$);

create or replace function private.fuzzy_candidates(p_org_id uuid, p_target_code text, p_name text, p_address text default null)
returns table (candidate_table text, candidate_id uuid, similarity numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_probe text := lower(btrim(coalesce(p_name, '') || ' ' || coalesce(p_address, '')));
begin
  if p_target_code = 'venues' then
    return query
    select 'app.venues'::text, v.id, round(extensions.similarity(
      lower(btrim(v.name || ' ' || concat_ws(' ', v.street_address, v.locality, v.postal_code))), v_probe)::numeric, 3)
    from app.venues v
    where v.org_id = p_org_id and v.deleted_at is null
      and extensions.similarity(lower(btrim(v.name || ' ' || concat_ws(' ', v.street_address, v.locality, v.postal_code))), v_probe) >= 0.85
    order by 3 desc;
  elsif p_target_code = 'counterparties' then
    return query
    select 'app.counterparties'::text, c.id, round(extensions.similarity(lower(o.name), lower(btrim(p_name)))::numeric, 3)
    from app.counterparties c join app.organizations o on o.id = c.organization_id
    where c.org_id = p_org_id and c.deleted_at is null
      and extensions.similarity(lower(o.name), lower(btrim(p_name))) >= 0.85
    order by 3 desc;
  end if;
end;
$$;

comment on function private.fuzzy_candidates(uuid, text, text, text) is 'Existing rows of the org whose name plus address is at least 0.85 similar (pg_trgm) to an import row (Section 4.6.2 step 5). Strong keys are matched exactly before this runs.';

create or replace function app.record_import_row(
  p_import_job_id uuid,
  p_sheet_name text,
  p_row_number integer,
  p_row_state app.import_row_state,
  p_reason text default null,
  p_match_name text default null,
  p_match_address text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job app.import_jobs;
  v_id uuid;
begin
  select * into v_job from app.import_jobs where id = p_import_job_id and deleted_at is null;
  if v_job.id is null then
    perform private.refuse('import_job_unknown', 'No such import.');
  end if;
  if v_job.mapping_confirmed_at is null then
    perform private.refuse('import_mapping_unconfirmed', 'Every column mapping must be confirmed before rows are validated.');
  end if;
  if p_row_state = 'Written' then
    perform private.refuse('import_row_written_by_commit', 'Rows become Written only through app.commit_import_write.');
  end if;
  insert into app.import_row_results (import_job_id, sheet_name, row_number, row_state, reason)
  values (p_import_job_id, p_sheet_name, p_row_number, p_row_state, p_reason)
  returning id into v_id;
  if p_row_state = 'Valid' and p_match_name is not null then
    insert into app.merge_reviews (import_row_result_id, candidate_table, candidate_id, similarity)
    select v_id, f.candidate_table, f.candidate_id, f.similarity
    from private.fuzzy_candidates(v_job.org_id, v_job.target_code, p_match_name, p_match_address) f;
  end if;
  return v_id;
end;
$$;

comment on function app.record_import_row(uuid, text, integer, app.import_row_state, text, text, text) is 'Import worker API (service role): records a validated row. A Valid row with a name is matched fuzzily and every candidate at 0.85 or more goes to merge review.';

create or replace function app.start_import_batch(p_import_job_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job app.import_jobs;
  v_id uuid;
begin
  select * into v_job from app.import_jobs where id = p_import_job_id and deleted_at is null for update;
  if v_job.id is null or v_job.import_status <> 'Validated' then
    perform private.refuse('import_not_validated', 'Only a validated import is committed.');
  end if;
  if exists (select 1 from app.merge_reviews m join app.import_row_results r on r.id = m.import_row_result_id
             where r.import_job_id = p_import_job_id and m.decision = 'Pending' and m.deleted_at is null) then
    perform private.refuse('import_merge_reviews_pending', 'Decide every fuzzy match before committing.');
  end if;
  update app.import_jobs set import_status = 'Committing' where id = p_import_job_id;
  insert into app.import_batches (import_job_id) values (p_import_job_id) returning id into v_id;
  return v_id;
end;
$$;

comment on function app.start_import_batch(uuid) is 'Import worker API (service role): opens the batch of a validated import once every fuzzy match is decided.';

create or replace function app.commit_import_write(
  p_import_row_result_id uuid,
  p_import_batch_id uuid,
  p_target_id uuid,
  p_write_action app.import_write_action,
  p_before_image jsonb default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row app.import_row_results;
  v_batch app.import_batches;
  v_table text;
  v_target_org uuid;
begin
  select * into v_row from app.import_row_results where id = p_import_row_result_id for update;
  select * into v_batch from app.import_batches where id = p_import_batch_id;
  if v_row.id is null or v_batch.id is null or v_batch.import_job_id <> v_row.import_job_id or v_batch.committed_at is not null then
    perform private.refuse('import_batch_mismatch', 'The row and an open batch of the same import are required.');
  end if;
  if v_row.row_state <> 'Valid' then
    perform private.refuse('import_row_not_valid', 'Only a Valid row is written.');
  end if;
  v_table := (select t.target_table from private.import_targets t join app.import_jobs j on j.target_code = t.code where j.id = v_row.import_job_id);
  execute format('select org_id from %s where id = $1', v_table) into v_target_org using p_target_id;
  if v_target_org is distinct from v_row.org_id then
    perform private.refuse('import_target_unknown', 'The written row must exist in the import''s org.');
  end if;
  update app.import_row_results
  set row_state = 'Written', import_batch_id = p_import_batch_id, target_table = v_table, target_id = p_target_id,
    write_action = p_write_action, before_image = p_before_image
  where id = p_import_row_result_id;
end;
$$;

comment on function app.commit_import_write(uuid, uuid, uuid, app.import_write_action, jsonb) is 'Import worker API (service role): records that a Valid row was written to a row of the target in the same org, with the before image of an update or merge. This puts the batch id on every imported row.';

create or replace function app.finish_import_batch(p_import_batch_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_batch app.import_batches;
begin
  select * into v_batch from app.import_batches where id = p_import_batch_id for update;
  if v_batch.id is null or v_batch.committed_at is not null then
    perform private.refuse('import_batch_closed', 'Only an open batch is finished.');
  end if;
  update app.import_batches set committed_at = now() where id = p_import_batch_id;
  update app.import_jobs set import_status = 'Committed' where id = v_batch.import_job_id;
end;
$$;

comment on function app.finish_import_batch(uuid) is 'Import worker API (service role): closes a batch after its last write. The 7-day undo window starts here.';

-- Undo (Section 4.6.2 step 8) -----------------------------------------------------------------------------------

create or replace function private.later_dependents(p_table text, p_id uuid, p_batch_id uuid, p_since timestamptz)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_fk record;
  v_count bigint;
begin
  for v_fk in
    select c.conrelid::regclass::text as child, a.attname as col
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = p_table::regclass and cardinality(c.conkey) = 1
      and c.conrelid::regclass::text not in ('app.import_row_results', 'app.merge_reviews', 'app.audit_events')
  loop
    if exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = v_fk.child::regclass and a.attname = 'id' and not a.attisdropped) then
      execute format(
        'select count(*) from %s x where x.%I = $1 and x.id not in (select r.target_id from app.import_row_results r where r.import_batch_id = $2 and r.target_id is not null)',
        v_fk.child, v_fk.col)
        into v_count using p_id, p_batch_id;
    else
      execute format('select count(*) from %s x where x.%I = $1', v_fk.child, v_fk.col) into v_count using p_id;
    end if;
    if v_count > 0 then
      return format('%s rows of %s depend on it.', v_count, v_fk.child);
    end if;
  end loop;
  return null;
end;
$$;

comment on function private.later_dependents(text, uuid, uuid, timestamptz) is 'Why a written row cannot be undone: rows outside the batch that reference it, or null when none do.';

create or replace function app.undo_import_batch(p_import_batch_id uuid, p_reason text)
returns table (reverted integer, kept integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_batch app.import_batches;
  v_job app.import_jobs;
  v_capability text;
  v_row record;
  v_updated_at timestamptz;
  v_why text;
  v_reverted integer := 0;
  v_kept integer := 0;
begin
  select * into v_batch from app.import_batches where id = p_import_batch_id for update;
  select * into v_job from app.import_jobs where id = v_batch.import_job_id;
  v_capability := (select t.write_capability from private.import_targets t where t.code = v_job.target_code);
  if v_batch.id is null or not private.has_capability(v_batch.org_id, v_capability) then
    raise exception using errcode = '42501', message = 'import batch not found';
  end if;
  if v_batch.committed_at is null or v_batch.undone_at is not null then
    perform private.refuse('import_batch_not_undoable', 'Only a committed batch that was not undone can be undone.');
  end if;
  if now() > v_batch.committed_at + interval '7 days' then
    perform private.refuse('import_undo_window', 'A batch can be undone for 7 days after it was committed.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) = 0 then
    perform private.refuse('import_undo_reason', 'Say why the batch is undone.');
  end if;
  for v_row in
    select r.id, r.target_table, r.target_id, r.write_action, r.before_image from app.import_row_results r
    where r.import_batch_id = p_import_batch_id and r.row_state = 'Written'
    order by r.row_number desc
  loop
    execute format('select updated_at from %s where id = $1', v_row.target_table) into v_updated_at using v_row.target_id;
    v_why := case when v_updated_at > v_batch.committed_at then 'The row was edited after the import.' end;
    if v_why is null and v_row.write_action = 'Created' then
      v_why := private.later_dependents(v_row.target_table, v_row.target_id, p_import_batch_id, v_batch.committed_at);
    end if;
    if v_why is not null then
      update app.import_row_results set undo_outcome = 'Kept', undo_reason = v_why where id = v_row.id;
      v_kept := v_kept + 1;
      continue;
    end if;
    if v_row.write_action = 'Created' then
      execute format('update %s set deleted_at = now() where id = $1', v_row.target_table) using v_row.target_id;
    else
      execute format('update %1$s t set %2$s from jsonb_populate_record(null::%1$s, $2) b where t.id = $1',
        v_row.target_table,
        (select string_agg(format('%I = b.%I', k, k), ', ') from jsonb_object_keys(v_row.before_image) k))
        using v_row.target_id, v_row.before_image;
    end if;
    update app.import_row_results set undo_outcome = 'Reverted' where id = v_row.id;
    v_reverted := v_reverted + 1;
  end loop;
  update app.import_batches set undone_at = now(), undo_reason = btrim(p_reason) where id = p_import_batch_id;
  perform private.begin_trusted_operation('import_undo');
  update app.import_jobs set import_status = 'Undone' where id = v_batch.import_job_id;
  perform private.end_trusted_operation('import_undo');
  return query select v_reverted, v_kept;
end;
$$;

comment on function app.undo_import_batch(uuid, text) is 'Undoes an import batch within 7 days of its commit (Section 4.6.2 step 8): created rows go to Trash and updated or merged rows get their before image back, except rows edited after the import or referenced by rows outside the batch, which are kept and listed with the reason. Needs the target''s write capability.';

-- Exports and data loss prevention (Section 8.6) ---------------------------------------------------------------------

create table app.export_jobs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  export_format app.export_format not null,
  source_label text not null,
  classification app.data_classification not null,
  watermark boolean not null,
  export_status app.export_status not null default 'Queued',
  storage_object_path text,
  row_count integer,
  expires_at timestamptz,
  constraint export_jobs_source_label_length check (char_length(btrim(source_label)) between 1 and 200),
  constraint export_jobs_ready check ((export_status = 'Ready') = (storage_object_path is not null and expires_at is not null)),
  constraint export_jobs_row_count check (row_count is null or row_count >= 0)
);

call private.install_domain_table('app.export_jobs');
call private.describe('app.export_jobs', 'Requested exports (Section 4.6.4) with data loss prevention (Section 8.6): the highest classification among the exported columns decides who may export and whether the file is watermarked.', array[
  'export_format', 'CSV, XLSX or PDF.',
  'source_label', 'What is exported, for example a list view or report name.',
  'classification', 'Highest classification among the exported columns, computed when the export is requested.',
  'watermark', 'True for Confidential and Restricted exports: PDFs and images carry the viewer email and timestamp.',
  'export_status', 'Queued, Rendering, Ready, Failed or Expired.',
  'storage_object_path', 'Object path of the file once ready.',
  'row_count', 'Rows exported.',
  'expires_at', 'When the download link stops working.'
]);

create index export_jobs_requester_idx on app.export_jobs (created_by, created_at);

call private.install_policies('app.export_jobs',
  $$created_by = (select private.current_person_id()) or org_id in (select private.orgs_with_capability('audit.log.read'))$$);

create or replace function private.readable_export_job_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from app.export_jobs e
  where e.deleted_at is null
    and (e.created_by = private.current_person_id() or e.org_id in (select private.orgs_with_capability('audit.log.read')));
$$;

comment on function private.readable_export_job_ids() is 'Exports the signed-in person may see: their own, or every export of an org whose audit log they read.';

create table app.export_job_columns (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  export_job_id uuid not null references app.export_jobs (id),
  table_name text not null,
  column_name text not null,
  constraint export_job_columns_table_format check (table_name ~ '^app\.[a-z][a-z0-9_]*$')
);

create index export_job_columns_job_idx on app.export_job_columns (export_job_id);

call private.install_domain_table('app.export_job_columns', 'app.export_jobs', 'export_job_id');
call private.describe('app.export_job_columns', 'Columns an export contains, which set its classification.', array[
  'export_job_id', 'Export.',
  'table_name', 'Source table.',
  'column_name', 'Source column.'
]);

call private.install_policies('app.export_job_columns', $$export_job_id in (select private.readable_export_job_ids())$$);

create or replace function private.session_aal()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal', 'aal1');
$$;

comment on function private.session_aal() is 'Authenticator assurance level of the session JWT: aal2 after a second factor (step-up, Section 9).';

create or replace function app.request_export(p_org_id uuid, p_format app.export_format, p_source_label text, p_columns text[])
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_level app.data_classification;
  v_column text;
  v_id uuid;
begin
  if not private.is_member(p_org_id) then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if coalesce(cardinality(p_columns), 0) = 0 then
    perform private.refuse('export_columns_required', 'An export names the columns it contains.');
  end if;
  foreach v_column in array p_columns loop
    if v_column !~ '^app\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' then
      perform private.refuse('export_column_format', format('%s is not table.column.', v_column));
    end if;
    if exists (select 1 from private.column_classifications c
               where c.table_name || '.' || c.column_name = v_column and c.read_capability = 'data.restricted.read.medical') then
      perform private.refuse('export_medical_excluded', 'Medical encounter data is excluded from exports (Section 14.3).');
    end if;
  end loop;
  select coalesce(max(c.classification), 'Internal') into v_level
  from unnest(p_columns) col
  left join private.column_classifications c on c.table_name || '.' || c.column_name = col;
  if v_level = 'Confidential' and not private.has_capability(p_org_id, 'data.export.confidential') then
    perform private.refuse('export_confidential', 'Exporting Confidential columns needs the export capability for Confidential data.');
  end if;
  if v_level = 'Restricted' then
    if not private.has_capability(p_org_id, 'data.export.restricted') then
      perform private.refuse('export_restricted', 'Exporting Restricted columns needs the restricted export capability.');
    end if;
    if private.session_aal() <> 'aal2' then
      perform private.refuse('step_up_required', 'Exporting Restricted columns needs step-up authentication.');
    end if;
  end if;
  insert into app.export_jobs (org_id, export_format, source_label, classification, watermark)
  values (p_org_id, p_format, btrim(p_source_label), v_level, v_level in ('Confidential', 'Restricted'))
  returning id into v_id;
  insert into app.export_job_columns (export_job_id, table_name, column_name)
  select v_id, split_part(c, '.', 1) || '.' || split_part(c, '.', 2), split_part(c, '.', 3) from unnest(p_columns) c;
  perform private.enqueue_job(p_org_id, 'export.render', v_id);
  return v_id;
end;
$$;

comment on function app.request_export(uuid, app.export_format, text, text[]) is 'Requests an export (Section 8.6): Internal data for members, Confidential with data.export.confidential, Restricted with data.export.restricted and step-up (aal2); medical data never. Records the columns, the classification and the watermark, and queues the render job.';

-- Retention -------------------------------------------------------------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.import_mapping_profiles', 'Soft Deleted', 'deleted_at', interval '90 days', 'Delete', 'Deleted profiles carry no history value.'),
  ('app.import_mapping_profile_fields', 'Soft Deleted', 'deleted_at', interval '90 days', 'Delete', 'Kept as long as their profile.'),
  ('app.import_jobs', 'Age', 'created_at', interval '1 year', 'Delete', 'Import history kept a year; the source file ages out with it.'),
  ('app.import_job_columns', 'Age', 'created_at', interval '1 year', 'Delete', 'Kept as long as their import.'),
  ('app.import_batches', 'Age', 'created_at', interval '1 year', 'Delete', 'Kept as long as their import.'),
  ('app.import_row_results', 'Age', 'created_at', interval '1 year', 'Delete', 'Row outcomes kept as long as their import.'),
  ('app.import_cell_issues', 'Age', 'created_at', interval '1 year', 'Delete', 'Kept as long as their row.'),
  ('app.merge_reviews', 'Age', 'created_at', interval '1 year', 'Delete', 'Kept as long as their import.'),
  ('app.export_jobs', 'Age', 'created_at', interval '1 year', 'Delete', 'Export history kept a year; files expire sooner.'),
  ('app.export_job_columns', 'Age', 'created_at', interval '1 year', 'Delete', 'Kept as long as their export.');

-- Privileges --------------------------------------------------------------------------------------------------

revoke all on function private.readable_import_profile_ids() from public, anon;
grant execute on function private.readable_import_profile_ids() to authenticated;
revoke all on function private.readable_import_job_ids() from public, anon;
grant execute on function private.readable_import_job_ids() to authenticated;
revoke all on function private.readable_export_job_ids() from public, anon;
grant execute on function private.readable_export_job_ids() to authenticated;
revoke all on function private.import_target_orgs(text) from public, anon;
grant execute on function private.import_target_orgs(text) to authenticated;
revoke all on function private.guard_import_field() from public, anon, authenticated;
revoke all on function private.guard_import_job() from public, anon, authenticated;
revoke all on function private.guard_merge_review() from public, anon, authenticated;
revoke all on function private.fuzzy_candidates(uuid, text, text, text) from public, anon, authenticated;
revoke all on function app.record_import_row(uuid, text, integer, app.import_row_state, text, text, text) from public, anon, authenticated;
grant execute on function app.record_import_row(uuid, text, integer, app.import_row_state, text, text, text) to service_role;
revoke all on function app.start_import_batch(uuid) from public, anon, authenticated;
grant execute on function app.start_import_batch(uuid) to service_role;
revoke all on function app.commit_import_write(uuid, uuid, uuid, app.import_write_action, jsonb) from public, anon, authenticated;
grant execute on function app.commit_import_write(uuid, uuid, uuid, app.import_write_action, jsonb) to service_role;
revoke all on function app.finish_import_batch(uuid) from public, anon, authenticated;
grant execute on function app.finish_import_batch(uuid) to service_role;
revoke all on function private.later_dependents(text, uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function app.undo_import_batch(uuid, text) from public, anon;
grant execute on function app.undo_import_batch(uuid, text) to authenticated, service_role;
revoke all on function private.session_aal() from public, anon, authenticated;
revoke all on function app.request_export(uuid, app.export_format, text, text[]) from public, anon;
grant execute on function app.request_export(uuid, app.export_format, text, text[]) to authenticated, service_role;
