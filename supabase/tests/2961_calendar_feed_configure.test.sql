-- pgTAP: migration 2961 (B7, RRR-231, ADR 0146 decisions 1 and 2; G-50). Every refusal of the feed configuration, an
-- atomic create with a configuration, configuring another member's or a revoked feed, the 50-people limit, personal
-- feeds, and the shared audience rule: a team (a removed team member and an ended membership left out), a department by
-- role or by Department group, and named people. The same scenario runs in 2963 and in packages/data's vitest.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

-- The audience scenario: team_a holds erin (live), carol (removed from the team) and gina (membership ended); frank holds
-- an Active Production (5000) role; erin is also in the Production department group; dave is in neither.
select pg_temp.as_platform();
insert into app.team_members (team_id, membership_id) values (pg_temp.id('team_a'), pg_temp.id('carol@org_a')),
  (pg_temp.id('team_a'), pg_temp.id('gina@org_a'));
update app.team_members set deleted_at = now() where team_id = pg_temp.id('team_a') and membership_id = pg_temp.id('carol@org_a');
set local session_replication_role = replica;
insert into app.role_assignments (org_id, project_id, role_code, person_id, staffing_basis, assignment_state)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), '5000.50.01', pg_temp.id('frank'), 'Declared', 'Active');
update app.memberships set valid_from = now() - interval '1 day', valid_to = now() - interval '1 minute' where id = pg_temp.id('gina@org_a');
set local session_replication_role = origin;
insert into k (key, id) values ('dept_group', gen_random_uuid());
insert into app.groups (id, org_id, name, group_kind, department_code)
values ((select id from k where key = 'dept_group'), pg_temp.id('org_a'), 'Production crew', 'Department', '5000');
insert into app.group_members (group_id, membership_id) values ((select id from k where key = 'dept_group'), pg_temp.id('erin@org_a'));

-- The audience rule ------------------------------------------------------------------------------------------------------------
select set_eq($$select private.schedule_audience_memberships(pg_temp.id('org_a'), null, pg_temp.id('team_a'), null)$$,
  $$values (pg_temp.id('erin@org_a'))$$, 'a team reaches its live members only: not a removed member, not an ended membership');
select set_eq($$select private.schedule_audience_memberships(pg_temp.id('org_a'), null, null, '5000')$$,
  $$values (pg_temp.id('frank@org_a')), (pg_temp.id('erin@org_a'))$$, 'a department reaches its role holders and its Department group');
select set_eq($$select private.schedule_audience_memberships(pg_temp.id('org_a'), array[pg_temp.id('frank'), pg_temp.id('dave'), pg_temp.id('gina')], null, null)$$,
  $$values (pg_temp.id('frank@org_a')), (pg_temp.id('dave@org_a'))$$, 'named people reach their live memberships of the org');
select is_empty($$select private.schedule_audience_memberships(pg_temp.id('org_a'), null, pg_temp.id('team_b'), null)$$,
  'another org''s team reaches nobody');
select is_empty($$select private.schedule_audience_memberships(pg_temp.id('org_a'), null, pg_temp.id('team_a'), '5000')$$,
  'two audiences at once reach nobody');
select is_empty($$select private.schedule_audience_memberships(pg_temp.id('org_a'), null, null, null)$$, 'no audience reaches nobody');
select ok(private.schedule_audience_shift(pg_temp.id('erin@org_a'), '0000.50.01', array[pg_temp.id('erin@org_a')], null),
  'a shift of a member of the audience belongs to it');
select ok(not private.schedule_audience_shift(pg_temp.id('dave@org_a'), '0000.50.01', array[pg_temp.id('erin@org_a')], null),
  'another member''s shift does not');
select ok(private.schedule_audience_shift(null, '5000.51.02', array[]::uuid[], '5000'), 'an open shift in the department''s role does');
select ok(not private.schedule_audience_shift(null, '5000.51.02', array[]::uuid[], null), 'but not for a team audience');

-- Privileges of the helpers -----------------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'private.schedule_audience_memberships(uuid, uuid[], uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'private.schedule_audience_shift(uuid, text, uuid[], text)', 'execute')
  and not has_function_privilege('authenticated', 'private.schedule_audience_record(uuid, uuid[])', 'execute')
  and not has_function_privilege('anon', 'private.schedule_audience_memberships(uuid, uuid[], uuid, text)', 'execute'),
  'members cannot run the audience helpers, which read any org');
