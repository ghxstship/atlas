-- 3028_budget_line_import_target.sql
-- B13 (RRR-237, gap G-214; Section 4.6.2, S4.6.2-01, -04 and -06, ADR 0152). Budget lines become an import wizard
-- target, from .xlsx and .csv, with the wizard's preview (row states and dry-run counts) and undo.
--
--   * A third import destination after P3's (2800): budget_id. app.import_jobs.budget_id names the budget the lines go
--     into, at most one destination per import (import_jobs_one_destination), fixed once the import exists. The
--     import is authorized by finance.budget.write on the budget's project (private.project_ids_with), never the
--     org-wide set.
--   * Each function below is restated from its latest definition (2800) and learns budget_id:
--     private.guard_import_job_destination, private.permitted_import_job_ids, app.import_destinations (it lists
--     budgets), app.import_strong_key_match (line_number), app.commit_import_write, app.request_import_commit and
--     app.undo_import_batch. private.import_job_allowed and app.import_detected_sheet gain a last argument,
--     p_budget_id default null, so the old signatures are dropped once the import_jobs policies use the new one.
--     private.import_target_orgs, private.readable_import_job_ids, app.record_import_row and private.fuzzy_candidates
--     do not branch on the destination column (budget lines are not matched fuzzily), so they are unchanged.
--   * The target budget_lines (finance.budget.write, sort order 7) with its fields; line_number is the strong key: a
--     row with a number updates that line of the destination budget, others append in sheet order.
--   * app.import_jobs.project_id now restates the project of a budget destination's budget only for guest lists; it is
--     registered as the import's own destination.
-- No table becomes Trash-eligible here (budget lines already are), so private.sync_trash_tables() is not called.

-- 1. Destination -------------------------------------------------------------------------------------------------------

alter table private.import_targets drop constraint import_targets_destination;
alter table private.import_targets add constraint import_targets_destination
  check (destination is null or destination in ('run_of_show_id', 'project_id', 'budget_id'));
comment on column private.import_targets.destination is 'NULL for an org-wide target; otherwise the app.import_jobs column that names where the rows go: run_of_show_id (cues), project_id (guest list entries) or budget_id (budget lines).';
comment on column app.import_targets.destination is 'NULL for an org-wide target; run_of_show_id, project_id or budget_id when an import of it names a running order, a project or a budget.';

alter table app.import_jobs add column budget_id uuid references app.budgets (id);
create index import_jobs_budget_idx on app.import_jobs (budget_id);
alter table app.import_jobs drop constraint import_jobs_one_destination;
alter table app.import_jobs add constraint import_jobs_one_destination check (num_nonnulls(project_id, run_of_show_id, budget_id) <= 1);
call private.add_cross_org_references('app.import_jobs', array['app.budgets', 'budget_id']);
comment on column app.import_jobs.budget_id is 'Budget a budget line import writes into; NULL for every other target. Fixed once the import exists.';

create or replace function private.guard_import_job_destination()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_destination text;
begin
  if tg_op = 'UPDATE' then
    if new.project_id is distinct from old.project_id or new.run_of_show_id is distinct from old.run_of_show_id
       or new.budget_id is distinct from old.budget_id then
      perform private.refuse('import_job_immutable', 'An import keeps its file and target; start a new import instead.');
    end if;
    return new;
  end if;
  select t.destination into v_destination from private.import_targets t where t.code = new.target_code;
  if v_destination is null then
    if new.project_id is not null or new.run_of_show_id is not null or new.budget_id is not null then
      perform private.refuse('import_destination_unexpected', 'This target imports into the whole organization; it names no running order, project or budget.');
    end if;
  elsif v_destination = 'run_of_show_id' then
    if new.project_id is not null or new.budget_id is not null then
      perform private.refuse('import_destination_unexpected', 'A cue import names a running order, not a project or a budget.');
    end if;
    if new.run_of_show_id is null then
      perform private.refuse('import_destination_required', 'Choose the running order the rows go into.');
    end if;
    if not exists (select 1 from app.run_of_show r where r.id = new.run_of_show_id and r.deleted_at is null) then
      perform private.refuse('import_destination_unknown', 'The running order does not exist or was deleted.');
    end if;
  elsif v_destination = 'budget_id' then
    if new.project_id is not null or new.run_of_show_id is not null then
      perform private.refuse('import_destination_unexpected', 'A budget line import names a budget, not a project or a running order.');
    end if;
    if new.budget_id is null then
      perform private.refuse('import_destination_required', 'Choose the budget the lines go into.');
    end if;
    if not exists (select 1 from app.budgets b where b.id = new.budget_id and b.deleted_at is null) then
      perform private.refuse('import_destination_unknown', 'The budget does not exist or was deleted.');
    end if;
  else
    if new.run_of_show_id is not null or new.budget_id is not null then
      perform private.refuse('import_destination_unexpected', 'A guest list import names a project, not a running order or a budget.');
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

