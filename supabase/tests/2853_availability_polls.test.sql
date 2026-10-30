-- pgTAP: availability polls (2853, P8, ADR 0063). A planner (crew.shift.write) asks members and an engaged freelancer for
-- their availability; outsiders, past days and days inside the notice period are refused, and each recipient is notified
-- (availability.requested). Recipients answer day by day as blocks on their calendar kept for the org, on project-local
-- day bounds whatever their calendar's zone; re-answering replaces, a locked day comes back unwritten, a closed poll and a
-- non-recipient are refused, and only the RPC tags a block with a poll. Planners read the results, which never show a
-- freelancer's Private blocks that do not answer the poll; a Member with crew.shift.read reads no poll, no recipient reads
-- another's row, and app.rank_shift_candidates ranks a member who answered Available above one who did not. A removed
-- poll is in Trash and is restored; its days and recipients are not.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(40);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Midnight n days from today on the New York calendar, the zone of prj_a.
create function pg_temp.ny_day(p_days integer) returns timestamptz
language sql stable as $$
  select ((now() at time zone 'America/New_York')::date + p_days)::timestamp at time zone 'America/New_York'
$$;
create function pg_temp.ny_date(p_days integer) returns date
language sql stable as $$ select (now() at time zone 'America/New_York')::date + p_days $$;

select has_table('app', 'availability_polls', 'app.availability_polls exists');
select is((select confdeltype::text from pg_catalog.pg_constraint
           where conrelid = 'app.availability_blocks'::regclass and contype = 'f' and confrelid = 'app.availability_polls'::regclass),
  'n', 'a block answering a poll outlives the poll''s purge: its reference is set to null');

-- Sending ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.send_availability_poll((select id from world where key = 'prj_a'), 'Load-in week', array[pg_temp.ny_date(10)],
  array[(select id from world where key = 'frank')])$$, '42501', null, 'a Member without crew.shift.write cannot ask');

select pg_temp.as_user('carol');
select throws_ok($$select app.send_availability_poll((select id from world where key = 'prj_a'), 'Load-in week', array[pg_temp.ny_date(10)],
  array[(select id from world where key = 'frank'), (select id from world where key = 'quinn')])$$, 'XR001',
  'availability_poll_recipient: Quinn Ashby is neither a member of this organization nor engaged by it, so they cannot be asked.',
  'a person with no membership and no open engagement with the org is refused, by name');
select throws_ok($$select app.send_availability_poll((select id from world where key = 'prj_a'), 'Load-in week', array[pg_temp.ny_date(-1)],
  array[(select id from world where key = 'frank')])$$, 'XR001', null, 'a day in the past is refused');
select throws_ok($$select app.send_availability_poll((select id from world where key = 'prj_a'), 'Load-in week',
  (select array_agg(pg_temp.ny_date(n)) from generate_series(10, 42) n), array[(select id from world where key = 'frank')])$$,
  'XR001', 'availability_poll_days: Ask about 1 to 31 different days, none of them in the past.', 'more than 31 days are refused');

insert into k values ('poll', app.send_availability_poll(pg_temp.id('prj_a'), 'Load-in week',
  array[pg_temp.ny_date(3), pg_temp.ny_date(10), pg_temp.ny_date(11), pg_temp.ny_date(12)],
  array[pg_temp.id('frank'), pg_temp.id('ivy')], 'Tell us which days you can work the load-in.'));
select is((select count(*)::int from app.availability_poll_days where availability_poll_id = (select id from k where key = 'poll')), 4,
  'the poll asks about four days');
select is((select created_by from app.availability_polls where id = (select id from k where key = 'poll')), pg_temp.id('carol'),
  'the planner who sent it is its creator');

select pg_temp.as_platform();
select is((select array_agg(recipient_person_id order by recipient_person_id) from app.notifications
           where kind = 'availability.requested' and subject_id = (select id from k where key = 'poll')),
  (select array_agg(x order by x) from unnest(array[pg_temp.id('frank'), pg_temp.id('ivy')]) x),
  'the member and the engaged freelancer are each notified');
select is((select message_args ->> 'gatewayPath' from app.notifications
           where kind = 'availability.requested' and recipient_person_id = pg_temp.id('ivy') and subject_id = (select id from k where key = 'poll')),
  '/profile#availability-requests', 'the notification links Gateway to the requests card');

-- Who reads it -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::int from app.availability_polls), 0, 'a Member with crew.shift.read only reads no poll');
select is((select count(*)::int from app.availability_poll_recipients), 0, 'nor its recipients');
select throws_ok($$select * from app.availability_poll_results((select id from k where key = 'poll'))$$, '42501', null,
  'nor its results');
