-- 1510_partition_existing_table.sql
-- A94 (RRR-139), finding A65-032, Section 5.1: monthly partitions for the last two of the eight tables. A18 created six
-- partitioned from the start (0500 to 0520); app.time_entries and app.access_scans (A03) are plain tables and need
-- converting. This is A26's reviewed proposal infra/db/proposals/01_partition_existing_table.sql with the three A94
-- additions below. 1511 converts app.access_scans. app.time_entries waits: its audit trail and its worker guard name
-- the table through TG_TABLE_NAME and TG_RELID, which a partition answers with its own name, so the shared trigger
-- functions must first resolve a partition to its parent (infra/db/README.md). Production holds no tenant rows yet
-- (demo data removed 2026-10-20), so the copy step moves only staging and local rows.
--
-- Postgres cannot partition a table in place. The procedure converts one in a single transaction, keeping everything
-- the table had:
--   * columns, defaults, not-null and check constraints, generated and identity columns, comments;
--   * the primary key, widened to (id, <partition column>) because a partitioned table's unique keys must include the
--     partition key; other unique indexes must already include it (refused otherwise);
--   * every other index, outgoing foreign key, trigger, row level security policy, table and column grant;
--   * every view that reads the table, recreated with its options, comment and grants;
--   * incoming foreign keys, which become composite: the referencing table gains <fk>_<partition column>, backfilled,
--     filled on insert by a trigger, and the key references (id, <partition column>);
--   * the rows, copied before any trigger exists, so guards and audit trails do not fire on the copy.
-- The table is then registered with A18's maintenance (private.partitioned_tables), which creates future partitions
-- nightly. Retention policies are left as they are; switching one to 'Drop Partition' is a separate decision per table.
--
-- A94 adds three things to A26's proposal, so the converted tables refuse exactly what they refused before:
--   * id stays unique. The widened key (id, <partition column>) alone would let a second row reuse an id, for example
--     two concurrent replays of one client id through app.record_scan. private.guard_partitioned_id, the first
--     trigger on the table, takes a transaction lock on the id and refuses a taken one with 23505, as the old key did.
--   * a referencing row that names no existing row is refused with 23503, as the old foreign key did. A composite key
--     is not checked while one of its columns is null, and the fill trigger leaves the new column null when the
--     referenced row does not exist, so the fill trigger refuses it instead.
--   * incoming foreign keys with an ON DELETE or ON UPDATE action, or deferrable ones, are refused rather than
--     recreated without them.

-- The id guard: one row per id across every partition, with the same error the primary key on id gave.
create or replace function private.guard_partitioned_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text := tg_argv[0];
  v_taken boolean;
begin
  if tg_op = 'UPDATE' and new.id = old.id then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_table || ':' || new.id::text, 0));
  execute format('select exists (select 1 from %s t where t.id = $1)', v_table) into v_taken using new.id;
  if v_taken then
    raise exception using errcode = 'unique_violation',
      message = format('duplicate key value violates unique constraint "%s_pkey"', split_part(v_table, '.', 2)),
      detail = format('Key (id)=(%s) already exists.', new.id);
  end if;
  return new;
end;
$$;

comment on function private.guard_partitioned_id() is
  'Trigger for a table partitioned by private.partition_existing_table (argument: the parent table): keeps id unique across partitions, which the widened primary key (id, partition column) no longer does, and refuses a taken id with 23505 like the original key. A transaction lock on the id serializes concurrent inserts of one id.';

revoke all on function private.guard_partitioned_id() from public, anon, authenticated;

create or replace procedure private.partition_existing_table(
  p_table regclass,
  p_column text,
  p_premake smallint,
  p_maintenance_order integer
)
language plpgsql
set search_path = ''
as $proc$
declare
  v_schema text;
  v_name text;
  v_old text;
  v_qualified text := p_table::text;
  v_min timestamptz;
  v_month date;
  v_rec record;
  v_def text;
  v_views jsonb := '[]'::jsonb;
  v_incoming jsonb := '[]'::jsonb;
  v_policies jsonb := '[]'::jsonb;
  v_new_col text;
