-- pgTAP: saving a day as a template and laying it onto another day (2933, B4 G-42). The preview equals the commit; chosen
-- skips, duplicates and cue items without a running order are reported; overlaps are counted; a round trip from a day
-- to a template to another day reproduces the times; two running orders that day are ambiguous; limits and capability.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(20);

create function pg_temp.new_record(p_kind text, p_title text, p_subtype text default null) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), p_kind, p_subtype, p_title, 'Y', 'Declared') returning id into v;
  return v;
end $$;

create temporary table applied (item_id uuid, item_kind text, name text, action text, refusal_code text, starts_at timestamptz,
  ends_at timestamptz, due_at timestamptz, "overlaps" integer, duplicate_of uuid, created_id uuid);
grant select, insert, delete on applied to public;

-- The source day: 2027-06-05 on Northwind Summer Series (America/New_York), two records and a running order of three
-- cues, the last after midnight.
select pg_temp.as_user('carol');
insert into world values ('rig', pg_temp.new_record('Task', 'Rig the follow spots', 'Execute'));
update app.records set starts_at = '2027-06-05 12:00+00', ends_at = '2027-06-05 14:30+00' where id = pg_temp.id('rig');
insert into world values ('doors', pg_temp.new_record('Milestone', 'Doors Open'));
update app.records set due_at = '2027-06-05 23:00+00', xyz = 'Z' where id = pg_temp.id('doors');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night Running Order', '2027-06-05') returning id)
  insert into world select 'ros', id from x;
insert into app.cues (run_of_show_id, position, label, planned_at, duration, segment) values
  (pg_temp.id('ros'), 1, 'House to Half', '2027-06-06 00:00+00', interval '5 minutes', 'Act I'),
  (pg_temp.id('ros'), 2, 'Headliner On', '2027-06-06 01:30+00', interval '75 minutes', 'Act II'),
  (pg_temp.id('ros'), 3, 'Curfew Lights Up', '2027-06-06 04:15+00', null, null);

insert into world select 'tpl', app.create_day_template_from_day(pg_temp.id('prj_a'), '2027-06-05', 'Opening Night Day');
select is((select count(*)::int from app.day_template_items where day_template_id = pg_temp.id('tpl')), 5,
  'saving the day keeps its two records and three cues');
select is((select string_agg(name || '@' || start_minute || '+' || coalesce(duration_minutes::text, '-'), ', ' order by sort_order)
           from app.day_template_items where day_template_id = pg_temp.id('tpl')),
  'Rig the follow spots@480+150, Doors Open@1140+-, House to Half@1200+5, Headliner On@1290+75, Curfew Lights Up@1455+-',
  'times are minutes from local midnight, past midnight above 1440; a due-only record keeps no length');
select is((select segment from app.day_template_items where day_template_id = pg_temp.id('tpl') and name = 'Headliner On'), 'Act II',
  'a cue keeps its segment''s text');

-- The target day, 2027-06-12, already holds the rigging and its own running order.
insert into world values ('rig2', pg_temp.new_record('Task', 'Rig the follow spots', 'Execute'));
update app.records set starts_at = '2027-06-12 12:00+00', ends_at = '2027-06-12 13:00+00' where id = pg_temp.id('rig2');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Second Night Running Order', '2027-06-12') returning id)
  insert into world select 'ros2', id from x;
insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros2'), 1, 'Preshow Announcement');

insert into applied select * from app.apply_day_template(pg_temp.id('tpl'), pg_temp.id('prj_a'), '2027-06-12',
  p_skip_item_ids => array[(select id from app.day_template_items where day_template_id = (select id from world where key = 'tpl') and name = 'Curfew Lights Up')]);
select is((select string_agg(name || ':' || action, ', ' order by coalesce(starts_at, due_at)) from applied),
  'Rig the follow spots:skip_duplicate, Doors Open:create, House to Half:create, Headliner On:create, Curfew Lights Up:skip_chosen',
  'the dry run tags the duplicate and the unticked item, in time order');
select is((select duplicate_of from applied where name = 'Rig the follow spots'), pg_temp.id('rig2'), 'the duplicate names the record already there');
select is((select "overlaps" from applied where name = 'Rig the follow spots'), 1, 'overlaps counts the day''s records the item meets');
select is((select count(*)::int from app.records where project_id = pg_temp.id('prj_a') and deleted_at is null), 3, 'the dry run writes nothing');
select ok((select bool_and(created_id is null) from applied), 'the dry run returns no created rows');

