-- pgTAP: migration 904190301, restore rules for the Trash tables members never update directly (RRR-198, ADR 0110
-- amendment of 4.19). This suite covers support_tickets, chat_messages, feed_posts, poll_options, surveys and
-- occupancy_counters; rating_replies, party_threads and shared_reports are in
-- 904190301_trash_restore_rules_parties.test.sql. Per table: a person who reads the row and does not manage it is
-- refused, the people who manage it restore it, and other orgs and anon stay out. A message a moderator removed never
-- comes back from Trash. Every table in Trash has a restore path. A row of a table that never comes back (a team
-- member) stays deleted when its parent is restored.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(58);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

create function pg_temp.k(p_key text) returns uuid
language sql stable as $$ select k.id from k where k.key = p_key $$;

-- Deletes a row as the service does: no member has a delete path for these tables, except chat messages.
create function pg_temp.trash(p_table text, p_key text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  execute format('update app.%I set deleted_at = now() where id = $1', p_table) using pg_temp.k(p_key);
end $$;

create function pg_temp.live(p_table text, p_key text) returns boolean
language plpgsql as $$
declare
  v_live boolean;
begin
  perform pg_temp.as_platform();
  execute format('select deleted_at is null from app.%I where id = $1', p_table) into v_live using pg_temp.k(p_key);
  return v_live;
end $$;

-- Every table in Trash has a restore path -----------------------------------------------------------------------------

select is_empty($$select tt.table_name from private.trash_tables tt
    where tt.table_name not in (select private.trash_ruled_tables())
      and not (has_column_privilege('authenticated', ('app.' || tt.table_name)::regclass, 'deleted_at', 'update')
               and exists (select 1 from pg_policy p where p.polrelid = ('app.' || tt.table_name)::regclass
                           and p.polcmd in ('w', '*') and p.polpermissive))$$,
  'every table in Trash lets members update deleted_at under an update policy, or has a restore rule');
select results_eq($$select t from private.trash_ruled_tables() t order by 1$$,
  $$values ('chat_messages'), ('feed_posts'), ('occupancy_counters'), ('party_threads'), ('poll_options'), ('rating_replies'),
    ('shared_reports'), ('support_tickets'), ('surveys')$$, 'nine tables are restored by rule');
select is_empty($$select t from private.trash_ruled_tables() t where t not in (select table_name from private.trash_tables)$$,
  'and each of them is in Trash');
select is_empty($$select t from private.trash_ruled_tables() t
    where has_column_privilege('authenticated', ('app.' || t)::regclass, 'deleted_at', 'update')$$,
  'none lets a member update deleted_at, so the rule is the only way back and nobody gains a way to delete');
select is(app.restore_trash_row_by_rule('budgets', gen_random_uuid()), null, 'a table with its own update policy has no rule');
select ok(not has_function_privilege('anon', 'app.restore_trash_row_by_rule(text, uuid)', 'execute')
  and not has_function_privilege('anon', 'app.trash_returns_with_parent(text)', 'execute'), 'anon runs none of it');

-- World -----------------------------------------------------------------------------------------------------------------

select pg_temp.as_user('dave');
insert into k select 'ticket', app.open_support_ticket(pg_temp.id('org_a'), 'Organization', 'Access', 'Cannot open the Access Grid',
  'The grid page shows an error after I pick a zone.');
insert into k select 'pollpost', app.create_feed_post(pg_temp.id('org_a'), 'Poll', 'Pick the crew meal.', p_poll =>
  '{"question": "Which crew meal on Saturday?", "options": ["Tacos", "Pasta", "Salad"]}'::jsonb);
select pg_temp.as_user('bob');
insert into k select 'platform_ticket', app.open_support_ticket(pg_temp.id('org_a'), 'Platform', 'Problem', 'Slow page',
  'The schedule loads slowly.');
select pg_temp.as_user('carol');
insert into k select 'post', app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Load-in starts at 06:00.', 'Load-In Time');
insert into k select 'survey', app.create_survey(pg_temp.id('org_a'), 'Load-In Pulse',
  '[{"prompt": "How safe did the load-in feel?", "kind": "Scale", "scale_max": 5}]'::jsonb, p_min_responses => 3::smallint);
select app.transition_survey(pg_temp.k('survey'), 'Draft', 'Open', 'Ready.');
select pg_temp.as_user('alice');
with s as (insert into app.spaces (venue_id, name, capacity) values (pg_temp.id('venue_a'), 'VIP Deck', 10) returning id)
  insert into k select 'deck', id from s;
select pg_temp.as_user('carol');
insert into k select 'counter', app.create_occupancy_counter(pg_temp.id('prj_a'), 'VIP Deck', pg_temp.k('deck'));
insert into k select 'old_counter', app.create_occupancy_counter(pg_temp.id('prj_a'), 'VIP Deck Stairs', pg_temp.k('deck'));
select pg_temp.as_user('frank');
insert into k select 'dm', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('dave@org_a'));
insert into k select 'msg', app.send_chat_message(pg_temp.k('dm'), 'Points are up on stage left.');
insert into k select 'bad_msg', app.send_chat_message(pg_temp.k('dm'), 'Send me your home address or else.');
select pg_temp.as_platform();
insert into k select 'option', o.id from app.poll_options o join app.polls p on p.id = o.poll_id
  where p.feed_post_id = pg_temp.k('pollpost') and o.position = 2;

