-- A69-013: a watermarked copy opened from a share link printed the link, bearer token and all, as text and as a QR code.
-- Section 8.6 watermarks a Confidential or Restricted image with who received it and when, and every generated document
-- carries a record link "for anyone with access" (ADR 0031). For a copy downloaded inside Atlas that link is
-- /files/{version}, which answers only a signed-in member who may see the file. The share route passed /share/{token}
-- instead, so whoever received a forwarded copy could open the link again until it expired or ran out.
--
-- api_public.open_share_link now also answers the opened version's id, and the web shell links the copy to
-- /files/{version}: the org can trace a copy back to the file, and the link grants nothing to anyone else. A version id
-- is a pseudonymous key that opens nothing without access (ADR 0003, ADR 0025). The function is recreated from 1380, its
-- latest definition (no later migration redefines it), with one more output column, so it is dropped first: a function's
-- result columns cannot change in place. Its grants and comment are restored with it.
--
-- This is the first migration of the orchestrator's fourth block, 2000 to 2009 (ADR 0022 amendment of 2026-10-24),
-- which sorts after every package range (1660 to 1999) of the release that follows 4.0.

drop function api_public.open_share_link(text, text);

create function api_public.open_share_link(p_token text, p_access_code text default null)
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
  expires_at timestamptz,
  attachment_version_id uuid
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
      null::app.data_classification, null::boolean, null::text, null::timestamptz, null::uuid;
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
    v_attachment.classification, v_watermark, v_link.recipient_email, v_link.expires_at, v_version.id
  from app.organizations o where o.id = v_link.org_id;
end;
$$;

comment on function api_public.open_share_link(text, text) is 'Opens a share link without an account (Section 8.6). Refuses a read-only (GET) call first; then, unless the caller''s address used up 20 failures in 10 minutes, locks the link row and checks it: invalid or revoked, locked after 5 wrong codes, expired, reclassified (the file was raised to Restricted, or to Confidential without a code), code required, or wrong code (counted). Each refusal comes back as one row with refusal REFUSE and the reason. An open returns a single-use download ticket (2 minutes) for the file-download Edge Function, the file''s name, type, size and classification, whether the copy must carry the watermark and the recipient it names, and the opened file version, which the watermarked copy links to at /files/{version} for members of the org instead of the bearer link (A69-013), and logs Share Link Opened.';
revoke all on function api_public.open_share_link(text, text) from public;
grant execute on function api_public.open_share_link(text, text) to anon, authenticated, service_role;
