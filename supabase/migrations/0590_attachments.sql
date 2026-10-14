-- 0590_attachments.sql
-- A18 Platform Services. Attachments on any commentable subject (Section 7.3, Section 9 file uploads):
--   * the private storage bucket attachments, whose size cap and allowed types are the one list both the
--     bucket and the upload RPC enforce; SVG and other active content are not accepted
--   * attachments keyed by subject table and subject id, and attachment_versions: one stored object per
--     version, with its checksum and virus-scan state. A version is downloadable only once it scans Clean
--   * storage policies: the uploader writes exactly the object name the upload RPC issued; reading an object
--     needs a Clean version on a subject the caller can read (invariant 2)
--   * a clean version of an attachment on a document becomes a version of that document in app.document_versions
--   * domain events, audit trail and retention

-- Bucket ------------------------------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 52428800, array[
  'application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp', 'image/gif',
  'text/plain', 'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'video/mp4', 'video/quicktime', 'audio/mpeg', 'application/zip'
])
on conflict (id) do nothing;

-- Tables -------------------------------------------------------------------------------------------------------------

create type app.scan_status as enum ('Pending Upload', 'Scanning', 'Clean', 'Infected', 'Scan Failed');
comment on type app.scan_status is 'Virus-scan state of an attachment version (a sync status, ADR 0002). Only Clean versions can be downloaded.';

create table app.attachments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  subject_table text not null references private.comment_subjects (table_name),
  subject_id uuid not null,
  title text not null,
  constraint attachments_title_length check (char_length(btrim(title)) between 1 and 255)
);

create index attachments_subject_idx on app.attachments (subject_table, subject_id);
create index attachments_subject_id_idx on app.attachments (subject_id);

call private.install_domain_table('app.attachments');
call private.describe('app.attachments', 'Files attached to a subject row (Section 7.3). Each attachment has numbered versions; the newest Clean version is the current file. Readable by whoever can read the subject.', array[
  'org_id', 'Org of the subject, derived from it on insert; never accepted from the caller.',
  'subject_table', 'Table of the subject.',
  'subject_id', 'Row the file is attached to.',
  'title', 'Display name, the first version''s file name unless renamed.'
]);

create table app.attachment_versions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  attachment_id uuid not null references app.attachments (id),
  version_number integer not null default 0,
  object_name text not null,
  filename text not null,
  content_type text not null,
  size_bytes bigint not null,
  checksum_sha256 text,
  uploaded_by uuid references app.people (id),
  uploaded_at timestamptz,
  scan_status app.scan_status not null default 'Pending Upload',
  scanned_at timestamptz,
  scan_detail text,
  document_version_id uuid references app.document_versions (id),
  constraint attachment_versions_filename check (char_length(filename) between 1 and 255 and filename !~ '[/\\\x00-\x1f]'),
  constraint attachment_versions_size check (size_bytes between 1 and 52428800),
  constraint attachment_versions_checksum check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  constraint attachment_versions_uploaded check ((uploaded_at is null) = (checksum_sha256 is null)),
  constraint attachment_versions_scan_detail_length check (scan_detail is null or char_length(scan_detail) <= 500)
);

create unique index attachment_versions_object_key on app.attachment_versions (object_name);
create unique index attachment_versions_number_key on app.attachment_versions (attachment_id, version_number);
create index attachment_versions_uploaded_by_idx on app.attachment_versions (uploaded_by);
create index attachment_versions_document_version_idx on app.attachment_versions (document_version_id);

call private.install_domain_table('app.attachment_versions', 'app.attachments', 'attachment_id');
call private.describe('app.attachment_versions', 'One stored file per attachment version: its object in the attachments bucket, type, size, checksum and virus-scan state. Versions are never replaced; a new file is a new version.', array[
  'attachment_id', 'Attachment.',
  'version_number', 'Version within the attachment, issued by the database.',
  'object_name', 'Object name in the attachments bucket: <org_id>/<attachment_id>/<version_id>/<file name>, issued by the database.',
  'filename', 'File name as uploaded.',
  'content_type', 'MIME type, one the bucket allows.',
  'size_bytes', 'Size in bytes, at most 50 MiB.',
  'checksum_sha256', 'SHA-256 of the stored file, set when the upload completes.',
  'uploaded_by', 'Person who uploaded the version, set from the session.',
  'uploaded_at', 'When the upload completed.',
  'scan_status', 'Pending Upload, Scanning, Clean, Infected or Scan Failed.',
  'scanned_at', 'When the scanner reported.',
  'scan_detail', 'Scanner finding, for an infected or failed scan.',
  'document_version_id', 'Document version this file became, for an attachment on a document.'
]);

