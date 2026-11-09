-- 6537_material_import_targets.sql
-- B11 Material import (RRR-235, G-106). Needs and purchase order lines become import wizard
-- targets, from CSV, Excel or a PDF read through the paste path. Every function below starts from its latest definition
-- in 2800.
--   * Destination purchase_order_id joins run_of_show_id and project_id. A po_lines import also carries the order's
--     project, stamped by private.guard_import_job_destination, so private.import_job_allowed keeps its signature and
--     needs no change. Only a Proposed order takes an import (import_po_not_proposed).
--   * app.undo_import_batch keeps every written line on an order past Proposed, Created and Updated alike: reverting one
--     would trip private.guard_po_line and abort the whole undo.
--   * private.material_match and app.import_material_match: catalogue matching. First the exact SKU among the order's
--     vendor's products, which also gives a blank price when the currencies agree; then an exact or at least 0.85 pg_trgm
--     match on live asset class names. An unmatched row stays free text.
--   * app.import_row_results.material_match and match_note: what the preview shows per row. The person confirms at commit.
-- No table becomes Trash-eligible here, so private.sync_trash_tables() is not called (ADR 0110).

-- 1. The destination ----------------------------------------------------------------------------------------------------------

alter table private.import_targets drop constraint import_targets_destination;
alter table private.import_targets add constraint import_targets_destination
  check (destination is null or destination in ('run_of_show_id', 'project_id', 'purchase_order_id'));
comment on column private.import_targets.destination is 'NULL for an org-wide target; otherwise the app.import_jobs column that names where the rows go: run_of_show_id (cues), project_id (guest list entries, needs) or purchase_order_id (order lines).';
comment on column app.import_targets.destination is 'NULL for an org-wide target; run_of_show_id, project_id or purchase_order_id when an import of it names a running order, a project or a purchase order.';

alter table app.import_jobs add column purchase_order_id uuid references app.purchase_orders (id);
create index import_jobs_purchase_order_idx on app.import_jobs (purchase_order_id);
call private.add_cross_org_references('app.import_jobs', array['app.purchase_orders', 'purchase_order_id']);
comment on column app.import_jobs.purchase_order_id is 'Purchase order an order line import writes into; NULL for every other target. Fixed once the import exists.';
comment on column app.import_jobs.project_id is 'Project a guest list or need import writes into, and the project of a purchase order import, stamped from the order; NULL for every other target. Fixed once the import exists.';

alter table app.import_row_results add column material_match text;
alter table app.import_row_results add column match_note text;
alter table app.import_row_results add constraint import_row_results_material_match check (material_match is null or material_match in ('Matched', 'Unmatched'));
alter table app.import_row_results add constraint import_row_results_match_note check (match_note is null or match_note in ('price_currency_differs'));
comment on column app.import_row_results.material_match is 'For a need or order line row: Matched when the catalogue named it, Unmatched when it stays free text; NULL for every other target.';
comment on column app.import_row_results.match_note is 'Why a match left something out: price_currency_differs when the vendor''s price is in another currency than the order, so the price stayed blank.';

create or replace function private.guard_import_job_destination()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_destination text;
  v_state app.po_state;
