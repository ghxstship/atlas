-- pgTAP: migration 2922, B3 (RRR-227, ADR 0142). Show channels: opening one per project (seeded with the project's
-- members less Client-engaged people, the opener as Owner), joining, the panel's status, show_channel set only by the
-- database, and Clients kept out at the three doors: a Client is never added, a member who becomes a Client reads no
-- conversation, message or Inbox preview, and is never notified.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

create function pg_temp.k(p_key text) returns uuid
language sql stable as $$ select id from k where key = p_key $$;

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.try(p_who text, p_sql text) returns text
language plpgsql as $$
begin
  if p_who = 'platform' then
    perform pg_temp.as_platform();
  else
    perform pg_temp.as_user(p_who);
  end if;
  begin
    execute p_sql;
  exception
    when sqlstate 'XR001' then
      perform pg_temp.as_platform();
      return split_part(sqlerrm, ':', 1);
    when insufficient_privilege then
      perform pg_temp.as_platform();
      return '42501';
  end;
  perform pg_temp.as_platform();
  return 'ok';
end $$;

create function pg_temp.status(p_who text) returns text
language plpgsql as $$
declare v record;
begin
  perform pg_temp.as_user(p_who);
  select * into v from app.show_channel_status(pg_temp.id('prj_a'));
  perform pg_temp.as_platform();
  return format('exists=%s member=%s join=%s open=%s conversation=%s', v.channel_exists, v.am_member, v.can_join, v.can_open,
    v.conversation_id is not null);
end $$;

create function pg_temp.members() returns text
language sql as $$
  select string_agg(w.key || ':' || gm.group_role, ',' order by w.key)
  from app.group_members gm join world w on w.id = gm.membership_id
  where gm.group_id = (select id from k where key = 'group') and gm.deleted_at is null and w.key like '%@org_a'
$$;

-- A Client on the project: cleo through Coral Group, and frank, a member, engaged as Client too ---------------------------------
select pg_temp.new_user('cleo', 'cleo@coral-group.test', 'Cleo Marsh');
select pg_temp.as_user('cleo');
insert into world values ('acct_c', app.create_external_account('Coral Group', 'coral-group'));
select pg_temp.as_user('alice');
insert into world values ('cp_c_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_c')));
with x as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('frank'), pg_temp.id('cp_c_a'), 'Client', '2027-06-01') returning id)
  insert into world select 'eng_frank_client', id from x;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_frank_client', 'Onboarding', 'Active');

select is(pg_temp.status('dave'), 'exists=false member=false join=false open=true conversation=false',
  'before a channel exists, an editor may open one');
select is(pg_temp.status('gina'), 'exists=false member=false join=false open=false conversation=false',
  'a reader may not');
select is(pg_temp.try('gina', format('select app.open_show_channel(%L)', pg_temp.id('prj_a'))), '42501',
  'opening needs show.run_of_show.write');
select is(pg_temp.try('xavier', format('select app.show_channel_status(%L)', pg_temp.id('prj_a'))), '42501',
  'another org learns nothing');

-- Opening ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into k values ('conv', app.open_show_channel(pg_temp.id('prj_a')), null);
select pg_temp.as_platform();
insert into k select 'group', c.group_id, null from app.conversations c where c.id = pg_temp.k('conv');
select ok((select show_channel and group_kind = 'Project' and project_id = pg_temp.id('prj_a') from app.groups where id = pg_temp.k('group')),
  'the show channel is a Project group of the project');
select is((select name from app.groups where id = pg_temp.k('group')), 'Show channel · Northwind Summer Series', 'named for the project');
select is(pg_temp.members(), 'dave@org_a:Owner,erin@org_a:Member', 'the opener owns it and the project''s members are in it, less the Client');
select is((select count(*)::int from app.domain_events where event_type = 'show_channel.opened' and subject_id = pg_temp.k('group')), 1,
  'opening is a domain event');
select pg_temp.as_user('dave');
select is(app.open_show_channel(pg_temp.id('prj_a')), pg_temp.k('conv'), 'opening again answers the same channel');
select pg_temp.as_platform();
select is((select count(*)::int from app.groups where project_id = pg_temp.id('prj_a') and show_channel and deleted_at is null), 1,
  'a project has one live show channel');
select is(pg_temp.status('dave'), 'exists=true member=true join=false open=false conversation=true', 'the opener is in it');

-- show_channel is the database's ------------------------------------------------------------------------------------------------
select is(pg_temp.try('alice', format($$insert into app.groups (org_id, name, group_kind, project_id, show_channel)
  values (%L, 'Side channel', 'Project', %L, true)$$, pg_temp.id('org_a'), pg_temp.id('prj_a2'))), 'show_channel_fixed',
  'a show channel is never created by hand');