select throws_ok($$select * from app.answer_availability_poll((select id from k where key = 'poll'), '[]'::jsonb)$$, '42501', null,
  'a non-recipient cannot answer');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.availability_polls), 1, 'a recipient reads the poll addressed to them');
select is((select count(*)::int from app.availability_poll_days), 4, 'and its days');
select is((select array_agg(person_id) from app.availability_poll_recipients), array[pg_temp.id('frank')],
  'but only their own recipient row');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.availability_polls), 0, 'another org reads nothing');

-- Answering ---------------------------------------------------------------------------------------------------------------
-- Frank keeps his calendar for the org in Los Angeles time; the poll's days are New York days.
select pg_temp.as_user('frank');
insert into k values ('frank_cal', app.ensure_member_availability_calendar(pg_temp.id('org_a'), 'America/Los_Angeles'));
select results_eq(
  $$select day, availability_kind::text, written from app.answer_availability_poll((select id from k where key = 'poll'),
    jsonb_build_array(jsonb_build_object('day', pg_temp.ny_date(10), 'kind', 'Available'), jsonb_build_object('day', pg_temp.ny_date(12), 'kind', 'Available')))$$,
  $$values (pg_temp.ny_date(10), 'Available'::text, true), (pg_temp.ny_date(12), 'Available'::text, true)$$,
  'a recipient answers two days');
select results_eq(
  $$select starts_at, ends_at, availability_poll_id from app.availability_blocks
    where availability_calendar_id = (select id from k where key = 'frank_cal') and deleted_at is null order by starts_at$$,
  $$values (pg_temp.ny_day(10), pg_temp.ny_day(11), (select id from k where key = 'poll')), (pg_temp.ny_day(12), pg_temp.ny_day(13), (select id from k where key = 'poll'))$$,
  'each answer is one full project-local day on the calendar kept for the org, tagged with the poll, whatever the calendar''s zone');
select lives_ok($$select * from app.answer_availability_poll((select id from k where key = 'poll'),
  jsonb_build_array(jsonb_build_object('day', pg_temp.ny_date(10), 'kind', 'Tentative')))$$, 're-answering a day');
select is((select string_agg(availability_kind::text || ':' || (deleted_at is null)::text, ',' order by created_at) from app.availability_blocks
           where availability_calendar_id = (select id from k where key = 'frank_cal') and starts_at = pg_temp.ny_day(10)),
  'Available:false,Tentative:true', 'replaces the earlier answer for that day');
select throws_ok($$select * from app.answer_availability_poll((select id from k where key = 'poll'),
  jsonb_build_array(jsonb_build_object('day', pg_temp.ny_date(20), 'kind', 'Available')))$$, 'XR001', null,
  'a day the poll does not ask about is refused');
select throws_ok($$insert into app.availability_blocks (availability_calendar_id, starts_at, ends_at, availability_kind, availability_poll_id)
  values ((select id from k where key = 'frank_cal'), pg_temp.ny_day(11), pg_temp.ny_day(12), 'Available', (select id from k where key = 'poll'))$$,
  'XR001', 'availability_poll_answer: Answer an availability poll from its request.', 'the owner cannot forge a poll answer through their policy');

-- Ivy, a freelancer, keeps a Private calendar for org_a with an Unavailable period that answers no poll.
select pg_temp.as_user('ivy');
with x as (insert into app.availability_calendars (org_id, person_id, time_zone)
  values (pg_temp.id('org_a'), pg_temp.id('ivy'), 'America/New_York') returning id)
insert into k select 'ivy_cal', id from x;
insert into app.availability_blocks (availability_calendar_id, starts_at, ends_at, availability_kind, note)
values ((select id from k where key = 'ivy_cal'), pg_temp.ny_day(11), pg_temp.ny_day(12), 'Unavailable', 'Family wedding');
select results_eq(
  $$select written from app.answer_availability_poll((select id from k where key = 'poll'), jsonb_build_array(jsonb_build_object('day', pg_temp.ny_date(10), 'kind', 'Unavailable')))$$,
  $$values (true)$$, 'the freelancer answers on their calendar kept for the org');
select throws_ok($$update app.availability_blocks set availability_poll_id = (select id from k where key = 'poll')
  where availability_calendar_id = (select id from k where key = 'ivy_cal') and availability_poll_id is null$$,
  'XR001', 'availability_poll_answer: A poll answer stays with its poll.', 'nor tag a period of their own as a poll answer');