select ok(not has_function_privilege('authenticated', 'private.apply_calendar_feed_configuration(uuid, text, app.calendar_feed_source[], uuid[], uuid, text, app.cue_call_kind)', 'execute'),
  'nor the shared write logic');
select ok(has_function_privilege('authenticated', 'app.configure_calendar_feed(uuid, text, app.calendar_feed_source[], uuid[], uuid, text, app.cue_call_kind)', 'execute')
  and not has_function_privilege('anon', 'app.configure_calendar_feed(uuid, text, app.calendar_feed_source[], uuid[], uuid, text, app.cue_call_kind)', 'execute'),
  'members configure their feeds; anon does not');

-- An atomic create with a configuration ----------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into k (key, id, val) select 'light', calendar_feed_id, feed_token
from app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Lighting crew', '{Shifts,Cues}', null, pg_temp.id('team_a'), null, 'Lighting');
select is((select row(name, sources::text, team_id, department_code, cue_call_kind::text)::text from app.calendar_feeds where id = (select id from k where key = 'light')),
  row('Lighting crew', '{Shifts,Cues}', pg_temp.id('team_a'), null::text, 'Lighting')::text, 'a feed is created with its configuration in one call');
insert into k (key, id, val) select 'calls', calendar_feed_id, feed_token
from app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'), '  Show calls ', p_person_ids => array[pg_temp.id('frank'), pg_temp.id('erin')]);
select is((select name from app.calendar_feeds where id = (select id from k where key = 'calls')), 'Show calls', 'a name is trimmed');
select set_eq(format($$select membership_id from app.calendar_feed_members where calendar_feed_id = %L and deleted_at is null$$, (select id from k where key = 'calls')),
  $$values (pg_temp.id('frank@org_a')), (pg_temp.id('erin@org_a'))$$, 'people are kept as their memberships of the org');
select is((select count(*)::int from app.calendar_feeds where membership_id = pg_temp.id('dave@org_a') and deleted_at is null), 2,
  'two named feeds on the same project');

-- Refusals --------------------------------------------------------------------------------------------------------------------------
select throws_ok(format($$select app.configure_calendar_feed(%L, '   ')$$, (select id from k where key = 'light')),
  'XR001', 'calendar_feed_name: Give the feed a name of 1 to 80 characters.', 'a blank name is refused');
select throws_ok(format($$select app.configure_calendar_feed(%L, repeat('x', 81))$$, (select id from k where key = 'light')),
  'XR001', 'calendar_feed_name: Give the feed a name of 1 to 80 characters.', 'a name of 81 characters is refused');
select throws_ok(format($$select app.configure_calendar_feed(%L, 'SHOW CALLS')$$, (select id from k where key = 'light')),
  'XR001', 'calendar_feed_name: You already have a feed with this name. Choose another name.', 'a duplicate live name is refused');
insert into k (key, id, val) select 'own', calendar_feed_id, feed_token from app.create_calendar_feed(pg_temp.id('org_a'));
select throws_ok(format($$select app.configure_calendar_feed(%L, p_sources => '{Cues}')$$, (select id from k where key = 'own')),
  'XR001', null, 'cues on a member feed are refused');
select throws_ok(format($$select app.configure_calendar_feed(%L, p_team_id => %L)$$, (select id from k where key = 'own'), pg_temp.id('team_a')),
  'XR001', 'calendar_feed_filter_scope: Cues, an audience and a show department are for project feeds only.', 'an audience on a member feed is refused');
select throws_ok(format($$select app.configure_calendar_feed(%L, p_person_ids => array[%L]::uuid[], p_team_id => %L)$$,
  (select id from k where key = 'light'), pg_temp.id('frank'), pg_temp.id('team_a')),
  'XR001', 'calendar_feed_audience: Choose one audience: people, a team or a department.', 'a team and people at once are refused');
select throws_ok(format($$select app.configure_calendar_feed(%L, p_team_id => %L)$$, (select id from k where key = 'light'), pg_temp.id('team_b')),
  'XR001', 'calendar_feed_audience: That team is not in this organization.', 'another org''s team is refused');
select throws_ok(format($$select app.configure_calendar_feed(%L, p_department_code => '5100')$$, (select id from k where key = 'light')),
  'XR001', 'calendar_feed_audience: That department does not exist.', 'an unknown department is refused');
