-- pgTAP: migration 2903 (B1, RRR-225; ADR 0140 D8 and D9). Place specs name exactly one venue or space, are written with
-- the venue or space capability, and are documented only by a document of the same venue. app.provide_place_specs copies
-- the known power, rigging and connectivity facts into managed Provide statements, DOCUMENTED or CLAIMED; reconciliation
-- meets a quantity-free requirement with them; the permit engine returns the same rules with or without specs.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 2900_places_world.psql

select * from no_plan();

select pg_temp.as_user('dave');
with x as (insert into app.spaces (venue_id, name, capacity) values (pg_temp.id('venue_a'), 'Main hall', 800) returning id) insert into world select 'space_a', id from x;
with x as (insert into app.spaces (venue_id, name) values (pg_temp.id('venue_a'), 'Terrace') returning id) insert into world select 'space_b', id from x;

-- Targets and capabilities -----------------------------------------------------------------------------------------------
with x as (insert into app.place_specs (venue_id, house_power_amps, house_power_voltage, house_power_phase, rigging_point_count, rigging_point_load_lb, occupant_load)
  values (pg_temp.id('venue_a'), 400, 208, 3, 24, 2000, 1200) returning id) insert into world select 'spec_v', id from x;
select is((select org_id from app.place_specs where id = pg_temp.id('spec_v')), pg_temp.id('org_a'), 'a venue spec takes its venue''s org');
select throws_ok($$insert into app.place_specs (venue_id) values (pg_temp.id('venue_a'))$$, '23505', null, 'one live spec per venue');
with x as (insert into app.place_specs (space_id, wifi_available, internet_bandwidth_mbps) values (pg_temp.id('space_a'), true, 500) returning id) insert into world select 'spec_s', id from x;
select is((select venue_id from app.place_specs where id = pg_temp.id('spec_s')), pg_temp.id('venue_a'), 'a space spec takes the space''s venue');
select throws_ok($$insert into app.place_specs (venue_id, space_id) values (pg_temp.id('venue_b'), pg_temp.id('space_b'))$$, 'XR001', null,
  'a space spec of another venue is refused');
select throws_ok($$insert into app.place_specs (space_id, occupant_load) values (pg_temp.id('space_b'), 100)$$, '23514', null,
  'only a venue spec has an occupant load');
select throws_ok($$insert into app.place_specs (venue_id, house_power_phase) values (pg_temp.id('venue_a'), 2)$$, '23514', null,
  'power is single or three phase');
select hasnt_column('app', 'place_specs', 'wifi_password', 'no password column exists');
select pg_temp.as_user('xavier');
with x as (insert into app.capability_documents (venue_id, title, document_uri, valid_from)
  values (pg_temp.id('venue_b'), 'Harbor tech pack', 'attachments/x', current_date - 10) returning id) insert into world select 'doc_b', id from x;
select pg_temp.as_user('dave');
select throws_ok($$update app.place_specs set spec_document_id = pg_temp.id('doc_b') where id = pg_temp.id('spec_v')$$, 'XR001', null,
  'a spec document of another venue is refused');
select pg_temp.as_user('gina');
update app.place_specs set house_power_amps = 1 where id = pg_temp.id('spec_v');
select is((select house_power_amps from app.place_specs where id = pg_temp.id('spec_v')), 400, 'a Viewer reads the spec but cannot change it');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.place_specs where venue_id = pg_temp.id('venue_a')), 0, 'another org reads no specs');

-- Provide statements -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(app.provide_place_specs(pg_temp.id('prj_a')), 3, 'power and rigging of the venue and connectivity of the hall are written');
select is((select string_agg(urid || ' ' || place_spec_field || ' ' || assertion_word || ' ' || coalesce(quantity::text, '-'), ', ' order by urid)
  from app.capability_statements where project_id = pg_temp.id('prj_a') and place_spec_id is not null and deleted_at is null),
  '5000.05.02 rigging CLAIMED -, 5000.06.01 power CLAIMED -, 9000.02.01 connectivity CLAIMED -', 'each by URID, without a quantity, CLAIMED');
select is((select description from app.capability_statements where place_spec_field = 'power' and deleted_at is null),
  '400 A · 208 V · 3Φ', 'the power line uses numbers and unit symbols');
select is((select description from app.capability_statements where place_spec_field = 'rigging' and deleted_at is null),
  '24 × 2000 lb', 'and the rigging line');
select is((select description from app.capability_statements where place_spec_field = 'connectivity' and deleted_at is null),
  'Main hall: Wi-Fi · 500 Mbps', 'a space''s line names the space');
select pg_temp.as_user('alice');
with x as (insert into app.capability_documents (venue_id, title, document_uri, valid_from)
  values (pg_temp.id('venue_a'), 'Northwind tech pack', 'attachments/y', current_date - 10) returning id) insert into world select 'doc_a', id from x;
select pg_temp.as_user('dave');
update app.place_specs set spec_document_id = pg_temp.id('doc_a') where id = pg_temp.id('spec_v');
select is(app.provide_place_specs(pg_temp.id('prj_a')), 3, 'a re-run writes the same rows');
select is((select count(*)::int from app.capability_statements where place_spec_id is not null), 3, 'and adds none');
select is((select string_agg(assertion_word, ',' order by urid) from app.capability_statements where place_spec_id is not null and deleted_at is null),
  'DOCUMENTED,DOCUMENTED,CLAIMED', 'a live document makes the venue''s rows DOCUMENTED');
