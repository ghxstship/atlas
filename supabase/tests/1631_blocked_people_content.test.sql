-- pgTAP: migration 1631, what a person block hides (ADR 0033 decision 57, App Store Review Guideline 1.2). Dave blocks
-- Frank and Carol through app.block_member: their posts (except one that needs acknowledgment), comments on posts,
-- shout-outs and messages, in a direct and a group conversation, disappear for Dave and stay for everyone else; the
-- notifications about them (announcement.posted, comment.created and mention.created on a post, message.received and
-- recognition.received) leave Dave's Inbox and their deliveries are Suppressed, except an announcement that needs
-- acknowledgment. Lifting the block shows everything again. A shout-out whose post a moderator hid reads to nobody.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(39);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Content before the block.
select pg_temp.as_user('carol');
insert into k select 'post', app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Catering moves to the west tent.');
insert into k select 'ack', app.create_feed_post(pg_temp.id('org_a'), 'Announcement', 'Hard hats on the deck from today.',
  p_requires_acknowledgment => true);
insert into k select 'ann', app.create_feed_post(pg_temp.id('org_a'), 'Announcement', 'Crew meal moves to 18:00.');
select pg_temp.as_user('alice');
insert into k select 'alice_post', app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Thanks for a smooth load-in.');
select pg_temp.as_user('carol');
insert into k select 'comment', app.post_comment('app.feed_posts', (select id from k where key = 'alice_post'), 'Agreed, great work.', '{}', null);
-- Comment notifications go at commit; each test comment fires them as its author.
set constraints all immediate;
set constraints all deferred;
select pg_temp.as_user('bob');
with g as (insert into app.groups (org_id, name, group_kind) values (pg_temp.id('org_a'), 'Deck Crew', 'Crew') returning id)
  insert into k select 'crew', id from g;
insert into app.group_members (group_id, membership_id) values
  ((select id from k where key = 'crew'), pg_temp.id('dave@org_a')),
  ((select id from k where key = 'crew'), pg_temp.id('frank@org_a')),
  ((select id from k where key = 'crew'), pg_temp.id('erin@org_a'));
select pg_temp.as_platform();
insert into k select 'crew_conv', id from app.conversations where group_id = (select id from k where key = 'crew');
select pg_temp.as_user('frank');
insert into k select 'dm', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('dave@org_a'));
insert into k select 'dm1', app.send_chat_message((select id from k where key = 'dm'), 'You still owe me for the cables.');
insert into k select 'group1', app.send_chat_message((select id from k where key = 'crew_conv'), 'Deck is clear.');

select pg_temp.as_user('dave');
select is((select count(*)::int from app.chat_messages where conversation_id = (select id from k where key = 'dm')), 1,
  'before: Dave reads Frank''s direct message');

-- Blocking --------------------------------------------------------------------------------------------------------------
select lives_ok($$insert into k select 'block_frank', app.block_member(pg_temp.id('frank@org_a'))$$, 'Dave blocks Frank by his membership');
select is(app.block_member(pg_temp.id('frank@org_a')), (select id from k where key = 'block_frank'), 'blocking again returns the same block');
select is((select blocked_person_id from app.blocks where id = (select id from k where key = 'block_frank')), pg_temp.id('frank'),
  'the block names the person, as a profile block does');
select throws_ok($$select app.block_member(pg_temp.id('dave@org_a'))$$, 'XR001', 'block_self: A person cannot block themselves.',
  'nobody blocks themselves');
select pg_temp.as_user('xavier');
select throws_ok($$select app.block_member(pg_temp.id('dave@org_a'))$$, '42501', null, 'nor someone outside their orgs');

select pg_temp.as_user('dave');
select lives_ok($$select app.block_member(pg_temp.id('carol@org_a'))$$, 'Dave blocks Carol too');

-- What Dave no longer sees ----------------------------------------------------------------------------------------------
select is((select count(*)::int from app.chat_messages where conversation_id = (select id from k where key = 'dm')), 0,
  'Frank''s direct message is gone for Dave');
select is((select count(*)::int from app.chat_messages where conversation_id = (select id from k where key = 'crew_conv')), 0,
  'and his message in the group conversation');
select is((select last_message_body from app.my_conversations(pg_temp.id('org_a')) where conversation_id = (select id from k where key = 'dm')),
  null, 'the conversation list previews none of his messages');
select is((select unread_count from app.my_conversations(pg_temp.id('org_a')) where conversation_id = (select id from k where key = 'dm')),
  0, 'and counts none unread');
select is((select count(*)::int from app.feed_posts where id = (select id from k where key = 'post')), 0, 'Carol''s post is gone for Dave');
select is((select count(*)::int from app.feed_posts where id = (select id from k where key = 'ack')), 1,
  'her post that needs acknowledgment stays');
select is((select count(*)::int from app.comments where id = (select id from k where key = 'comment')), 0,
  'her comment on Alice''s post is gone for Dave');
select is((select count(*)::int from app.feed_posts where id = (select id from k where key = 'alice_post')), 1, 'Alice''s post stays');
select is((select count(*)::int from app.notifications where kind = 'announcement.posted' and subject_id = (select id from k where key = 'ann')), 0,
  'the notification about Carol''s announcement leaves Dave''s Inbox');
select is((select count(*)::int from app.notifications where kind = 'announcement.posted' and subject_id = (select id from k where key = 'ack')), 1,
  'the one about her announcement that needs acknowledgment stays');
select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where kind = 'announcement.posted' and recipient_person_id = pg_temp.id('dave')
           and subject_id in ((select id from k where key = 'ann'), (select id from k where key = 'ack'))), 2,
  'both announcement notifications were made for Dave');