-- support_tickets: the requester, or a responder of the Organization queue ------------------------------------------------

select pg_temp.trash('support_tickets', 'ticket');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.trash_items where subject_table = 'support_tickets' and subject_id = pg_temp.k('ticket')), 1,
  'a deleted support ticket is in the requester''s Trash');
select pg_temp.as_user('frank');
select throws_ok($$select app.restore_trash_item('support_tickets', pg_temp.k('ticket'))$$, '42501', 'the row is not visible to you',
  'a member who does not read the ticket cannot restore it');
select pg_temp.as_user('xavier');
select throws_ok($$select app.restore_trash_item('support_tickets', pg_temp.k('ticket'))$$, '42501', null, 'nor can another org');
select pg_temp.as_anon();
select throws_ok($$select app.restore_trash_item('support_tickets', pg_temp.k('ticket'))$$, '42501', null, 'nor anon');
select pg_temp.as_user('dave');
select is(app.restore_trash_item('support_tickets', pg_temp.k('ticket')), 1, 'the requester restores their support ticket');
select ok(pg_temp.live('support_tickets', 'ticket'), 'and it is live again');
select is((select count(*)::int from app.domain_events where event_type = 'trash.restored' and subject_id = pg_temp.k('ticket')), 1,
  'trash.restored was emitted');
select is((select updated_by from app.support_tickets where id = pg_temp.k('ticket')), pg_temp.id('dave'), 'and the ticket names who restored it');
select pg_temp.as_user('dave');
select throws_ok($$select app.restore_trash_item('support_tickets', pg_temp.k('ticket'))$$,
  'XR001', 'trash_not_deleted: This row is not in Trash.', 'a live ticket is not restored');
select pg_temp.trash('support_tickets', 'ticket');
select pg_temp.as_user('bob');
select is(app.restore_trash_item('support_tickets', pg_temp.k('ticket')), 1, 'a responder of the Organization queue restores it too');
select pg_temp.trash('support_tickets', 'platform_ticket');
select pg_temp.as_user('alice');
select throws_ok($$select app.restore_trash_item('support_tickets', pg_temp.k('platform_ticket'))$$,
  '42501', 'you cannot edit this row, so you cannot restore it', 'an admin who reads a Platform ticket they did not open cannot restore it');
select pg_temp.as_user('bob');
select is(app.restore_trash_item('support_tickets', pg_temp.k('platform_ticket')), 1, 'its requester can');

-- chat_messages: the author who deleted it, never one a moderator removed ---------------------------------------------------

select pg_temp.as_user('frank');
select app.delete_chat_message(pg_temp.k('msg'));
select is((select count(*)::int from app.trash_items where subject_table = 'chat_messages' and subject_id = pg_temp.k('msg')), 1,
  'a message its author deleted is in their Trash');
select pg_temp.as_user('dave');
select throws_ok($$select app.restore_trash_item('chat_messages', pg_temp.k('msg'))$$,
  '42501', 'you cannot edit this row, so you cannot restore it', 'someone else in the conversation cannot restore it');
select pg_temp.as_user('bob');
select throws_ok($$select app.restore_trash_item('chat_messages', pg_temp.k('msg'))$$, '42501', 'the row is not visible to you',
  'nor an admin outside the conversation');
