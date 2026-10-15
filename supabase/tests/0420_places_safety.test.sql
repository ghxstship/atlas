-- pgTAP: A09 Places and Safety (migration 0420). Venue location (pair and range refusals, write
-- capability, tenant and anon deny), domain events for Places, the permit engine and inspections,
-- inspection results carrying their project, the reconciliation silence rule (Section 3.7: silence is
-- Unknown, never Met) and its RPC, permit tracking in one transaction, and the permit engine's element
-- filter through xpms.bridge_element_permit (canon silence keeps a rule).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(54);

-- Venue location -----------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select lives_ok($$select app.set_venue_location((select id from world where key = 'venue_a'), -80.1918, 25.7617)$$, 'an Owner locates a venue');
select is((select round(app.venue_latitude(v)::numeric, 4) from app.venues v where v.id = pg_temp.id('venue_a')), 25.7617::numeric, 'the latitude reads back from the one location column');
select is((select round(app.venue_longitude(v)::numeric, 4) from app.venues v where v.id = pg_temp.id('venue_a')), -80.1918::numeric, 'the longitude reads back from the one location column');
select throws_ok($$select app.set_venue_location((select id from world where key = 'venue_a'), -80.19, null)$$,
  'XR001', 'venue_location_pair: A venue location needs both a longitude and a latitude, or neither.', 'a location needs both coordinates');
select throws_ok($$select app.set_venue_location((select id from world where key = 'venue_a'), -200, 25)$$,
  'XR001', 'venue_location_range: Longitude runs from -180 to 180 and latitude from -90 to 90.', 'coordinates stay in range');
select pg_temp.as_user('gina');
select throws_ok($$select app.set_venue_location((select id from world where key = 'venue_a'), -80, 25)$$, '42501', null, 'a Viewer cannot locate a venue');
select pg_temp.as_user('xavier');
select throws_ok($$select app.set_venue_location((select id from world where key = 'venue_a'), -80, 25)$$, '42501', null, 'another org cannot locate this org''s venue');
select pg_temp.as_anon();
select throws_ok($$select app.set_venue_location((select id from world where key = 'venue_a'), -80, 25)$$, '42501', null, 'anon cannot call the location RPC');
select pg_temp.as_user('alice');
select lives_ok($$select app.set_venue_location((select id from world where key = 'venue_a'), null, null)$$, 'an Owner clears a location');
select is((select location from app.venues where id = pg_temp.id('venue_a')), null, 'a cleared venue is not located, never guessed');

-- Places events --------------------------------------------------------------------------------------------------
update app.venues set name = 'Northwind Pier Pavilion East' where id = pg_temp.id('venue_a');
update app.venues set deleted_at = now() where id = pg_temp.id('venue_a');
update app.venues set deleted_at = null where id = pg_temp.id('venue_a');
with x as (insert into app.capability_documents (venue_id, title, document_uri, valid_from) values (pg_temp.id('venue_a'), 'Tech Pack', 'docs/tech-pack.pdf', '2027-01-01') returning id) insert into world select 'doc', id from x;
update app.capability_documents set is_frozen = true where id = pg_temp.id('doc');
with x as (insert into app.spaces (venue_id, name) values (pg_temp.id('venue_a'), 'Main Deck') returning id) insert into world select 'space', id from x;
with x as (insert into app.zones (venue_id, space_id, code, name) values (pg_temp.id('venue_a'), pg_temp.id('space'), 'FOH', 'Front of House') returning id) insert into world select 'zone', id from x;
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'venue.created' and subject_id = pg_temp.id('venue_a')), 1, 'venue.created was emitted');
select is((select count(*)::int from app.domain_events where event_type = 'venue.updated' and subject_id = pg_temp.id('venue_a')), 3, 'venue.updated was emitted for the rename and each location change, not for archiving');
select is((select count(*)::int from app.domain_events where event_type = 'venue.archived' and subject_id = pg_temp.id('venue_a')), 1, 'venue.archived was emitted');
select is((select count(*)::int from app.domain_events where event_type = 'venue.restored' and subject_id = pg_temp.id('venue_a')), 1, 'venue.restored was emitted');
select is((select count(*)::int from app.domain_events where event_type = 'capability_document.frozen' and subject_id = pg_temp.id('doc')), 1, 'capability_document.frozen was emitted');
select is((select count(*)::int from app.domain_events where event_type = 'capability_document.updated' and subject_id = pg_temp.id('doc')), 0, 'freezing is not reported as an edit');
select is((select count(*)::int from app.domain_events where event_type in ('space.created', 'zone.created') and subject_id in (pg_temp.id('space'), pg_temp.id('zone'))), 2, 'space.created and zone.created were emitted');
select is((select data ->> 'code' from app.domain_events where event_type = 'zone.created' and subject_id = pg_temp.id('zone')), 'FOH', 'the zone event carries the zone code');

