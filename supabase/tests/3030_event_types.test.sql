-- pgTAP: event types (3030, B14 G-250). A holder of projects.template.write configures a type, its template rules and
-- its field set; a member reads them and cannot change them. The template a project starts from is the most specific
-- live, published rule, else none; a type of another org resolves to nothing. A project's type and bands are set by the
-- update policy while none is set, and changed only with projects.settings.write; an archived type is not newly set and
-- a type a live project names is not deleted. project.updated names the type.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(29);

select has_table('app', 'event_types', 'app.event_types exists');
select has_table('app', 'event_type_templates', 'app.event_type_templates exists');
select has_table('app', 'event_type_fields', 'app.event_type_fields exists');
select has_column('app', 'projects', 'event_type_id', 'projects carry an event type');

-- Fixture: templates of Northwind, two published and one unpublished.
select pg_temp.as_user('carol');
with x as (insert into app.templates (org_id, name) values (pg_temp.id('org_a'), 'Large Festival Plan') returning id)
  insert into world select 'tpl_large', id from x;
with x as (insert into app.templates (org_id, name) values (pg_temp.id('org_a'), 'Festival Plan') returning id)
  insert into world select 'tpl_default', id from x;
with x as (insert into app.templates (org_id, name) values (pg_temp.id('org_a'), 'Draft Gala Plan') returning id)
  insert into world select 'tpl_draft', id from x;
with x as (insert into app.template_versions (template_id, default_time_zone) values (pg_temp.id('tpl_large'), 'America/New_York') returning id)
  insert into world select 'v_large', id from x;
with x as (insert into app.template_versions (template_id, default_time_zone) values (pg_temp.id('tpl_default'), 'America/New_York') returning id)
  insert into world select 'v_default', id from x;
insert into app.template_versions (template_id) values (pg_temp.id('tpl_draft'));
select app.publish_template_version(pg_temp.id('v_large'));
select app.publish_template_version(pg_temp.id('v_default'));

-- Configuring a type --------------------------------------------------------------------------------------------------------
select lives_ok($$with x as (insert into app.event_types (org_id, name, description, intake_guidance)
  values (pg_temp.id('org_a'), 'Music Festival', 'Outdoor multi-stage weekends.', 'Have the site plan and the capacity ready.')
  returning id) insert into world select 'type_fest', id from x$$, 'a Manager creates an event type');
select throws_ok($$insert into app.event_types (org_id, name) values (pg_temp.id('org_a'), ' music festival')$$,
  '23514', null, 'a name is trimmed');
select throws_ok($$insert into app.event_types (org_id, name) values (pg_temp.id('org_a'), 'music festival')$$,
  '23505', null, 'names are unique in the org, case aside');
select lives_ok($$insert into app.event_type_templates (event_type_id, event_scale, template_id)
  values (pg_temp.id('type_fest'), 'Large', pg_temp.id('tpl_large'))$$, 'a rule for Large with any audience');
select lives_ok($$insert into app.event_type_templates (event_type_id, template_id)
  values (pg_temp.id('type_fest'), pg_temp.id('tpl_default'))$$, 'a default rule for any scale and audience');
select throws_ok($$insert into app.event_type_templates (event_type_id, template_id)
  values (pg_temp.id('type_fest'), pg_temp.id('tpl_large'))$$, '23505', null, 'one rule per band pair, NULLs counted equal');
-- A rule names a live project template of the org: a deleted one is refused, and another org's is not referenced.
with x as (insert into app.templates (org_id, name) values (pg_temp.id('org_a'), 'Old Festival Plan') returning id)
  insert into world select 'tpl_gone', id from x;
update app.templates set deleted_at = now() where id = pg_temp.id('tpl_gone');
select throws_ok($$insert into app.event_type_templates (event_type_id, event_scale, template_id)
  values (pg_temp.id('type_fest'), 'Small', pg_temp.id('tpl_gone'))$$,
  'XR001', 'event_type_template_kind: Choose a live project template.', 'a rule naming a deleted template is refused');
select pg_temp.as_platform();
with x as (insert into app.templates (org_id, name) values (pg_temp.id('org_b'), 'Harbor Plan') returning id)
  insert into world select 'tpl_b', id from x;
select pg_temp.as_user('carol');
select throws_like($$insert into app.event_type_templates (event_type_id, event_scale, template_id)
  values (pg_temp.id('type_fest'), 'Medium', pg_temp.id('tpl_b'))$$,
  'cross_org_reference:%', 'a rule naming another org''s template is refused');
with x as (insert into app.event_types (org_id, name) values (pg_temp.id('org_a'), 'Gala') returning id)
  insert into world select 'type_gala', id from x;
insert into app.event_type_templates (event_type_id, template_id) values (pg_temp.id('type_gala'), pg_temp.id('tpl_draft'));
with x as (insert into app.event_types (org_id, name) values (pg_temp.id('org_a'), 'Conference') returning id)
  insert into world select 'type_conf', id from x;

