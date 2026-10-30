-- pgTAP: migration 2960 (B7, RRR-231, ADR 0146 decision 1; G-50), named and filtered calendar feeds. The new columns,
-- their checks and grants, the people audience table and its row level security, the cross-org guards on team_id and
-- membership_id, the Trash exclusions, and the 4.0 two-argument create still serving a 4.0 feed.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

-- Columns and comments ---------------------------------------------------------------------------------------------------
select col_type_is('app', 'calendar_feeds', 'sources', 'app.calendar_feed_source[]', 'calendar_feeds.sources is an enum array');
select col_type_is('app', 'calendar_feeds', 'team_id', 'uuid', 'calendar_feeds.team_id is a uuid');
select col_type_is('app', 'calendar_feeds', 'cue_call_kind', 'app.cue_call_kind', 'calendar_feeds.cue_call_kind is a cue call kind');
select col_type_is('app', 'person_calendar_feeds', 'sources', 'app.calendar_feed_source[]', 'person_calendar_feeds.sources is an enum array');
select fk_ok('app', 'calendar_feeds', 'department_code', 'xpms', 'dim_department', 'dept_code', 'a department is a canon department');
select is((select count(*)::int from (values ('app.calendar_feeds'::regclass, 'name'), ('app.calendar_feeds', 'sources'),
    ('app.calendar_feeds', 'team_id'), ('app.calendar_feeds', 'department_code'), ('app.calendar_feeds', 'cue_call_kind'),
    ('app.person_calendar_feeds', 'name'), ('app.person_calendar_feeds', 'sources')) v (rel, col)
  join pg_catalog.pg_attribute a on a.attrelid = v.rel and a.attname = v.col
  where col_description(a.attrelid, a.attnum) is not null), 7, 'every new column carries a comment');
select ok(obj_description('app.calendar_feed_source'::regtype, 'pg_type') is not null, 'the source enum carries a comment');

-- Grants: members read the new columns and write none of them ---------------------------------------------------------------
select ok(has_column_privilege('authenticated', 'app.calendar_feeds', 'name', 'select')
  and has_column_privilege('authenticated', 'app.calendar_feeds', 'sources', 'select')
  and has_column_privilege('authenticated', 'app.calendar_feeds', 'team_id', 'select')
  and has_column_privilege('authenticated', 'app.calendar_feeds', 'department_code', 'select')
  and has_column_privilege('authenticated', 'app.calendar_feeds', 'cue_call_kind', 'select'), 'members read a feed''s configuration');
select ok(not has_column_privilege('authenticated', 'app.calendar_feeds', 'token_hash', 'select'), 'and never its token hash');
select ok(not has_column_privilege('authenticated', 'app.calendar_feeds', 'name', 'update')
  and not has_column_privilege('authenticated', 'app.calendar_feeds', 'sources', 'update')
  and not has_column_privilege('authenticated', 'app.calendar_feeds', 'team_id', 'update'), 'only the RPCs write a feed''s configuration');
select ok(has_column_privilege('authenticated', 'app.person_calendar_feeds', 'name', 'select')
  and has_column_privilege('authenticated', 'app.person_calendar_feeds', 'sources', 'select')
  and not has_column_privilege('authenticated', 'app.person_calendar_feeds', 'name', 'update'), 'a person reads, never writes, a feed''s name directly');
select ok(not has_table_privilege('authenticated', 'app.calendar_feed_members', 'insert')
  and not has_table_privilege('authenticated', 'app.calendar_feed_members', 'update')
  and not has_table_privilege('authenticated', 'app.calendar_feed_members', 'delete'), 'the people audience is written only by the RPCs');

-- The 4.0 create still creates a 4.0 feed ---------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into k (key, id, val) select 'legacy', calendar_feed_id, feed_token from app.create_calendar_feed(pg_temp.id('org_a'), pg_temp.id('prj_a'));
insert into k (key, id, val) select 'mine', calendar_feed_id, feed_token from app.create_calendar_feed(pg_temp.id('org_a'));
select is((select row(name, sources, team_id, department_code, cue_call_kind)::text from app.calendar_feeds where id = (select id from k where key = 'legacy')),
  row(null::text, null::text, null::uuid, null::text, null::text)::text, 'the two-argument create saves no configuration');
select pg_temp.as_anon();
select is(api_public.calendar_feed((select val from k where key = 'legacy')) ->> 'status', 'ok', 'and the feed is served');
select is(api_public.calendar_feed((select val from k where key = 'legacy')) -> 'feed' -> 'name', 'null'::jsonb, 'with no name of its own');

