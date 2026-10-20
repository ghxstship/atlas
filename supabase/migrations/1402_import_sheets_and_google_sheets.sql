-- 1402_import_sheets_and_google_sheets.sql
-- A83 Import wizard (RRR-128, finding A65-025, Section 4.6.2 steps 1 to 3). The worker read only the first worksheet,
-- Google Sheets was an enum value with no path, and suggestions ignored the Playbook column map.
--   * Detect: the worker records every sheet of the workbook in app.import_job_sheets with its header row, data rows
--     and a proposed target, and the import reads one sheet (app.import_jobs.sheet_name). app.import_detected_sheet
--     starts the import of another detected sheet as the person, so their capability for the target and the upload
--     rules decide, exactly as for a new upload.
--   * Upload: a Google Sheets link (app.import_jobs.source_url) is read by the worker through the org's Connected
--     Google Drive connection (Section 17 storage): the import.fetch job saves the sheet into the person's own folder
--     of the imports bucket, where it is scanned like any upload before it is read. A fetch that cannot read the
--     sheet fails the import with a reason (failure_code). The imports.google_sheets flag (0540) gates the link.
--   * Map: each suggestion records where it came from (a saved profile, the Playbook column map or header
--     similarity). The assistant's suggestions (aurora.mapColumns) are offered in the wizard and confirmed by the
--     person like any other.
-- .xls stays refused (1241, owner decision 28).

create type app.import_suggestion_source as enum ('Profile', 'Playbook', 'Header');
comment on type app.import_suggestion_source is 'Where the worker''s column suggestion came from: a saved mapping profile, the Playbook column map (canon/map/playbook-columns.yaml, xpms.playbook_column) or header similarity.';

insert into private.job_kinds (code, subject_table, max_attempts, description) values
  ('import.fetch', 'app.import_jobs', 5, 'Reads a Google Sheets link through the org''s Google Drive connection and saves it to the imports bucket for scanning.');

-- The assistant's mapping step is built (the wizard calls aurora.mapColumns through the AI seam, which checks the
-- org's AI switch, plan and allowance); the flag that held it back since 0540 now defaults on.
update private.feature_flags set default_enabled = true where flag_key = 'imports.ai_mapping';

-- Import jobs ------------------------------------------------------------------------------------------------------

alter table app.import_jobs add column sheet_name text;
alter table app.import_jobs add column source_url text;
alter table app.import_jobs add column failure_code text;
alter table app.import_jobs add column import_job_sheet_id uuid;

alter table app.import_jobs add constraint import_jobs_sheet_name_length check (sheet_name is null or char_length(sheet_name) between 1 and 200);
alter table app.import_jobs add constraint import_jobs_source_url_pair check ((source = 'Google Sheets') = (source_url is not null));
alter table app.import_jobs add constraint import_jobs_source_url_format check (
  source_url is null or (source_url ~ '^https://docs\.google\.com/spreadsheets/d/[A-Za-z0-9_-]{20,100}([/?#].*)?$' and char_length(source_url) <= 500));
alter table app.import_jobs add constraint import_jobs_failure_code_format check (failure_code is null or failure_code ~ '^[a-z][a-z0-9_]{2,60}$');

comment on column app.import_jobs.sheet_name is 'Sheet of the workbook this import reads. NULL until detection picks the first sheet with data; set when the import was started from a detected sheet.';
comment on column app.import_jobs.source_url is 'The Google Sheets link the import reads through the org''s Google Drive connection; NULL for an uploaded file.';
comment on column app.import_jobs.failure_code is 'Why the worker failed the import before reading it, for example google_sheet_not_shared; NULL otherwise.';
comment on column app.import_jobs.import_job_sheet_id is 'Detected sheet (app.import_job_sheets) this import was started from, or NULL for an import started from an upload or a link.';

alter table app.import_job_columns add column suggestion_source app.import_suggestion_source;
comment on column app.import_job_columns.suggestion_source is 'Where suggested_field_name came from: a saved profile, the Playbook column map or header similarity; NULL without a suggestion.';

-- Detected sheets ------------------------------------------------------------------------------------------------