-- Permit engine and tracking --------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(app.generate_permit_requirements(pg_temp.id('prj_a')),
  (select count(*)::int from xpms.dim_permit_rule where jurisdiction_id in ('US', 'US-FL', 'US-FL-MIAMI-DADE')),
  'with no element selection every rule of the jurisdiction chain applies (A03''s engine test still holds)');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'permit_requirement.generated' and project_id = pg_temp.id('prj_a')),
  (select count(*)::int from app.permit_requirements where project_id = pg_temp.id('prj_a')), 'permit_requirement.generated was emitted once per requirement');
insert into world select 'preq', id from app.permit_requirements where project_id = pg_temp.id('prj_a') and permit_rule = 'Special event';
select pg_temp.as_user('dave');
select lives_ok($$insert into world values ('permit', app.track_permit_requirement((select id from world where key = 'preq')))$$, 'a project Coordinator opens the Permit record for a requirement');
select is((select record_kind || ' | ' || title || ' | ' || record_state from app.records where id = pg_temp.id('permit')),
  'Permit | Special Events Permit | Proposed', 'the record is a Proposed Permit titled with the canon permit text');
select is((select permit_rule from app.record_permit where record_id = pg_temp.id('permit')), 'Special event', 'its record_permit row names the canon rule');
select is((select record_id from app.permit_requirements where id = pg_temp.id('preq')), pg_temp.id('permit'), 'the requirement links to its Permit record');
select throws_ok($$select app.track_permit_requirement((select id from world where key = 'preq'))$$,
  'XR001', 'permit_requirement_tracked: This permit requirement already has a Permit record tracking it.', 'a requirement is tracked once');
select pg_temp.as_user('gina');
select throws_ok($$select app.track_permit_requirement((select id from world where key = 'preq'))$$, '42501', null, 'a Viewer outside the project cannot track a permit');
select pg_temp.as_user('xavier');
select throws_ok($$select app.track_permit_requirement((select id from world where key = 'preq'))$$, '42501', null, 'another org cannot track this org''s permit');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'permit_requirement.tracked' and subject_id = pg_temp.id('preq')), 1, 'permit_requirement.tracked was emitted');

