-- pgTAP: the feed, required acknowledgments, reactions and comment switches, polls, and anonymous pulse
-- surveys with their minimum response threshold (A29, Section 4.9 Feed, Polls and surveys).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(54);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Posting ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select throws_ok($$select app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Gate C is open.')$$, 'XR001', null,
  'a field member cannot post to the feed');

select pg_temp.as_user('carol');
select lives_ok($$insert into k select 'ann', app.create_feed_post(pg_temp.id('org_a'), 'Announcement', 'Wristbands change color on Friday.',
  'Wristband change', p_pinned => true, p_requires_acknowledgment => true)$$, 'a manager posts a pinned announcement that needs acknowledgment');
select ok((select pinned_at is not null and notified_at is not null from app.feed_posts where id = (select id from k where key = 'ann')),
  'the post is pinned and published at once');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications where subject_id = (select id from k where key = 'ann') and kind = 'announcement.posted'),
  7, 'everyone else in the org is notified');
select pg_temp.as_user('carol');
select lives_ok($$insert into k select 'proj', app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Load-in starts at 06:00.',
  p_audience_kind => 'Project', p_project_id => pg_temp.id('prj_a'), p_comments_enabled => false)$$, 'a project update with comments off');
select lives_ok($$insert into k select 'later', app.create_feed_post(pg_temp.id('org_a'), 'Announcement', 'Payroll closes Sunday.',
  p_publish_at => now() + interval '2 days')$$, 'a scheduled announcement');
select throws_ok($$select app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Team only', p_audience_kind => 'Team')$$, 'XR001', null,
  'a team audience names its team');
select throws_ok($$select app.create_feed_post(pg_temp.id('org_a'), 'Recognition', 'Great work')$$, 'XR001', null,
  'recognition posts come only from a shout-out');
select throws_ok($$select app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Old news', p_publish_at => now() - interval '1 day')$$, 'XR001', null,
  'a schedule in the past is refused');

select pg_temp.as_user('gina');
select throws_ok($$select app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Hello')$$, 'XR001', null, 'a viewer cannot post');
select pg_temp.as_user('erin');
select throws_ok($$select app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Pin me', p_pinned => true)$$, 'XR001', null,
  'a collaborator can neither post nor pin');
select pg_temp.as_user('gina');

-- Reading ------------------------------------------------------------------------------------------------------------
select is((select count(*)::integer from app.feed_posts where org_id = pg_temp.id('org_a')), 1,
  'a viewer reads the org announcement only: not the project post, not the scheduled one');
select pg_temp.as_user('mia');
select is((select count(*)::integer from app.feed_posts where org_id = pg_temp.id('org_a') and audience_kind = 'Project'), 0,
  'a field member outside the project does not read its posts');
select pg_temp.as_user('frank');
select is((select count(*)::integer from app.feed_posts where org_id = pg_temp.id('org_a')), 2, 'a project member reads the project update');
select pg_temp.as_user('carol');
select is((select count(*)::integer from app.feed_posts where org_id = pg_temp.id('org_a')), 3, 'the author reads the scheduled post too');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.feed_posts where org_id = pg_temp.id('org_a')), 0, 'no cross-tenant feed reads');
select pg_temp.as_anon();
select throws_ok($$select count(*) from app.feed_posts$$, '42501', null, 'anon reads no feed');

-- Scheduled publish ---------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
update app.feed_posts set publish_at = now() - interval '1 minute' where id = (select id from k where key = 'later');
select is(private.publish_due_feed_posts(), 1, 'the cron job publishes a scheduled post once due');
select is(private.publish_due_feed_posts(), 0, 'and only once');

-- Acknowledgments ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select lives_ok($$insert into k select 'ack', app.acknowledge_feed_post((select id from k where key = 'ann'))$$, 'a member acknowledges');
select is(app.acknowledge_feed_post((select id from k where key = 'ann')), (select id from k where key = 'ack'), 'acknowledging twice keeps the first');
select throws_ok($$select app.acknowledge_feed_post((select id from k where key = 'proj'))$$, 'XR001', null,
  'a post that asks for no acknowledgment refuses one');
