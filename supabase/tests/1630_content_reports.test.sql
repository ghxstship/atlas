-- pgTAP: migration 1630, reported posts, comments and messages (owner decision 19, App Store Review Guideline 1.2). A
-- person reports content they can see, never their own; the org's moderators (org.communication.write: Alice the owner
-- and Bob the admin) are notified, read the report with its snapshot and decide it with a statement of reasons. Removal
-- hides a post, deletes a comment or deletes a message; the reporters hear the outcome and the author gets the
-- statement. A report still open after 24 hours reminds the moderators once.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(57);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

select has_table('app', 'content_reports', 'app.content_reports exists');
select has_table('app', 'content_moderation_decisions', 'app.content_moderation_decisions exists');

-- A post by Carol (a manager, not a moderator) to the whole org.
select pg_temp.as_user('carol');
insert into k select 'post', app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Anyone who misses load-in is useless.');

-- Reporting -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$insert into k select 'r1', app.report_content('Feed Post', (select id from k where key = 'post'), 'Harassment', 'Aimed at the late crew.')$$,
  'a member reports a post in their feed');
select is(app.report_content('Feed Post', (select id from k where key = 'post'), 'Hate'), (select id from k where key = 'r1'),
  'reporting it again while the report is open returns the open report');
select is((select count(*)::int from app.content_reports), 1, 'the reporter reads their own report');
select is((select content_excerpt from app.content_reports), 'Anyone who misses load-in is useless.', 'the report keeps a snapshot of the text');
select ok((select due_at = reported_at + interval '24 hours' from app.content_reports), 'a decision is due 24 hours after the report');
select throws_ok($$insert into app.content_reports (org_id, subject_kind, feed_post_id, reporter_person_id, reason, content_excerpt, due_at)
  values (pg_temp.id('org_a'), 'Feed Post', (select id from k where key = 'post'), pg_temp.id('dave'), 'Spam', 'x', now())$$,
  '42501', null, 'reports are filed only through app.report_content');

select pg_temp.as_user('carol');
select throws_ok($$select app.report_content('Feed Post', (select id from k where key = 'post'), 'Spam')$$,
  'XR001', 'content_report_own: You cannot report your own post, comment or message.', 'nobody reports their own content');
select is((select count(*)::int from app.content_reports), 0, 'the author cannot read reports about their post');

select pg_temp.as_user('xavier');
select throws_ok($$select app.report_content('Feed Post', (select id from k where key = 'post'), 'Spam')$$,
  '42501', null, 'a person in another org cannot report a post they cannot see');

select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where kind = 'content_report.filed' and subject_id = (select id from k where key = 'r1')),
  2, 'both moderators are notified of the new report');
select is((select array_agg(recipient_person_id order by recipient_person_id) from app.notifications
           where kind = 'content_report.filed' and subject_id = (select id from k where key = 'r1')),
  (select array_agg(x order by x) from unnest(array[pg_temp.id('alice'), pg_temp.id('bob')]) x), 'the owner and the admin, nobody else');
select is((select count(*)::int from app.notification_deliveries d join app.notifications n on n.id = d.notification_id
           where n.kind = 'content_report.filed' and n.subject_id = (select id from k where key = 'r1') and d.message_status = 'Digest'),
  0, 'safety notices never wait for a digest');

-- The moderators' queue -------------------------------------------------------------------------------------------------
select pg_temp.as_user('erin');
select is((select count(*)::int from app.content_reports), 0, 'another member reads nobody else''s report');
select throws_ok($$select * from app.content_moderation_queue(pg_temp.id('org_a'))$$,
  'XR001', 'content_moderation_authority: Reviewing reported content needs org.communication.write.', 'a member has no moderation queue');

select pg_temp.as_user('bob');
select is((select count(*)::int from app.content_reports), 1, 'a moderator reads the org''s reports');
select is((select open_reports from app.content_moderation_queue(pg_temp.id('org_a'))), 1::bigint, 'the queue lists the post with one open report');
select is((select overdue from app.content_moderation_queue(pg_temp.id('org_a'))), false, 'not yet overdue');
select is((select author_name from app.content_moderation_queue(pg_temp.id('org_a'))), 'Carol Nguyen', 'with its author');
select is((select jsonb_array_length(app.content_report_detail(pg_temp.id('org_a'), 'Feed Post', (select id from k where key = 'post')) -> 'reports')),
  1, 'the detail lists the report');
