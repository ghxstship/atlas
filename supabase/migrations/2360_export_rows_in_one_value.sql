-- 2360_export_rows_in_one_value.sql
--
-- Export rows in one value (ADR 0022, 2360-2369), A102, RRR-146; a fix of 2030. app.export_job_rows returned
-- setof jsonb, and PostgREST caps every set-returning function at max_rows (1,000 in supabase/config.toml and on
-- hosted Supabase). The export.render worker (packages/data export-renders.ts) asks for at most 50,001 rows (a CSV
-- or .xlsx; 2,001 for a PDF) in one call, so any export of more than 1,000 rows came back with exactly 1,000: the
-- file had no truncation note and the export recorded 1,000 rows.
--
-- The function now returns one jsonb array of at most p_limit rows, which PostgREST does not cap. It is recreated
-- from its 2030 definition with the same arguments, reads and refusals; the rows are numbered in the sort order and
-- aggregated in it, and the sort ends with the source's id when it has one, so rows that tie on every exported
-- column keep one order. The requester's role and claims are put back before the rows are returned. Still stable
-- (a read replica serves it on a GET), security invoker and granted to the service role alone.

drop function app.export_job_rows(uuid, integer);

/*
 * Security invoker on purpose, as 1050's app.report_run_rows: called by the service role (granted to it alone), it
 * switches to the authenticated role with the requester as the JWT subject for the one query, so their row level
 * security and grants decide every row and column. Stable, so PostgREST runs it read-only on a GET and a read replica
 * serves it (1512). Reads the export's recorded columns in order, scoped to its org (org_id, or project_id within the
 * org; canon has neither), without soft-deleted rows, with its eq and in filters and its search across the exported columns.
 */
create or replace function app.export_job_rows(p_export_job_id uuid, p_limit integer)
returns jsonb
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
  v_rows jsonb;
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
  -- Then by the source's id when it has one, so rows that tie on every exported column keep one order.
  if exists (select 1 from pg_catalog.pg_attribute a join pg_catalog.pg_type t on t.oid = a.atttypid
             where a.attrelid = v_class and a.attname = 'id' and a.attnum > 0 and not a.attisdropped
               and t.typcategory in ('N', 'S', 'U')) then
    v_order := coalesce(v_order || ', ', '') || 's.id';
  end if;
  -- One jsonb array, numbered in the sort order and aggregated in it: PostgREST caps a set-returning function at
  -- max_rows (1,000), so the rows leave as one value.
  v_sql := format(
    'select coalesce(jsonb_agg(w.r order by w.n), ''[]''::jsonb) from (select to_jsonb(c) as r, row_number() over (%s) as n'
      || ' from %s s cross join lateral (select %s) c where %s%s limit %s) w',
    case when v_order is null then '' else 'order by ' || v_order end,
    v_class::text,
    (select string_agg(format('s.%I', c), ', ' order by n) from unnest(v_columns) with ordinality as x (c, n)),
    coalesce(nullif(array_to_string(v_where, ' and '), ''), 'true'),
    case when v_order is null then '' else ' order by ' || v_order end,
    least(greatest(coalesce(p_limit, 1), 1), 100001)
  );

  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute v_sql into v_rows;
  perform set_config('role', v_role, true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v_rows;
end;
$$;

comment on function app.export_job_rows(uuid, integer) is 'Worker API (service role): the rows of an export being rendered, read as the person who asked for it (their row level security and grants): its recorded columns in order, scoped to its org, without deleted rows, with its eq, in and search filters, sorted by its columns (then its id), at most p_limit rows, as one jsonb array so PostgREST''s max_rows never cuts it. Stable, so a read replica serves it.';
revoke all on function app.export_job_rows(uuid, integer) from public, anon, authenticated;
grant execute on function app.export_job_rows(uuid, integer) to service_role;
