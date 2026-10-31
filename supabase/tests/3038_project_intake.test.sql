-- pgTAP: the staged intake's save (3038, B14 G-250, G-252, G-262; ADR 0153 C1 and C3). The event type's template for
-- the scale, a chosen template or none; the type and bands set on the new project; Load In and Load Out days saved as
-- B4's project days; a copy from a past project in the same transaction, so a refused copy or a refused step leaves no
-- project. A custom role that creates projects without projects.settings.write still completes intake.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(23);

create function pg_temp.project(p_key text) returns uuid
language sql as $$ select p.id from app.projects p where p.project_key = p_key and p.deleted_at is null $$;

-- Fixture: a Music Festival type whose Large template carries one task, a House Plan template whose version sets every
-- header default, and a hotel block on NWL to copy.
select pg_temp.as_user('carol');
with x as (insert into app.templates (org_id, name) values (pg_temp.id('org_a'), 'Large Festival Plan') returning id)
  insert into world select 'tpl', id from x;
with x as (insert into app.template_versions (template_id, default_time_zone, duration_days) values (pg_temp.id('tpl'), 'America/New_York', 3) returning id)
  insert into world select 'tv', id from x;
insert into app.template_items (template_version_id, item_kind, sort_order, name, record_kind, xyz, due_offset_days)
  values (pg_temp.id('tv'), 'Record', 1, 'Book the stage builder', 'Task', 'Y', -30);
select app.publish_template_version(pg_temp.id('tv'));
with x as (insert into app.templates (org_id, name, description) values (pg_temp.id('org_a'), 'House Plan', 'The house plan.') returning id)
  insert into world select 'tpl_house', id from x;
with x as (insert into app.template_versions (template_id, default_time_zone, default_jurisdiction_id, default_region_code,
    default_tier_code, default_currency_code, duration_days)
  values (pg_temp.id('tpl_house'), 'America/New_York', 'US', 'NA-NE-NYC', '04', 'EUR', 2) returning id)
  insert into world select 'tv_house', id from x;
select app.publish_template_version(pg_temp.id('tv_house'));
with x as (insert into app.event_types (org_id, name) values (pg_temp.id('org_a'), 'Music Festival') returning id)
  insert into world select 'type_fest', id from x;
insert into app.event_type_templates (event_type_id, event_scale, template_id) values (pg_temp.id('type_fest'), 'Large', pg_temp.id('tpl'));
update app.projects set starts_on = '2027-06-01', ends_on = '2027-06-03' where id = pg_temp.id('prj_a');
insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held)
  values (pg_temp.id('prj_a'), 'Crew rooms', '2027-05-31', '2027-06-04', 10);

select has_function('app', 'create_project_from_intake', 'app.create_project_from_intake exists');

-- The event type's template, with its type, bands, show dates and bump days.
select lives_ok($$insert into world select 'p1', app.create_project_from_intake(pg_temp.id('org_a'), 'NWF', 'Northwind Fest 2027',
  'America/New_York', '2027-06-15', '2027-06-16', pg_temp.id('venue_a'), pg_temp.id('type_fest'), 'Large', 'Public Ticketed',
  p_load_in_from => '2027-06-12', p_load_in_to => '2027-06-14', p_load_out_from => '2027-06-17', p_load_out_to => '2027-06-18')$$,
  'intake creates a typed project from the type''s template');
select is((select row(event_type_id, event_scale, event_audience, starts_on, ends_on)::text from app.projects where id = pg_temp.id('p1')),
  row(pg_temp.id('type_fest'), 'Large', 'Public Ticketed', '2027-06-15'::date, '2027-06-16'::date)::text,
  'the project carries the type, the bands and the given last show day');
select is((select string_agg(title, ',') from app.records where project_id = pg_temp.id('p1')), 'Book the stage builder',
  'its records come from the resolved template');
select is((select string_agg(day_type || '@' || day_on, ', ' order by day_on) from app.project_days where project_id = pg_temp.id('p1')),
  'Load In@2027-06-12, Load In@2027-06-13, Load In@2027-06-14, Load Out@2027-06-17, Load Out@2027-06-18',
  'the bump days are saved as project days');

-- Blank, a chosen template, and the choice itself.
select lives_ok($$insert into world select 'p2', app.create_project_from_intake(pg_temp.id('org_a'), 'NWB', 'Northwind Blank',
  'America/New_York', p_template_choice => 'none')$$, 'a blank project needs no type');
select is((select count(*)::integer from app.records where project_id = pg_temp.id('p2')), 0, 'and starts empty');
select lives_ok($$insert into world select 'p3', app.create_project_from_intake(pg_temp.id('org_a'), 'NWT', 'Northwind Templated',
  'America/New_York', '2027-09-01', p_template_choice => 'template', p_template_id => pg_temp.id('tpl'))$$, 'a chosen template is applied');
select is((select ends_on from app.projects where id = pg_temp.id('p3')), '2027-09-03'::date,
  'the template''s duration gives the last show day when none is given');
