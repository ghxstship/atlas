-- 6281_share_links_always_need_a_code.sql
-- Owner decision of 2026-11-06 (ADR 0142): a file share always takes an access code, and it ends with its project (6280).
-- A live link with no code is removed here, and nothing can make or keep one: the guard always mints a code,
-- app.create_share_link no longer takes a choice, the check below holds every live row, and api_public.open_share_link
-- answers share_link_invalid for a row with no code. The demo seed holds no share links; production holds no customer data.

select private.begin_trusted_operation('share_link_service');
update app.share_links set deleted_at = now()
where not access_code_required and revoked_at is null and deleted_at is null;
select private.end_trusted_operation('share_link_service');

alter table app.share_links alter column access_code_required set default true;
alter table app.share_links add constraint share_links_always_code
  check (access_code_required or revoked_at is not null or deleted_at is not null);

drop function app.create_share_link(uuid, timestamptz, boolean, text, text);

create function app.create_share_link(
  p_attachment_id uuid,
  p_expires_at timestamptz default null,
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
  insert into app.share_links as l (attachment_id, recipient_email, note, expires_at)
  values (p_attachment_id, p_recipient_email, p_note, p_expires_at)
  returning l.id, l.classification, l.expires_at into v_id, v_classification, v_expires;
  v_secret := nullif(pg_catalog.current_setting('xos.share_link_secret', true), '')::jsonb;
  perform pg_catalog.set_config('xos.share_link_secret', '', true);
  return query select v_id, v_secret ->> 'token', v_secret ->> 'access_code', v_classification, v_expires;
end;
$$;

comment on function app.create_share_link(uuid, timestamptz, text, text) is 'Makes a share link to a file and returns its token and access code once (ADR 0142: every link has a code). The guard enforces every rule.';
revoke all on function app.create_share_link(uuid, timestamptz, text, text) from public, anon;
grant execute on function app.create_share_link(uuid, timestamptz, text, text) to authenticated, service_role;

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
  v_reason text;
begin
  -- A connector session neither makes nor changes a link (6052): its changes are proposals.
  perform private.refuse_agent_write();
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
  v_reason := private.org_read_only_reason(v_attachment.org_id);
  if v_reason is not null then
    perform private.refuse('org_read_only', private.read_only_refusal(v_reason));
  end if;
  -- Making a link is a write to its file for the plan limits: refused to a read-only seat and for a read-only project.
  if exists (select 1 from app.over_limit_objects x where x.org_id = v_attachment.org_id) then
    perform private.refuse_over_limit_write(v_attachment.org_id, 'app.attachments', null, to_jsonb(v_attachment));
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

  new.access_code_required := true;
  v_code := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
  new.access_code_hash := private.share_code_hash(v_token, v_code);
  new.token_hash := private.share_token_hash(v_token);
  perform pg_catalog.set_config('xos.share_link_secret',
    jsonb_build_object('token', v_token, 'access_code', v_code)::text, true);

  insert into app.file_access_log (org_id, person_id, bucket_id, object_path, action, classification, watermarked)
  values (new.org_id, v_person, 'attachments', v_version.object_name, 'Share Link Created', new.classification, false);
  return new;
end;
$$;

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
       or v_version.id is null or v_version.deleted_at is not null or v_version.scan_status <> 'Clean'
       or not v_link.access_code_required then
      perform private.note_rate_event('share_link.failure', v_client);
      v_reason := 'share_link_invalid';
    elsif not private.project_link_open(case when v_attachment.subject_table in ('app.projects', 'projects') then v_attachment.subject_id
      else (private.subject_row(v_attachment.subject_table, v_attachment.subject_id) ->> 'project_id')::uuid end) then
      v_reason := 'share_link_ended';
    elsif v_link.failed_attempts >= 5 then
      perform private.note_rate_event('share_link.failure', v_client);
      v_reason := 'share_link_locked';
    elsif v_link.expires_at is not null and v_link.expires_at <= now() then
      v_reason := 'share_link_expired';
    elsif v_attachment.classification = 'Restricted'
       or (v_attachment.classification = 'Confidential' and v_link.recipient_email is null)
       or (v_attachment.classification <> 'Public' and v_link.expires_at is null) then
      v_reason := 'share_link_reclassified';
    elsif nullif(btrim(coalesce(p_access_code, '')), '') is null then
      v_reason := 'share_link_access_code_required';
    elsif v_link.access_code_hash <> private.share_code_hash(p_token, p_access_code) then
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
