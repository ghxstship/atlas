-- 1680_collection_exports.sql
--
-- Export from every collection, with the export.render worker (ADR 0022, 1680-1689), A102, RRR-146. Section 4.6.4
-- says every list and report exports to CSV, .xlsx and PDF, subject to Section 8.6. A18's app.request_export (0530,
-- fixed in 1380) recorded the classification, the watermark and the columns of an export and queued an export.render
-- job, but no worker ever ran one, so every export stayed Queued and no Atlas collection offered one. This migration:
--   * records what an export reads: each column's place and header (export_job_columns.column_position and
--     header_label) and the collection's filters in app.export_job_filters (an equality or a list of values on a
--     column, or the search box across the exported columns). A table of filter rows rather than a JSON column (ADR
--     0002, ADR 0060);
--   * recreates app.request_export from 1380 with every rule kept and the same refusal messages, and adds an overload
--     that takes the headers and the filters. An export now names columns that exist, of one table or view (the
--     worker reads one source), in app or in the canon (xpms); medical encounter data is refused through any view
--     that reads it; and a column of a view is classified as the column it shows, so a masked view's Restricted rate
--     still asks for the restricted export capability and step-up. A filtered column counts toward the classification
--     too, since filtering on a column discloses it;
--   * lets the worker run: app.claim_export_renders claims export.render jobs and moves their exports to Rendering,
--     app.export_job_rows reads an export's rows as the person who asked for it (their row level security and grants,
--     never the service role's reach; stable, so a read replica serves it as 1512 made report rows), and
--     app.finish_export_render records Ready with the file and a 7-day expiry, Failed with the reason, or Queued again
--     while the job has attempts left. Expired files are listed and marked Expired once the worker removed them;
--   * keeps the files in a private export-files bucket that only the requester reads, and only while the classification
--     still allows it (Confidential needs data.export.confidential; Restricted needs data.export.restricted and an
--     aal2 session). app.record_export_download logs each download in app.file_access_log;
--   * answers the report worker the classification of a run's columns and the viewer's email, so a report PDF whose
--     columns classify above Internal carries the Section 8.6 watermark;
--   * schedules the worker from pg_cron every minute while there is work, through the functions URL and the worker key
--     in Vault, as 1542 calls fx-rates-ecb.

-- 1. What an export reads -----------------------------------------------------------------------------------------------

alter table app.export_job_columns drop constraint export_job_columns_table_format;
alter table app.export_job_columns
  add constraint export_job_columns_table_format check (table_name ~ '^(app|xpms)\.[a-z][a-z0-9_]*$'),
  add column column_position smallint,
  add column header_label text,
  add constraint export_job_columns_position check (column_position is null or column_position between 1 and 100),
  add constraint export_job_columns_header_length check (header_label is null or char_length(btrim(header_label)) between 1 and 200);

comment on column app.export_job_columns.table_name is 'Source table or view: app.<name>, or xpms.<name> for canon.';
comment on column app.export_job_columns.column_position is 'Place of the column in the file, from 1. Null on exports requested before 1680.';
comment on column app.export_job_columns.header_label is 'Column header in the requester''s language, as the collection shows it; null shows the column name.';

alter table app.export_jobs
  add column last_error text,
  add constraint export_jobs_last_error_length check (last_error is null or char_length(last_error) <= 2000);

comment on column app.export_jobs.last_error is 'Why the latest render attempt failed, for the requester. Cleared when an attempt starts or succeeds.';

create type app.export_filter_operator as enum ('eq', 'in', 'search');
comment on type app.export_filter_operator is 'How an export filter narrows its rows: eq compares one column with a value, in with any of a comma-separated list of values, search matches the value inside any exported column (the collection''s search box).';

-- Requesting an export stays possible while a canceled org is read-only, as 1063 keeps for its columns.
insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.export_job_filters', 'Filters of an export.')
on conflict (table_name) do nothing;

create table app.export_job_filters (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  export_job_id uuid not null references app.export_jobs (id),
  column_name text,
  filter_operator app.export_filter_operator not null,
  value_text text not null,
  constraint export_job_filters_column_format check (column_name is null or column_name ~ '^[a-z][a-z0-9_]*$'),
  constraint export_job_filters_column check ((filter_operator = 'search') = (column_name is null)),
  constraint export_job_filters_value_length check (char_length(value_text) between 1 and 1000)
);

create index export_job_filters_job_idx on app.export_job_filters (export_job_id);