comment on function private.guard_import_job_destination() is 'Import jobs: a target with a destination names exactly that live running order, project or budget, an org-wide target names none, and none of the three columns changes after the import exists.';
revoke all on function private.guard_import_job_destination() from public, anon, authenticated;

-- 2. One import, from its column values ----------------------------------------------------------------------------------

create function private.import_job_allowed(p_org_id uuid, p_target_code text, p_project_id uuid, p_run_of_show_id uuid,
  p_budget_id uuid default null)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_capability text;
  v_destination text;
  v_project uuid;
begin
  select t.write_capability, t.destination into v_capability, v_destination
  from private.import_targets t where t.code = p_target_code;
  if v_capability is null or p_org_id is null then
    return false;
  end if;
  if v_destination is null then
    return exists (select 1 from private.orgs_with_capability(v_capability) o where o = p_org_id);
  end if;
  if not private.is_member(p_org_id) then
    return false;
  end if;
  if v_destination = 'run_of_show_id' then
    select r.project_id into v_project from app.run_of_show r
    where r.id = p_run_of_show_id and r.org_id = p_org_id and r.deleted_at is null;
  elsif v_destination = 'budget_id' then
    select b.project_id into v_project from app.budgets b
    where b.id = p_budget_id and b.org_id = p_org_id and b.deleted_at is null;
  else
    select p.id into v_project from app.projects p
    where p.id = p_project_id and p.org_id = p_org_id and p.deleted_at is null;
  end if;
  return v_project is not null and private.can_on_project(v_project, v_capability);
end;
$$;

comment on function private.import_job_allowed(uuid, text, uuid, uuid, uuid) is 'True when the signed-in person may work on an import with these column values: an org-wide target needs its write capability org-wide in the org; a cue import needs it on the project of the live running order, a guest list import on the live project, and a budget line import on the project of the live budget, in an org they are a member of. The commit and undo RPCs and the insert policy use it.';
revoke all on function private.import_job_allowed(uuid, text, uuid, uuid, uuid) from public, anon;
grant execute on function private.import_job_allowed(uuid, text, uuid, uuid, uuid) to authenticated, service_role;

-- 3. Every import of a statement ---------------------------------------------------------------------------------------

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
  join project_targets x on x.code = j.target_code and x.destination = 'project_id' and x.project_id = j.project_id
  where (p_include_deleted or j.deleted_at is null) and j.org_id in (select m.org_id from member_orgs m)
  union all
  select j.id from app.import_jobs j
  join app.budgets b on b.id = j.budget_id and b.deleted_at is null
  join project_targets x on x.code = j.target_code and x.destination = 'budget_id' and x.project_id = b.project_id
  where (p_include_deleted or j.deleted_at is null) and j.org_id in (select m.org_id from member_orgs m);
$$;

comment on function private.permitted_import_job_ids(boolean) is 'Imports the signed-in person may work on, computed once per statement: org-wide targets in orgs where they hold the write capability org-wide, cue imports whose live running order is on a project where they hold it, guest list imports of such a project, budget line imports whose live budget is on such a project, the last three only in orgs they are a member of. Soft-deleted imports only when asked. The app.import_jobs read and update policies use it.';
revoke all on function private.permitted_import_job_ids(boolean) from public, anon;
grant execute on function private.permitted_import_job_ids(boolean) to authenticated;

call private.install_policies('app.import_jobs',
  $$id in (select private.permitted_import_job_ids(true))
    or (created_by = (select private.current_person_id())
        and private.import_job_allowed(org_id, target_code, project_id, run_of_show_id, budget_id))$$,
  $$private.import_job_allowed(org_id, target_code, project_id, run_of_show_id, budget_id)$$,
  $$id in (select private.permitted_import_job_ids(true))$$);

-- 4. Commit request ----------------------------------------------------------------------------------------------------

