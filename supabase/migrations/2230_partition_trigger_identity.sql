-- 2230_partition_trigger_identity.sql
-- A130 (RRR-175), trace row S5.1-07, Section 5.1: the shared trigger functions name the table a row trigger was
-- declared on, not the partition it runs on. On a partitioned table each row trigger runs on the month partition, so
-- TG_TABLE_NAME, TG_TABLE_SCHEMA and TG_RELID answer private.access_scans_p202610 rather than app.access_scans. That
-- is the precondition infra/db/README.md set before app.time_entries can be partitioned (2231):
--   * private.audit_row_change writes the action as <table>.<op> and the subject as <schema>.<table>, and looks up
--     the Restricted columns to leave out of the diff by table. On a partition it would write
--     time_entries_p202610.update, subject private.time_entries_p202610, and carry Restricted columns into the diff.
--   * private.guard_engaged_worker refuses with <table>_worker_immutable and tells shifts from time by table name.
--   * private.refuse_ledger_change, refuse_org_change, refuse_cross_org_reference, derive_org_id and
--     assert_same_project name the table in their refusal messages (the codes never named it).
--
-- private.trigger_table resolves a partition to its parent through pg_class.relispartition and pg_inherits (to the
-- root, should a partition ever be partitioned again) and returns any other table as itself. Each body below is the
-- latest definition (audit_row_change and refuse_ledger_change 1270, guard_engaged_worker 0940, refuse_org_change,
-- refuse_cross_org_reference and derive_org_id 0200, assert_same_project 0350) with only the table identity changed.
-- The refusal helpers resolve the name on the refusal path alone, so a row that passes pays nothing. Tables that are
-- not partitioned behave exactly as before; on the partitioned tables (A18's six and access_scans since 1511) the
-- refusal messages name the table again, as they did before 1511. Other packages must not redefine these functions
-- without keeping the resolution: pgTAP 2230 fails when a body stops calling private.trigger_table.

create or replace function private.trigger_table(p_relid oid)
returns regclass
language sql
stable
security definer
set search_path = ''
as $$
  with recursive up (relid, is_partition) as (
    select c.oid, c.relispartition from pg_catalog.pg_class c where c.oid = p_relid
    union all
    select i.inhparent, p.relispartition
    from up
    join pg_catalog.pg_inherits i on i.inhrelid = up.relid
    join pg_catalog.pg_class p on p.oid = i.inhparent
    where up.is_partition
  )
  select up.relid::regclass from up where not up.is_partition;
$$;

comment on function private.trigger_table(oid) is 'Table a row trigger belongs to, given TG_RELID: a partition resolves to its partitioned parent (pg_class.relispartition and pg_inherits, up to the root); any other table is itself. Shared trigger functions name, audit and refuse by this table, so a partitioned table keeps the identity it had as a plain table.';

revoke all on function private.trigger_table(oid) from public, anon, authenticated;

create or replace function private.trigger_table_name(p_relid oid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.relname::text from pg_catalog.pg_class c where c.oid = private.trigger_table(p_relid);
$$;

comment on function private.trigger_table_name(oid) is 'Unqualified name of private.trigger_table(TG_RELID): what TG_TABLE_NAME says on a plain table, and the parent''s name on a partition.';

revoke all on function private.trigger_table_name(oid) from public, anon, authenticated;

-- Audit trail (latest: 1270) -----------------------------------------------------------------------------------------

create or replace function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table regclass := private.trigger_table(tg_relid);
  v_schema text := tg_table_schema;
  v_name text := tg_table_name;
  v_excluded text[] := private.audit_excluded_columns(v_table);
  v_old jsonb;
  v_new jsonb;
  v_diff jsonb;
  v_row jsonb;
  v_key text;
begin
  if private.in_trusted_operation('retention_purge') then
    return null;
  end if;
  if v_table <> tg_relid::regclass then
    select n.nspname, c.relname into v_schema, v_name
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.oid = v_table;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := to_jsonb(old) - v_excluded;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := to_jsonb(new) - v_excluded;
  end if;
  v_row := coalesce(to_jsonb(new), to_jsonb(old));
  if (v_row ->> 'org_id') is null then
    return null;
  end if;
  if private.in_tenant_purge((v_row ->> 'org_id')::uuid) then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    v_diff := jsonb_build_object('old', '{}'::jsonb, 'new', '{}'::jsonb);
    for v_key in select k from jsonb_object_keys(v_new) k loop
      if (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_diff := jsonb_set(v_diff, array['old', v_key], coalesce(v_old -> v_key, 'null'::jsonb));
        v_diff := jsonb_set(v_diff, array['new', v_key], v_new -> v_key);
      end if;
    end loop;
    if v_diff -> 'new' = '{}'::jsonb then
      return null;
    end if;
  elsif tg_op = 'INSERT' then
    v_diff := jsonb_build_object('new', v_new);
  else
    v_diff := jsonb_build_object('old', v_old);
  end if;
  perform private.write_audit_event((v_row ->> 'org_id')::uuid, v_name || '.' || lower(tg_op), v_schema || '.' || v_name,
    (v_row ->> 'id')::uuid, v_diff);
  return null;
end;
$$;

comment on function private.audit_row_change() is 'After insert, update or delete trigger: writes the row change to the audit ledger with a diff that leaves out audit columns, hashes and Restricted columns. Rows without an org, purge deletes and changes to a purged org''s rows (private.begin_tenant_purge) are not audited. On a partitioned table the action, subject and excluded columns are the parent table''s (private.trigger_table).';

revoke all on function private.audit_row_change() from public, anon, authenticated;

-- Worker guard (latest: 0940) ----------------------------------------------------------------------------------------

create or replace function private.guard_engaged_worker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_table text;
begin
  if tg_op = 'UPDATE' and new.engagement_id is not distinct from old.engagement_id then
    return new;
  end if;
  v_table := private.trigger_table_name(tg_relid);
  if tg_op = 'UPDATE' and v_table <> 'shifts' then
    perform private.refuse(v_table || '_worker_immutable', 'The worker of time never changes.');
  end if;
  if tg_op = 'UPDATE' and auth.uid() is not null and not private.can_on_project(new.project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required to reassign a shift';
  end if;
  if new.engagement_id is null then
    return new;
  end if;
  select * into v_engagement from app.engagements e where e.id = new.engagement_id;
  if v_engagement.person_id is null then
    perform private.refuse('engagement_worker_person', 'Time and shifts go to an engagement that names the person who works.');
  end if;
  if v_table <> 'shifts' and v_engagement.engagement_state not in ('Active', 'Closing') then
    perform private.refuse('engagement_not_working', 'External crew record time only while their engagement is Active or Closing.');
  end if;
  return new;
end;
$$;

comment on function private.guard_engaged_worker() is 'Shifts, time entries, timesheets and punches worked through an engagement: the engagement names a person, new time needs it Active or Closing, the worker of time never changes, and only shift writers reassign a shift to an engagement. Tables are told apart, and the refusal code named, by the parent table on a partition (private.trigger_table_name).';
revoke all on function private.guard_engaged_worker() from public, anon, authenticated;

-- Refusal helpers ----------------------------------------------------------------------------------------------------

-- Latest: 1270.
create or replace function private.refuse_ledger_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and (private.in_trusted_operation('retention_purge')
                           or private.in_tenant_purge((to_jsonb(old) ->> 'org_id')::uuid)) then
    return old;
  end if;
  perform private.refuse('append_only', format('%s is an append-only ledger.', private.trigger_table_name(tg_relid)));
  return null;
end;
$$;

comment on function private.refuse_ledger_change() is 'Before update or delete trigger on append-only ledgers: refuses the change, except deletes by the retention purge job once a row is past its retention period and deletes of a purged org''s rows (private.begin_tenant_purge). The refusal names the parent table on a partition.';
revoke all on function private.refuse_ledger_change() from public, anon, authenticated;

-- Latest: 0200.
create or replace function private.refuse_org_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is distinct from old.org_id then
    perform private.refuse('tenant_move', format('%s rows cannot move to another org.', private.trigger_table_name(tg_relid)));
  end if;
  return new;
end;
$$;

comment on function private.refuse_org_change() is 'Before update trigger: refuses any change of org_id (Section 7.5 invariant 1). The refusal names the parent table on a partition.';
revoke all on function private.refuse_org_change() from public, anon, authenticated;

-- Latest: 0200.
create or replace function private.refuse_cross_org_reference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_org_id uuid := (v_row ->> 'org_id')::uuid;
  v_ref_id uuid;
  v_ref_org uuid;
  v_found boolean;
  i integer := 0;
begin
  while i < tg_nargs loop
    v_ref_id := (v_row ->> tg_argv[i + 1])::uuid;
    if v_ref_id is not null then
      v_found := false;
      execute format('select org_id, true from %s where id = $1', tg_argv[i])
        into v_ref_org, v_found
        using v_ref_id;
      if v_found is not true then
        raise exception using errcode = '23503',
          message = format('%s.%s references a missing %s row', private.trigger_table_name(tg_relid), tg_argv[i + 1], tg_argv[i]);
      end if;
      if v_ref_org is not null and v_ref_org is distinct from v_org_id then
        perform private.refuse('cross_org_reference',
          format('%s.%s points to a row of another org.', private.trigger_table_name(tg_relid), tg_argv[i + 1]));
      end if;
    end if;
    i := i + 2;
  end loop;
  return new;
end;
$$;

comment on function private.refuse_cross_org_reference() is 'Before insert or update trigger: refuses a foreign key into another org (Section 7.5 invariant 1). Arguments are pairs of referenced table and referencing column. The refusal names the parent table on a partition.';
revoke all on function private.refuse_cross_org_reference() from public, anon, authenticated;

-- Latest: 0200.
create or replace function private.derive_org_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_table text := tg_argv[0];
  v_parent_column text := tg_argv[1];
  v_parent_id uuid := (to_jsonb(new) ->> v_parent_column)::uuid;
  v_org_id uuid;
  v_found boolean := false;
begin
  if v_parent_id is null then
    raise exception using errcode = '23502',
      message = format('%s.%s is required to derive org_id', private.trigger_table_name(tg_relid), v_parent_column);
  end if;
  execute format('select org_id, true from %s where id = $1', v_parent_table)
    into v_org_id, v_found
    using v_parent_id;
  if v_found is not true then
    raise exception using errcode = '23503',
      message = format('%s.%s references a missing %s row', private.trigger_table_name(tg_relid), v_parent_column, v_parent_table);
  end if;
  new := jsonb_populate_record(new, jsonb_build_object('org_id', v_org_id));
  return new;
end;
$$;

comment on function private.derive_org_id() is 'Before insert or update trigger: sets org_id from the parent row named by the trigger arguments (parent table, parent id column). Never trusts a caller-supplied org_id. The refusal names the parent table on a partition.';
revoke all on function private.derive_org_id() from public, anon, authenticated;

-- Latest: 0350.
create or replace function private.assert_same_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_project uuid := (v_row ->> 'project_id')::uuid;
  v_other uuid;
  i integer := 0;
begin
  while i < tg_nargs loop
    if (v_row ->> tg_argv[i + 1]) is not null then
      execute format('select project_id from %s where id = $1', tg_argv[i]) into v_other using (v_row ->> tg_argv[i + 1])::uuid;
      if v_other is distinct from v_project then
        perform private.refuse('same_project',
          format('%s.%s points to a row of another project.', private.trigger_table_name(tg_relid), tg_argv[i + 1]));
      end if;
    end if;
    i := i + 2;
  end loop;
  return new;
end;
$$;

comment on function private.assert_same_project() is 'Before insert or update trigger: refuses references into another project. Arguments are pairs of referenced table and referencing column. The refusal names the parent table on a partition.';
revoke all on function private.assert_same_project() from public, anon, authenticated;
