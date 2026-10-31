-- pgTAP: migration 2872, custom fields on budget lines (P10, RRR-224, gap G-217). Budget lines are the tenth built-in
-- target: Settings lists them, an org with org.custom_fields.write defines a filterable Choice tag on them, values are
-- read and written under the line's own budget policy (finance.budget.read on the budget's project) by the
-- Collaborator band or higher, and the 0540 and 2110 value rules hold.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(13);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Budgets and lines in Northwind (prj_a) and Harbor Lights (prj_b).
select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD') returning id)
insert into world select 'bud_a', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_a'), 1, 'Stage deck rental.', '0000.01.01', 2, 15000, 'X', 'Category') returning id)
insert into world select 'line_stage', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_a'), 2, 'Crew overtime.', '0000.01.01', 1, 40000, 'X', 'Declared') returning id)
insert into world select 'line_ot', id from x;
select pg_temp.as_user('xavier');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_b'), 'Pier Nights Budget', 'USD') returning id)
insert into world select 'bud_b', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_b'), 1, 'Barge rental.', '0000.01.01', 1, 90000, 'X', 'Declared') returning id)
insert into world select 'line_b', id from x;

-- Project-scoped finance.budget.read for a Collaborator (erin) and a Viewer (gina) on prj_a.
select pg_temp.as_user('alice');
insert into app.user_capability_grants (membership_id, capability_code, scope_kind, scope_id, reason) values
  (pg_temp.id('erin@org_a'), 'finance.budget.read', 'project', pg_temp.id('prj_a'), 'Tags the rental lines.'),
  (pg_temp.id('gina@org_a'), 'finance.budget.read', 'project', pg_temp.id('prj_a'), 'Reviews the budget.');

-- The target --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select ok(exists (select 1 from app.custom_field_targets where table_name = 'app.budget_lines'),
  'Settings lists budget lines among the custom field targets');
select is((select count(*)::integer from app.custom_field_targets), 10, 'budget lines are the tenth target');
select lives_ok($$
  with d as (
    insert into app.custom_field_definitions (org_id, target_table, field_key, label, data_type, filterable, sort_order)
    values (pg_temp.id('org_a'), 'app.budget_lines', 'tag', 'Tag', 'Choice', true, 1) returning id)
  insert into k select 'tag', id from d$$,
  'a member with org.custom_fields.write defines a filterable Choice tag on budget lines');
insert into app.custom_field_choices (custom_field_definition_id, choice_key, label, sort_order) values
  ((select id from k where key = 'tag'), 'rental', 'Rental', 1),
  ((select id from k where key = 'tag'), 'overtime', 'Overtime', 2);
insert into k select 'choice_' || choice_key, id from app.custom_field_choices
where custom_field_definition_id = (select id from k where key = 'tag');
insert into app.custom_field_definitions (org_id, target_table, field_key, label, data_type, required, sort_order)
values (pg_temp.id('org_a'), 'app.budget_lines', 'gl_note', 'GL Note', 'Text', true, 2);
insert into k select 'gl_note', id from app.custom_field_definitions where field_key = 'gl_note' and org_id = pg_temp.id('org_a');
select pg_temp.as_platform();
select ok(exists (select 1 from pg_indexes where indexname = 'cfv_f_' || replace((select id from k where key = 'tag')::text, '-', '')),
  'the filterable tag gets its partial index');

-- Who writes and reads ------------------------------------------------------------------------------------------------
select pg_temp.as_user('erin');
select lives_ok($$insert into app.custom_field_values (custom_field_definition_id, target_id, value_choice_id)
  values ((select id from k where key = 'tag'), pg_temp.id('line_stage'), (select id from k where key = 'choice_rental'))$$,
  'a Collaborator-band member with finance.budget.read on the project tags a line');
select is((select count(*)::integer from app.custom_field_values where target_id = pg_temp.id('line_stage')), 1,
  'and reads the value back');
select pg_temp.as_user('dave');
select lives_ok($$insert into app.custom_field_values (custom_field_definition_id, target_id, value_choice_id)
  values ((select id from k where key = 'tag'), pg_temp.id('line_ot'), (select id from k where key = 'choice_overtime'))$$,
  'a project member holding finance.budget.read tags another line');

select pg_temp.as_user('mia');
select is((select count(*)::integer from app.custom_field_values where target_id in (pg_temp.id('line_stage'), pg_temp.id('line_ot'))), 0,
  'a member without finance.budget.read on the budget''s project sees no tag');
select throws_ok($$insert into app.custom_field_values (custom_field_definition_id, target_id, value_choice_id)
  values ((select id from k where key = 'tag'), pg_temp.id('line_stage'), (select id from k where key = 'choice_overtime'))$$,
  '42501', null, 'nor writes one');

select pg_temp.as_user('gina');
select is((select count(*)::integer from app.custom_field_values where target_id = pg_temp.id('line_stage')), 1,
  'a Viewer-band member with finance.budget.read reads the tag');
select throws_ok($$insert into app.custom_field_values (custom_field_definition_id, target_id, value_text)
  values ((select id from k where key = 'gl_note'), pg_temp.id('line_stage'), 'Rental, billed back.')$$,
  '42501', null, 'but never writes one');
select pg_temp.as_platform();

-- The value rules of 0540 and 2110 ------------------------------------------------------------------------------------
select throws_like($$insert into app.custom_field_values (custom_field_definition_id, target_id, value_choice_id)
  values ((select id from k where key = 'tag'), pg_temp.id('line_b'), (select id from k where key = 'choice_rental'))$$,
  'cross_org_reference:%', 'a value pointing at another org''s line is refused');
select pg_temp.as_user('dave');
select throws_like($$insert into app.custom_field_values (custom_field_definition_id, target_id) values ((select id from k where key = 'gl_note'), pg_temp.id('line_stage'))$$,
  'custom_value_required:%', 'a required field on a budget line needs a value');

select * from finish();
rollback;
