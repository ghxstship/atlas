-- pgTAP: day templates (2932, B4 G-42). Read by the org and written with projects.template.write; Record items in their
-- kind's title grammar with a kind and an XYZ tag, Cue items without them; 500 items at most; applications append-only
-- and written only with schedule.timeline.write on the project.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(14);

select has_table('app', 'day_templates', 'app.day_templates exists');
select has_table('app', 'day_template_items', 'app.day_template_items exists');
select has_table('app', 'day_template_applications', 'app.day_template_applications exists');

select pg_temp.as_user('carol');
with x as (insert into app.day_templates (org_id, name, day_type) values (pg_temp.id('org_a'), 'Festival Show Day', 'Show') returning id)
  insert into world select 'tpl', id from x;
select lives_ok($$insert into app.day_template_items (day_template_id, item_kind, sort_order, name, record_kind, xyz, start_minute, duration_minutes)
  values ((select id from world where key = 'tpl'), 'Record', 1, 'Rig the follow spots', 'Task', 'Y', 480, 120)$$,
  'a projects.template.write holder adds a Record item');
select lives_ok($$insert into app.day_template_items (day_template_id, item_kind, sort_order, name, start_minute, duration_minutes, segment)
  values ((select id from world where key = 'tpl'), 'Cue', 2, 'Headliner On', 1290, 75, 'Act II')$$,
  'and a Cue item with a segment');
select throws_ok($$insert into app.day_template_items (day_template_id, item_kind, sort_order, name, record_kind, xyz, start_minute)
  values ((select id from world where key = 'tpl'), 'Record', 3, 'Installing the truss', 'Task', 'Y', 420)$$,
  'XR001', null, 'a Record item''s name follows its kind''s title grammar (day_template_title)');
select throws_ok($$insert into app.day_template_items (day_template_id, item_kind, sort_order, name, start_minute)
  values ((select id from world where key = 'tpl'), 'Record', 3, 'Rig the truss', 420)$$,
  '23514', null, 'a Record item has a kind and an XYZ tag');
select throws_ok($$insert into app.day_template_items (day_template_id, item_kind, sort_order, name, record_kind, xyz, start_minute)
  values ((select id from world where key = 'tpl'), 'Cue', 3, 'House to Half', 'Task', 'Y', 1260)$$,
  '23514', null, 'a Cue item has no kind or XYZ tag');
select throws_ok($$insert into app.day_template_items (day_template_id, item_kind, sort_order, name, start_minute)
  values ((select id from world where key = 'tpl'), 'Cue', 3, 'House to Half', 2880)$$,
  '23514', null, 'an item starts within the day before to the night after (-1440 to 2879 minutes)');

-- 500 items at most.
select pg_temp.as_platform();
insert into app.day_template_items (org_id, day_template_id, item_kind, sort_order, name, start_minute)
select pg_temp.id('org_a'), pg_temp.id('tpl'), 'Cue', g, 'Cue ' || g, g from generate_series(3, 500) g;
select pg_temp.as_user('carol');
select throws_ok($$insert into app.day_template_items (day_template_id, item_kind, sort_order, name, start_minute)
  values ((select id from world where key = 'tpl'), 'Cue', 500, 'One Too Many', 10)$$,
  'XR001', 'day_template_too_large: A day template holds at most 500 items; remove one first.',
  'a template holds at most 500 live items');

-- Org reads, writes by capability.
select pg_temp.as_user('frank');
select is((select count(*)::int from app.day_templates where id = pg_temp.id('tpl')), 1, 'every member of the org reads its day templates');
select is_empty($$update app.day_templates set name = 'Renamed' where id = (select id from world where key = 'tpl') returning id$$,
  'a member without projects.template.write changes none');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.day_templates where id = pg_temp.id('tpl')), 0, 'another org reads none');

-- Applications are append-only.
select pg_temp.as_user('carol');
insert into app.day_template_applications (day_template_id, project_id, day_on, records_created)
  values (pg_temp.id('tpl'), pg_temp.id('prj_a'), '2027-06-01', 1);
select throws_ok($$update app.day_template_applications set records_created = 2 where day_template_id = (select id from world where key = 'tpl')$$,
  'XR001', null, 'an application never changes');

select * from finish();
rollback;
