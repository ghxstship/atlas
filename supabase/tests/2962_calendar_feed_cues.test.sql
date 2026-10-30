-- pgTAP: migration 2962 (B7, RRR-231, ADR 0146 decisions 1 and 2; G-50), api_public.calendar_feed with sources,
-- audiences and cues. A legacy feed's event set is unchanged; cues carry their run and label, times, TBC as tentative,
-- and a sequence that rises after app.move_cue, app.shift_cue_plan and a run rename; the show department keeps only
-- cues with its call and carries the instruction; team, department and people audiences filter shifts and records;
-- no cues without show.run_of_show.read; a person feed's cues are api_external.cues; the name is in the meta.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

create function pg_temp.feed(p_key text) returns jsonb
language sql as $$ select api_public.calendar_feed((select val from k where key = p_key)) $$;

create function pg_temp.ids(p_key text, p_kind text default null) returns setof uuid
language sql as $$
  select (e ->> 'id')::uuid from jsonb_array_elements(pg_temp.feed(p_key) -> 'events') e
  where p_kind is null or e ->> 'kind' = p_kind
$$;

create function pg_temp.event(p_key text, p_id uuid) returns jsonb
language sql as $$ select e from jsonb_array_elements(pg_temp.feed(p_key) -> 'events') e where (e ->> 'id')::uuid = p_id $$;

-- The audience scenario of 2961: team_a holds erin; frank holds a Production (5000) role; erin is in the Production group.
select pg_temp.as_platform();
set local session_replication_role = replica;
insert into app.role_assignments (org_id, project_id, role_code, person_id, staffing_basis, assignment_state)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), '5000.50.01', pg_temp.id('frank'), 'Declared', 'Active');
set local session_replication_role = origin;
insert into k (key, id) values ('dept_group', gen_random_uuid());
insert into app.groups (id, org_id, name, group_kind, department_code)
values ((select id from k where key = 'dept_group'), pg_temp.id('org_a'), 'Production crew', 'Department', '5000');
insert into app.group_members (group_id, membership_id) values ((select id from k where key = 'dept_group'), pg_temp.id('erin@org_a'));

-- Shifts of erin, frank (a Production role), dave, and an open Production shift; a meeting assigned to erin, a milestone
-- frank owns, a deadline dave owns, and a TBC meeting.
with s as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone) values
  (pg_temp.id('prj_a'), pg_temp.id('erin@org_a'), '0000.50.01', date_trunc('day', now()) + interval '10 days 12 hours',
   date_trunc('day', now()) + interval '10 days 20 hours', 'America/New_York') returning id)
  insert into world select 'erin_shift', id from s;
with s as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone) values
  (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '5000.50.01', date_trunc('day', now()) + interval '10 days 13 hours',
   date_trunc('day', now()) + interval '10 days 21 hours', 'America/New_York') returning id)
  insert into world select 'frank_shift', id from s;
with s as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone) values
  (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), '0000.50.01', date_trunc('day', now()) + interval '10 days 14 hours',
   date_trunc('day', now()) + interval '10 days 22 hours', 'America/New_York') returning id)
  insert into world select 'dave_shift', id from s;
with s as (insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone) values
  (pg_temp.id('prj_a'), '5000.51.02', date_trunc('day', now()) + interval '10 days 15 hours',
   date_trunc('day', now()) + interval '10 days 23 hours', 'America/New_York') returning id)
  insert into world select 'open_shift', id from s;
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), 'Meeting', 'Lighting focus', 'Y', 'Declared', date_trunc('day', now()) + interval '10 days 16 hours',
    date_trunc('day', now()) + interval '10 days 17 hours', 'America/New_York') returning id)
  insert into world select 'meeting', id from r;
insert into app.record_assignments (record_id, membership_id) values (pg_temp.id('meeting'), pg_temp.id('erin@org_a'));
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, due_at, time_zone, owner_party_id)
  values (pg_temp.id('prj_a'), 'Milestone', 'Rig signed off', 'Y', 'Declared', now() + interval '11 days', 'America/New_York',
    pg_temp.id('frank')) returning id)
  insert into world select 'milestone', id from r;
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, due_at, time_zone, owner_party_id)
  values (pg_temp.id('prj_a'), 'Deadline', 'Advance due', 'Y', 'Declared', now() + interval '12 days', 'America/New_York',
    pg_temp.id('dave')) returning id)
  insert into world select 'deadline', id from r;
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, starts_at, time_zone, owner_party_id, start_tbc)
  values (pg_temp.id('prj_a'), 'Meeting', 'Sponsor walk', 'Y', 'Declared', now() + interval '13 days', 'America/New_York',
    pg_temp.id('dave'), true) returning id)
  insert into world select 'tbc_meeting', id from r;

-- A running order with three cues: a lighting call on the first, a TBC third.
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night', (now() + interval '10 days')::date) returning id)
  insert into world select 'ros', id from x;
