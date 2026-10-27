-- 2381_export_filter_null_tests_rules.sql
--
-- Exports keep the filters a page applies by default (2380-2389), A102, RRR-146, review finding 3; the null tests
-- 2380 added to app.export_filter_operator, now usable. Atlas's export plan (apps/atlas lib/views/export-sources.ts)
-- sends {"operator":"is_null","column":"archived_at"} for Projects unless the page shows archived projects too
-- (?archived=1), so the file holds the rows the page lists. This migration:
--   * lets an export filter carry no value: is_null and not_null name a column and compare no value, and every other
--     filter still has a value of 1 to 1000 characters (export_job_filters_value);
--   * recreates app.request_export (the overload with headers and filters) from 2030 with every rule and refusal
--     message kept, accepting is_null and not_null with a column of the source and no value. Their column counts
--     toward the classification like any filtered column, since the null test discloses whether it is set;
--   * recreates app.export_job_rows from 2030 with every rule kept, rendering is_null and not_null as
--     "<column> is null" and "<column> is not null" after the same check that the column still exists. Before this, a
--     filter that was not eq or in fell through to the search branch.

-- 1. A filter without a value ----------------------------------------------------------------------------------------

alter table app.export_job_filters alter column value_text drop not null;
alter table app.export_job_filters
  add constraint export_job_filters_value check ((filter_operator in ('is_null', 'not_null')) = (value_text is null));

comment on column app.export_job_filters.column_name is 'Column of the export''s source an eq, in, is_null or not_null filter compares; null for search.';
comment on column app.export_job_filters.filter_operator is 'eq, in, search, is_null or not_null.';
comment on column app.export_job_filters.value_text is 'Value compared as text, the comma-separated values of an in filter, or the text searched for; null for is_null and not_null, which compare none.';

-- 2. Requesting an export (from 2030) --------------------------------------------------------------------------------

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
    if jsonb_typeof(v_filter) <> 'object'
       or coalesce(v_filter ->> 'operator', '') not in ('eq', 'in', 'search', 'is_null', 'not_null') then
      perform private.refuse('export_filters', 'Each filter has an operator (eq, in, search, is_null or not_null).');
    end if;
    if v_filter ->> 'operator' in ('is_null', 'not_null') then
      if v_filter ? 'value' and jsonb_typeof(v_filter -> 'value') <> 'null' then
        perform private.refuse('export_filters', 'An is_null or not_null filter compares no value.');
      end if;
    elsif jsonb_typeof(v_filter -> 'value') is distinct from 'string'
       or char_length(v_filter ->> 'value') not between 1 and 1000 then
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
  select v_id, case when f ->> 'operator' <> 'search' then f ->> 'column' end, (f ->> 'operator')::app.export_filter_operator,
         case when f ->> 'operator' not in ('is_null', 'not_null') then f ->> 'value' end
  from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb)) f;
  perform private.enqueue_job(p_org_id, 'export.render', v_id);
  return v_id;
end;
$$;

comment on function app.request_export(uuid, app.export_format, text, text[], text[], jsonb) is 'Requests an export (Section 4.6.4, 8.6) of columns of one table or view (app, or xpms for canon), with their headers (null for column names) and filters ([{"operator":"eq" or "in","column":...,"value":...}, {"operator":"is_null" or "not_null","column":...} or {"operator":"search","value":...}], an in value comma-separated; null for none). Public and Internal data for members, Confidential with data.export.confidential, Restricted with data.export.restricted and step-up (aal2); medical encounter data never, through any view. A view column is classified as the column it shows, an unlisted column is Internal, and a filtered column counts toward the classification. Records the columns, headers, filters, classification and watermark, and queues the render job.';
revoke all on function app.request_export(uuid, app.export_format, text, text[], text[], jsonb) from public, anon;
grant execute on function app.request_export(uuid, app.export_format, text, text[], text[], jsonb) to authenticated, service_role;

-- 3. The worker's rows (from 2030) ---------------------------------------------------------------------------------

/*
 * Security invoker on purpose, as 1050's app.report_run_rows: called by the service role (granted to it alone), it
 * switches to the authenticated role with the requester as the JWT subject for the one query, so their row level
 * security and grants decide every row and column. Stable, so PostgREST runs it read-only on a GET and a read replica
 * serves it (1512). Reads the export's recorded columns in order, scoped to its org (org_id, or project_id within the
 * org; canon has neither), without soft-deleted rows, with its eq, in and null-test filters and its search across the exported columns.
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
    if v_filter.filter_operator in ('eq', 'in', 'is_null', 'not_null') then
      if not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = v_class and a.attname = v_filter.column_name and a.attnum > 0 and not a.attisdropped) then
        perform private.refuse('export_filter_column', format('%s has no column %s to filter on.', v_relation, v_filter.column_name));
      end if;
      if v_filter.filter_operator = 'is_null' then
        v_where := v_where || format('s.%I is null', v_filter.column_name);
      elsif v_filter.filter_operator = 'not_null' then
        v_where := v_where || format('s.%I is not null', v_filter.column_name);
      elsif v_filter.filter_operator = 'eq' then
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

comment on function app.export_job_rows(uuid, integer) is 'Worker API (service role): the rows of an export being rendered, read as the person who asked for it (their row level security and grants): its recorded columns in order, scoped to its org, without deleted rows, with its eq, in, is_null, not_null and search filters, sorted by its columns, at most p_limit rows. Stable, so a read replica serves it.';
revoke all on function app.export_job_rows(uuid, integer) from public, anon, authenticated;
grant execute on function app.export_job_rows(uuid, integer) to service_role;
