-- 2051_import_finished_notice.sql
--
-- Import finished notices (ADR 0022, 2050-2059), A104, RRR-149; a follow-up of A83 (RRR-128). import.finished was
-- registered with its own email template (import_finished: the import's name, its counts and a review link) but the
-- import pipeline (0530, 1061) notified nobody, because only the import worker (packages/data import-worker.ts) knows
-- Atlas's address and can build an absolute link. The worker now calls app.notify_import_finished when it finishes
-- validating an import and when it finishes committing one:
--
--   * validated (no batch): the person who started the import learns it is ready to review. written counts the rows
--     ready to write (Valid), refused the rows that need fixing (Invalid) and skipped the blank ones.
--   * committed (a batch): the person who committed it learns what happened. written counts the rows the batch
--     wrote, refused the rows it could not write and those that were invalid, and skipped the blank ones.
--
-- The counts come from the import's row results, not from the worker. The message arguments carry title and
-- importName (the file, with the sheet when a workbook's sheet is imported), stage, the three counts as numbers and
-- url, exactly what the import_finished template reads (packages/platform dispatch.ts). The notice is about the import
-- (subject app.import_jobs), whose Inbox item opens it in the wizard. Service role only, like the other worker RPCs.

create or replace function app.notify_import_finished(p_import_job_id uuid, p_import_batch_id uuid, p_review_url text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job app.import_jobs;
  v_batch app.import_batches;
  v_person uuid;
  v_stage text;
  v_name text;
  v_written integer;
  v_refused integer;
  v_skipped integer;
begin
  if p_review_url is null or char_length(p_review_url) > 2048 or p_review_url !~ '^https?://[^/?#[:space:]]+/[^[:space:]]*$' then
    perform private.refuse('import_review_url_invalid', 'The review link is an absolute http or https address.');
  end if;
  select * into v_job from app.import_jobs j where j.id = p_import_job_id and j.deleted_at is null;
  if v_job.id is null then
    perform private.refuse('import_not_found', 'No import has that id.');
  end if;

  if p_import_batch_id is null then
    if v_job.import_status <> 'Validated' then
      perform private.refuse('import_not_finished', 'Only a validated import or a committed batch is announced.');
    end if;
    v_stage := 'validated';
    v_person := v_job.created_by;
    select count(*) filter (where r.row_state = 'Valid'),
           count(*) filter (where r.row_state = 'Invalid'),
           count(*) filter (where r.row_state = 'Skipped')
      into v_written, v_refused, v_skipped
    from app.import_row_results r where r.import_job_id = v_job.id and r.deleted_at is null;
  else
    select * into v_batch from app.import_batches b
    where b.id = p_import_batch_id and b.import_job_id = v_job.id and b.deleted_at is null;
    if v_batch.id is null or v_batch.committed_at is null then
      perform private.refuse('import_not_finished', 'Only a validated import or a committed batch is announced.');
    end if;
    v_stage := 'committed';
    v_person := coalesce(v_batch.created_by, v_job.created_by);
    select count(*) filter (where r.row_state = 'Written' and r.import_batch_id = v_batch.id),
           count(*) filter (where r.row_state in ('Refused', 'Invalid')),
           count(*) filter (where r.row_state = 'Skipped')
      into v_written, v_refused, v_skipped
    from app.import_row_results r where r.import_job_id = v_job.id and r.deleted_at is null;
  end if;

  if v_person is null then
    return null;
  end if;
  -- A CSV's one sheet carries the file's name; a workbook's sheet follows the file's.
  v_name := v_job.original_filename
    || case when v_job.sheet_name is not null and v_job.sheet_name <> v_job.original_filename then ' · ' || v_job.sheet_name else '' end;
  return private.notify(v_job.org_id, v_person, 'import.finished', 'app.import_jobs', v_job.id, null,
    jsonb_build_object('title', v_name, 'importName', v_name, 'stage', v_stage, 'written', v_written,
      'refused', v_refused, 'skipped', v_skipped, 'url', p_review_url));
end;
$$;

comment on function app.notify_import_finished(uuid, uuid, text) is 'Import worker API (service role): tells the person who started an import that it finished validating (no batch), or the person who committed a batch that it finished committing, with import.finished: the import''s name, its written, refused and skipped rows counted from its row results, and the absolute review link the worker built (A104). Returns the notification id, or null when nobody started it.';
revoke all on function app.notify_import_finished(uuid, uuid, text) from public, anon, authenticated;
grant execute on function app.notify_import_finished(uuid, uuid, text) to service_role;
