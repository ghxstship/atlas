-- pgTAP: migration 1410, calendar feeds served, rotated and revoked (A84, RRR-129, finding A65-018, Section 4.6.5).
-- The token RPC behind /ical/{feedToken}.ics returns one JSON document: a member feed shows the member's own shifts
-- and assigned records, a project feed what the member may see on the project, and a person feed what Gateway shows
-- an external party. Rotation replaces the token in place, revocation is final, retired tokens never count as failed
-- guesses, and the per-token and per-address limits hold.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(45);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

create function pg_temp.feed(p_key text, p_client text default null) returns jsonb
language sql as $$ select api_public.calendar_feed((select val from k where key = p_key), p_client) $$;

create function pg_temp.status(p_key text, p_client text default null) returns text
language sql as $$ select pg_temp.feed(p_key, p_client) ->> 'status' $$;

create function pg_temp.event_ids(p_key text) returns setof uuid
language sql as $$ select (e ->> 'id')::uuid from jsonb_array_elements(pg_temp.feed(p_key) -> 'events') e $$;

create function pg_temp.event(p_key text, p_id uuid) returns jsonb
language sql as $$ select e from jsonb_array_elements(pg_temp.feed(p_key) -> 'events') e where (e ->> 'id')::uuid = p_id $$;

-- Fixture: shifts for frank and dave on NWL, a milestone frank owns, an external crew shift for ivy. ---------------------
select pg_temp.as_platform();
with s as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone) values
  (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '0000.50.01', date_trunc('day', now()) + interval '10 days 12 hours',
   date_trunc('day', now()) + interval '10 days 20 hours', 'America/New_York') returning id)
  insert into world select 'frank_shift', id from s;
with s as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone) values
  (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), '0000.50.01', date_trunc('day', now()) + interval '11 days 12 hours',
   date_trunc('day', now()) + interval '11 days 20 hours', 'America/Chicago') returning id)
  insert into world select 'dave_shift', id from s;
with s as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone) values
  (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '0000.50.01', now() - interval '200 days', now() - interval '199 days 16 hours',
   'America/New_York') returning id)
  insert into world select 'old_shift', id from s;
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, due_at, time_zone, owner_party_id)
  values (pg_temp.id('prj_a'), 'Milestone', 'Stage rigging signed off', 'Y', 'Declared', now() + interval '20 days', 'America/New_York',
    pg_temp.id('frank')) returning id)
  insert into world select 'milestone', id from r;

insert into k (key, val) values
  ('org_slug', (select slug from app.organizations where id = pg_temp.id('org_a'))),
  ('org_name', (select name from app.organizations where id = pg_temp.id('org_a'))),
  ('prj_tz', (select time_zone from app.projects where id = pg_temp.id('prj_a')));

-- Member feed ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
insert into k (key, id, val) select 'frank', calendar_feed_id, feed_token from app.create_calendar_feed(pg_temp.id('org_a'));
select ok((select val ~ '^xcal_[0-9a-f]{64}$' from k where key = 'frank'), 'a feed token is xcal_ and 64 hex characters, shown once');
select pg_temp.as_anon();
select is(pg_temp.status('frank'), 'ok', 'a live token serves its feed');
select is(pg_temp.feed('frank') -> 'feed' ->> 'scope', 'member', 'a feed without a project is the member''s own schedule');
select is(pg_temp.feed('frank') -> 'feed' ->> 'org_slug', (select val from k where key = 'org_slug'),
  'the feed names its org');
select ok((pg_temp.feed('frank') -> 'feed' ->> 'time_zone') is not null and (pg_temp.feed('frank') -> 'feed' ->> 'locale') is not null,
  'the feed carries the owner''s zone and language');
select set_eq($$select pg_temp.event_ids('frank')$$, array[pg_temp.id('frank_shift'), pg_temp.id('milestone')],
  'a member feed shows the member''s own shift and the record they own, and nothing older than 90 days');