call private.install_domain_table('app.export_job_filters', 'app.export_jobs', 'export_job_id');
call private.describe('app.export_job_filters', 'Filters of an export: the collection''s filters and search when it was exported (Section 4.6.4), applied by the worker as the requester reads. Written only by app.request_export.', array[
  'export_job_id', 'Export.',
  'column_name', 'Column of the export''s source an eq or in filter compares; null for search.',
  'filter_operator', 'eq, in or search.',
  'value_text', 'Value compared as text, the comma-separated values of an in filter, or the text searched for.'
]);

call private.install_policies('app.export_job_filters', $$export_job_id in (select private.readable_export_job_ids())$$);

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.export_job_filters', 'Age', 'created_at', interval '1 year', 'Delete', 'Kept as long as their export.');

-- 2. Classification and medical data through views -----------------------------------------------------------------------

create table private.view_column_sources (
  view_name text not null,
  column_name text not null,
  source_table text not null,
  source_column text not null,
  primary key (view_name, column_name, source_table, source_column),
  constraint view_column_sources_view_format check (view_name ~ '^app\.[a-z][a-z0-9_]*$'),
  constraint view_column_sources_source_format check (source_table ~ '^app\.[a-z][a-z0-9_]*$')
);

comment on table private.view_column_sources is 'View columns that show a classified column under another name or compute from it (Section 8.3). An export classifies such a column as its source; a view column of the same name as a column it reads needs no row here.';
comment on column private.view_column_sources.view_name is 'Schema-qualified view.';
comment on column private.view_column_sources.column_name is 'Column of the view.';
comment on column private.view_column_sources.source_table is 'Schema-qualified table whose column the view column shows or computes from.';
comment on column private.view_column_sources.source_column is 'Classified column it comes from.';

alter table private.view_column_sources enable row level security;
revoke all on private.view_column_sources from public, anon, authenticated;
grant select on private.view_column_sources to service_role;

insert into private.view_column_sources (view_name, column_name, source_table, source_column) values
  ('app.payroll_line_amounts', 'amount_minor', 'app.payroll_lines', 'rate_minor'),
  ('app.engagement_resolved', 'rate_minor', 'app.engagements', 'agreed_rate_minor');

-- The classification of one column an export reads. A column of a view reads the column of the same name in each
-- relation the view depends on (through other views too), and the column a row of private.view_column_sources names;
-- the highest registered classification among them wins, and a column the registry does not reach is Internal (1380).
create or replace function private.export_column_classification(p_relation regclass, p_column text)
returns app.data_classification
language sql
stable
security definer
set search_path = ''
as $$
  with recursive reads (rel, col) as (
    select p_relation::oid, p_column
    union
    select n.rel, n.col
    from reads x
    cross join lateral (
      select d.refobjid as rel, a.attname::text collate "default" as col
      from pg_catalog.pg_rewrite r
      join pg_catalog.pg_depend d on d.classid = 'pg_catalog.pg_rewrite'::regclass and d.objid = r.oid
        and d.refclassid = 'pg_catalog.pg_class'::regclass and d.refobjsubid > 0 and d.refobjid <> x.rel
      join pg_catalog.pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid and not a.attisdropped
      where r.ev_class = x.rel and a.attname::text = x.col
      union
      select to_regclass(s.source_table)::oid, s.source_column
      from private.view_column_sources s
      where s.view_name = x.rel::regclass::text and s.column_name = x.col and to_regclass(s.source_table) is not null
    ) n
  )
  select coalesce(max(c.classification), 'Internal'::app.data_classification)
  from reads x
  join private.column_classifications c on c.table_name = x.rel::regclass::text and c.column_name = x.col;
$$;

comment on function private.export_column_classification(regclass, text) is 'Classification of a column an export reads (Section 8.3, 8.6): its own registry entry, or for a view column the entries of the same-named columns the view reads (recursively) and of the sources private.view_column_sources names. Internal when the registry reaches none.';
revoke all on function private.export_column_classification(regclass, text) from public, anon, authenticated;

-- True when the relation is app.medical_encounters or a view that reads it, directly or through other views.
create or replace function private.export_reads_medical(p_relation regclass)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive deps (rel) as (
    select p_relation::oid
    union
    select d.refobjid
    from deps x
    join pg_catalog.pg_rewrite r on r.ev_class = x.rel
    join pg_catalog.pg_depend d on d.classid = 'pg_catalog.pg_rewrite'::regclass and d.objid = r.oid
      and d.refclassid = 'pg_catalog.pg_class'::regclass and d.refobjid <> x.rel
  )
  select exists (select 1 from deps where deps.rel = 'app.medical_encounters'::regclass);
