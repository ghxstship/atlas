-- 1240_upload_quarantine.sql
-- A57 (RRR-102), owner decision 10: every upload is virus-scanned by self-hosted ClamAV and stays
-- quarantined until it scans Clean (ADR 0033). Builds on 1041 (A22-011).
--
--   * The imports and support-screenshots buckets join private.object_scans. Only the uploader reads
--     these files (1061, 1034); until a file scans Clean the import worker does not parse it
--     (app.object_scan_status), and support staff tooling, which uses the service role, must not open it.
--   * An import is detected only once its spreadsheet scans Clean: creating the job queues detection
--     when the file is already Clean, and the verdict queues it otherwise; an Infected or refused file
--     marks the import Failed. The scan row is locked on both sides, so the two cannot miss each other.
--   * A verdict outlives the file. The worker removes an Infected or refused object, and 1041 then
--     dropped its scan row, so the uploader could never learn why the file vanished. Infected and Scan
--     Failed rows now stay, keyed by bucket and name with the uploader's id, until that name is
--     uploaded again; app.my_upload_scan_status gives the uploader, and only the uploader, the verdict
--     for a plain-language message.
-- Helpers take column values as arguments and never re-read storage.objects (ADR 0016 crash rule).

-- Scanned buckets ---------------------------------------------------------------------------------------------

