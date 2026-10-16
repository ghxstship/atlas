-- 1041_upload_scanning.sql
-- A34 security fixes (RRR-78), finding A22-011: uploads are scanned before other people can read them.
--
-- The attachments bucket already keeps a scan state per version (0590) and serves only Clean versions;
-- the A18 job attachment.scan now has a worker (packages/platform scanning, the upload-scan Edge
-- Function) that calls app.record_attachment_scan.
--
-- This migration gives the other four upload buckets a scan state:
--   * private.object_scans: one row per stored object in field-media, onboarding-uploads, profile-media
--     and org-brand, created by a trigger on storage.objects when an object is written or replaced, and
--     removed when the object is deleted. Objects stored before this migration are queued too.
--   * field-media and onboarding-uploads are private: a restrictive read policy lets other people read
--     an object only once it scans Clean. The uploader (the object's owner) still reads their own file,
--     which also keeps INSERT ... RETURNING working for the storage API.
--   * profile-media and org-brand are public buckets, read by URL without any policy, so no read gate
--     can apply. They are scanned all the same, and the worker removes an object that is Infected or
--     whose bytes are not the image type it claims; A22-004 already limits both to raster images.
--   * app.claim_object_scans and app.record_object_scan (service role): the worker claims due scans with
--     SKIP LOCKED and records each verdict; app.release_object_scan retries a scan the scanner could not
--     finish, with backoff, and marks it Scan Failed after five attempts.
-- Helpers take column values as arguments and never re-read storage.objects (ADR 0016 crash rule).

-- Scan state -----------------------------------------------------------------------------------------------------

create table private.object_scans (
  id uuid primary key default private.uuid_v7(),
  bucket_id text not null,
  object_name text not null,
  scan_status app.scan_status not null default 'Scanning',
  attempts smallint not null default 0,
  run_after timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  scanned_at timestamptz,
  scan_detail text,
  created_at timestamptz not null default now(),
  constraint object_scans_bucket check (bucket_id in ('field-media', 'onboarding-uploads', 'profile-media', 'org-brand')),
  constraint object_scans_status check (scan_status in ('Scanning', 'Clean', 'Infected', 'Scan Failed')),
  constraint object_scans_attempts_nonnegative check (attempts >= 0),
  constraint object_scans_lock_pair check ((locked_by is null) = (locked_at is null)),
  constraint object_scans_scanned check ((scanned_at is null) = (scan_status = 'Scanning')),
  constraint object_scans_detail_length check (scan_detail is null or char_length(scan_detail) <= 500),
  constraint object_scans_locked_by_length check (locked_by is null or char_length(locked_by) <= 200)
);

create unique index object_scans_object_key on private.object_scans (bucket_id, object_name);
create index object_scans_due_idx on private.object_scans (run_after) where scan_status = 'Scanning';

comment on table private.object_scans is 'Virus-scan state of each object in the field-media, onboarding-uploads, profile-media and org-brand buckets (A22-011, Section 9). Private buckets serve an object to anyone but its uploader only once it is Clean; public buckets lose an object that is not.';
comment on column private.object_scans.id is 'Scan id.';
comment on column private.object_scans.bucket_id is 'Bucket of the object.';
comment on column private.object_scans.object_name is 'Object name in the bucket.';
comment on column private.object_scans.scan_status is 'Scanning, Clean, Infected or Scan Failed.';
comment on column private.object_scans.attempts is 'Scan attempts started so far.';
comment on column private.object_scans.run_after is 'Earliest time a worker may claim the scan.';
comment on column private.object_scans.locked_by is 'Worker that holds the scan while it runs.';
comment on column private.object_scans.locked_at is 'When the worker claimed the scan; a claim older than 10 minutes is abandoned.';
comment on column private.object_scans.scanned_at is 'When the scan reached a verdict.';
comment on column private.object_scans.scan_detail is 'Scanner finding or refusal reason, for an infected, refused or failed scan.';
comment on column private.object_scans.created_at is 'When the object was written and queued.';

alter table private.object_scans enable row level security;
revoke all on private.object_scans from public, anon, authenticated;
grant select on private.object_scans to service_role;

-- Queueing ----------------------------------------------------------------------------------------------------------

create or replace function private.queue_object_scan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.bucket_id not in ('field-media', 'onboarding-uploads', 'profile-media', 'org-brand') then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.name = old.name and new.version is not distinct from old.version
     and new.metadata is not distinct from old.metadata then
    return null;
  end if;
  insert into private.object_scans (bucket_id, object_name)
  values (new.bucket_id, new.name)
  on conflict (bucket_id, object_name) do update
    set scan_status = 'Scanning', attempts = 0, run_after = now(), locked_by = null, locked_at = null,
        scanned_at = null, scan_detail = null;
  if tg_op = 'UPDATE' and new.name <> old.name then
    delete from private.object_scans s where s.bucket_id = old.bucket_id and s.object_name = old.name;
  end if;
  return null;
end;
$$;

comment on function private.queue_object_scan() is 'After a write to storage.objects in a scanned bucket: queues the object for scanning, and queues it again when its content is replaced or it is renamed (A22-011).';

create trigger t90_queue_object_scan after insert or update on storage.objects
  for each row execute function private.queue_object_scan();

create or replace function private.forget_object_scan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.object_scans s where s.bucket_id = old.bucket_id and s.object_name = old.name;
  return null;
end;
$$;

comment on function private.forget_object_scan() is 'After an object is deleted from storage.objects: drops its scan state.';

create trigger t90_forget_object_scan after delete on storage.objects
  for each row execute function private.forget_object_scan();

insert into private.object_scans (bucket_id, object_name)
select o.bucket_id, o.name from storage.objects o
where o.bucket_id in ('field-media', 'onboarding-uploads', 'profile-media', 'org-brand') and o.name is not null
on conflict (bucket_id, object_name) do nothing;

-- Read gate ---------------------------------------------------------------------------------------------------------

create or replace function private.object_scan_clean(p_bucket_id text, p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.object_scans s
    where s.bucket_id = p_bucket_id and s.object_name = p_object_name and s.scan_status = 'Clean');
$$;

comment on function private.object_scan_clean(text, text) is 'True when an object in a scanned bucket has scanned Clean. Takes the bucket and name as values (ADR 0016).';

create policy object_scan_read_gate on storage.objects
  as restrictive
  for select to authenticated
  using (bucket_id not in ('field-media', 'onboarding-uploads')
         or owner_id = (select auth.uid())::text
         or private.object_scan_clean(bucket_id, name));

comment on policy object_scan_read_gate on storage.objects is 'A22-011: in the private upload buckets field-media and onboarding-uploads, only the uploader reads an object before it scans Clean.';

-- Worker API ----------------------------------------------------------------------------------------------------------

create or replace function app.claim_object_scans(p_worker text, p_limit integer default 10)
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
      where q.scan_status = 'Scanning' and q.run_after <= now()
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

comment on function app.claim_object_scans(text, integer) is 'Scanner API (service role): claims up to p_limit due object scans, skipping rows another worker holds, with each object''s declared type and size. A claim older than 10 minutes is taken over.';

create or replace function app.record_object_scan(p_object_scan_id uuid, p_clean boolean, p_detail text default null)
returns app.scan_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_scan private.object_scans;
  v_status app.scan_status;
begin
  select * into v_scan from private.object_scans s where s.id = p_object_scan_id for update;
  if v_scan.id is null or v_scan.scan_status <> 'Scanning' then
    perform private.refuse('object_scan_not_scanning', 'Only an object being scanned takes a scan result.');
  end if;
  v_status := case when p_clean is null then 'Scan Failed' when p_clean then 'Clean' else 'Infected' end;
  update private.object_scans
  set scan_status = v_status, scanned_at = now(), scan_detail = left(p_detail, 500), locked_by = null, locked_at = null
  where id = v_scan.id;
  return v_status;
end;
$$;

comment on function app.record_object_scan(uuid, boolean, text) is 'Scanner API (service role): records a verdict. Clean opens the object to its readers; Infected, or a refusal recorded as null (Scan Failed), keeps it closed, and the scanner removes the object.';

create or replace function app.release_object_scan(p_object_scan_id uuid, p_error text)
returns app.scan_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_scan private.object_scans;
begin
  select * into v_scan from private.object_scans s where s.id = p_object_scan_id for update;
  if v_scan.id is null or v_scan.scan_status <> 'Scanning' then
    perform private.refuse('object_scan_not_scanning', 'Only an object being scanned can be retried.');
  end if;
  if v_scan.attempts >= 5 then
    update private.object_scans
    set scan_status = 'Scan Failed', scanned_at = now(), scan_detail = left(coalesce(p_error, 'The scanner did not answer.'), 500),
        locked_by = null, locked_at = null
    where id = v_scan.id;
    return 'Scan Failed';
  end if;
  update private.object_scans
  set locked_by = null, locked_at = null, scan_detail = left(p_error, 500),
      run_after = now() + make_interval(secs => least(30 * power(2, v_scan.attempts - 1), 3600))
  where id = v_scan.id;
  return 'Scanning';
end;
$$;

comment on function app.release_object_scan(uuid, text) is 'Scanner API (service role): the scanner could not finish (unreachable, timed out). The scan is retried after 30 seconds doubling per attempt, and is Scan Failed after five attempts.';

-- Privileges ---------------------------------------------------------------------------------------------------------

revoke all on function private.queue_object_scan() from public, anon, authenticated;
revoke all on function private.forget_object_scan() from public, anon, authenticated;
revoke all on function private.object_scan_clean(text, text) from public, anon;
grant execute on function private.object_scan_clean(text, text) to authenticated, service_role;
revoke all on function app.claim_object_scans(text, integer) from public, anon, authenticated;
grant execute on function app.claim_object_scans(text, integer) to service_role;
revoke all on function app.record_object_scan(uuid, boolean, text) from public, anon, authenticated;
grant execute on function app.record_object_scan(uuid, boolean, text) to service_role;
revoke all on function app.release_object_scan(uuid, text) from public, anon, authenticated;
grant execute on function app.release_object_scan(uuid, text) to service_role;
