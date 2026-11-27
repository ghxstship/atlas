-- The nightly retention job completes (release 4.19; Section 7.1, Section 14.3; ADR 0002).
-- Defect: private.purge_table (0500) read and deleted every table by a column named id. The 26 app.record_*
-- tables are keyed by record_id and have no id column, and each has a Delete retention policy, so the first of
-- them (app.record_approval) raised "column t.id does not exist". Nothing caught it, so the error ended
-- private.run_nightly_retention for the night: the row purge deleted nothing, and the rate limit pruning that
-- follows it never ran. In production the job xos_nightly_retention failed on every night from 2026-10-17 and
-- never completed.
--
-- Two changes, both to private.purge_table. Signature, privileges, the batch size, the legal hold rule, the
-- retention_purge trusted operation and the "N expired rows kept" record are as 0500 left them.
--   1. Rows are read and deleted by the table's primary key, whatever its columns are called: id on most tables,
--      record_id on the record tables, (id, created_at) on app.time_entries.
--   2. The whole table step runs in its own subtransaction, as the 0500 header always said it did. A table the
--      purge cannot read is recorded in private.retention_runs with its error and the purge moves on to the next
--      table; one table no longer stops the night. The step is retried on the next run.

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
  v_key text[];
  v_select text;
  v_delete text;
  v_row jsonb;
  v_count bigint := 0;
  v_blocked bigint := 0;
  v_error text;
begin
  select * into v_policy from private.retention_policies r where r.table_name = p_table;
  if v_policy.table_name is null or v_policy.purge_method <> 'Delete' then
    return 0;
  end if;
  begin
    select array_agg(a.attname::text order by k.ord) into v_key
    from pg_catalog.pg_index i
    cross join lateral unnest(i.indkey::smallint[]) with ordinality k(attnum, ord)
    join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
    where i.indrelid = p_table::regclass and i.indisprimary;
    if v_key is null then
      raise exception '% has no primary key to purge by.', p_table using errcode = '55000';
    end if;
    v_has_org := exists (
      select 1 from pg_catalog.pg_attribute a where a.attrelid = p_table::regclass and a.attname = 'org_id' and not a.attisdropped);
    -- One expired row's key per result row, as JSON, so a key of any column names and types reads the same way.
    v_select := format('select to_jsonb(k) from (select %s from %s t where t.%I < now() - $1',
      (select string_agg(format('t.%I', c), ', ') from unnest(v_key) c), p_table, v_policy.time_column);
    if v_policy.basis = 'Soft Deleted' then
      v_select := v_select || ' and t.deleted_at is not null';
    end if;
    if v_has_org then
      v_select := v_select || ' and t.org_id not in (select private.held_org_ids($2))';
    end if;
    v_select := v_select || format(' order by %s limit $3) k',
      (select string_agg(format('t.%I', c), ', ') from unnest(v_key) c));
    -- The key goes back through the table's own row type, so each column compares in its own type and the
    -- primary key index finds the row.
    v_delete := format('delete from %1$s t using jsonb_populate_record(null::%1$s, $1) k where %2$s', p_table,
      (select string_agg(format('t.%1$I = k.%1$I', c), ' and ') from unnest(v_key) c));
    perform private.begin_trusted_operation('retention_purge');
    for v_row in execute v_select using v_policy.retention, p_table, p_batch loop
      begin
        execute v_delete using v_row;
        v_count := v_count + 1;
      exception when others then
        v_blocked := v_blocked + 1;
        v_error := sqlerrm;
      end;
    end loop;
    perform private.end_trusted_operation('retention_purge');
  exception when others then
    -- The subtransaction has undone this table's deletes and its trusted operation marker.
    insert into private.retention_runs (table_name, action, rows_affected, error_message)
    values (p_table, 'purge', 0, sqlerrm);
    return 0;
  end;
  insert into private.retention_runs (table_name, action, rows_affected, error_message)
  values (p_table, 'purge', v_count,
    case when v_blocked > 0 then format('%s expired rows kept: %s', v_blocked, v_error) end);
  return v_count;
end;
$$;

comment on function private.purge_table(text, integer) is 'Deletes up to p_batch rows of a table past retention by its primary key, one row per subtransaction, skipping orgs under legal hold. A row that cannot go yet (still referenced by a younger row) is kept, counted and recorded in private.retention_runs, and retried on the next run. The table step runs in its own subtransaction: a table the purge cannot read is recorded with its error and returns 0, so the nightly job goes on to the next table.';

revoke all on function private.purge_table(text, integer) from public, anon, authenticated;