select throws_ok($$select * from app.feed_acknowledgment_status((select id from k where key = 'ann'))$$, 'XR001', null,
  'a field member cannot see who acknowledged');
select throws_ok($$update app.feed_acknowledgments set acknowledged_at = now() where id = (select id from k where key = 'ack')$$, '42501', null,
  'acknowledgments are append-only');
select pg_temp.as_user('carol');
select is((select count(*)::integer from app.feed_acknowledgment_status((select id from k where key = 'ann')) where acknowledged_at is not null), 1,
  'the author sees who acknowledged');
select is((select count(*)::integer from app.feed_acknowledgment_status((select id from k where key = 'ann')) where acknowledged_at is null), 7,
  'and who is outstanding');

-- Reactions and comments -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select lives_ok($$select app.react_to_feed_post((select id from k where key = 'ann'), 'thumbs_up')$$, 'a member reacts');
select app.react_to_feed_post((select id from k where key = 'ann'), 'thumbs_up');
select is((select count(*)::integer from app.feed_reactions where feed_post_id = (select id from k where key = 'ann') and deleted_at is null), 1,
  'a reaction counts once per member');
select throws_ok($$select app.react_to_feed_post((select id from k where key = 'ann'), 'rocket')$$, 'XR001', null, 'only curated reactions');
select throws_ok($$select app.post_comment('app.feed_posts', (select id from k where key = 'proj'), 'Can we start at 07:00?', '{}', null)$$,
  'XR001', null, 'a post with comments off refuses comments');
select lives_ok($$select app.post_comment('app.feed_posts', (select id from k where key = 'ann'), 'Which color on Saturday?', '{}', null)$$,
  'a post with comments on takes comments');
select pg_temp.as_user('carol');
select app.update_feed_post((select id from k where key = 'ann'), p_reactions_enabled => false);
select pg_temp.as_user('frank');
select throws_ok($$select app.react_to_feed_post((select id from k where key = 'ann'), 'heart')$$, 'XR001', null,
  'turning reactions off refuses new ones');
select throws_ok($$select app.update_feed_post((select id from k where key = 'ann'), p_comments_enabled => false)$$, 'XR001', null,
  'only the author or a communication admin changes a post');

-- Moderation -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok($$select app.hide_feed_post((select id from k where key = 'proj'), 'Posted to the wrong project.')$$, 'a communication admin hides a post');
select pg_temp.as_user('frank');
select is((select count(*)::integer from app.feed_posts where id = (select id from k where key = 'proj')), 0, 'a hidden post leaves the feed');
select pg_temp.as_user('carol');
select throws_ok($$update app.feed_posts set body = 'Edited' where id = (select id from k where key = 'ann')$$, '42501', null,
  'posts are written only through the RPCs');

-- Polls ----------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$insert into k select 'pollpost', app.create_feed_post(pg_temp.id('org_a'), 'Poll', 'Pick the crew meal.', p_poll =>
  '{"question": "Which crew meal on Saturday?", "options": ["Tacos", "Pasta", "Salad"]}'::jsonb)$$, 'a member posts a poll');
insert into k select 'poll', id from app.polls where feed_post_id = (select id from k where key = 'pollpost');
select throws_ok($$select app.create_feed_post(pg_temp.id('org_a'), 'Poll', 'One option', p_poll => '{"options": ["Only"]}'::jsonb)$$, 'XR001', null,
  'a poll needs at least two options');
select pg_temp.as_user('frank');
select throws_ok($$select app.vote_in_poll((select id from k where key = 'poll'), array(select id from app.poll_options where poll_id = (select id from k where key = 'poll')))$$,
  'XR001', null, 'a single-choice poll takes one option');
select lives_ok($$select app.vote_in_poll((select id from k where key = 'poll'), array[(select id from app.poll_options where poll_id = (select id from k where key = 'poll') and position = 1)])$$,
  'a member votes');
select throws_ok($$select app.vote_in_poll((select id from k where key = 'poll'), array[(select id from app.poll_options where poll_id = (select id from k where key = 'poll') and position = 2)])$$,
  'XR001', null, 'a member votes once');
