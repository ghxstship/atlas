-- 2041_file_handover.sql
--
-- The file handover (ADR 0022, 2040-2049), A103 (RRR-148): finding A65-016 part 2, trace row S8.6-03. 2040 let a
-- Confidential PDF have a share link and marked every Confidential or Restricted PDF downloaded in Atlas, but two calls
-- outside Atlas still reached the stored bytes unmarked: a link's recipient who calls api_public.open_share_link and
-- the file-download Edge Function directly (the ticket was the only credential), and a member holding the export
-- capability who reads the object straight from Storage with their own session. This migration closes both:
--   * a download ticket also serves in-app downloads now (private.file_download_tickets.person_id), and
--     app.record_file_download (latest 2040) issues one for every copy that must carry the watermark, so the web shell
--     receives those bytes only through the file-download function, never from Storage as the viewer;
--   * app.consume_file_download_ticket (latest 1380) hands over a copy that must carry the watermark only to a caller
--     that marks it (p_watermarks). The file-download function sets it only for the Atlas web shell, which proves itself
--     with the handover secret (XOS_FILE_HANDOVER_SECRET, set in both); a ticket refused that way stays unused. It also
--     answers whether the copy must carry the mark, from the file's classification at that moment;
--   * private.attachment_download_allowed (latest 1380), and so the attachments storage policy, no longer lets anyone
--     read an object that must carry the watermark straight from Storage, except the org export holder
--     (org.organization.delete, the Owner) with step-up, whose full export (Section 14.7) carries the org's originals.
--     The 1380 capability rules still hold for every other file.
-- api_public.open_share_link and private.guard_share_link are unchanged. No later migration redefines any of these.

-- 1. Tickets for in-app downloads --------------------------------------------------------------------------------------

alter table private.file_download_tickets
  alter column share_link_id drop not null,
  add column person_id uuid references app.people (id) on delete cascade,
  add constraint file_download_tickets_one_source check (num_nonnulls(share_link_id, person_id) = 1);

create index file_download_tickets_person_idx on private.file_download_tickets (person_id);

comment on table private.file_download_tickets is 'Single-use handovers to the file-download Edge Function (Section 8.6): one stored object, valid 2 minutes, consumed once by app.consume_file_download_ticket. Issued by api_public.open_share_link for a share link, and by app.record_file_download for an in-app download that must carry the watermark (2041). Only the SHA-256 of the ticket is stored.';
comment on column private.file_download_tickets.share_link_id is 'Share link whose open issued the ticket; null for an in-app download.';
comment on column private.file_download_tickets.person_id is 'Member whose in-app download issued the ticket (app.record_file_download, 2041); null for a share link.';
comment on column private.file_download_tickets.ticket_hash is 'SHA-256 of the ticket; the ticket itself is returned once to the web shell.';

-- 2. In-app downloads: a copy that must carry the watermark is handed over by ticket ----------------------------------

drop function app.record_file_download(uuid);

create function app.record_file_download(p_attachment_version_id uuid)
returns table (classification app.data_classification, watermark boolean, viewer_email text, ticket text)
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
  v_ticket text;
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
  -- The storage policy keeps the viewer from reading this object (2041), so the web shell receives it by ticket.
  if v_watermark then
    delete from private.file_download_tickets t where t.expires_at < now() - interval '1 day';
    v_ticket := 'xdlt_' || encode(extensions.gen_random_bytes(32), 'hex');
    insert into private.file_download_tickets (ticket_hash, person_id, attachment_version_id, expires_at)
    values (private.share_token_hash(v_ticket), v_person, v_version.id, now() + interval '2 minutes');
  end if;
  insert into app.file_access_log (org_id, person_id, bucket_id, object_path, action, classification, watermarked)
  values (v_version.org_id, v_person, 'attachments', v_version.object_name, 'Download', v_attachment.classification, v_watermark);
  return query select v_attachment.classification, v_watermark,
    (select u.email::text from auth.users u join app.people p on p.user_id = u.id where p.id = v_person),
    v_ticket;
end;
$$;

comment on function app.record_file_download(uuid) is 'Logs one in-app download of a file in app.file_access_log (Section 8.4, 8.6) and answers its classification, whether the copy must carry the watermark (a Confidential or Restricted PDF, PNG or JPEG), the viewer''s email for it and, for such a copy, a single-use download ticket (2 minutes) the web shell trades at the file-download Edge Function, since the storage policy keeps the viewer from reading that object directly (2041). Confidential files need data.export.confidential; Restricted files need data.export.restricted and step-up (aal2). A Confidential or Restricted image the watermark cannot carry (HEIC, WebP, GIF) is refused rather than downloaded unmarked (2040). Every other file the viewer reads from Storage, under the same capability rules.';
revoke all on function app.record_file_download(uuid) from public, anon;
grant execute on function app.record_file_download(uuid) to authenticated, service_role;

