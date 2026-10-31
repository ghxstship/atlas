-- pgTAP: document types, requirements and the setup progress view (3031, B14 G-266). A Manager keeps the org's document
-- types and adopts the Standard Library's once (a second run adds nothing, and names the org already holds are skipped);
-- a member cannot. A typed project lists one progress row per requirement, satisfied by a live typed document with a
-- version or a field value, by the same rule the gate applies; a reader without knowledge.document.read on the project
-- sees no rows; deleted document types are left out; a type a requirement names is not deleted; the view keeps select
-- from xos_backup.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(20);

select has_table('app', 'document_types', 'app.document_types exists');
select has_column('app', 'documents', 'document_type_id', 'documents carry a document type');
select has_view('app', 'project_setup_progress', 'app.project_setup_progress exists');

select pg_temp.as_user('carol');
select lives_ok($$with x as (insert into app.document_types (org_id, name, description)
  values (pg_temp.id('org_a'), 'Site Plan', 'The scaled plan of the site.') returning id) insert into world select 'dt_site', id from x$$,
  'a Manager adds a document type');
with x as (insert into app.document_types (org_id, name) values (pg_temp.id('org_a'), 'Crowd Management Plan') returning id)
  insert into world select 'dt_crowd', id from x;
with x as (insert into app.document_types (org_id, name) values (pg_temp.id('org_a'), 'Noise Survey') returning id)
  insert into world select 'dt_noise', id from x;
select pg_temp.as_user('dave');
select throws_ok($$insert into app.document_types (org_id, name) values (pg_temp.id('org_a'), 'Mine')$$, '42501', null,
  'a member cannot add a document type');
select throws_ok(format('select app.adopt_standard_document_types(%L)', pg_temp.id('org_a')), '42501', null,
  'a member cannot adopt the standard types');

-- Adopting the Standard Library's types: the call is made against the canon as it stands; every org holds Standard
-- Library documents (2002), never document types, so the org starts with only its own three.
select pg_temp.as_platform();
create temporary table expected_types as
select count(distinct lower(btrim(s.document_type)))::integer as n from xpms.std_document_library s
where nullif(btrim(s.document_type), '') is not null
  and s.record_id <> all (private.standard_library_withheld('document_library'))
  and lower(btrim(s.document_type)) not in ('site plan', 'crowd management plan', 'noise survey');
grant select on expected_types to public;
select pg_temp.as_user('carol');
select is(app.adopt_standard_document_types(pg_temp.id('org_a')), (select n from expected_types),
  'adopting adds one type per distinct canon DOCUMENT TYPE the org does not hold');
select is(app.adopt_standard_document_types(pg_temp.id('org_a')), 0, 'adopting again adds nothing');
select is((select count(*)::integer from app.document_types where org_id = pg_temp.id('org_a') and std_document_type is not null),
  (select n from expected_types), 'each adopted type names its canon DOCUMENT TYPE');

-- An event type that needs them, and a typed project.
with x as (insert into app.event_types (org_id, name) values (pg_temp.id('org_a'), 'Music Festival') returning id)
  insert into world select 'type_fest', id from x;
insert into app.event_type_document_requirements (event_type_id, document_type_id, requirement, required_by_gate, sort_order) values
  (pg_temp.id('type_fest'), pg_temp.id('dt_site'), 'Required', 3, 1),
  (pg_temp.id('type_fest'), pg_temp.id('dt_crowd'), 'Recommended', 1, 2),
  (pg_temp.id('type_fest'), pg_temp.id('dt_noise'), 'Required', 2, 3);
select pg_temp.as_user('alice');
with x as (insert into app.custom_field_definitions (org_id, target_table, field_key, label, data_type, sort_order)
  values (pg_temp.id('org_a'), 'app.projects', 'capacity', 'Licensed capacity', 'Number', 1) returning id)
  insert into world select 'cfd_capacity', id from x;
select pg_temp.as_user('carol');
insert into app.event_type_fields (event_type_id, custom_field_definition_id, required_for_type, required_by_gate)
  values (pg_temp.id('type_fest'), pg_temp.id('cfd_capacity'), true, 1);
update app.projects set event_type_id = pg_temp.id('type_fest') where id = pg_temp.id('prj_a');

