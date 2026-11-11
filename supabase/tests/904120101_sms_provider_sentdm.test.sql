-- pgTAP: migration 904120101 (RRR-266), SMS through sent.dm. The comments name sent.dm and no longer Twilio, and the
-- webhook API still takes the statuses the sms-webhook function maps sent.dm's delivery events onto.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(5);

select matches(col_description('app.notification_deliveries'::regclass,
  (select attnum from pg_attribute where attrelid = 'app.notification_deliveries'::regclass and attname = 'provider_message_id')),
  'sent\.dm', 'the delivery''s provider message id names sent.dm');
select doesnt_match(col_description('app.notification_deliveries'::regclass,
  (select attnum from pg_attribute where attrelid = 'app.notification_deliveries'::regclass and attname = 'provider_message_id')),
  '(?i)twilio', 'and no longer Twilio');
select matches(obj_description('app.record_sms_status(text, text, text)'::regprocedure, 'pg_proc'), 'sent\.dm',
  'record_sms_status names sent.dm');
select doesnt_match(obj_description('app.record_sms_status(text, text, text)'::regprocedure, 'pg_proc'), '(?i)twilio',
  'and no longer Twilio');
select is(app.record_sms_status('no-such-message', 'delivered', null), false,
  'an unknown message id is still refused quietly');

select * from finish();
rollback;