delete from applied;
insert into applied select * from app.apply_day_template(pg_temp.id('tpl'), pg_temp.id('prj_a'), '2027-06-12',
  p_skip_item_ids => array[(select id from app.day_template_items where day_template_id = (select id from world where key = 'tpl') and name = 'Curfew Lights Up')],
  p_commit => true);
select is((select string_agg(name || ':' || action, ', ' order by coalesce(starts_at, due_at)) from applied),
  'Rig the follow spots:skip_duplicate, Doors Open:create, House to Half:create, Headliner On:create, Curfew Lights Up:skip_chosen',
  'the commit returns what the dry run showed');
select is((select due_at from app.records where id = (select created_id from applied where name = 'Doors Open')),
  '2027-06-12 23:00+00'::timestamptz, 'the round trip reproduces a record''s time on the wall clock');
select is((select row(position, planned_at, duration, segment)::text from app.cues where id = (select created_id from applied where name = 'Headliner On')),
  row(3, '2027-06-13 01:30+00'::timestamptz, interval '75 minutes', 'Act II')::text,
  'cues are appended after the last position, at their minute past midnight, with length and segment');
select is((select row(records_created, cues_created, items_skipped, run_of_show_id = pg_temp.id('ros2'))::text
           from app.day_template_applications where day_template_id = pg_temp.id('tpl')),
  row(1, 2, 2, true)::text, 'one application row records what was created and skipped');

-- Duplicates may be included; cue items without a running order are skipped.
select is((select action from app.apply_day_template(pg_temp.id('tpl'), pg_temp.id('prj_a'), '2027-06-12', p_include_duplicates => true)
           where name = 'Rig the follow spots'), 'create', 'a duplicate is created when duplicates are included');
select is((select string_agg(distinct action, ',') from app.apply_day_template(pg_temp.id('tpl'), pg_temp.id('prj_a'), '2027-06-20')
           where item_kind = 'Cue'), 'skip_no_running_order', 'cue items with no running order that day are skipped');

-- Two running orders that day are two stages: the caller chooses one.
insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Side Stage Running Order', '2027-06-12');
select throws_ok(format('select * from app.apply_day_template(%L, %L, %L)', pg_temp.id('tpl'), pg_temp.id('prj_a'), '2027-06-12'),
  'XR001', 'day_template_run_ambiguous: This day has more than one running order; choose the one the cues join.',
  'two running orders that day refuse an unnamed one');
select lives_ok(format('select * from app.apply_day_template(%L, %L, %L, %L)', pg_temp.id('tpl'), pg_temp.id('prj_a'), '2027-06-12', pg_temp.id('ros2')),
  'naming the running order applies');

-- A cue more than a day out cannot be held.
insert into app.cues (run_of_show_id, position, label, planned_at) values (pg_temp.id('ros'), 4, 'Load Out Call', '2027-06-08 12:00+00');
select throws_ok(format('select app.create_day_template_from_day(%L, %L, %L)', pg_temp.id('prj_a'), '2027-06-05', 'Too Long a Day'),
  'XR001', 'day_template_item_window: Load Out Call starts more than a day from this day or lasts longer than a day, so a day template cannot hold it.',
  'an item outside the template''s window is refused, named');

-- Capabilities.
select pg_temp.as_user('frank');
select throws_ok(format('select app.create_day_template_from_day(%L, %L, %L)', pg_temp.id('prj_a'), '2027-06-20', 'Frank''s Day'),
  '42501', null, 'saving a template needs projects.template.write');
select pg_temp.as_user('xavier');
select throws_ok(format('select * from app.apply_day_template(%L, %L, %L)', pg_temp.id('tpl'), pg_temp.id('prj_a'), '2027-06-12'),
  '42501', null, 'another org cannot apply a template to the project');
select throws_ok(format('select * from app.apply_day_template(%L, %L, %L)', pg_temp.id('tpl'), pg_temp.id('prj_b'), '2027-06-12'),
  'XR001', 'day_template_unknown: Choose a day template of this organization.', 'nor apply this org''s template to its own project');

select * from finish();
rollback;
