-- pgTAP: custom objects with typed values and partial indexes, custom fields on built-in tables,
-- saved views and feature flags (Section 4.6.3, Section 7.3, Section 5.1).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(42);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Custom object definitions ------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$insert into app.custom_object_types (org_id, object_key, label, icon) values (pg_temp.id('org_a'), 'sponsors', 'Sponsors', 'handshake')$$,
  '42501', null, 'a member cannot define custom objects');
select pg_temp.as_user('bob');
insert into app.custom_object_types (org_id, object_key, label, icon) values (pg_temp.id('org_a'), 'sponsors', 'Sponsors', 'handshake');
insert into k select 'type', id from app.custom_object_types where object_key = 'sponsors';
select throws_ok($$insert into app.custom_object_types (org_id, object_key, label, icon) values (pg_temp.id('org_a'), 'gear', 'gear list', 'box')$$,
  '23514', null, 'object labels are Title Case');
select throws_ok($$update app.custom_object_types set object_key = 'partners' where object_key = 'sponsors'$$, 'XR001', null,
  'an object key never changes');
insert into app.custom_object_fields (custom_object_type_id, field_key, label, data_type, filterable, sort_order) values
  ((select id from k where key = 'type'), 'tier', 'Tier', 'Choice', true, 1),
  ((select id from k where key = 'type'), 'fee', 'Fee', 'Money', false, 2),
  ((select id from k where key = 'type'), 'contact', 'Contact', 'Person', false, 3),
  ((select id from k where key = 'type'), 'website', 'Website', 'URL', true, 4);
insert into k select field_key, id from app.custom_object_fields;
insert into app.custom_object_field_choices (custom_object_field_id, choice_key, label, sort_order) values
  ((select id from k where key = 'tier'), 'gold', 'Gold', 1),
  ((select id from k where key = 'tier'), 'silver', 'Silver', 2);
select is((select count(*)::integer from pg_indexes where schemaname = 'app' and indexname = 'cov_f_' || replace((select id from k where key = 'tier')::text, '-', '')
           and indexdef like '%(value_choice_id)%'), 1, 'a filterable field gets a partial index on its value column');
update app.custom_object_fields set filterable = false where field_key = 'website';
select is((select count(*)::integer from pg_indexes where indexname = 'cov_f_' || replace((select id from k where key = 'website')::text, '-', '')), 0,
  'the index goes when the field stops being filterable');
select throws_ok($$update app.custom_object_fields set data_type = 'Text' where field_key = 'fee'$$, 'XR001', null, 'a field keeps its data type');
select pg_temp.as_platform();
select is(private.custom_limit(pg_temp.id('org_a'), 'custom_object_types'), null::bigint, 'the plan limit is read from private.org_plan_limits (none set means unlimited)');

-- Records and typed values ------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$insert into app.custom_object_records (custom_object_type_id, title) values ((select id from k where key = 'type'), 'Acme Beverages')$$,
  '42501', null, 'a viewer cannot create records');
select pg_temp.as_user('dave');
insert into app.custom_object_records (custom_object_type_id, title) values ((select id from k where key = 'type'), 'Acme Beverages');
insert into k select 'rec', id from app.custom_object_records;
select lives_ok($$insert into app.custom_object_values (custom_object_record_id, custom_object_field_id, value_choice_id)
  values ((select id from k where key = 'rec'), (select id from k where key = 'tier'), (select id from app.custom_object_field_choices where choice_key = 'gold'))$$,
  'a choice value is stored in its typed column');
select lives_ok($$insert into app.custom_object_values (custom_object_record_id, custom_object_field_id, value_money_minor, value_currency)
  values ((select id from k where key = 'rec'), (select id from k where key = 'fee'), 2500000, 'USD')$$, 'a money value carries its currency');
select throws_ok($$insert into app.custom_object_values (custom_object_record_id, custom_object_field_id, value_text)
  values ((select id from k where key = 'rec'), (select id from k where key = 'fee'), '25000')$$, 'XR001', null,
  'a value goes only in the column of its data type');
