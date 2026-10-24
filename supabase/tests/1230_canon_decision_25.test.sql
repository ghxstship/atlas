-- pgTAP: owner decision 25 (2026-10-19, RRR-101), migration 1230 and the regenerated canon seed.
-- The Bible wins on structure, values the Bible lacks are imported and marked as from the Playbook,
-- labels map to the closest existing value, and the CSMIA26 template rows stay private (RRR-67). Owner decision 39
-- (2026-10-23, RRR-66, migration 1610) settled what decision 25 left deferred, so the counts below include it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(27);

-- Values the Bible lacks, imported and marked -------------------------------------------------------
select is((select count(*)::int from xpms.playbook_sourced_value), 2575, 'every imported value is marked as from the Playbook');
select is((select count(*)::int from xpms.playbook_sourced_value where target_table = 'element_price_bands'), 2570,
  'the Playbook prices the Item Catalog leaves unpriced are imported (about 857 per grade)');
select is(
  (select count(*)::int from xpms.playbook_sourced_value s
    where s.target_table = 'element_price_bands'
      and not exists (select 1 from xpms.element_price_bands b
                       where b.element_id = s.target_key and b.grade_code = split_part(s.target_column, ':', 2)
                         and b.amount_minor = round(s.value_text::numeric * 100))),
  0, 'every marked price is stored as its band, in minor units');
select is((select amount_minor from xpms.element_price_bands where element_id = '0000.51.01-XOS-004' and grade_code = 'base'),
  3500000::bigint, 'an item the Bible leaves unpriced carries the Playbook price');
select is((select amount_minor from xpms.element_price_bands where element_id = '6000.08.02-XPMS-002' and grade_code = 'base'),
  17000::bigint, 'where both price an item, the Bible''s price is kept');
select is((select scope_code from xpms.dim_cost_center_template where cost_center_id = 'CC-VENUE'), 'CC-VENUE',
  'a cost center scope code the Bible leaves blank comes from the Playbook');
select is((select count(*)::int from xpms.playbook_sourced_value where target_table = 'dim_cost_center_template'), 5,
  'the five cost center values are marked as from the Playbook');

-- Intake: imported values leave it, kept Bible values stay Canceled for the round trip --------------
select is(
  (select count(*)::int from xpms.intake i join xpms.playbook_sourced_value s
     on s.source_file = i.source_file and s.source_sheet = i.source_sheet and s.source_row = i.source_row and s.source_column = i.source_column),
  0, 'no imported value is still proposed in intake');
select is((select count(*)::int from xpms.intake where intake_state = 'Canceled'), 347,
  'Playbook values the decisions do not adopt stay in intake as Canceled (247 by decision 25, 100 phase names by decision 39)');
select is((select count(*)::int from xpms.intake where intake_state = 'Canceled' and reason not like '%Owner decision 25%' and reason not like '%Owner decision 39%'), 0,
  'each kept value names the decision');
select is((select count(*)::int from xpms.intake where intake_state = 'Proposed' and source_file like 'XOS-4.0_Production-Playbook%'), 0,
  'no Playbook difference is left undecided');
select ok(not exists (select 1 from xpms.intake where intake_state = 'Proposed'),
  'no Bible inconsistency waits in intake: decision 39 ruled on RRR-66');

-- Structure: no state, type or code is added ----------------------------------------------------------
select is((select count(*)::int from xpms.dim_counterparty_type where counterparty_type = 'Landlord'), 0, 'Landlord is not added as a counterparty type');
select is((select canon_value from xpms.label_mapping where source_list = 'Counterparty Types' and playbook_label = 'Landlord'),
  'Facilities Services', 'Landlord resolves to the existing Facilities Services type');
select is((select count(*)::int from xpms.dim_state), 18, 'no state is added');

