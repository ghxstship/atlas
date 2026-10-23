-- pgTAP: migration 1600, the record's key in every notification about a record (RRR-125). An assignment, a mention or
-- a comment on a record, and an automation notice about a record event, carry recordKey ({project_key}-{record_number},
-- as app.record_display_key reads it) beside the arguments they carried before, so the Inbox opens the record; a
-- mention, a comment or a notice about any other subject carries none. Each emitter still tells the same people.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(16);

-- The latest notification of a kind to a person about a subject, and how many they got.
create function pg_temp.note(p_person text, p_kind text, p_subject uuid) returns app.notifications
language sql as $$
  select n.* from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_person) and n.kind = p_kind and n.subject_id = p_subject
  order by n.created_at desc, n.id desc limit 1
$$;
create function pg_temp.notes(p_kind text, p_subject uuid) returns text
language sql as $$
  select coalesce(string_agg(p.full_name, ',' order by p.full_name), '') from app.notifications n
  join app.people p on p.id = n.recipient_person_id
  where n.kind = p_kind and n.subject_id = p_subject
$$;
create function pg_temp.display_key(p_record uuid) returns text
language sql as $$
  select app.record_display_key(r) from app.records r where r.id = p_record
$$;

select pg_temp.as_platform();
with r as (insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Execute', 'Hang the downstage truss', 'Y', 'Declared') returning id)
  insert into world select 'task', id from r;

-- The key -------------------------------------------------------------------------------------------------------------
select is(private.record_key(pg_temp.id('task')), pg_temp.display_key(pg_temp.id('task')),
  'a record''s key is its display key');
select matches(private.record_key(pg_temp.id('task')), '^NWL-[1-9][0-9]*$', 'its project key and record number');
select is(private.record_key(gen_random_uuid()), null, 'an id no record has has no key');
select ok(not has_function_privilege('authenticated', 'private.record_key(uuid)', 'execute'), 'only definer code reads it');

-- assignment.created (1394) -------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.record_assignments (record_id, membership_id) values
  (pg_temp.id('task'), pg_temp.id('frank@org_a')),
  (pg_temp.id('task'), pg_temp.id('carol@org_a'));
select pg_temp.as_platform();
select is((pg_temp.note('frank', 'assignment.created', pg_temp.id('task'))).message_args,
  jsonb_build_object('title', 'Hang the downstage truss', 'actorName', 'Carol Nguyen', 'recordKey', pg_temp.display_key(pg_temp.id('task'))),
  'an assignment carries the record''s key beside its title and actor');
select is(pg_temp.notes('assignment.created', pg_temp.id('task')), 'Frank Adeyemi',
  'and tells the member assigned, not the person who assigned themselves');

-- mention.created and comment.created on a record (0580) ------------------------------------------------------------
select pg_temp.as_user('dave');
select app.post_comment('app.records', pg_temp.id('task'), 'Truss arrives at 06:00.', array[pg_temp.id('erin')]);
set constraints all immediate;
set constraints all deferred;
select pg_temp.as_user('erin');
select app.post_comment('app.records', pg_temp.id('task'), 'Crew booked for 06:00.');
set constraints all immediate;
set constraints all deferred;
select pg_temp.as_platform();
select is((pg_temp.note('erin', 'mention.created', pg_temp.id('task'))).message_args,
  jsonb_build_object('actorName', 'Dave Lindqvist', 'title', 'Hang the downstage truss', 'recordKey', pg_temp.display_key(pg_temp.id('task'))),
  'a mention on a record carries its key');
select is(pg_temp.notes('mention.created', pg_temp.id('task')), 'Erin Castillo', 'and tells only the person mentioned');
select is((pg_temp.note('dave', 'comment.created', pg_temp.id('task'))).message_args,
  jsonb_build_object('actorName', 'Erin Castillo', 'title', 'Hang the downstage truss', 'recordKey', pg_temp.display_key(pg_temp.id('task'))),
  'a comment on a record carries its key');
select is(pg_temp.notes('comment.created', pg_temp.id('task')), 'Dave Lindqvist',
  'and tells the other subscribers, never a comment''s author or the person it mentions');

-- mention.created and comment.created on another subject carry no key -----------------------------------------------
select pg_temp.as_user('dave');
select app.post_comment('app.projects', pg_temp.id('prj_a'), 'Load-in moves to 07:00.', array[pg_temp.id('frank')]);
set constraints all immediate;
set constraints all deferred;
select pg_temp.as_user('erin');
select app.post_comment('app.projects', pg_temp.id('prj_a'), 'Crew briefed.');
set constraints all immediate;
set constraints all deferred;
select pg_temp.as_platform();
select is((pg_temp.note('frank', 'mention.created', pg_temp.id('prj_a'))).message_args,
  jsonb_build_object('actorName', 'Dave Lindqvist', 'title', 'Northwind Summer Series'),
  'a mention on a project carries no record key');
select is((pg_temp.note('dave', 'comment.created', pg_temp.id('prj_a'))).message_args,
  jsonb_build_object('actorName', 'Erin Castillo', 'title', 'Northwind Summer Series'),
  'nor does a comment on it');
select is(pg_temp.notes('mention.created', pg_temp.id('prj_a')) || '|' || pg_temp.notes('comment.created', pg_temp.id('prj_a')),
  'Frank Adeyemi|Dave Lindqvist,Frank Adeyemi', 'which tell the same people: the person mentioned, then every other subscriber');

-- automation.notice (1481) --------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
insert into world values ('auto', app.save_automation(pg_temp.id('org_a'), null, 'Pick up tasks', null, 'record.created',
  '{"all": [{"field": "data.record_kind", "operator": "eq", "value": "Task"}]}',
  jsonb_build_array(jsonb_build_object('type', 'notify', 'recipient_person_id', pg_temp.id('carol'), 'title', 'New task')), true));
select pg_temp.as_user('alice');
with r as (insert into app.records (project_id, scope_node_id, record_kind, title, phase_code, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), pg_temp.id('root_a'), 'Task', 'Confirm the caterer', 'SCP', 'Y', 'Declared') returning id)
  insert into world select 'task2', id from r;
