-- 1771_line_restore_and_trash_activity.sql
-- A118 (RRR-163, A65-006, ADR 0077). Deletes that undo (Section 11.7): invoice, settlement and budget lines restore
-- without colliding, and a record or a line moved to Trash shows in Activity, which offers Restore on it.
--
--   * The three line tables were already soft deleted and are in Trash (1031), but a line number is unique only
--     among live lines, so a line added after a delete could take the deleted line's number and the restore failed
--     on the index. A restored line keeps its number when it is free and otherwise moves to the end of its parent.
--   * record.trashed, invoice_line.trashed, settlement_line.trashed and budget_line.trashed are emitted when a row
--     moves to Trash, with the project it belongs to, so the Activity feed shows the deletion to the people who could
--     read the row. The feed names a record by its key; a line's event carries its description. Activity offers
--     Restore on the entry while app.trash_items still lists the row (until its purge_after), through
--     app.restore_trash_item, the same RPC as the Trash page and the Undo of a line.

-- Restored lines keep their place when they can ---------------------------------------------------------------------

create or replace function private.renumber_restored_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_column text := tg_argv[0];
  v_parent uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
  v_taken boolean;
  v_last integer;
begin
  execute format('select exists (select 1 from %s l where l.%I = $1 and l.line_number = $2 and l.deleted_at is null and l.id <> $3)',
    tg_relid::regclass, v_parent_column)
    into v_taken using v_parent, new.line_number, new.id;
  if v_taken then
    execute format('select coalesce(max(l.line_number), 0) from %s l where l.%I = $1 and l.deleted_at is null',
      tg_relid::regclass, v_parent_column)
      into v_last using v_parent;
    new.line_number := v_last + 1;
  end if;
  return new;
end;
$$;

comment on function private.renumber_restored_line() is 'Before trigger on a line restored from Trash: when a live line of the same parent (the column named by the argument) took its number since it was deleted, the restored line moves to the end, so the restore never fails on the live-number index.';
revoke all on function private.renumber_restored_line() from public, anon, authenticated;

create trigger t45_renumber_restored_line before update of deleted_at on app.invoice_lines
  for each row when (old.deleted_at is not null and new.deleted_at is null)
  execute function private.renumber_restored_line('invoice_id');
create trigger t45_renumber_restored_line before update of deleted_at on app.settlement_lines
  for each row when (old.deleted_at is not null and new.deleted_at is null)
  execute function private.renumber_restored_line('settlement_id');
create trigger t45_renumber_restored_line before update of deleted_at on app.budget_lines
  for each row when (old.deleted_at is not null and new.deleted_at is null)
  execute function private.renumber_restored_line('budget_id');

-- Moving to Trash reaches Activity -------------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('record.trashed', 'records', 'A record moved to Trash; it can be restored until its retention period ends.'),
  ('invoice_line.trashed', 'invoice_lines', 'An invoice line was deleted to Trash; it can be restored while the invoice is Proposed.'),
  ('settlement_line.trashed', 'settlement_lines', 'A settlement line was deleted to Trash; it can be restored while the settlement is Proposed.'),
  ('budget_line.trashed', 'budget_lines', 'A budget line was deleted to Trash; it can be restored until its retention period ends.')
on conflict (code) do nothing;

create or replace function private.emit_trashed_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_project uuid;
begin
  if tg_nargs = 2 then
    v_project := (v_row ->> tg_argv[1])::uuid;
  elsif tg_nargs = 3 then
    execute format('select p.project_id from %s p where p.id = $1', tg_argv[1]::regclass)
      into v_project using (v_row ->> tg_argv[2])::uuid;
  end if;
  perform private.emit_event(new.org_id, tg_argv[0], tg_table_name, new.id, v_project,
    jsonb_strip_nulls(jsonb_build_object('title', v_row -> 'title', 'description', v_row -> 'description')));
  return null;
end;
$$;

comment on function private.emit_trashed_event() is 'After trigger on a row moved to Trash: emits the event named by the first argument, with the row''s title or description. The project is the row''s column named by the second argument, or the project_id of the parent table (second argument) the row names in the column given third.';
revoke all on function private.emit_trashed_event() from public, anon, authenticated;

create trigger t90_emit_record_trashed after update of deleted_at on app.records
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_trashed_event('record.trashed', 'project_id');
create trigger t90_emit_invoice_line_trashed after update of deleted_at on app.invoice_lines
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_trashed_event('invoice_line.trashed', 'app.invoices', 'invoice_id');
create trigger t90_emit_settlement_line_trashed after update of deleted_at on app.settlement_lines
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_trashed_event('settlement_line.trashed', 'app.settlements', 'settlement_id');
create trigger t90_emit_budget_line_trashed after update of deleted_at on app.budget_lines
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_trashed_event('budget_line.trashed', 'app.budgets', 'budget_id');