-- Label mappings name only values canon and the domain schema hold ------------------------------------
select is(
  (select count(*)::int from xpms.label_mapping m
    where m.canon_value is not null and not case m.target_domain
      when 'state' then m.canon_value in (select state from xpms.dim_state union select record_state from xpms.dim_record_state)
      when 'unit' then m.canon_value in (select alias from xpms.dim_unit_alias)
      when 'element_kind' then m.canon_value in (select kind from xpms.elements)
      when 'counterparty_type' then m.canon_value in (select counterparty_type from xpms.dim_counterparty_type)
      when 'order_type' then m.canon_value in (select enum_label from xpms.std_enumeration where enum_domain = 'Order Type')
      when 'freight_type' then m.canon_value in (select enum_label from xpms.std_enumeration where enum_domain = 'Freight Type')
      when 'record_kind' then m.canon_value in (select record_kind from xpms.dim_record_kind)
      when 'record_subtype' then m.canon_value in (select record_kind || ' · ' || record_subtype from xpms.dim_record_subtype)
      when 'phase' then m.canon_value in (select phase_code from xpms.dim_phase)
      when 'department' then m.canon_value in (select dept_code from xpms.dim_department)
      when 'category' then m.canon_value in (select cat_urid from xpms.dim_category)
      when 'production_state' then m.canon_value = any (enum_range(null::app.production_state)::text[])
      when 'work_order_state' then m.canon_value = any (enum_range(null::app.work_order_state)::text[])
      when 'asset_state' then m.canon_value = any (enum_range(null::app.asset_state)::text[])
      when 'shift_state' then m.canon_value = any (enum_range(null::app.shift_state)::text[])
      else false end),
  0, 'every mapped label names an existing canon or lifecycle value');
select is((select count(*)::int from xpms.label_mapping), 102, 'every label the decision maps is recorded');
select is((select string_agg(playbook_label || ' ' || canon_value, ', ' order by playbook_label) from xpms.label_mapping
            where source_list = 'Enumerations: Unit of Measure' and playbook_label in ('Hour', 'Week')),
  'Hour hour, Week week', 'the units decision 25 deferred resolve to the time units decision 39 ratified');
select is((select canon_value from xpms.label_mapping where source_list = 'Crew Shifts STATUS' and playbook_label = 'Confirmed'),
  'Accepted', 'a status label maps to the closest state of its lifecycle');
select throws_ok($$insert into xpms.label_mapping (source_list, playbook_label, target_domain, canon_value, basis, decision) values ('x', 'y', 'state', null, 'closest-state', 'D25')$$,
  '23514', null, 'a mapping has a canon value unless it is deferred');

-- The 18 Playbook field targets that waited on the decision resolve (finding A47-001) ------------------
select is((select count(*)::int from xpms.playbook_column where note like 'Blocked on owner%'), 0, 'no Playbook column waits on the owner');
select is(
  (select count(*)::int from xpms.playbook_column c
    where c.disposition = 'field' and c.target like 'app.%'
      and not exists (select 1 from information_schema.columns k
                       where k.table_schema = split_part(c.target, '.', 1) and k.table_name = split_part(c.target, '.', 2)
                         and k.column_name = split_part(c.target, '.', 3))),
  0, 'every domain field target names a real column');

-- Canon stays read-only; the CSMIA26 template stays private (RRR-67) -----------------------------------
select is((select is_published from xpms.production_template where template_code = 'XOS-4.0'), false, 'the Production Template stays unpublished');
set local role authenticated;
select ok((select count(*) from xpms.label_mapping) > 0 and (select count(*) from xpms.playbook_sourced_value) > 0,
  'authenticated users can read the decision tables');
select throws_ok($$insert into xpms.label_mapping (source_list, playbook_label, target_domain, canon_value, basis, decision) values ('x', 'y', 'state', 'Active', 'closest-state', 'D25')$$,
  '42501', null, 'authenticated users cannot write the decision tables');
select throws_ok($$select count(*) from xpms.production_template_values$$, '42501', null, 'authenticated users cannot read the CSMIA26 template rows');
reset role;
set local role service_role;
select ok((select count(*) from xpms.production_template_values) > 0, 'service_role reads the template rows');
reset role;

select * from finish();
rollback;