select pg_temp.as_user('alice');
update app.capability_documents set valid_from = current_date - 30, valid_to = current_date - 1 where id = pg_temp.id('doc_a');
select pg_temp.as_user('dave');
select app.provide_place_specs(pg_temp.id('prj_a'));
select is((select string_agg(assertion_word, ',' order by urid) from app.capability_statements where place_spec_id is not null and deleted_at is null),
  'CLAIMED,CLAIMED,CLAIMED', 'a stale document gives CLAIMED');
update app.place_specs set rigging_point_count = null, rigging_point_load_lb = null where id = pg_temp.id('spec_v');
select is(app.provide_place_specs(pg_temp.id('prj_a')), 2, 'a group that became unknown is not written');
select is((select count(*)::int from app.capability_statements where place_spec_field = 'rigging' and deleted_at is null), 0, 'and its row is moved to Trash');
select throws_ok($$update app.capability_statements set description = 'Edited' where place_spec_field = 'power' and deleted_at is null$$, 'XR001',
  'place_spec_capability_managed: This capability comes from the venue''s specs. Change the specs and add them again.', 'managed rows cannot be edited directly');
select throws_ok($$insert into app.capability_statements (project_id, direction, urid, description, venue_id, place_spec_id, place_spec_field)
  values (pg_temp.id('prj_a'), 'Provide', '5000.06.01', 'Fake', pg_temp.id('venue_a'), pg_temp.id('spec_v'), 'power')$$, 'XR001', null,
  'nor written by hand');
select lives_ok($$update app.capability_statements set deleted_at = now() where place_spec_field = 'connectivity' and deleted_at is null$$,
  'but a person may move one to Trash');
select pg_temp.as_user('alice');
select throws_ok($$select app.provide_place_specs(pg_temp.id('prj_a2'))$$, 'XR001', null, 'a project with no venue is refused');
select pg_temp.as_user('dave');
select ok((select count(*) from app.project_capabilities where place_spec_id is not null) > 0, 'the capability view carries the spec columns');

-- Reconciliation -----------------------------------------------------------------------------------------------------------------
insert into app.capability_statements (project_id, direction, urid, description, is_critical)
values (pg_temp.id('prj_a'), 'Require', '5000.06.01', 'Show power', true);
select pg_temp.as_user('carol');
insert into world values ('rec', app.reconcile_project(pg_temp.id('prj_a')));
select is((select l.result::text from app.reconciliation_lines l where l.reconciliation_id = pg_temp.id('rec')),
  'Met', 'a requirement with no quantity is Met by a spec-fed capability');

-- Permit facts ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.generate_permit_requirements(pg_temp.id('prj_a'));
create temporary table with_specs as select permit_rule from app.permit_requirements where project_id = pg_temp.id('prj_a') and deleted_at is null;
select pg_temp.as_platform();
update app.place_specs set deleted_at = now() where venue_id = pg_temp.id('venue_a');
update app.permit_requirements set deleted_at = now() where project_id = pg_temp.id('prj_a');
select pg_temp.as_user('alice');
select app.generate_permit_requirements(pg_temp.id('prj_a'));
select set_eq($$select permit_rule from app.permit_requirements where project_id = pg_temp.id('prj_a') and deleted_at is null$$,
  $$select permit_rule from with_specs$$, 'the permit engine returns the same rules with or without specs');
select is((select string_agg(permit_rule || '=' || fact_group, ', ' order by permit_rule) from app.permit_rule_place_facts),
  'Assembly occupancy=occupancy, Crane / heavy pick=rigging, Crowd managers=occupancy, EMS / medical plan=occupancy, Off-duty police=occupancy, Temporary power=power, Temporary stage=dimensions',
  'the seeded map from rule to fact group');
select pg_temp.as_platform();
update app.place_specs set deleted_at = null where id = pg_temp.id('spec_v');
select pg_temp.as_user('dave');
select is((select occupant_load || ' ' || house_power_amps || ' ' || coalesce(space_capacity_total::text, 'null') || ' ' || spaces_capacity_known || '/' || spaces_count
  from app.project_place_facts where project_id = pg_temp.id('prj_a')), '1200 400 null 1/2',
  'the facts show the venue spec, and no partial space capacity sum');
update app.spaces set capacity = 200 where id = pg_temp.id('space_b');
select is((select space_capacity_total::int from app.project_place_facts where project_id = pg_temp.id('prj_a')), 1000,
  'once every space has a capacity, the sum');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.project_place_facts where project_id = pg_temp.id('prj_a')), 0, 'another org reads no facts');
select pg_temp.as_platform();
select is(has_table_privilege('authenticated', 'private.permit_rule_place_facts', 'select'), false, 'the private map is not granted to signed-in people');
select is(has_table_privilege('xos_backup', 'app.project_place_facts', 'select'), false, 'the backup login cannot read the facts view');
select is(has_table_privilege('xos_backup', 'app.permit_rule_place_facts', 'select'), false, 'nor the map view');
select ok(exists (select 1 from app.custom_field_targets where table_name = 'app.spaces'), 'app.spaces is a custom field target');

select * from finish();
rollback;