select throws_ok($$insert into app.custom_object_values (custom_object_record_id, custom_object_field_id, value_choice_id)
  values ((select id from k where key = 'rec'), (select id from k where key = 'tier'), (select id from app.custom_object_field_choices where choice_key = 'silver'))$$,
  '23505', null, 'one value per record and field');
select throws_ok($$insert into app.custom_object_values (custom_object_record_id, custom_object_field_id, value_person_id)
  values ((select id from k where key = 'rec'), (select id from k where key = 'contact'), pg_temp.id('xavier'))$$, 'XR001', null,
  'a person value names a member of the org');
select throws_ok($$insert into app.custom_object_values (custom_object_record_id, custom_object_field_id, value_text)
  values ((select id from k where key = 'rec'), (select id from k where key = 'website'), 'not a url')$$, 'XR001', null,
  'URL values are checked');
select lives_ok($$insert into app.custom_object_values (custom_object_record_id, custom_object_field_id, value_person_id)
  values ((select id from k where key = 'rec'), (select id from k where key = 'contact'), pg_temp.id('carol'))$$, 'a member is a valid person value');
select lives_ok($$insert into app.custom_object_relations (from_record_id, relation_key, to_project_id) values ((select id from k where key = 'rec'), 'activation', pg_temp.id('prj_a'))$$,
  'a record links to a project');
select throws_ok($$insert into app.custom_object_relations (from_record_id, relation_key, to_project_id, to_person_id) values ((select id from k where key = 'rec'), 'both', pg_temp.id('prj_a'), pg_temp.id('carol'))$$,
  '23514', null, 'a relation has exactly one target');
select pg_temp.as_platform();
select throws_ok($$insert into app.custom_object_relations (from_record_id, relation_key, to_project_id) values ((select id from k where key = 'rec'), 'raid', pg_temp.id('prj_b'))$$,
  'XR001', null, 'a relation never crosses orgs');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.custom_object_types) + (select count(*)::integer from app.custom_object_values), 0,
  'no cross-tenant custom object reads');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.custom_object_values), 3, 'every member reads custom object values');

-- Custom fields on built-in tables ------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
insert into app.custom_field_definitions (org_id, target_table, field_key, label, data_type, filterable, sort_order)
values (pg_temp.id('org_a'), 'app.projects', 'budget_code', 'Budget Code', 'Text', true, 1);
insert into k select 'cfd', id from app.custom_field_definitions;
select is((select count(*)::integer from pg_indexes where indexname = 'cfv_f_' || replace((select id from k where key = 'cfd')::text, '-', '')), 1,
  'filterable custom fields get a partial index too');
select throws_ok($$insert into app.custom_field_definitions (org_id, target_table, field_key, label, data_type, sort_order)
  values (pg_temp.id('org_a'), 'app.audit_events', 'x', 'X', 'Text', 1)$$, '23503', null, 'custom fields extend only listed tables');
select pg_temp.as_user('dave');
select lives_ok($$insert into app.custom_field_values (custom_field_definition_id, target_id, value_text) values ((select id from k where key = 'cfd'), pg_temp.id('prj_a'), 'NWL-26')$$,
  'a project member sets a custom field on their project');
select throws_ok($$insert into app.custom_field_values (custom_field_definition_id, target_id, value_text) values ((select id from k where key = 'cfd'), pg_temp.id('prj_a2'), 'NWX-26')$$,
  '42501', null, 'nobody sets a custom field on a row they cannot read');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.custom_field_values), 0, 'a custom field value is hidden where its row is hidden (invariant 2)');
select pg_temp.as_user('erin');
select is((select value_text from app.custom_field_values), 'NWL-26', 'another member of the project reads it');
select pg_temp.as_platform();
select throws_ok($$insert into app.custom_field_values (custom_field_definition_id, target_id, value_text) values ((select id from k where key = 'cfd'), pg_temp.id('prj_b'), 'HLP')$$,
  'XR001', null, 'a custom field value never points into another org');