insert into app.cues (run_of_show_id, position, label, planned_at, duration)
select pg_temp.id('ros'), v.p, v.label, date_trunc('day', now()) + interval '10 days 23 hours' + make_interval(mins => v.p * 5), v.d
from (values (1, 'House to Half', interval '2 minutes'), (2, 'Walk-in Out', interval '0'), (3, 'Headliner On', null::interval)) v (p, label, d);
insert into world select 'q' || c.position, c.id from app.cues c where c.run_of_show_id = pg_temp.id('ros');
update app.cues set start_tbc = true where id = pg_temp.id('q3');
insert into app.cue_calls (cue_id, call_kind, instruction) values
  (pg_temp.id('q1'), 'Lighting', 'LX 12 go, house to half'), (pg_temp.id('q2'), 'Audio', 'Fade walk-in music');

-- Feeds -----------------------------------------------------------------------------------------------------------------------
insert into k (key, id, val) select 'legacy', calendar_feed_id, feed_token from app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'));
insert into k (key, id, val) select 'cues', calendar_feed_id, feed_token
from app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Show calls', '{Cues}');
insert into k (key, id, val) select 'lx', calendar_feed_id, feed_token
from app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Lighting crew', '{Cues}', p_cue_call_kind => 'Lighting');
insert into k (key, id, val) select 'team', calendar_feed_id, feed_token
from app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Load-in crew', p_team_id => pg_temp.id('team_a'));
insert into k (key, id, val) select 'dept', calendar_feed_id, feed_token
from app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Production', p_department_code => '5000');
insert into k (key, id, val) select 'people', calendar_feed_id, feed_token
from app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Just me', p_person_ids => array[pg_temp.id('dave')]);
select pg_temp.as_anon();

-- A legacy feed is the 4.0 feed --------------------------------------------------------------------------------------------------
select set_eq($$select pg_temp.ids('legacy')$$,
  array[pg_temp.id('erin_shift'), pg_temp.id('frank_shift'), pg_temp.id('dave_shift'), pg_temp.id('open_shift'),
        pg_temp.id('meeting'), pg_temp.id('milestone'), pg_temp.id('deadline'), pg_temp.id('tbc_meeting')],
  'a feed without saved sources serves shifts, meetings, milestones and deadlines, and no cues');
select is(pg_temp.event('legacy', pg_temp.id('tbc_meeting')) ->> 'status', 'tentative', 'P2''s TBC record is still tentative');
select is(pg_temp.event('legacy', pg_temp.id('erin_shift')) -> 'run_id', 'null'::jsonb, 'run_id is null for a shift');
select is(pg_temp.event('legacy', pg_temp.id('meeting')) -> 'call_instruction', 'null'::jsonb, 'call_instruction is null for a record');
select is(pg_temp.feed('cues') -> 'feed' ->> 'name', 'Show calls', 'the feed''s name is in its meta');

-- Cues ---------------------------------------------------------------------------------------------------------------------------
select set_eq($$select pg_temp.ids('cues')$$, array[pg_temp.id('q1'), pg_temp.id('q2'), pg_temp.id('q3')],
  'a Cues feed serves the live cues of the project''s runs and nothing else');
select is(pg_temp.event('cues', pg_temp.id('q1')) ->> 'title', 'House to Half', 'a cue event is titled by its label');
select is(pg_temp.event('cues', pg_temp.id('q1')) ->> 'run_name', 'Opening Night', 'and names its run');
select is(pg_temp.event('cues', pg_temp.id('q1')) ->> 'kind', 'cue', 'its kind is cue');
select pg_temp.as_platform();
select is((pg_temp.event('cues', pg_temp.id('q1')) ->> 'starts_at')::timestamptz, (select planned_at from app.cues where id = pg_temp.id('q1')),
  'it starts at the planned time');
select is((pg_temp.event('cues', pg_temp.id('q1')) ->> 'ends_at')::timestamptz, (select planned_at + duration from app.cues where id = pg_temp.id('q1')),
  'and ends after its duration');
select pg_temp.as_anon();
select is(pg_temp.event('cues', pg_temp.id('q2')) -> 'ends_at', 'null'::jsonb, 'a cue of no length has no end');
select is(pg_temp.event('cues', pg_temp.id('q1')) ->> 'time_zone', 'America/New_York', 'cues are in the project''s zone');
select is(pg_temp.event('cues', pg_temp.id('q3')) ->> 'status', 'tentative', 'a TBC cue is tentative');
select is(pg_temp.event('cues', pg_temp.id('q1')) ->> 'status', 'confirmed', 'any other cue is confirmed');
select is(pg_temp.event('cues', pg_temp.id('q1')) -> 'call_instruction', 'null'::jsonb, 'without a show department a cue carries no call');

select set_eq($$select pg_temp.ids('lx')$$, array[pg_temp.id('q1')], 'a Lighting feed keeps only cues with a Lighting call');
select is(pg_temp.event('lx', pg_temp.id('q1')) ->> 'call_instruction', 'LX 12 go, house to half', 'and carries its instruction');

