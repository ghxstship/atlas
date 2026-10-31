-- pgTAP: migration 2921, B3 (RRR-227, ADR 0142). The segment library: org-wide policies, a version the database keeps
-- (once per changing statement), at most 100 cues per segment, insertion into a running order (place, renumbering,
-- planned times, department calls, color, the refusals and the 300-cue cap), the instance and cue guards, publishing
-- (Published, Current, Called, Linked and No Instance, no other run touched) and Trash membership.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

create function pg_temp.k(p_key text) returns uuid
language sql stable as $$ select id from k where key = p_key $$;

create function pg_temp.try(p_who text, p_sql text) returns text
language plpgsql as $$
begin
  if p_who = 'platform' then
    perform pg_temp.as_platform();
  else
    perform pg_temp.as_user(p_who);
  end if;
  begin
    execute p_sql;
  exception
    when sqlstate 'XR001' then
      perform pg_temp.as_platform();
      return split_part(sqlerrm, ':', 1);
    when insufficient_privilege then
      perform pg_temp.as_platform();
      return '42501';
  end;
  perform pg_temp.as_platform();
  return 'ok';
end $$;

create function pg_temp.version(p_key text) returns integer
language sql stable as $$ select version from app.segment_library where id = (select id from k where key = p_key) $$;

create function pg_temp.order_of(p_run text) returns text
language sql as $$
  select string_agg(c.label || '@' || c.position, ',' order by c.position)
  from app.cues c where c.run_of_show_id = pg_temp.id(p_run) and c.deleted_at is null
$$;

create function pg_temp.publish(p_library text, p_runs text[]) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user('alice');
  select string_agg(r.outcome, ',' order by r.outcome) into v
  from app.publish_library_segment(pg_temp.k(p_library), array(select pg_temp.id(x) from unnest(p_runs) x)) r;
  perform pg_temp.as_platform();
  return v;
end $$;

-- The library ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.segment_library (org_id, name, description, color_key, version)
  values (pg_temp.id('org_a'), 'Awards Block', 'Three awards and the walk-off.', 'cat-4', 99) returning id)
  insert into k select 'awards', id, null from x;
select pg_temp.as_platform();
select is(pg_temp.version('awards'), 1, 'a new segment starts at version 1, whatever the caller sends');
select is(pg_temp.try('alice', format($$update app.segment_library set name = 'Awards' where id = %L$$, pg_temp.k('awards'))), 'ok', 'renaming');
select is(pg_temp.version('awards'), 2, 'raises the version');
select is(pg_temp.try('alice', format($$update app.segment_library set name = 'Awards', version = 40 where id = %L$$, pg_temp.k('awards'))), 'ok',
  'a write that changes nothing');
select is(pg_temp.version('awards'), 2, 'leaves it, and the caller''s version is ignored');

select pg_temp.as_user('alice');
insert into app.segment_library_cues (segment_library_id, position, label, duration, description) values
  (pg_temp.k('awards'), 1, 'Award One', interval '4 minutes', 'Presenter walks on.'),
  (pg_temp.k('awards'), 2, 'Award Two', null, null),
  (pg_temp.k('awards'), 3, 'Walk-off', interval '1 minute', null);
select pg_temp.as_platform();
insert into k select 'lc' || position, id, null from app.segment_library_cues where segment_library_id = pg_temp.k('awards');
select is(pg_temp.version('awards'), 3, 'three cues in one statement raise it once');
select pg_temp.as_user('alice');
insert into app.segment_library_cue_calls (segment_library_cue_id, call_kind, instruction) values
  (pg_temp.k('lc1'), 'Lighting', 'LX 40 GO'), (pg_temp.k('lc1'), 'Audio', 'Presenter mic live'), (pg_temp.k('lc3'), 'Video', 'Roll outro');
select pg_temp.as_platform();
select is(pg_temp.version('awards'), 4, 'and so do their department calls');

select is(pg_temp.try('gina', format($$update app.segment_library set name = 'Mine' where id = %L$$, pg_temp.k('awards'))), 'ok',
  'a viewer''s update runs');
select is((select name from app.segment_library where id = pg_temp.k('awards')), 'Awards', 'but changes nothing: writing takes show.run_of_show.write org-wide');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.segment_library_cues where segment_library_id = pg_temp.k('awards')), 3, 'every member reads the library');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.segment_library where id = pg_temp.k('awards')), 0, 'another org does not');
select pg_temp.as_platform();

select pg_temp.as_user('alice');
with x as (insert into app.segment_library (org_id, name) values (pg_temp.id('org_a'), 'Long Block') returning id)
  insert into k select 'long', id, null from x;
insert into app.segment_library_cues (segment_library_id, position, label)
select pg_temp.k('long'), g, 'Cue ' || g from generate_series(1, 100) g;
select pg_temp.as_platform();
select is(pg_temp.try('alice', format($$insert into app.segment_library_cues (segment_library_id, position, label) values (%L, 101, 'One more')$$,
  pg_temp.k('long'))), 'segment_library_cue_limit', 'a segment holds at most 100 cues');