select pg_temp.as_user('frank');
select is(app.restore_trash_item('chat_messages', pg_temp.k('msg')), 1, 'the author restores the message they deleted');
select pg_temp.as_platform();
select is((select body from app.chat_messages where id = pg_temp.k('msg') and deleted_at is null), 'Points are up on stage left.',
  'and it is back as it was');
select pg_temp.as_user('frank');
select lives_ok($$select app.edit_chat_message(pg_temp.k('msg'), 'Points are up on stage right.')$$, 'a restored message is edited again');

select pg_temp.as_user('dave');
select app.report_content('Chat Message', pg_temp.k('bad_msg'), 'Violence');
select pg_temp.as_user('bob');
select app.decide_content_report(pg_temp.id('org_a'), 'Chat Message', pg_temp.k('bad_msg'), 'Removed', 'Terms Violation',
  'Acceptable Use Policy 1', 'The message threatens a crew member.', 'We removed your message because it threatens a crew member.');
select ok(not pg_temp.live('chat_messages', 'bad_msg'), 'a moderator removes a reported message');
select pg_temp.as_user('frank');
select throws_ok($$select app.restore_trash_item('chat_messages', pg_temp.k('bad_msg'))$$,
  'XR001', 'trash_removed_by_moderation: A moderator removed this message, so it is not restored from Trash.',
  'its author cannot restore a message a moderator removed');
select pg_temp.as_platform();
select throws_ok($$update app.chat_messages set deleted_at = null where id = pg_temp.k('bad_msg')$$,
  'XR001', 'chat_message_deleted: A deleted message does not change.', 'and outside the Trash restore a deleted message still never changes');
select pg_temp.as_user('frank');
select app.delete_chat_message(pg_temp.k('msg'));
select pg_temp.as_platform();
select private.begin_trusted_operation('trash_restore');
select throws_ok($$update app.chat_messages set deleted_at = null, body = 'Rewritten.' where id = pg_temp.k('msg')$$,
  'XR001', 'chat_message_deleted: A deleted message does not change.', 'the restore itself brings a message back unchanged or not at all');
select private.end_trusted_operation('trash_restore');

-- feed_posts: the author or a communication admin ------------------------------------------------------------------------

select pg_temp.trash('feed_posts', 'post');
select pg_temp.as_user('dave');
select throws_ok($$select app.restore_trash_item('feed_posts', pg_temp.k('post'))$$,
  '42501', 'you cannot edit this row, so you cannot restore it', 'a member who reads a post they did not write cannot restore it');
select pg_temp.as_user('xavier');
select throws_ok($$select app.restore_trash_item('feed_posts', pg_temp.k('post'))$$, '42501', null, 'nor another org');
select pg_temp.as_user('carol');
select is(app.restore_trash_item('feed_posts', pg_temp.k('post')), 1, 'the author restores their post');
select ok(pg_temp.live('feed_posts', 'post'), 'and it is live again');
select pg_temp.trash('feed_posts', 'post');
select pg_temp.as_user('bob');
select is(app.restore_trash_item('feed_posts', pg_temp.k('post')), 1, 'a communication admin restores it too');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'trash.restored' and subject_id = pg_temp.k('post')), 2,
  'each restore emits trash.restored');

-- poll_options: the same people, through the poll's post -------------------------------------------------------------------

select pg_temp.trash('poll_options', 'option');
select pg_temp.as_user('carol');
select throws_ok($$select app.restore_trash_item('poll_options', pg_temp.k('option'))$$,
  '42501', 'you cannot edit this row, so you cannot restore it', 'a Manager who did not post the poll cannot restore its option');
select pg_temp.as_user('dave');
select is(app.restore_trash_item('poll_options', pg_temp.k('option')), 1, 'the poll''s author restores the option');
select ok(pg_temp.live('poll_options', 'option'), 'and it is live again');
select pg_temp.trash('poll_options', 'option');
select pg_temp.as_user('bob');
select is(app.restore_trash_item('poll_options', pg_temp.k('option')), 1, 'a communication admin restores it too');

-- surveys: the author or knowledge.sop.publish -----------------------------------------------------------------------------

select pg_temp.trash('surveys', 'survey');
select pg_temp.as_user('frank');
select throws_ok($$select app.restore_trash_item('surveys', pg_temp.k('survey'))$$,
  '42501', 'you cannot edit this row, so you cannot restore it', 'a Field member in the survey''s audience cannot restore it');