-- 3. Consuming a ticket: a copy that must carry the watermark goes only to a caller that marks it ---------------------

drop function app.consume_file_download_ticket(text);

create function app.consume_file_download_ticket(p_ticket text, p_watermarks boolean default false)
returns table (bucket_id text, object_name text, filename text, content_type text, size_bytes bigint, watermark boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ticket private.file_download_tickets;
  v_version app.attachment_versions;
  v_attachment app.attachments;
  v_link app.share_links;
  v_watermark boolean;
begin
  select * into v_ticket from private.file_download_tickets t where t.ticket_hash = private.share_token_hash(p_ticket) for update;
  if v_ticket.id is null or v_ticket.used_at is not null or v_ticket.expires_at <= now() then
    return;
  end if;
  select * into v_version from app.attachment_versions v where v.id = v_ticket.attachment_version_id;
  select * into v_attachment from app.attachments a where a.id = v_version.attachment_id;
  -- The rule of the file as it is now, not as it was when the ticket was issued.
  v_watermark := coalesce(private.watermark_required(v_attachment.classification, v_version.content_type), false);
  if v_watermark and not coalesce(p_watermarks, false) then
    return;
  end if;
  update private.file_download_tickets t set used_at = now() where t.id = v_ticket.id;
  if v_version.id is null or v_version.deleted_at is not null or v_version.scan_status <> 'Clean'
     or v_attachment.id is null or v_attachment.deleted_at is not null then
    return;
  end if;
  if v_ticket.share_link_id is not null then
    select * into v_link from app.share_links l where l.id = v_ticket.share_link_id;
    if v_link.id is null or v_link.revoked_at is not null or v_link.deleted_at is not null
       or v_attachment.classification = 'Restricted' then
      return;
    end if;
  end if;
  return query select 'attachments'::text, v_version.object_name, v_version.filename, v_version.content_type,
    v_version.size_bytes, v_watermark;
end;
$$;

comment on function app.consume_file_download_ticket(text, boolean) is 'Service role only (the file-download Edge Function): consumes a download ticket once, within its 2 minutes, and answers the stored object to send and whether the copy must carry the watermark, by the file''s classification now. A copy that must carry it is answered only when p_watermarks says the caller marks it, which the function says only for the Atlas web shell proven by the handover secret (2041); otherwise nothing is answered and the ticket stays unused. An unknown, used or expired ticket, a deleted file, or a share link revoked since or whose file was raised to Restricted answers nothing.';
revoke all on function app.consume_file_download_ticket(text, boolean) from public, anon, authenticated;
grant execute on function app.consume_file_download_ticket(text, boolean) to service_role;

-- 4. Storage: an object that must carry the watermark is never read directly ------------------------------------------

create or replace function private.attachment_download_allowed(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select (a.classification in ('Public', 'Internal')
        or (a.classification = 'Confidential' and private.has_capability(a.org_id, 'data.export.confidential'))
        or (a.classification = 'Restricted' and private.has_capability(a.org_id, 'data.export.restricted')
            and private.session_aal() = 'aal2'))
      and (not private.watermark_required(a.classification, v.content_type)
        or (private.has_capability(a.org_id, 'org.organization.delete') and private.session_aal() = 'aal2'))
    from app.attachment_versions v
    join app.attachments a on a.id = v.attachment_id
    where v.object_name = p_object_name), false);
$$;

comment on function private.attachment_download_allowed(text) is 'True when the caller''s capabilities allow downloading the file an object belongs to straight from Storage (Section 8.6): any Public or Internal file, a Confidential file with data.export.confidential, a Restricted file with data.export.restricted and step-up (aal2). A Confidential or Restricted PDF or image, which must carry the viewer watermark, is never read directly (2041): the web shell receives it by ticket and marks it; only the org export holder (org.organization.delete) with step-up reads the original, for the full export of Section 14.7. Visibility of the file itself is private.attachment_object_readable''s job.';
revoke all on function private.attachment_download_allowed(text) from public, anon;
grant execute on function private.attachment_download_allowed(text) to authenticated, service_role;
