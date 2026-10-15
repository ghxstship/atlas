-- pgTAP: safety and knowledge (Section 7.4). Same-tenant allow, cross-tenant deny, anon deny, role
-- bands, invariant 22 (a critical incident cannot be relabeled and closed in one statement; closing
-- needs sign-off), the incident state machine, Restricted medical notes (Section 8.3), inspection
-- sign-off separation, the permit engine's NO_ANSWER refusal (Section 3.7), invariant 10 for
-- incidents' project, and invariant 24 (no em dash in verbiage).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(43);

-- Permit engine ------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select ok(app.generate_permit_requirements(pg_temp.id('prj_a')) >= 0, 'the engine runs for a populated jurisdiction');
select is((select count(*)::int from app.permit_requirements where project_id = pg_temp.id('prj_a')),
  (select count(*)::int from xpms.dim_permit_rule where jurisdiction_id in ('US', 'US-FL', 'US-FL-MIAMI-DADE')), 'it adds every rule of the jurisdiction chain');
select is(app.generate_permit_requirements(pg_temp.id('prj_a')), 0, 'running it again adds nothing');
select pg_temp.as_user('carol');
select throws_ok($$select app.generate_permit_requirements((select id from world where key = 'prj_a2'))$$,
  'XR001', 'jurisdiction_no_answer: NO_ANSWER: the project''s jurisdiction is unresolved, so permit questions have no answer.', 'an unresolved jurisdiction answers no permit question');
update app.projects set jurisdiction_id = 'GB' where id = pg_temp.id('prj_a2');
select throws_ok($$select app.generate_permit_requirements((select id from world where key = 'prj_a2'))$$,
  'XR001', 'jurisdiction_no_answer: NO_ANSWER: the project''s jurisdiction is declared but unpopulated; it never passes.', 'an unpopulated jurisdiction never passes');
select pg_temp.as_user('gina');
select throws_ok($$select app.generate_permit_requirements((select id from world where key = 'prj_a'))$$, '42501', null, 'a Viewer cannot run the permit engine');
select pg_temp.as_platform();

-- Incidents (invariant 22) -------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.incidents (project_id, title, severity_enum_id, occurred_at) values (pg_temp.id('prj_a'), 'Truss Failure at Stage Left', 'ENM-097', now()) returning id) insert into world select 'inc', id from x;
select is((select reported_by from app.incidents where id = pg_temp.id('inc')), pg_temp.id('dave'), 'the reporter is the session person');
select throws_ok($$insert into app.incidents (project_id, title, severity_enum_id, occurred_at) values ((select id from world where key = 'prj_a'), 'Bad', 'ENM-017', now())$$,
  'XR001', null, 'a severity comes from the Incident Severity enumeration');
select throws_ok($$update app.incidents set severity_enum_id = 'ENM-100', incident_state = 'Closed' where id = (select id from world where key = 'inc')$$,
  'XR001', 'incident_relabel_and_close: A critical incident cannot be relabeled and closed in one statement.', 'a critical incident cannot be relabeled and closed in one statement (invariant 22)');
select throws_ok($$update app.incidents set incident_state = 'Closed' where id = (select id from world where key = 'inc')$$, 'XR001', null, 'an incident never closes by a direct update');
select throws_ok($$select app.transition_incident((select id from world where key = 'inc'), 'Reported', 'Closed', 'Done.')$$,
  'XR001', 'incident_close_rpc: Close an incident through app.close_incident, which records sign-off.', 'closing goes through the sign-off RPC');
select lives_ok($$select app.transition_incident((select id from world where key = 'inc'), 'Reported', 'Dispatched', 'Riggers sent.')$$, 'Reported to Dispatched');
select lives_ok($$select app.transition_incident((select id from world where key = 'inc'), 'Dispatched', 'Contained', 'Area cleared.')$$, 'Dispatched to Contained');
select throws_ok($$select app.close_incident((select id from world where key = 'inc'), 'Signed off.')$$,
  'XR001', 'sod_approval_requester: An approval is decided by an eligible approver, never the requester.', 'the reporter cannot sign off a critical incident');