select pg_temp.as_platform();
insert into world select 'run', r.id from app.automation_runs r
  where r.automation_id = pg_temp.id('auto') and r.event_payload -> 'subject' ->> 'id' = pg_temp.id('task2')::text;
select app.begin_automation_run(pg_temp.id('run'),
  (select j.id from app.claim_jobs('pgtap-worker', 'automation.run', 100) j where j.subject_id = pg_temp.id('run')));
select pg_temp.as_user('bob');
insert into world values ('notice', app.send_automation_notice(pg_temp.id('run'), pg_temp.id('carol'), 'New task: Confirm the caterer'));
select pg_temp.as_platform();
select is((select concat_ws('|', n.recipient_person_id = pg_temp.id('carol'), n.subject_table, n.subject_id = pg_temp.id('task2'), n.message_args::text)
  from app.notifications n where n.id = pg_temp.id('notice')),
  concat_ws('|', true, 'records', true, jsonb_build_object('automationName', 'Pick up tasks', 'title', 'New task: Confirm the caterer',
    'body', 'New task: Confirm the caterer', 'actorName', 'Bob Okafor', 'recordKey', pg_temp.display_key(pg_temp.id('task2')))::text),
  'a notice about a record event carries the record''s key, to the member it names');

-- The same run, as if its event were about a project: the notice carries no key.
update app.automation_runs set event_payload = event_payload || jsonb_build_object('subject',
  jsonb_build_object('table', 'projects', 'id', pg_temp.id('prj_a')))
where id = pg_temp.id('run');
select pg_temp.as_user('bob');
insert into world values ('notice2', app.send_automation_notice(pg_temp.id('run'), pg_temp.id('carol'), 'New task: Confirm the caterer'));
select pg_temp.as_platform();
select is((select concat_ws('|', n.subject_table, n.message_args ? 'recordKey') from app.notifications n where n.id = pg_temp.id('notice2')),
  'projects|f', 'a notice about any other subject carries none');

-- Inbox items read the key ------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select i.message_args ->> 'recordKey' from app.inbox_items i
  where i.kind = 'assignment.created' and i.subject_id = pg_temp.id('task')), pg_temp.display_key(pg_temp.id('task')),
  'the assignee''s Inbox item carries the key it opens the record by');

select * from finish();
rollback;
