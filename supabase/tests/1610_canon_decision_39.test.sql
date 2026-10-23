-- pgTAP: owner decision 39 (2026-10-23, RRR-66), migration 1610 and the regenerated canon seed. The seven canon
-- rulings of finding A56-001 are applied, and every gated phase carries an Active element or a declared gap
-- (doctrine 3.4, finding A65-019).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(24);

-- Ruling 1: "Show" means OPR and "Procurement" means PRC ------------------------------------------------------
select is((select count(*)::int from xpms.intake where intake_state = 'Proposed'), 0, 'no canon value waits in intake for the owner');
select is((select count(*)::int from xpms.intake where intake_state = 'Complete' and reason like '%Owner decision 39%'), 118,
  'the 118 phase names the ruling resolved stay in intake as Complete, naming the decision');
select is(
  (select count(*)::int from xpms.intake where intake_state = 'Complete'
     and canon_value <> case proposed_value when 'Show' then 'OPR' when 'Procurement' then 'PRC' end),
  0, 'Show resolves to OPR and Procurement to PRC');
select is((select count(*)::int from xpms.bridge_element_phase where is_default), 1211, 'every catalog item has a default phase');
select is(
  (select count(*)::int from xpms.intake i
     join xpms.bridge_element_phase b on b.element_id = i.target_key and b.is_default and b.phase_code = i.canon_value
    where i.source_column = 'default_phase'),
  100, 'each item named Show or Procurement carries the phase the ruling gives');
select is((select count(*)::int from xpms.dim_touchpoint where lifecycle_phase_code is null), 0, 'every touchpoint has a lifecycle phase');
select is(
  (select count(*)::int from xpms.dim_touchpoint t
     join xpms.intake i on i.target_key = t.touchpoint_id and i.source_column = 'lifecycle_gate'
    where t.lifecycle_phase_code = 'OPR'),
  18, 'the 18 touchpoints whose gate is Show are in Operate');
select is(
  (select count(*)::int from xpms.intake
    where source_sheet = 'Procurement Catalog' and source_column = 'DEFAULT PHASE' and intake_state = 'Canceled'),
  100, 'the Playbook''s phase names stay in intake for the round trip');

-- Rulings 2 to 5: labels, statements and role codes --------------------------------------------------------------
select is((select count(*)::int from xpms.canon_statement where tab like '23%'), 0, 'tab 23''s headings are not loaded');
select is((select count(*)::int from xpms.dim_budget_template_rule where rule like '=%'), 0, 'no tab 34 rule is an empty formula');
select is((select count(*)::int from xpms.dim_budget_template_rule), 10, 'tab 34 keeps its ten stated rules');
select is((select department from xpms.dim_department d join xpms.dim_role r using (dept_code) where r.role_code = '4000.50.01'),
  'Environment', 'department 4000 is Environment for its roles');
select is((select count(*)::int from xpms.role where role_code in ('2000.50.02', '5000.50.03', '6000.50.03')), 3,
  'the Roles Library owns the three role codes tab 27 lacks');
select is((select count(*)::int from xpms.dim_role where role_code in ('2000.50.02', '5000.50.03', '6000.50.03')), 0,
  'tab 27 does not have to hold a role code for it to exist');

-- Ruling 7: the time dimension ------------------------------------------------------------------------------------
select is((select name from xpms.dim_unit_dimension where dimension_code = 'time'), 'Time', 'the time dimension is ratified');
select is((select string_agg(alias, ', ' order by alias) from xpms.dim_unit_alias where dimension_code = 'time'),
  'day, hour, week, year', 'hour, day, week and year are time units');
select is((select count(*)::int from xpms.dim_unit_alias where dimension_code is null), 7, 'the other unit bases keep no dimension');

-- Ruling 8 and doctrine 3.4: declared gaps ------------------------------------------------------------------------
select is((select count(*)::int from xpms.v_phase_coverage where not has_active_element and not declared_gap), 0,
  'every gated phase carries an Active element or a declared gap');
select is((select string_agg(phase_code, ', ' order by gate) from xpms.v_phase_coverage where declared_gap),
  'SCP, ENG, AMP, CLS', 'Scope, Engage, Amplify and Close are the declared gaps');
select is((select count(*)::int from xpms.declared_gap where decision = 'D39' and ratified_by <> '' and ratified_on = '2026-10-23'), 4,
  'each gap names the decision and its ratifier');
select is((select element_count from xpms.v_phase_coverage where phase_code = 'OPR'), 283, 'Operate counts the 54 items named Show');
select is((select element_count from xpms.v_phase_coverage where phase_code = 'PRC'), 283, 'Procure counts the 46 items named Procurement');

set local role authenticated;
select is((select count(*)::int from xpms.declared_gap), 4, 'authenticated users read the declared gaps');
select throws_ok($$insert into xpms.declared_gap (phase_code, reason, decision, ratified_by, ratified_on) values ('OPR', 'x', 'D39', 'x', current_date)$$,
  '42501', null, 'authenticated users cannot declare a gap');
reset role;

select * from finish();
rollback;
