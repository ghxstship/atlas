-- pgTAP: group spaces, audiences and chat (A29, Section 4.9 Groups and Chat).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(42);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Groups ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$insert into app.groups (org_id, name, group_kind) values (pg_temp.id('org_a'), 'Riggers', 'Crew')$$,
  '42501', null, 'a member without org.communication.write cannot create a group');

select pg_temp.as_user('bob');
select lives_ok($$with g as (insert into app.groups (org_id, name, group_kind, description)
  values (pg_temp.id('org_a'), 'Rigging Crew', 'Crew', 'Everyone flying points.') returning id) insert into k select 'crew', id from g$$,
  'a communication admin creates a group');
select pg_temp.as_platform();
select is((select count(*)::integer from app.conversations where group_id = (select id from k where key = 'crew')), 1,
  'every group opens its conversation');
select pg_temp.as_user('bob');
select throws_ok($$insert into app.groups (org_id, name, group_kind) values (pg_temp.id('org_a'), 'Pier Project', 'Project')$$,
  '23514', null, 'a Project group needs its project');
select throws_ok($$insert into app.groups (org_id, name, group_kind) values (pg_temp.id('org_a'), 'rigging crew', 'Custom')$$,
  '23505', null, 'group names are unique in the org, ignoring case');
select lives_ok($$insert into app.group_members (group_id, membership_id, group_role) values
  ((select id from k where key = 'crew'), pg_temp.id('dave@org_a'), 'Owner'),
  ((select id from k where key = 'crew'), pg_temp.id('frank@org_a'), 'Member')$$, 'the admin adds members');
select pg_temp.as_platform();
select is((select count(*)::integer from app.conversation_members cm join app.conversations c on c.id = cm.conversation_id
  where c.group_id = (select id from k where key = 'crew') and cm.deleted_at is null), 2, 'group members join the group conversation');

select pg_temp.as_user('dave');
select lives_ok($$insert into app.group_members (group_id, membership_id) values ((select id from k where key = 'crew'), pg_temp.id('erin@org_a'))$$,
  'a group owner adds a member');
select pg_temp.as_user('frank');
select throws_ok($$insert into app.group_members (group_id, membership_id) values ((select id from k where key = 'crew'), pg_temp.id('gina@org_a'))$$,
  '42501', null, 'a plain group member cannot add members');
select is((select count(*)::integer from app.groups where org_id = pg_temp.id('org_a')), 1, 'a member reads the groups they belong to');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.groups where org_id = pg_temp.id('org_a')), 0, 'a non-member reads no group');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.groups where org_id = pg_temp.id('org_a')), 0, 'no cross-tenant group reads');
select pg_temp.as_anon();
select throws_ok($$select count(*) from app.groups$$, '42501', null, 'anon reads no groups');

-- A removed member leaves the conversation.
select pg_temp.as_user('dave');
update app.group_members set deleted_at = now() where group_id = (select id from k where key = 'crew') and membership_id = pg_temp.id('erin@org_a');
select is((select count(*)::integer from app.conversation_members cm join app.conversations c on c.id = cm.conversation_id
  where c.group_id = (select id from k where key = 'crew') and cm.membership_id = pg_temp.id('erin@org_a') and cm.deleted_at is null), 0,
  'a removed member leaves the group conversation');
select throws_ok($$update app.group_members set deleted_at = null where group_id = (select id from k where key = 'crew') and membership_id = pg_temp.id('erin@org_a')$$,
  'XR001', null, 'a removed member is added again as a new row');
select pg_temp.as_user('bob');
select throws_ok($$update app.groups set group_kind = 'Custom' where id = (select id from k where key = 'crew')$$, 'XR001', null,
  'a group keeps its kind');

-- Group chat ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
insert into k select 'crew_conv', id from app.conversations where group_id = (select id from k where key = 'crew');
select lives_ok($$insert into k select 'msg1', app.send_chat_message((select id from k where key = 'crew_conv'), 'Points are up on stage left.')$$,
  'a group member sends a message');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications n where n.subject_id = (select id from k where key = 'msg1') and n.kind = 'message.received'),
  1, 'the other member is notified');
select pg_temp.as_user('frank');
select throws_ok($$insert into app.chat_messages (conversation_id, author_membership_id, body) values ((select id from k where key = 'crew_conv'), pg_temp.id('frank@org_a'), 'Direct')$$,
  '42501', null, 'messages are sent only through the RPC');
