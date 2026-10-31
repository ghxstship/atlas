-- pgTAP: migration 2321, work phones in E.164 (A139, S15-14). Stored numbers whose form is unambiguous are rewritten
-- to E.164 and the others are listed, not changed; a new or changed work phone must be E.164; a stored value that does
-- not change is never refused. The exceptions view is for the service role only.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(19);

-- Reading stored numbers ---------------------------------------------------------------------------------------------
select is(private.e164_from_text('+1 (305) 555-0199'), '+13055550199', 'an international number with spacing reads as E.164');
select is(private.e164_from_text('0044 20 7946 0958'), '+442079460958', 'a 00 prefix reads as +');
select is(private.e164_from_text('(305) 555-0199'), '+13055550199', 'a ten-digit North American number reads as a US number');
select is(private.e164_from_text('1-305-555-0199'), '+13055550199', 'with its leading 1 too');
select is(private.e164_from_text('555-0199'), null, 'a number without its area code is not read');
select is(private.e164_from_text('020 7946 0958'), null, 'a national number of another country is not guessed');
select is(private.e164_from_text('ext 12'), null, 'text is not a number');

-- Normalizing stored values ------------------------------------------------------------------------------------------
select pg_temp.as_platform();
alter table app.personal_setting_values disable trigger t41_work_phone_e164;
insert into app.personal_setting_values (person_id, org_id, setting_key, value_text) values
  ((select person_id from app.memberships where id = pg_temp.id('frank@org_a')), null, 'workforce.work_phone', '(305) 555-0199'),
  ((select person_id from app.memberships where id = pg_temp.id('erin@org_a')), null, 'workforce.work_phone', '+44 20 7946 0958'),
  ((select person_id from app.memberships where id = pg_temp.id('dave@org_a')), null, 'workforce.work_phone', 'desk 4412'),
  ((select person_id from app.memberships where id = pg_temp.id('carol@org_a')), null, 'workforce.work_phone', '+13055550142');
alter table app.personal_setting_values enable trigger t41_work_phone_e164;
select is(private.normalize_work_phones(), 2, 'the two stored numbers that read unambiguously are rewritten');
select is((select array_agg(value_text order by value_text) from app.personal_setting_values where setting_key = 'workforce.work_phone'),
  array['+13055550142', '+13055550199', '+442079460958', 'desk 4412'], 'stored work phones are E.164 where they could be read');
select is((select array_agg(stored_value) from private.contact_format_exceptions where table_name = 'app.personal_setting_values'),
  array['desk 4412'], 'the value that could not be read is listed');
select is(private.normalize_work_phones(), 0, 'normalizing again changes nothing');

-- The check --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select throws_ok($$select app.set_personal_setting('workforce.work_phone', p_value_text => '(305) 555-0100')$$,
  'XR001', null, 'a work phone that is not E.164 is refused');
select throws_ok($$select app.set_personal_setting('workforce.work_phone', p_value_text => '+0123456789')$$,
  'XR001', null, 'E.164 never starts with 0');
select lives_ok($$select app.set_personal_setting('workforce.work_phone', p_value_text => '+13055550100')$$, 'an E.164 work phone saves');
select lives_ok($$select app.set_personal_setting('workforce.work_phone', p_value_text => '+13055550100', p_org_id => pg_temp.id('org_a'))$$,
  'a per-org E.164 work phone saves');
select is((select work_phone from app.workforce_directory(pg_temp.id('org_a'), 'frank')), '+13055550100', 'the directory shows the E.164 number');

select pg_temp.as_user('dave');
select lives_ok($$select app.set_personal_setting('locale.time_zone', p_value_text => 'America/Chicago')$$,
  'a person whose stored work phone could not be read still saves other settings');
select lives_ok($$select app.clear_personal_setting('workforce.work_phone')$$, 'and can clear the unread work phone');

select throws_ok($$select count(*) from private.contact_format_exceptions$$, '42501', null, 'members cannot read the exceptions');