-- The header fields: on the blank path they go to app.create_project; over a template they replace only the defaults
-- given, and the currency is upper-cased either way.
select lives_ok($$insert into world select 'p6', app.create_project_from_intake(pg_temp.id('org_a'), 'NWJ', 'Northwind Fair',
  'America/New_York', p_template_choice => 'none', p_jurisdiction_id => 'US-FL-MIAMI-DADE', p_region_code => 'NA-SE-MIA',
  p_tier_code => '05', p_currency_code => ' usd ', p_description => 'A two-day fair.')$$, 'a blank intake takes the header fields');
select is((select row(jurisdiction_id, region_code, tier_code, currency::text, description)::text from app.projects where id = pg_temp.id('p6')),
  row('US-FL-MIAMI-DADE', 'NA-SE-MIA', '05', 'USD', 'A two-day fair.')::text, 'the blank project carries them, the currency upper-cased');
select lives_ok($$insert into world select 'p7', app.create_project_from_intake(pg_temp.id('org_a'), 'NWK', 'Northwind House',
  'America/New_York', '2027-08-01', p_template_choice => 'template', p_template_id => pg_temp.id('tpl_house'),
  p_currency_code => 'gbp', p_description => 'Our own words.')$$, 'a templated intake takes some header fields');
select is((select row(jurisdiction_id, region_code, tier_code, currency::text, description)::text from app.projects where id = pg_temp.id('p7')),
  row('US', 'NA-NE-NYC', '04', 'GBP', 'Our own words.')::text,
  'the given currency and description replace the template''s, and its jurisdiction, region and tier stay');
select throws_ok($$select app.create_project_from_intake(pg_temp.id('org_a'), 'NWQ', 'Northwind Q', 'America/New_York',
  p_template_choice => 'copy')$$, '22023', null, 'an unknown template choice is refused');
select throws_like($$select app.create_project_from_intake(pg_temp.id('org_a'), 'NWQ', 'Northwind Q', 'America/New_York',
  p_load_in_from => '2027-06-12')$$, 'project_bump_window_bounds:%', 'a Load In range needs both ends');

-- A copy in the same transaction, and a refused one that leaves no project.
select lives_ok($$insert into world select 'p4', app.create_project_from_intake(pg_temp.id('org_a'), 'NWC', 'Northwind Copy',
  'America/New_York', '2027-06-29', p_template_choice => 'none', p_copy_from_project_id => pg_temp.id('prj_a'),
  p_copy_parts => '{Hotel Blocks}')$$, 'intake copies from a past project');
select is((select row(check_in_on, check_out_on)::text from app.accommodation_blocks where project_id = pg_temp.id('p4')),
  row('2027-06-28'::date, '2027-07-02'::date)::text, 'the copied block moved 28 days');
select throws_like($$select app.create_project_from_intake(pg_temp.id('org_a'), 'NWD', 'Northwind Undated', 'America/New_York',
  p_template_choice => 'none', p_copy_from_project_id => pg_temp.id('prj_a'), p_copy_parts => '{Hotel Blocks}')$$,
  'copy_offset_unknown:%', 'a copy with no show date and no offset is refused');
select is(pg_temp.project('NWD'), null, 'and leaves no project behind');

-- A custom role that creates and writes projects at organization reach, without projects.settings.write.
select pg_temp.as_platform();
insert into app.roles (org_id, code, name, band) values (pg_temp.id('org_a'), 'project_starter', 'Project Starter', 5);
insert into app.role_capabilities (role_id, capability_code, reach)
  select r.id, c.code, 'organization' from app.roles r
  cross join (values ('projects.project.read'), ('projects.project.create'), ('projects.project.write'), ('projects.scope.write'),
    ('work.record.write'), ('projects.members.manage')) c (code)
  where r.code = 'project_starter';
delete from app.membership_roles where membership_id = pg_temp.id('gina@org_a');
insert into app.membership_roles (membership_id, role_id)
  select pg_temp.id('gina@org_a'), r.id from app.roles r where r.code = 'project_starter';
select pg_temp.as_user('gina');
select lives_ok($$insert into world select 'p5', app.create_project_from_intake(pg_temp.id('org_a'), 'NWG', 'Northwind Gina',
  'America/New_York', '2027-10-01', p_event_type_id => pg_temp.id('type_fest'), p_event_scale => 'Small', p_template_choice => 'type')$$,
  'a role with create but not projects.settings.write completes intake with a type');
select lives_ok($$insert into world select 'p8', app.create_project_from_intake(pg_temp.id('org_a'), 'NWM', 'Northwind Gina House',
  'America/New_York', '2027-10-01', p_template_choice => 'template', p_template_id => pg_temp.id('tpl_house'),
  p_tier_code => '03')$$,
  'the same role sets a header field over a template, through t44 and the project guard');
select is((select row(tier_code, currency::text, description)::text from app.projects where id = pg_temp.id('p8')),
  row('03', 'EUR', 'The house plan.')::text, 'the given tier stands, and the template''s currency and description stay');
select throws_ok($$select app.create_project_from_intake(pg_temp.id('org_a'), 'NWH', 'Northwind Bump', 'America/New_York', '2027-10-01',
  p_template_choice => 'none', p_load_in_from => '2027-09-29', p_load_in_to => '2027-09-30')$$,
  '42501', 'schedule.timeline.write is required on the project', 'bump days need schedule.timeline.write, and nothing is left');

select * from finish();
rollback;