select throws_ok($$select app.send_chat_message((select id from k where key = 'crew_conv'), null, 'Text')$$, '23514', null,
  'a text message needs text');
select lives_ok($$select app.send_chat_message((select id from k where key = 'crew_conv'), null, 'Voice')$$,
  'a voice note carries its attachment, not text');

select pg_temp.as_user('dave');
select is((select unread_count from app.my_conversations(pg_temp.id('org_a')) where conversation_id = (select id from k where key = 'crew_conv')),
  2, 'unread counts what others sent since the last read');
select app.mark_conversation_read((select id from k where key = 'crew_conv'));
select is((select unread_count from app.my_conversations(pg_temp.id('org_a')) where conversation_id = (select id from k where key = 'crew_conv')),
  0, 'reading clears the unread count');
select throws_ok($$select app.edit_chat_message((select id from k where key = 'msg1'), 'Changed')$$, '42501', null,
  'only the author edits a message');

select pg_temp.as_user('gina');
select throws_ok($$select app.send_chat_message((select id from k where key = 'crew_conv'), 'Hello')$$, '42501', null,
  'an outsider cannot post in a group conversation');
select is((select count(*)::integer from app.chat_messages where conversation_id = (select id from k where key = 'crew_conv')), 0,
  'an outsider reads no messages');

select pg_temp.as_user('frank');
select lives_ok($$select app.edit_chat_message((select id from k where key = 'msg1'), 'Points are up on stage right.')$$, 'the author edits');
select ok((select edited_at is not null from app.chat_messages where id = (select id from k where key = 'msg1')), 'an edit is stamped');
select lives_ok($$select app.delete_chat_message((select id from k where key = 'msg1'))$$, 'the author deletes');
select throws_ok($$select app.edit_chat_message((select id from k where key = 'msg1'), 'Again')$$, '42501', null, 'a deleted message is gone');

-- Archiving --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
update app.groups set archived_at = now() where id = (select id from k where key = 'crew');
select pg_temp.as_user('frank');
select throws_ok($$select app.send_chat_message((select id from k where key = 'crew_conv'), 'Anyone?')$$, 'XR001', null,
  'an archived group takes no messages');
select pg_temp.as_user('bob');
select throws_ok($$update app.groups set archived_at = null where id = (select id from k where key = 'crew')$$, 'XR001', null, 'archiving is final');

-- Direct conversations ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$insert into k select 'dm', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('frank@org_a'))$$,
  'a member starts a direct conversation');
select is(app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('frank@org_a')), (select id from k where key = 'dm'),
  'each pair has one direct conversation');
select pg_temp.as_user('frank');
select is(app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('carol@org_a')), (select id from k where key = 'dm'),
  'either side finds the same conversation');
select is((select title from app.my_conversations(pg_temp.id('org_a')) where conversation_id = (select id from k where key = 'dm')),
  'Carol Nguyen', 'a direct conversation is titled with the other person');
select throws_ok($$select app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('frank@org_a'))$$, 'XR001', null,
  'nobody messages themselves');
select throws_ok($$select app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('xavier@org_b'))$$, 'XR001', null,
  'direct conversations stay inside one org');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.conversations where id = (select id from k where key = 'dm')), 0,
  'a third member reads nobody else''s direct conversation');

-- Audiences ------------------------------------------------------------------------------------------------------------------
select pg_temp.claims('erin');
select ok(private.in_audience(pg_temp.id('org_a'), 'Team', null, pg_temp.id('team_a'), null, null), 'a team member is in the team audience');
select pg_temp.claims('dave');
select ok(not private.in_audience(pg_temp.id('org_a'), 'Team', null, pg_temp.id('team_a'), null, null), 'others are not in a team audience');

-- Events are scoped to this world.
select pg_temp.as_platform();
select is((select count(*)::integer from app.domain_events where org_id = pg_temp.id('org_a')
  and event_type in ('group.created', 'group.archived', 'group_member.added', 'group_member.removed', 'conversation.started', 'chat_message.sent', 'chat_message.deleted')),
  10, 'groups and chat emit their domain events (1 group, 3 adds, 1 removal, 1 archive, 2 sends, 1 delete, 1 direct start)');

select * from finish();
rollback;