select throws_ok(format($$insert into app.segment_library (org_id, name) values (%L, ' awards ')$$, pg_temp.id('org_a')), '23505', null,
  'names are unique in the org, ignoring case and spaces');

-- A running order: q1 called -------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night', '2027-06-05') returning id)
  insert into world select 'ros', id from x;
insert into app.cues (run_of_show_id, position, label) values
  (pg_temp.id('ros'), 1, 'House to Half'), (pg_temp.id('ros'), 2, 'Host Welcome'), (pg_temp.id('ros'), 4, 'Headliner On');
insert into world select 'q' || c.position, c.id from app.cues c where c.run_of_show_id = pg_temp.id('ros');
select app.call_cue(pg_temp.id('q1'));
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Second Night', '2027-06-06') returning id)
  insert into world select 'ros2', id from x;
insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros2'), 1, 'Doors');
select pg_temp.as_platform();

-- Inserting ----------------------------------------------------------------------------------------------------------------------
select is(pg_temp.try('dave', format('select app.insert_library_segment(%L, %L, 1)', pg_temp.id('ros'), pg_temp.k('awards'))),
  'segment_insert_before_called', 'a place at or before the last called cue is refused');
select is(pg_temp.try('gina', format('select app.insert_library_segment(%L, %L)', pg_temp.id('ros'), pg_temp.k('awards'))), '42501',
  'a reader cannot insert a segment');
select is(pg_temp.try('xavier', format('select app.insert_library_segment(%L, %L)', pg_temp.id('ros'), pg_temp.k('awards'))), '42501',
  'nor another org');
select pg_temp.as_user('dave');
insert into k values ('inst', app.insert_library_segment(pg_temp.id('ros'), pg_temp.k('awards'), 3, '2027-06-05 23:30+00'), null);
select pg_temp.as_platform();
select is(pg_temp.order_of('ros'), 'House to Half@1,Host Welcome@2,Award One@3,Award Two@4,Walk-off@5,Headliner On@6',
  'the segment lands before the third cue and the run is renumbered 1..n');
select is((select array_agg(coalesce(to_char(c.planned_at at time zone 'UTC', 'HH24:MI'), '-') order by c.position)
  from app.cues c where c.segment_instance_id = pg_temp.k('inst')), array['23:30', '23:34', '23:34'],
  'planned times follow the start and the durations before them, a missing one counting as none');
select is((select count(*)::int from app.cues c where c.segment_instance_id = pg_temp.k('inst') and c.segment = 'Awards'), 3,
  'the copies take the segment''s name');
select is((select array_agg(k.call_kind::text || ':' || k.instruction order by c.position, k.call_kind)
  from app.cue_calls k join app.cues c on c.id = k.cue_id where c.segment_instance_id = pg_temp.k('inst') and k.deleted_at is null),
  array['Audio:Presenter mic live', 'Lighting:LX 40 GO', 'Video:Roll outro'], 'and the department calls');
select is((select color_key from app.run_segment_colors where run_of_show_id = pg_temp.id('ros') and lower(segment) = 'awards' and deleted_at is null),
  'cat-4', 'the run takes the segment''s color');
select is((select library_version from app.run_segment_instances where id = pg_temp.k('inst')), 4, 'the instance records the version copied');
select is((select description from app.cues where segment_instance_id = pg_temp.k('inst') and position = 3), 'Presenter walks on.',
  'descriptions are copied');

select pg_temp.as_user('dave');
insert into k values ('inst2', app.insert_library_segment(pg_temp.id('ros2'), pg_temp.k('awards')), null);
select pg_temp.as_platform();
select is(pg_temp.order_of('ros2'), 'Doors@1,Award One@2,Award Two@3,Walk-off@4', 'without a place the segment is appended');
select is((select count(*)::int from app.cues where segment_instance_id = pg_temp.k('inst2') and planned_at is not null), 0,
  'and without a start the copies are unplanned');

select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Marathon', '2027-06-07') returning id)
  insert into world select 'ros_big', id from x;
insert into app.cues (run_of_show_id, position, label) select pg_temp.id('ros_big'), g, 'Cue ' || g from generate_series(1, 298) g;
select pg_temp.as_platform();
select is(pg_temp.try('dave', format('select app.insert_library_segment(%L, %L)', pg_temp.id('ros_big'), pg_temp.k('awards'))),
  'segment_insert_cue_limit', 'a run that would pass 300 cues is refused');

-- Guards -------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.try('dave', format($$insert into app.run_segment_instances (run_of_show_id, segment_library_id, library_version) values (%L, %L, 1)$$,
  pg_temp.id('ros'), pg_temp.k('awards'))), '42501', 'members cannot write instances');
select is(pg_temp.try('platform', format($$insert into app.run_segment_instances (run_of_show_id, segment_library_id, library_version) values (%L, %L, 1)$$,
  pg_temp.id('ros'), pg_temp.k('awards'))), 'segment_instance_fixed', 'and even the platform writes them only through the RPCs');
