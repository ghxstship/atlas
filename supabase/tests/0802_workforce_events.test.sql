-- pgTAP: briefings, crew calls and meetings with RSVP and check-in (A29, Section 4.9 Events).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(28);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Scheduling ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select throws_ok($$insert into app.workforce_events (org_id, organizer_membership_id, event_kind, title, starts_at, ends_at)
  values (pg_temp.id('org_a'), pg_temp.id('frank@org_a'), 'Briefing', 'Org briefing', now(), now() + interval '1 hour')$$,
  '42501', null, 'a field member cannot schedule an org-wide event');

select pg_temp.as_user('dave');
select throws_ok($$insert into app.workforce_events (org_id, organizer_membership_id, event_kind, title, starts_at, ends_at)
  values (pg_temp.id('org_a'), pg_temp.id('dave@org_a'), 'Briefing', 'Org briefing', now(), now() + interval '1 hour')$$,
  '42501', null, 'a member schedules on assigned projects only, not org-wide');
select lives_ok($$with e as (insert into app.workforce_events (org_id, organizer_membership_id, event_kind, title, agenda, location, venue_id,
  audience_kind, project_id, starts_at, ends_at)
  values (pg_temp.id('org_a'), pg_temp.id('dave@org_a'), 'Crew Call', 'Load-in crew call', '1. Safety brief. 2. Assignments.', 'Dock door 3',
  pg_temp.id('venue_a'), 'Project', pg_temp.id('prj_a'), now() + interval '30 minutes', now() + interval '2 hours') returning id)
  insert into k select 'call', id from e$$, 'a project member schedules a project crew call');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications where subject_id = (select id from k where key = 'call') and kind = 'event.invited'), 2,
  'the project''s other members are invited');

select pg_temp.as_user('carol');
select lives_ok($$with e as (insert into app.workforce_events (org_id, organizer_membership_id, event_kind, title, audience_kind, team_id, starts_at, ends_at)
  values (pg_temp.id('org_a'), pg_temp.id('carol@org_a'), 'Meeting', 'Load-in leads sync', 'Team', pg_temp.id('team_a'),
  now() + interval '3 days', now() + interval '3 days 1 hour') returning id) insert into k select 'sync', id from e$$,
  'a manager schedules a team meeting');
select throws_ok($$insert into app.workforce_events (org_id, organizer_membership_id, event_kind, title, starts_at, ends_at)
  values (pg_temp.id('org_a'), pg_temp.id('carol@org_a'), 'Meeting', 'Backwards', now() + interval '2 hours', now())$$,
  '23514', null, 'an event ends after it starts');
select throws_ok($$insert into app.workforce_events (org_id, organizer_membership_id, event_kind, title, audience_kind, starts_at, ends_at)
  values (pg_temp.id('org_a'), pg_temp.id('carol@org_a'), 'Meeting', 'Group without group', 'Group', now(), now() + interval '1 hour')$$,
  'XR001', null, 'a group audience names its group');

-- Reading ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select count(*)::integer from app.workforce_events where org_id = pg_temp.id('org_a')), 1, 'a project member reads the project call only');
select pg_temp.as_user('erin');
select is((select count(*)::integer from app.workforce_events where org_id = pg_temp.id('org_a')), 2, 'a team and project member reads both');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.workforce_events where org_id = pg_temp.id('org_a')), 0, 'an uninvited viewer reads none');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.workforce_events where org_id = pg_temp.id('org_a')), 0, 'no cross-tenant event reads');
select pg_temp.as_anon();
select throws_ok($$select count(*) from app.workforce_events$$, '42501', null, 'anon reads no events');

-- RSVP and check-in ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select lives_ok($$select app.rsvp_to_event((select id from k where key = 'call'), 'Maybe')$$, 'an invitee RSVPs');
select app.rsvp_to_event((select id from k where key = 'call'), 'Going');
select is((select response::text from app.event_rsvps where workforce_event_id = (select id from k where key = 'call')), 'Going',
  'an RSVP changes in place');
select lives_ok($$insert into k select 'checkin', app.check_in_to_event((select id from k where key = 'call'))$$, 'an invitee checks in within the hour before');
select is(app.check_in_to_event((select id from k where key = 'call')), (select id from k where key = 'checkin'), 'checking in twice keeps the first');
select throws_ok($$select app.check_in_to_event((select id from k where key = 'call'), pg_temp.id('erin@org_a'), 'Self')$$, 'XR001', null,
  'nobody self-checks-in someone else');
select throws_ok($$select app.check_in_to_event((select id from k where key = 'sync'))$$, '42501', null,
  'an uninvited person cannot check in');
select pg_temp.as_user('erin');
select throws_ok($$select app.check_in_to_event((select id from k where key = 'sync'))$$, 'XR001', null,
  'check-in opens only an hour before the start');
select pg_temp.as_user('dave');
select lives_ok($$select app.check_in_to_event((select id from k where key = 'call'), pg_temp.id('erin@org_a'), 'Scan')$$,
  'the organizer checks an invitee in from a scan');
select throws_ok($$select app.check_in_to_event((select id from k where key = 'call'), pg_temp.id('gina@org_a'), 'Organizer')$$, 'XR001', null,
  'the organizer checks in only invitees');
select pg_temp.as_platform();
select throws_ok($$update app.event_check_ins set check_in_method = 'Self' where id = (select id from k where key = 'checkin')$$, 'XR001', null,
  'attendance is append-only');

-- Cancel ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('mia');
update app.workforce_events set canceled_at = now(), cancel_reason = 'Rain.' where id = (select id from k where key = 'call');
select pg_temp.as_platform();
select is((select canceled_at from app.workforce_events where id = (select id from k where key = 'call')), null::timestamptz,
  'someone outside the project cannot cancel');
select pg_temp.as_user('dave');
select throws_ok($$update app.workforce_events set canceled_at = now() where id = (select id from k where key = 'call')$$, '23514', null,
  'a cancel names its reason');
select lives_ok($$update app.workforce_events set canceled_at = now(), cancel_reason = 'Dock closed for repairs.' where id = (select id from k where key = 'call')$$,
  'the organizer cancels with a reason');
select throws_ok($$update app.workforce_events set title = 'Revived' where id = (select id from k where key = 'call')$$, 'XR001', null,
  'a canceled event does not change');
select pg_temp.as_user('frank');
select throws_ok($$select app.rsvp_to_event((select id from k where key = 'call'), 'Going')$$, 'XR001', null, 'a canceled event takes no RSVP');

select pg_temp.as_platform();
select is((select count(*)::integer from app.domain_events where org_id = pg_temp.id('org_a')
  and event_type in ('workforce_event.scheduled', 'workforce_event.canceled', 'workforce_event.checked_in')), 5,
  'events emit their domain events: 2 scheduled, 2 check-ins and 1 cancel');

select * from finish();
rollback;
