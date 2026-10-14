-- pgTAP: two-sided ratings released together after both submit or 14 days (Section 4.4.3, Section 14.9), rating
-- replies by the rated side, engagement threads and messages with external access through the engagement and its
-- time box (Section 8.7), and person-owned availability calendars and blocks.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

-- Ratings ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$insert into app.ratings (engagement_id, rater_side, score) values ((select id from world where key = 'eng_ivy_a'), 'Organization', 5)$$,
  'XR001', 'rating_engagement_not_complete: Ratings come only from completed engagements.', 'ratings come only from completed engagements');
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');

select pg_temp.as_user('carol');
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_vendor_a'), 'Organization', 4, 'Clean load-in, late strike.') returning id)
  insert into world select 'rating_org', id from r;
select is((select rated_by from app.ratings where id = pg_temp.id('rating_org')), pg_temp.id('carol'), 'the rater is stamped');
select throws_ok($$insert into app.ratings (engagement_id, rater_side, score) values ((select id from world where key = 'eng_vendor_a'), 'Organization', 3)$$,
  '23505', null, 'one rating per side');
select throws_ok($$insert into app.ratings (engagement_id, rater_side, score) values ((select id from world where key = 'eng_vendor_a'), 'Party', 1)$$,
  '42501', null, 'the org cannot rate itself on the party''s behalf');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.ratings (engagement_id, rater_side, score) values ((select id from world where key = 'eng_vendor_a'), 'Organization', 1)$$,
  '42501', null, 'a Member without opportunities.rating.write cannot rate');
select pg_temp.as_user('victor');
select is((select count(*)::int from app.ratings), 0, 'the party does not see the org''s rating before release');
select pg_temp.as_user('fiona');
select throws_ok($$insert into app.ratings (engagement_id, rater_side, score) values ((select id from world where key = 'eng_vendor_a'), 'Party', 5)$$,
  '42501', null, 'Account Finance does not rate for the account');
select pg_temp.as_user('sam');
select throws_ok($$insert into app.ratings (engagement_id, rater_side, score) values ((select id from world where key = 'eng_vendor_a'), 'Party', 9)$$,
  '23514', null, 'scores run from 1 to 5');
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_vendor_a'), 'Party', 5, 'Clear call sheets.') returning id)
  insert into world select 'rating_party', id from r;
select pg_temp.as_platform();
select ok(private.rating_released(pg_temp.id('eng_vendor_a')), 'both ratings in: released together');
select pg_temp.as_user('victor');
select is((select count(*)::int from app.ratings), 2, 'the party''s account reads both ratings once released');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.ratings where engagement_id = pg_temp.id('eng_vendor_a')), 2, 'the org reads both');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.ratings), 0, 'a stranger reads no ratings through the table');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.ratings), 0, 'another org reads none');
select pg_temp.as_user('sam');
select throws_ok($$update app.ratings set score = 1 where id = (select id from world where key = 'rating_party')$$,
  '42501', null, 'ratings are never edited by their author');
select pg_temp.as_platform();
select throws_ok($$update app.ratings set score = 1 where id = (select id from world where key = 'rating_org')$$,
  'XR001', 'rating_immutable: Ratings are never edited, withdrawn or suppressed.', 'nor suppressed by anyone');

-- Release after 14 days with one side in
select pg_temp.move_engagement('eng_ivy_b', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_b', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_b', 'Closing', 'Complete');
select pg_temp.as_user('xavier');
with r as (insert into app.ratings (engagement_id, rater_side, score) values (pg_temp.id('eng_ivy_b'), 'Organization', 3) returning id)
  insert into world select 'rating_b', id from r;
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.ratings), 0, 'a lone rating stays hidden inside 14 days');
select throws_ok($$insert into app.rating_replies (rating_id, body) values ((select id from world where key = 'rating_b'), 'Too early.')$$,
  'XR001', 'rating_not_released: A rating can be answered once it is released.', 'an unreleased rating cannot be answered');
select pg_temp.as_platform();
select pg_temp.backdate_close('eng_ivy_b', interval '15 days');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.ratings), 1, 'after 14 days the lone rating is released');

-- Replies
select pg_temp.as_user('carol');
select throws_ok($$insert into app.rating_replies (rating_id, body) values ((select id from world where key = 'rating_org'), 'Our own rating.')$$,
  '42501', null, 'the rater does not reply to their own rating');
select lives_ok($$insert into app.rating_replies (rating_id, body) values ((select id from world where key = 'rating_party'), 'Thank you, Bayside.')$$,
  'the org replies to the party''s rating');
select pg_temp.as_user('sam');
select lives_ok($$insert into app.rating_replies (rating_id, body) values ((select id from world where key = 'rating_org'), 'Strike ran late because of the storm.')$$,
  'the rated party replies publicly');
select throws_ok($$insert into app.rating_replies (rating_id, body) values ((select id from world where key = 'rating_org'), 'Again.')$$,
  '23505', null, 'one reply per rating');
