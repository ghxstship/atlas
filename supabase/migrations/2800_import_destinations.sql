-- 2800_import_destinations.sql
-- P3 Rundown and guest list import (RRR-217, gaps G-84 and G-72, Section 4.6.2). Every import target so far was
-- org-wide and authorized by an org-wide write capability. Cues and guest list entries are project rows, so their
-- imports name where the rows go: a running order (cues) or a project (guest list entries), authorized by the
-- project capability (private.project_ids_with, last redefined in 1205), never by the org-wide set.
--   * private.import_targets.destination: NULL for an org-wide target, else the app.import_jobs column that names
--     the destination ('run_of_show_id' or 'project_id'); app.import_targets shows it.
--   * app.import_jobs.project_id and run_of_show_id, at most one of them, fixed once the job exists
--     (t43_guard_import_job_destination).
--   * private.import_target_orgs keeps org-wide targets as they were; for a destination target it returns the member
--     orgs where the person may import into some project. Outside orgs that hold a project share or a record grant
--     never reach the owning org's mapping profiles (review correction C4).
--   * private.import_job_allowed decides one import from its column values; private.permitted_import_job_ids and
--     private.readable_import_job_ids decide every import of a statement at once (C5). The import_jobs policies and
--     every child table of an import go through them.
--   * app.request_import_commit, app.undo_import_batch, app.commit_import_write, app.record_import_row,
--     app.import_detected_sheet and private.fuzzy_candidates learn the destination.
--   * app.import_destinations lists the running orders or projects of one org the person may import into.
--   * app.import_strong_key_match: the worker's exact match on a target's strong keys, with the semantics PostgREST
--     cannot express (case-insensitive trimmed guest names, NULL shows and times), always inside the job's
--     destination (C9).
-- No table becomes Trash-eligible here, so private.sync_trash_tables() is not called (ADR 0110).

-- 1. Targets name their destination ------------------------------------------------------------------------------

alter table private.import_targets add column destination text;
alter table private.import_targets add constraint import_targets_destination
  check (destination is null or destination in ('run_of_show_id', 'project_id'));
comment on column private.import_targets.destination is 'NULL for an org-wide target; otherwise the app.import_jobs column that names where the rows go: run_of_show_id (cues) or project_id (guest list entries).';

create or replace view app.import_targets as
select t.code, t.write_capability, t.fuzzy_match, t.sort_order, t.destination from private.import_targets t;
comment on column app.import_targets.destination is 'NULL for an org-wide target; run_of_show_id or project_id when an import of it names a running order or a project.';
revoke select on app.import_targets from xos_backup;

-- 2. Import jobs carry the destination ---------------------------------------------------------------------------

alter table app.import_jobs add column project_id uuid references app.projects (id);
alter table app.import_jobs add column run_of_show_id uuid references app.run_of_show (id);
create index import_jobs_project_idx on app.import_jobs (project_id);
create index import_jobs_run_of_show_idx on app.import_jobs (run_of_show_id);
alter table app.import_jobs add constraint import_jobs_one_destination check (num_nonnulls(project_id, run_of_show_id) <= 1);
call private.add_cross_org_references('app.import_jobs', array['app.projects', 'project_id', 'app.run_of_show', 'run_of_show_id']);
comment on column app.import_jobs.project_id is 'Project a guest list import writes into; NULL for every other target. Fixed once the import exists.';
comment on column app.import_jobs.run_of_show_id is 'Running order a cue import writes into; NULL for every other target. Fixed once the import exists.';

-- 3. The destination guard ---------------------------------------------------------------------------------------

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
    if new.project_id is distinct from old.project_id or new.run_of_show_id is distinct from old.run_of_show_id then
      perform private.refuse('import_job_immutable', 'An import keeps its file and target; start a new import instead.');
    end if;
    return new;
  end if;
  select t.destination into v_destination from private.import_targets t where t.code = new.target_code;
  if v_destination is null then
    if new.project_id is not null or new.run_of_show_id is not null then
      perform private.refuse('import_destination_unexpected', 'This target imports into the whole organization; it names no running order or project.');
    end if;
  elsif v_destination = 'run_of_show_id' then
    if new.project_id is not null then
      perform private.refuse('import_destination_unexpected', 'A cue import names a running order, not a project.');
    end if;
    if new.run_of_show_id is null then
      perform private.refuse('import_destination_required', 'Choose the running order the rows go into.');
    end if;
    if not exists (select 1 from app.run_of_show r where r.id = new.run_of_show_id and r.deleted_at is null) then
      perform private.refuse('import_destination_unknown', 'The running order does not exist or was deleted.');
    end if;
  else
    if new.run_of_show_id is not null then
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