select is(pg_temp.try('alice', format('update app.groups set show_channel = false where id = %L', pg_temp.k('group'))), 'show_channel_fixed',
  'nor unmade');
select is(pg_temp.try('alice', format($$insert into app.groups (org_id, name, group_kind) values (%L, 'Lighting crew', 'Crew')$$,
  pg_temp.id('org_a'))), 'ok', 'other groups are made as before');

-- Joining ----------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.user_capability_grants (membership_id, capability_code, scope_kind, scope_id, reason) values
  (pg_temp.id('mia@org_a'), 'show.run_of_show.read', 'project', pg_temp.id('prj_a'), 'Follows the run.');
select pg_temp.as_platform();
select is(pg_temp.status('mia'), 'exists=true member=false join=true open=false conversation=false', 'a reader may join');
select is(pg_temp.n('mia', format('select 1 from app.groups where id = %L', pg_temp.k('group'))), 0, 'and cannot read the group yet');
select is(pg_temp.try('mia', format('select app.join_show_channel(%L)', pg_temp.id('prj_a'))), 'ok', 'joining');
select is(pg_temp.status('mia'), 'exists=true member=true join=false open=false conversation=true', 'puts the reader in it');
select is(pg_temp.try('frank', format('select app.join_show_channel(%L)', pg_temp.id('prj_a'))), 'show_channel_client',
  'a Client cannot join');
select is(pg_temp.status('frank'), 'exists=true member=false join=false open=false conversation=false', 'and is never offered to');
select is(pg_temp.try('alice', format('insert into app.group_members (group_id, membership_id) values (%L, %L)', pg_temp.k('group'),
  pg_temp.id('frank@org_a'))), 'show_channel_client', 'nor be added by an admin');

-- A member who becomes a Client reads nothing more, and is never notified ------------------------------------------------------------
select pg_temp.as_user('dave');
select app.send_chat_message(pg_temp.k('conv'), 'Standby house to half.');
select pg_temp.as_platform();
select is(pg_temp.n('erin', format('select 1 from app.chat_messages where conversation_id = %L', pg_temp.k('conv'))), 1, 'erin reads the message');
select is(pg_temp.n('erin', format('select 1 from app.my_conversations(%L) where conversation_id = %L', pg_temp.id('org_a'), pg_temp.k('conv'))), 1,
  'and sees the channel in her Inbox');
select is((select count(*)::int from app.notifications where kind = 'message.received' and recipient_person_id = pg_temp.id('erin')), 1,
  'and was notified');

select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('erin'), pg_temp.id('cp_c_a'), 'Client', '2027-06-01') returning id)
  insert into world select 'eng_erin_client', id from x;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_erin_client', 'Onboarding', 'Active');

select is(pg_temp.n('erin', format('select 1 from app.chat_messages where conversation_id = %L', pg_temp.k('conv'))), 0,
  'once engaged as Client, erin reads no message');
select is(pg_temp.n('erin', format('select 1 from app.conversations where id = %L', pg_temp.k('conv'))), 0, 'nor the conversation');
select is(pg_temp.n('erin', format('select 1 from app.my_conversations(%L) where conversation_id = %L', pg_temp.id('org_a'), pg_temp.k('conv'))), 0,
  'and her Inbox lists no row, preview or count from it');
select is(pg_temp.status('erin'), 'exists=true member=false join=false open=false conversation=false', 'the panel offers her nothing');
select pg_temp.as_user('dave');
select app.send_chat_message(pg_temp.k('conv'), 'Go house to half.');
select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where kind = 'message.received' and recipient_person_id = pg_temp.id('erin')), 1,
  'and she is not notified of the new message');
select is((select count(*)::int from app.notifications where kind = 'message.received' and recipient_person_id = pg_temp.id('mia')), 2,
  'while the other members are, for both messages');
select is(pg_temp.try('erin', format($$select app.send_chat_message(%L, 'Hello')$$, pg_temp.k('conv'))), '42501', 'nor can she post');

select is(pg_temp.n('dave', format('select 1 from app.chat_messages where conversation_id = %L', pg_temp.k('conv'))), 2,
  'a crew member still reads every message');
select is(pg_temp.n('dave', format('select 1 from app.my_conversations(%L) where conversation_id = %L', pg_temp.id('org_a'), pg_temp.k('conv'))), 1,
  'and the Inbox still lists the channel');

-- Catalog -------------------------------------------------------------------------------------------------------------------------
select col_not_null('app', 'groups', 'show_channel', 'groups.show_channel is not null');
select col_default_is('app', 'groups', 'show_channel', 'false', 'and false by default');
select ok(not has_function_privilege('authenticated', 'private.person_engaged_as(uuid, uuid, app.external_role_type)', 'execute'),
  'person_engaged_as is for the database only');

select * from finish();
rollback;