-- The sequence follows the cue, its run and the filtered call.
select pg_temp.as_platform();
set local session_replication_role = replica;
update app.cues set created_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' where run_of_show_id = pg_temp.id('ros');
update app.run_of_show set updated_at = now() - interval '1 hour' where id = pg_temp.id('ros');
update app.cue_calls set updated_at = now() - interval '1 hour' where cue_id = pg_temp.id('q1');
set local session_replication_role = origin;
select pg_temp.as_anon();
insert into k (key, val) select 'seq_q2', pg_temp.event('cues', pg_temp.id('q2')) ->> 'sequence';
select is((select val from k where key = 'seq_q2'), '0', 'an untouched cue is at sequence 0');
select pg_temp.as_user('dave');
select app.move_cue(pg_temp.id('q2'), 3);
select pg_temp.as_anon();
select ok((pg_temp.event('cues', pg_temp.id('q2')) ->> 'sequence')::int > 0, 'moving a cue raises its sequence');
select is(pg_temp.event('cues', pg_temp.id('q1')) ->> 'sequence', '0', 'a cue the move did not touch keeps its sequence');
select pg_temp.as_user('dave');
select app.shift_cue_plan(pg_temp.id('ros'), 60);
select pg_temp.as_anon();
select ok((pg_temp.event('cues', pg_temp.id('q1')) ->> 'sequence')::int > 0, 'nudging the plan raises the sequence');
select pg_temp.as_platform();
set local session_replication_role = replica;
update app.cues set created_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' where run_of_show_id = pg_temp.id('ros');
set local session_replication_role = origin;
select pg_temp.as_anon();
select is(pg_temp.event('cues', pg_temp.id('q1')) ->> 'sequence', '0', 'after the backdate the cue is untouched again');
select pg_temp.as_user('dave');
update app.run_of_show set name = 'Opening Night (late)' where id = pg_temp.id('ros');
select pg_temp.as_anon();
select ok((pg_temp.event('cues', pg_temp.id('q1')) ->> 'sequence')::int > 0, 'renaming the run raises the sequence');
select is(pg_temp.event('cues', pg_temp.id('q1')) ->> 'run_name', 'Opening Night (late)', 'and the event names the new run');

-- Audiences -----------------------------------------------------------------------------------------------------------------------
select set_eq($$select pg_temp.ids('team')$$, array[pg_temp.id('erin_shift'), pg_temp.id('meeting')],
  'a team feed serves its members'' shifts and the records assigned to them');
select set_eq($$select pg_temp.ids('dept')$$,
  array[pg_temp.id('erin_shift'), pg_temp.id('frank_shift'), pg_temp.id('open_shift'), pg_temp.id('meeting'), pg_temp.id('milestone')],
  'a department feed serves its members'' shifts, open shifts in its roles, and its members'' records');
select set_eq($$select pg_temp.ids('people')$$, array[pg_temp.id('dave_shift'), pg_temp.id('deadline'), pg_temp.id('tbc_meeting')],
  'a people feed serves those people''s shifts and owned records');

-- Never wider than the owner's reach: frank (field) reads only his own shift, so a team filter cannot show him erin's.
select pg_temp.as_user('frank');
insert into k (key, id, val) select 'frank_team', calendar_feed_id, feed_token
from app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'), 'My crew', '{Shifts}', p_team_id => pg_temp.id('team_a'));
select pg_temp.as_anon();
select is_empty($$select pg_temp.ids('frank_team')$$, 'an audience never shows a shift the owner could not see without it');

-- No cues without show.run_of_show.read -----------------------------------------------------------------------------------------------
select pg_temp.as_platform();
update app.project_members set deleted_at = now() where project_id = pg_temp.id('prj_a') and membership_id = pg_temp.id('dave@org_a');
select pg_temp.as_anon();
select is_empty($$select pg_temp.ids('cues')$$, 'an owner who no longer reads the run of show gets no cue events');
select pg_temp.as_platform();
update app.project_members set deleted_at = null where project_id = pg_temp.id('prj_a') and membership_id = pg_temp.id('dave@org_a');

-- A person feed's cues are api_external.cues --------------------------------------------------------------------------------------------
insert into app.engagement_cues (engagement_id, cue_id) values (pg_temp.id('eng_art_a'), pg_temp.id('q3'));
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.as_user('art');
insert into k (key, id, val) select 'art', calendar_feed_id, feed_token from app.create_person_calendar_feed('My sets', '{Cues}');
insert into k (key, id, val) select 'art_default', calendar_feed_id, feed_token from app.create_person_calendar_feed();
insert into k (key, val) select 'art_view', string_agg(id::text, ',' order by id) from api_external.cues;
select pg_temp.as_anon();
select is((select string_agg(x::text, ',' order by x) from pg_temp.ids('art', 'cue') x), (select val from k where key = 'art_view'),
  'an artist''s person feed shows exactly the cues Gateway shows them');
select set_eq($$select pg_temp.ids('art')$$, array[pg_temp.id('q3')], 'their own set time');
select is(pg_temp.event('art', pg_temp.id('q3')) -> 'call_instruction', 'null'::jsonb, 'with no department call');
select is(pg_temp.feed('art') -> 'feed' ->> 'name', 'My sets', 'a person feed carries its name');
select is_empty($$select pg_temp.ids('art_default', 'cue')$$, 'a person feed without Cues serves no cues');

select * from finish();
rollback;
