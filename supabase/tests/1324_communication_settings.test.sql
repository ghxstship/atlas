-- pgTAP: migration 1324, the Communication settings take effect (A76, RRR-121, A65-001). New feed posts take the
-- org's communication.feed_reactions_default and communication.feed_comments_default unless the author sets them.
-- The nightly retention job deletes chat messages older than communication.message_retention_days, marks their
-- attachments deleted, keeps messages inside the retention and messages of orgs under a legal hold, and records
-- its run.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(12);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Feed defaults ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into k select 'post1', app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Gate C opens at noon.');
select results_eq($$select reactions_enabled, comments_enabled from app.feed_posts where id = (select id from k where key = 'post1')$$,
  $$values (true, true)$$, 'by default a new post takes reactions and comments');
select app.set_setting(pg_temp.id('org_a'), 'communication.feed_reactions_default', 'Organization', pg_temp.id('org_a'), p_value_boolean => false);
select app.set_setting(pg_temp.id('org_a'), 'communication.feed_comments_default', 'Organization', pg_temp.id('org_a'), p_value_boolean => false);
insert into k select 'post2', app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Wristbands change color on Friday.');
select results_eq($$select reactions_enabled, comments_enabled from app.feed_posts where id = (select id from k where key = 'post2')$$,
  $$values (false, false)$$, 'with the org defaults off, a new post takes neither');
insert into k select 'post3', app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Thanks to the load-in crew.', p_reactions_enabled => true);
select results_eq($$select reactions_enabled, comments_enabled from app.feed_posts where id = (select id from k where key = 'post3')$$,
  $$values (true, false)$$, 'the author can still turn reactions on for one post');
select pg_temp.as_user('xavier');
insert into k select 'post_b', app.create_feed_post(pg_temp.id('org_b'), 'Update', 'Harbor stage is dry.');
select results_eq($$select reactions_enabled, comments_enabled from app.feed_posts where id = (select id from k where key = 'post_b')$$,
  $$values (true, true)$$, 'another org keeps its own defaults');

-- Message retention -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into k select 'conv_a', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('bob@org_a'));
insert into k select 'msg_a', app.send_chat_message((select id from k where key = 'conv_a'), 'Truck two is at the dock.');
select pg_temp.as_user('xavier');
insert into k select 'conv_b', app.start_direct_conversation(pg_temp.id('org_b'), pg_temp.id('mia@org_b'));
insert into k select 'msg_b', app.send_chat_message((select id from k where key = 'conv_b'), 'Harbor stage is dry.');
select pg_temp.as_platform();
insert into app.attachments (org_id, subject_table, subject_id, title)
values (pg_temp.id('org_a'), 'app.chat_messages', (select id from k where key = 'msg_a'), 'dock.jpg');

select is(private.purge_chat_messages_past_retention(now() + interval '31 days'), 0::bigint,
  'nothing is deleted inside the default retention of 730 days');

select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'communication.message_retention_days', 'Organization', pg_temp.id('org_a'), p_value_integer => 30);
select pg_temp.as_platform();
insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_a'), 'app.chat_messages', 'Insurance claim 2027-14');
select is(private.purge_chat_messages_past_retention(now() + interval '31 days'), 0::bigint, 'a legal hold on chat messages keeps them past the retention');
update app.legal_holds set released_at = now() where org_id = pg_temp.id('org_a');

select is(private.purge_chat_messages_past_retention(now() + interval '31 days'), 1::bigint, 'once released, a message older than the org''s 30 days is deleted');
select is((select count(*)::int from app.chat_messages where id = (select id from k where key = 'msg_a')), 0, 'the message is gone');
select ok((select deleted_at is not null from app.attachments where subject_id = (select id from k where key = 'msg_a')), 'its attachment is marked deleted');
select is((select count(*)::int from app.chat_messages where id = (select id from k where key = 'msg_b')), 1, 'another org''s message inside its retention stays');
select ok(exists (select 1 from private.retention_runs where table_name = 'app.chat_messages' and action = 'purge' and rows_affected = 1),
  'the run is recorded');
select ok(position('purge_chat_messages_past_retention' in pg_get_functiondef('private.run_nightly_retention()'::regprocedure)) > 0,
  'the nightly retention job runs the message purge');

select * from finish();
rollback;