create table app.import_job_sheets (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  import_job_id uuid not null references app.import_jobs (id),
  sheet_name text not null,
  sheet_index smallint not null,
  header_row integer,
  first_data_row integer,
  last_row integer,
  column_count integer not null default 0,
  data_row_count integer not null default 0,
  proposed_target_code text references private.import_targets (code),
  proposed_from_playbook boolean not null default false,
  constraint import_job_sheets_name_length check (char_length(sheet_name) between 1 and 200),
  constraint import_job_sheets_index_range check (sheet_index between 0 and 999),
  constraint import_job_sheets_rows check (
    (header_row is null or header_row >= 1) and (first_data_row is null or first_data_row > header_row)
    and (last_row is null or last_row >= 0) and column_count >= 0 and data_row_count >= 0)
);

create index import_job_sheets_job_idx on app.import_job_sheets (import_job_id);
create index import_job_sheets_target_idx on app.import_job_sheets (proposed_target_code);

call private.install_domain_table('app.import_job_sheets', 'app.import_jobs', 'import_job_id');
create unique index import_job_sheets_unique on app.import_job_sheets (import_job_id, sheet_index) where deleted_at is null;
call private.describe('app.import_job_sheets', 'Every sheet the worker found in an import''s workbook (Section 4.6.2 step 2): its header row, data range and the target the worker proposes, so each sheet can be imported into its own target.', array[
  'import_job_id', 'Import whose workbook holds the sheet.',
  'sheet_name', 'Sheet name as the workbook spells it.',
  'sheet_index', 'Zero-based position of the sheet in the workbook.',
  'header_row', 'One-based row of the headers, or NULL for an empty sheet.',
  'first_data_row', 'First row with data below the headers, or NULL when there is none.',
  'last_row', 'Last row with any text.',
  'column_count', 'Columns in the header row.',
  'data_row_count', 'Non-blank rows below the headers.',
  'proposed_target_code', 'Target the worker proposes for the sheet, or NULL when none fits.',
  'proposed_from_playbook', 'True when the proposal came from the Playbook sheet of the same name; false when it came from the headers.'
]);

call private.install_policies('app.import_job_sheets', $$import_job_id in (select private.readable_import_job_ids())$$);
call private.install_default_retention('app.import_job_sheets', interval '1 year');

alter table app.import_jobs add constraint import_jobs_import_job_sheet_id_fkey
  foreign key (import_job_sheet_id) references app.import_job_sheets (id);
create index import_jobs_import_job_sheet_idx on app.import_jobs (import_job_sheet_id);

-- Guards ---------------------------------------------------------------------------------------------------------

