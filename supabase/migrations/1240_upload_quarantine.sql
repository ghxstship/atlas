-- 1240_upload_quarantine.sql
-- A57 (RRR-102), owner decision 10: every upload is virus-scanned by self-hosted ClamAV and stays
-- quarantined until it scans Clean (ADR 0033). Builds on 1041 (A22-011).
--
--   * The imports and support-screenshots buckets join private.object_scans. Only the uploader reads
--     these files (1061, 1034); until a file scans Clean the import worker does not parse it
--     (app.object_scan_status), and support staff tooling, which uses the service role, must not open it.
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

revoke all on function app.object_scan_status(text, text) from public, anon, authenticated;
grant execute on function app.object_scan_status(text, text) to service_role;
revoke all on function app.my_upload_scan_status(text, text) from public, anon;
grant execute on function app.my_upload_scan_status(text, text) to authenticated, service_role;