-- Element filter (private.permit_rule_applies) ---------------------------------------------------------------------
insert into xpms.bridge_element_permit (element_id, rule) values ('0000.01.01-XOS-001', 'Show laser');
select ok(private.permit_rule_applies(pg_temp.id('prj_a2'), 'Show laser', 'element'), 'with no selection an element rule applies');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a2'), 'Gala Budget', 'USD') returning id) insert into world select 'bud', id from x;
insert into app.budget_lines (budget_id, line_number, description, urid, element_id, quantity, xyz, xyz_basis)
values (pg_temp.id('bud'), 1, 'Production lead.', '0000.01.01', '0000.01.01-XOS-002', 1, 'X', 'Declared');
select ok(not private.permit_rule_applies(pg_temp.id('prj_a2'), 'Show laser', 'element'), 'a bridged element rule drops when none of its elements is selected');
select ok(private.permit_rule_applies(pg_temp.id('prj_a2'), 'Fireworks', 'element'), 'a rule canon bridges to no element still applies (silence never passes)');
select ok(private.permit_rule_applies(pg_temp.id('prj_a2'), 'Special event', 'project'), 'a project rule always applies');
insert into app.budget_lines (budget_id, line_number, description, urid, element_id, quantity, xyz, xyz_basis)
values (pg_temp.id('bud'), 2, 'Production lead backup.', '0000.01.01', '0000.01.01-XOS-001', 1, 'X', 'Declared');
select ok(private.permit_rule_applies(pg_temp.id('prj_a2'), 'Show laser', 'element'), 'selecting a bridged element brings its rule back');
update app.budget_lines set deleted_at = now() where budget_id = pg_temp.id('bud') and line_number = 2;
select ok(not private.permit_rule_applies(pg_temp.id('prj_a2'), 'Show laser', 'element'), 'an archived budget line no longer selects its element');
select ok(exists (select 1 from private.project_element_ids(pg_temp.id('prj_a2')) e where e = '0000.01.01-XOS-002'), 'project_element_ids lists the selected elements');

-- Reconciliation silence rule -----------------------------------------------------------------------------------------
select is(private.reconciliation_result(10, 12, 3), 'Met'::app.reconciliation_result, 'a known capability that covers the quantity is Met');
select is(private.reconciliation_result(10, 4, 2), 'Gap'::app.reconciliation_result, 'a known capability that falls short is a Gap');
select is(private.reconciliation_result(10, 12, 0), 'Unknown'::app.reconciliation_result, 'an UNKNOWN assertion is Unknown whatever it claims');
select is(private.reconciliation_result(10, null, 4), 'Unknown'::app.reconciliation_result, 'a capability with no quantity against a stated quantity is Unknown');
select is(private.reconciliation_result(null, null, 1), 'Met'::app.reconciliation_result, 'a requirement without a quantity is met by any claim');
select is(private.reconciliation_result(5, null, null), 'Unknown'::app.reconciliation_result, 'no capability at all is Unknown, never Met');

select pg_temp.as_user('dave');
with x as (insert into app.capability_statements (project_id, direction, urid, description, quantity, is_critical) values (pg_temp.id('prj_a'), 'Require', '0000.01.01', 'Seats for 1,200.', 1200, true) returning id) insert into world select 'r_met', id from x;
with x as (insert into app.capability_statements (project_id, direction, urid, description, quantity, is_critical) values (pg_temp.id('prj_a'), 'Require', '0000.02.01', 'Storage for 500.', 500, false) returning id) insert into world select 'r_gap', id from x;
with x as (insert into app.capability_statements (project_id, direction, urid, description, quantity, is_critical) values (pg_temp.id('prj_a'), 'Require', '0000.03.01', 'Legal review.', null, true) returning id) insert into world select 'r_silent', id from x;
with x as (insert into app.capability_statements (project_id, direction, urid, description, quantity, is_critical) values (pg_temp.id('prj_a'), 'Require', '0000.04.01', 'Unclear need.', null, true) returning id) insert into world select 'r_unknown', id from x;
with x as (insert into app.capability_statements (project_id, direction, urid, description, quantity, is_critical) values (pg_temp.id('prj_a'), 'Require', '0000.05.01', 'Ten units.', 10, false) returning id) insert into world select 'r_noqty', id from x;
insert into app.capability_statements (project_id, direction, urid, description, quantity, venue_id, assertion_word) values
  (pg_temp.id('prj_a'), 'Provide', '0000.01.01', 'Pavilion seats 1,200.', 1200, pg_temp.id('venue_a'), 'DOCUMENTED'),
  (pg_temp.id('prj_a'), 'Provide', '0000.01.01', 'Rumored balcony.', 1500, pg_temp.id('venue_a'), 'UNKNOWN'),
  (pg_temp.id('prj_a'), 'Provide', '0000.02.01', 'Stores 300.', 300, pg_temp.id('venue_a'), 'CLAIMED'),
  (pg_temp.id('prj_a'), 'Provide', '0000.04.01', 'Maybe.', null, pg_temp.id('venue_a'), 'UNKNOWN'),
  (pg_temp.id('prj_a'), 'Provide', '0000.05.01', 'Certified, count unstated.', null, pg_temp.id('venue_a'), 'CERTIFIED');