-- The field set: project fields only.
select pg_temp.as_user('alice');
with x as (insert into app.custom_field_definitions (org_id, target_table, field_key, label, data_type, sort_order)
  values (pg_temp.id('org_a'), 'app.projects', 'capacity', 'Licensed capacity', 'Number', 1) returning id)
  insert into world select 'cfd_capacity', id from x;
with x as (insert into app.custom_field_definitions (org_id, target_table, field_key, label, data_type, sort_order)
  values (pg_temp.id('org_a'), 'app.venues', 'dock_count', 'Docks', 'Number', 1) returning id)
  insert into world select 'cfd_venue', id from x;
select pg_temp.as_user('carol');
select lives_ok($$insert into app.event_type_fields (event_type_id, custom_field_definition_id, required_for_type, required_by_gate)
  values (pg_temp.id('type_fest'), pg_temp.id('cfd_capacity'), true, 1)$$, 'a required project field by gate 1');
select throws_ok($$insert into app.event_type_fields (event_type_id, custom_field_definition_id)
  values (pg_temp.id('type_fest'), pg_temp.id('cfd_venue'))$$,
  'XR001', 'event_type_field_target: Choose a live custom field of projects.', 'a field of another table is refused');

-- A member reads and cannot change.
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.event_types where org_id = pg_temp.id('org_a') and deleted_at is null), 3,
  'a member reads the org''s event types');
select throws_ok($$insert into app.event_types (org_id, name) values (pg_temp.id('org_a'), 'Trade Show')$$,
  '42501', null, 'a member cannot create a type');
update app.event_types set description = 'Changed.' where id = pg_temp.id('type_fest');
select is((select description from app.event_types where id = pg_temp.id('type_fest')), 'Outdoor multi-stage weekends.',
  'a member''s update of a type changes nothing');

-- Template resolution --------------------------------------------------------------------------------------------------------
-- Readers have no usage on schema private, so the resolver is called under the reader's claims as the owner.
select pg_temp.claims('carol');
select is(private.resolve_event_type_template(pg_temp.id('type_fest'), 'Large', null), pg_temp.id('tpl_large'),
  'scale Large with any audience takes the (Large, any) template');
select is(private.resolve_event_type_template(pg_temp.id('type_fest'), 'Large', 'Trade'), pg_temp.id('tpl_large'),
  'a more specific scale beats the default for any audience');
select is(private.resolve_event_type_template(pg_temp.id('type_fest'), 'Small', null), pg_temp.id('tpl_default'),
  'scale Small falls through to the default');
select pg_temp.as_user('carol');
insert into app.event_type_templates (event_type_id, event_scale, event_audience, template_id)
  values (pg_temp.id('type_fest'), 'Large', 'Trade', pg_temp.id('tpl_default'));
select pg_temp.claims('carol');
select is(private.resolve_event_type_template(pg_temp.id('type_fest'), 'Large', 'Trade'), pg_temp.id('tpl_default'),
  '(scale, audience) beats (scale, any)');
select is(private.resolve_event_type_template(pg_temp.id('type_gala'), 'Large', 'Trade'), null,
  'a type whose only template is unpublished resolves to nothing');
select is(private.resolve_event_type_template(pg_temp.id('type_conf'), 'Small', null), null, 'a type with no rules resolves to nothing');
select pg_temp.claims('xavier');
select is(private.resolve_event_type_template(pg_temp.id('type_fest'), 'Large', null), null, 'another org resolves nothing');

-- The project's type and bands ------------------------------------------------------------------------------------------------
-- dave, a Coordinator of NWL with projects.project.write but not projects.settings.write, sets them while none is set.
select pg_temp.as_user('dave');
select lives_ok($$update app.projects set event_type_id = pg_temp.id('type_fest'), event_scale = 'Large', event_audience = 'Public Ticketed'
  where id = pg_temp.id('prj_a')$$, 'the update policy sets a type and bands on a project with none');
select throws_ok($$update app.projects set event_scale = 'Major' where id = pg_temp.id('prj_a')$$,
  'XR001', 'project_event_type_locked: Only someone who may change the project''s settings changes its event type, scale or audience.',
  'changing a band needs projects.settings.write');
select pg_temp.as_user('carol');
update app.projects set event_scale = 'Major' where id = pg_temp.id('prj_a');
select pg_temp.as_platform();
select ok((select e.data -> 'changed' ? 'event_scale' from app.domain_events e
           where e.event_type = 'project.updated' and e.subject_id = pg_temp.id('prj_a') order by e.occurred_at desc, e.id desc limit 1),
  'project.updated names the changed band');

-- Archived and in-use types.
select pg_temp.as_user('carol');
update app.event_types set retired_at = now() where id = pg_temp.id('type_gala');
select throws_ok($$update app.projects set event_type_id = pg_temp.id('type_gala') where id = pg_temp.id('prj_a2')$$,
  'XR001', 'event_type_archived: This event type is archived; choose another.', 'an archived type is not newly set');
select throws_ok($$update app.event_types set deleted_at = now() where id = pg_temp.id('type_fest')$$,
  'XR001', 'event_type_in_use: Archive the event type instead; projects still use it.', 'a type a live project names is not deleted');

select * from finish();
rollback;