select throws_ok($$update app.incidents set closed_signed_off_by = (select id from world where key = 'carol') where id = (select id from world where key = 'inc')$$, 'XR001', null, 'sign-off is never written directly');
select pg_temp.as_user('carol');
select lives_ok($$select app.close_incident((select id from world where key = 'inc'), 'Inspected and signed off by safety lead.')$$, 'another eligible person signs off and closes it');
select is((select closed_signed_off_by from app.incidents where id = pg_temp.id('inc')), pg_temp.id('carol'), 'the sign-off is recorded');
select throws_ok($$update app.incidents set severity_enum_id = 'ENM-101' where id = (select id from world where key = 'inc')$$, 'XR001', null, 'a closed incident is never relabeled');
select throws_ok($$select app.transition_incident((select id from world where key = 'inc'), 'Closed', 'Dispatched', 'Again.')$$, 'XR001', null, 'Closed is terminal');
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'incident'), 5, 'the incident lifecycle declares five moves');
select pg_temp.as_user('dave');
with x as (insert into app.incidents (project_id, title, severity_enum_id, occurred_at) values (pg_temp.id('prj_a'), 'Minor Trip Hazard', 'ENM-100', now()) returning id) insert into world select 'inc2', id from x;
select app.transition_incident(pg_temp.id('inc2'), 'Reported', 'Contained', 'Taped off.');
select lives_ok($$select app.close_incident((select id from world where key = 'inc2'), 'Fixed.')$$, 'a non-critical incident may be closed by its reporter with sign-off');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'incident.reported' and org_id in (pg_temp.id('org_a'), pg_temp.id('org_b'))), 2, 'incident.reported was emitted for each incident');
select is((select count(*)::int from app.domain_events where event_type = 'incident.closed' and org_id in (pg_temp.id('org_a'), pg_temp.id('org_b'))), 2, 'incident.closed was emitted on each sign-off');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.incidents), 0, 'a Viewer outside the project reads no incidents (invariant 2)');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.incidents where org_id = pg_temp.id('org_a')), 0, 'another org reads no incidents');
select pg_temp.as_anon();
select throws_ok('select 1 from app.incidents', '42501', null, 'anon cannot read incidents');
select throws_ok('select 1 from app.medical_encounters_masked', '42501', null, 'anon cannot read medical encounters');
select pg_temp.as_platform();

-- Medical encounters (Restricted) --------------------------------------------------------------------------
select pg_temp.as_user('carol');
select app.record_medical_encounter(pg_temp.id('inc'), 'Rigger, adult.', 'Laceration to forearm, dressed.', 'Released');
select pg_temp.as_user('dave');
select throws_ok($$select treatment_notes from app.medical_encounters$$, '42501', null, 'Restricted medical notes are not selectable directly');
select is((select treatment_notes from app.medical_encounters_masked), null, 'without data.restricted.read.medical the notes are masked');
select is((select is_masked from app.medical_encounters_masked), true, 'and marked masked');
select pg_temp.as_user('alice');
select is((select treatment_notes from app.medical_encounters_masked), 'Laceration to forearm, dressed.', 'the holder of data.restricted.read.medical reads them');
select pg_temp.as_platform();

-- Inspections ------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.inspection_templates (org_id, name) values (pg_temp.id('org_a'), 'Rigging Daily Check') returning id) insert into world select 'tmpl', id from x;
with x as (insert into app.inspection_items (inspection_template_id, position, prompt, is_critical) values (pg_temp.id('tmpl'), 1, 'Shackles moused.', true) returning id) insert into world select 'item', id from x;
select pg_temp.as_user('dave');
with x as (insert into app.inspections (project_id, inspection_template_id) values (pg_temp.id('prj_a'), pg_temp.id('tmpl')) returning id) insert into world select 'insp', id from x;
select throws_ok($$insert into app.inspection_results (inspection_id, inspection_item_id, result_enum_id) values ((select id from world where key = 'insp'), (select id from world where key = 'item'), 'ENM-097')$$,
  'XR001', null, 'a result comes from the Inspection Result enumeration');