select is((select string_agg(item_kind || ':' || label || ':' || requirement || ':' || required_by_gate || ':' || satisfied, ', '
           order by item_kind, sort_order) from app.project_setup_progress where project_id = pg_temp.id('prj_a')),
  'Document:Site Plan:Required:3:false, Document:Crowd Management Plan:Recommended:1:false, Document:Noise Survey:Required:2:false, Field:Licensed capacity:Required:1:false',
  'one row per requirement, none satisfied yet');

-- A typed document without a version does not satisfy; one with a version does.
with x as (insert into app.documents (org_id, project_id, title, document_type_id)
  values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Main site plan', pg_temp.id('dt_site')) returning id) insert into world select 'doc_site', id from x;
select is((select satisfied from app.project_setup_progress where project_id = pg_temp.id('prj_a') and document_type_id = pg_temp.id('dt_site')),
  false, 'a typed document without a version does not satisfy');
insert into app.document_versions (document_id, storage_uri, checksum_sha256)
  values (pg_temp.id('doc_site'), 'documents/site-plan-v1.pdf', repeat('a', 64));
select is((select row(satisfied, documents_count)::text from app.project_setup_progress
           where project_id = pg_temp.id('prj_a') and document_type_id = pg_temp.id('dt_site')),
  row(true, 1)::text, 'a typed document with a version satisfies, counted once');
insert into app.custom_field_values (custom_field_definition_id, target_id, value_number)
  values (pg_temp.id('cfd_capacity'), pg_temp.id('prj_a'), 12000);
select is((select satisfied from app.project_setup_progress where project_id = pg_temp.id('prj_a') and item_kind = 'Field'),
  true, 'a field value satisfies its row');

-- The view reads the gate's own rule, so the two agree on every Required item.
select pg_temp.as_platform();
create temporary table seen (label text, requirement app.document_requirement, satisfied boolean);
grant select, insert on seen to public;
select pg_temp.as_user('carol');
insert into seen select label, requirement, satisfied from app.project_setup_progress where project_id = pg_temp.id('prj_a');
select pg_temp.as_platform();
select is((select count(*)::integer from seen s where s.requirement = 'Required'
           and s.satisfied = exists (select 1 from private.project_setup_unmet(pg_temp.id('prj_a'), 9) u where u.label = s.label)), 0,
  'the progress view and the gate agree on every Required item');
select pg_temp.as_user('carol');

-- Deleted document types are left out.
update app.event_type_document_requirements set deleted_at = now() where document_type_id = pg_temp.id('dt_noise');
update app.document_types set deleted_at = now() where id = pg_temp.id('dt_noise');
select is((select count(*)::integer from app.project_setup_progress where project_id = pg_temp.id('prj_a') and item_kind = 'Document'),
  2, 'a deleted document type is left out');
select throws_ok(format('update app.document_types set deleted_at = now() where id = %L', pg_temp.id('dt_site')),
  'XR001', 'document_type_in_use: Remove the event types'' requirements for this document type first.',
  'a document type a live requirement names is not deleted');

-- A reader without knowledge.document.read on the project sees no rows, though it reads the project.
select pg_temp.as_platform();
insert into app.roles (org_id, code, name, band) values (pg_temp.id('org_a'), 'project_watcher', 'Project Watcher', 5);
insert into app.role_capabilities (role_id, capability_code, reach)
  select r.id, c.code, 'organization' from app.roles r
  cross join (values ('projects.project.read'), ('projects.members.manage')) c (code)
  where r.code = 'project_watcher';
delete from app.membership_roles where membership_id = pg_temp.id('gina@org_a');
insert into app.membership_roles (membership_id, role_id)
  select pg_temp.id('gina@org_a'), r.id from app.roles r where r.code = 'project_watcher';
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.projects where id = pg_temp.id('prj_a')), 1, 'the watcher reads the project');
select is((select count(*)::integer from app.project_setup_progress where project_id = pg_temp.id('prj_a')), 0,
  'and sees no progress rows without knowledge.document.read, never a false Missing');

-- Another org sees nothing; the backup reader is kept out.
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.project_setup_progress where project_id = pg_temp.id('prj_a')), 0,
  'another org sees no progress rows');
select pg_temp.as_platform();
select ok(not has_table_privilege('xos_backup', 'app.project_setup_progress', 'select'), 'xos_backup cannot select the progress view');

select * from finish();
rollback;