select is((app.content_report_detail(pg_temp.id('org_a'), 'Feed Post', (select id from k where key = 'post')) -> 'reports' -> 0 ->> 'reporter_name'),
  'Dave Lindqvist', 'and who reported it');
select throws_ok($$select * from app.content_moderation_queue(pg_temp.id('org_b'))$$,
  'XR001', null, 'a moderator of one org has no queue in another');

-- Deciding --------------------------------------------------------------------------------------------------------------
select throws_ok($$select app.decide_content_report(pg_temp.id('org_a'), 'Feed Post', (select id from k where key = 'post'),
  'Removed', 'No Violation', 'Acceptable Use Policy 1', 'Insults the crew.', 'We removed the post.')$$,
  '23514', null, 'a removal needs a violation as its ground');
select lives_ok($$insert into k select 'd1', app.decide_content_report(pg_temp.id('org_a'), 'Feed Post', (select id from k where key = 'post'),
  'Removed', 'Terms Violation', 'Acceptable Use Policy 1', 'The post insults crew members who arrived late.',
  'We removed your post because it insults crew members.')$$, 'a moderator removes the post with a statement of reasons');
select throws_ok($$select app.decide_content_report(pg_temp.id('org_a'), 'Feed Post', (select id from k where key = 'post'),
  'No Action', 'No Violation', 'Acceptable Use Policy 1', 'Second look.', 'No action.')$$,
  'XR001', 'content_moderation_nothing_open: Every report about this was already decided.', 'a decided item has nothing left to decide');
select pg_temp.as_platform();
select ok((select hidden_at is not null and pinned_at is null and hidden_reason = 'We removed your post because it insults crew members.'
           from app.feed_posts where id = (select id from k where key = 'post')), 'removal hides the post with the statement as its reason');
select is((select content_moderation_decision_id from app.content_reports where id = (select id from k where key = 'r1')),
  (select id from k where key = 'd1'), 'the decision decides the report');
select is((select decided_by from app.content_moderation_decisions where id = (select id from k where key = 'd1')), pg_temp.id('bob'),
  'the decision names the moderator');
select is((select count(*)::int from app.notifications where kind = 'content_report.decided' and recipient_person_id = pg_temp.id('dave')
           and subject_id = (select id from k where key = 'd1')), 1, 'the reporter hears the outcome');
select is((select message_args ->> 'statement' from app.notifications where kind = 'content.removed'
           and recipient_person_id = pg_temp.id('carol') and subject_id = (select id from k where key = 'd1')),
  'We removed your post because it insults crew members.', 'the author receives the statement of reasons');
select is((select message_args ->> 'actorName' from app.notifications where kind = 'content.removed'
           and recipient_person_id = pg_temp.id('carol')), 'Northwind Live', 'the notice names the org, not the moderator');
select throws_ok($$update app.content_moderation_decisions set facts = 'Changed.' where id = (select id from k where key = 'd1')$$,
  'XR001', null, 'decisions are append-only');

select pg_temp.as_user('carol');
select is((select count(*)::int from app.content_moderation_decisions), 1, 'the author reads the decision about their post');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.content_moderation_decisions), 1, 'the reporter reads the decision on their report');
select pg_temp.as_user('erin');
select is((select count(*)::int from app.content_moderation_decisions), 0, 'nobody else does');

select pg_temp.as_user('alice');
select throws_ok($$select app.report_content('Feed Post', (select id from k where key = 'post'), 'Spam')$$,
  'XR001', 'content_report_removed: This was already removed.', 'content already removed cannot be reported');

-- A moderator's own post ------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into k select 'own', app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Parking moves to lot B.');
select pg_temp.as_user('dave');
insert into k select 'r2', app.report_content('Feed Post', (select id from k where key = 'own'), 'Spam');
select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where kind = 'content_report.filed' and subject_id = (select id from k where key = 'r2')
           and recipient_person_id = pg_temp.id('alice')), 0, 'a moderator is not told about a report on their own post');