create or replace function app.request_import_commit(p_import_job_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job app.import_jobs;
  v_batch uuid;
begin
  perform private.require_person();
  select * into v_job from app.import_jobs j where j.id = p_import_job_id and j.deleted_at is null;
  if v_job.id is null
     or not private.import_job_allowed(v_job.org_id, v_job.target_code, v_job.project_id, v_job.run_of_show_id, v_job.budget_id) then
    raise exception using errcode = '42501', message = 'import not found';
  end if;
  if not exists (select 1 from app.import_row_results r where r.import_job_id = v_job.id and r.row_state = 'Valid' and r.deleted_at is null) then
    perform private.refuse('import_nothing_to_commit', 'No row is valid; fix the spreadsheet and import it again.');
  end if;
  perform private.begin_trusted_operation('import_commit_request');
  v_batch := app.start_import_batch(v_job.id);
  perform private.end_trusted_operation('import_commit_request');
  perform private.enqueue_job(v_job.org_id, 'import.commit', v_batch);
  return v_batch;
end;
$$;

comment on function app.request_import_commit(uuid) is 'Commits a validated import (Section 4.6.2 step 7) for a person who may work on it (private.import_job_allowed: the target''s write capability org-wide, or on the project of a cue, guest list or budget line import): opens the import batch once every fuzzy match is decided and queues the worker that writes the rows with the batch id. Refuses an import that is not validated, has pending merge reviews or no valid row. Returns the batch id.';
revoke all on function app.request_import_commit(uuid) from public, anon;
grant execute on function app.request_import_commit(uuid) to authenticated, service_role;

-- 5. Undo (only the authorization changes) ------------------------------------------------------------------------------

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
  if v_batch.id is null
     or not private.import_job_allowed(v_job.org_id, v_job.target_code, v_job.project_id, v_job.run_of_show_id, v_job.budget_id) then
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

comment on function app.undo_import_batch(uuid, text) is 'Undoes an import batch within 7 days of its commit (Section 4.6.2 step 8): created rows go to Trash and updated or merged rows get their before image back, except rows edited after the import or referenced by rows outside the batch, which are kept and listed with the reason. Needs what the import needs (private.import_job_allowed): the target''s write capability org-wide, or on the project of a cue, guest list or budget line import.';
revoke all on function app.undo_import_batch(uuid, text) from public, anon;
grant execute on function app.undo_import_batch(uuid, text) to authenticated, service_role;

-- 6. Writes stay inside the destination ----------------------------------------------------------------------------------

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
    if v_target_destination is distinct from (case v_destination when 'run_of_show_id' then v_job.run_of_show_id
                                                when 'budget_id' then v_job.budget_id else v_job.project_id end) then
      perform private.refuse('import_target_outside_destination', 'The written row must be in the running order, project or budget the import names.');
    end if;
  end if;
  update app.import_row_results
  set row_state = 'Written', import_batch_id = p_import_batch_id, target_table = v_table, target_id = p_target_id,
    write_action = p_write_action, before_image = p_before_image
  where id = p_import_row_result_id;
end;
$$;

comment on function app.commit_import_write(uuid, uuid, uuid, app.import_write_action, jsonb) is 'Import worker API (service role): records that a Valid row was written to a row of the target in the same org, and for a cue, guest list or budget line import in the running order, project or budget the import names, with the before image of an update or merge. This puts the batch id on every imported row.';
revoke all on function app.commit_import_write(uuid, uuid, uuid, app.import_write_action, jsonb) from public, anon, authenticated;
grant execute on function app.commit_import_write(uuid, uuid, uuid, app.import_write_action, jsonb) to service_role;

-- 7. Importing another detected sheet ------------------------------------------------------------------------------------

drop function app.import_detected_sheet(uuid, text, uuid, uuid);

create function app.import_detected_sheet(p_sheet_id uuid, p_target_code text, p_project_id uuid default null,
  p_run_of_show_id uuid default null, p_budget_id uuid default null)
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
  -- A target with a destination and none named is refused by the destination guard (import_destination_required).
  -- An org-wide target has a NULL destination, so the comparisons are NULL-safe: it is always checked.
  if p_target_code is null or v_named is null
     or (not (v_destination is not distinct from 'run_of_show_id' and p_run_of_show_id is null)
         and not (v_destination is not distinct from 'project_id' and p_project_id is null)
         and not (v_destination is not distinct from 'budget_id' and p_budget_id is null)
         and not private.import_job_allowed(v_job.org_id, p_target_code, p_project_id, p_run_of_show_id, p_budget_id)) then
    perform private.refuse('import_target_not_allowed', 'You cannot import into that target in this organization.');
  end if;
  if v_sheet.sheet_name = v_job.sheet_name or exists (
       select 1 from app.import_jobs j where j.import_job_sheet_id = p_sheet_id and j.deleted_at is null
         and j.import_status not in ('Canceled', 'Failed', 'Undone')) then
    perform private.refuse('import_sheet_taken', 'An import of this sheet is already open.');
  end if;
  insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, source_url, sheet_name,
    import_job_sheet_id, project_id, run_of_show_id, budget_id)
  values (v_job.org_id, p_target_code, v_job.source, v_job.original_filename, v_job.storage_object_path, v_job.source_url,
          v_sheet.sheet_name, p_sheet_id, p_project_id, p_run_of_show_id, p_budget_id)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.import_detected_sheet(uuid, text, uuid, uuid, uuid) is 'Starts the import of another sheet of an already-read workbook into a target the caller may import into, naming the running order (cues), project (guest list entries) or budget (budget lines) when the target has a destination. The new import reads the same stored file (the caller''s own upload, as for any import) and goes through detection, mapping, validation and commit on its own.';