select lives_ok($$insert into world values ('rec', app.reconcile_project((select id from world where key = 'prj_a'), 'Venue walk.'))$$, 'a project Coordinator reconciles the project');
select is((select string_agg(w.key || '=' || l.result::text, ', ' order by w.key) from app.reconciliation_lines l join world w on w.id = l.requirement_id
  where l.reconciliation_id = pg_temp.id('rec')),
  'r_gap=Gap, r_met=Met, r_noqty=Unknown, r_silent=Unknown, r_unknown=Unknown', 'each requirement gets the silence-rule result');
select is((select c.assertion_word from app.reconciliation_lines l join app.capability_statements c on c.id = l.capability_id
  where l.reconciliation_id = pg_temp.id('rec') and l.requirement_id = pg_temp.id('r_met')), 'DOCUMENTED', 'Met names the documented capability, not the louder UNKNOWN one');
select is((select count(*)::int from app.reconciliation_lines l where l.reconciliation_id = pg_temp.id('rec') and l.capability_id is null),
  2, 'silence and UNKNOWN-only claims never point at a capability');
select is((select string_agg(w.key, ', ' order by w.key) from app.reconciliation_gaps g join world w on w.id = g.requirement_id where g.reconciliation_id = pg_temp.id('rec')),
  'r_gap, r_silent, r_unknown', 'gaps are every Gap and every Unknown against a critical requirement');
select pg_temp.as_user('gina');
select throws_ok($$select app.reconcile_project((select id from world where key = 'prj_a'))$$, '42501', null, 'a Viewer outside the project cannot reconcile');
select pg_temp.as_user('xavier');
select throws_ok($$select app.reconcile_project((select id from world where key = 'prj_a'))$$, '42501', null, 'another org cannot reconcile this org''s project');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'reconciliation.completed' and subject_id = pg_temp.id('rec')), 1, 'reconciliation.completed was emitted');

-- Inspections ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.inspection_templates (org_id, name) values (pg_temp.id('org_a'), 'Stage Walk') returning id) insert into world select 'tpl', id from x;
with x as (insert into app.inspection_items (inspection_template_id, position, prompt, is_critical) values (pg_temp.id('tpl'), 1, 'Deck edges guarded', true) returning id) insert into world select 'item', id from x;
select pg_temp.as_user('dave');
with x as (insert into app.inspections (project_id, inspection_template_id) values (pg_temp.id('prj_a'), pg_temp.id('tpl')) returning id) insert into world select 'insp', id from x;
with x as (insert into app.inspection_results (inspection_id, inspection_item_id, result_enum_id, project_id)
  values (pg_temp.id('insp'), pg_temp.id('item'), 'ENM-084', pg_temp.id('prj_a2')) returning id) insert into world select 'res', id from x;
select is((select project_id from app.inspection_results where id = pg_temp.id('res')), pg_temp.id('prj_a'), 'a result carries its inspection''s project, whatever the caller sends');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'inspection_template.created' and subject_id = pg_temp.id('tpl')), 1, 'inspection_template.created was emitted');
select is((select count(*)::int from app.domain_events where event_type = 'inspection.created' and subject_id = pg_temp.id('insp')), 1, 'inspection.created was emitted');
select is((select count(*)::int from app.domain_events where event_type = 'inspection_result.recorded' and subject_id = pg_temp.id('res')), 1, 'inspection_result.recorded was emitted');
select pg_temp.as_user('carol');
update app.inspections set signed_off_at = now() where id = pg_temp.id('insp');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'inspection.signed_off' and subject_id = pg_temp.id('insp')), 1, 'inspection.signed_off was emitted once at sign-off');

select * from finish();
rollback;