comment on function private.guard_import_job_destination() is 'Import jobs: a target with a destination names exactly that live running order or project, an org-wide target names neither, and neither column changes after the import exists.';
revoke all on function private.guard_import_job_destination() from public, anon, authenticated;

create trigger t43_guard_import_job_destination before insert or update on app.import_jobs
  for each row execute function private.guard_import_job_destination();

-- 4. Orgs a person may import into ---------------------------------------------------------------------------------

-- From 0530, its only definition. Org-wide targets are unchanged.
create or replace function private.import_target_orgs(p_target_code text)
returns setof uuid
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
  if v_capability is null then
    return;
  end if;
  if v_destination is null then
    return query select private.orgs_with_capability(v_capability);
  else
    return query
    select distinct p.org_id from app.projects p
    where p.id in (select private.project_ids_with(v_capability))
      and p.org_id in (select private.my_org_ids());
  end if;
end;
$$;

comment on function private.import_target_orgs(text) is 'Orgs where the signed-in person may import into a target: for an org-wide target, where they hold its write capability org-wide; for a target with a destination, the orgs they are a member of where they hold it on some project. A project share or record grant from another org never counts (P3 correction C4).';
revoke all on function private.import_target_orgs(text) from public, anon;
grant execute on function private.import_target_orgs(text) to authenticated;

-- 5. One import, from its column values (ADR 0016 rule 14) ----------------------------------------------------------

create or replace function private.import_job_allowed(p_org_id uuid, p_target_code text, p_project_id uuid, p_run_of_show_id uuid)
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
  else
    select p.id into v_project from app.projects p
    where p.id = p_project_id and p.org_id = p_org_id and p.deleted_at is null;
  end if;
  return v_project is not null and private.can_on_project(v_project, v_capability);
end;
$$;

comment on function private.import_job_allowed(uuid, text, uuid, uuid) is 'True when the signed-in person may work on an import with these column values: an org-wide target needs its write capability org-wide in the org; a cue import needs it on the project of the live running order, and a guest list import on the live project, in an org they are a member of. The commit and undo RPCs and the insert policy use it.';
revoke all on function private.import_job_allowed(uuid, text, uuid, uuid) from public, anon;
grant execute on function private.import_job_allowed(uuid, text, uuid, uuid) to authenticated, service_role;

-- 6. Every import of a statement, set-based (C5) -------------------------------------------------------------------

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
  where (p_include_deleted or j.deleted_at is null) and j.org_id in (select m.org_id from member_orgs m);
$$;

comment on function private.permitted_import_job_ids(boolean) is 'Imports the signed-in person may work on, computed once per statement: org-wide targets in orgs where they hold the write capability org-wide, cue imports whose live running order is on a project where they hold it, guest list imports of such a project, the last two only in orgs they are a member of. Soft-deleted imports only when asked. The app.import_jobs read and update policies use it.';
revoke all on function private.permitted_import_job_ids(boolean) from public, anon;
grant execute on function private.permitted_import_job_ids(boolean) to authenticated;

-- From 0530, its only definition.
create or replace function private.readable_import_job_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.permitted_import_job_ids(false);
$$;

comment on function private.readable_import_job_ids() is 'Live imports the signed-in person may see and work on (private.permitted_import_job_ids). Child tables of an import authorize through it.';
revoke all on function private.readable_import_job_ids() from public, anon;
grant execute on function private.readable_import_job_ids() to authenticated;

-- The read policy also admits the person's own new row, which the set does not hold yet while its insert returns it.
call private.install_policies('app.import_jobs',
  $$id in (select private.permitted_import_job_ids(true))
    or (created_by = (select private.current_person_id()) and private.import_job_allowed(org_id, target_code, project_id, run_of_show_id))$$,
  $$private.import_job_allowed(org_id, target_code, project_id, run_of_show_id)$$,
  $$id in (select private.permitted_import_job_ids(true))$$);

