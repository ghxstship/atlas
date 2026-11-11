-- 4.12, block 01 (RRR-266): SMS, text and WhatsApp go through sent.dm instead of Twilio (owner decision
-- 2026-11-11). The SMS senders and their webhook API are unchanged: the sms-webhook function maps sent.dm's delivery
-- events onto the statuses app.record_sms_status takes (delivered, failed) and records STOP, START and HELP from
-- sent.dm's message.received events through app.record_sms_keyword. Only the comments named Twilio; they name the
-- provider-neutral contract now, so the data dictionary reads true.

comment on column app.notification_deliveries.provider_message_id is
  'Message id returned by the provider: Resend for email, sent.dm for SMS and WhatsApp, Expo for push.';

comment on function app.record_sms_status(text, text, text) is 'SMS webhook API (service role): records a delivery event by the provider''s message id (sent.dm since 4.12) for every delivery the text carried, all the held texts of a summary included (1393). delivered marks them Delivered; undelivered and failed mark them Bounced with the provider''s reason (a retry would fail the same way). Other statuses change nothing. Returns false for an unknown message id.';