create or replace function private.scanned_upload_bucket(p_bucket_id text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_bucket_id in ('field-media', 'onboarding-uploads', 'profile-media', 'org-brand', 'imports', 'support-screenshots');
$$;

comment on function private.scanned_upload_bucket(text) is 'True for a bucket whose objects are virus-scanned through private.object_scans (1041, 1240): field-media, onboarding-uploads, profile-media, org-brand, imports and support-screenshots. Attachments keep their own scan state (0590).';
revoke all on function private.scanned_upload_bucket(text) from public, anon;
grant execute on function private.scanned_upload_bucket(text) to authenticated, service_role;

alter table private.object_scans drop constraint object_scans_bucket;
alter table private.object_scans add constraint object_scans_bucket check (private.scanned_upload_bucket(bucket_id));

alter table private.object_scans add column owner_id text;
alter table private.object_scans add constraint object_scans_owner_length check (owner_id is null or char_length(owner_id) <= 100);
update private.object_scans s set owner_id = o.owner_id
from storage.objects o where o.bucket_id = s.bucket_id and o.name = s.object_name;

comment on table private.object_scans is 'Virus-scan state of each object in the scanned upload buckets (A22-011, 1240). Private buckets serve an object to anyone but its uploader only once it is Clean; public buckets lose an object that is not. Infected and Scan Failed rows outlive the removed object so its uploader can be told why.';
comment on column private.object_scans.owner_id is 'Storage owner (auth user id) of the object when it was queued; the only caller app.my_upload_scan_status answers.';

-- Queueing and forgetting ---------------------------------------------------------------------------------------

create or replace function private.queue_object_scan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.scanned_upload_bucket(new.bucket_id) then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.name = old.name and new.version is not distinct from old.version
     and new.metadata is not distinct from old.metadata then
    return null;
  end if;
  insert into private.object_scans (bucket_id, object_name, owner_id)
  values (new.bucket_id, new.name, new.owner_id)
  on conflict (bucket_id, object_name) do update
    set scan_status = 'Scanning', attempts = 0, run_after = now(), locked_by = null, locked_at = null,
        scanned_at = null, scan_detail = null, owner_id = excluded.owner_id;
  if tg_op = 'UPDATE' and new.name <> old.name then
    delete from private.object_scans s where s.bucket_id = old.bucket_id and s.object_name = old.name;
  end if;
  return null;
end;
$$;

comment on function private.queue_object_scan() is 'After a write to storage.objects in a scanned bucket: queues the object for scanning with its uploader, and queues it again when its content is replaced or it is renamed (A22-011, 1240).';

create or replace function private.forget_object_scan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.object_scans s
  where s.bucket_id = old.bucket_id and s.object_name = old.name
    and s.scan_status in ('Scanning', 'Clean');
  return null;
end;
$$;

comment on function private.forget_object_scan() is 'After an object is deleted from storage.objects: drops its scan state, unless the scan was Infected or Scan Failed, whose verdict stays for the uploader (1240).';

insert into private.object_scans (bucket_id, object_name, owner_id)
select o.bucket_id, o.name, o.owner_id from storage.objects o
where o.bucket_id in ('imports', 'support-screenshots') and o.name is not null
on conflict (bucket_id, object_name) do nothing;

-- Read gate -------------------------------------------------------------------------------------------------------

-- 1041's restrictive gate (only the uploader reads an object before it is Clean) is not widened: in
-- imports and support-screenshots the path policies (1061, 1034) already let only the uploader read an
-- object at all. Everyone else reaches these files only through the service role, which checks
-- app.object_scan_status first.

-- Verdicts ----------------------------------------------------------------------------------------------------------

create or replace function app.object_scan_status(p_bucket_id text, p_object_name text)
returns app.scan_status
language sql
stable
security definer
set search_path = ''
as $$
  select s.scan_status from private.object_scans s
  where s.bucket_id = p_bucket_id and s.object_name = p_object_name;
$$;

comment on function app.object_scan_status(text, text) is 'Workers (service role): the scan status of an object in a scanned bucket, or NULL when it has none yet. The import worker parses a spreadsheet only once it is Clean (1240).';

create or replace function app.my_upload_scan_status(p_bucket_id text, p_object_name text)
returns app.scan_status
language sql
stable
security definer
set search_path = ''
as $$
  select s.scan_status from private.object_scans s
  where s.bucket_id = p_bucket_id and s.object_name = p_object_name
    and s.owner_id is not null and s.owner_id = (select auth.uid())::text;
$$;

comment on function app.my_upload_scan_status(text, text) is 'The uploader''s view of their own upload''s scan: Scanning, Clean, Infected or Scan Failed, kept after an infected file is removed so Atlas can say why. NULL for anyone else''s object (1240).';

create or replace function app.claim_bucket_scans(p_bucket_id text, p_worker text, p_limit integer default 10)
returns table (object_scan_id uuid, bucket_id text, object_name text, content_type text, size_bytes bigint, attempts integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return query
  with claimed as (
    update private.object_scans s
    set attempts = s.attempts + 1, locked_by = left(p_worker, 200), locked_at = now()
    where s.id in (
      select q.id from private.object_scans q
      where q.bucket_id = p_bucket_id and q.scan_status = 'Scanning' and q.run_after <= now()
        and (q.locked_at is null or q.locked_at < now() - interval '10 minutes')
      order by q.run_after
      limit greatest(1, least(coalesce(p_limit, 10), 100))
      for update skip locked)
    returning s.id, s.bucket_id, s.object_name, s.attempts
  )
  select c.id, c.bucket_id, c.object_name, lower(o.metadata ->> 'mimetype'), (o.metadata ->> 'size')::bigint, c.attempts::integer
  from claimed c
  left join storage.objects o on o.bucket_id = c.bucket_id and o.name = c.object_name;
end;
$$;

comment on function app.claim_bucket_scans(text, text, integer) is 'Scanner API (service role): app.claim_object_scans for one bucket only, for a worker or a local test run that scans one bucket without touching the others (1240).';

revoke all on function app.claim_bucket_scans(text, text, integer) from public, anon, authenticated;
grant execute on function app.claim_bucket_scans(text, text, integer) to service_role;
revoke all on function app.object_scan_status(text, text) from public, anon, authenticated;
grant execute on function app.object_scan_status(text, text) to service_role;
revoke all on function app.my_upload_scan_status(text, text) from public, anon;
grant execute on function app.my_upload_scan_status(text, text) to authenticated, service_role;

-- Imports wait for Clean ---------------------------------------------------------------------------------------------

create or replace function private.queue_import_work()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scan app.scan_status;
  v_scanned boolean;
begin
  if tg_op = 'INSERT' then
    -- Lock the upload's scan row so a verdict being recorded right now either sees this job or is
    -- seen by it (private.on_import_upload_scanned).
    select s.scan_status, true into v_scan, v_scanned from private.object_scans s
    where s.bucket_id = 'imports' and s.object_name = new.storage_object_path
    for update;
    if v_scanned is null or v_scan <> 'Scanning' then
      -- Clean: detect it. No scan row (no stored object), Infected or Scan Failed: the detection step
      -- reports the import Failed, as the service.
      perform private.enqueue_job(new.org_id, 'import.detect', new.id);
    end if;
  elsif new.mapping_confirmed_at is not null and old.mapping_confirmed_at is null then
    perform private.enqueue_job(new.org_id, 'import.validate', new.id);
  end if;
  return null;
end;
$$;

comment on function private.queue_import_work() is 'Queues detection when an import is created and its spreadsheet has scanned Clean (otherwise the scan verdict queues it, 1240), and validation once its column mapping is confirmed (Section 4.6.2 steps 2 and 4).';
revoke all on function private.queue_import_work() from public, anon, authenticated;

create or replace function private.on_import_upload_scanned()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job record;
begin
  for v_job in
    select j.id, j.org_id from app.import_jobs j
    where j.storage_object_path = new.object_name and j.import_status = 'Uploaded' and j.deleted_at is null
  loop
    if new.scan_status = 'Clean' then
      if not exists (select 1 from app.job_queue q where q.job_kind = 'import.detect' and q.subject_id = v_job.id) then
        perform private.enqueue_job(v_job.org_id, 'import.detect', v_job.id);
      end if;
    else
      update app.import_jobs set import_status = 'Failed' where id = v_job.id;
    end if;
  end loop;
  return null;
end;
$$;

comment on function private.on_import_upload_scanned() is 'After an imports spreadsheet gets a verdict (1240): Clean queues detection for its waiting import; Infected or Scan Failed marks that import Failed, and Atlas tells the uploader why (app.my_upload_scan_status).';
revoke all on function private.on_import_upload_scanned() from public, anon, authenticated;

create trigger t60_import_upload_scanned after update of scan_status on private.object_scans
  for each row
  when (new.bucket_id = 'imports' and old.scan_status = 'Scanning' and new.scan_status <> 'Scanning')
  execute function private.on_import_upload_scanned();