-- Results -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select results_eq(
  $$select full_name, day, availability, answered_by_poll from app.availability_poll_results((select id from k where key = 'poll'))
    where day in (pg_temp.ny_date(10), pg_temp.ny_date(11)) order by full_name, day$$,
  $$values ('Frank Adeyemi'::text, pg_temp.ny_date(10), 'Tentative'::text, true), ('Frank Adeyemi'::text, pg_temp.ny_date(11), 'Unstated'::text, false),
    ('Ivy Marchetti'::text, pg_temp.ny_date(10), 'Unavailable'::text, true), ('Ivy Marchetti'::text, pg_temp.ny_date(11), 'Unstated'::text, false)$$,
  'planners read each recipient and day; a freelancer''s Private period that answers no poll reads as Unstated');
select ok((select bool_and(responded_at is not null) from app.availability_poll_results((select id from k where key = 'poll'))),
  'and when each recipient responded, from their answers');

-- A shift inside a New York day Frank answered Available ranks him above Dave, who left it unstated.
with x as (insert into app.shifts (org_id, project_id, starts_at, ends_at, time_zone)
  values (pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.ny_day(12) + interval '10 hours', pg_temp.ny_day(12) + interval '18 hours', 'America/New_York')
  returning id)
insert into k select 'shift', id from x;
select is((select availability from app.rank_shift_candidates((select id from k where key = 'shift')) where person_id = pg_temp.id('frank')),
  'Available', 'the answer reads Available for a shift inside that day, though the calendar is in another zone');
select ok((select (select candidate_rank from app.rank_shift_candidates((select id from k where key = 'shift')) where person_id = pg_temp.id('frank'))
               < (select candidate_rank from app.rank_shift_candidates((select id from k where key = 'shift')) where person_id = pg_temp.id('dave'))),
  'and ranks him above a member who left the day unstated');

-- The notice lock ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.availability_required', 'Organization', pg_temp.id('org_a'), p_value_boolean => true);
select pg_temp.as_user('frank');
select results_eq(
  $$select day, written from app.answer_availability_poll((select id from k where key = 'poll'), jsonb_build_array(jsonb_build_object('day', pg_temp.ny_date(3), 'kind', 'Available')))$$,
  $$values (pg_temp.ny_date(3), false)$$, 'a day inside the notice lock comes back unwritten');
select is((select count(*)::int from app.availability_blocks where availability_calendar_id = (select id from k where key = 'frank_cal') and starts_at = pg_temp.ny_day(3)), 0,
  'and nothing is written for it');
select is((select string_agg(locked::text, ',' order by day) from app.my_availability_requests() where poll_id = (select id from k where key = 'poll')),
  'true,false,false,false', 'the member''s requests show the locked day as locked');
select is((select answer::text from app.my_availability_requests() where poll_id = (select id from k where key = 'poll') and day = pg_temp.ny_date(10)),
  'Tentative', 'and each day''s current answer');
select pg_temp.as_user('carol');
select throws_ok($$select app.send_availability_poll((select id from world where key = 'prj_a'), 'Next week', array[pg_temp.ny_date(3)],
  array[(select id from world where key = 'frank')])$$, 'XR001',
  'availability_poll_inside_notice: Availability for the next 7 days is locked; ask only about days after that.',
  'while availability is required, a day inside the notice period is refused');

-- Closing ------------------------------------------------------------------------------------------------------------------
update app.availability_polls set closes_at = now() - interval '1 minute' where id = (select id from k where key = 'poll');
select pg_temp.as_user('frank');
select throws_ok($$select * from app.answer_availability_poll((select id from k where key = 'poll'),
  jsonb_build_array(jsonb_build_object('day', pg_temp.ny_date(11), 'kind', 'Available')))$$, 'XR001',
  'availability_poll_closed: This poll has closed; tell your planner your availability directly.', 'a closed poll takes no answers');

-- Trash -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
update app.availability_polls set deleted_at = now() where id = (select id from k where key = 'poll');
select is((select title from app.trash_items where subject_id = (select id from k where key = 'poll')), 'Load-in week',
  'a removed poll is in Trash under its title');
select ok(app.restore_trash_item('availability_polls', (select id from k where key = 'poll')) >= 1, 'and the planner restores it');
select pg_temp.as_platform();
select is((select array_agg(table_name::text order by table_name) from private.trash_tables where table_name like 'availability_poll%'),
  array['availability_polls'], 'poll days and recipients, with no title, stay out of Trash');
select throws_ok($$update app.availability_polls set project_id = (select id from world where key = 'prj_a2') where id = (select id from k where key = 'poll')$$,
  'XR001', 'availability_poll_project: A poll stays on its project.', 'a poll stays on its project');

select * from finish();
rollback;