select is(pg_temp.event('frank', pg_temp.id('frank_shift')) ->> 'status', 'tentative', 'a draft shift is tentative');
select is(pg_temp.event('frank', pg_temp.id('frank_shift')) ->> 'time_zone', 'America/New_York', 'an event keeps the zone its times were typed in');
select is((pg_temp.event('frank', pg_temp.id('frank_shift')) ->> 'sequence')::integer, 0, 'an untouched event has sequence 0');
select is(pg_temp.event('frank', pg_temp.id('milestone')) ->> 'kind', 'milestone', 'a milestone is a feed event of its kind');
select is(pg_temp.event('frank', pg_temp.id('milestone')) ->> 'ends_at', null, 'a milestone has no end: it is a point in time');
select is(pg_temp.event('frank', pg_temp.id('milestone')) ->> 'record_key', 'NWL-1', 'a record event carries its display key');
select pg_temp.as_platform();
select is(private.calendar_feed_sequence(now() - interval '90 seconds', now()), 90, 'the sequence grows with every second between creation and change');
select pg_temp.as_anon();

select pg_temp.as_user('alice');
select app.transition_shift(pg_temp.id('frank_shift'), 'Draft', 'Published', 'Published to crew.');
select app.transition_shift(pg_temp.id('frank_shift'), 'Published', 'Canceled', 'Weather.');
select pg_temp.as_anon();
select is(pg_temp.event('frank', pg_temp.id('frank_shift')) ->> 'status', 'cancelled', 'a canceled shift stays in the feed, cancelled');

-- Project feed ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into k (key, id, val) select 'dave_project', calendar_feed_id, feed_token
from app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'));
select pg_temp.as_user('frank');
insert into k (key, id, val) select 'frank_project', calendar_feed_id, feed_token
from app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'));
select pg_temp.as_anon();
select is(pg_temp.feed('dave_project') -> 'feed' ->> 'project_key', 'NWL', 'a project feed names its project');
select is(pg_temp.feed('dave_project') -> 'feed' ->> 'time_zone', (select val from k where key = 'prj_tz'),
  'a project feed is in the project''s zone');
select ok(pg_temp.id('frank_shift') in (select pg_temp.event_ids('dave_project'))
          and pg_temp.id('dave_shift') in (select pg_temp.event_ids('dave_project')),
  'a coordinator who reads the project''s shifts sees every shift of the project');
select ok(pg_temp.id('dave_shift') not in (select pg_temp.event_ids('frank_project')),
  'a field member''s project feed leaves out other people''s shifts');

-- Rotation --------------------------------------------------------------------------------------------------------------
insert into k (key, val) select 'frank_old', val from k where key = 'frank';
select pg_temp.as_user('frank');
update k set val = (select feed_token from app.rotate_calendar_feed((select id from k where key = 'frank'))) where key = 'frank';
select isnt((select val from k where key = 'frank'), (select val from k where key = 'frank_old'), 'rotating issues a new token');
select is((select token_hint from app.calendar_feeds where id = (select id from k where key = 'frank')),
  right((select val from k where key = 'frank'), 4), 'the hint follows the new token');
select ok((select rotated_at is not null from app.calendar_feeds where id = (select id from k where key = 'frank')), 'the rotation is dated');
select pg_temp.as_anon();
select is(pg_temp.status('frank_old'), 'not_found', 'the old token stops at once');
select is(pg_temp.status('frank'), 'ok', 'the new token serves the same feed');
select pg_temp.as_user('dave');
select throws_ok(format($$select app.rotate_calendar_feed('%s')$$, (select id from k where key = 'frank')), '42501', null,
  'nobody rotates another member''s feed');
select pg_temp.as_user('frank');
select throws_ok($$update app.calendar_feeds set token_hint = 'abcd'$$, '42501', null, 'a token never changes outside rotation');

-- Retired tokens are not guesses ----------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select count(*)::integer from generate_series(1, 25) g where pg_temp.status('frank_old', '198.51.100.20') = 'not_found'), 25,
  'a calendar polling a rotated link gets 404 every time');
select is(pg_temp.status('frank', '198.51.100.20'), 'ok', 'and polling a dead link never locks its address out of live feeds');

