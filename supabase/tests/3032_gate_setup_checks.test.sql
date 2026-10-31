-- pgTAP: setup checks at the gate (3032, B14 G-250 and G-266). With every blocking criterion evidenced, gate 1 of a
-- typed project refuses gate_fields_missing until its required field holds a value, and gate 3 refuses
-- gate_documents_missing until a live typed document with a version exists; documents are checked before fields; a
-- Recommended type never blocks; a project without an event type passes exactly as before.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(11);

create function pg_temp.evidence(p_project text, p_gate integer) returns void
language sql as $$
  insert into app.gate_evidence (project_id, criterion_id, evidence_uri, assertion_rank)
  select pg_temp.id(p_project), c.criterion_id, 'docs/' || c.criterion_id || '.pdf', 3
  from xpms.dim_gate_criterion c where c.gate = p_gate and c.is_blocking;
$$;

-- Fixture: a Music Festival type needing a capacity by gate 1, a Site Plan by gate 3 and, recommended, a Noise Survey
-- by gate 1.
select pg_temp.as_user('alice');
with x as (insert into app.custom_field_definitions (org_id, target_table, field_key, label, data_type, sort_order)
  values (pg_temp.id('org_a'), 'app.projects', 'capacity', 'Licensed capacity', 'Number', 1) returning id)
  insert into world select 'cfd_capacity', id from x;
select pg_temp.as_user('carol');
with x as (insert into app.event_types (org_id, name) values (pg_temp.id('org_a'), 'Music Festival') returning id)
  insert into world select 'type_fest', id from x;
with x as (insert into app.document_types (org_id, name) values (pg_temp.id('org_a'), 'Site Plan') returning id)
  insert into world select 'dt_site', id from x;
with x as (insert into app.document_types (org_id, name) values (pg_temp.id('org_a'), 'Noise Survey') returning id)
  insert into world select 'dt_noise', id from x;
insert into app.event_type_document_requirements (event_type_id, document_type_id, requirement, required_by_gate) values
  (pg_temp.id('type_fest'), pg_temp.id('dt_site'), 'Required', 3),
  (pg_temp.id('type_fest'), pg_temp.id('dt_noise'), 'Recommended', 1);
insert into app.event_type_fields (event_type_id, custom_field_definition_id, required_for_type, required_by_gate)
  values (pg_temp.id('type_fest'), pg_temp.id('cfd_capacity'), true, 1);
update app.projects set event_type_id = pg_temp.id('type_fest') where id = pg_temp.id('prj_a');
select pg_temp.evidence('prj_a', 1);

-- Gate 1: the field, then the gate passes; the Recommended survey never blocks.
select throws_ok(format($$select app.pass_gate(%L, 'SCP', 'Go.')$$, pg_temp.id('prj_a')),
  'XR001', 'gate_fields_missing: Gate 1 needs the required details; missing: Licensed capacity.',
  'gate 1 refuses while a required field is empty, naming it');
insert into app.custom_field_values (custom_field_definition_id, target_id, value_number)
  values (pg_temp.id('cfd_capacity'), pg_temp.id('prj_a'), 12000);
select is(app.pass_gate(pg_temp.id('prj_a'), 'SCP', 'Go decision recorded.'), 'ENG',
  'gate 1 passes once the field holds a value, with the Recommended survey still missing');

-- Gate 3: the Required site plan.
select pg_temp.evidence('prj_a', 2);
select is(app.pass_gate(pg_temp.id('prj_a'), 'ENG', 'Contracts in.'), 'ADV', 'gate 2 needs no document of the type');
select pg_temp.evidence('prj_a', 3);
select throws_ok(format($$select app.pass_gate(%L, 'ADV', 'Go.')$$, pg_temp.id('prj_a')),
  'XR001', 'gate_documents_missing: Gate 3 needs the required documents; missing: Site Plan.',
  'gate 3 refuses without a live project document of the Required type, naming it');
with x as (insert into app.documents (org_id, project_id, title, document_type_id)
  values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Main site plan', pg_temp.id('dt_site')) returning id)
  insert into world select 'doc_site', id from x;
select throws_ok(format($$select app.pass_gate(%L, 'ADV', 'Go.')$$, pg_temp.id('prj_a')),
  'XR001', 'gate_documents_missing: Gate 3 needs the required documents; missing: Site Plan.',
  'a typed document without a version does not count');
insert into app.document_versions (document_id, storage_uri, checksum_sha256)
  values (pg_temp.id('doc_site'), 'documents/site-plan-v1.pdf', repeat('b', 64));
update app.custom_field_values set deleted_at = now() where target_id = pg_temp.id('prj_a');
select throws_ok(format($$select app.pass_gate(%L, 'ADV', 'Go.')$$, pg_temp.id('prj_a')),
  'XR001', 'gate_fields_missing: Gate 3 needs the required details; missing: Licensed capacity.',
  'a field required by an earlier gate is checked again at later gates');
insert into app.custom_field_values (custom_field_definition_id, target_id, value_number)
  values (pg_temp.id('cfd_capacity'), pg_temp.id('prj_a'), 12000);
select is(app.pass_gate(pg_temp.id('prj_a'), 'ADV', 'Permits filed.'), 'PRC', 'gate 3 passes with the typed document and its version');

-- Clearing the type takes projects.settings.write, which a Manager holds.
update app.projects set event_type_id = null where id = pg_temp.id('prj_a');
select is((select event_type_id from app.projects where id = pg_temp.id('prj_a')), null, 'a Manager clears the type');

-- A project without a type is unchanged: only its blocking criteria decide.
with x as (insert into app.projects (org_id, project_key, name, time_zone) values (pg_temp.id('org_a'), 'NWU', 'Northwind Untyped', 'America/New_York')
  returning id) insert into world select 'prj_u', id from x;
select throws_ok(format($$select app.pass_gate(%L, 'SCP', 'Go.')$$, pg_temp.id('prj_u')),
  'XR001', 'gate_criteria_unmet: Gate 1 needs evidence for every blocking criterion; missing: G1.BUDGET_ENVELOPE, G1.GONOGO, G1.JURISDICTION, G1.SCOPE_LOCK.',
  'a project without a type refuses exactly as before');
select pg_temp.evidence('prj_u', 1);
select is(app.pass_gate(pg_temp.id('prj_u'), 'SCP', 'Go.'), 'ENG', 'and passes exactly as before');

-- The definer helper stays private.
select pg_temp.as_platform();
select ok(not has_function_privilege('authenticated', 'private.project_setup_unmet(uuid, integer)', 'execute'),
  'authenticated cannot call private.project_setup_unmet');

select * from finish();
rollback;