select throws_ok(format($$select app.configure_calendar_feed(%L, p_person_ids => array[%L, %L]::uuid[])$$,
  (select id from k where key = 'light'), pg_temp.id('frank'), pg_temp.id('xavier')),
  'XR001', 'calendar_feed_audience: Everyone in a feed''s audience must be a member of this organization.', 'a person outside the org is refused');
select throws_ok(format($$select app.configure_calendar_feed(%L, p_person_ids => array(select gen_random_uuid() from generate_series(1, 51)))$$,
  (select id from k where key = 'light')),
  'XR001', 'calendar_feed_people_limit: A feed can follow at most 50 people.', '51 people are refused');
select throws_ok(format($$select app.configure_calendar_feed(%L, p_sources => '{}')$$, (select id from k where key = 'light')),
  'XR001', 'calendar_feed_sources: Choose at least one thing for the feed to show, each once.', 'an empty source list is refused');
select throws_ok($$select app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Lighting crew')$$,
  'XR001', null, 'a refused configuration creates no feed');
select is((select count(*)::int from app.calendar_feeds where membership_id = pg_temp.id('dave@org_a') and deleted_at is null), 3,
  'the refused create left nothing behind');

-- Configure replaces the configuration ----------------------------------------------------------------------------------------------------
select lives_ok(format($$select app.configure_calendar_feed(%L, 'Show calls', '{Cues}', array[%L]::uuid[])$$,
  (select id from k where key = 'calls'), pg_temp.id('dave')), 'a feed''s owner reconfigures it');
select set_eq(format($$select membership_id from app.calendar_feed_members where calendar_feed_id = %L and deleted_at is null$$, (select id from k where key = 'calls')),
  $$values (pg_temp.id('dave@org_a'))$$, 'the people audience is replaced');
select is((select count(*)::int from app.calendar_feed_members where calendar_feed_id = (select id from k where key = 'calls') and deleted_at is not null), 2,
  'the old audience rows are soft-deleted');
select lives_ok(format($$select app.configure_calendar_feed(%L, 'Show calls', null, null, null, '5000')$$, (select id from k where key = 'calls')),
  'a department replaces the people');
select is((select count(*)::int from app.calendar_feed_members where calendar_feed_id = (select id from k where key = 'calls') and deleted_at is null), 0,
  'and leaves no people behind');
select is((select sources from app.calendar_feeds where id = (select id from k where key = 'calls')), null::app.calendar_feed_source[],
  'a null source list saves the default set');

select pg_temp.as_user('frank');
select throws_ok(format($$select app.configure_calendar_feed(%L, 'Mine now')$$, (select id from k where key = 'light')),
  '42501', 'calendar feed not found', 'nobody configures another member''s feed');
select pg_temp.as_user('dave');
update app.calendar_feeds set revoked_at = now() where id = (select id from k where key = 'own');
select throws_ok(format($$select app.configure_calendar_feed(%L, 'Back again')$$, (select id from k where key = 'own')),
  '42501', 'calendar feed not found', 'nor a revoked feed');

-- Personal feeds -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
insert into k (key, id, val) select 'ivy', calendar_feed_id, feed_token from app.create_person_calendar_feed('My gigs', '{Shifts,Cues}');
select is((select row(name, sources::text)::text from app.person_calendar_feeds where id = (select id from k where key = 'ivy')),
  row('My gigs', '{Shifts,Cues}')::text, 'a personal feed is created with a name and sources');
insert into k (key, id, val) select 'ivy2', calendar_feed_id, feed_token from app.create_person_calendar_feed();
select throws_ok(format($$select app.configure_person_calendar_feed(%L, 'my GIGS')$$, (select id from k where key = 'ivy2')),
  'XR001', 'calendar_feed_name: You already have a feed with this name. Choose another name.', 'personal feed names are unique per person');
select throws_ok(format($$select app.configure_person_calendar_feed(%L, 'Gigs', '{}')$$, (select id from k where key = 'ivy2')),
  'XR001', null, 'and an empty source list is refused');
select lives_ok(format($$select app.configure_person_calendar_feed(%L, 'Festival season', '{Meetings}')$$, (select id from k where key = 'ivy2')),
  'a person renames their feed');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.configure_person_calendar_feed(%L, 'Mine')$$, (select id from k where key = 'ivy')),
  '42501', 'calendar feed not found', 'nobody configures another person''s feed');

select * from finish();
rollback;
