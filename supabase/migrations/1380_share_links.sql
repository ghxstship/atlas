-- 1380_share_links.sql
-- A82 compliance flows and data loss prevention (RRR-127), finding A65-016 (Section 8.3, Section 8.6). Section 8.6 sets
-- per classification who may export or download, whether a share link may exist, and whether the copy carries a
-- watermark. Before this migration share links existed only as two app.file_access_action values, files had no
-- classification, nothing was ever classified Public, and no download carried a watermark. This migration:
--   * gives every attachment a classification (Public, Internal, Confidential or Restricted; Internal by default).
--     Anyone who can read a file may raise it; lowering it needs the uploader or data.classification.write, and
--     lowering a Restricted file needs data.classification.write;
--   * limits who may download a classified file: Confidential needs data.export.confidential and Restricted needs
--     data.export.restricted and step-up (aal2), in the attachments storage policy itself, so no path skips it.
--     app.record_file_download logs each download of a classified file in app.file_access_log, with the watermark;
--   * adds app.share_links. Public files may have a link without an expiry; Internal links need an expiry; Confidential
--     links need an expiry, an access code and the recipient's email (the watermark names the viewer); Restricted files
--     never get a link. A Confidential link is refused for a file the pipeline cannot watermark (an uploaded PDF, or
--     an image other than PNG or JPEG). Tokens and codes are returned once and stored only as SHA-256 hashes. A link
--     can be revoked; creation, opening and revocation are logged; links last at most 90 days (30 when Confidential);
--   * opens a link through api_public.open_share_link, hardened the way A69 hardened advance links (1295): a read-only
--     call is refused first, the link row is locked before the code is compared, 5 wrong codes lock the link, and
--     failed lookups count against the caller's address through private.request_ip() (20 in 10 minutes). A link whose
--     file was raised to Restricted, or to Confidential without a code, stops opening;
--   * hands the file over through a single-use download ticket (2 minutes): the file-download Edge Function consumes
--     it with the service role (app.consume_file_download_ticket) and returns the bytes, and the web shell watermarks
--     Confidential images before the visitor gets them;
--   * classifies the Public columns (org brand, org name and slug, opportunity listing fields) in
--     private.column_classifications, and fixes app.request_export so a column missing from the registry counts as
--     Internal instead of being ignored by max(), now that Public rows exist;
--   * reserves the share and files slugs for the new routes.

insert into private.reserved_org_slugs (slug) values ('share'), ('files') on conflict (slug) do nothing;

-- Column classification registry: Public columns (Section 8.3) -------------------------------------------------------

comment on table private.column_classifications is 'Classification of every column that is not Internal (Section 8.3): Public columns, published to anyone by design, and the Confidential and Restricted columns. A column not listed is Internal. Restricted columns name the capability that unmasks them; views mask them for everyone else and say so.';
call private.describe('app.column_classifications', 'Columns classified Public, Confidential or Restricted, and the capability that unmasks each Restricted one (Section 8.3). Every other column is Internal.');

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.organizations', 'name', 'Public', null),
  ('app.organizations', 'slug', 'Public', null),
  ('app.org_brands', 'display_name', 'Public', null),
  ('app.org_brands', 'logo_light_path', 'Public', null),
  ('app.org_brands', 'logo_dark_path', 'Public', null),
  ('app.org_brands', 'favicon_path', 'Public', null),
  ('app.org_brands', 'app_icon_path', 'Public', null),
  ('app.org_brands', 'accent_hex', 'Public', null),
  ('app.org_brands', 'neutral_tint_hex', 'Public', null),
  ('app.org_brands', 'font_family', 'Public', null),
  ('app.org_brands', 'radius_scale', 'Public', null),
  ('app.org_brands', 'suppress_powered_by', 'Public', null),
  ('app.opportunities', 'title', 'Public', null),
  ('app.opportunities', 'description', 'Public', null),
  ('app.opportunities', 'role_type', 'Public', null),
  ('app.opportunities', 'starts_on', 'Public', null),
  ('app.opportunities', 'ends_on', 'Public', null),
  ('app.opportunities', 'rate_type', 'Public', null),
  ('app.opportunities', 'pay_min_minor', 'Public', null),
  ('app.opportunities', 'pay_max_minor', 'Public', null),
  ('app.opportunities', 'currency_code', 'Public', null),
  ('app.opportunities', 'deadline_at', 'Public', null),
  ('app.opportunities', 'minimum_age', 'Public', null),
  ('app.opportunities', 'is_remote', 'Public', null)
on conflict (table_name, column_name) do nothing;