-- Failed guesses ----------------------------------------------------------------------------------------------------------
insert into k (key, val) values ('guess', 'xcal_' || repeat('0', 64)), ('junk', 'not-a-token');
select is((select count(*)::integer from generate_series(1, 20) g where pg_temp.status('guess', '198.51.100.30') = 'not_found'), 20,
  'a wrong token is not found');
select is(pg_temp.status('frank', '198.51.100.30'), 'rate_limited', 'after 20 failed lookups the address is refused for 15 minutes');
select is((pg_temp.feed('frank', '198.51.100.30') ->> 'retry_after_seconds')::integer, 900, 'the refusal says when to retry');
select is(pg_temp.status('frank', '198.51.100.31'), 'ok', 'another client address behind the same hop is not refused');
select is(pg_temp.status('junk', '198.51.100.32'), 'not_found', 'a malformed token is not found');
select is(pg_temp.status('frank', 'not an address'), 'ok', 'an unreadable relayed address counts as the reaching address');

-- Per-token limit -----------------------------------------------------------------------------------------------------------
select is((select count(*)::integer from generate_series(1, 116) g where pg_temp.status('frank', '198.51.100.40') = 'ok'), 116,
  'a feed serves well over a hundred fetches an hour');
select is(pg_temp.status('frank', '198.51.100.41'), 'rate_limited', 'past 120 fetches an hour a token is refused, from any address');

-- Revocation --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
update app.calendar_feeds set revoked_at = now() - interval '1 day' where id = (select id from k where key = 'dave_project');
select ok((select revoked_at > now() - interval '1 minute' and deleted_at is not null from app.calendar_feeds
  where id = (select id from k where key = 'dave_project')), 'revoking takes the database time and removes the feed from the list');
select throws_ok(format($$update app.calendar_feeds set revoked_at = null where id = '%s'$$, (select id from k where key = 'dave_project')),
  'XR001', null, 'a revoked feed never comes back');
select throws_ok(format($$select app.rotate_calendar_feed('%s')$$, (select id from k where key = 'dave_project')), '42501', null,
  'a revoked feed cannot be rotated back to life');
select pg_temp.as_anon();
select is(pg_temp.status('dave_project'), 'not_found', 'a revoked feed is not found');

-- Person feed (Gateway) -------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('alice');
with s as (insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '5000.51.02', date_trunc('day', now()) + interval '12 days 12 hours',
    date_trunc('day', now()) + interval '12 days 22 hours', 'America/New_York') returning id)
  insert into world select 'ivy_shift', id from s;
with s as (insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '5000.51.02', date_trunc('day', now()) + interval '13 days 12 hours',
    date_trunc('day', now()) + interval '13 days 22 hours', 'America/New_York') returning id)
  insert into world select 'ivy_draft', id from s;
select app.transition_shift(pg_temp.id('ivy_shift'), 'Draft', 'Published', 'Published to crew.');
select pg_temp.as_user('ivy');
insert into k (key, id, val) select 'ivy', calendar_feed_id, feed_token from app.create_person_calendar_feed();
select throws_ok($$select token_hash from app.person_calendar_feeds$$, '42501', null, 'nobody reads a person feed''s token hash');
select throws_ok(format($$insert into app.person_calendar_feeds (person_id, token_hash, token_hint) values ('%s', '\x00', 'abcd')$$,
  pg_temp.id('ivy')), '42501', null, 'a person feed is created only through the RPC');
select pg_temp.as_anon();
select is(pg_temp.feed('ivy') -> 'feed' ->> 'scope', 'person', 'a Gateway feed is the person''s own across orgs');
select set_eq($$select pg_temp.event_ids('ivy')$$, array[pg_temp.id('ivy_shift')],
  'a person feed shows what Gateway shows: the published shift, never the draft');
select is(pg_temp.event('ivy', pg_temp.id('ivy_shift')) ->> 'org_name', (select val from k where key = 'org_name'),
  'a person feed names the org of each event');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.rotate_person_calendar_feed('%s')$$, (select id from k where key = 'ivy')), '42501', null,
  'nobody rotates another person''s feed');

select * from finish();
rollback;
