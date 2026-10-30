-- pgTAP: project days (2930, B4 G-38). Read with schedule.timeline.read and written with schedule.timeline.write; split
-- days of up to four segments with a unique place each; the zone, Show node and venue rules; a day that never changes
-- project; and Trash registration.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(18);

select has_table('app', 'project_days', 'app.project_days exists');
select enum_has_labels('app', 'project_day_type', array['Load In', 'Show', 'Load Out', 'Travel', 'Off', 'Rehearsal', 'Other'],
  'the seven day types, in order');

-- carol (manager) plans Northwind Summer Series: Load In on Nov 12, Show on Nov 13, and Nov 14 split into a Load Out
-- and Travel to Austin in another zone.
select pg_temp.as_user('carol');
select lives_ok($$
  insert into app.project_days (project_id, day_on, day_type, venue_id) values
    ((select id from world where key = 'prj_a'), '2027-11-12', 'Load In', (select id from world where key = 'venue_a'));
  insert into app.project_days (project_id, day_on, day_type, scope_node_id) values
    ((select id from world where key = 'prj_a'), '2027-11-13', 'Show', (select id from world where key = 'show_a'));
  insert into app.project_days (project_id, day_on, day_type, sort_order, venue_id) values
    ((select id from world where key = 'prj_a'), '2027-11-14', 'Load Out', 1, (select id from world where key = 'venue_a'));
  insert into app.project_days (project_id, day_on, day_type, sort_order, label, location_text, time_zone) values
    ((select id from world where key = 'prj_a'), '2027-11-14', 'Travel', 2, 'Travel to Austin', 'Austin, Texas', 'America/Chicago')
$$, 'a schedule.timeline.write holder saves a Load In, a Show and a split day');
select is((select count(*)::int from app.project_days where project_id = pg_temp.id('prj_a') and deleted_at is null), 4,
  'four segments on three dates');
select is((select org_id from app.project_days where project_id = pg_temp.id('prj_a') limit 1), pg_temp.id('org_a'),
  'org_id is derived from the project');

select throws_ok($$insert into app.project_days (project_id, day_on, day_type, sort_order) values
  ((select id from world where key = 'prj_a'), '2027-11-14', 'Off', 2)$$,
  '23505', null, 'two segments cannot share a place on one date');
insert into app.project_days (project_id, day_on, day_type, sort_order) values
  (pg_temp.id('prj_a'), '2027-11-14', 'Other', 3), (pg_temp.id('prj_a'), '2027-11-14', 'Off', 4);
select throws_ok($$insert into app.project_days (project_id, day_on, day_type, sort_order) values
  ((select id from world where key = 'prj_a'), '2027-11-14', 'Rehearsal', 4)$$,
  'XR001', 'project_day_split_limit: A day splits into at most four segments; change or remove one first.',
  'a fifth segment on one date is refused');

-- Zones, nodes and venues.
select throws_ok($$insert into app.project_days (project_id, day_on, day_type, time_zone) values
  ((select id from world where key = 'prj_a'), '2027-11-20', 'Off', 'Mars/Olympus_Mons')$$,
  'XR001', null, 'an unknown time zone is refused');
select throws_ok($$insert into app.project_days (project_id, day_on, day_type, venue_id, time_zone) values
  ((select id from world where key = 'prj_a'), '2027-11-20', 'Off', (select id from world where key = 'venue_a'), 'America/Chicago')$$,
  '23514', null, 'a segment at a venue takes the venue''s zone, so none is stored');
select throws_ok($$insert into app.project_days (project_id, day_on, day_type, scope_node_id, time_zone) values
  ((select id from world where key = 'prj_a'), '2027-11-20', 'Show', (select id from world where key = 'show_a'), 'America/Chicago')$$,
  'XR001', 'project_day_time_zone: This show''s venue sets the time zone; leave the time zone empty.',
  'a Show node with a venue sets the zone');
select throws_ok($$insert into app.project_days (project_id, day_on, day_type, scope_node_id) values
  ((select id from world where key = 'prj_a'), '2027-11-20', 'Show', (select id from world where key = 'root_a'))$$,
  'XR001', 'project_day_scope_kind: A day serves a Show node of the project; choose a show, or leave it for the whole project.',
  'only a Show node is accepted');
select throws_ok($$insert into app.project_days (project_id, day_on, day_type, scope_node_id) values
  ((select id from world where key = 'prj_a2'), '2027-11-20', 'Show', (select id from world where key = 'show_a'))$$,
  'XR001', null, 'a Show node of another project is refused');

-- Dates move as edits; the project never changes.
select lives_ok($$update app.project_days set day_on = '2027-11-11' where project_id = (select id from world where key = 'prj_a')
  and day_type = 'Load In'$$, 'a schedule.timeline.write holder moves a day to another date');
select throws_ok($$update app.project_days set project_id = (select id from world where key = 'prj_a2')
  where project_id = (select id from world where key = 'prj_a') and day_type = 'Load In'$$,
  'XR001', 'project_day_project_immutable: A day stays in its project; add the day to the other project instead.',
  'a project change is refused');

-- gina (viewer) on the project's Field crew reads the days and writes none; another org sees none.
select pg_temp.as_user('alice');
insert into app.project_members (project_id, membership_id, project_role) values (pg_temp.id('prj_a'), pg_temp.id('gina@org_a'), 'Field');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.project_days where project_id = pg_temp.id('prj_a')), 6,
  'a holder of schedule.timeline.read reads the days');
select is_empty($$update app.project_days set label = 'Moved' where project_id = (select id from world where key = 'prj_a') returning id$$,
  'a holder of schedule.timeline.read changes no day (row level security)');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.project_days where project_id = pg_temp.id('prj_a')), 0, 'another org reads no day');

select pg_temp.as_platform();
select ok(exists (select 1 from private.trash_tables t where t.table_name = 'project_days' and t.title_column = 'label'),
  'a deleted day is undone from Trash, titled by its label (ADR 0110)');

select * from finish();
rollback;