$$;

comment on function private.export_reads_medical(regclass) is 'True when a relation is app.medical_encounters or a view reading it, directly or through other views: medical encounter data never leaves in an export (Section 14.3).';
revoke all on function private.export_reads_medical(regclass) from public, anon, authenticated;
grant execute on function private.export_reads_medical(regclass) to service_role;

-- 3. Requesting an export (from 1380) ------------------------------------------------------------------------------------

create or replace function app.request_export(
  p_org_id uuid,
  p_format app.export_format,
  p_source_label text,
  p_columns text[],
  p_headers text[],
  p_filters jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_level app.data_classification;
  v_column text;
  v_relation text;
  v_sources integer;
  v_class regclass;
  v_filter jsonb;
  v_filter_columns text[] := array[]::text[];
  v_id uuid;
begin
  if not private.is_member(p_org_id) then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if coalesce(cardinality(p_columns), 0) = 0 then
    perform private.refuse('export_columns_required', 'An export names the columns it contains.');
  end if;
  if cardinality(p_columns) > 100 then
    perform private.refuse('export_columns_count', 'An export names at most 100 columns.');
  end if;
  foreach v_column in array p_columns loop
    if v_column !~ '^(app|xpms)\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' then
      perform private.refuse('export_column_format', format('%s is not table.column.', v_column));
    end if;
    if exists (select 1 from private.column_classifications c
               where c.table_name || '.' || c.column_name = v_column and c.read_capability = 'data.restricted.read.medical') then
      perform private.refuse('export_medical_excluded', 'Medical encounter data is excluded from exports (Section 14.3).');
    end if;
  end loop;
  if (select count(*) from unnest(p_columns) c) <> (select count(distinct c) from unnest(p_columns) c) then
    perform private.refuse('export_column_duplicate', 'An export names each column once.');
  end if;
  select min(split_part(c, '.', 1) || '.' || split_part(c, '.', 2)), count(distinct split_part(c, '.', 1) || '.' || split_part(c, '.', 2))
  into v_relation, v_sources
  from unnest(p_columns) c;
  if v_sources <> 1 then
    perform private.refuse('export_one_source', 'An export reads its columns from one table or view.');
  end if;
  v_class := to_regclass(v_relation);
  if v_class is null or (select c.relkind from pg_catalog.pg_class c where c.oid = v_class) not in ('r', 'p', 'v', 'm') then
    perform private.refuse('export_source_unknown', format('%s is not a table or view.', v_relation));
  end if;
  foreach v_column in array p_columns loop
    if not exists (select 1 from pg_catalog.pg_attribute a
                   where a.attrelid = v_class and a.attname = split_part(v_column, '.', 3) and a.attnum > 0 and not a.attisdropped) then
      perform private.refuse('export_column_unknown', format('%s has no column %s.', v_relation, split_part(v_column, '.', 3)));
    end if;
  end loop;
  if p_headers is not null and (cardinality(p_headers) <> cardinality(p_columns)
      or exists (select 1 from unnest(p_headers) h where h is null or char_length(btrim(h)) not between 1 and 200)) then
    perform private.refuse('export_headers', 'An export names one header of 1 to 200 characters for each column.');
  end if;
  if p_filters is not null and (jsonb_typeof(p_filters) <> 'array' or jsonb_array_length(p_filters) > 20) then
    perform private.refuse('export_filters', 'Filters are a list of at most 20.');
  end if;
  for v_filter in select f from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb)) f loop
    if jsonb_typeof(v_filter) <> 'object' or jsonb_typeof(v_filter -> 'value') <> 'string'
       or char_length(v_filter ->> 'value') not between 1 and 1000
       or coalesce(v_filter ->> 'operator', '') not in ('eq', 'in', 'search') then
      perform private.refuse('export_filters', 'Each filter has an operator (eq, in or search) and a value of 1 to 1000 characters.');
    end if;
    if v_filter ->> 'operator' = 'search' then
      if v_filter ? 'column' and jsonb_typeof(v_filter -> 'column') <> 'null' then
        perform private.refuse('export_filters', 'A search filter searches the exported columns and names none.');
      end if;
    else
      if coalesce(v_filter ->> 'column', '') !~ '^[a-z][a-z0-9_]*$' or not exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = v_class and a.attname = v_filter ->> 'column' and a.attnum > 0 and not a.attisdropped) then
        perform private.refuse('export_filter_column', format('%s has no column %s to filter on.', v_relation, coalesce(v_filter ->> 'column', '')));
      end if;
      v_filter_columns := v_filter_columns || (v_relation || '.' || (v_filter ->> 'column'));
    end if;
  end loop;
  if private.export_reads_medical(v_class) then
    perform private.refuse('export_medical_excluded', 'Medical encounter data is excluded from exports (Section 14.3).');
  end if;
  select max(private.export_column_classification(v_class, split_part(col, '.', 3))) into v_level
  from unnest(p_columns || v_filter_columns) col;
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
  insert into app.export_job_columns (export_job_id, table_name, column_name, column_position, header_label)
  select v_id, v_relation, split_part(c.name, '.', 3), c.place::smallint, btrim(p_headers[c.place])
  from unnest(p_columns) with ordinality as c (name, place);
  insert into app.export_job_filters (export_job_id, column_name, filter_operator, value_text)
  select v_id, case when f ->> 'operator' <> 'search' then f ->> 'column' end, (f ->> 'operator')::app.export_filter_operator, f ->> 'value'
  from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb)) f;
  perform private.enqueue_job(p_org_id, 'export.render', v_id);
  return v_id;