begin
  if tg_op = 'UPDATE' then
    if new.project_id is distinct from old.project_id or new.run_of_show_id is distinct from old.run_of_show_id
       or new.purchase_order_id is distinct from old.purchase_order_id then
      perform private.refuse('import_job_immutable', 'An import keeps its file and target; start a new import instead.');
    end if;
    return new;
  end if;
  select t.destination into v_destination from private.import_targets t where t.code = new.target_code;
  if v_destination is null then
    if new.project_id is not null or new.run_of_show_id is not null or new.purchase_order_id is not null then
      perform private.refuse('import_destination_unexpected', 'This target imports into the whole organization; it names no running order or project.');
    end if;
  elsif v_destination = 'run_of_show_id' then
    if new.project_id is not null or new.purchase_order_id is not null then
      perform private.refuse('import_destination_unexpected', 'A cue import names a running order, not a project.');
    end if;
    if new.run_of_show_id is null then
      perform private.refuse('import_destination_required', 'Choose the running order the rows go into.');
    end if;
    if not exists (select 1 from app.run_of_show r where r.id = new.run_of_show_id and r.deleted_at is null) then
      perform private.refuse('import_destination_unknown', 'The running order does not exist or was deleted.');
    end if;
  elsif v_destination = 'purchase_order_id' then
    if new.run_of_show_id is not null or new.project_id is not null then
      perform private.refuse('import_destination_unexpected', 'An order line import names a purchase order, not a project or running order.');
    end if;
    if new.purchase_order_id is null then
      perform private.refuse('import_destination_required', 'Choose the purchase order the rows go into.');
    end if;
    select po.project_id, po.po_state into new.project_id, v_state from app.purchase_orders po
    where po.id = new.purchase_order_id and po.deleted_at is null;
    if new.project_id is null then
      perform private.refuse('import_destination_unknown', 'The purchase order does not exist or was deleted.');
    end if;
    if v_state <> 'Proposed' then
      perform private.refuse('import_po_not_proposed', 'Lines import only into an order that is still Proposed.');
    end if;
  else
    if new.run_of_show_id is not null or new.purchase_order_id is not null then
      perform private.refuse('import_destination_unexpected', 'A guest list import names a project, not a running order.');
    end if;
    if new.project_id is null then
      perform private.refuse('import_destination_required', 'Choose the project the rows go into.');
    end if;
    if not exists (select 1 from app.projects p where p.id = new.project_id and p.deleted_at is null) then
      perform private.refuse('import_destination_unknown', 'The project does not exist or was deleted.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_import_job_destination() is 'Import jobs: a target with a destination names exactly that live running order, project or purchase order, an org-wide target names none of them, and the destination never changes (import_job_immutable). A purchase order import also carries the order''s project, stamped here, so private.import_job_allowed reads it like any project target; an order past Proposed refuses import_po_not_proposed.';
revoke all on function private.guard_import_job_destination() from public, anon, authenticated;

-- 2. Who may work on it ----------------------------------------------------------------------------------------------------------

create or replace function private.permitted_import_job_ids(p_include_deleted boolean default false)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with org_targets as (
    select t.code, o.org_id from private.import_targets t
    cross join lateral private.orgs_with_capability(t.write_capability) as o(org_id)
    where t.destination is null
  ),
  project_targets as (
    select t.code, t.destination, x.project_id from private.import_targets t
    cross join lateral private.project_ids_with(t.write_capability) as x(project_id)
    where t.destination is not null
  ),
  member_orgs as (
    select m.org_id from private.my_org_ids() as m(org_id)
  )
  select j.id from app.import_jobs j
  join org_targets o on o.code = j.target_code and o.org_id = j.org_id
  where (p_include_deleted or j.deleted_at is null)
  union all
  select j.id from app.import_jobs j
  join app.run_of_show r on r.id = j.run_of_show_id and r.deleted_at is null
  join project_targets x on x.code = j.target_code and x.destination = 'run_of_show_id' and x.project_id = r.project_id
  where (p_include_deleted or j.deleted_at is null) and j.org_id in (select m.org_id from member_orgs m)
  union all
  select j.id from app.import_jobs j
  join project_targets x on x.code = j.target_code and x.destination in ('project_id', 'purchase_order_id') and x.project_id = j.project_id
  where (p_include_deleted or j.deleted_at is null) and j.org_id in (select m.org_id from member_orgs m);
$$;

comment on function private.permitted_import_job_ids(boolean) is 'Imports the signed-in person may work on, computed once per statement: org-wide targets in orgs where they hold the write capability org-wide, cue imports whose live running order is on a project where they hold it, guest list imports of such a project, the last two only in orgs they are a member of. Soft-deleted imports only when asked. The app.import_jobs read and update policies use it.';
revoke all on function private.permitted_import_job_ids(boolean) from public, anon;
grant execute on function private.permitted_import_job_ids(boolean) to authenticated;

-- 3. Undo -----------------------------------------------------------------------------------------------------------------------

create or replace function app.undo_import_batch(p_import_batch_id uuid, p_reason text)
returns table (reverted integer, kept integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_batch app.import_batches;
  v_job app.import_jobs;
  v_row record;
  v_updated_at timestamptz;
  v_why text;
  v_reverted integer := 0;
  v_kept integer := 0;
begin
  select * into v_batch from app.import_batches where id = p_import_batch_id for update;
  select * into v_job from app.import_jobs where id = v_batch.import_job_id;
  if v_batch.id is null or not private.import_job_allowed(v_job.org_id, v_job.target_code, v_job.project_id, v_job.run_of_show_id) then
    raise exception using errcode = '42501', message = 'import batch not found';
  end if;
  if v_batch.committed_at is null or v_batch.undone_at is not null then
    perform private.refuse('import_batch_not_undoable', 'Only a committed batch that was not undone can be undone.');
  end if;
  if now() > v_batch.committed_at + interval '7 days' then
    perform private.refuse('import_undo_window', 'A batch can be undone for 7 days after it was committed.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) = 0 then
    perform private.refuse('import_undo_reason', 'Say why the batch is undone.');
  end if;
  for v_row in
    select r.id, r.target_table, r.target_id, r.write_action, r.before_image from app.import_row_results r
    where r.import_batch_id = p_import_batch_id and r.row_state = 'Written'
    order by r.row_number desc
  loop
    execute format('select updated_at from %s where id = $1', v_row.target_table) into v_updated_at using v_row.target_id;
    v_why := case when v_updated_at > v_batch.committed_at then 'The row was edited after the import.' end;
    -- A line of an order past Proposed stays, Created and Updated alike: reverting it would trip private.guard_po_line.
    if v_why is null and v_job.target_code = 'po_lines' and (select po.po_state from app.purchase_orders po where po.id = v_job.purchase_order_id) <> 'Proposed' then
      v_why := 'The purchase order is no longer Proposed.';
    end if;
    if v_why is null and v_row.write_action = 'Created' then
      v_why := private.later_dependents(v_row.target_table, v_row.target_id, p_import_batch_id, v_batch.committed_at);
    end if;
    if v_why is not null then
      update app.import_row_results set undo_outcome = 'Kept', undo_reason = v_why where id = v_row.id;
      v_kept := v_kept + 1;
      continue;
    end if;
    if v_row.write_action = 'Created' then
      execute format('update %s set deleted_at = now() where id = $1', v_row.target_table) using v_row.target_id;
    else
      execute format('update %1$s t set %2$s from jsonb_populate_record(null::%1$s, $2) b where t.id = $1',
        v_row.target_table,
        (select string_agg(format('%I = b.%I', k, k), ', ') from jsonb_object_keys(v_row.before_image) k))
        using v_row.target_id, v_row.before_image;
    end if;
    update app.import_row_results set undo_outcome = 'Reverted' where id = v_row.id;
    v_reverted := v_reverted + 1;
  end loop;
  update app.import_batches set undone_at = now(), undo_reason = btrim(p_reason) where id = p_import_batch_id;
  perform private.begin_trusted_operation('import_undo');
  update app.import_jobs set import_status = 'Undone' where id = v_batch.import_job_id;
  perform private.end_trusted_operation('import_undo');
  return query select v_reverted, v_kept;
end;
$$;

comment on function app.undo_import_batch(uuid, text) is 'Undoes an import batch within 7 days of its commit (Section 4.6.2 step 8): created rows go to Trash and updated or merged rows get their before image back, except rows edited after the import or referenced by rows outside the batch, which are kept and listed with the reason. Needs what the import needs (private.import_job_allowed): the target''s write capability org-wide, or on the project of a cue or guest list import.';
revoke all on function app.undo_import_batch(uuid, text) from public, anon;
grant execute on function app.undo_import_batch(uuid, text) to authenticated, service_role;

-- 4. Writes stay inside the destination ------------------------------------------------------------------------------------------

create or replace function app.commit_import_write(
  p_import_row_result_id uuid,
  p_import_batch_id uuid,
  p_target_id uuid,
  p_write_action app.import_write_action,
  p_before_image jsonb default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row app.import_row_results;
  v_batch app.import_batches;
  v_job app.import_jobs;
  v_table text;
  v_destination text;
  v_target_org uuid;
  v_target_destination uuid;
begin
  select * into v_row from app.import_row_results where id = p_import_row_result_id for update;
  select * into v_batch from app.import_batches where id = p_import_batch_id;
  if v_row.id is null or v_batch.id is null or v_batch.import_job_id <> v_row.import_job_id or v_batch.committed_at is not null then
    perform private.refuse('import_batch_mismatch', 'The row and an open batch of the same import are required.');
  end if;
  if v_row.row_state <> 'Valid' then
    perform private.refuse('import_row_not_valid', 'Only a Valid row is written.');
  end if;
  select * into v_job from app.import_jobs where id = v_row.import_job_id;
  select t.target_table, t.destination into v_table, v_destination from private.import_targets t where t.code = v_job.target_code;
  execute format('select org_id from %s where id = $1', v_table) into v_target_org using p_target_id;
  if v_target_org is distinct from v_row.org_id then
    perform private.refuse('import_target_unknown', 'The written row must exist in the import''s org.');
  end if;
  if v_destination is not null then
    execute format('select %I from %s where id = $1', v_destination, v_table) into v_target_destination using p_target_id;
    if v_target_destination is distinct from (case v_destination when 'run_of_show_id' then v_job.run_of_show_id when 'purchase_order_id' then v_job.purchase_order_id else v_job.project_id end) then
      perform private.refuse('import_target_outside_destination', 'The written row must be in the running order or project the import names.');
    end if;
  end if;
  update app.import_row_results
  set row_state = 'Written', import_batch_id = p_import_batch_id, target_table = v_table, target_id = p_target_id,
    write_action = p_write_action, before_image = p_before_image
  where id = p_import_row_result_id;
end;
$$;

comment on function app.commit_import_write(uuid, uuid, uuid, app.import_write_action, jsonb) is 'Import worker API (service role): records that a Valid row was written to a row of the target in the same org, and for a cue or guest list import in the running order or project the import names, with the before image of an update or merge. This puts the batch id on every imported row.';
revoke all on function app.commit_import_write(uuid, uuid, uuid, app.import_write_action, jsonb) from public, anon, authenticated;
grant execute on function app.commit_import_write(uuid, uuid, uuid, app.import_write_action, jsonb) to service_role;

-- 5. Importing another detected sheet --------------------------------------------------------------------------------------------

drop function app.import_detected_sheet(uuid, text, uuid, uuid);

create function app.import_detected_sheet(p_sheet_id uuid, p_target_code text, p_project_id uuid default null, p_run_of_show_id uuid default null, p_purchase_order_id uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sheet app.import_job_sheets;
  v_job app.import_jobs;
  v_destination text;
  v_named boolean;
  v_id uuid;
  v_project uuid := p_project_id;
begin
  select * into v_sheet from app.import_job_sheets s where s.id = p_sheet_id and s.deleted_at is null;
  if v_sheet.id is null or v_sheet.import_job_id not in (select private.readable_import_job_ids()) then
    raise exception using errcode = '42501', message = 'the sheet does not exist';
  end if;
  select * into v_job from app.import_jobs j where j.id = v_sheet.import_job_id;
  if v_job.import_status in ('Uploaded', 'Detected', 'Failed', 'Canceled') then
    perform private.refuse('import_sheet_not_detected', 'Sheets can be imported once the workbook has been read.');
  end if;
  if v_sheet.data_row_count = 0 then
    perform private.refuse('import_sheet_empty', 'The sheet has no rows to import.');
  end if;
  select t.destination, true into v_destination, v_named from private.import_targets t where t.code = p_target_code;
  -- A purchase order import is allowed by the order's project, which the guard stamps on the new row.
  if v_destination is not distinct from 'purchase_order_id' then
    select po.project_id into v_project from app.purchase_orders po where po.id = p_purchase_order_id and po.org_id = v_job.org_id;
  end if;
  -- A target with a destination and none named is refused by the destination guard (import_destination_required).
  -- An org-wide target has a NULL destination, so the comparisons are NULL-safe: it is always checked.
  if p_target_code is null or v_named is null
     or (not (v_destination is not distinct from 'run_of_show_id' and p_run_of_show_id is null)
         and not (v_destination is not distinct from 'project_id' and p_project_id is null)
         and not (v_destination is not distinct from 'purchase_order_id' and p_purchase_order_id is null)
         and not private.import_job_allowed(v_job.org_id, p_target_code, v_project, p_run_of_show_id)) then
    perform private.refuse('import_target_not_allowed', 'You cannot import into that target in this organization.');
  end if;
  if v_sheet.sheet_name = v_job.sheet_name or exists (
       select 1 from app.import_jobs j where j.import_job_sheet_id = p_sheet_id and j.deleted_at is null
         and j.import_status not in ('Canceled', 'Failed', 'Undone')) then
    perform private.refuse('import_sheet_taken', 'An import of this sheet is already open.');
  end if;
  insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, source_url, sheet_name,
    import_job_sheet_id, project_id, run_of_show_id, purchase_order_id)
  values (v_job.org_id, p_target_code, v_job.source, v_job.original_filename, v_job.storage_object_path, v_job.source_url,
          v_sheet.sheet_name, p_sheet_id, p_project_id, p_run_of_show_id, p_purchase_order_id)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.import_detected_sheet(uuid, text, uuid, uuid, uuid) is 'Starts the import of another sheet of an already-read workbook into a target the caller may import into, naming the running order (cues) or project (guest list entries) when the target has a destination. The new import reads the same stored file (the caller''s own upload, as for any import) and goes through detection, mapping, validation and commit on its own. A po_lines import names a purchase order.';
revoke all on function app.import_detected_sheet(uuid, text, uuid, uuid, uuid) from public, anon;
grant execute on function app.import_detected_sheet(uuid, text, uuid, uuid, uuid) to authenticated, service_role;

-- 6. Destinations a person may import into ---------------------------------------------------------------------------------------

create or replace function app.import_destinations(p_org_id uuid, p_target_code text, p_include uuid default null)
returns table (destination_id uuid, project_id uuid, label text, show_date date)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_capability text;
  v_destination text;
begin
  select t.write_capability, t.destination into v_capability, v_destination
  from private.import_targets t where t.code = p_target_code;
  if v_destination is null or p_org_id is null or not private.is_member(p_org_id) then
    return;
  end if;
  if v_destination = 'run_of_show_id' then
    return query
    with allowed as (select x.project_id from private.project_ids_with(v_capability) as x(project_id)),
    listed as (
      (select r.id, r.project_id, p.project_key || ' · ' || r.name as label, r.show_date, r.created_at
       from app.run_of_show r join app.projects p on p.id = r.project_id
       where r.org_id = p_org_id and r.deleted_at is null and r.project_id in (select a.project_id from allowed a)
       order by r.show_date desc, r.created_at desc
       limit 200)
      union
      (select r.id, r.project_id, p.project_key || ' · ' || r.name, r.show_date, r.created_at
       from app.run_of_show r join app.projects p on p.id = r.project_id
       where r.id = p_include and r.org_id = p_org_id and r.deleted_at is null and r.project_id in (select a.project_id from allowed a))
    )
    select l.id, l.project_id, l.label, l.show_date from listed l order by l.show_date desc, l.created_at desc;
  elsif v_destination = 'purchase_order_id' then
    return query
    with allowed as (select x.project_id from private.project_ids_with(v_capability) as x(project_id)),
    orders as (
      select po.id, po.project_id, p.project_key || '-PO-' || po.po_number::text || ' · ' || coalesce(o.name, '') as label, po.created_at
      from app.purchase_orders po
      join app.projects p on p.id = po.project_id
      join app.vendors v on v.id = po.vendor_id
      join app.counterparties c on c.id = v.counterparty_id
      left join app.organizations o on o.id = c.organization_id
      where po.org_id = p_org_id and po.deleted_at is null and po.po_state = 'Proposed' and po.project_id in (select a.project_id from allowed a)
    ),
    listed as (
      (select r.id, r.project_id, r.label, r.created_at from orders r order by r.created_at desc limit 200)
      union
      (select r.id, r.project_id, r.label, r.created_at from orders r where r.id = p_include)
    )
    select l.id, l.project_id, l.label, null::date from listed l order by l.created_at desc;
  else
    return query
    with allowed as (select x.project_id from private.project_ids_with(v_capability) as x(project_id)),
    listed as (
      (select p.id, p.project_key || ' · ' || p.name as label, p.created_at
       from app.projects p
       where p.org_id = p_org_id and p.deleted_at is null and p.id in (select a.project_id from allowed a)
       order by p.created_at desc
       limit 200)
      union
      (select p.id, p.project_key || ' · ' || p.name, p.created_at
       from app.projects p
       where p.id = p_include and p.org_id = p_org_id and p.deleted_at is null and p.id in (select a.project_id from allowed a))
    )
    select l.id, l.id, l.label, null::date from listed l order by l.created_at desc;
  end if;
end;
$$;

comment on function app.import_destinations(uuid, text, uuid) is 'Running orders (cues: label project key · name, with the show date) or projects (guest list entries: project key · name) of one org that the signed-in person may import into, newest first, at most 200, plus p_include when they may import into it, so a preselected destination always resolves. Nothing for an org-wide target or an org the person is not a member of. Purchase order lines list the org''s Proposed orders, labelled by key and vendor (B11).';
revoke all on function app.import_destinations(uuid, text, uuid) from public, anon;
grant execute on function app.import_destinations(uuid, text, uuid) to authenticated, service_role;

-- 7. Strong key match ------------------------------------------------------------------------------------------------------------

create or replace function app.import_strong_key_match(p_import_job_id uuid, p_keys jsonb)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_job app.import_jobs;
  v_id uuid;
begin
  select * into v_job from app.import_jobs j where j.id = p_import_job_id and j.deleted_at is null;
  if v_job.id is null then
    perform private.refuse('import_job_unknown', 'No such import.');
  end if;
  if v_job.target_code = 'cues' then
    if p_keys ? 'position' then
      select c.id into v_id from app.cues c
      where c.run_of_show_id = v_job.run_of_show_id and c.deleted_at is null
        and c.position = (p_keys ->> 'position')::integer
      limit 1;
    elsif p_keys ? 'label' then
      select c.id into v_id from app.cues c
      where c.run_of_show_id = v_job.run_of_show_id and c.deleted_at is null
        and c.label = p_keys ->> 'label'
        and c.planned_at is not distinct from (p_keys ->> 'planned_at')::timestamptz
      order by c.position
      limit 1;
    end if;
  elsif v_job.target_code = 'guest_list_entries' then
    if p_keys ? 'guest_name' then
      select g.id into v_id from app.guest_list_entries g
      where g.project_id = v_job.project_id and g.deleted_at is null
        and lower(btrim(g.guest_name)) = lower(btrim(p_keys ->> 'guest_name'))
        and g.scope_node_id is not distinct from (p_keys ->> 'scope_node_id')::uuid
      order by g.created_at
      limit 1;
    end if;
  elsif v_job.target_code = 'pool_invitations' then
    -- Email inside the row's pool, pending only: a claimed, declined or revoked invitation never matches.
    if p_keys ? 'email' and p_keys ? 'talent_pool_id' then
      select i.id into v_id from app.talent_pool_invitations i
      where i.org_id = v_job.org_id and i.talent_pool_id = (p_keys ->> 'talent_pool_id')::uuid
        and i.email = lower(btrim(p_keys ->> 'email'))
        and i.claimed_at is null and i.declined_at is null and i.revoked_at is null and i.deleted_at is null
      limit 1;
    end if;
  elsif v_job.target_code = 'procurement_needs' then
    if p_keys ? 'description' then
      select n.id into v_id from app.procurement_needs n
      where n.project_id = v_job.project_id and n.deleted_at is null
        and lower(btrim(n.description)) = lower(btrim(p_keys ->> 'description'))
      order by n.need_number
      limit 1;
    end if;
  elsif v_job.target_code = 'po_lines' then
    if p_keys ? 'line_number' then
      select l.id into v_id from app.po_lines l
      where l.purchase_order_id = v_job.purchase_order_id and l.deleted_at is null
        and l.line_number = (p_keys ->> 'line_number')::integer
      limit 1;
    end if;
  end if;
  return v_id;
end;
$$;

comment on function app.import_strong_key_match(uuid, jsonb) is 'Import worker API (service role): the existing row of a destination import that a row matches exactly on its strong keys: a cue''s position, else its label and time; a guest''s trimmed, case-insensitive name and show; a need''s trimmed, case-insensitive description (B11); an order line''s number (B11). Always inside the import''s destination.';
revoke all on function app.import_strong_key_match(uuid, jsonb) from public, anon, authenticated;
grant execute on function app.import_strong_key_match(uuid, jsonb) to service_role;

-- 8. Catalogue matching -----------------------------------------------------------------------------------------------------------

create or replace function private.material_match(p_org_id uuid, p_vendor_id uuid, p_vendor_sku text, p_text text)
returns table (match_source text, element_id text, asset_class_id uuid, unit_price_minor bigint, currency_code text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sku text := nullif(btrim(coalesce(p_vendor_sku, '')), '');
  v_text text := lower(btrim(coalesce(p_text, '')));
begin
  if v_sku is not null and p_vendor_id is not null then
    return query
    select 'vendor_sku'::text, coalesce(vp.element_id, b.element_id), null::uuid, vp.unit_price_minor, vp.currency_code::text
    from app.vendor_products vp
    left join app.catalog_bindings b on b.id = vp.catalog_binding_id
    where vp.org_id = p_org_id and vp.vendor_id = p_vendor_id and vp.vendor_sku = v_sku and vp.deleted_at is null
    limit 1;
    if found then
      return;
    end if;
  end if;
  if v_text = '' then
    return;
  end if;
  return query
  select 'asset_class'::text, c.element_id, c.id, null::bigint, null::text
  from app.asset_classes c
  where c.org_id = p_org_id and c.deleted_at is null
    and (lower(btrim(c.name)) = v_text or extensions.similarity(lower(btrim(c.name)), v_text) >= 0.85)
  order by (lower(btrim(c.name)) = v_text) desc, extensions.similarity(lower(btrim(c.name)), v_text) desc, c.name
  limit 1;
end;
$$;
comment on function private.material_match(uuid, uuid, text, text) is 'Catalogue matching of a material line (B11, G-106): first an exact vendor SKU in app.vendor_products of the vendor, with its element and price; then an exact or at least 0.85 pg_trgm match on the org''s live asset class names, with the class and its element. No row means it stays free text.';
revoke all on function private.material_match(uuid, uuid, text, text) from public, anon, authenticated;

create or replace function app.import_material_match(p_import_job_id uuid, p_vendor_sku text, p_text text)
returns table (match_source text, element_id text, asset_class_id uuid, unit_price_minor bigint, currency_code text, order_currency_code text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_job app.import_jobs;
  v_order app.purchase_orders;
begin
  select * into v_job from app.import_jobs j where j.id = p_import_job_id and j.deleted_at is null;
  if v_job.id is null then
    perform private.refuse('import_job_unknown', 'No such import.');
  end if;
  select po.* into v_order from app.purchase_orders po where po.id = v_job.purchase_order_id;
  return query
  select m.match_source, m.element_id, m.asset_class_id, m.unit_price_minor, m.currency_code, v_order.currency_code::text
  from private.material_match(v_job.org_id, v_order.vendor_id, p_vendor_sku, p_text) m;
end;
$$;
comment on function app.import_material_match(uuid, text, text) is 'Import worker API (service role): private.material_match for a row of a need or order line import, with the order''s currency so a price in another currency is left blank.';
revoke all on function app.import_material_match(uuid, text, text) from public, anon, authenticated;
grant execute on function app.import_material_match(uuid, text, text) to service_role;

-- 9. The targets ----------------------------------------------------------------------------------------------------------------------

insert into private.import_targets (code, target_table, write_capability, fuzzy_match, sort_order, destination) values
  ('procurement_needs', 'app.procurement_needs', 'procurement.po.write', false, 8, 'project_id'),
  ('po_lines', 'app.po_lines', 'procurement.po.write', false, 9, 'purchase_order_id');

insert into private.import_target_fields (target_code, field_name, required, strong_key) values
  ('procurement_needs', 'description', true, true),
  ('procurement_needs', 'quantity', true, false),
  ('procurement_needs', 'asset_class_id', false, false),
  ('procurement_needs', 'unit_basis', false, false),
  ('procurement_needs', 'needed_from', false, false),
  ('procurement_needs', 'needed_to', false, false),
  ('procurement_needs', 'note', false, false),
  ('po_lines', 'line_number', false, true),
  ('po_lines', 'description', true, false),
  ('po_lines', 'quantity', true, false),
  ('po_lines', 'vendor_sku', false, false),
  ('po_lines', 'element_id', false, false),
  ('po_lines', 'unit_basis', false, false),
  ('po_lines', 'unit_price_minor', false, false);
