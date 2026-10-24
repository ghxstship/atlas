-- 1651_inbound_mail_bucket.sql
--
-- Raw inbound mail kept by XOS (ADR 0022, 1650-1659; ADR 0033, decision 60), RRR-139. Project inboxes and reply by
-- email receive through Resend's inbound mail on inbound.ghxstship.tech. Resend's event carries only metadata, and
-- Resend keeps a received message for 30 days, while app.inbound_messages keeps mail for two years. So the
-- inbound-email Edge Function reads the raw message from Resend's Receiving API and stores it here, as
-- resend/<email id>.eml, the name app.inbound_messages.raw_object_path records. private.org_storage_objects finds the
-- object through that column when an org is purged.
--   * Private, with no policy: only the function, with the service role, writes or reads it. No screen serves a raw
--     message, so it is not in the upload scanner's buckets; attachments copied onto a document later are scanned there.
--   * 50 MiB a message, the same cap as an inbound attachment. A larger message is not kept: its row records
--     resend:<email id>, which only Resend holds, for 30 days.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('inbound-mail', 'inbound-mail', false, 52428800, array['message/rfc822'])
on conflict (id) do nothing;

comment on column app.inbound_messages.raw_object_path is 'Where the raw message is kept. Through Resend: its object name in the private inbound-mail bucket, resend/<email id>.eml (1651), or resend:<email id> when it was over 50 MiB and only Resend keeps it, for 30 days. Through a provider posting a parsed message: the path that provider sent.';
