-- 1126_report_run_formats.sql
-- A43 (RRR-87), finding A38-004. Report runs in every export format (Section 4.6.4): the report-run worker
-- (A35, 1050) rendered CSV only and failed XLSX and PDF runs with a message naming CSV. It now renders .xlsx
-- (exceljs) and PDF (pdfkit) too, so a run's file is <org_id>/<run_id>.<csv|xlsx|pdf> in report-results:
--   * private.report_result_path(org, run, format) names the file of each format; the two-argument form
--     stays for CSV;
--   * private.report_result_run accepts the three extensions, so the read policy covers every file;
--   * app.finish_report_run checks a finished run names the file of its own format;
--   * the bucket takes the three media types.

update storage.buckets
set allowed_mime_types = array['text/csv', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
where id = 'report-results';

create or replace function private.report_result_path(p_org_id uuid, p_run_id uuid, p_format app.export_format)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_org_id::text || '/' || p_run_id::text || '.' || lower(p_format::text);
$$;

comment on function private.report_result_path(uuid, uuid, app.export_format) is 'Object name of a report run''s file in report-results: <org_id>/<run_id>.<csv|xlsx|pdf>.';
revoke all on function private.report_result_path(uuid, uuid, app.export_format) from public, anon;
grant execute on function private.report_result_path(uuid, uuid, app.export_format) to authenticated, service_role;

create or replace function private.report_result_run(p_object_name text)
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

comment on function private.report_result_run(text) is 'Report run id of a report-results object (<org_id>/<run_id>.<csv|xlsx|pdf>), or NULL for any other name.';

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
    if p_storage_object_path is distinct from private.report_result_path(v_run.org_id, v_run.id, v_run.export_format) then
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

comment on function app.finish_report_run(uuid, app.run_status, text, integer, integer, text) is 'Worker API (service role): records a report run''s outcome. Succeeded needs the result file of the run''s own format (CSV, .xlsx or PDF) and its counts; Failed and Queued (a retry) need the error.';
