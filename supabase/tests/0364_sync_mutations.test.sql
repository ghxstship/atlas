-- pgTAP: the sync replay ledger for offline devices (Section 13, requested by A17). A mutation id is
-- applied once and every replay returns the stored result; refusals are stored and replayed; other
-- errors leave the id free; only allowlisted RPCs run; each person reads only their own rows.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(22);

select pg_temp.as_user('carol');
with x as (insert into app.incidents (project_id, title, severity_enum_id, occurred_at) values (pg_temp.id('prj_a'), 'Truss Edge Laceration', 'ENM-097', now()) returning id) insert into world select 'inc', id from x;
select pg_temp.as_platform();
insert into world values ('m1', gen_random_uuid()), ('m2', gen_random_uuid()), ('m3', gen_random_uuid()), ('m4', gen_random_uuid()), ('m5', gen_random_uuid());

create temporary table results (key text primary key, result jsonb);
grant select, insert on results to public;

-- Apply once, replay many -------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into results select 'first', app.apply_sync_mutation(pg_temp.id('m1'), pg_temp.id('org_a'), 'ipad-7',
  'app.record_medical_encounter', jsonb_build_object('p_incident_id', pg_temp.id('inc'), 'p_patient_description', 'Rigger, adult.', 'p_treatment_notes', 'Dressed a cut.'));
select ok((select result ? 'data' from results where key = 'first'), 'the first apply runs the RPC and returns its result');
insert into results select 'replay', app.apply_sync_mutation(pg_temp.id('m1'), pg_temp.id('org_a'), 'ipad-7',
  'app.record_medical_encounter', jsonb_build_object('p_incident_id', pg_temp.id('inc'), 'p_patient_description', 'Rigger, adult.', 'p_treatment_notes', 'Dressed a cut.'));
select is((select result from results where key = 'replay'), (select result from results where key = 'first'), 'a replay returns the stored result');
select is((select count(*)::int from app.medical_encounters_masked where incident_id = pg_temp.id('inc')), 1, 'and never runs the RPC twice');
select is((select (result ->> 'data')::uuid from results where key = 'first'), (select id from app.medical_encounters_masked where incident_id = pg_temp.id('inc')), 'the stored result is the RPC''s return value');
select throws_ok($$select app.apply_sync_mutation((select id from world where key = 'm1'), (select id from world where key = 'org_a'), 'ipad-7', 'app.update_medical_encounter', '{}'::jsonb)$$,
  'XR001', 'sync_mutation_conflict: This mutation id was already used for another mutation; generate a new id.', 'an id reused for another RPC is refused');

-- Refusals are stored and replayed ------------------------------------------------------------------------
insert into results select 'refused', app.apply_sync_mutation(pg_temp.id('m2'), pg_temp.id('org_a'), 'ipad-7',
  'app.record_medical_encounter', jsonb_build_object('p_incident_id', pg_temp.id('inc'), 'p_patient_description', 'Blank.', 'p_treatment_notes', '  '));
select is((select result -> 'refusal' ->> 'rule' from results where key = 'refused'), 'medical_notes_blank', 'a refusal is returned as a stored result naming the rule');
select is(app.apply_sync_mutation(pg_temp.id('m2'), pg_temp.id('org_a'), 'ipad-7', 'app.record_medical_encounter', '{}'::jsonb),
  (select result from results where key = 'refused'), 'and replayed without running again');
select is((select count(*)::int from app.medical_encounters_masked where incident_id = pg_temp.id('inc')), 1, 'a refused mutation changed nothing');
select is((app.apply_sync_mutation(pg_temp.id('m3'), pg_temp.id('org_a'), 'ipad-7', 'app.record_medical_encounter', '{"p_unknown": "x"}'::jsonb)) -> 'refusal' ->> 'rule',
  'sync_argument_unknown', 'an argument the RPC does not take is refused');
select throws_ok($$select app.apply_sync_mutation(gen_random_uuid(), (select id from world where key = 'org_a'), 'ipad-7', 'app.approve_requisition', '{}'::jsonb)$$,
  'XR001', null, 'only allowlisted RPCs run from a device');
select throws_ok($$select app.apply_sync_mutation(null, (select id from world where key = 'org_a'), 'ipad-7', 'app.record_medical_encounter', '{}'::jsonb)$$,
  'XR001', null, 'a mutation needs its client id');
select throws_ok($$select app.apply_sync_mutation(gen_random_uuid(), (select id from world where key = 'org_b'), 'ipad-7', 'app.record_medical_encounter', '{}'::jsonb)$$,
  '42501', null, 'a device acts only in the person''s own orgs');
select pg_temp.as_platform();

-- Errors other than refusals leave the id free ------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$select app.apply_sync_mutation((select id from world where key = 'm4'), (select id from world where key = 'org_a'), 'phone-2', 'app.record_medical_encounter',
  jsonb_build_object('p_incident_id', (select id from world where key = 'inc'), 'p_patient_description', 'Viewer.'))$$,
  '42501', null, 'an RPC the person may not call raises');
select pg_temp.as_platform();
select is((select count(*)::int from app.sync_mutations where id = pg_temp.id('m4')), 0, 'and stores nothing, so the id can be retried');
select pg_temp.as_user('dave');
select throws_ok($$select app.apply_sync_mutation((select id from world where key = 'm1'), (select id from world where key = 'org_a'), 'phone-3', 'app.record_medical_encounter', '{}'::jsonb)$$,
  'XR001', null, 'another person cannot replay someone else''s mutation id');

-- RLS ----------------------------------------------------------------------------------------------------------
select is((select count(*)::int from app.sync_mutations), 0, 'a person reads none of another person''s mutations');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.sync_mutations), 3, 'a person reads their own mutations');
select is((select device_id from app.sync_mutations where id = pg_temp.id('m1')), 'ipad-7', 'with the device that sent them');
select throws_ok($$insert into app.sync_mutations (id, org_id, person_id, device_id, rpc, result) values (gen_random_uuid(), (select id from world where key = 'org_a'), (select id from world where key = 'carol'), 'x', 'app.sign_agreement', '{}'::jsonb)$$,
  '42501', null, 'rows are written only by the wrapper');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.sync_mutations), 0, 'another org reads none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.sync_mutations', '42501', null, 'anon cannot read the ledger');
select pg_temp.as_platform();
select throws_ok($$update app.sync_mutations set result = '{}'::jsonb where id = (select id from world where key = 'm1')$$, 'XR001', null, 'the ledger is append-only');

select * from finish();
rollback;
