-- 2801_import_column_samples.sql
-- P3 Rundown and guest list import (RRR-217, gap G-84): the column-mapping preview. While a person maps the columns of
-- an import, the wizard shows up to three sample values under each column and a preview of the first rows laid out by
-- the current choices.
--   * private.import_column_samples: the cells of the first three data rows per column, aligned by row, written by
--     the worker at detection through app.record_import_column_samples (service role only; PostgREST does not expose
--     private, review correction C1). A private table rather than a column of app.import_job_columns, because only
--     the uploader and the worker read a spreadsheet (1061, A22-011) while the columns are readable by everyone who may
--     work on the import.
--   * app.import_column_samples: the samples, for the person who created the import, only while it is Mapped.
--   * t61_drop_import_samples: the samples are deleted when the import leaves Uploaded, Detected or Mapped, or is
--     soft-deleted. Otherwise they go with their column (on delete cascade), whose import keeps a year of history
--     (0530 retention, the 0501 sweep). private.retention_policies registers only app tables, so the samples are not
--     registered (C3). xos_backup keeps the SELECT 1650 grants it on every private table (C2).
-- No table becomes Trash-eligible here, so private.sync_trash_tables() is not called (ADR 0110).

create table private.import_column_samples (
  import_job_column_id uuid not null references app.import_job_columns (id) on delete cascade,
  sample_index smallint not null,
  sample_value text not null,
  primary key (import_job_column_id, sample_index),
  constraint import_column_samples_index_range check (sample_index between 1 and 3),
  constraint import_column_samples_value_length check (char_length(sample_value) <= 200)
);

comment on table private.import_column_samples is 'Cells of the first three data rows of each detected import column, aligned by row, for the mapping preview of the person who uploaded the spreadsheet. Deleted when the import leaves mapping or is deleted; otherwise kept as long as its column.';
comment on column private.import_column_samples.import_job_column_id is 'Detected column of the import.';
comment on column private.import_column_samples.sample_index is 'Data row the cell comes from, 1 to 3, the same for every column of the import.';
comment on column private.import_column_samples.sample_value is 'Cell text, at most 200 characters; empty for a blank cell, so rows stay aligned.';

alter table private.import_column_samples enable row level security;
revoke all on private.import_column_samples from public, anon, authenticated;
grant select, insert, delete on private.import_column_samples to service_role;

-- Writing (worker) --------------------------------------------------------------------------------------------------

create or replace function app.record_import_column_samples(p_import_job_id uuid, p_samples jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job app.import_jobs;
  v_count integer;
begin
  select * into v_job from app.import_jobs j where j.id = p_import_job_id and j.deleted_at is null;
  if v_job.id is null then
    perform private.refuse('import_job_unknown', 'No such import.');
  end if;
  if v_job.import_status not in ('Detected', 'Mapped') then
    perform private.refuse('import_samples_closed', 'Sample values are recorded only while the import''s columns are being mapped.');
  end if;
  if jsonb_typeof(coalesce(p_samples, '[]'::jsonb)) <> 'array' then
    perform private.refuse('import_samples_shape', 'Samples are a list of column, row and value.');
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_samples, '[]'::jsonb)) e
    where not exists (
      select 1 from app.import_job_columns c
      where c.id = (e ->> 'import_job_column_id')::uuid and c.import_job_id = p_import_job_id and c.deleted_at is null)
  ) then
    perform private.refuse('import_samples_column', 'Each sample belongs to a column of the same import.');
  end if;
  insert into private.import_column_samples (import_job_column_id, sample_index, sample_value)
  select (e ->> 'import_job_column_id')::uuid, (e ->> 'sample_index')::smallint, left(coalesce(e ->> 'sample_value', ''), 200)
  from jsonb_array_elements(coalesce(p_samples, '[]'::jsonb)) e
  on conflict (import_job_column_id, sample_index) do update set sample_value = excluded.sample_value;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.record_import_column_samples(uuid, jsonb) is 'Import worker API (service role): records the sample cells of an import''s detected columns, [{import_job_column_id, sample_index 1 to 3, sample_value}], while the import is Detected or Mapped. Each column must belong to the import. Returns the cells written.';
revoke all on function app.record_import_column_samples(uuid, jsonb) from public, anon, authenticated;
grant execute on function app.record_import_column_samples(uuid, jsonb) to service_role;

-- Reading (the uploader, while mapping) ---------------------------------------------------------------------------------

create or replace function app.import_column_samples(p_import_job_id uuid)
returns table (import_job_column_id uuid, sample_index smallint, sample_value text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.import_job_column_id, s.sample_index, s.sample_value
  from private.import_column_samples s
  join app.import_job_columns c on c.id = s.import_job_column_id and c.deleted_at is null
  join app.import_jobs j on j.id = c.import_job_id
  where j.id = p_import_job_id and j.deleted_at is null and j.import_status = 'Mapped'
    and j.created_by is not null and j.created_by = private.current_person_id()
    and j.id in (select private.readable_import_job_ids())
  order by c.column_index, s.sample_index;
$$;

comment on function app.import_column_samples(uuid) is 'Sample cells of each column of an import, for the mapping preview: rows only for the person who created the import, only while it is Mapped and they may still work on it. Anyone else gets no rows.';
revoke all on function app.import_column_samples(uuid) from public, anon;
grant execute on function app.import_column_samples(uuid) to authenticated, service_role;

-- Purge -------------------------------------------------------------------------------------------------------------------

create or replace function private.drop_import_samples()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null or new.import_status not in ('Uploaded', 'Detected', 'Mapped') then
    delete from private.import_column_samples s
    using app.import_job_columns c
    where c.id = s.import_job_column_id and c.import_job_id = new.id;
  end if;
  return null;
end;
$$;

comment on function private.drop_import_samples() is 'Deletes an import''s sample cells once it leaves Uploaded, Detected or Mapped (validated, committed, failed or canceled) or is soft-deleted: sample values live only while the mapping is open.';
revoke all on function private.drop_import_samples() from public, anon, authenticated;

create trigger t61_drop_import_samples after update of import_status, deleted_at on app.import_jobs
  for each row execute function private.drop_import_samples();