insert into app.inspection_results (inspection_id, inspection_item_id, result_enum_id) values (pg_temp.id('insp'), pg_temp.id('item'), 'ENM-082');
select throws_ok($$update app.inspections set signed_off_at = now() where id = (select id from world where key = 'insp')$$, 'XR001', null, 'the inspector cannot sign off their own inspection');
select pg_temp.as_user('carol');
select lives_ok($$update app.inspections set signed_off_at = now() where id = (select id from world where key = 'insp')$$, 'another eligible person signs it off');
select pg_temp.as_user('dave');
select throws_ok($$update app.inspection_results set note = 'Late.' where inspection_id = (select id from world where key = 'insp')$$, 'XR001', null, 'results freeze at sign-off');
select pg_temp.as_platform();

-- Crisis alerts and radio -----------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$insert into app.crisis_alerts (project_id, emergency_code, message) values ((select id from world where key = 'prj_a'), (select code from xpms.emergency_code order by sort_order limit 1), 'Evacuate stage left.')$$,
  'a crisis alert uses a global canon emergency code');
select pg_temp.as_user('carol');
insert into app.radio_channels (project_id, channel_number, name) values (pg_temp.id('prj_a'), 1, 'Production');
select throws_ok($$insert into app.radio_channels (project_id, channel_number, name) values ((select id from world where key = 'prj_a'), 1, 'Duplicate')$$, '23505', null, 'a channel number is unique per project');
select pg_temp.as_platform();

-- Knowledge (invariant 24) -----------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.verbiage_terms (org_id, term, casing_rule, definition) values ((select id from world where key = 'org_a'), 'Load%sIn', 'Title Case', 'The move into the venue.')$$, chr(8212)),
  '23514', null, 'verbiage refuses the em dash (invariant 24)');
select throws_ok($$insert into app.verbiage_terms (org_id, term, casing_rule, definition) values ((select id from world where key = 'org_a'), 'Load-In', 'Title Case', 'No period')$$,
  '23514', null, 'a definition is a period-terminated sentence');
with x as (insert into app.sops (org_id, code, title, body) values (pg_temp.id('org_a'), 'SOP-001', 'Working at Height', 'Wear a harness.') returning id) insert into world select 'sop', id from x;
select pg_temp.as_user('dave');
select throws_ok($$insert into app.sop_acknowledgments (sop_id, person_id) values ((select id from world where key = 'sop'), (select id from world where key = 'dave'))$$,
  'XR001', 'sop_unpublished: Only a published SOP is acknowledged.', 'an unpublished SOP is not acknowledged');
select pg_temp.as_user('carol');
update app.sops set published_at = now() where id = pg_temp.id('sop');
select pg_temp.as_user('dave');
select lives_ok($$insert into app.sop_acknowledgments (sop_id, person_id) values ((select id from world where key = 'sop'), (select id from world where key = 'dave'))$$, 'a person acknowledges a published SOP');
select throws_ok($$insert into app.sop_acknowledgments (sop_id, person_id) values ((select id from world where key = 'sop'), (select id from world where key = 'frank'))$$, 'XR001', null, 'nobody acknowledges for someone else');
select pg_temp.as_user('carol');
with x as (insert into app.documents (org_id, project_id, title) values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Rigging Plan') returning id) insert into world select 'doc', id from x;
insert into app.document_versions (document_id, storage_uri, checksum_sha256) values (pg_temp.id('doc'), 'docs/rig-v1.pdf', repeat('a', 64)), (pg_temp.id('doc'), 'docs/rig-v2.pdf', repeat('b', 64));
select is((select max(version_number) from app.document_versions where document_id = pg_temp.id('doc')), 2, 'document versions are numbered by the database');
select pg_temp.as_platform();

select * from finish();
rollback;
