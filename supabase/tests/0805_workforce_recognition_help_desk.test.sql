-- pgTAP: recognition shout-outs with consented profile counts, and help desk teams on the Organization support
-- queue (A29, Section 4.9 Recognition and Help desk).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(34);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Recognition ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.recognize(pg_temp.id('org_a'), pg_temp.id('dave@org_a'), 'Great job, me.')$$, 'XR001', null, 'nobody recognizes themselves');
select throws_ok($$select app.recognize(pg_temp.id('org_a'), pg_temp.id('xavier@org_b'), 'Thanks!')$$, 'XR001', null, 'recognition stays inside the org');
select lives_ok($$insert into k select 'shout', app.recognize(pg_temp.id('org_a'), pg_temp.id('frank@org_a'), 'Frank re-rigged the truss in record time.', pg_temp.id('prj_a'))$$,
  'a member recognizes a colleague for a project');
select is((select post_kind::text || ' ' || audience_kind::text from app.feed_posts where id = (select feed_post_id from app.recognitions where id = (select id from k where key = 'shout'))),
  'Recognition Project', 'the shout-out is posted to the project feed');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications where kind = 'recognition.received' and subject_id = (select id from k where key = 'shout')), 1,
  'the person recognized is notified');
select pg_temp.as_user('dave');
select throws_ok($$update app.recognitions set message = 'Edited' where id = (select id from k where key = 'shout')$$, '42501', null, 'recognitions are append-only');

select pg_temp.as_user('frank');
select is((select count(*)::integer from app.recognitions where org_id = pg_temp.id('org_a')), 1, 'the person recognized reads it');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.recognitions where org_id = pg_temp.id('org_a')), 0, 'someone outside the project feed does not');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.recognitions where org_id = pg_temp.id('org_a')), 0, 'no cross-tenant recognition reads');
select pg_temp.as_anon();
select throws_ok($$select count(*) from app.recognitions$$, '42501', null, 'anon reads no recognitions');

-- The count shows on a profile only with consent.
select pg_temp.as_user('carol');
select is(app.recognition_count(pg_temp.id('org_a'), pg_temp.id('frank')), null::integer, 'no count without consent');
select pg_temp.as_user('frank');
insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
values (pg_temp.id('org_a'), pg_temp.id('frank'), 'recognition_profile', '2026-10', 'Web');
select pg_temp.as_user('carol');
select is(app.recognition_count(pg_temp.id('org_a'), pg_temp.id('frank')), 1, 'with consent, colleagues see the count');
select pg_temp.as_user('xavier');
select is(app.recognition_count(pg_temp.id('org_a'), pg_temp.id('frank')), null::integer, 'other orgs never see it');

-- Help desk teams ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$insert into app.help_desk_teams (org_id, name, team_kind) values (pg_temp.id('org_a'), 'IT', 'IT')$$, '42501', null,
  'only org.help.write sets up help desk teams');
select pg_temp.as_user('bob');
select lives_ok($$with t as (insert into app.help_desk_teams (org_id, name, team_kind, first_response_hours) values (pg_temp.id('org_a'), 'IT Desk', 'IT', 4) returning id)
  insert into k select 'it', id from t$$, 'an admin sets up a team');
insert into app.help_desk_team_members (help_desk_team_id, membership_id) values ((select id from k where key = 'it'), pg_temp.id('dave@org_a'));
with t as (insert into app.help_desk_teams (org_id, name, team_kind) values (pg_temp.id('org_a'), 'Facilities', 'Facilities') returning id)
insert into k select 'fac', id from t;

select pg_temp.as_user('frank');
select lives_ok($$insert into k select 'req', app.open_help_desk_request(pg_temp.id('org_a'), (select id from k where key = 'it'), 'Access',
  'Tablet will not sign in', 'The dock tablet shows a blank screen after sign-in.')$$, 'a member asks the IT team for help');
select ok((select help_desk_response_due_at > created_at and queue = 'Organization' from app.support_tickets where id = (select id from k where key = 'req')),
  'the request lands in the Organization queue with the team''s response deadline');
select throws_ok($$select app.open_help_desk_request(pg_temp.id('org_a'), gen_random_uuid(), 'Access', 'X', 'Y')$$, 'XR001', null, 'the team must be an active team of the org');
select throws_ok($$update app.support_tickets set assignee_membership_id = pg_temp.id('frank@org_a') where id = (select id from k where key = 'req')$$, '42501', null,
  'members never write tickets directly');
select pg_temp.as_platform();
select throws_ok($$update app.support_tickets set assignee_membership_id = pg_temp.id('frank@org_a') where id = (select id from k where key = 'req')$$, 'XR001', null,
  'even the platform routes only through the RPCs');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications where kind = 'help_request.assigned' and subject_id = (select id from k where key = 'req')), 1,
  'the team is notified');

select pg_temp.as_user('dave');
select is((select count(*)::integer from app.support_tickets where id = (select id from k where key = 'req')), 1, 'a team member reads their team''s requests');
select lives_ok($$select app.assign_help_desk_request((select id from k where key = 'req'), pg_temp.id('dave@org_a'))$$, 'a team member takes the request');
select throws_ok($$select app.assign_help_desk_request((select id from k where key = 'req'), pg_temp.id('gina@org_a'))$$, 'XR001', null,
  'requests are assigned only to team members');
select lives_ok($$select app.answer_help_desk_request((select id from k where key = 'req'), 'Restarting the tablet profile now.')$$, 'the team member answers');
select ok((select first_responded_at is not null from app.support_tickets where id = (select id from k where key = 'req')), 'the first answer is timed');
select lives_ok($$select app.transition_help_desk_request((select id from k where key = 'req'), 'Open', 'Resolved', 'Profile reset.')$$, 'the team member resolves it');
select is((select count(*)::integer from app.support_ticket_messages where support_ticket_id = (select id from k where key = 'req')), 1,
  'the team member reads the conversation');

select pg_temp.as_user('carol');
select is((select count(*)::integer from app.support_tickets where id = (select id from k where key = 'req')), 0, 'others outside the team do not read it');
select throws_ok($$select app.answer_help_desk_request((select id from k where key = 'req'), 'Me too.')$$, '42501', null, 'others cannot answer it');
select pg_temp.as_user('bob');
select lives_ok($$select app.assign_help_desk_request((select id from k where key = 'req'), null, (select id from k where key = 'fac'))$$,
  'an admin moves a request to another team');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.support_tickets where id = (select id from k where key = 'req')), 0, 'it leaves the old team''s queue');
select pg_temp.as_user('frank');
select lives_ok($$select app.transition_support_ticket((select id from k where key = 'req'), 'Resolved', 'Closed', 'Working now.')$$,
  'the requester closes it through the support queue');

select pg_temp.as_platform();
select is((select count(*)::integer from app.domain_events where org_id = pg_temp.id('org_a') and event_type in
  ('recognition.given', 'help_desk_request.routed', 'help_desk_request.assigned', 'support_ticket.answered', 'support_ticket.resolved')), 6,
  'recognition and help desk domain events: 1 shout-out, 1 routed, 2 assignments, 1 answer, 1 resolved');

select * from finish();
rollback;