-- Guards ---------------------------------------------------------------------------------------------------------------

create or replace function private.guard_attachment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject jsonb := private.subject_row(new.subject_table, new.subject_id);
begin
  if tg_op = 'INSERT' then
    if v_subject is null then
      perform private.refuse('attachment_subject_unknown', 'The subject does not exist or does not take attachments.');
    end if;
    new.org_id := (v_subject ->> 'org_id')::uuid;
    return new;
  end if;
  if new.subject_table <> old.subject_table or new.subject_id <> old.subject_id then
    perform private.refuse('attachment_immutable', 'An attachment stays on its subject.');
  end if;
  return new;
end;
$$;

comment on function private.guard_attachment() is 'Attachments: org derived from the subject, and an attachment never moves.';

create trigger t11_guard_attachment before insert or update on app.attachments
  for each row execute function private.guard_attachment();

create or replace function private.guard_attachment_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bucket storage.buckets;
begin
  if tg_op = 'INSERT' then
    select * into v_bucket from storage.buckets b where b.id = 'attachments';
    if not (new.content_type = any (v_bucket.allowed_mime_types)) then
      perform private.refuse('attachment_type', format('%s files cannot be attached.', new.content_type));
    end if;
    if new.size_bytes > v_bucket.file_size_limit then
      perform private.refuse('attachment_size', 'Attachments are at most 50 MiB.');
    end if;
    new.version_number := private.next_sequence(new.org_id, 'attachment:' || new.attachment_id::text);
    new.object_name := new.org_id::text || '/' || new.attachment_id::text || '/' || new.id::text || '/' || new.filename;
    new.uploaded_by := private.current_person_id();
    new.uploaded_at := null;
    new.checksum_sha256 := null;
    new.scan_status := 'Pending Upload';
    new.scanned_at := null;
    new.scan_detail := null;
    new.document_version_id := null;
    return new;
  end if;
  if not private.in_trusted_operation('attachment_service') then
    if (to_jsonb(new) - array['deleted_at', 'updated_at', 'updated_by']) <> (to_jsonb(old) - array['deleted_at', 'updated_at', 'updated_by']) then
      perform private.refuse('attachment_version_immutable', 'A version changes only through the upload and scan RPCs.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_attachment_version() is 'Attachment versions: type and size within the bucket''s limits, number, object name and uploader issued by the database, and nothing changes afterwards except through the upload and scan RPCs (or a soft delete).';

create trigger t40_guard_attachment_version before insert or update on app.attachment_versions
  for each row execute function private.guard_attachment_version();

call private.install_policies('app.attachments',
  $$private.can_read_subject(subject_table, subject_id)$$,
  $$private.can_read_subject(subject_table, subject_id)$$,
  $$private.can_read_subject(subject_table, subject_id) and created_by = (select private.current_person_id())$$);

create or replace function private.can_read_attachment(p_attachment_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (select 1 from app.attachments a where a.id = p_attachment_id and a.deleted_at is null);
$$;

comment on function private.can_read_attachment(uuid) is 'True when the caller can read an attachment. Runs as the caller, so the attachment''s policy (the subject''s read policy) decides; takes the id as an argument (ADR 0016 rule 14).';

call private.install_policies('app.attachment_versions',
  $$private.can_read_attachment(attachment_id)$$,
  $$private.can_read_attachment(attachment_id)$$,
  $$private.can_read_attachment(attachment_id) and uploaded_by = (select private.current_person_id())$$);

-- Storage policies -------------------------------------------------------------------------------------------------------

create or replace function private.attachment_upload_allowed(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.attachment_versions v
    where v.object_name = p_object_name and v.scan_status = 'Pending Upload' and v.deleted_at is null
      and v.uploaded_by = private.current_person_id());
$$;

comment on function private.attachment_upload_allowed(text) is 'True when the signed-in person may upload an object: the exact name the upload RPC issued them, while the version still waits for its file.';

create or replace function private.attachment_object_readable(p_object_name text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1 from app.attachment_versions v
    where v.object_name = p_object_name and v.scan_status = 'Clean' and v.deleted_at is null);
$$;

comment on function private.attachment_object_readable(text) is 'True when the caller may download an object: a Clean version they can read. Runs as the caller, so the version, attachment and subject policies all apply (invariant 2).';

create policy attachments_object_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and private.attachment_upload_allowed(name));
create policy attachments_object_read on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and private.attachment_object_readable(name));

