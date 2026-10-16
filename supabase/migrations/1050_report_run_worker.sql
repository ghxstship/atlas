-- 1050_report_run_worker.sql
-- A35 (RRR-79). A18 queued a report.run job for every report run (0550 app.run_report), but nothing
-- processed them, so runs stayed Queued (finding of A33). The worker (packages/data report-runs, the
-- report-run Edge Function) claims report.run jobs from the 0510 queue and, for each:
--   1. app.start_report_run moves the run from Queued to Running;
--   2. app.report_run_rows reads the source rows as the person the run is for: it takes their identity
--      (request.jwt.claims) and the authenticated role for the one query, so row level security and
--      column grants apply exactly as in the builder preview, never the service role's reach;
--   3. the worker aggregates the rows as the preview does, writes CSV to the private report-results
--      bucket at <org_id>/<run_id>.csv and app.finish_report_run records Succeeded with the file and
--      its counts, Failed with the error, or Queued again while the job has attempts left.
-- Only the person a run is for reads its file (report-results storage policy, the same rule as
-- app.report_runs). XLSX and PDF runs fail with a message naming CSV until a renderer exists.
-- The storage helper takes the object name as a value and never re-reads storage.objects (ADR 0016
-- rule 14).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-results', 'report-results', false, 52428800, array['text/csv'])
on conflict (id) do nothing;

