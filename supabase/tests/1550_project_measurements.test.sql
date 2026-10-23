-- pgTAP: project objectives and measurements (A98, RRR-143, finding A65-030, Section 4.10, migration 1550). Units convert
-- exactly within a dimension, metrics name their canon benchmark without adding canon rows, objectives set at gate 1 lock
-- to gate approvers once the gate is passed, an unmeasured figure stays NULL, and every correction is written with its
-- reason to the correction ledger. Access follows the project (invariant 2).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

-- Days on the project's calendar, read once by the platform (signed-in roles have no USAGE on private).
create temporary table days as
select private.project_today(pg_temp.id('prj_a')) as today, private.project_today(pg_temp.id('prj_a')) - 3 as earlier;
grant select on days to public;

-- Reference lists ------------------------------------------------------------------------------------------------------
select is((select factor_to_base from app.measurement_units where unit_code = 'lb'), 0.45359237, 'a pound is exactly 0.45359237 kg');
select is((select factor_to_base from app.measurement_units where unit_code = 'gal'), 3.785411784, 'a US gallon is exactly 3.785411784 l');
select is((select factor_to_base from app.measurement_units where unit_code = 'short_ton'), 907.18474, 'a short ton is exactly 2,000 lb');
select is_empty($$
  select d.dimension, s.system from (select distinct dimension from app.measurement_units) d
  cross join (values ('Metric'), ('Imperial')) s(system)
  where (select count(*) from app.measurement_units u
         where u.dimension = d.dimension and u.is_display and u.unit_system in (s.system, 'Either')) <> 1
$$, 'every dimension shows in exactly one unit for metric readers and one for imperial readers');
select is_empty($$
  select m.metric_code from app.measurement_metrics m join app.measurement_units u on u.unit_code = m.base_unit_code
  where u.factor_to_base <> 1 or u.dimension <> m.dimension
$$, 'every metric totals in the factor 1 unit of its own dimension');
select is((select count(*)::int from app.measurement_metrics where family = 'Sustainability'), 5,
  'waste generated and diverted, energy, water and transport are sustainability figures');
select is((select count(*)::int from app.measurement_metrics where family in ('Audience', 'Earned Media', 'Sentiment')), 5,
  'attendance, online audience, earned media and sentiment are gate 8 figures');
select is((select canon_value_numeric from app.measurement_metrics where metric_code = 'waste_generated'), 2.4,
  'waste is benchmarked by the canon modeled 2.4 lb per guest per day');
select is((select canon_qualifier from app.measurement_metrics where metric_code = 'water_used'), 'MODELED - outdoor, non-camping',
  'water is benchmarked by the canon potable water model');
select is((select count(*)::int from xpms.dim_metric), 39, 'no canon metric is added (owner decision 25)');
select is_empty($$
  select t.tag_id from app.measurement_metric_tags t join xpms.dim_tag d on d.tag_id = t.tag_id where d.tag_type <> 'Sustainability'
$$, 'figures are reported against Bible sustainability tags only');
select is_empty($$
  select t.metric_code from app.measurement_metric_tags t join app.measurement_metrics m using (metric_code) where m.family <> 'Sustainability'
$$, 'only sustainability figures carry tags');
select is((select tag from app.measurement_metric_tags where metric_code = 'waste_diverted' and tag_id = 'TAG-005'), 'REUSABLE',
  'waste diverted is reported against REUSABLE');

select pg_temp.as_user('gina');
select is((select count(*)::int from app.measurement_metrics), 10, 'any member reads the metric list');
select is((select count(*)::int from app.measurement_units), 13, 'and the units');
select pg_temp.as_anon();
select throws_ok('select 1 from app.measurement_units', '42501', null, 'anon reads no unit');
select throws_ok('select 1 from app.measurement_metrics', '42501', null, 'nor any metric');

-- Objectives while gate 1 is open --------------------------------------------------------------------------------------
select pg_temp.as_user('erin');
select lives_ok($$insert into app.project_objectives (project_id, metric_code, direction, target_value, unit_code, note)
  values ((select id from world where key = 'prj_a'), 'attendance', 'At Least', 5000, 'count', 'Three shows at the pavilion.')$$,
  'a Collaborator on the project drafts an objective at gate 1');