-- Checks ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select throws_ok(format($$update app.calendar_feeds set name = ' Lighting' where id = %L$$, (select id from k where key = 'legacy')),
  '23514', null, 'a name is trimmed');
select throws_ok(format($$update app.calendar_feeds set name = repeat('x', 81) where id = %L$$, (select id from k where key = 'legacy')),
  '23514', null, 'a name has at most 80 characters');
select throws_ok(format($$update app.calendar_feeds set name = E'Light\nCrew' where id = %L$$, (select id from k where key = 'legacy')),
  '23514', null, 'a name has no control characters');
select throws_ok(format($$update app.calendar_feeds set sources = '{}' where id = %L$$, (select id from k where key = 'legacy')),
  '23514', null, 'saved sources are never empty');
select throws_ok(format($$update app.calendar_feeds set sources = '{Shifts,Shifts}' where id = %L$$, (select id from k where key = 'legacy')),
  '23514', null, 'nor repeated');
select throws_ok(format($$update app.calendar_feeds set sources = '{Cues}' where id = %L$$, (select id from k where key = 'mine')),
  '23514', null, 'cues need a project feed');
select throws_ok(format($$update app.calendar_feeds set cue_call_kind = 'Lighting' where id = %L$$, (select id from k where key = 'mine')),
  '23514', null, 'a member feed takes no show department');
select throws_ok(format($$update app.calendar_feeds set team_id = %L, department_code = '5000' where id = %L$$,
  pg_temp.id('team_a'), (select id from k where key = 'legacy')), '23514', null, 'a feed has one audience at most');
select lives_ok(format($$update app.calendar_feeds set name = 'Lighting crew', sources = '{Shifts,Cues}' where id = %L$$,
  (select id from k where key = 'legacy')), 'a project feed takes a name and cues');
select throws_ok(format($$update app.calendar_feeds set name = 'lighting CREW' where id = %L$$, (select id from k where key = 'mine')),
  '23505', null, 'names are unique per member among live feeds, ignoring case');

-- Cross-org guards ----------------------------------------------------------------------------------------------------------------
select throws_ok(format($$update app.calendar_feeds set team_id = %L where id = %L$$, pg_temp.id('team_b'), (select id from k where key = 'legacy')),
  'XR001', 'cross_org_reference: calendar_feeds.team_id points to a row of another org.', 'a feed never names another org''s team');
select lives_ok(format($$update app.calendar_feeds set team_id = %L where id = %L$$, pg_temp.id('team_a'), (select id from k where key = 'legacy')),
  'its own org''s team is fine');
select throws_ok(format($$insert into app.calendar_feed_members (calendar_feed_id, membership_id) values (%L, %L)$$,
  (select id from k where key = 'legacy'), pg_temp.id('xavier@org_b')),
  'XR001', 'cross_org_reference: calendar_feed_members.membership_id points to a row of another org.', 'an audience never holds another org''s member');
update app.calendar_feeds set team_id = null where id = (select id from k where key = 'legacy');
insert into app.calendar_feed_members (calendar_feed_id, membership_id) values ((select id from k where key = 'legacy'), pg_temp.id('frank@org_a'));
select is((select org_id from app.calendar_feed_members where calendar_feed_id = (select id from k where key = 'legacy')), pg_temp.id('org_a'),
  'an audience row takes its feed''s org');

-- Row level security of the audience -----------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::int from app.calendar_feed_members where calendar_feed_id = (select id from k where key = 'legacy')), 1,
  'the feed''s owner reads its audience');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.calendar_feed_members), 0, 'nobody else does, not even a member of it');
select throws_ok(format($$insert into app.calendar_feed_members (calendar_feed_id, membership_id) values (%L, %L)$$,
  (select id from k where key = 'legacy'), pg_temp.id('frank@org_a')), '42501', null, 'members never write an audience directly');

-- Trash (ADR 0110) ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok(exists (select 1 from private.trash_excluded_tables where table_name = 'calendar_feeds'), 'calendar_feeds is kept out of Trash');
select ok(exists (select 1 from private.trash_excluded_tables where table_name = 'person_calendar_feeds'), 'and so is person_calendar_feeds, as a guard');
select ok(not exists (select 1 from private.trash_tables where table_name in ('calendar_feeds', 'person_calendar_feeds', 'calendar_feed_members')),
  'no feed table is in Trash');
select is(private.sync_trash_tables(), 0, 'the sync has nothing left to add');

select * from finish();
rollback;