-- An export of only Public columns is Public; any column the registry does not list is Internal. Before Public rows
-- existed, max() over the left join ignored unlisted columns harmlessly; now it would have called a mix of Public and
-- Internal columns Public.
create or replace function app.request_export(p_org_id uuid, p_format app.export_format, p_source_label text, p_columns text[])
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_level app.data_classification;
  v_column text;
  v_id uuid;
begin
  if not private.is_member(p_org_id) then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if coalesce(cardinality(p_columns), 0) = 0 then
    perform private.refuse('export_columns_required', 'An export names the columns it contains.');
  end if;
  foreach v_column in array p_columns loop
    if v_column !~ '^app\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' then
      perform private.refuse('export_column_format', format('%s is not table.column.', v_column));
    end if;
    if exists (select 1 from private.column_classifications c
               where c.table_name || '.' || c.column_name = v_column and c.read_capability = 'data.restricted.read.medical') then
      perform private.refuse('export_medical_excluded', 'Medical encounter data is excluded from exports (Section 14.3).');
    end if;
  end loop;
  select max(coalesce(c.classification, 'Internal'::app.data_classification)) into v_level
  from unnest(p_columns) col
  left join private.column_classifications c on c.table_name || '.' || c.column_name = col;
  if v_level = 'Confidential' and not private.has_capability(p_org_id, 'data.export.confidential') then
    perform private.refuse('export_confidential', 'Exporting Confidential columns needs the export capability for Confidential data.');
  end if;
  if v_level = 'Restricted' then
    if not private.has_capability(p_org_id, 'data.export.restricted') then
      perform private.refuse('export_restricted', 'Exporting Restricted columns needs the restricted export capability.');
    end if;
    if private.session_aal() <> 'aal2' then
      perform private.refuse('step_up_required', 'Exporting Restricted columns needs step-up authentication.');
    end if;
  end if;
  insert into app.export_jobs (org_id, export_format, source_label, classification, watermark)
  values (p_org_id, p_format, btrim(p_source_label), v_level, v_level in ('Confidential', 'Restricted'))
  returning id into v_id;
  insert into app.export_job_columns (export_job_id, table_name, column_name)
  select v_id, split_part(c, '.', 1) || '.' || split_part(c, '.', 2), split_part(c, '.', 3) from unnest(p_columns) c;
  perform private.enqueue_job(p_org_id, 'export.render', v_id);
  return v_id;
end;
$$;

comment on function app.request_export(uuid, app.export_format, text, text[]) is 'Requests an export (Section 8.6): Public and Internal data for members, Confidential with data.export.confidential, Restricted with data.export.restricted and step-up (aal2); medical data never. A column the registry does not list counts as Internal. Records the columns, the classification and the watermark, and queues the render job.';
revoke all on function app.request_export(uuid, app.export_format, text, text[]) from public, anon;
grant execute on function app.request_export(uuid, app.export_format, text, text[]) to authenticated, service_role;

-- File classification ---------------------------------------------------------------------------------------------

alter table app.attachments add column classification app.data_classification not null default 'Internal';
comment on column app.attachments.classification is 'Classification of the file (Section 8.6): Public, Internal (the default), Confidential or Restricted. It decides who may download it, whether it may be shared by link and whether the copy carries a watermark. Anyone who can read the file may raise it; lowering it needs the uploader or data.classification.write.';

-- Any reader may raise a file's classification, so the one update policy admits every reader; the guard below keeps
-- every other change, such as the rename 0590 gave the uploader, to the uploader (one permissive policy per action, 1221).
alter policy attachments_update on app.attachments
  using (private.can_read_subject(subject_table, subject_id))
  with check (private.can_read_subject(subject_table, subject_id));