-- Saved views --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into app.saved_views (membership_id, collection_key, name, view_type, group_by_field) values
  (pg_temp.id('dave@org_a'), 'objects/sponsors', 'Gold Sponsors', 'Board', 'tier');
insert into k select 'view', id from app.saved_views;
insert into app.saved_view_filters (saved_view_id, field, operator, value_text) values ((select id from k where key = 'view'), 'tier', 'eq', 'gold');
insert into app.saved_view_sorts (saved_view_id, field, direction, position) values ((select id from k where key = 'view'), 'title', 'Ascending', 1);
select throws_ok($$insert into app.saved_view_filters (saved_view_id, field, operator) values ((select id from k where key = 'view'), 'fee', 'gt')$$,
  '23514', null, 'a filter other than is_null has a value');
select throws_ok($$insert into app.saved_views (membership_id, collection_key, name, view_type) values (pg_temp.id('erin@org_a'), 'records', 'Mine', 'List')$$,
  '42501', null, 'nobody saves a view for someone else');
select pg_temp.as_user('erin');
select is((select count(*)::integer from app.saved_views), 0, 'a private view is the owner''s alone');
select pg_temp.as_user('dave');
update app.saved_views set shared = true;
select pg_temp.as_user('erin');
select is((select count(*)::integer from app.saved_view_filters), 1, 'a shared view and its filters are readable by the org');
select throws_ok($$insert into app.saved_view_sorts (saved_view_id, field, direction, position) values ((select id from k where key = 'view'), 'fee', 'Descending', 2)$$,
  '42501', null, 'only the owner edits a shared view');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.saved_views), 0, 'no cross-tenant view reads');

-- Feature flags -------------------------------------------------------------------------------------------------------
-- 1402 (A83) turned imports.ai_mapping on by default; the suite sets its default off to exercise an off flag.
select pg_temp.as_platform();
update private.feature_flags set default_enabled = false where flag_key = 'imports.ai_mapping';
select pg_temp.as_user('alice');
select is((select enabled from app.org_feature_flags(pg_temp.id('org_a')) where flag_key = 'webhooks.delivery'), true,
  'a plan-gated flag is on for a plan that includes the feature');
select is((select enabled from app.org_feature_flags(pg_temp.id('org_a')) where flag_key = 'imports.ai_mapping'), false, 'flags start at their default');
select throws_ok($$insert into app.feature_flag_overrides (org_id, flag_key, enabled, reason) values (pg_temp.id('org_a'), 'imports.ai_mapping', true, 'Self-serve.')$$,
  '42501', null, 'orgs cannot override flags themselves');
select pg_temp.as_platform();
insert into app.feature_flag_overrides (org_id, flag_key, enabled, reason) values
  (pg_temp.id('org_a'), 'imports.ai_mapping', true, 'Early access cohort.'),
  (pg_temp.id('org_b'), 'webhooks.delivery', true, 'Support exception.');
select is(private.flag_enabled(pg_temp.id('org_a'), 'imports.ai_mapping'), true, 'an override turns a flag on for one org');
select is(private.flag_enabled(pg_temp.id('org_b'), 'webhooks.delivery'), false, 'an override never beats the plan');
update private.feature_flags set kill_switch = true where flag_key = 'imports.ai_mapping';
select is(private.flag_enabled(pg_temp.id('org_a'), 'imports.ai_mapping'), false, 'the kill switch turns the feature off everywhere');
select is(private.flag_enabled(pg_temp.id('org_a'), 'no.such_flag'), false, 'unknown flags are off');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.org_feature_flags(pg_temp.id('org_a'))), 0, 'another org''s flags are not readable');
select is((select count(*)::integer from app.feature_flag_overrides), 1, 'an org reads only its own overrides');

select * from finish();
rollback;