select pg_temp.as_user('erin');
select is((select count(*)::int from app.chat_messages where conversation_id = (select id from k where key = 'crew_conv')), 1,
  'Erin still reads Frank''s group message');
select is((select count(*)::int from app.feed_posts where id = (select id from k where key = 'post')), 1, 'and Carol''s post');
select is((select count(*)::int from app.comments where id = (select id from k where key = 'comment')), 1, 'and her comment');

select pg_temp.as_user('frank');
select is((select count(*)::int from app.chat_messages where conversation_id = (select id from k where key = 'dm')), 1,
  'Frank still reads the conversation and is not told');
select is((select count(*)::int from app.blocks), 0, 'and cannot read the block');

-- New content after the block -------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
insert into k select 'dm2', app.send_chat_message((select id from k where key = 'dm'), 'Answer me.');
insert into k select 'shout', app.recognize(pg_temp.id('org_a'), pg_temp.id('dave@org_a'), 'Thanks for covering my shift.');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.notifications where subject_id in ((select id from k where key = 'dm2'), (select id from k where key = 'shout'))),
  0, 'the notifications about Frank''s new message and shout-out stay out of Dave''s Inbox');
select is((select count(*)::int from app.recognitions where id = (select id from k where key = 'shout')), 0,
  'the shout-out Frank gave Dave is hidden from Dave');
select pg_temp.as_platform();
select is((select array_agg(kind order by kind) from app.notifications where recipient_person_id = pg_temp.id('dave')
           and subject_id in ((select id from k where key = 'dm2'), (select id from k where key = 'shout'))),
  array['message.received', 'recognition.received'], 'both notifications were made for Dave');
select ok((select count(*) > 0 and count(*) filter (where d.message_status <> 'Suppressed') = 0
           from app.notification_deliveries d join app.notifications n on n.id = d.notification_id
           where n.recipient_person_id = pg_temp.id('dave') and n.subject_id = (select id from k where key = 'dm2')),
  'the email and push of Frank''s message to Dave are Suppressed');
update app.notification_deliveries d set message_status = 'Digest'
from app.notifications n
where n.id = d.notification_id and n.created_at = d.notification_created_at
  and n.recipient_person_id = pg_temp.id('dave') and n.subject_id = (select id from k where key = 'dm2');
select ok((select bool_and(d.message_status = 'Suppressed')
           from app.notification_deliveries d join app.notifications n on n.id = d.notification_id
           where n.recipient_person_id = pg_temp.id('dave') and n.subject_id = (select id from k where key = 'dm2')),
  'and stay Suppressed when a text is held for the summary');
select ok((select count(*) > 0 and count(*) filter (where d.message_status = 'Suppressed') = 0
           from app.notification_deliveries d join app.notifications n on n.id = d.notification_id
           where n.recipient_person_id = pg_temp.id('erin') and n.subject_id = (select id from k where key = 'group1')),
  'nothing is suppressed for anyone else');

-- Carol comments on a post Dave follows, and mentions him.
select pg_temp.as_user('dave');
select app.post_comment('app.feed_posts', (select id from k where key = 'alice_post'), 'Seconded.', '{}', null);
set constraints all immediate;
set constraints all deferred;
select pg_temp.as_user('carol');
select app.post_comment('app.feed_posts', (select id from k where key = 'alice_post'), 'Thanks, everyone.', '{}', null);
select app.post_comment('app.feed_posts', (select id from k where key = 'alice_post'), 'Dave, can you lock the tent?', array[pg_temp.id('dave')], null);
set constraints all immediate;
set constraints all deferred;
select pg_temp.as_platform();
select is((select array_agg(kind order by kind) from app.notifications where recipient_person_id = pg_temp.id('dave')
           and subject_id = (select id from k where key = 'alice_post') and actor_person_id = pg_temp.id('carol')),
  array['comment.created', 'mention.created'], 'Carol''s comment and mention notify Dave');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.notifications where kind = 'comment.created' and subject_id = (select id from k where key = 'alice_post')), 0,
  'the comment notification leaves his Inbox');
select is((select count(*)::int from app.notifications where kind = 'mention.created' and subject_id = (select id from k where key = 'alice_post')), 0,
  'and so does the mention');

-- Lifting the block -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
update app.blocks set deleted_at = now() where id = (select id from k where key = 'block_frank');
select is((select count(*)::int from app.chat_messages where conversation_id = (select id from k where key = 'dm')), 2,
  'lifting the block shows Frank''s messages again');
select is((select count(*)::int from app.notifications where subject_id = (select id from k where key = 'dm2')), 1,
  'and the notification about his message');
select is((select count(*)::int from app.recognitions where id = (select id from k where key = 'shout')), 1, 'and his shout-out');
select is((select count(*)::int from app.notifications where kind = 'recognition.received' and subject_id = (select id from k where key = 'shout')), 1,
  'and the notification about it');

-- A shout-out whose post a moderator hid --------------------------------------------------------------------------------
select pg_temp.as_user('frank');
insert into k select 'shout_erin', app.recognize(pg_temp.id('org_a'), pg_temp.id('erin@org_a'), 'Nice rigging, slowpoke.');
select pg_temp.as_user('bob');
select app.hide_feed_post((select feed_post_id from app.recognitions where id = (select id from k where key = 'shout_erin')),
  'Removed after a report.');
select pg_temp.as_user('erin');
select is((select count(*)::int from app.recognitions where id = (select id from k where key = 'shout_erin')), 0,
  'the person it names no longer reads a shout-out whose post was hidden');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.recognitions where id = (select id from k where key = 'shout_erin')), 0, 'nor does its author');

select pg_temp.as_anon();
select throws_ok($$select app.block_member(pg_temp.id('frank@org_a'))$$, '42501', null, 'anon blocks nobody');

select * from finish();
rollback;