create or replace function private.guard_attachment_classification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_trusted boolean := v_person is null or private.in_trusted_operation('attachment_service');
begin
  if v_trusted then
    return new;
  end if;
  -- A reader who did not add the file may change only the classification: any other change of theirs is skipped,
  -- exactly as the uploader-only policy of 0590 skipped it before.
  if old.created_by is distinct from v_person
     and (to_jsonb(new) - array['classification', 'updated_at', 'updated_by'])
         <> (to_jsonb(old) - array['classification', 'updated_at', 'updated_by']) then
    return null;
  end if;
  if new.classification < old.classification then
    if old.classification = 'Restricted' and not private.has_capability(new.org_id, 'data.classification.write') then
      perform private.refuse('attachment_classification_lower', 'Lowering a Restricted file needs data.classification.write.');
    end if;
    if old.created_by is distinct from v_person and not private.has_capability(new.org_id, 'data.classification.write') then
      perform private.refuse('attachment_classification_lower', 'Only the person who added the file, or someone with data.classification.write, may lower its classification.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_attachment_classification() is 'Attachments: a reader who did not add the file may change only its classification, and only upward (any other change of theirs is skipped, as the uploader-only policy skipped it); lowering needs the uploader or data.classification.write, and lowering a Restricted file always needs data.classification.write.';
revoke all on function private.guard_attachment_classification() from public, anon, authenticated;

create trigger t12_guard_attachment_classification before update on app.attachments
  for each row execute function private.guard_attachment_classification();

call private.install_audit_trail('app.attachments');


-- Downloading a classified file needs the matching export capability (Section 8.6), checked by the storage policy, so
-- a signed URL, a direct download and the watermarking route are all held to it. The policy keeps A18's visibility
-- check, which runs as the caller, and adds this definer check, since signed-in callers cannot resolve private
-- objects inside an invoker function.
create or replace function private.attachment_download_allowed(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select a.classification in ('Public', 'Internal')
      or (a.classification = 'Confidential' and private.has_capability(a.org_id, 'data.export.confidential'))
      or (a.classification = 'Restricted' and private.has_capability(a.org_id, 'data.export.restricted')
          and private.session_aal() = 'aal2')
    from app.attachment_versions v
    join app.attachments a on a.id = v.attachment_id
    where v.object_name = p_object_name), false);
$$;

comment on function private.attachment_download_allowed(text) is 'True when the caller''s capabilities allow downloading the file an object belongs to (Section 8.6): any Public or Internal file, a Confidential file with data.export.confidential, a Restricted file with data.export.restricted and step-up (aal2). Visibility of the file itself is private.attachment_object_readable''s job.';
revoke all on function private.attachment_download_allowed(text) from public, anon;
grant execute on function private.attachment_download_allowed(text) to authenticated, service_role;

alter policy attachments_object_read on storage.objects
  using (bucket_id = 'attachments' and private.attachment_object_readable(name) and private.attachment_download_allowed(name));


