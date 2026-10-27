-- 2122_trash_restore_children.sql
-- A118 (RRR-163, A65-006, ADR 0077). app.restore_trash_item (1031, its only earlier definition) restores rows that
-- reference the restored row and were deleted with it. It ran that update on every soft-deletable child table, and a
-- table the caller may not update at all (app.self_billed_timesheets and app.self_billed_deliverables, written only
-- by the self-billing RPC) failed the whole restore with permission denied, even with no row to restore. So no
-- invoice line could be restored, from Trash, Activity or its Undo. The cascade now skips child tables the caller
-- has no update privilege on: their rows were never the caller's to restore, and the restore itself is unchanged.

create or replace function app.restore_trash_item(p_subject_table text, p_subject_id uuid)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_terms record;
  v_deleted timestamptz;
  v_restored integer;
  v_queue_tables text[];
  v_queue_ids uuid[];
  v_depths integer[];
  v_table text;
  v_id uuid;
  v_depth integer;
  v_fk record;
  v_child uuid;
  v_total integer := 1;
  i integer := 1;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  select * into v_terms from app.trash_restore_terms(p_subject_table);
  if v_terms.table_name is null then
    raise exception using errcode = 'XR001', hint = 'trash_not_restorable',
      message = format('trash_not_restorable: Rows of %s are not restored from Trash.', coalesce(p_subject_table, 'that table'));
  end if;
  execute format('select deleted_at from app.%I where id = $1', v_terms.table_name) into v_deleted using p_subject_id;
  get diagnostics v_restored = row_count;
  if v_restored = 0 then
    raise exception using errcode = '42501', message = 'the row is not visible to you';
  end if;
  if v_deleted is null then
    raise exception using errcode = 'XR001', hint = 'trash_not_deleted', message = 'trash_not_deleted: This row is not in Trash.';
  end if;
  if v_deleted + v_terms.retention < now() then
    raise exception using errcode = 'XR001', hint = 'trash_restore_expired',
      message = 'trash_restore_expired: Its retention period has ended; it is about to be purged and cannot be restored.';
  end if;
  execute format('update app.%I set deleted_at = null where id = $1 and deleted_at is not null', v_terms.table_name)
    using p_subject_id;
  get diagnostics v_restored = row_count;
  if v_restored = 0 then
    raise exception using errcode = '42501', message = 'you cannot edit this row, so you cannot restore it';
  end if;

  -- Rows that reference it and were deleted in the same statement come back with it, three levels deep, in the
  -- tables the caller may update.
  v_queue_tables := array[v_terms.table_name];
  v_queue_ids := array[p_subject_id];
  v_depths := array[1];
  while i <= cardinality(v_queue_ids) loop
    v_table := v_queue_tables[i];
    v_id := v_queue_ids[i];
    v_depth := v_depths[i];
    i := i + 1;
    continue when v_depth > 3;
    for v_fk in
      select cl.relname::text as child_table, a.attname::text as child_column
      from pg_catalog.pg_constraint k
      join pg_catalog.pg_class cl on cl.oid = k.conrelid
      join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
      where k.contype = 'f' and k.confrelid = format('app.%I', v_table)::regclass and cardinality(k.conkey) = 1
        and n.nspname = 'app' and a.attname not in ('created_by', 'updated_by')
        and exists (select 1 from pg_catalog.pg_attribute d where d.attrelid = k.conrelid and d.attname = 'deleted_at' and not d.attisdropped)
        and exists (select 1 from pg_catalog.pg_attribute x where x.attrelid = k.conrelid and x.attname = 'id' and not x.attisdropped)
        and has_table_privilege(k.conrelid, 'UPDATE')
    loop
      for v_child in execute format('update app.%I set deleted_at = null where %I = $1 and deleted_at = $2 returning id',
        v_fk.child_table, v_fk.child_column) using v_id, v_deleted
      loop
        v_total := v_total + 1;
        v_queue_tables := v_queue_tables || v_fk.child_table;
        v_queue_ids := v_queue_ids || v_child;
        v_depths := v_depths || (v_depth + 1);
      end loop;
    end loop;
  end loop;

  perform app.record_trash_restore(v_terms.table_name, p_subject_id, v_total);
  return v_total;
end;
$$;

comment on function app.restore_trash_item(text, uuid) is 'Restores a soft-deleted row from Trash as the caller, so the table''s update policy and guards decide; refuses a table not in Trash, a live row and a row past its retention period. Rows that reference it and were deleted with it (the same deleted_at) are restored too, three levels deep, in the tables the caller may update. Emits trash.restored. Returns how many rows were restored.';
revoke all on function app.restore_trash_item(text, uuid) from public, anon;
grant execute on function app.restore_trash_item(text, uuid) to authenticated, service_role;
