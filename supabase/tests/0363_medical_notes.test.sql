-- pgTAP: field-encrypted medical treatment notes (Sections 8.3, 9 and 14.3; RRR-71, requested by A14).
-- The column holds only pgcrypto ciphertext under the Vault key; plaintext enters only through the
-- encrypting RPCs and leaves only through the masked view for holders of data.restricted.read.medical.
-- Allowed and denied reads and writes, cross-tenant and anon denial.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(24);

-- World ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.incidents (project_id, title, severity_enum_id, occurred_at) values (pg_temp.id('prj_a'), 'Truss Edge Laceration', 'ENM-097', now()) returning id) insert into world select 'inc', id from x;
select pg_temp.as_user('xavier');
with x as (insert into app.incidents (project_id, title, severity_enum_id, occurred_at) values (pg_temp.id('prj_b'), 'Truss Edge Laceration', 'ENM-097', now()) returning id) insert into world select 'inc_b', id from x;
select pg_temp.as_platform();

-- Writes ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$insert into world values ('enc', app.record_medical_encounter((select id from world where key = 'inc'), 'Rigger, adult.', 'Laceration to forearm, dressed.', 'Released'))$$,
  'an incident writer records an encounter with notes through the RPC');
select throws_ok($$insert into app.medical_encounters (incident_id, patient_description, treatment_notes) values ((select id from world where key = 'inc'), 'Direct.', 'plaintext'::bytea)$$,
  '42501', null, 'signed-in callers cannot write the notes column directly');
select throws_ok($$update app.medical_encounters set treatment_notes = 'plaintext'::bytea where id = (select id from world where key = 'enc')$$,
  '42501', null, 'nor update it');
select lives_ok($$insert into app.medical_encounters (incident_id, patient_description, disposition) values ((select id from world where key = 'inc'), 'Guest, adult.', 'Released')$$,
  'the other columns stay writable directly');
select throws_ok($$select app.record_medical_encounter((select id from world where key = 'inc'), 'Blank.', '   ', null)$$,
  'XR001', 'medical_notes_blank: Leave treatment notes out rather than recording them blank.', 'blank notes are refused');
select pg_temp.as_user('gina');
select throws_ok($$select app.record_medical_encounter((select id from world where key = 'inc'), 'Viewer.', 'Notes.', null)$$,
  '42501', null, 'a Viewer outside the project cannot record an encounter');
select pg_temp.as_user('xavier');
select throws_ok($$select app.record_medical_encounter((select id from world where key = 'inc'), 'Cross.', 'Notes.', null)$$,
  '42501', null, 'another org cannot record an encounter on this incident');
select throws_ok($$select app.update_medical_encounter((select id from world where key = 'enc'), null, 'Overwritten.', null)$$,
  '42501', null, 'nor change one');
select lives_ok($$insert into world values ('enc_b', app.record_medical_encounter((select id from world where key = 'inc_b'), 'Guest, adult.', 'Sprained ankle, iced.', 'Released'))$$,
  'Harbor Lights records its own encounter');
select pg_temp.as_anon();
select throws_ok($$select app.record_medical_encounter((select id from world where key = 'inc'), 'Anon.', 'Notes.', null)$$, '42501', null, 'anon cannot record an encounter');
select pg_temp.as_platform();

-- Storage ----------------------------------------------------------------------------------------------------
select is((select pg_typeof(treatment_notes)::text from app.medical_encounters where id = pg_temp.id('enc')), 'bytea', 'the notes column holds ciphertext');
select is((select position(convert_to('Laceration', 'UTF8') in treatment_notes) from app.medical_encounters where id = pg_temp.id('enc')), 0, 'no plaintext sits in the column');
select is((select extensions.pgp_sym_decrypt(treatment_notes, private.medical_notes_key()) from app.medical_encounters where id = pg_temp.id('enc')),
  'Laceration to forearm, dressed.', 'the ciphertext decrypts under the Vault key');
select is((select count(*)::int from vault.secrets where name = 'xos_medical_notes_key'), 1, 'the key lives in Vault');
select throws_ok($$update app.medical_encounters set treatment_notes = null where id = (select id from world where key = 'enc')$$,
  'XR001', null, 'outside the RPCs even the platform cannot change the notes');

-- Reads ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select treatment_notes from app.medical_encounters$$, '42501', null, 'the ciphertext is not selectable');
select is((select treatment_notes from app.medical_encounters_masked where id = pg_temp.id('enc')), null, 'a project member without data.restricted.read.medical reads the notes masked');
select is((select is_masked from app.medical_encounters_masked where id = pg_temp.id('enc')), true, 'and marked masked');
select throws_ok($$select private.medical_notes_key()$$, '42501', null, 'signed-in callers cannot read the key');
select pg_temp.as_user('alice');
select is((select treatment_notes from app.medical_encounters_masked where id = pg_temp.id('enc')), 'Laceration to forearm, dressed.', 'the holder of data.restricted.read.medical reads them decrypted');
select lives_ok($$select app.update_medical_encounter((select id from world where key = 'enc'), null, 'Laceration to forearm, cleaned and dressed.', null)$$, 'notes are updated through the RPC');
select is((select treatment_notes from app.medical_encounters_masked where id = pg_temp.id('enc')), 'Laceration to forearm, cleaned and dressed.', 'the update is encrypted and reads back');
select is((select count(*)::int from app.medical_encounters_masked where org_id = pg_temp.id('org_b')), 0, 'another org''s encounters stay hidden even from a medical reader');
select pg_temp.as_anon();
select throws_ok('select 1 from app.medical_encounters_masked', '42501', null, 'anon cannot read encounters');
select pg_temp.as_platform();

select * from finish();
rollback;
