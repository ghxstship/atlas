-- pgTAP: the kiosk PIN service records punches through app.record_punch (A17 Compass): idempotent on the
-- client punch id, In, Break Start, Break End and Out, offline punches corrected by the monotonic offset,
-- photos, and refusals returned as codes so failure counts persist (invariant 8).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(15);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;
insert into k values ('in', private.uuid_v7()), ('bs', private.uuid_v7()), ('be', private.uuid_v7()), ('out', private.uuid_v7()),
  ('again', private.uuid_v7()), ('dave_in', private.uuid_v7());

select pg_temp.as_user('bob');
create temporary table kiosk_key as select * from app.register_kiosk_device(pg_temp.id('org_a'), 'Dock Gate Kiosk', pg_temp.id('prj_a'));
grant select on kiosk_key to public;
select app.set_kiosk_pin(pg_temp.id('frank@org_a'), '4821');
select app.set_kiosk_pin(pg_temp.id('dave@org_a'), '1357');
-- Kiosks are off until the org turns them on (time.kiosk_enabled, 1321); this suite runs with them on.
select app.set_setting(pg_temp.id('org_a'), 'time.kiosk_enabled', 'Organization', pg_temp.id('org_a'), p_value_boolean => true);
select pg_temp.as_platform();

select ok(not has_function_privilege('authenticated', 'app.kiosk_punch(text, uuid, text, uuid, app.punch_kind, timestamptz, bigint, text, uuid)', 'execute')
  and has_function_privilege('service_role', 'app.kiosk_punch(text, uuid, text, uuid, app.punch_kind, timestamptz, bigint, text, uuid)', 'execute'),
  'only the kiosk service may punch');

create temporary table first_in as
select * from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('frank@org_a'), '4821', (select id from k where key = 'in'), 'In', now() - interval '20 minutes');
select results_eq($$select punch_id, refusal, time_entry_id is not null from first_in$$,
  $$values ((select id from k where key = 'in'), null::text, true)$$, 'a kiosk In opens a time entry for the member');
select results_eq($$select source::text, kiosk_device_id is not null from app.clock_punches where id = (select id from k where key = 'in')$$,
  $$values ('Kiosk'::text, true)$$, 'the punch is recorded as a Kiosk punch from the kiosk');
select results_eq($$select punch_id, time_entry_id from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('frank@org_a'), '4821', (select id from k where key = 'in'), 'In', now() - interval '20 minutes')$$,
  $$select punch_id, time_entry_id from first_in$$, 'a replay of the same punch id returns the stored punch');
select is((select count(*)::integer from app.clock_punches where membership_id = pg_temp.id('frank@org_a')), 1, 'a replay records nothing twice');
select is((select refusal from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('frank@org_a'), '4821', (select id from k where key = 'again'), 'In', now())),
  'punch_already_in', 'a second In while clocked in is refused with its rule');
select is((select refusal from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('frank@org_a'), '4821', (select id from k where key = 'in'), 'Out', now())),
  'punch_id_conflict', 'a punch id cannot be reused for another punch');

select is((select refusal from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('frank@org_a'), '4821', (select id from k where key = 'bs'), 'Break Start', now() - interval '10 minutes')),
  null, 'a break starts');
select is((select refusal from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('frank@org_a'), '4821', (select id from k where key = 'be'), 'Break End', now() - interval '4 minutes')),
  null, 'and ends');
select is((select break_minutes from app.time_entries where id = (select time_entry_id from first_in)), 6, 'the break adds its minutes to the entry');
select is((select refusal from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('frank@org_a'), '4821', (select id from k where key = 'out'), 'Out', now())),
  null, 'Out closes the entry');
select ok((select clock_out is not null from app.time_entries where id = (select time_entry_id from first_in)), 'the entry is closed');

select results_eq($$select skew_flagged, effective_at between now() - interval '31 seconds' and now() - interval '29 seconds', refusal
  from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('dave@org_a'), '1357', (select id from k where key = 'dave_in'), 'In',
    '2001-01-01 00:00+00', 30000, 'storage://attachments/org/kiosk/dave.jpg')$$,
  $$values (true, true, null::text)$$, 'an offline punch with a wrong device clock counts at the received time less the monotonic offset, flagged for review');

select is((select refusal from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('frank@org_a'), '0000', private.uuid_v7(), 'In', now())),
  'kiosk_pin_rejected', 'a wrong PIN is refused and counted');
select is((select refusal from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('frank@org_a'), '4821', private.uuid_v7(), 'In', now(), null, 'javascript:alert(1)')),
  'kiosk_photo_uri', 'a photo must be a storage or https URI');

select * from finish();
rollback;
