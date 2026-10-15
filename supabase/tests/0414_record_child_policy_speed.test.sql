-- pgTAP: the faster punch_items and record_watchers policies (0414) give every role exactly the rows
-- the previous record_ids_with expressions gave, for reads and for writes.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(22);

-- Fixture: punch items and watchers on records of a member project (NWL), a project without members
-- (NWX) where one record is assigned to frank, and another org's project (HLP).
select pg_temp.as_platform();
create function pg_temp.task(p_project text, p_title text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id(p_project), 'Task', 'Execute', p_title, 'Y', 'Declared') returning id into v;
  return v;
end $$;
insert into world values ('t_a', pg_temp.task('prj_a', 'Correct the handrail'));
insert into world values ('t_a2', pg_temp.task('prj_a2', 'Correct the exit sign'));
insert into world values ('t_a2_assigned', pg_temp.task('prj_a2', 'Correct the ramp'));
insert into world values ('t_b', pg_temp.task('prj_b', 'Correct the gate'));
insert into app.record_assignments (record_id, membership_id) values (pg_temp.id('t_a2_assigned'), pg_temp.id('frank@org_a'));
insert into app.punch_items (record_id) select id from app.records where id in (pg_temp.id('t_a'), pg_temp.id('t_a2'), pg_temp.id('t_a2_assigned'), pg_temp.id('t_b'));
insert into app.record_watchers (record_id, person_id)
select r.id, p.id from app.records r cross join app.people p
where r.id in (pg_temp.id('t_a'), pg_temp.id('t_a2'), pg_temp.id('t_a2_assigned'), pg_temp.id('t_b'))
  and p.id in (pg_temp.id('dave'), pg_temp.id('frank'), pg_temp.id('xavier'));

-- Rows each person sees under the policies, and rows the previous expressions allowed.
create function pg_temp.visible(p_user text, p_table text) returns uuid[]
language plpgsql as $$
declare v uuid[];
begin
  perform pg_temp.as_user(p_user);
  execute format('select coalesce(array_agg(id order by id), ''{}'') from app.%I', p_table) into v;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.previous_read(p_user text, p_table text) returns uuid[]
language plpgsql as $$
declare v uuid[];
begin
  perform pg_temp.claims(p_user);
  execute format('select coalesce(array_agg(id order by id), ''{}'') from app.%I where record_id in (select private.record_ids_with(''work.record.read''))', p_table) into v;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.punch_writable(p_user text, p_new boolean) returns uuid[]
language plpgsql as $$
declare v uuid[];
begin
  perform pg_temp.claims(p_user);
  if p_new then
    select coalesce(array_agg(p.id order by p.id), '{}') into v from app.punch_items p
    where exists (select 1 from app.records r where r.id = p.record_id
      and r.project_id = any (array(select private.project_ids_with('work.punch_list.write'))));
  else
    select coalesce(array_agg(p.id order by p.id), '{}') into v from app.punch_items p
    where p.record_id in (select r.id from app.records r where r.project_id in (select private.project_ids_with('work.punch_list.write')));
  end if;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.watch_writable(p_user text, p_new boolean) returns uuid[]
language plpgsql as $$
declare v uuid[];
begin
  perform pg_temp.claims(p_user);
  if p_new then
    select coalesce(array_agg(w.id order by w.id), '{}') into v from app.record_watchers w
    where private.can_watch_record(w.org_id, w.record_id, w.person_id);
  else
    select coalesce(array_agg(w.id order by w.id), '{}') into v from app.record_watchers w
    where w.record_id in (select private.record_ids_with('work.record.read'))
      and (w.person_id = private.current_person_id() or w.record_id in (select private.record_ids_with('work.record.write')));
  end if;
  perform pg_temp.as_platform();
  return v;
end $$;

select is(pg_temp.visible('alice', 'punch_items'), pg_temp.previous_read('alice', 'punch_items'), 'the Owner reads the same punch items');
select is(pg_temp.visible('carol', 'punch_items'), pg_temp.previous_read('carol', 'punch_items'), 'the Manager reads the same punch items');
select is(pg_temp.visible('dave', 'punch_items'), pg_temp.previous_read('dave', 'punch_items'), 'a Member reads the same punch items');
select is(pg_temp.visible('erin', 'punch_items'), pg_temp.previous_read('erin', 'punch_items'), 'a Collaborator reads the same punch items');
select is(pg_temp.visible('frank', 'punch_items'), pg_temp.previous_read('frank', 'punch_items'), 'a Field member reads the same punch items, including the assigned one');
select is(pg_temp.visible('gina', 'punch_items'), pg_temp.previous_read('gina', 'punch_items'), 'a Viewer reads the same punch items');
select is(pg_temp.visible('xavier', 'punch_items'), pg_temp.previous_read('xavier', 'punch_items'), 'another org reads the same punch items');
select ok(cardinality(pg_temp.visible('frank', 'punch_items')) >= 2, 'the comparison covers rows a person does see');

select is(pg_temp.visible('alice', 'record_watchers'), pg_temp.previous_read('alice', 'record_watchers'), 'the Owner reads the same watchers');
select is(pg_temp.visible('carol', 'record_watchers'), pg_temp.previous_read('carol', 'record_watchers'), 'the Manager reads the same watchers');
select is(pg_temp.visible('dave', 'record_watchers'), pg_temp.previous_read('dave', 'record_watchers'), 'a Member reads the same watchers');
select is(pg_temp.visible('frank', 'record_watchers'), pg_temp.previous_read('frank', 'record_watchers'), 'a Field member reads the same watchers');
select is(pg_temp.visible('gina', 'record_watchers'), pg_temp.previous_read('gina', 'record_watchers'), 'a Viewer reads the same watchers');
select is(pg_temp.visible('xavier', 'record_watchers'), pg_temp.previous_read('xavier', 'record_watchers'), 'another org reads the same watchers');

select is(pg_temp.punch_writable('carol', true), pg_temp.punch_writable('carol', false), 'the Manager may write the same punch items');
select is(pg_temp.punch_writable('dave', true), pg_temp.punch_writable('dave', false), 'a Member may write the same punch items');
select is(pg_temp.punch_writable('frank', true), pg_temp.punch_writable('frank', false), 'a Field member may write the same punch items');
select is(pg_temp.punch_writable('gina', true), pg_temp.punch_writable('gina', false), 'a Viewer may write the same punch items');

select is(pg_temp.watch_writable('alice', true), pg_temp.watch_writable('alice', false), 'the Owner may write the same watchers');
select is(pg_temp.watch_writable('dave', true), pg_temp.watch_writable('dave', false), 'a Member may write the same watchers');
select is(pg_temp.watch_writable('frank', true), pg_temp.watch_writable('frank', false), 'a Field member may write the same watchers');
select is(pg_temp.watch_writable('gina', true), pg_temp.watch_writable('gina', false), 'a Viewer may write the same watchers');

select * from finish();
rollback;