end;
$$;

comment on function app.request_export(uuid, app.export_format, text, text[], text[], jsonb) is 'Requests an export (Section 4.6.4, 8.6) of columns of one table or view (app, or xpms for canon), with their headers (null for column names) and filters ([{"operator":"eq" or "in","column":...,"value":...} or {"operator":"search","value":...}], an in value comma-separated; null for none). Public and Internal data for members, Confidential with data.export.confidential, Restricted with data.export.restricted and step-up (aal2); medical encounter data never, through any view. A view column is classified as the column it shows, an unlisted column is Internal, and a filtered column counts toward the classification. Records the columns, headers, filters, classification and watermark, and queues the render job.';
revoke all on function app.request_export(uuid, app.export_format, text, text[], text[], jsonb) from public, anon;
grant execute on function app.request_export(uuid, app.export_format, text, text[], text[], jsonb) to authenticated, service_role;

create or replace function app.request_export(p_org_id uuid, p_format app.export_format, p_source_label text, p_columns text[])
returns uuid
language sql
volatile
security definer
set search_path = ''
as $$
  select app.request_export(p_org_id, p_format, p_source_label, p_columns, null::text[], null::jsonb);
$$;

comment on function app.request_export(uuid, app.export_format, text, text[]) is 'Requests an export (Section 8.6) of the columns named, with their column names as headers and no filters: the API''s ExportJobCreate. The rules are those of the overload with headers and filters: Public and Internal data for members, Confidential with data.export.confidential, Restricted with data.export.restricted and step-up (aal2); medical data never. A column the registry does not list counts as Internal. Records the columns, the classification and the watermark, and queues the render job.';
revoke all on function app.request_export(uuid, app.export_format, text, text[]) from public, anon;
grant execute on function app.request_export(uuid, app.export_format, text, text[]) to authenticated, service_role;

-- 4. Export files ---------------------------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('export-files', 'export-files', false, 52428800,
  array['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf'])
on conflict (id) do nothing;

-- The object name of an export's file.
create or replace function private.export_file_path(p_org_id uuid, p_export_job_id uuid, p_format app.export_format)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_org_id::text || '/' || p_export_job_id::text || '.' || lower(p_format::text);
$$;

comment on function private.export_file_path(uuid, uuid, app.export_format) is 'Object name of an export''s file in export-files: <org_id>/<export_job_id>.<csv|xlsx|pdf>.';
revoke all on function private.export_file_path(uuid, uuid, app.export_format) from public, anon, authenticated;
grant execute on function private.export_file_path(uuid, uuid, app.export_format) to service_role;