begin
  select n.nspname, c.relname into v_schema, v_name
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.oid = p_table;
  if v_schema <> 'app' then
    raise exception 'partition_existing_table: % is not in the app schema', v_qualified using errcode = 'XR001';
  end if;
  if (select c.relkind from pg_catalog.pg_class c where c.oid = p_table) <> 'r' then
    raise exception 'partition_existing_table: % is not a plain table', v_qualified using errcode = 'XR001';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = p_table and a.attname = p_column
                 and a.atttypid = 'timestamptz'::regtype and a.attnotnull and not a.attisdropped) then
    raise exception 'partition_existing_table: %.% must be a not null timestamptz', v_qualified, p_column using errcode = 'XR001';
  end if;
  for v_rec in
    select i.indexrelid::regclass as idx from pg_catalog.pg_index i
    where i.indrelid = p_table and i.indisunique and not i.indisprimary
      and not exists (select 1 from pg_catalog.pg_attribute a
                      where a.attrelid = p_table and a.attname = p_column and a.attnum = any (i.indkey))
  loop
    raise exception 'partition_existing_table: unique index % does not include %', v_rec.idx, p_column using errcode = 'XR001';
  end loop;

  execute format('lock table %s in access exclusive mode', v_qualified);
  v_old := v_name || '_unpartitioned';

  -- 1. Views that read the table: remember them, then drop them (recreated at the end).
  for v_rec in
    select distinct v.oid, format('%I.%I', vn.nspname, v.relname) as view_name,
           pg_catalog.pg_get_viewdef(v.oid) as def, v.reloptions, pg_catalog.obj_description(v.oid, 'pg_class') as note,
           v.relacl
    from pg_catalog.pg_depend d
    join pg_catalog.pg_rewrite r on r.oid = d.objid
    join pg_catalog.pg_class v on v.oid = r.ev_class
    join pg_catalog.pg_namespace vn on vn.oid = v.relnamespace
    where d.refobjid = p_table and v.oid <> p_table and v.relkind = 'v'
  loop
    v_views := v_views || jsonb_build_object('name', v_rec.view_name, 'def', v_rec.def,
      'options', coalesce(array_to_string(v_rec.reloptions, ', '), ''), 'note', v_rec.note,
      'acl', (select coalesce(jsonb_agg(jsonb_build_object('grantee', coalesce(g.rolname, 'public'), 'privilege', x.privilege_type)), '[]'::jsonb)
              from aclexplode(v_rec.relacl) x left join pg_catalog.pg_roles g on g.oid = x.grantee));
    execute format('drop view %s', v_rec.view_name);
  end loop;

  -- 1b. Policies on other tables whose expressions read this table: remember them, then drop them.
  for v_rec in
    select distinct p.oid, p.polname, p.polrelid::regclass as rel, p.polpermissive, p.polcmd,
           (select string_agg(case when r = 0 then 'public' else quote_ident(g.rolname) end, ', ')
            from unnest(p.polroles) r left join pg_catalog.pg_roles g on g.oid = r) as roles,
           pg_catalog.pg_get_expr(p.polqual, p.polrelid) as qual,
           pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) as with_check
    from pg_catalog.pg_depend d
    join pg_catalog.pg_policy p on p.oid = d.objid and d.classid = 'pg_catalog.pg_policy'::regclass
    where d.refobjid = p_table and p.polrelid <> p_table
  loop
    v_policies := v_policies || jsonb_build_object('sql', format('create policy %I on %s as %s for %s to %s%s%s',
      v_rec.polname, v_rec.rel,
      case when v_rec.polpermissive then 'permissive' else 'restrictive' end,
      case v_rec.polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update' when 'd' then 'delete' else 'all' end,
      v_rec.roles,
      case when v_rec.qual is null then '' else format(' using (%s)', v_rec.qual) end,
      case when v_rec.with_check is null then '' else format(' with check (%s)', v_rec.with_check) end));
    execute format('drop policy %I on %s', v_rec.polname, v_rec.rel);
  end loop;

  -- 2. Incoming foreign keys: remember them, then drop them. Actions and deferral would be lost, so they are refused.
  if exists (select 1 from pg_catalog.pg_constraint con where con.confrelid = p_table and con.contype = 'f'
             and (con.confupdtype <> 'a' or con.confdeltype <> 'a' or con.condeferrable)) then
    raise exception 'partition_existing_table: % has an incoming foreign key with an action or deferral', v_qualified
      using errcode = 'XR001';
  end if;
  for v_rec in
    select con.conname, con.conrelid::regclass as child, a.attname as fk_col, a.attnotnull as fk_not_null
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
    where con.confrelid = p_table and con.contype = 'f' and array_length(con.conkey, 1) = 1
  loop
    v_incoming := v_incoming || jsonb_build_object('name', v_rec.conname, 'child', v_rec.child::text,
      'col', v_rec.fk_col, 'not_null', v_rec.fk_not_null);
    execute format('alter table %s drop constraint %I', v_rec.child, v_rec.conname);
  end loop;
  if exists (select 1 from pg_catalog.pg_constraint con where con.confrelid = p_table and con.contype = 'f') then
    raise exception 'partition_existing_table: % has a multi-column incoming foreign key', v_qualified using errcode = 'XR001';
  end if;

  -- 3. Swap: the old table steps aside under a new name; its indexes and constraints are renamed too,
  --    so the new table can take the original names.
  execute format('alter table %s rename to %I', v_qualified, v_old);
  for v_rec in select c.relname from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where i.indrelid = p_table loop
    execute format('alter index %I.%I rename to %I', v_schema, v_rec.relname, left('u_' || v_rec.relname, 63));
  end loop;
  for v_rec in select con.conname from pg_catalog.pg_constraint con where con.conrelid = p_table and con.contype in ('c', 'f') loop
    execute format('alter table %I.%I rename constraint %I to %I', v_schema, v_old, v_rec.conname, left('u_' || v_rec.conname, 63));
  end loop;

  execute format(
    'create table %I.%I (like %I.%I including defaults including constraints including generated including identity including comments including storage) partition by range (%I)',
    v_schema, v_name, v_schema, v_old, p_column);
  for v_rec in select con.conname from pg_catalog.pg_constraint con where con.conrelid = format('%I.%I', v_schema, v_name)::regclass and con.contype = 'c' loop
    execute format('alter table %I.%I rename constraint %I to %I', v_schema, v_name, v_rec.conname, substr(v_rec.conname, 3));
  end loop;
  execute format('alter table %I.%I add constraint %I primary key (id, %I)', v_schema, v_name, v_name || '_pkey', p_column);
  execute format('comment on table %I.%I is %L', v_schema, v_name, pg_catalog.obj_description(p_table, 'pg_class'));

  -- 4. Partitions for every month that has rows, then the premake horizon through A18's machinery.
  insert into private.partitioned_tables (table_name, partition_column, premake_months, maintenance_order)
  values (v_qualified, p_column, p_premake, p_maintenance_order);
  execute format('select min(%I) from %I.%I', p_column, v_schema, v_old) into v_min;
  v_month := date_trunc('month', coalesce(v_min, now()) at time zone 'UTC')::date;
  while v_month < date_trunc('month', now() at time zone 'UTC')::date loop
    perform private.create_month_partition(v_qualified, v_month);
    v_month := (v_month + interval '1 month')::date;
  end loop;
  perform private.ensure_partitions(v_qualified);

  -- 5. Rows, before any trigger exists on the new table.
  execute format('insert into %I.%I select * from %I.%I', v_schema, v_name, v_schema, v_old);

  -- 6. Indexes other than the primary key.
  for v_rec in
    select c.relname, pg_catalog.pg_get_indexdef(i.indexrelid) as def
    from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid
    where i.indrelid = p_table and not i.indisprimary
  loop
    v_def := replace(v_rec.def, format('INDEX %s ON %s.%s', v_rec.relname, v_schema, v_old), format('INDEX %s ON %s.%s', substr(v_rec.relname, 3), v_schema, v_name));
    v_def := replace(v_def, format('ON %s.%s USING', v_schema, v_old), format('ON %s.%s USING', v_schema, v_name));
    execute v_def;
  end loop;

  -- 7. Outgoing foreign keys.
  for v_rec in select con.conname, pg_catalog.pg_get_constraintdef(con.oid) as def from pg_catalog.pg_constraint con where con.conrelid = p_table and con.contype = 'f' loop
    execute format('alter table %I.%I add constraint %I %s', v_schema, v_name, substr(v_rec.conname, 3), v_rec.def);
  end loop;

  -- 8. Triggers, and the id guard first of all.
  for v_rec in select t.tgname, pg_catalog.pg_get_triggerdef(t.oid) as def from pg_catalog.pg_trigger t where t.tgrelid = p_table and not t.tgisinternal loop
    execute replace(v_rec.def, format(' ON %s.%s ', v_schema, v_old), format(' ON %s.%s ', v_schema, v_name));
  end loop;
  execute format('create trigger t00_unique_id before insert or update of id on %I.%I for each row execute function private.guard_partitioned_id(%L)',
    v_schema, v_name, v_qualified);

  -- 9. Row level security, policies and grants.
  execute format('alter table %I.%I enable row level security', v_schema, v_name);
  if (select c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = p_table) then
    execute format('alter table %I.%I force row level security', v_schema, v_name);
  end if;
  for v_rec in
    select p.polname, p.polpermissive, p.polcmd,
           (select string_agg(case when r = 0 then 'public' else quote_ident(g.rolname) end, ', ')
            from unnest(p.polroles) r left join pg_catalog.pg_roles g on g.oid = r) as roles,
           pg_catalog.pg_get_expr(p.polqual, p.polrelid) as qual,
           pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) as with_check
    from pg_catalog.pg_policy p where p.polrelid = p_table
  loop
    execute format('create policy %I on %I.%I as %s for %s to %s%s%s', v_rec.polname, v_schema, v_name,
      case when v_rec.polpermissive then 'permissive' else 'restrictive' end,
      case v_rec.polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update' when 'd' then 'delete' else 'all' end,
      v_rec.roles,
      case when v_rec.qual is null then '' else format(' using (%s)', v_rec.qual) end,
      case when v_rec.with_check is null then '' else format(' with check (%s)', v_rec.with_check) end);
  end loop;
  execute format('revoke all on %I.%I from public, anon, authenticated', v_schema, v_name);
  for v_rec in
    select coalesce(g.rolname, 'public') as grantee, x.privilege_type
    from pg_catalog.pg_class c, aclexplode(c.relacl) x left join pg_catalog.pg_roles g on g.oid = x.grantee
    where c.oid = p_table
  loop
    execute format('grant %s on %I.%I to %s', v_rec.privilege_type, v_schema, v_name,
      case when v_rec.grantee = 'public' then 'public' else quote_ident(v_rec.grantee) end);
  end loop;
  for v_rec in
    select a.attname, coalesce(g.rolname, 'public') as grantee, x.privilege_type
    from pg_catalog.pg_attribute a, aclexplode(a.attacl) x left join pg_catalog.pg_roles g on g.oid = x.grantee
    where a.attrelid = p_table and a.attacl is not null and not a.attisdropped
  loop
    execute format('grant %s (%I) on %I.%I to %s', v_rec.privilege_type, v_rec.attname, v_schema, v_name,
      case when v_rec.grantee = 'public' then 'public' else quote_ident(v_rec.grantee) end);
  end loop;

  -- 10. Incoming foreign keys, now composite.
  for v_rec in select * from jsonb_to_recordset(v_incoming) as x(name text, child text, col text, not_null boolean) loop
    v_new_col := regexp_replace(v_rec.col, '_id$', '') || '_' || p_column;
    execute format('alter table %s add column %I timestamptz', v_rec.child, v_new_col);
    execute format('comment on column %s.%I is %L', v_rec.child, v_new_col,
      format('Partition key of the referenced %s row (%s), filled by the database; part of the foreign key.', v_qualified, p_column));
    execute format('alter table %s disable trigger user', v_rec.child);
    execute format('update %s c set %I = p.%I from %I.%I p where p.id = c.%I', v_rec.child, v_new_col, p_column, v_schema, v_name, v_rec.col);
    execute format('alter table %s enable trigger user', v_rec.child);
    if v_rec.not_null then
      execute format('alter table %s alter column %I set not null', v_rec.child, v_new_col);
    end if;
    execute format('create index if not exists %I on %s (%I, %I)', left(replace(v_rec.child, 'app.', '') || '_' || v_new_col || '_idx', 63), v_rec.child, v_rec.col, v_new_col);
    execute format(
      'alter table %s add constraint %I foreign key (%I, %I) references %I.%I (id, %I)',
      v_rec.child, v_rec.name, v_rec.col, v_new_col, v_schema, v_name, p_column);
    -- The fill trigger also refuses a key that names no row (23503): the composite key is not checked while its
    -- new column is null, which is what the lookup gives for a missing row.
    execute format($f$
      create or replace function private.%7$I() returns trigger language plpgsql security definer set search_path = '' as $b$
      begin
        if new.%1$I is not null then
          new.%2$I := (select p.%3$I from %4$I.%5$I p where p.id = new.%1$I);
          if new.%2$I is null then
            raise exception using errcode = 'foreign_key_violation', message = %6$L,
              detail = format('Key (%1$s)=(%%s) is not present in table "%5$s".', new.%1$I);
          end if;
        end if;
        return new;
      end;
      $b$$f$,
      v_rec.col, v_new_col, p_column, v_schema, v_name,
      format('insert or update on table "%s" violates foreign key constraint "%s"', replace(v_rec.child, 'app.', ''), v_rec.name),
      left('fill_' || replace(v_rec.child, 'app.', '') || '_' || v_new_col, 63));
    execute format('revoke all on function private.%I() from public, anon, authenticated',
      left('fill_' || replace(v_rec.child, 'app.', '') || '_' || v_new_col, 63));
    execute format('create trigger t05_fill_%s before insert or update of %I on %s for each row execute function private.%I()',
      left(v_new_col, 40), v_rec.col, v_rec.child, left('fill_' || replace(v_rec.child, 'app.', '') || '_' || v_new_col, 63));
  end loop;

  -- 11. Views, as they were.
  for v_rec in select * from jsonb_to_recordset(v_views) as x(name text, def text, options text, note text, acl jsonb) loop
    execute format('create view %s%s as %s', v_rec.name,
      case when v_rec.options = '' then '' else format(' with (%s)', v_rec.options) end, v_rec.def);
    if v_rec.note is not null then
      execute format('comment on view %s is %L', v_rec.name, v_rec.note);
    end if;
    execute format('revoke all on %s from public', v_rec.name);
    for v_def in select format('grant %s on %s to %s', g->>'privilege', v_rec.name,
                   case when g->>'grantee' = 'public' then 'public' else quote_ident(g->>'grantee') end)
                 from jsonb_array_elements(v_rec.acl) g loop
      execute v_def;
    end loop;
  end loop;

  -- 11b. Policies of other tables, as they were (their expressions name the table, so they bind to the new one).
  for v_def in select x->>'sql' from jsonb_array_elements(v_policies) x loop
    execute v_def;
  end loop;

  -- 12. The old table goes; its rows now live in the partitions. Anything else still bound to it (an SQL
  --     standard function body, a rule) stops the conversion here and the transaction rolls back.
  execute format('drop table %I.%I', v_schema, v_old);
end;
$proc$;

comment on procedure private.partition_existing_table(regclass, text, smallint, integer) is
  'Converts a plain app table to monthly range partitions on a not null timestamptz column in one transaction, keeping columns, constraints, indexes, foreign keys (incoming ones become composite), triggers, policies, grants, dependent views and rows, and registers it with the nightly partition maintenance (Section 5.1).';

revoke all on procedure private.partition_existing_table(regclass, text, smallint, integer) from public, anon, authenticated;