select pg_temp.as_user('gina');
select app.vote_in_poll((select id from k where key = 'poll'), array[(select id from app.poll_options where poll_id = (select id from k where key = 'poll') and position = 1)]);
select is((select votes from app.poll_results((select id from k where key = 'poll')) where option_position = 1), 2, 'results count votes per option');
select is((select count(*)::integer from app.poll_votes), 1, 'members read only their own votes');

-- Surveys ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$insert into k select 'survey', app.create_survey(pg_temp.id('org_a'), 'Load-in pulse', '[
  {"prompt": "How safe did the load-in feel?", "kind": "Scale", "scale_max": 5},
  {"prompt": "Best shift?", "kind": "Choice", "choices": ["Morning", "Night"]},
  {"prompt": "Anything else?", "kind": "Text", "required": false}]'::jsonb, p_min_responses => 3::smallint)$$,
  'a manager drafts an anonymous survey');
select pg_temp.as_user('frank');
select is((select count(*)::integer from app.surveys where id = (select id from k where key = 'survey')), 0, 'a draft is hidden from the audience');
select pg_temp.as_user('carol');
select app.transition_survey((select id from k where key = 'survey'), 'Draft', 'Open', 'Ready.');
select throws_ok($$insert into app.survey_questions (survey_id, position, prompt, question_kind) values ((select id from k where key = 'survey'), 9, 'Late', 'Text')$$,
  '42501', null, 'questions are not written directly');
select pg_temp.as_user('frank');
select is(app.respond_to_survey((select id from k where key = 'survey'), jsonb_build_object(
  (select id::text from app.survey_questions where survey_id = (select id from k where key = 'survey') and position = 1), 4,
  (select id::text from app.survey_questions where survey_id = (select id from k where key = 'survey') and position = 2), 'Night')), null::uuid,
  'an anonymous response returns nothing that links to it');
select throws_ok($$select app.respond_to_survey((select id from k where key = 'survey'), '{}'::jsonb)$$, 'XR001', null, 'one response per member');
select pg_temp.as_platform();
select ok((select created_by is null and created_at = date_trunc('day', created_at) from app.survey_responses where survey_id = (select id from k where key = 'survey')),
  'an anonymous response stores no creator and only the day');
select pg_temp.as_user('gina');
select throws_ok($$select app.respond_to_survey((select id from k where key = 'survey'), jsonb_build_object(
  (select id::text from app.survey_questions where survey_id = (select id from k where key = 'survey') and position = 1), 9))$$, 'XR001', null,
  'a scale answer stays within the scale');
select pg_temp.as_user('carol');
select is((app.survey_results((select id from k where key = 'survey')) ->> 'threshold_met')::boolean, false, 'results stay hidden below the threshold');
select is(jsonb_array_length(app.survey_results((select id from k where key = 'survey')) -> 'questions'), 0, 'no question results below the threshold');
select pg_temp.as_user('dave');
select app.respond_to_survey((select id from k where key = 'survey'), jsonb_build_object(
  (select id::text from app.survey_questions where survey_id = (select id from k where key = 'survey') and position = 1), 2,
  (select id::text from app.survey_questions where survey_id = (select id from k where key = 'survey') and position = 2), 'Morning'));
select pg_temp.as_user('gina');
select app.respond_to_survey((select id from k where key = 'survey'), jsonb_build_object(
  (select id::text from app.survey_questions where survey_id = (select id from k where key = 'survey') and position = 1), 3,
  (select id::text from app.survey_questions where survey_id = (select id from k where key = 'survey') and position = 2), 'Night'));
select pg_temp.as_user('carol');
select is((app.survey_results((select id from k where key = 'survey')) #>> '{questions,0,average}')::numeric, 3.00,
  'once met, results show averages');

-- Events stay scoped to this world.
select pg_temp.as_platform();
select is((select count(*)::integer from app.domain_events where org_id = pg_temp.id('org_a')
  and event_type in ('feed_post.published', 'feed_post.hidden', 'feed_post.acknowledged', 'poll.voted', 'survey.opened')), 9,
  'feed, poll and survey domain events: 4 published, 1 hidden, 1 acknowledgment, 2 votes and 1 survey opened');

select * from finish();
rollback;
