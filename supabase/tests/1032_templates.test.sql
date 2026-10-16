-- pgTAP: templates (Section 4.10 workflow engine, Projects > Templates, A33). Same-tenant allow,
-- cross-tenant deny, anon deny, role bands (projects.template.write to edit, projects.project.create
-- to apply), version numbering, the draft and published states (publish only through the RPC,
-- published versions and their items frozen), the item shape invariants, applying a template as the
-- caller, saving a project as a template, and Trash registration.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(38);

-- Templates: role bands, tenancy, anon -------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$with x as (insert into app.templates (org_id, name, description) values ((select id from world where key = 'org_a'), 'Three-Day Festival', 'Outdoor weekend shows.') returning id) insert into world select 'tpl', id from x$$,
  'a Manager creates a template');
select throws_ok($$insert into app.templates (org_id, name) values ((select id from world where key = 'org_a'), 'three-day festival ')$$,
  '23505', null, 'template names are unique in the org, ignoring case and spaces');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.templates (org_id, name) values ((select id from world where key = 'org_a'), 'Mine')$$, '42501', null, 'a Member cannot create templates');
select is((select count(*)::int from app.templates), 1, 'a Member reads the org''s templates');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.templates where org_id = pg_temp.id('org_a')), 0, 'another org reads no templates');
select throws_ok($$select app.apply_template((select id from world where key = 'tpl'), 'XHL', 'Cross')$$, '42501', null, 'another org cannot apply the template');
select pg_temp.as_anon();
select throws_ok('select 1 from app.templates', '42501', null, 'anon cannot read templates');
select throws_ok('select 1 from app.template_applications', '42501', null, 'anon cannot read template applications');
select pg_temp.as_platform();

-- Versions and items -------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$insert into app.template_versions (template_id, published_at) values ((select id from world where key = 'tpl'), now())$$,
  'XR001', null, 'a version is never inserted published');
select throws_ok($$insert into app.template_versions (template_id, default_time_zone) values ((select id from world where key = 'tpl'), 'Mars/Olympus')$$,
  'XR001', null, 'the default time zone must be an IANA zone');
with x as (insert into app.template_versions (template_id, default_time_zone, default_currency_code, duration_days)
  values (pg_temp.id('tpl'), 'America/New_York', 'USD', 3) returning id) insert into world select 'v1', id from x;
with x as (insert into app.template_versions (template_id) values (pg_temp.id('tpl')) returning id) insert into world select 'v2', id from x;
select is((select string_agg(version_number::text, ',' order by version_number) from app.template_versions where template_id = pg_temp.id('tpl')), '1,2', 'versions are numbered in order');
select is((select org_id from app.template_versions where id = pg_temp.id('v1')), pg_temp.id('org_a'), 'a version''s org is derived from its template');
select lives_ok($$insert into app.template_items (template_version_id, item_kind, sort_order, name, scope_kind, scope_code_suffix) values ((select id from world where key = 'v1'), 'Scope Node', 1, 'Opening Night', 'Show', 'E02')$$,
  'a scope node item');
select lives_ok($$insert into app.template_items (template_version_id, item_kind, sort_order, name, record_kind, xyz, phase_code, due_offset_days) values ((select id from world where key = 'v1'), 'Record', 2, 'Book the rigging inspection', 'Inspection', 'Y', 'SCP', 3)$$,
  'a record item');
select throws_ok($$insert into app.template_items (template_version_id, item_kind, sort_order, name, scope_kind, scope_code_suffix, record_kind) values ((select id from world where key = 'v1'), 'Scope Node', 3, 'Bad', 'Show', 'E03', 'Task')$$,
  '23514', null, 'a scope node item carries no record fields');
select throws_ok($$insert into app.template_items (template_version_id, item_kind, sort_order, name, record_kind) values ((select id from world where key = 'v1'), 'Record', 3, 'No family', 'Task')$$,
  '23514', null, 'a record item declares its schema family');
select throws_ok($$insert into app.template_items (template_version_id, item_kind, sort_order, name, scope_kind, scope_code_suffix) values ((select id from world where key = 'v1'), 'Scope Node', 4, 'Again', 'Show', 'E02')$$,
  '23505', null, 'scope code suffixes are unique in a version');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.template_items (template_version_id, item_kind, sort_order, name, record_kind, xyz) values ((select id from world where key = 'v1'), 'Record', 5, 'Mine', 'Task', 'Y')$$,
  '42501', null, 'a Member cannot edit template items');