select pg_temp.as_user('victor');
select is((select count(*)::int from app.rating_replies), 2, 'both sides read the replies');
select pg_temp.as_platform();

-- Threads and messages ------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with t as (insert into app.engagement_threads (engagement_id, subject) values (pg_temp.id('eng_ivy_a'), 'Call Times') returning id) insert into world select 'thread_ivy', id from t;
insert into app.engagement_messages (engagement_thread_id, body) values (pg_temp.id('thread_ivy'), 'Call is 07:00 at the pier gate.');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.engagement_messages), 1, 'access through own engagement: the party reads the thread');
select lives_ok($$insert into app.engagement_messages (engagement_thread_id, body) values ((select id from world where key = 'thread_ivy'), 'Confirmed.')$$, 'the party replies');
select is((select author_person_id from app.engagement_messages where body = 'Confirmed.'), pg_temp.id('ivy'), 'the author is stamped');
select throws_ok($$update app.engagement_messages set body = 'Edited.'$$, '42501', null, 'messages are never edited');
select lives_ok($$insert into app.engagement_threads (engagement_id, subject) values ((select id from world where key = 'eng_ivy_a'), 'Parking')$$, 'the party opens a thread');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.engagement_messages), 0, 'denial for another party''s engagement messages');
select throws_ok($$insert into app.engagement_messages (engagement_thread_id, body) values ((select id from world where key = 'thread_ivy'), 'Hi.')$$,
  '42501', null, 'another party cannot post');
select pg_temp.as_user('victor');
with t as (insert into app.engagement_threads (engagement_id, subject) values (pg_temp.id('eng_vendor_a'), 'Final Invoice') returning id) insert into world select 'thread_v', id from t;
select is((select count(*)::int from app.engagement_threads), 1, 'access through account engagement: the Account Owner reads and opens threads');
select pg_temp.as_user('rita');
select lives_ok($$insert into app.engagement_threads (engagement_id, subject) values ((select id from world where key = 'eng_art_a'), 'Rider Questions')$$,
  'access through representation: the representative opens a thread on the artist''s engagement');
select pg_temp.as_platform();
select pg_temp.backdate_close('eng_vendor_a', interval '19 months');
select pg_temp.as_user('victor');
select is((select count(*)::int from app.engagement_threads), 0, 'denial after close: threads close 18 months after Complete');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.engagement_threads where engagement_id = pg_temp.id('eng_vendor_a')), 1, 'the org keeps the record');
select pg_temp.as_platform();
select throws_ok($$update app.engagement_messages set body = 'x'$$, 'XR001', null, 'messages are append-only');

-- Availability ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
with c as (insert into app.availability_calendars (person_id, time_zone) values (pg_temp.id('ivy'), 'America/New_York') returning id) insert into world select 'cal_ivy', id from c;
insert into app.availability_blocks (availability_calendar_id, starts_at, ends_at, availability_kind, note)
  values (pg_temp.id('cal_ivy'), '2027-06-10 00:00+00', '2027-06-14 00:00+00', 'Unavailable', 'Sister''s wedding.');
select throws_ok($$insert into app.availability_calendars (person_id, time_zone) values ((select id from world where key = 'ivy'), 'Mars/Olympus')$$,
  'XR001', null, 'a calendar keeps an IANA time zone');
select throws_ok($$insert into app.availability_calendars (person_id, time_zone) values ((select id from world where key = 'quinn'), 'UTC')$$,
  '42501', null, 'nobody keeps a calendar for someone else');
select throws_ok($$insert into app.availability_blocks (availability_calendar_id, starts_at, ends_at, availability_kind) values ((select id from world where key = 'cal_ivy'), '2027-06-02', '2027-06-01', 'Available')$$,
  '23514', null, 'a block ends after it starts');
select is((select visibility::text from app.availability_calendars), 'Private', 'a new calendar starts Private');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.availability_calendars), 0, 'a Private calendar is the owner''s alone');
select pg_temp.as_user('ivy');
update app.availability_calendars set visibility = 'Shared on Application' where id = pg_temp.id('cal_ivy');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.availability_calendars), 1, 'shared on application: an org the person works for sees it');
select is((select count(*)::int from app.availability_blocks), 0, 'block notes stay with the owner');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.availability_calendars), 0, 'a stranger does not');
select pg_temp.as_user('ivy');
update app.availability_calendars set visibility = 'Public' where id = pg_temp.id('cal_ivy');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.availability_calendars), 1, 'a Public calendar is visible in the marketplace');
update app.availability_calendars set visibility = 'Private' where id = pg_temp.id('cal_ivy');
select pg_temp.as_platform();
select is((select visibility::text from app.availability_calendars where id = pg_temp.id('cal_ivy')), 'Public', 'only the owner changes it');

-- Anon deny ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok(format('select 1 from %s', t), '42501', null, 'anon cannot read ' || t)
from unnest(array['app.ratings', 'app.rating_replies', 'app.engagement_threads', 'app.engagement_messages',
  'app.availability_calendars', 'app.availability_blocks']) as t;
select pg_temp.as_platform();

select * from finish();
rollback;
