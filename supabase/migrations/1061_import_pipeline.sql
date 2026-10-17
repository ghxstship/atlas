-- 1061_import_pipeline.sql
-- A36 Import wizard (Section 4.6.2), on A18's import schema (0530):
--   * the imports bucket: a person uploads the spreadsheet under their own folder; only they and the
--     import worker (service role) ever read it, so nothing unscanned is served to anyone else (A22-011)
--   * import jobs name only their creator's own uploads
--   * detection and validation are queued when a job is created and when its mapping is confirmed;
--     committing is requested through app.request_import_commit, which opens the batch and queues the
--     worker (detection, validation and the writes stay service role by design)
--   * import_row_matches: the worker's strong key matches, so the dry run counts updates
--   * app.import_dry_run: counts of creates, updates, merges, refusals and pending reviews
--   * target field fixes: a client counterparty has no counterparty type, and a vendor product names
--     its vendor

-- Target fields ---------------------------------------------------------------------------------------------

-- A client counterparty carries no canon counterparty type (0301: NULL for a client), so the type is
-- optional; a vendor product needs its vendor, which the worker resolves by name within the org.
update private.import_target_fields set required = false where target_code = 'counterparties' and field_name = 'counterparty_type';
insert into private.import_target_fields (target_code, field_name, required, strong_key)
values ('vendor_products', 'vendor_name', true, false)
on conflict (target_code, field_name) do nothing;

-- Uploads -----------------------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('imports', 'imports', false, 10485760, array[
  'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'])
on conflict (id) do nothing;

create or replace function private.import_object_owner(p_object_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_object_name is null or p_object_name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(csv|xlsx|xls)$' then
    return null;
  end if;
  return split_part(p_object_name, '/', 1)::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

comment on function private.import_object_owner(text) is 'Person id that owns an imports object (<person_id>/<upload id>.<csv|xlsx|xls>), or NULL for any other name. Takes the name as a value (ADR 0016 rule 14).';
revoke all on function private.import_object_owner(text) from public, anon;
grant execute on function private.import_object_owner(text) to authenticated, service_role;

create policy imports_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'imports' and private.import_object_owner(name) = (select private.current_person_id()));
create policy imports_read on storage.objects for select to authenticated
  using (bucket_id = 'imports' and private.import_object_owner(name) = (select private.current_person_id()));

comment on policy imports_insert on storage.objects is 'A36: a person uploads import spreadsheets only into their own folder of the imports bucket.';
comment on policy imports_read on storage.objects is 'A36: only the uploader reads an import spreadsheet; the import worker reads it with the service role and parses it as data, never serving it (A22-011).';

create or replace function private.guard_import_job_upload()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
begin
  if v_person is not null and private.import_object_owner(new.storage_object_path) is distinct from v_person then
    perform private.refuse('import_upload_owner', 'An import reads a spreadsheet you uploaded yourself.');
  end if;
  return new;
end;
$$;

comment on function private.guard_import_job_upload() is 'A person''s import job names only a spreadsheet in their own folder of the imports bucket.';
revoke all on function private.guard_import_job_upload() from public, anon, authenticated;

create trigger t41_guard_import_job_upload before insert on app.import_jobs
  for each row execute function private.guard_import_job_upload();

-- Queueing ----------------------------------------------------------------------------------------------------

create or replace function private.queue_import_work()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.enqueue_job(new.org_id, 'import.detect', new.id);
  elsif new.mapping_confirmed_at is not null and old.mapping_confirmed_at is null then
    perform private.enqueue_job(new.org_id, 'import.validate', new.id);
  end if;
  return null;
end;
$$;

comment on function private.queue_import_work() is 'Queues detection when an import is created and validation once its column mapping is confirmed (Section 4.6.2 steps 2 and 4).';
revoke all on function private.queue_import_work() from public, anon, authenticated;

create trigger t60_queue_import_work after insert or update of mapping_confirmed_at on app.import_jobs
  for each row execute function private.queue_import_work();

-- Strong key matches --------------------------------------------------------------------------------------------

create table app.import_row_matches (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  import_row_result_id uuid not null references app.import_row_results (id),
  target_id uuid not null
);

create unique index import_row_matches_row_key on app.import_row_matches (import_row_result_id);
create index import_row_matches_target_idx on app.import_row_matches (target_id);

call private.install_domain_table('app.import_row_matches', 'app.import_row_results', 'import_row_result_id');
call private.describe('app.import_row_matches', 'An existing row a Valid import row matched exactly on a strong key such as an asset tag or vendor SKU (Section 4.6.2 step 5): committing updates it instead of creating a new row. Written by the import worker.', array[
  'import_row_result_id', 'Import row that matched.',
  'target_id', 'Existing row of the import''s target table it matched.'
]);