revoke all on function app.import_detected_sheet(uuid, text, uuid, uuid, uuid) from public, anon;
grant execute on function app.import_detected_sheet(uuid, text, uuid, uuid, uuid) to authenticated, service_role;

-- The policies above use the five-argument check, so the four-argument one can go.
drop function private.import_job_allowed(uuid, text, uuid, uuid);

-- 8. Destinations a person may import into -------------------------------------------------------------------------------

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
  elsif v_destination = 'budget_id' then
    return query
    with allowed as (select x.project_id from private.project_ids_with(v_capability) as x(project_id)),
    listed as (
      (select b.id, b.project_id, p.project_key || ' · ' || b.name as label, b.created_at
       from app.budgets b join app.projects p on p.id = b.project_id
       where b.org_id = p_org_id and b.deleted_at is null and p.deleted_at is null
         and b.project_id in (select a.project_id from allowed a)
       order by b.created_at desc
       limit 200)
      union
      (select b.id, b.project_id, p.project_key || ' · ' || b.name, b.created_at
       from app.budgets b join app.projects p on p.id = b.project_id
       where b.id = p_include and b.org_id = p_org_id and b.deleted_at is null
         and b.project_id in (select a.project_id from allowed a))
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

comment on function app.import_destinations(uuid, text, uuid) is 'Running orders (cues: label project key · name, with the show date), projects (guest list entries: project key · name) or budgets (budget lines: project key · budget name) of one org that the signed-in person may import into, newest first, at most 200, plus p_include when they may import into it, so a preselected destination always resolves. Nothing for an org-wide target or an org the person is not a member of.';
revoke all on function app.import_destinations(uuid, text, uuid) from public, anon;
grant execute on function app.import_destinations(uuid, text, uuid) to authenticated, service_role;

-- 9. Strong key match ----------------------------------------------------------------------------------------------------

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
  elsif v_job.target_code = 'budget_lines' then
    if p_keys ? 'line_number' then
      select l.id into v_id from app.budget_lines l
      where l.budget_id = v_job.budget_id and l.deleted_at is null
        and l.line_number = (p_keys ->> 'line_number')::integer
      limit 1;
    end if;
  end if;
  return v_id;
end;
$$;

comment on function app.import_strong_key_match(uuid, jsonb) is 'Import worker API (service role): the existing row of a cue, guest list or budget line import''s destination that a row matches exactly on its strong keys, or NULL. Cues match on position, or without one on label and planned time; guests on the trimmed name, case-insensitively, and the show; budget lines on the live line number of the import''s budget. A NULL show or time matches only NULL. The destination always comes from the import, never from the sheet.';
revoke all on function app.import_strong_key_match(uuid, jsonb) from public, anon, authenticated;
grant execute on function app.import_strong_key_match(uuid, jsonb) to service_role;

-- 10. The target -------------------------------------------------------------------------------------------------------

insert into private.import_targets (code, target_table, write_capability, fuzzy_match, sort_order, destination) values
  ('budget_lines', 'app.budget_lines', 'finance.budget.write', false, 7, 'budget_id');

insert into private.import_target_fields (target_code, field_name, required, strong_key) values
  ('budget_lines', 'line_number', false, true),
  ('budget_lines', 'description', true, false),
  ('budget_lines', 'urid', true, false),
  ('budget_lines', 'quantity', false, false),
  ('budget_lines', 'unit_price', false, false),
  ('budget_lines', 'line_type', false, false),
  ('budget_lines', 'cost_center', false, false),
  ('budget_lines', 'unit_basis', false, false),
  ('budget_lines', 'grade_code', false, false),
  ('budget_lines', 'element_id', false, false),
  ('budget_lines', 'phase_code', false, false),
  ('budget_lines', 'tier_code', false, false),
  ('budget_lines', 'xyz', false, false),
  ('budget_lines', 'markup_percent', false, false),
  ('budget_lines', 'client_unit_price', false, false),
  ('budget_lines', 'excluded_from_quote', false, false);
