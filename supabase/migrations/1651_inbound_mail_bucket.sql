-- 1651_inbound_mail_bucket.sql
--
-- Raw inbound mail kept by XOS (ADR 0022, 1650-1659; ADR 0033, decision 60), RRR-139. Project inboxes and reply by
-- email receive through Resend's inbound mail on inbound.ghxstship.tech. Resend's event carries only metadata, and
-- Resend keeps a received message for 30 days, while app.inbound_messages keeps mail for two years. So the
-- inbound-email Edge Function reads the raw message from Resend's Receiving API and stores it here, as
-- <org id>/resend/<email id>.eml, the name app.inbound_messages.raw_object_path records.
--   * Named under the org, like every other object: private.org_storage_objects finds it by that prefix when an org is
--     purged, even after retention has deleted its row.
--   * Private, with no policy: only the function, with the service role, writes or reads it. No screen serves a raw
--     message, so it is not in the upload scanner's buckets; attachments copied onto a document later are scanned there.
--   * 50 MiB a message, the same cap as an inbound attachment. A larger message is not kept: its row records
--     resend:<email id>, which only Resend holds, for 30 days.
--   * app.inbound_email_org gives the function the org before it downloads anything, so mail to an address with no
--     inbox costs no call to Resend.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('inbound-mail', 'inbound-mail', false, 52428800, array['message/rfc822'])
on conflict (id) do nothing;

comment on column app.inbound_messages.raw_object_path is 'Where the raw message is kept. Through Resend: its object name in the private inbound-mail bucket, <org id>/resend/<email id>.eml (1651), or resend:<email id> when it was over 50 MiB and only Resend keeps it, for 30 days. Through a provider posting a parsed message: the path that provider sent.';

-- The same lookups app.receive_inbound_email (0550) makes before it inserts: an open project inbox with this local
-- part, else a reply address whose signature verifies and whose thread has an event. It returns the org that function
-- files the mail under, and null exactly when it would ignore the mail.
create or replace function app.inbound_email_org(p_local_part text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_parts text[];
begin
  select a.org_id into v_org from app.inbound_addresses a
  where a.local_part = lower(p_local_part) and a.disabled_at is null and a.deleted_at is null;
  if v_org is not null then
    return v_org;
  end if;
  v_parts := regexp_match(lower(p_local_part), '^r-([0-9a-f]{32})-([0-9a-f]{32})-([0-9a-f]{32})$');
  if v_parts is null or private.reply_signature(v_parts[2]::uuid, v_parts[1]::uuid) <> v_parts[3] then
    return null;
  end if;
  select e.org_id into v_org from app.domain_events e where e.subject_id = v_parts[1]::uuid order by e.occurred_at desc limit 1;
  return v_org;
end;
$$;

comment on function app.inbound_email_org(text) is 'Inbound mail API (service role, migration 1651): the org app.receive_inbound_email would file mail to this local part under, or null when it would ignore it. The inbound-email Edge Function asks first, names the raw message under the org, and calls Resend only for mail with an inbox.';

revoke all on function app.inbound_email_org(text) from public, anon, authenticated;
grant execute on function app.inbound_email_org(text) to service_role;