-- 7. Commit request (from 1061) --------------------------------------------------------------------------------------

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
  if v_job.id is null or not private.import_job_allowed(v_job.org_id, v_job.target_code, v_job.project_id, v_job.run_of_show_id) then
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

comment on function app.request_import_commit(uuid) is 'Commits a validated import (Section 4.6.2 step 7) for a person who may work on it (private.import_job_allowed: the target''s write capability org-wide, or on the project of a cue or guest list import): opens the import batch once every fuzzy match is decided and queues the worker that writes the rows with the batch id. Refuses an import that is not validated, has pending merge reviews or no valid row. Returns the batch id.';
revoke all on function app.request_import_commit(uuid) from public, anon;
grant execute on function app.request_import_commit(uuid) to authenticated, service_role;

-- 8. Undo (from 0530; only the authorization changes) ---------------------------------------------------------------

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

-- 9. Writes stay inside the destination (from 0530) -------------------------------------------------------------------

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
    if v_target_destination is distinct from (case v_destination when 'run_of_show_id' then v_job.run_of_show_id else v_job.project_id end) then
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

-- 10. Importing another detected sheet (from 1402) -----------------------------------------------------------------------

drop function app.import_detected_sheet(uuid, text);

create function app.import_detected_sheet(p_sheet_id uuid, p_target_code text, p_project_id uuid default null, p_run_of_show_id uuid default null)
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
  if p_target_code is null or v_named is null
     or (not (v_destination = 'run_of_show_id' and p_run_of_show_id is null)
         and not (v_destination = 'project_id' and p_project_id is null)
         and not private.import_job_allowed(v_job.org_id, p_target_code, p_project_id, p_run_of_show_id)) then
    perform private.refuse('import_target_not_allowed', 'You cannot import into that target in this organization.');
  end if;
  if v_sheet.sheet_name = v_job.sheet_name or exists (
       select 1 from app.import_jobs j where j.import_job_sheet_id = p_sheet_id and j.deleted_at is null
         and j.import_status not in ('Canceled', 'Failed', 'Undone')) then
    perform private.refuse('import_sheet_taken', 'An import of this sheet is already open.');
  end if;
  insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, source_url, sheet_name,
    import_job_sheet_id, project_id, run_of_show_id)
  values (v_job.org_id, p_target_code, v_job.source, v_job.original_filename, v_job.storage_object_path, v_job.source_url,
          v_sheet.sheet_name, p_sheet_id, p_project_id, p_run_of_show_id)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.import_detected_sheet(uuid, text, uuid, uuid) is 'Starts the import of another sheet of an already-read workbook into a target the caller may import into, naming the running order (cues) or project (guest list entries) when the target has a destination. The new import reads the same stored file (the caller''s own upload, as for any import) and goes through detection, mapping, validation and commit on its own.';
revoke all on function app.import_detected_sheet(uuid, text, uuid, uuid) from public, anon;
grant execute on function app.import_detected_sheet(uuid, text, uuid, uuid) to authenticated, service_role;

-- 11. Fuzzy candidates learn guest lists (from 0530) -----------------------------------------------------------------------

drop function private.fuzzy_candidates(uuid, text, text, text);