select pg_temp.as_user('xavier');
select throws_ok($$select app.restore_trash_item('surveys', pg_temp.k('survey'))$$, '42501', null, 'nor another org');
select pg_temp.as_user('carol');
select is(app.restore_trash_item('surveys', pg_temp.k('survey')), 1, 'the author restores their survey');
select is((select survey_state::text from app.surveys where id = pg_temp.k('survey') and deleted_at is null), 'Open',
  'and it comes back in the state it had');
select pg_temp.trash('surveys', 'survey');
select pg_temp.as_user('dave');
select is(app.restore_trash_item('surveys', pg_temp.k('survey')), 1, 'a member who may open and close surveys restores it too');

-- occupancy_counters: safety.emergency_code.write ---------------------------------------------------------------------------

select pg_temp.trash('occupancy_counters', 'counter');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.trash_items where subject_table = 'occupancy_counters' and subject_id = pg_temp.k('counter')), 1,
  'a Field member of the project sees the deleted counter in Trash');
select throws_ok($$select app.restore_trash_item('occupancy_counters', pg_temp.k('counter'))$$,
  '42501', 'you cannot edit this row, so you cannot restore it', 'and cannot restore it');
select pg_temp.as_user('xavier');
select throws_ok($$select app.restore_trash_item('occupancy_counters', pg_temp.k('counter'))$$, '42501', null, 'nor another org');
select pg_temp.as_user('carol');
select is(app.restore_trash_item('occupancy_counters', pg_temp.k('counter')), 1, 'a Manager who sets up counters restores it');
select ok(pg_temp.live('occupancy_counters', 'counter'), 'and it is live again');
select pg_temp.as_platform();
update app.occupancy_counters set deleted_at = now() - interval '8 years' where id = pg_temp.k('old_counter');
select pg_temp.as_user('carol');
select throws_ok($$select app.restore_trash_item('occupancy_counters', pg_temp.k('old_counter'))$$,
  'XR001', 'trash_restore_expired: Its retention period has ended; it is about to be purged and cannot be restored.',
  'a counter past its retention period is not restored');
select pg_temp.claims('carol');
select throws_ok($$select app.restore_trash_row_by_rule('occupancy_counters', pg_temp.k('old_counter'))$$,
  'XR001', 'trash_restore_expired: Its retention period has ended; it is about to be purged and cannot be restored.',
  'the rule refuses it by itself too');
select pg_temp.as_platform();
select ok(not private.in_trusted_operation('trash_restore'), 'no restore leaves its trusted operation open');

-- The cascade leaves rows that never come back -----------------------------------------------------------------------------

select ok(not app.trash_returns_with_parent('team_members') and not app.trash_returns_with_parent('api_keys')
  and not app.trash_returns_with_parent('medical_encounters'), 'access, credentials and restricted records never come back with a parent');
select ok(app.trash_returns_with_parent('application_template_questions') and app.trash_returns_with_parent('run_segment_colors')
  and app.trash_returns_with_parent('budget_lines'), 'parts of a row, and tables in Trash, come back with it');
select is_empty($$select table_name from private.trash_excluded_tables where not returns_with_parent
    and rationale ~* 'restored from Trash with|comes back with|returns with|restored with its'$$,
  'no table whose rationale says it returns with its parent is marked as never coming back');
update app.teams set deleted_at = now() where id = pg_temp.id('team_a');
update app.team_members set deleted_at = now() where team_id = pg_temp.id('team_a');
select pg_temp.as_user('alice');
select is(app.restore_trash_item('teams', pg_temp.id('team_a')), 1, 'restoring a team restores the team alone');
select pg_temp.as_platform();
select is((select count(*)::int from app.team_members where team_id = pg_temp.id('team_a') and deleted_at is null), 0,
  'its members, removed with it, stay removed');
select pg_temp.as_user('alice');
select lives_ok($$update app.team_members set deleted_at = null where team_id = pg_temp.id('team_a')$$,
  'though the restorer may update team members: the walk left them on purpose');
select pg_temp.as_platform();
select is((select count(*)::int from app.team_members where team_id = pg_temp.id('team_a') and deleted_at is null), 1,
  'and adding them back is that person''s own act');

select * from finish();
rollback;