select lives_ok($$insert into app.project_objectives (project_id, metric_code, direction, target_value, unit_code)
  values ((select id from world where key = 'prj_a'), 'waste_generated', 'At Most', 2, 't')$$, 'in any unit of the metric''s dimension');
insert into world select 'obj_attendance', id from app.project_objectives where metric_code = 'attendance';
insert into world select 'obj_waste', id from app.project_objectives where metric_code = 'waste_generated';
select is((select org_id from app.project_objectives where id = pg_temp.id('obj_attendance')), pg_temp.id('org_a'), 'the org comes from the project');
select throws_ok($$insert into app.project_objectives (project_id, metric_code, direction, target_value, unit_code)
  values ((select id from world where key = 'prj_a'), 'water_used', 'At Most', 100, 'kg')$$,
  'XR001', 'measurement_unit_dimension: kg is not a unit of water_used; use a volume unit.', 'a unit of another dimension is refused');
select throws_ok($$insert into app.project_objectives (project_id, metric_code, direction, target_value, unit_code)
  values ((select id from world where key = 'prj_a'), 'positive_sentiment', 'At Least', 120, 'percent')$$,
  'XR001', 'measurement_out_of_range: positive_sentiment takes figures from 0 to 100 percent.', 'a share above 100 percent is refused');
select throws_ok($$insert into app.project_objectives (project_id, metric_code, direction, target_value, unit_code)
  values ((select id from world where key = 'prj_a'), 'online_audience', 'At Least', 10.5, 'count')$$,
  'XR001', 'measurement_whole_count: A count is a whole number.', 'a fractional count is refused');
select throws_ok($$insert into app.project_objectives (project_id, metric_code, direction, target_value, unit_code)
  values ((select id from world where key = 'prj_a'), 'attendance', 'At Least', 6000, 'count')$$,
  '23505', null, 'one live objective per metric');
select throws_ok($$update app.project_objectives set metric_code = 'online_audience' where id = (select id from world where key = 'obj_attendance')$$,
  'XR001', 'project_objective_immutable: An objective keeps its project and metric; withdraw it and set another.', 'the metric never changes');
select lives_ok($$update app.project_objectives set target_value = 5500 where id = (select id from world where key = 'obj_attendance')$$,
  'a draft objective changes freely before gate 1');
select pg_temp.as_platform();
select ok(exists (select 1 from app.audit_events a where a.subject_table = 'app.project_objectives' and a.subject_id = pg_temp.id('obj_attendance')
  and a.actor_person_id = pg_temp.id('erin')), 'and the change lands in the audit ledger');

select pg_temp.as_user('gina');
select is((select count(*)::int from app.project_objectives), 0, 'a Viewer outside the project reads no objective (invariant 2)');
select throws_ok($$insert into app.project_objectives (project_id, metric_code, direction, target_value, unit_code)
  values ((select id from world where key = 'prj_a'), 'energy_used', 'At Most', 900, 'kwh')$$, '42501', null, 'nor sets one');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.project_objectives), 0, 'another org reads none');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.project_objectives), 2, 'a project member reads them');

-- Gate 1 approval locks the objectives ---------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.gate_evidence (project_id, criterion_id, evidence_uri, assertion_rank)
select pg_temp.id('prj_a'), c, 'docs/' || c || '.pdf', 4 from unnest(array['G1.BUDGET_ENVELOPE', 'G1.GONOGO', 'G1.JURISDICTION', 'G1.SCOPE_LOCK']) c;
insert into app.gate_evidence (project_id, criterion_id, evidence_uri, assertion_rank)
values (pg_temp.id('prj_a'), 'G1.OBJECTIVES_STATED', 'urn:xpms:project-objectives:' || pg_temp.id('prj_a'), 4);
select is(app.pass_gate(pg_temp.id('prj_a'), 'SCP', 'Go decision ratified.'), 'ENG', 'gate 1 passes with the objectives on the evidence spine');

