-- pgTAP: migration 904130101 (RRR-266, Section 14.5). START by text turns texts back on only in an org whose texts a
-- texted STOP turned off after the person agreed. An org the person turned off in settings, or never agreed to,
-- stays off. STOP and HELP still reach every org with a consent event for the number.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(12);

create function pg_temp.event(p_org text, p_phone text, p_action app.sms_consent_action, p_source app.consent_source)
returns void language plpgsql as $$
begin
  insert into app.sms_consent_events (org_id, phone_e164, action, source) values (pg_temp.id(p_org), p_phone, p_action, p_source);
  perform pg_sleep(0.002);
end $$;
create function pg_temp.may_text(p_org text, p_phone text) returns boolean language sql as $$
  select coalesce((select c.may_text from app.sms_consent_status c where c.org_id = pg_temp.id(p_org) and c.phone_e164 = p_phone), false);
$$;
create function pg_temp.stopped(p_org text, p_phone text) returns boolean language sql as $$
  select exists (select 1 from app.suppression_list s where s.org_id = pg_temp.id(p_org) and s.channel = 'SMS'
                 and s.address = p_phone and s.reason = 'STOP' and s.lifted_at is null and s.deleted_at is null);
$$;
create function pg_temp.keyword(p_phone text, p_action app.sms_consent_action, p_word text) returns integer
language plpgsql as $$
declare v integer;
begin
  v := app.record_sms_keyword(p_phone, p_action, p_word);
  perform pg_sleep(0.002);
  return v;
end $$;

select pg_temp.as_platform();

-- org_a: agreed in settings. org_b: agreed, then turned texts off in settings.
select pg_temp.event('org_a', '+15555550122', 'Opt In', 'Web');
select pg_temp.event('org_b', '+15555550122', 'Opt In', 'Web');
select pg_temp.event('org_b', '+15555550122', 'Opt Out', 'Web');

select is(pg_temp.keyword('+15555550122', 'Opt Out', 'STOP'), 2, 'STOP reaches every org with a consent event for the number');
select ok(not pg_temp.may_text('org_a', '+15555550122') and pg_temp.stopped('org_a', '+15555550122')
  and pg_temp.stopped('org_b', '+15555550122'), 'and stops texts in both, with the STOP suppression');

select is(pg_temp.keyword('+15555550122', 'Opt In', 'START'), 1, 'START touches only the org a texted STOP turned off');
select ok(pg_temp.may_text('org_a', '+15555550122') and not pg_temp.stopped('org_a', '+15555550122'),
  'texts start again in the org the person had agreed to');
select ok(not pg_temp.may_text('org_b', '+15555550122') and pg_temp.stopped('org_b', '+15555550122'),
  'the org turned off in settings stays off');

select is(pg_temp.keyword('+15555550122', 'Opt In', 'START'), 0, 'a second START changes nothing');

-- A STOP, START, STOP, START cycle restores texts each time.
select pg_temp.keyword('+15555550122', 'Opt Out', 'STOP');
select pg_temp.keyword('+15555550122', 'Opt In', 'START');
select pg_temp.keyword('+15555550122', 'Opt Out', 'STOP');
select is(pg_temp.keyword('+15555550122', 'Opt In', 'UNSTOP'), 1, 'START after a texted START and STOP restores again');
select ok(pg_temp.may_text('org_a', '+15555550122'), 'so org_a may text the number');

-- org_a only has a HELP event for this number; org_b has consent.
select pg_temp.event('org_a', '+15555550133', 'Help', 'SMS');
select pg_temp.event('org_b', '+15555550133', 'Opt In', 'Web');
select is(pg_temp.keyword('+15555550133', 'Help', 'HELP'), 2, 'HELP is recorded in every org with an event for the number');
select pg_temp.keyword('+15555550133', 'Opt Out', 'STOP');
select is(pg_temp.keyword('+15555550133', 'Opt In', 'START'), 1, 'START skips an org the person never agreed to');
select ok(not pg_temp.may_text('org_a', '+15555550133') and pg_temp.may_text('org_b', '+15555550133'),
  'texts start only where the person agreed');

-- The org turned off in settings never got a texted Opt In.
select is((select count(*)::integer from app.sms_consent_events
           where org_id = pg_temp.id('org_b') and phone_e164 = '+15555550122' and action = 'Opt In' and source = 'SMS'), 0,
  'no texted Opt In was ever recorded for the org turned off in settings');

select * from finish();
rollback;