call private.install_policies('app.import_row_matches',
  $$import_row_result_id in (select r.id from app.import_row_results r where r.import_job_id in (select private.readable_import_job_ids()))$$);

-- Dry run and commit ----------------------------------------------------------------------------------------------

-- A18's job guard, unchanged except that a person's commit request (app.request_import_commit, which
-- opens the batch through the worker API) may move the job to Committing.
create or replace function private.guard_import_job()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.current_person_id() is null or private.in_trusted_operation('import_undo')
     or private.in_trusted_operation('import_commit_request') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.import_status := 'Uploaded';
    new.mapping_confirmed_at := null;
    return new;
  end if;
  if new.import_status is distinct from old.import_status and not (new.import_status = 'Canceled' and old.import_status not in ('Committing', 'Committed', 'Undone')) then
    perform private.refuse('import_status_service_only', 'Import progress is set by the import service; a person may only cancel an uncommitted import.');
  end if;
  if new.target_code <> old.target_code or new.storage_object_path <> old.storage_object_path or new.source <> old.source then
    perform private.refuse('import_job_immutable', 'An import keeps its file and target; start a new import instead.');
  end if;
  if new.mapping_confirmed_at is distinct from old.mapping_confirmed_at then
    if old.mapping_confirmed_at is not null or old.import_status <> 'Mapped' then
      perform private.refuse('import_mapping_confirmation', 'Mappings are confirmed once, after detection proposes them.');
    end if;
    new.mapping_confirmed_at := now();
  end if;
  return new;
end;
$$;

comment on function private.guard_import_job() is 'Import jobs: a person creates them as Uploaded, confirms the mapping once when it is Mapped (the database stamps the time) and may cancel before commit; all other progress comes from the import service, or from app.request_import_commit opening the batch.';
revoke all on function private.guard_import_job() from public, anon, authenticated;

create or replace function app.import_dry_run(p_import_job_id uuid)
returns table (creates integer, updates integer, merges integer, refusals integer, skipped integer, pending_reviews integer)
language sql
stable
security invoker
set search_path = ''
as $$
  with rows as (
    select r.id, r.row_state,
      exists (select 1 from app.import_row_matches m where m.import_row_result_id = r.id and m.deleted_at is null) as matched,
      exists (select 1 from app.merge_reviews v where v.import_row_result_id = r.id and v.decision = 'Merged' and v.deleted_at is null) as merged,
      exists (select 1 from app.merge_reviews v where v.import_row_result_id = r.id and v.decision = 'Pending' and v.deleted_at is null) as pending
    from app.import_row_results r
    where r.import_job_id = p_import_job_id and r.deleted_at is null
  )
  select
    count(*) filter (where row_state = 'Valid' and not matched and not merged)::integer,
    count(*) filter (where row_state = 'Valid' and matched and not merged)::integer,
    count(*) filter (where row_state = 'Valid' and merged)::integer,
    count(*) filter (where row_state in ('Invalid', 'Refused'))::integer,
    count(*) filter (where row_state = 'Skipped')::integer,
    (select count(*)::integer from app.merge_reviews v join rows x on x.id = v.import_row_result_id
     where v.decision = 'Pending' and v.deleted_at is null)
  from rows;
$$;

comment on function app.import_dry_run(uuid) is 'Dry run of an import (Section 4.6.2 step 6), read with the caller''s row level security: rows that will be created, updated on a strong key match, merged after review, refused, skipped, and fuzzy matches still pending. Rows with a pending review count as creates until decided.';
revoke all on function app.import_dry_run(uuid) from public, anon;
grant execute on function app.import_dry_run(uuid) to authenticated, service_role;

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
  if v_job.id is null or v_job.org_id not in (select private.import_target_orgs(v_job.target_code)) then
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

comment on function app.request_import_commit(uuid) is 'Commits a validated import (Section 4.6.2 step 7) for a person who may import into its target: opens the import batch once every fuzzy match is decided and queues the worker that writes the rows with the batch id. Refuses an import that is not validated, has pending merge reviews or no valid row. Returns the batch id.';
revoke all on function app.request_import_commit(uuid) from public, anon;
grant execute on function app.request_import_commit(uuid) to authenticated, service_role;

-- Retention ---------------------------------------------------------------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.import_row_matches', 'Age', 'created_at', interval '1 year', 'Delete', 'Kept as long as their import row.');