select pg_temp.as_user('erin');
select throws_ok($$update app.project_objectives set target_value = 4000 where id = (select id from world where key = 'obj_attendance')$$,
  'XR001', 'project_objectives_locked: Gate 1 has been passed: only a gate approver sets, changes or withdraws the objectives it recorded.',
  'after gate 1 an evidence writer cannot lower a target');
select throws_ok($$insert into app.project_objectives (project_id, metric_code, direction, target_value, unit_code)
  values ((select id from world where key = 'prj_a'), 'energy_used', 'At Most', 900, 'kwh')$$,
  'XR001', null, 'nor add one');
select throws_ok($$update app.project_objectives set deleted_at = now() where id = (select id from world where key = 'obj_waste')$$,
  'XR001', null, 'nor withdraw one');
select pg_temp.as_user('dave');
select lives_ok($$update app.project_objectives set target_value = 2500, unit_code = 'kg' where id = (select id from world where key = 'obj_waste')$$,
  'a gate approver on the project changes one');
select lives_ok($$insert into app.project_objectives (project_id, metric_code, direction, target_value, unit_code)
  values ((select id from world where key = 'prj_a'), 'positive_sentiment', 'At Least', 70, 'percent')$$, 'and adds one');
select pg_temp.as_platform();
select is((select count(*)::int from app.audit_events a where a.subject_table = 'app.project_objectives' and a.actor_person_id = pg_temp.id('dave')), 2,
  'each change after the gate is in the audit ledger with its approver');

-- Measurements ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('erin');
select lives_ok($$insert into app.project_measurements (project_id, metric_code, measured_on, value, unit_code, source, source_reference)
  values ((select id from world where key = 'prj_a'), 'waste_generated', (select earlier from days), 1200, 'kg', 'Import', 'Hauler invoice 4471')$$,
  'an evidence writer records a figure');
insert into world select 'm_waste', id from app.project_measurements where source_reference = 'Hauler invoice 4471';
select lives_ok($$insert into app.project_measurements (project_id, metric_code, value, unit_code, correction_reason)
  values ((select id from world where key = 'prj_a'), 'water_used', null, null, 'Not needed.')$$,
  'a figure that was not measured is recorded without a value');
select is((select value from app.project_measurements where metric_code = 'water_used'), null::numeric, 'it stays NULL, never zero');
select is((select measured_on from app.project_measurements where metric_code = 'water_used'), (select today from days),
  'the day defaults to today on the project''s calendar');
select is((select correction_reason from app.project_measurements where metric_code = 'water_used'), null, 'a reason is never stored on the row');
select is((select created_by from app.project_measurements where id = pg_temp.id('m_waste')), pg_temp.id('erin'), 'who recorded it is kept');
select throws_ok($$insert into app.project_measurements (project_id, metric_code, value) values ((select id from world where key = 'prj_a'), 'energy_used', 300)$$,
  'XR001', 'measurement_unit_required: A measured figure names its unit.', 'a measured figure names its unit');
select throws_ok($$insert into app.project_measurements (project_id, metric_code, measured_on, value, unit_code)
  values ((select id from world where key = 'prj_a'), 'energy_used', (select today + 1 from days), 300, 'kwh')$$,
  'XR001', 'measurement_in_future: A figure is measured on or before today on the project''s calendar.', 'a figure is never dated after today');
select throws_ok($$insert into app.project_measurements (project_id, metric_code, value, unit_code) values ((select id from world where key = 'prj_a'), 'earned_media_reach', 40000, 'count')$$,
  'XR001', 'measurement_metric_derived: earned_media_reach is computed from the earned media coverage records; add coverage instead.',
  'earned media figures come from the coverage records');
select throws_ok($$insert into app.project_measurements (project_id, metric_code, value, unit_code) values ((select id from world where key = 'prj_a'), 'energy_used', 300, 'kg')$$,
  'XR001', null, 'units follow the metric');
select throws_ok($$insert into app.project_measurements (project_id, metric_code, value, unit_code, source_uri) values ((select id from world where key = 'prj_a'), 'energy_used', 300, 'kwh', 'javascript:alert(1)')$$,
  '23514', null, 'a source link is an http(s) URL or a URN');