-- Upload and scan --------------------------------------------------------------------------------------------------------

insert into private.job_kinds (code, subject_table, max_attempts, description) values
  ('attachment.scan', 'app.attachment_versions', 5, 'Scans an uploaded attachment version for viruses and records the result.');

insert into private.domain_event_types (code, subject, description) values
  ('attachment.added', 'attachment_versions', 'A file version was attached to a subject and scanned clean.'),
  ('attachment.removed', 'attachments', 'An attachment was removed from its subject.');

create or replace function app.begin_attachment_upload(
  p_subject_table text,
  p_subject_id uuid,
  p_filename text,
  p_content_type text,
  p_size_bytes bigint,
  p_attachment_id uuid default null
)
returns table (attachment_id uuid, attachment_version_id uuid, object_name text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_attachment uuid := p_attachment_id;
  v_version uuid;
  v_object text;
begin
  if v_attachment is null then
    insert into app.attachments (subject_table, subject_id, title) values (p_subject_table, p_subject_id, btrim(p_filename))
    returning id into v_attachment;
  elsif not exists (select 1 from app.attachments a where a.id = v_attachment and a.subject_table = p_subject_table
                    and a.subject_id = p_subject_id and a.deleted_at is null) then
    raise exception using errcode = '42501', message = 'attachment not found';
  end if;
  insert into app.attachment_versions (attachment_id, object_name, filename, content_type, size_bytes)
  values (v_attachment, '', btrim(p_filename), lower(p_content_type), p_size_bytes)
  returning id, attachment_versions.object_name into v_version, v_object;
  return query select v_attachment, v_version, v_object;
end;
$$;

comment on function app.begin_attachment_upload(text, uuid, text, text, bigint, uuid) is 'Starts an upload to a subject the caller can read, as a new attachment or a new version of one: checks type and size, and returns the object name the caller may upload to the attachments bucket. Runs as the caller, so the subject''s policy decides.';

create or replace function app.complete_attachment_upload(p_attachment_version_id uuid, p_checksum_sha256 text)
returns app.scan_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_version app.attachment_versions;
  v_size bigint;
begin
  select * into v_version from app.attachment_versions v where v.id = p_attachment_version_id and v.deleted_at is null for update;
  if v_version.id is null or v_version.uploaded_by is distinct from private.current_person_id() then
    raise exception using errcode = '42501', message = 'attachment version not found';
  end if;
  if v_version.scan_status <> 'Pending Upload' then
    perform private.refuse('attachment_upload_complete', 'The upload of this version is already complete.');
  end if;
  if p_checksum_sha256 is null or p_checksum_sha256 !~ '^[0-9a-f]{64}$' then
    perform private.refuse('attachment_checksum', 'The file checksum must be a SHA-256 in lowercase hex.');
  end if;
  select (o.metadata ->> 'size')::bigint into v_size from storage.objects o
  where o.bucket_id = 'attachments' and o.name = v_version.object_name;
  if not found then
    perform private.refuse('attachment_upload_missing', 'Upload the file before completing the upload.');
  end if;
  if v_size is not null and v_size <> v_version.size_bytes then
    perform private.refuse('attachment_size_mismatch', 'The stored file is not the size that was declared.');
  end if;
  perform private.begin_trusted_operation('attachment_service');
  update app.attachment_versions set checksum_sha256 = p_checksum_sha256, uploaded_at = now(), scan_status = 'Scanning'
  where id = v_version.id;
  perform private.end_trusted_operation('attachment_service');
  perform private.enqueue_job(v_version.org_id, 'attachment.scan', v_version.id);
  return 'Scanning';
end;
$$;

comment on function app.complete_attachment_upload(uuid, text) is 'The uploader confirms a finished upload with the file''s SHA-256: the object must exist at the issued name with the declared size. The version moves to Scanning and the virus scan is queued.';

create or replace function app.record_attachment_scan(p_attachment_version_id uuid, p_clean boolean, p_detail text default null)
returns app.scan_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_version app.attachment_versions;
  v_attachment app.attachments;
  v_status app.scan_status;
  v_document_version uuid;
begin
  select * into v_version from app.attachment_versions v where v.id = p_attachment_version_id for update;
  if v_version.id is null or v_version.scan_status <> 'Scanning' then
    perform private.refuse('attachment_not_scanning', 'Only a version being scanned takes a scan result.');
  end if;
  select * into v_attachment from app.attachments a where a.id = v_version.attachment_id;
  v_status := case when p_clean is null then 'Scan Failed' when p_clean then 'Clean' else 'Infected' end;
  if v_status = 'Clean' and v_attachment.subject_table = 'app.documents' then
    insert into app.document_versions (document_id, storage_uri, checksum_sha256)
    values (v_attachment.subject_id, 'storage://attachments/' || v_version.object_name, v_version.checksum_sha256)
    returning id into v_document_version;
  end if;
  perform private.begin_trusted_operation('attachment_service');
  update app.attachment_versions
  set scan_status = v_status, scanned_at = now(), scan_detail = left(p_detail, 500), document_version_id = v_document_version
  where id = v_version.id;
  perform private.end_trusted_operation('attachment_service');
  if v_status = 'Clean' then
    perform private.emit_event(v_version.org_id, 'attachment.added', 'attachment_versions', v_version.id,
      (private.subject_row(v_attachment.subject_table, v_attachment.subject_id) ->> 'project_id')::uuid,
      jsonb_build_object('attachment_id', v_attachment.id, 'attachment_version_id', v_version.id, 'version_number', v_version.version_number,
        'subject_table', v_attachment.subject_table, 'subject_id', v_attachment.subject_id, 'content_type', v_version.content_type,
        'size_bytes', v_version.size_bytes));
  end if;
  return v_status;
end;
$$;

comment on function app.record_attachment_scan(uuid, boolean, text) is 'Scanner API (service role): records a scan result. Clean makes the version downloadable, emits attachment.added and, for an attachment on a document, adds the file as a new document version. Infected or a failed scan (null) keeps the file blocked; the scanner removes infected objects from storage.';

create or replace function private.after_attachment_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform private.emit_event(new.org_id, 'attachment.removed', 'attachments', new.id,
      (private.subject_row(new.subject_table, new.subject_id) ->> 'project_id')::uuid,
      jsonb_build_object('attachment_id', new.id, 'subject_table', new.subject_table, 'subject_id', new.subject_id));
  end if;
  return null;
end;
$$;

comment on function private.after_attachment_update() is 'After update trigger on attachments: emits attachment.removed on a soft delete.';

create trigger t60_after_attachment_update after update on app.attachments
  for each row execute function private.after_attachment_update();

call private.install_audit_trail('app.attachments');
call private.install_audit_trail('app.attachment_versions');

-- Retention --------------------------------------------------------------------------------------------------------------

call private.install_default_retention('app.attachments');
call private.install_default_retention('app.attachment_versions');

-- Privileges -------------------------------------------------------------------------------------------------------------

revoke all on function private.guard_attachment() from public, anon, authenticated;
revoke all on function private.guard_attachment_version() from public, anon, authenticated;
revoke all on function private.can_read_attachment(uuid) from public, anon;
grant execute on function private.can_read_attachment(uuid) to authenticated, service_role;
revoke all on function private.attachment_upload_allowed(text) from public, anon;
grant execute on function private.attachment_upload_allowed(text) to authenticated, service_role;
revoke all on function private.attachment_object_readable(text) from public, anon;
grant execute on function private.attachment_object_readable(text) to authenticated, service_role;
revoke all on function app.begin_attachment_upload(text, uuid, text, text, bigint, uuid) from public, anon;
grant execute on function app.begin_attachment_upload(text, uuid, text, text, bigint, uuid) to authenticated, service_role;
revoke all on function app.complete_attachment_upload(uuid, text) from public, anon;
grant execute on function app.complete_attachment_upload(uuid, text) to authenticated, service_role;
revoke all on function app.record_attachment_scan(uuid, boolean, text) from public, anon, authenticated;
grant execute on function app.record_attachment_scan(uuid, boolean, text) to service_role;
revoke all on function private.after_attachment_update() from public, anon, authenticated;
