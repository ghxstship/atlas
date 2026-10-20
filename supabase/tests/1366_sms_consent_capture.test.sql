-- pgTAP: SMS consent captured from Personal settings (A80, RRR-125, Section 14.5 express consent).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(8);

select pg_temp.as_user('dave');
select is((select phone_e164 from app.my_sms_status(pg_temp.id('org_a'))), null::text, 'without a verified phone there is no number');
select throws_ok($$select app.record_my_sms_consent(pg_temp.id('org_a'), true)$$, 'XR001', null,
  'consent needs a verified phone');

select pg_temp.as_platform();
update auth.users set phone = '15555550111', phone_confirmed_at = now() where id = pg_temp.id('dave_user');

select pg_temp.as_user('dave');
select is((select concat_ws('|', phone_e164, may_text) from app.my_sms_status(pg_temp.id('org_a'))), '+15555550111|f',
  'the verified phone shows, not yet textable');
select lives_ok($$select app.record_my_sms_consent(pg_temp.id('org_a'), true)$$, 'a member consents to texts');
select is((select may_text from app.my_sms_status(pg_temp.id('org_a'))), true, 'the org may now text the number');

select pg_temp.as_platform();
select app.record_sms_keyword('+15555550111', 'Opt Out', 'STOP');
select pg_temp.as_user('dave');
select is((select may_text from app.my_sms_status(pg_temp.id('org_a'))), false, 'a STOP by text withdraws it');
select app.record_my_sms_consent(pg_temp.id('org_a'), true);
select is((select may_text from app.my_sms_status(pg_temp.id('org_a'))), true, 'consenting again lifts the STOP');

select pg_temp.as_user('xavier');
select throws_ok($$select app.record_my_sms_consent(pg_temp.id('org_a'), true)$$, '42501', null,
  'someone outside the org records nothing there');

select * from finish();
rollback;