create or replace function private.guard_import_job_source()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.source_url is distinct from old.source_url or new.import_job_sheet_id is distinct from old.import_job_sheet_id
       or (new.sheet_name is distinct from old.sheet_name and old.sheet_name is not null) then
      perform private.refuse('import_job_immutable', 'An import keeps its file and target; start a new import instead.');
    end if;
    if private.current_person_id() is not null and (new.failure_code is distinct from old.failure_code
       or new.sheet_name is distinct from old.sheet_name) then
      perform private.refuse('import_status_service_only', 'Import progress is set by the import service; a person may only cancel an uncommitted import.');
    end if;
    return new;
  end if;
  if private.current_person_id() is not null then
    new.failure_code := null;
  end if;
  if new.source = 'Google Sheets' and new.import_job_sheet_id is null then
    if not private.flag_enabled(new.org_id, 'imports.google_sheets') then
      perform private.refuse('import_google_sheets_off', 'Importing from a Google Sheets link is turned off for this organization.');
    end if;
    if not exists (select 1 from app.integration_connections c
                   where c.org_id = new.org_id and c.provider_code = 'google_drive'
                     and c.connection_state = 'Connected' and c.deleted_at is null) then
      perform private.refuse('import_google_drive_required', 'Connect Google Drive in Settings, Integrations, before importing a Google Sheets link.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_import_job_source() is 'Import jobs: a Google Sheets link needs the imports.google_sheets flag and a Connected Google Drive connection in the org; the link, the sheet once chosen and the detected sheet never change; only the import service sets the sheet and the failure reason.';
revoke all on function private.guard_import_job_source() from public, anon, authenticated;

create trigger t42_guard_import_job_source before insert or update on app.import_jobs
  for each row execute function private.guard_import_job_source();

-- Queueing: a Google Sheets link is fetched first --------------------------------------------------------------------

create or replace function private.queue_import_work()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scan app.scan_status;
  v_scanned boolean;
begin
  if tg_op = 'INSERT' then
    -- Lock the upload's scan row so a verdict being recorded right now either sees this job or is
    -- seen by it (private.on_import_upload_scanned).
    select s.scan_status, true into v_scan, v_scanned from private.object_scans s
    where s.bucket_id = 'imports' and s.object_name = new.storage_object_path
    for update;
    if v_scanned is null and new.source = 'Google Sheets' then
      -- Nothing stored yet: the worker reads the link and saves it, and the scan verdict queues detection.
      perform private.enqueue_job(new.org_id, 'import.fetch', new.id);
    elsif v_scanned is null or v_scan <> 'Scanning' then
      -- Clean: detect it. No scan row (no stored object), Infected or Scan Failed: the detection step
      -- reports the import Failed, as the service.
      perform private.enqueue_job(new.org_id, 'import.detect', new.id);
    end if;
  elsif new.mapping_confirmed_at is not null and old.mapping_confirmed_at is null then
    perform private.enqueue_job(new.org_id, 'import.validate', new.id);
  end if;
  return null;
end;
$$;

comment on function private.queue_import_work() is 'Queues work when an import is created: import.fetch for a Google Sheets link not yet saved, detection once the spreadsheet has scanned Clean (otherwise the scan verdict queues it, 1240); and validation once its column mapping is confirmed (Section 4.6.2 steps 1, 2 and 4).';

-- Importing another detected sheet ---------------------------------------------------------------------------------

create or replace function app.import_detected_sheet(p_sheet_id uuid, p_target_code text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sheet app.import_job_sheets;
  v_job app.import_jobs;
  v_id uuid;
begin
  select * into v_sheet from app.import_job_sheets s where s.id = p_sheet_id and s.deleted_at is null;
  if v_sheet.id is null or v_sheet.import_job_id not in (select private.readable_import_job_ids()) then
    raise exception using errcode = '42501', message = 'the sheet does not exist';
  end if;
  select * into v_job from app.import_jobs j where j.id = v_sheet.import_job_id;
  if v_job.import_status in ('Uploaded', 'Detected', 'Failed', 'Canceled') then
    perform private.refuse('import_sheet_not_detected', 'Sheets can be imported once the workbook has been read.');
  end if;
  if v_sheet.data_row_count = 0 then
    perform private.refuse('import_sheet_empty', 'The sheet has no rows to import.');
  end if;
  if p_target_code is null or v_job.org_id not in (select private.import_target_orgs(p_target_code)) then
    perform private.refuse('import_target_not_allowed', 'You cannot import into that target in this organization.');
  end if;
  if v_sheet.sheet_name = v_job.sheet_name or exists (
       select 1 from app.import_jobs j where j.import_job_sheet_id = p_sheet_id and j.deleted_at is null
         and j.import_status not in ('Canceled', 'Failed', 'Undone')) then
    perform private.refuse('import_sheet_taken', 'An import of this sheet is already open.');
  end if;
  insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, source_url, sheet_name, import_job_sheet_id)
  values (v_job.org_id, p_target_code, v_job.source, v_job.original_filename, v_job.storage_object_path, v_job.source_url,
          v_sheet.sheet_name, p_sheet_id)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.import_detected_sheet(uuid, text) is 'Starts the import of another sheet of an already-read workbook into a target the caller may import into. The new import reads the same stored file (the caller''s own upload, as for any import) and goes through detection, mapping, validation and commit on its own.';

revoke all on function app.import_detected_sheet(uuid, text) from public, anon;
grant execute on function app.import_detected_sheet(uuid, text) to authenticated, service_role;