select pg_temp.as_platform();

-- Draft and published --------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select app.apply_template((select id from world where key = 'tpl'), 'NWT', 'Tidewater Weekend')$$,
  'XR001', 'template_unpublished: Publish a version of the template before creating projects from it.', 'a template without a published version is not applied');
select throws_ok($$update app.templates set current_version_id = (select id from world where key = 'v1') where id = (select id from world where key = 'tpl')$$,
  'XR001', null, 'the current version changes only by publishing');
select throws_ok($$update app.template_versions set published_at = now() where id = (select id from world where key = 'v1')$$,
  'XR001', null, 'a version is published only through the RPC');
select pg_temp.as_user('dave');
select throws_ok($$select app.publish_template_version((select id from world where key = 'v1'))$$, '42501', null, 'a Member cannot publish');
select pg_temp.as_user('carol');
select lives_ok($$select app.publish_template_version((select id from world where key = 'v1'))$$, 'the Manager publishes version 1');
select is((select current_version_id from app.templates where id = pg_temp.id('tpl')), pg_temp.id('v1'), 'it becomes the current version');
select throws_ok($$select app.publish_template_version((select id from world where key = 'v1'))$$, 'XR001', null, 'a version is published once');
select throws_ok($$update app.template_versions set duration_days = 5 where id = (select id from world where key = 'v1')$$,
  'XR001', 'template_version_published: A published version is frozen; create a new version to change the template.', 'a published version is frozen');
select throws_ok($$insert into app.template_items (template_version_id, item_kind, sort_order, name, record_kind, xyz) values ((select id from world where key = 'v1'), 'Record', 9, 'Late', 'Task', 'Y')$$,
  'XR001', null, 'and so are its items');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'template.published' and subject_id = pg_temp.id('v1')), 1, 'template.published was emitted');

-- Applying -------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.apply_template((select id from world where key = 'tpl'), 'NWD', 'Member Weekend', null, '2027-07-01')$$,
  '42501', null, 'a Member cannot create a project from a template');
select pg_temp.as_user('carol');
select lives_ok($$insert into world values ('app1', app.apply_template((select id from world where key = 'tpl'), 'nwt', 'Tidewater Weekend', null, '2027-07-01'))$$,
  'the Manager creates a project from the template');
insert into world select 'prj_t', project_id from app.template_applications where id = pg_temp.id('app1');
select is((select project_key || ' ' || time_zone || ' ' || currency || ' ' || ends_on::text from app.projects where id = pg_temp.id('prj_t')),
  'NWT America/New_York USD 2027-07-03', 'the project takes the version''s defaults and length');
select is((select string_agg(scope_code, ',' order by scope_code) from app.scope_nodes where project_id = pg_temp.id('prj_t')), 'NWT-E01,NWT-E02', 'the scope nodes are created under the engagement root');
select is((select title || ' ' || record_state || ' ' || (due_at at time zone 'America/New_York')::text from app.records where project_id = pg_temp.id('prj_t')),
  'Book the rigging inspection Proposed 2027-07-04 17:00:00', 'the record is created, due on the start date plus its offset');
select is((select scope_nodes_created || ' ' || records_created || ' ' || (template_version_id = pg_temp.id('v1'))::text from app.template_applications where id = pg_temp.id('app1')),
  '1 1 true', 'the application records the version and what it created');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'template.applied' and subject_id = pg_temp.id('app1')), 1, 'template.applied was emitted');

-- Saving a project as a template ------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$insert into world values ('tpl2', app.create_template_from_project((select id from world where key = 'prj_t'), 'Tidewater Weekend Template'))$$,
  'a project is saved as a template');
select is((select count(*)::int from app.template_items i join app.templates t on t.current_version_id = i.template_version_id where t.id = pg_temp.id('tpl2')), 2,
  'with its scope node and open record in a published first version');
select pg_temp.as_platform();

-- Trash ----------------------------------------------------------------------------------------------------
select ok(exists (select 1 from private.trash_tables where table_name = 'templates'), 'deleted templates reach Trash');

select * from finish();
rollback;