-- Image types the watermark can carry: the ADR 0031 renderer embeds PNG and JPEG in a tagged PDF.
create or replace function private.watermarkable_content_type(p_content_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(coalesce(p_content_type, '')) in ('image/png', 'image/jpeg');
$$;

comment on function private.watermarkable_content_type(text) is 'True for the image types a watermark can be applied to (PNG and JPEG, delivered as a tagged PDF carrying the viewer email and time).';
revoke all on function private.watermarkable_content_type(text) from public, anon, authenticated;

-- True when Section 8.6 asks for a watermark on this type at this classification: PDFs and images, Confidential and up.
create or replace function private.watermark_required(p_classification app.data_classification, p_content_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_classification in ('Confidential', 'Restricted')
    and (lower(coalesce(p_content_type, '')) = 'application/pdf' or lower(coalesce(p_content_type, '')) like 'image/%');
$$;

comment on function private.watermark_required(app.data_classification, text) is 'True when Section 8.6 requires the viewer email and timestamp on the delivered copy: a PDF or an image classified Confidential or Restricted.';
revoke all on function private.watermark_required(app.data_classification, text) from public, anon, authenticated;

-- In-app downloads of classified files are logged (Section 8.4 access transparency, Section 8.6).
create or replace function app.record_file_download(p_attachment_version_id uuid)
returns table (classification app.data_classification, watermark boolean, viewer_email text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_person uuid := private.require_person();
  v_version app.attachment_versions;
  v_attachment app.attachments;
  v_watermark boolean;
begin
  select * into v_version from app.attachment_versions v where v.id = p_attachment_version_id and v.deleted_at is null;
  select * into v_attachment from app.attachments a where a.id = v_version.attachment_id and a.deleted_at is null;
  if v_version.id is null or v_attachment.id is null or v_version.scan_status <> 'Clean' or not private.is_member(v_version.org_id) then
    raise exception using errcode = '42501', message = 'file not found';
  end if;
  if v_attachment.classification = 'Confidential' and not private.has_capability(v_version.org_id, 'data.export.confidential') then
    perform private.refuse('download_confidential', 'Downloading a Confidential file needs the export capability for Confidential data.');
  end if;
  if v_attachment.classification = 'Restricted' then
    if not private.has_capability(v_version.org_id, 'data.export.restricted') then
      perform private.refuse('download_restricted', 'Downloading a Restricted file needs the restricted export capability.');
    end if;
    if private.session_aal() <> 'aal2' then
      perform private.refuse('step_up_required', 'Downloading a Restricted file needs step-up authentication.');
    end if;
  end if;
  v_watermark := private.watermark_required(v_attachment.classification, v_version.content_type)
    and private.watermarkable_content_type(v_version.content_type);
  insert into app.file_access_log (org_id, person_id, bucket_id, object_path, action, classification, watermarked)
  values (v_version.org_id, v_person, 'attachments', v_version.object_name, 'Download', v_attachment.classification, v_watermark);
  return query select v_attachment.classification, v_watermark,
    (select u.email::text from auth.users u join app.people p on p.user_id = u.id where p.id = v_person);
end;
$$;

comment on function app.record_file_download(uuid) is 'Logs one in-app download of a file in app.file_access_log (Section 8.4, 8.6) and answers its classification, whether the copy must carry the watermark (a Confidential or Restricted PNG or JPEG) and the viewer''s email for it. Confidential files need data.export.confidential; Restricted files need data.export.restricted and step-up (aal2). The storage policy holds the download itself to the same rules.';
revoke all on function app.record_file_download(uuid) from public, anon;
grant execute on function app.record_file_download(uuid) to authenticated, service_role;

-- Share links -------------------------------------------------------------------------------------------------------

create table app.share_links (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  attachment_id uuid not null references app.attachments (id),
  attachment_version_id uuid references app.attachment_versions (id),
  classification app.data_classification not null default 'Internal',
  token_hash bytea not null default '\x'::bytea,
  access_code_required boolean not null default false,
  access_code_hash bytea,
  recipient_email text,
  note text,
  expires_at timestamptz,
  failed_attempts smallint not null default 0,
  open_count integer not null default 0,
  last_opened_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references app.people (id),
  constraint share_links_never_restricted check (classification <> 'Restricted'),
  constraint share_links_expiry_rule check (classification = 'Public' or expires_at is not null),
  constraint share_links_confidential_code check (classification <> 'Confidential' or access_code_required),
  constraint share_links_confidential_recipient check (classification <> 'Confidential' or recipient_email is not null),
  constraint share_links_code_hash check (access_code_required = (access_code_hash is not null)),
  constraint share_links_recipient_format check (recipient_email is null
    or (recipient_email = lower(recipient_email) and recipient_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(recipient_email) <= 320)),
  constraint share_links_note_length check (note is null or char_length(btrim(note)) between 1 and 200),
  constraint share_links_failed_attempts check (failed_attempts between 0 and 5),
  constraint share_links_open_count check (open_count >= 0),
  constraint share_links_revoked check ((revoked_at is null) = (revoked_by is null))
);

create unique index share_links_token_key on app.share_links (token_hash);
create index share_links_attachment_idx on app.share_links (attachment_id);
create index share_links_version_idx on app.share_links (attachment_version_id);
create index share_links_revoked_by_idx on app.share_links (revoked_by);

call private.install_domain_table('app.share_links', 'app.attachments', 'attachment_id',
  array['app.attachment_versions', 'attachment_version_id']);
call private.describe('app.share_links', 'Links that open one version of a file without an account (Section 8.6): Public files may have a link without an expiry, Internal links need an expiry, Confidential links need an expiry, an access code and the recipient''s email, and Restricted files never get one. The token and the code are returned once and stored only as hashes. Created through app.create_share_link, opened through api_public.open_share_link, revoked through app.revoke_share_link.', array[
  'attachment_id', 'File the link shares.',
  'attachment_version_id', 'Clean version the link opens, set by the database from the file''s current version when the link is created.',
  'classification', 'Classification of the file when the link was created, set by the database. An open is refused once the file is raised to Restricted, or to Confidential when the link has no code.',
  'token_hash', 'SHA-256 of the link token, set by the database. The token is shown once and never stored.',
  'access_code_required', 'True when the link asks for a 6-digit access code. Always true for a Confidential file.',
  'access_code_hash', 'SHA-256 of the token, a colon and the access code, set by the database. Never readable by signed-in callers.',
  'recipient_email', 'Who the link was made for, lowercased. Required for a Confidential file: the watermark names this address.',
  'note', 'What the link is for, as its creator described it.',
  'expires_at', 'When the link stops opening: at most 90 days ahead, 30 for a Confidential file. NULL only for a Public file.',
  'failed_attempts', 'Wrong access codes entered; the link locks at 5.',
  'open_count', 'How many times the link was opened successfully.',
  'last_opened_at', 'When the link was last opened successfully.',
  'revoked_at', 'When the link was revoked; a revoked link never opens again.',
  'revoked_by', 'Person who revoked the link.'
]);

-- Revoking a link withdraws access, so it stays possible while a canceled org is read-only (Section 14.7); the guard
-- below refuses new links in that window itself.
insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.share_links', 'Revoking a share link withdraws access; new links are refused by the share link guard.')
on conflict (table_name) do nothing;
drop trigger if exists t15_refuse_read_only_org on app.share_links;

-- Signed-in callers read links of files they can read, without the hashes; writes go through the RPCs.
revoke select on app.share_links from authenticated;
grant select (id, org_id, attachment_id, attachment_version_id, classification, access_code_required, recipient_email, note,
  expires_at, failed_attempts, open_count, last_opened_at, revoked_at, revoked_by, created_at, created_by, updated_at,
  updated_by, deleted_at) on app.share_links to authenticated;
call private.install_policies('app.share_links',
  $$private.can_read_attachment(attachment_id)$$,
  $$private.can_read_attachment(attachment_id) and created_by = (select private.current_person_id())$$);
revoke update on app.share_links from authenticated;
revoke insert on app.share_links from authenticated;
grant insert (attachment_id, access_code_required, recipient_email, note, expires_at) on app.share_links to authenticated;

create or replace function private.share_token_hash(p_token text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select extensions.digest(coalesce(p_token, ''), 'sha256');
$$;

comment on function private.share_token_hash(text) is 'SHA-256 of a share link token or download ticket, the only form stored.';
revoke all on function private.share_token_hash(text) from public, anon, authenticated;

create or replace function private.share_code_hash(p_token text, p_code text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select extensions.digest(coalesce(p_token, '') || ':' || coalesce(btrim(p_code), ''), 'sha256');
$$;

comment on function private.share_code_hash(text, text) is 'SHA-256 of the share link token, a colon and the access code: the token salts the 6-digit code.';
revoke all on function private.share_code_hash(text, text) from public, anon, authenticated;

-- A link is made only by the database: the guard copies the file's classification and current version, applies the
-- Section 8.6 rules, and draws the token and code itself, so a row inserted any other way carries a token nobody knows.
-- The secrets go back to app.create_share_link through a transaction-local setting.
create or replace function private.guard_share_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_attachment app.attachments;
  v_version app.attachment_versions;
  v_token text := 'xshr_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_code text;
  v_limit interval;
begin
  if tg_op = 'UPDATE' then
    if not private.in_trusted_operation('share_link_service') then
      perform private.refuse('share_link_immutable', 'A share link changes only when it is opened or revoked.');
    end if;
    return new;
  end if;

  if v_person is null then
    perform private.refuse('share_link_person', 'A share link is made by a signed-in person.');
  end if;
  select * into v_attachment from app.attachments a where a.id = new.attachment_id and a.deleted_at is null;
  select * into v_version from app.attachment_versions v
  where v.attachment_id = new.attachment_id and v.scan_status = 'Clean' and v.deleted_at is null
  order by v.version_number desc limit 1;
  if v_attachment.id is null or v_version.id is null then
    perform private.refuse('share_link_file', 'Only a file with a version that scanned clean can be shared.');
  end if;
  if not private.is_member(v_attachment.org_id) then
    raise exception using errcode = '42501', message = 'file not found';
  end if;
  if private.org_read_only(v_attachment.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;

  new.org_id := v_attachment.org_id;
  new.attachment_version_id := v_version.id;
  new.classification := v_attachment.classification;
  new.recipient_email := nullif(lower(btrim(coalesce(new.recipient_email, ''))), '');
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  new.failed_attempts := 0;
  new.open_count := 0;
  new.last_opened_at := null;
  new.revoked_at := null;
  new.revoked_by := null;

  if new.classification = 'Restricted' then
    perform private.refuse('share_link_restricted', 'A Restricted file is never shared by link (Section 8.6).');
  end if;
  if new.classification = 'Confidential' then
    if not private.has_capability(new.org_id, 'data.export.confidential') then
      perform private.refuse('share_link_confidential', 'Sharing a Confidential file needs the export capability for Confidential data.');
    end if;
    if new.recipient_email is null then
      perform private.refuse('share_link_recipient', 'A link to a Confidential file names who it is for; the watermark carries that address.');
    end if;
    if private.watermark_required(new.classification, v_version.content_type)
       and not private.watermarkable_content_type(v_version.content_type) then
      perform private.refuse('share_link_watermark_unsupported', 'A Confidential PDF, or an image other than PNG or JPEG, cannot carry the viewer watermark, so it cannot be shared by link.');
    end if;
    new.access_code_required := true;
  end if;
  if new.expires_at is null and new.classification <> 'Public' then
    perform private.refuse('share_link_expiry', 'A link to an Internal or Confidential file needs an expiry date.');
  end if;
  v_limit := case when new.classification = 'Confidential' then interval '30 days' else interval '90 days' end;
  if new.expires_at is not null and (new.expires_at <= now() or new.expires_at > now() + v_limit) then
    perform private.refuse('share_link_expiry_range', format('A link expires after now and within %s.', v_limit));
  end if;
  if new.recipient_email is not null and new.recipient_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform private.refuse('share_link_recipient_format', 'Enter the recipient''s email address.');
  end if;

  if new.access_code_required then
    v_code := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
    new.access_code_hash := private.share_code_hash(v_token, v_code);
  else
    new.access_code_hash := null;
  end if;
  new.token_hash := private.share_token_hash(v_token);
  perform pg_catalog.set_config('xos.share_link_secret',
    jsonb_build_object('token', v_token, 'access_code', v_code)::text, true);

  insert into app.file_access_log (org_id, person_id, bucket_id, object_path, action, classification, watermarked)
  values (new.org_id, v_person, 'attachments', v_version.object_name, 'Share Link Created', new.classification, false);
  return new;
end;
$$;

comment on function private.guard_share_link() is 'Share links: the database copies the file''s org, classification and current Clean version, applies the Section 8.6 rules (no Restricted file; Internal needs an expiry; Confidential needs data.export.confidential, an expiry within 30 days, an access code, the recipient''s email and a type the watermark can carry), draws the token and the code, stores only their hashes and logs Share Link Created. Afterwards a link changes only inside the open and revoke RPCs.';
revoke all on function private.guard_share_link() from public, anon, authenticated;

create trigger t40_guard_share_link before insert or update on app.share_links
  for each row execute function private.guard_share_link();

call private.install_audit_trail('app.share_links');
call private.install_default_retention('app.share_links', interval '2 years');

insert into private.domain_event_types (code, subject, description) values
  ('share_link.created', 'share_links', 'A share link was made for a file.'),
  ('share_link.revoked', 'share_links', 'A share link was revoked.')
on conflict (code) do nothing;

create or replace function app.create_share_link(
  p_attachment_id uuid,
  p_expires_at timestamptz default null,
  p_access_code_required boolean default false,
  p_recipient_email text default null,
  p_note text default null
)
returns table (share_link_id uuid, token text, access_code text, classification app.data_classification, expires_at timestamptz)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id uuid;
  v_classification app.data_classification;
  v_expires timestamptz;
  v_secret jsonb;
begin
  if not exists (select 1 from app.attachments a where a.id = p_attachment_id and a.deleted_at is null) then
    raise exception using errcode = '42501', message = 'file not found';
  end if;
  perform pg_catalog.set_config('xos.share_link_secret', '', true);
  insert into app.share_links as l (attachment_id, access_code_required, recipient_email, note, expires_at)
  values (p_attachment_id, coalesce(p_access_code_required, false), p_recipient_email, p_note, p_expires_at)
  returning l.id, l.classification, l.expires_at into v_id, v_classification, v_expires;
  v_secret := nullif(pg_catalog.current_setting('xos.share_link_secret', true), '')::jsonb;
  perform pg_catalog.set_config('xos.share_link_secret', '', true);
  return query select v_id, v_secret ->> 'token', v_secret ->> 'access_code', v_classification, v_expires;
end;
$$;

comment on function app.create_share_link(uuid, timestamptz, boolean, text, text) is 'Makes a share link to the current Clean version of a file the caller can read (Section 8.6). Public files may omit the expiry; Internal files need one within 90 days; Confidential files need data.export.confidential, an expiry within 30 days and the recipient''s email, and always get an access code; Restricted files are refused. Returns the token and the access code once; only their hashes are kept.';
revoke all on function app.create_share_link(uuid, timestamptz, boolean, text, text) from public, anon;
grant execute on function app.create_share_link(uuid, timestamptz, boolean, text, text) to authenticated, service_role;

create or replace function app.revoke_share_link(p_share_link_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_link app.share_links;
begin
  select * into v_link from app.share_links l where l.id = p_share_link_id and l.deleted_at is null for update;
  if v_link.id is null or not private.is_member(v_link.org_id)
     or (v_link.created_by is distinct from v_person and not private.has_capability(v_link.org_id, 'data.export.confidential')) then
    raise exception using errcode = '42501', message = 'share link not found';
  end if;
  if v_link.revoked_at is not null then
    return v_link.revoked_at;
  end if;
  perform private.begin_trusted_operation('share_link_service');
  update app.share_links set revoked_at = now(), revoked_by = v_person where id = v_link.id;
  perform private.end_trusted_operation('share_link_service');
  perform private.emit_event(v_link.org_id, 'share_link.revoked', 'share_links', v_link.id, null,
    jsonb_build_object('attachment_id', v_link.attachment_id));
  return now();
end;
$$;

comment on function app.revoke_share_link(uuid) is 'Revokes a share link so it never opens again. The person who made it may revoke it, and so may anyone holding data.export.confidential in the org. Idempotent: a revoked link answers its revocation time.';
revoke all on function app.revoke_share_link(uuid) from public, anon;
grant execute on function app.revoke_share_link(uuid) to authenticated, service_role;

create or replace function private.emit_share_link_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.emit_event(new.org_id, 'share_link.created', 'share_links', new.id, null,
    jsonb_build_object('attachment_id', new.attachment_id, 'classification', new.classification, 'expires_at', new.expires_at));
  return null;
end;
$$;

comment on function private.emit_share_link_created() is 'After insert on share links: emits share_link.created for the activity feed and webhooks.';
revoke all on function private.emit_share_link_created() from public, anon, authenticated;

create trigger t90_emit_share_link_created after insert on app.share_links
  for each row execute function private.emit_share_link_created();

-- Download tickets ---------------------------------------------------------------------------------------------------
-- A ticket is the one-time handover between the open RPC and the file-download Edge Function, which holds the service
-- role the anonymous visitor lacks. It names one stored object, lives 2 minutes and works once.

create table private.file_download_tickets (
  id uuid primary key default private.uuid_v7(),
  ticket_hash bytea not null,
  share_link_id uuid not null references app.share_links (id),
  attachment_version_id uuid not null references app.attachment_versions (id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint file_download_tickets_hash_length check (octet_length(ticket_hash) = 32)
);

create unique index file_download_tickets_hash_key on private.file_download_tickets (ticket_hash);
create index file_download_tickets_share_link_idx on private.file_download_tickets (share_link_id);
create index file_download_tickets_version_idx on private.file_download_tickets (attachment_version_id);
create index file_download_tickets_expires_idx on private.file_download_tickets (expires_at);

comment on table private.file_download_tickets is 'Single-use handovers from api_public.open_share_link to the file-download Edge Function (Section 8.6): one stored object, valid 2 minutes, consumed once by app.consume_file_download_ticket. Only the SHA-256 of the ticket is stored.';
comment on column private.file_download_tickets.id is 'Ticket id (UUID v7).';
comment on column private.file_download_tickets.ticket_hash is 'SHA-256 of the ticket; the ticket itself is returned once to the web shell.';
comment on column private.file_download_tickets.share_link_id is 'Share link whose open issued the ticket.';
comment on column private.file_download_tickets.attachment_version_id is 'File version the ticket hands over.';
comment on column private.file_download_tickets.expires_at is 'When the ticket stops working, 2 minutes after it was issued.';
comment on column private.file_download_tickets.used_at is 'When the Edge Function consumed the ticket; a used ticket never works again.';
comment on column private.file_download_tickets.created_at is 'When the ticket was issued.';

alter table private.file_download_tickets enable row level security;
revoke all on private.file_download_tickets from public, anon, authenticated;
grant select on private.file_download_tickets to service_role;

-- Opening a link ----------------------------------------------------------------------------------------------------

create or replace function api_public.open_share_link(p_token text, p_access_code text default null)
returns table (
  refusal text,
  reason text,
  ticket text,
  org_name text,
  filename text,
  content_type text,
  size_bytes bigint,
  classification app.data_classification,
  watermark boolean,
  recipient_email text,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_client text;
  v_link app.share_links;
  v_attachment app.attachments;
  v_version app.attachment_versions;
  v_ticket text;
  v_watermark boolean;
  v_reason text;
begin
  perform private.require_read_write();
  v_client := coalesce(host(private.request_ip()), 'unknown');
  if private.rate_limit_exceeded('share_link.failure', v_client, 20, interval '10 minutes') then
    v_reason := 'share_link_rate_limited';
  else
    select * into v_link from app.share_links l where l.token_hash = private.share_token_hash(p_token) for update;
    select * into v_attachment from app.attachments a where a.id = v_link.attachment_id;
    select * into v_version from app.attachment_versions v where v.id = v_link.attachment_version_id;
    if v_link.id is null or v_link.deleted_at is not null or v_link.revoked_at is not null
       or v_attachment.id is null or v_attachment.deleted_at is not null
       or v_version.id is null or v_version.deleted_at is not null or v_version.scan_status <> 'Clean' then
      perform private.note_rate_event('share_link.failure', v_client);
      v_reason := 'share_link_invalid';
    elsif v_link.failed_attempts >= 5 then
      perform private.note_rate_event('share_link.failure', v_client);
      v_reason := 'share_link_locked';
    elsif v_link.expires_at is not null and v_link.expires_at <= now() then
      v_reason := 'share_link_expired';
    elsif v_attachment.classification = 'Restricted'
       or (v_attachment.classification = 'Confidential' and (not v_link.access_code_required or v_link.recipient_email is null))
       or (v_attachment.classification <> 'Public' and v_link.expires_at is null) then
      v_reason := 'share_link_reclassified';
    elsif v_link.access_code_required and nullif(btrim(coalesce(p_access_code, '')), '') is null then
      v_reason := 'share_link_access_code_required';
    elsif v_link.access_code_required and v_link.access_code_hash <> private.share_code_hash(p_token, p_access_code) then
      perform private.begin_trusted_operation('share_link_service');
      update app.share_links l set failed_attempts = least(l.failed_attempts + 1, 5) where l.id = v_link.id;
      perform private.end_trusted_operation('share_link_service');
      perform private.note_rate_event('share_link.failure', v_client);
      v_reason := case when v_link.failed_attempts + 1 >= 5 then 'share_link_locked' else 'share_link_access_code' end;
    end if;
  end if;

  if v_reason is not null then
    return query select 'REFUSE'::text, v_reason, null::text, null::text, null::text, null::text, null::bigint,
      null::app.data_classification, null::boolean, null::text, null::timestamptz;
    return;
  end if;

  delete from private.file_download_tickets t where t.expires_at < now() - interval '1 day';
  v_ticket := 'xdlt_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.file_download_tickets (ticket_hash, share_link_id, attachment_version_id, expires_at)
  values (private.share_token_hash(v_ticket), v_link.id, v_version.id, now() + interval '2 minutes');

  perform private.begin_trusted_operation('share_link_service');
  update app.share_links l set open_count = l.open_count + 1, last_opened_at = now() where l.id = v_link.id;
  perform private.end_trusted_operation('share_link_service');

  v_watermark := private.watermark_required(v_attachment.classification, v_version.content_type);
  insert into app.file_access_log (org_id, person_id, bucket_id, object_path, action, classification, watermarked)
  values (v_link.org_id, null, 'attachments', v_version.object_name, 'Share Link Opened', v_attachment.classification, v_watermark);

  return query select null::text, null::text, v_ticket, o.name, v_version.filename, v_version.content_type, v_version.size_bytes,
    v_attachment.classification, v_watermark, v_link.recipient_email, v_link.expires_at
  from app.organizations o where o.id = v_link.org_id;
end;
$$;

comment on function api_public.open_share_link(text, text) is 'Opens a share link without an account (Section 8.6). Refuses a read-only (GET) call first; then, unless the caller''s address used up 20 failures in 10 minutes, locks the link row and checks it: invalid or revoked, locked after 5 wrong codes, expired, reclassified (the file was raised to Restricted, or to Confidential without a code), code required, or wrong code (counted). Each refusal comes back as one row with refusal REFUSE and the reason. An open returns a single-use download ticket (2 minutes) for the file-download Edge Function, the file''s name, type, size and classification, whether the copy must carry the watermark and the recipient it names, and logs Share Link Opened.';
revoke all on function api_public.open_share_link(text, text) from public;
grant execute on function api_public.open_share_link(text, text) to anon, authenticated, service_role;

create or replace function app.consume_file_download_ticket(p_ticket text)
returns table (bucket_id text, object_name text, filename text, content_type text, size_bytes bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ticket private.file_download_tickets;
begin
  select * into v_ticket from private.file_download_tickets t where t.ticket_hash = private.share_token_hash(p_ticket) for update;
  if v_ticket.id is null or v_ticket.used_at is not null or v_ticket.expires_at <= now() then
    return;
  end if;
  update private.file_download_tickets set used_at = now() where id = v_ticket.id;
  return query select 'attachments'::text, v.object_name, v.filename, v.content_type, v.size_bytes
  from app.attachment_versions v
  join app.share_links l on l.id = v_ticket.share_link_id
  where v.id = v_ticket.attachment_version_id and v.deleted_at is null and v.scan_status = 'Clean'
    and l.revoked_at is null and l.deleted_at is null;
end;
$$;

comment on function app.consume_file_download_ticket(text) is 'Service role only (the file-download Edge Function): consumes a download ticket once, within its 2 minutes, and answers the stored object to send. An unknown, used or expired ticket, or one whose link was revoked since, answers nothing.';
revoke all on function app.consume_file_download_ticket(text) from public, anon, authenticated;
grant execute on function app.consume_file_download_ticket(text) to service_role;