create function private.fuzzy_candidates(p_org_id uuid, p_target_code text, p_name text, p_address text default null, p_project_id uuid default null)
returns table (candidate_table text, candidate_id uuid, similarity numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_probe text := lower(btrim(coalesce(p_name, '') || ' ' || coalesce(p_address, '')));
begin
  if p_target_code = 'venues' then
    return query
    select 'app.venues'::text, v.id, round(extensions.similarity(
      lower(btrim(v.name || ' ' || concat_ws(' ', v.street_address, v.locality, v.postal_code))), v_probe)::numeric, 3)
    from app.venues v
    where v.org_id = p_org_id and v.deleted_at is null
      and extensions.similarity(lower(btrim(v.name || ' ' || concat_ws(' ', v.street_address, v.locality, v.postal_code))), v_probe) >= 0.85
    order by 3 desc;
  elsif p_target_code = 'counterparties' then
    return query
    select 'app.counterparties'::text, c.id, round(extensions.similarity(lower(o.name), lower(btrim(p_name)))::numeric, 3)
    from app.counterparties c join app.organizations o on o.id = c.organization_id
    where c.org_id = p_org_id and c.deleted_at is null
      and extensions.similarity(lower(o.name), lower(btrim(p_name))) >= 0.85
    order by 3 desc;
  elsif p_target_code = 'guest_list_entries' then
    return query
    select 'app.guest_list_entries'::text, g.id, round(extensions.similarity(lower(btrim(g.guest_name)), lower(btrim(p_name)))::numeric, 3)
    from app.guest_list_entries g
    where g.org_id = p_org_id and g.project_id = p_project_id and g.deleted_at is null
      and extensions.similarity(lower(btrim(g.guest_name)), lower(btrim(p_name))) >= 0.85
    order by 3 desc;
  end if;
end;
$$;

comment on function private.fuzzy_candidates(uuid, text, text, text, uuid) is 'Existing rows of the org whose name plus address is at least 0.85 similar (pg_trgm) to an import row (Section 4.6.2 step 5); for a guest list import, live guests of the import''s project by name. Strong keys are matched exactly before this runs.';
revoke all on function private.fuzzy_candidates(uuid, text, text, text, uuid) from public, anon, authenticated;

create or replace function app.record_import_row(
  p_import_job_id uuid,
  p_sheet_name text,
  p_row_number integer,
  p_row_state app.import_row_state,
  p_reason text default null,
  p_match_name text default null,
  p_match_address text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job app.import_jobs;
  v_id uuid;
begin
  select * into v_job from app.import_jobs where id = p_import_job_id and deleted_at is null;
  if v_job.id is null then
    perform private.refuse('import_job_unknown', 'No such import.');
  end if;
  if v_job.mapping_confirmed_at is null then
    perform private.refuse('import_mapping_unconfirmed', 'Every column mapping must be confirmed before rows are validated.');
  end if;
  if p_row_state = 'Written' then
    perform private.refuse('import_row_written_by_commit', 'Rows become Written only through app.commit_import_write.');
  end if;
  insert into app.import_row_results (import_job_id, sheet_name, row_number, row_state, reason)
  values (p_import_job_id, p_sheet_name, p_row_number, p_row_state, p_reason)
  returning id into v_id;
  if p_row_state = 'Valid' and p_match_name is not null then
    insert into app.merge_reviews (import_row_result_id, candidate_table, candidate_id, similarity)
    select v_id, f.candidate_table, f.candidate_id, f.similarity
    from private.fuzzy_candidates(v_job.org_id, v_job.target_code, p_match_name, p_match_address, v_job.project_id) f;
  end if;
  return v_id;
end;
$$;

comment on function app.record_import_row(uuid, text, integer, app.import_row_state, text, text, text) is 'Import worker API (service role): records a validated row. A Valid row with a name is matched fuzzily (within the project for a guest list import) and every candidate at 0.85 or more goes to merge review.';
revoke all on function app.record_import_row(uuid, text, integer, app.import_row_state, text, text, text) from public, anon, authenticated;
grant execute on function app.record_import_row(uuid, text, integer, app.import_row_state, text, text, text) to service_role;

-- 12. Destinations a person may import into (C6) ---------------------------------------------------------------------------

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

comment on function app.import_destinations(uuid, text, uuid) is 'Running orders (cues: label project key · name, with the show date) or projects (guest list entries: project key · name) of one org that the signed-in person may import into, newest first, at most 200, plus p_include when they may import into it, so a preselected destination always resolves. Nothing for an org-wide target or an org the person is not a member of.';
revoke all on function app.import_destinations(uuid, text, uuid) from public, anon;
grant execute on function app.import_destinations(uuid, text, uuid) to authenticated, service_role;

-- 13. Strong key match (C9) -------------------------------------------------------------------------------------------------

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
  end if;
  return v_id;
end;
$$;

comment on function app.import_strong_key_match(uuid, jsonb) is 'Import worker API (service role): the existing row of a cue or guest list import''s destination that a row matches exactly on its strong keys, or NULL. Cues match on position, or without one on label and planned time; guests on the trimmed name, case-insensitively, and the show. A NULL show or time matches only NULL. The destination always comes from the import, never from the sheet.';
revoke all on function app.import_strong_key_match(uuid, jsonb) from public, anon, authenticated;
grant execute on function app.import_strong_key_match(uuid, jsonb) to service_role;