select is(pg_temp.try('dave', format('update app.cues set segment_instance_id = %L where id = %L', pg_temp.k('inst2'), pg_temp.id('q2'))),
  'cue_segment_instance', 'a cue never joins a copy outside the library RPCs');
select is(pg_temp.try('dave', format('update app.cues set segment_instance_id = %L where segment_instance_id = %L and position = 5',
  pg_temp.k('inst2'), pg_temp.k('inst'))), 'cue_segment_instance', 'nor moves to another copy');

-- Publishing ---------------------------------------------------------------------------------------------------------------------
select is(pg_temp.publish('awards', array['ros', 'ros2']), 'Current,Current', 'an instance of the current version answers Current');
select pg_temp.as_user('alice');
update app.segment_library_cues set label = 'Award One (Gold)' where id = pg_temp.k('lc1');
select pg_temp.as_platform();
select is(pg_temp.version('awards'), 5, 'editing a library cue raises the version');
select pg_temp.as_user('dave');
update app.cues set label = 'Local Award Two' where segment_instance_id = pg_temp.k('inst2') and position = 3;
select pg_temp.as_platform();
insert into k values ('ros2_before', null, pg_temp.order_of('ros2'));
select is(pg_temp.publish('awards', array['ros']), 'Published', 'publishing to one run');
select is(pg_temp.order_of('ros'), 'House to Half@1,Host Welcome@2,Award One (Gold)@3,Award Two@4,Walk-off@5,Headliner On@6',
  'replaces the copy in place with the current version');
select is((select count(*)::int from app.cues where segment_instance_id = pg_temp.k('inst') and deleted_at is not null), 3,
  'the old copies are soft-deleted');
select is((select library_version from app.run_segment_instances where id = pg_temp.k('inst')), 5, 'the instance is current');
select is(pg_temp.order_of('ros2'), (select val from k where key = 'ros2_before'), 'a run that was not chosen is untouched');
select is(pg_temp.publish('awards', array['ros2']), 'Published', 'publishing to the other run');
select ok(pg_temp.order_of('ros2') not like '%Local Award Two%', 'replaces its local edit, as the UI warns');

select pg_temp.as_user('alice');
update app.segment_library set description = 'Updated.' where id = pg_temp.k('awards');
select pg_temp.as_platform();
select pg_temp.as_user('dave');
select app.call_cue((select id from app.cues where segment_instance_id = pg_temp.k('inst') and deleted_at is null order by position limit 1));
select pg_temp.as_platform();
insert into k values ('ros_before', null, pg_temp.order_of('ros'));
select is(pg_temp.publish('awards', array['ros']), 'Called', 'an instance with a called cue answers Called');
select is(pg_temp.order_of('ros'), (select val from k where key = 'ros_before'), 'and is left untouched');

select pg_temp.as_platform();
insert into app.engagement_cues (engagement_id, cue_id)
select pg_temp.id('eng_art_a'), c.id from app.cues c where c.segment_instance_id = pg_temp.k('inst2') and c.deleted_at is null order by c.position limit 1;
select is(pg_temp.publish('awards', array['ros2']), 'Linked', 'an instance with an artist''s set time answers Linked');
select is(pg_temp.publish('awards', array['ros_big']), 'No Instance', 'a run without the segment answers No Instance');
update app.engagement_cues set deleted_at = now() where engagement_id = pg_temp.id('eng_art_a');
select pg_temp.as_user('dave');
update app.cues set deleted_at = now() where segment_instance_id = pg_temp.k('inst2');
select pg_temp.as_platform();
select is(pg_temp.publish('awards', array['ros2']), 'No Instance', 'and so does a copy whose cues were all removed, which is not brought back');
select is(pg_temp.try('alice', format('select * from app.publish_library_segment(%L, %L)', pg_temp.k('awards'),
  array(select gen_random_uuid() from generate_series(1, 51)))), 'segment_publish_runs', 'at most 50 runs at a time');
select is(pg_temp.try('gina', format('select * from app.publish_library_segment(%L, %L)', pg_temp.k('awards'), array[pg_temp.id('ros')])),
  '42501', 'publishing needs show.run_of_show.write on every run');

-- Trash ---------------------------------------------------------------------------------------------------------------------------
select ok(exists (select 1 from private.trash_tables where table_name = 'segment_library'), 'a library segment can be restored from Trash');
select ok(not exists (select 1 from private.trash_tables where table_name in ('segment_library_cues', 'segment_library_cue_calls', 'run_segment_instances')),
  'its cues and calls come back with it and stay out of Trash');
select is((select count(*)::int from private.retention_policies where table_name in ('app.segment_library', 'app.segment_library_cues',
  'app.segment_library_cue_calls', 'app.run_segment_instances')), 4, 'every new table has its retention policy');
select ok(exists (select 1 from private.domain_event_types where code = 'segment_library.inserted'), 'inserting is a domain event');
select ok(exists (select 1 from app.domain_events where event_type = 'segment_library.published' and subject_id = pg_temp.k('awards')),
  'and publishing emits one');

select * from finish();
rollback;