-- The object name of a run's result file.
create or replace function private.report_result_path(p_org_id uuid, p_run_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_org_id::text || '/' || p_run_id::text || '.csv';
$$;

comment on function private.report_result_path(uuid, uuid) is 'Object name of a report run''s CSV in report-results: <org_id>/<run_id>.csv.';
revoke all on function private.report_result_path(uuid, uuid) from public, anon;
grant execute on function private.report_result_path(uuid, uuid) to authenticated, service_role;

-- The run a report-results object belongs to, or NULL for any other name.
create or replace function private.report_result_run(p_object_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(p_object_name, '/');
begin
  if coalesce(array_length(v_parts, 1), 0) <> 2 or v_parts[2] !~ '^[0-9a-f-]{36}\.csv$' then
    return null;
  end if;
  return left(v_parts[2], 36)::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

comment on function private.report_result_run(text) is 'Report run id of a report-results object (<org_id>/<run_id>.csv), or NULL for any other name.';
revoke all on function private.report_result_run(text) from public, anon;
grant execute on function private.report_result_run(text) to authenticated, service_role;

create policy report_results_read on storage.objects for select to authenticated
  using (bucket_id = 'report-results'
    and private.report_result_run(name) in (
      select r.id from app.report_runs r
      where r.deleted_at is null and r.storage_object_path = name
        and r.run_for_membership_id in (select private.my_membership_ids())));

-- Run lifecycle ---------------------------------------------------------------------------------------------

create or replace function app.start_report_run(p_run_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status app.run_status;
begin
  select r.run_status into v_status from app.report_runs r
  where r.id = p_run_id and r.deleted_at is null for update;
  if v_status is null then
    perform private.refuse('report_run_missing', 'The report run does not exist.');
  end if;
  if v_status <> 'Queued' then
    perform private.refuse('report_run_not_queued', 'Only a queued report run can start.');
  end if;
  update app.report_runs set run_status = 'Running', started_at = now(), last_error = null
  where id = p_run_id;
end;
$$;

comment on function app.start_report_run(uuid) is 'Worker API (service role): moves a report run from Queued to Running.';
revoke all on function app.start_report_run(uuid) from public, anon, authenticated;
grant execute on function app.start_report_run(uuid) to service_role;

create or replace function app.finish_report_run(
  p_run_id uuid,
  p_outcome app.run_status,
  p_storage_object_path text default null,
  p_row_count integer default null,
  p_unpriced_count integer default null,
  p_error text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.report_runs;
begin
  select * into v_run from app.report_runs r where r.id = p_run_id and r.deleted_at is null for update;
  if v_run.id is null then
    perform private.refuse('report_run_missing', 'The report run does not exist.');
  end if;
  if v_run.run_status <> 'Running' then
    perform private.refuse('report_run_not_running', 'Only a running report run can finish.');
  end if;
  if p_outcome = 'Succeeded' then
    if p_storage_object_path is distinct from private.report_result_path(v_run.org_id, v_run.id) then
      perform private.refuse('report_run_result_path', 'A finished run names its own result file.');
    end if;
    if p_row_count is null or p_row_count < 0 or p_unpriced_count is null or p_unpriced_count < 0 then
      perform private.refuse('report_run_counts', 'A finished run records its row and unpriced counts.');
    end if;
    update app.report_runs set run_status = 'Succeeded', finished_at = now(),
      storage_object_path = p_storage_object_path, row_count = p_row_count,
      unpriced_count = p_unpriced_count, last_error = null
    where id = p_run_id;
  elsif p_outcome in ('Failed', 'Queued') then
    if p_error is null or btrim(p_error) = '' then
      perform private.refuse('report_run_error', 'A failed attempt records why it failed.');
    end if;
    update app.report_runs set run_status = p_outcome,
      finished_at = case when p_outcome = 'Failed' then now() end,
      last_error = left(p_error, 2000)
    where id = p_run_id;
  else
    perform private.refuse('report_run_outcome', 'A run finishes as Succeeded or Failed, or goes back to Queued for a retry.');
  end if;
end;
$$;

comment on function app.finish_report_run(uuid, app.run_status, text, integer, integer, text) is 'Worker API (service role): records a report run''s outcome. Succeeded needs its own result file and counts; Failed and Queued (a retry) need the error.';
revoke all on function app.finish_report_run(uuid, app.run_status, text, integer, integer, text) from public, anon, authenticated;
grant execute on function app.finish_report_run(uuid, app.run_status, text, integer, integer, text) to service_role;

-- Reading as the person ------------------------------------------------------------------------------------

-- The relation each report source reads (the same map as packages/data report-builder REPORT_SOURCES).
create or replace function private.report_source_relation(p_source_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_source_code
    when 'records' then 'records'
    when 'finance' then 'budget_line_facts'
    when 'crew' then 'shifts'
    when 'procurement' then 'purchase_order_totals'
    when 'assets' then 'asset_units'
    when 'incidents' then 'incidents'
    when 'custom_object' then 'custom_object_records'
  end;
$$;

comment on function private.report_source_relation(text) is 'Relation in schema app that a report source reads.';
revoke all on function private.report_source_relation(text) from public, anon, authenticated;
grant execute on function private.report_source_relation(text) to service_role;

/*
 * Security invoker on purpose: it is called by the service role (granted to it alone) and switches to
 * the authenticated role with the run's person as the JWT subject for the one query, so the person's
 * row level security and grants decide every row and column. A definer function would read as its
 * owner and bypass row level security.
 */
create or replace function app.report_run_rows(p_run_id uuid, p_columns text[], p_limit integer)
returns setof jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_run app.report_runs;
  v_def app.report_definitions;
  v_user uuid;
  v_relation text;
  v_has_org boolean;
  v_has_deleted boolean;
  v_where text[] := array[]::text[];
  v_filter record;
  v_list text;
  v_column text;
  v_role text := current_user;
  v_claims text := current_setting('request.jwt.claims', true);
  v_sql text;
begin
  select * into v_run from app.report_runs r where r.id = p_run_id and r.deleted_at is null;
  if v_run.id is null then
    perform private.refuse('report_run_missing', 'The report run does not exist.');
  end if;
  if v_run.run_status <> 'Running' then
    perform private.refuse('report_run_not_running', 'Rows are read only for a running report run.');
  end if;
  select * into v_def from app.report_definitions d where d.id = v_run.report_definition_id;
  v_relation := private.report_source_relation(v_def.source_code);
  if v_relation is null then
    perform private.refuse('report_source_unknown', 'The report''s source cannot be read.');
  end if;
  if p_columns is null or cardinality(p_columns) = 0 or cardinality(p_columns) > 100 then
    perform private.refuse('report_columns', 'Name between 1 and 100 columns.');
  end if;
  foreach v_column in array p_columns loop
    if not exists (
      select 1 from pg_catalog.pg_attribute a
      where a.attrelid = ('app.' || v_relation)::regclass and a.attname = v_column
        and a.attnum > 0 and not a.attisdropped
    ) then
      perform private.refuse('report_column_unknown', format('The source has no column %s.', v_column));
    end if;
  end loop;
  select p.user_id into v_user from app.memberships m join app.people p on p.id = m.person_id
  where m.id = v_run.run_for_membership_id;
  if v_user is null then
    perform private.refuse('report_run_person', 'The person the run is for has no sign-in.');
  end if;

  select exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = ('app.' || v_relation)::regclass
                 and a.attname = 'org_id' and not a.attisdropped),
         exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = ('app.' || v_relation)::regclass
                 and a.attname = 'deleted_at' and not a.attisdropped)
  into v_has_org, v_has_deleted;
  v_where := v_where || case when v_has_org
    then format('s.org_id = %L', v_run.org_id)
    else format('s.project_id in (select p.id from app.projects p where p.org_id = %L and p.deleted_at is null)', v_run.org_id)
  end;
  if v_has_deleted then
    v_where := v_where || 's.deleted_at is null'::text;
  end if;
  if v_def.source_code = 'custom_object' then
    v_where := v_where || format('s.custom_object_type_id = %L', v_def.custom_object_type_id);
  end if;
  -- Filters on catalog columns only, the same as the preview.
  for v_filter in
    select f.field, f.operator, f.value_text from app.report_filters f
    where f.report_definition_id = v_def.id and f.deleted_at is null and f.field = any (p_columns)
  loop
    if v_filter.operator = 'in' then
      select string_agg(format('%L', btrim(x)), ', ') into v_list
      from unnest(string_to_array(v_filter.value_text, ',')) x where btrim(x) <> '';
    end if;
    v_where := v_where || case v_filter.operator
      when 'eq' then format('s.%I::text = %L', v_filter.field, v_filter.value_text)
      when 'ne' then format('s.%I::text is distinct from %L', v_filter.field, v_filter.value_text)
      when 'lt' then format('s.%I < %L', v_filter.field, v_filter.value_text)
      when 'lte' then format('s.%I <= %L', v_filter.field, v_filter.value_text)
      when 'gt' then format('s.%I > %L', v_filter.field, v_filter.value_text)
      when 'gte' then format('s.%I >= %L', v_filter.field, v_filter.value_text)
      when 'in' then case when v_list is null then 'false' else format('s.%I::text in (%s)', v_filter.field, v_list) end
      when 'is_null' then format('s.%I is null', v_filter.field)
      when 'contains' then format('s.%I::text ilike %L', v_filter.field,
        '%' || regexp_replace(coalesce(v_filter.value_text, ''), '[%_]', '', 'g') || '%')
    end;
  end loop;
  v_sql := format(
    'select to_jsonb(q) from (select %s from app.%I s where %s limit %s) q',
    (select string_agg(format('s.%I', c), ', ') from unnest(p_columns) c),
    v_relation,
    array_to_string(v_where, ' and '),
    least(greatest(coalesce(p_limit, 1), 1), 100000)
  );

  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  return query execute v_sql;
  perform set_config('role', v_role, true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
end;
$$;

comment on function app.report_run_rows(uuid, text[], integer) is 'Worker API (service role): the source rows of a running report run, read as the person it runs for (their row level security and grants), with the definition''s org scope and filters, at most p_limit rows.';
revoke all on function app.report_run_rows(uuid, text[], integer) from public, anon, authenticated;
grant execute on function app.report_run_rows(uuid, text[], integer) to service_role;