-- Corrections ------------------------------------------------------------------------------------------------------------
select throws_ok($$update app.project_measurements set value = 1250 where id = (select id from world where key = 'm_waste')$$,
  'XR001', 'measurement_correction_reason: Say why the figure is corrected.', 'a correction needs a reason');
select lives_ok($$update app.project_measurements set value = 1.25, unit_code = 't', correction_reason = 'Weighbridge ticket supersedes the estimate.'
  where id = (select id from world where key = 'm_waste')$$, 'a correction with a reason');
select is((select correction_kind::text || ' ' || previous_value || ' ' || previous_unit_code || ' to ' || value || ' ' || unit_code || ': ' || reason
  from app.project_measurement_corrections where project_measurement_id = pg_temp.id('m_waste')),
  'Corrected 1200 kg to 1.25 t: Weighbridge ticket supersedes the estimate.', 'is written to the ledger with the figure before and after');
select is((select created_by from app.project_measurement_corrections where project_measurement_id = pg_temp.id('m_waste')), pg_temp.id('erin'),
  'with who corrected it');
select is((select correction_reason from app.project_measurements where id = pg_temp.id('m_waste')), null, 'and the reason is cleared from the row');
select lives_ok($$update app.project_measurements set note = 'Two roll-offs.' where id = (select id from world where key = 'm_waste')$$,
  'a note changes without a correction');
select is((select count(*)::int from app.project_measurement_corrections where project_measurement_id = pg_temp.id('m_waste')), 1, 'and writes no correction');
select throws_ok($$update app.project_measurements set source = 'Manual' where id = (select id from world where key = 'm_waste')$$,
  'XR001', 'project_measurement_immutable: A figure keeps its project, metric and source; withdraw it and record another.', 'the source never changes');
select throws_ok($$update app.project_measurements set measured_on = (select today + 2 from days), correction_reason = 'Typo.' where id = (select id from world where key = 'm_waste')$$,
  'XR001', null, 'a correction cannot move a figure past today');
select lives_ok($$update app.project_measurements set deleted_at = now(), correction_reason = 'Duplicate of the hauler import.' where id = (select id from world where key = 'm_waste')$$,
  'a figure is withdrawn');
select lives_ok($$update app.project_measurements set deleted_at = null where id = (select id from world where key = 'm_waste')$$, 'and restored');
select is((select string_agg(correction_kind::text || coalesce(': ' || reason, ''), ', ' order by created_at, correction_kind)
  from app.project_measurement_corrections where project_measurement_id = pg_temp.id('m_waste')),
  'Corrected: Weighbridge ticket supersedes the estimate., Withdrawn: Duplicate of the hauler import., Restored', 'both are in the ledger');
select throws_ok($$insert into app.project_measurement_corrections (project_measurement_id, correction_kind, previous_measured_on, measured_on)
  values ((select id from world where key = 'm_waste'), 'Corrected', current_date, current_date)$$, '42501', null, 'nobody writes the ledger directly');
select pg_temp.as_platform();
select throws_ok($$update app.project_measurement_corrections set reason = 'Rewritten.'$$, 'XR001', null, 'the ledger is append-only');

select pg_temp.as_user('dave');
select is((select count(*)::int from app.project_measurements), 2, 'a project member reads the figures');
select is((select count(*)::int from app.project_measurement_corrections), 3, 'and their corrections');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.project_measurements), 0, 'a Viewer outside the project reads no figure');
select is((select count(*)::int from app.project_measurement_corrections), 0, 'nor a correction');
select throws_ok($$insert into app.project_measurements (project_id, metric_code, value, unit_code) values ((select id from world where key = 'prj_a'), 'energy_used', 300, 'kwh')$$,
  '42501', null, 'nor records one');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.project_measurements), 0, 'another org reads none');
select throws_ok($$insert into app.project_measurements (project_id, metric_code, value, unit_code) values ((select id from world where key = 'prj_a'), 'energy_used', 300, 'kwh')$$,
  '42501', null, 'nor writes into another org''s project');
select pg_temp.as_anon();
select throws_ok('select 1 from app.project_measurements', '42501', null, 'anon reads no figure');

select * from finish();
rollback;