select pg_temp.as_user('alice');
select throws_ok($$select app.decide_content_report(pg_temp.id('org_a'), 'Feed Post', (select id from k where key = 'own'),
  'No Action', 'No Violation', 'Acceptable Use Policy 1', 'A parking notice.', 'The post breaks no rule.')$$,
  'XR001', 'content_moderation_own: Another moderator decides reports about your own post, comment or message.',
  'a moderator never decides about their own content');
select pg_temp.as_user('bob');
select lives_ok($$select app.decide_content_report(pg_temp.id('org_a'), 'Feed Post', (select id from k where key = 'own'),
  'No Action', 'No Violation', 'Acceptable Use Policy 1', 'A parking notice.', 'The post breaks no rule.')$$,
  'another moderator takes no action');
select pg_temp.as_platform();
select ok((select hidden_at is null from app.feed_posts where id = (select id from k where key = 'own')), 'no action leaves the post');
select is((select count(*)::int from app.notifications where kind = 'content.removed' and recipient_person_id = pg_temp.id('alice')), 0,
  'and its author receives no removal notice');

-- A comment on a post ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into k select 'comment', app.post_comment('app.feed_posts', (select id from k where key = 'own'), 'Lot B floods every year, genius.', '{}', null);
select pg_temp.as_user('erin');
select lives_ok($$insert into k select 'r3', app.report_content('Comment', (select id from k where key = 'comment'), 'Harassment')$$,
  'a member reports a comment on a post');
select pg_temp.as_user('bob');
select lives_ok($$select app.decide_content_report(pg_temp.id('org_a'), 'Comment', (select id from k where key = 'comment'),
  'Removed', 'Terms Violation', 'Acceptable Use Policy 1', 'Insults the post''s author.', 'We removed the comment.')$$,
  'a moderator removes the comment');
select pg_temp.as_platform();
select ok((select deleted_at is not null and body = '' from app.comments where id = (select id from k where key = 'comment')),
  'removal deletes the comment and clears its text');

-- A chat message --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
insert into k select 'dm', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('dave@org_a'));
insert into k select 'msg', app.send_chat_message((select id from k where key = 'dm'), 'Send me your home address or else.');
select pg_temp.as_user('erin');
select throws_ok($$select app.report_content('Chat Message', (select id from k where key = 'msg'), 'Violence')$$,
  '42501', null, 'someone outside the conversation cannot report its messages');
select pg_temp.as_user('dave');
select lives_ok($$insert into k select 'r4', app.report_content('Chat Message', (select id from k where key = 'msg'), 'Violence')$$,
  'a person in the conversation reports a message');
select pg_temp.as_user('bob');
select is((app.content_report_detail(pg_temp.id('org_a'), 'Chat Message', (select id from k where key = 'msg')) -> 'subject' ->> 'body'),
  'Send me your home address or else.', 'a moderator outside the conversation reads the reported message');

-- Past the 24 hours -----------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
update app.content_reports set due_at = now() - interval '1 minute' where id = (select id from k where key = 'r4');
select is(private.escalate_overdue_content_reports(), 1, 'the hourly job finds the report past its due time');
select is((select count(*)::int from app.notifications where kind = 'content_report.overdue'
           and subject_id = (select id from k where key = 'r4')), 2, 'and reminds both moderators');
select is(private.escalate_overdue_content_reports(), 0, 'once');
select pg_temp.as_user('bob');
select is((select overdue from app.content_moderation_queue(pg_temp.id('org_a'))
           where subject_id = (select id from k where key = 'msg')), true, 'the queue shows it overdue');
select lives_ok($$select app.decide_content_report(pg_temp.id('org_a'), 'Chat Message', (select id from k where key = 'msg'),
  'Removed', 'Terms Violation', 'Acceptable Use Policy 1', 'A threat to a crew member.', 'We removed the message.')$$,
  'a moderator removes the message');
select pg_temp.as_platform();
select ok((select deleted_at is not null from app.chat_messages where id = (select id from k where key = 'msg')),
  'removal deletes the message for everyone');
select pg_temp.as_user('bob');
select is((select count(*)::int from app.content_moderation_queue(pg_temp.id('org_a'))), 0, 'the open queue is empty');
select is((select count(*)::int from app.content_moderation_queue(pg_temp.id('org_a'), false)), 4, 'and the decided view lists every item');

select pg_temp.as_anon();
select throws_ok('select 1 from app.content_reports', '42501', null, 'anon reads no reports');

select * from finish();
rollback;