-- The export an export-files object belongs to, or NULL for any other name. Takes the name as a value and never
-- re-reads storage.objects (ADR 0016 rule 14).
create or replace function private.export_file_job(p_object_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(p_object_name, '/');
begin
  if coalesce(array_length(v_parts, 1), 0) <> 2 or v_parts[2] !~ '^[0-9a-f-]{36}\.(csv|xlsx|pdf)$' then
    return null;
  end if;
  return left(v_parts[2], 36)::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

comment on function private.export_file_job(text) is 'Export id of an export-files object (<org_id>/<export_job_id>.<format>), or NULL for any other name.';
revoke all on function private.export_file_job(text) from public, anon;
grant execute on function private.export_file_job(text) to authenticated, service_role;

-- True when the signed-in person may download the file: their own Ready export, not expired, and the classification
-- still allows it now (an aal2 session for Restricted, as 1380 asks of Restricted files).
create or replace function private.export_file_downloadable(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.export_jobs e
    where e.id = private.export_file_job(p_object_name) and e.deleted_at is null
      and e.storage_object_path = p_object_name and e.export_status = 'Ready' and e.expires_at > now()
      and e.created_by = private.current_person_id()
      and (e.classification in ('Public', 'Internal')
        or (e.classification = 'Confidential' and private.has_capability(e.org_id, 'data.export.confidential'))
        or (e.classification = 'Restricted' and private.has_capability(e.org_id, 'data.export.restricted')
          and private.session_aal() = 'aal2')));
$$;

comment on function private.export_file_downloadable(text) is 'True when the signed-in person may download an export-files object (Section 8.6): their own Ready export before it expires, a Confidential one while they hold data.export.confidential, a Restricted one while they hold data.export.restricted on an aal2 session.';
revoke all on function private.export_file_downloadable(text) from public, anon;
grant execute on function private.export_file_downloadable(text) to authenticated, service_role;

create policy export_files_read on storage.objects for select to authenticated
  using (bucket_id = 'export-files' and private.export_file_downloadable(name));

-- Downloading an export file: checks the person may, logs it (Section 8.4 access transparency, Section 8.6) and answers
-- the object name for the signed link, whose download the storage policy holds to the same rules.
create or replace function app.record_export_download(p_export_job_id uuid)
returns table (storage_object_path text, export_format app.export_format, source_label text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_person uuid := private.require_person();
  v_export app.export_jobs;
begin
  select * into v_export from app.export_jobs e where e.id = p_export_job_id and e.deleted_at is null;
  if v_export.id is null or v_export.created_by is distinct from v_person or not private.is_member(v_export.org_id) then
    raise exception using errcode = '42501', message = 'export not found';
  end if;
  if v_export.export_status <> 'Ready' or v_export.expires_at <= now() then
    perform private.refuse('export_not_ready', 'The export''s file is not ready, or its download has expired.');
  end if;
  if v_export.classification = 'Confidential' and not private.has_capability(v_export.org_id, 'data.export.confidential') then
    perform private.refuse('export_confidential', 'Exporting Confidential columns needs the export capability for Confidential data.');
  end if;
  if v_export.classification = 'Restricted' then
    if not private.has_capability(v_export.org_id, 'data.export.restricted') then
      perform private.refuse('export_restricted', 'Exporting Restricted columns needs the restricted export capability.');
    end if;
    if private.session_aal() <> 'aal2' then
      perform private.refuse('step_up_required', 'Downloading a Restricted export needs step-up authentication.');
    end if;
  end if;
  insert into app.file_access_log (org_id, person_id, bucket_id, object_path, action, classification, watermarked)
  values (v_export.org_id, v_person, 'export-files', v_export.storage_object_path, 'Download', v_export.classification,
    v_export.watermark and v_export.export_format = 'PDF');
  return query select v_export.storage_object_path, v_export.export_format, v_export.source_label;
end;
$$;

comment on function app.record_export_download(uuid) is 'Logs one download of the caller''s own Ready export in app.file_access_log (Section 8.4, 8.6) and answers its object name in export-files, its format and its label. Confidential exports need data.export.confidential, Restricted ones data.export.restricted and step-up (aal2), as when they were requested; the storage policy holds the download itself to the same rules.';
revoke all on function app.record_export_download(uuid) from public, anon;
grant execute on function app.record_export_download(uuid) to authenticated, service_role;

-- 5. The export.render worker -------------------------------------------------------------------------------------------

-- Claims ready export.render jobs and moves each one's export from Queued to Rendering. A job whose export is gone or
-- no longer Queued (an earlier attempt finished it) is finished at once and not returned.
create or replace function app.claim_export_renders(p_worker text, p_limit integer default 5)
returns table (
  job_id uuid,
  export_job_id uuid,
  org_id uuid,
  export_format app.export_format,
  source_label text,
  classification app.data_classification,
  watermark boolean,
  requested_at timestamptz,
  requester_email text,
  locale text,
  time_zone text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_job app.job_queue;
  v_export app.export_jobs;
begin
  for v_job in select * from app.claim_jobs(p_worker, 'export.render', p_limit) loop
    select * into v_export from app.export_jobs e where e.id = v_job.subject_id and e.deleted_at is null for update;
    if v_export.id is null or v_export.export_status <> 'Queued' then
      perform app.finish_job(v_job.id, true, null);
      continue;
    end if;
    update app.export_jobs set export_status = 'Rendering', last_error = null where id = v_export.id;
    return query select v_job.id, v_export.id, v_export.org_id, v_export.export_format, v_export.source_label,
      v_export.classification, v_export.watermark, v_export.created_at,
      (select u.email::text from app.people p join auth.users u on u.id = p.user_id where p.id = v_export.created_by),
      private.person_language(v_export.created_by, v_export.org_id),
      coalesce(private.setting_text(v_export.org_id, 'locale.time_zone', null, null, v_export.created_by), 'UTC');
  end loop;
end;
$$;

comment on function app.claim_export_renders(text, integer) is 'Worker API (service role): claims up to p_limit ready export.render jobs (app.claim_jobs, SKIP LOCKED), moves each export from Queued to Rendering and answers what the file needs: format, label, classification, watermark, when it was asked for, the requester''s email for the watermark, and their language and time zone. Jobs whose export is gone or already finished are finished at once.';
revoke all on function app.claim_export_renders(text, integer) from public, anon, authenticated;
grant execute on function app.claim_export_renders(text, integer) to service_role;

/*
 * Security invoker on purpose, as 1050's app.report_run_rows: called by the service role (granted to it alone), it
 * switches to the authenticated role with the requester as the JWT subject for the one query, so their row level
 * security and grants decide every row and column. Stable, so PostgREST runs it read-only on a GET and a read replica
 * serves it (1512). Reads the export's recorded columns in order, scoped to its org (org_id, or project_id within the
 * org; canon has neither), without soft-deleted rows, with its eq and in filters and its search across the exported columns.
 */
create or replace function app.export_job_rows(p_export_job_id uuid, p_limit integer)
returns setof jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_export app.export_jobs;
  v_relation text;
  v_sources integer;
  v_class regclass;
  v_columns text[];
  v_user uuid;
  v_where text[] := array[]::text[];
  v_filter record;
  v_search text;
  v_order text;
  v_role text := current_user;
  v_claims text := current_setting('request.jwt.claims', true);
  v_sql text;
begin
  select * into v_export from app.export_jobs e where e.id = p_export_job_id and e.deleted_at is null;
  if v_export.id is null then
    perform private.refuse('export_missing', 'The export does not exist.');
  end if;
  if v_export.export_status <> 'Rendering' then
    perform private.refuse('export_not_rendering', 'Rows are read only for an export being rendered.');
  end if;
  select min(c.table_name), count(distinct c.table_name),
         array_agg(c.column_name order by c.column_position nulls last, c.id)
  into v_relation, v_sources, v_columns
  from app.export_job_columns c where c.export_job_id = v_export.id and c.deleted_at is null;
  if coalesce(v_sources, 0) <> 1 then
    perform private.refuse('export_one_source', 'An export reads its columns from one table or view.');
  end if;
  v_class := to_regclass(v_relation);
  if v_class is null then
    perform private.refuse('export_source_unknown', format('%s is not a table or view.', v_relation));
  end if;
  if exists (select 1 from unnest(v_columns) c where not exists (
      select 1 from pg_catalog.pg_attribute a where a.attrelid = v_class and a.attname = c and a.attnum > 0 and not a.attisdropped)) then
    perform private.refuse('export_column_unknown', format('%s no longer has every column of the export.', v_relation));
  end if;
  if private.export_reads_medical(v_class) then
    perform private.refuse('export_medical_excluded', 'Medical encounter data is excluded from exports (Section 14.3).');
  end if;
  select p.user_id into v_user from app.people p where p.id = v_export.created_by;
  if v_user is null then
    perform private.refuse('export_person', 'The person who asked for the export has no sign-in.');
  end if;

  if v_relation like 'app.%' then
    if exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = v_class and a.attname = 'org_id' and not a.attisdropped) then
      v_where := v_where || format('s.org_id = %L', v_export.org_id);
    elsif exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = v_class and a.attname = 'project_id' and not a.attisdropped) then
      v_where := v_where || format('s.project_id in (select p.id from app.projects p where p.org_id = %L and p.deleted_at is null)', v_export.org_id);
    else
      perform private.refuse('export_scope', format('%s has neither org_id nor project_id to scope the export.', v_relation));
    end if;
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = v_class and a.attname = 'deleted_at' and not a.attisdropped) then
    v_where := v_where || 's.deleted_at is null'::text;
  end if;
  for v_filter in
    select f.column_name, f.filter_operator, f.value_text from app.export_job_filters f
    where f.export_job_id = v_export.id and f.deleted_at is null order by f.id
  loop
    if v_filter.filter_operator in ('eq', 'in') then
      if not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = v_class and a.attname = v_filter.column_name and a.attnum > 0 and not a.attisdropped) then
        perform private.refuse('export_filter_column', format('%s has no column %s to filter on.', v_relation, v_filter.column_name));
      end if;
      if v_filter.filter_operator = 'eq' then
        v_where := v_where || format('s.%I::text = %L', v_filter.column_name, v_filter.value_text);
      else
        v_where := v_where || coalesce(
          (select format('s.%I::text in (%s)', v_filter.column_name, string_agg(format('%L', btrim(x)), ', '))
           from unnest(string_to_array(v_filter.value_text, ',')) x where btrim(x) <> ''),
          'false');
      end if;
    else
      -- The search box: the text inside any exported column, with % and _ taken literally.
      v_search := '%' || regexp_replace(v_filter.value_text, '([%_\\])', '\\\1', 'g') || '%';
      v_where := v_where || (select '(' || string_agg(format('s.%I::text ilike %L', c, v_search), ' or ') || ')' from unnest(v_columns) c);
    end if;
  end loop;
  -- Sorted by the exported columns in their order, skipping types without a natural order (json, geometry, ids).
  select string_agg(format('s.%I', a.attname), ', ' order by array_position(v_columns, a.attname::text))
  into v_order
  from pg_catalog.pg_attribute a join pg_catalog.pg_type t on t.oid = a.atttypid
  where a.attrelid = v_class and a.attname::text = any (v_columns) and a.attnum > 0 and not a.attisdropped
    and t.typcategory in ('B', 'D', 'E', 'N', 'S');
  v_sql := format(
    'select to_jsonb(q) from (select %s from %s s where %s%s limit %s) q',
    (select string_agg(format('s.%I', c), ', ' order by n) from unnest(v_columns) with ordinality as x (c, n)),
    v_class::text,
    coalesce(nullif(array_to_string(v_where, ' and '), ''), 'true'),
    case when v_order is null then '' else ' order by ' || v_order end,
    least(greatest(coalesce(p_limit, 1), 1), 100001)
  );

  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  return query execute v_sql;
  perform set_config('role', v_role, true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
end;
$$;

comment on function app.export_job_rows(uuid, integer) is 'Worker API (service role): the rows of an export being rendered, read as the person who asked for it (their row level security and grants): its recorded columns in order, scoped to its org, without deleted rows, with its eq, in and search filters, sorted by its columns, at most p_limit rows. Stable, so a read replica serves it.';
revoke all on function app.export_job_rows(uuid, integer) from public, anon, authenticated;
grant execute on function app.export_job_rows(uuid, integer) to service_role;

-- Records an attempt's outcome: Ready with the export's own file, its row count and a 7-day expiry; or, for a failure,
-- Queued again while the job has attempts left (app.finish_job's backoff), then Failed, with the reason either way.
create or replace function app.finish_export_render(
  p_job_id uuid,
  p_succeeded boolean,
  p_storage_object_path text default null,
  p_row_count integer default null,
  p_error text default null
)
returns app.export_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job app.job_queue;
  v_export app.export_jobs;
  v_status app.job_status;
begin
  select * into v_job from app.job_queue q where q.id = p_job_id and q.job_kind = 'export.render' for update;
  if v_job.id is null or v_job.job_status <> 'Running' then
    perform private.refuse('job_not_running', 'Only a running job can be finished.');
  end if;
  select * into v_export from app.export_jobs e where e.id = v_job.subject_id and e.deleted_at is null for update;
  if v_export.id is null then
    perform private.refuse('export_missing', 'The export does not exist.');
  end if;
  if v_export.export_status <> 'Rendering' then
    perform private.refuse('export_not_rendering', 'Only an export being rendered can finish.');
  end if;
  if p_succeeded then
    if p_storage_object_path is distinct from private.export_file_path(v_export.org_id, v_export.id, v_export.export_format) then
      perform private.refuse('export_file_path', 'A finished export names its own file.');
    end if;
    if p_row_count is null or p_row_count < 0 then
      perform private.refuse('export_row_count', 'A finished export records how many rows it holds.');
    end if;
    update app.export_jobs set export_status = 'Ready', storage_object_path = p_storage_object_path,
      row_count = p_row_count, expires_at = now() + interval '7 days', last_error = null
    where id = v_export.id;
    perform app.finish_job(p_job_id, true, null);
    return 'Ready';
  end if;
  if p_error is null or btrim(p_error) = '' then
    perform private.refuse('export_error', 'A failed attempt records why it failed.');
  end if;
  v_status := app.finish_job(p_job_id, false, p_error);
  update app.export_jobs set export_status = case when v_status = 'Queued' then 'Queued' else 'Failed' end::app.export_status,
    last_error = left(p_error, 2000)
  where id = v_export.id;
  return case when v_status = 'Queued' then 'Queued' else 'Failed' end::app.export_status;
end;
$$;

comment on function app.finish_export_render(uuid, boolean, text, integer, text) is 'Worker API (service role): records an export.render attempt. Success needs the export''s own file (private.export_file_path) and its row count, and makes it Ready for 7 days; a failure needs the reason and returns the export to Queued while the job has attempts left (app.finish_job), then Failed.';
revoke all on function app.finish_export_render(uuid, boolean, text, integer, text) from public, anon, authenticated;
grant execute on function app.finish_export_render(uuid, boolean, text, integer, text) to service_role;

-- Ready exports past their expiry, oldest first, whose files the worker removes before marking them Expired.
create or replace function app.expired_export_files(p_limit integer default 50)
returns table (export_job_id uuid, storage_object_path text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.storage_object_path from app.export_jobs e
  where e.export_status = 'Ready' and e.expires_at <= now() and e.deleted_at is null
  order by e.expires_at, e.id
  limit least(greatest(coalesce(p_limit, 1), 1), 500);
$$;

comment on function app.expired_export_files(integer) is 'Worker API (service role): Ready exports whose download expired, with the file the worker removes before app.mark_export_expired.';
revoke all on function app.expired_export_files(integer) from public, anon, authenticated;
grant execute on function app.expired_export_files(integer) to service_role;

create or replace function app.mark_export_expired(p_export_job_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update app.export_jobs set export_status = 'Expired', storage_object_path = null
  where id = p_export_job_id and export_status = 'Ready' and expires_at <= now();
end;
$$;

comment on function app.mark_export_expired(uuid) is 'Worker API (service role): marks a Ready export whose download expired as Expired and forgets its file, once the worker removed it. Does nothing to any other export.';
revoke all on function app.mark_export_expired(uuid) from public, anon, authenticated;
grant execute on function app.mark_export_expired(uuid) to service_role;

-- 6. Report runs: the watermark of report PDFs -------------------------------------------------------------------------

create or replace function app.report_run_classification(p_run_id uuid, p_columns text[])
returns table (classification app.data_classification, viewer_email text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select coalesce(max(private.export_column_classification(to_regclass('app.' || private.report_source_relation(d.source_code)), col)), 'Internal')
     from unnest(coalesce(p_columns, array[]::text[])) col
     where to_regclass('app.' || private.report_source_relation(d.source_code)) is not null),
    (select u.email::text from app.memberships m join app.people p on p.id = m.person_id join auth.users u on u.id = p.user_id
     where m.id = r.run_for_membership_id)
  from app.report_runs r
  join app.report_definitions d on d.id = r.report_definition_id
  where r.id = p_run_id and r.deleted_at is null;
$$;

comment on function app.report_run_classification(uuid, text[]) is 'Worker API (service role): the highest classification among the source columns a report run reads (as an export classifies them; Internal when none is listed) and the email of the person it runs for, so a report PDF classified Confidential or Restricted carries the Section 8.6 watermark.';
revoke all on function app.report_run_classification(uuid, text[]) from public, anon, authenticated;
grant execute on function app.report_run_classification(uuid, text[]) to service_role;

-- 7. Scheduling ---------------------------------------------------------------------------------------------------------

create or replace function private.request_export_render()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  if not exists (select 1 from app.job_queue q
                 where q.job_kind = 'export.render' and q.job_status = 'Queued' and q.run_after <= now() and q.deleted_at is null)
     and not exists (select 1 from app.export_jobs e
                     where e.export_status = 'Ready' and e.expires_at <= now() and e.deleted_at is null) then
    return;
  end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'xos_functions_url';
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'xos_worker_key';
  if v_url is null or v_key is null then
    return;
  end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/export-render',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

comment on function private.request_export_render() is 'pg_cron''s export step: when an export.render job is ready or an export file has expired, calls the export-render Edge Function with the service key from Vault (xos_worker_key) at the functions URL in Vault (xos_functions_url). Without either it does nothing and exports wait (infra/runbooks/production.md, Exports).';
revoke all on function private.request_export_render() from public, anon, authenticated;

select cron.schedule('xos_export_render', '* * * * *', 'select private.request_export_render()');
