-- 1690_uploaded_pdf_watermarks.sql
--
-- Watermarked uploaded PDFs (ADR 0022, 1690-1699), A103 (RRR-148): finding A65-016 part 2, trace row S8.6-03. Section 8.6
-- puts the viewer's email and the time on every Confidential and Restricted PDF and image. 1380 could mark only PNG and
-- JPEG images, which the web shell renders through the ADR 0031 pipeline, so an uploaded Confidential or Restricted PDF
-- downloaded in Atlas went out as stored (app.record_file_download answered watermark false) and a Confidential PDF could
-- not be shared by link. The web shell now stamps every page of an uploaded PDF (pdf-lib, ADR 0061) and refuses a copy
-- that must carry the mark and cannot. This migration:
--   * counts application/pdf among the types the watermark can carry (private.watermarkable_content_type, 1380);
--   * lets a Confidential PDF have a share link: private.guard_share_link (latest 1380) keeps every rule, and its refusal
--     share_link_watermark_unsupported now applies only to the image types the watermark cannot carry (HEIC, WebP, GIF)
--     and says so. Restricted files still never get a link;
--   * makes app.record_file_download (latest 1380) refuse an in-app download that must carry the watermark and cannot (a
--     Confidential or Restricted image other than PNG or JPEG) with download_watermark_unsupported, instead of answering
--     it without the watermark, and answer watermark true for every Confidential or Restricted PDF.
-- api_public.open_share_link already answers watermark true for any Confidential PDF or image and is unchanged. No later
-- migration redefines any of the three functions.

-- 1. Types the watermark can carry -------------------------------------------------------------------------------------

create or replace function private.watermarkable_content_type(p_content_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(coalesce(p_content_type, '')) in ('application/pdf', 'image/png', 'image/jpeg');
$$;

comment on function private.watermarkable_content_type(text) is 'True for the types a watermark can be applied to: a PDF, stamped page by page with the viewer email and time (1690), and PNG and JPEG images, delivered as a tagged PDF carrying them (1380).';
revoke all on function private.watermarkable_content_type(text) from public, anon, authenticated;

-- 2. Share links: a Confidential PDF may have one ----------------------------------------------------------------------

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
      perform private.refuse('share_link_watermark_unsupported', 'A Confidential image other than a PNG or JPEG cannot carry the viewer watermark, so it cannot be shared by link.');
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

comment on function private.guard_share_link() is 'Share links: the database copies the file''s org, classification and current Clean version, applies the Section 8.6 rules (no Restricted file; Internal needs an expiry; Confidential needs data.export.confidential, an expiry within 30 days, an access code, the recipient''s email and a type the watermark can carry: a PDF, PNG or JPEG since 1690), draws the token and the code, stores only their hashes and logs Share Link Created. Afterwards a link changes only inside the open and revoke RPCs.';
revoke all on function private.guard_share_link() from public, anon, authenticated;

-- 3. In-app downloads: never answered without a watermark they need ---------------------------------------------------

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
  v_watermark := private.watermark_required(v_attachment.classification, v_version.content_type);
  if v_watermark and not private.watermarkable_content_type(v_version.content_type) then
    perform private.refuse('download_watermark_unsupported', 'A Confidential or Restricted image other than a PNG or JPEG cannot carry the viewer watermark, so it cannot be downloaded.');
  end if;
  insert into app.file_access_log (org_id, person_id, bucket_id, object_path, action, classification, watermarked)
  values (v_version.org_id, v_person, 'attachments', v_version.object_name, 'Download', v_attachment.classification, v_watermark);
  return query select v_attachment.classification, v_watermark,
    (select u.email::text from auth.users u join app.people p on p.user_id = u.id where p.id = v_person);
end;
$$;

comment on function app.record_file_download(uuid) is 'Logs one in-app download of a file in app.file_access_log (Section 8.4, 8.6) and answers its classification, whether the copy must carry the watermark (a Confidential or Restricted PDF, PNG or JPEG) and the viewer''s email for it. Confidential files need data.export.confidential; Restricted files need data.export.restricted and step-up (aal2). A Confidential or Restricted image the watermark cannot carry (HEIC, WebP, GIF) is refused rather than downloaded unmarked (1690). The storage policy holds the download itself to the same capability rules.';
revoke all on function app.record_file_download(uuid) from public, anon;
grant execute on function app.record_file_download(uuid) to authenticated, service_role;
