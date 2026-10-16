-- 0800_workforce_groups_chat.sql
-- A29 Workforce Suite (Section 4.9): audiences, group spaces and chat.
--   * Audiences: feed posts, surveys and events reach the whole org, a project, a team, an org role or a
--     group. Department audiences are groups of kind Department (the org has no department membership
--     table). private.in_audience takes the row's audience columns as arguments (ADR 0016 rule 14).
--   * Groups: spaces by department, project, crew or a custom audience, with chat and files. Holders of
--     org.communication.write create and manage them (Settings, Communication); a group's owners add and
--     remove members.
--   * Chat: one-to-one and group conversations between active members of one org. Every group has one
--     conversation whose members follow the group. Messages are written only through the RPCs, which
--     notify the other members (Section 4.9 Chat). Photos, files and voice notes are A18 attachments on
--     the message. Read receipts are an org setting (1010); offline sends replay through
--     app.apply_sync_mutation (0807 allowlists the RPCs).

create type app.audience_kind as enum ('Organization', 'Project', 'Team', 'Role', 'Group');
comment on type app.audience_kind is 'Who a feed post, survey or event reaches: the whole org, one project, one team, one org role or one group (department groups included).';

create type app.group_kind as enum ('Department', 'Project', 'Crew', 'Custom');
comment on type app.group_kind is 'What a group space gathers: a department, a project''s people, a crew or a custom audience.';

create type app.group_role as enum ('Owner', 'Member');
comment on type app.group_role is 'A group member''s role: owners add and remove members.';

create type app.conversation_kind as enum ('Direct', 'Group');
comment on type app.conversation_kind is 'A one-to-one conversation between two members, or the conversation of a group.';

create type app.chat_message_kind as enum ('Text', 'Photo', 'File', 'Voice');
comment on type app.chat_message_kind is 'What a chat message carries: text, or a photo, file or voice note attached to it.';

insert into private.domain_event_types (code, subject, description) values
  ('group.created', 'groups', 'A group space was created.'),
  ('group.archived', 'groups', 'A group space was archived.'),
  ('group_member.added', 'group_members', 'A member joined a group space.'),
  ('group_member.removed', 'group_members', 'A member left or was removed from a group space.'),
  ('conversation.started', 'conversations', 'A one-to-one conversation was started.'),
  ('chat_message.sent', 'chat_messages', 'A chat message was sent.'),
  ('chat_message.deleted', 'chat_messages', 'The author deleted a chat message.');

-- Notification categories and kinds for the whole suite (A18 notifications, 0520). Messages and feed are
-- their own categories so members tune them apart from comments; site alerts are Safety (urgent).
insert into private.notification_categories (code, urgent, sort_order) values
  ('messages', false, 40),
  ('feed', false, 41);

insert into private.notification_templates (kind, channel, category_code, email_template_code)
select k.kind, c.channel, k.category, case when c.channel = 'Email' then 'notification' end
from (values
  ('message.received', 'messages'),
  ('announcement.posted', 'feed'),
  ('survey.opened', 'feed'),
  ('recognition.received', 'feed'),
  ('event.invited', 'schedule'),
  ('training.assigned', 'assignments'),
  ('help_request.assigned', 'assignments'),
  ('occupancy.threshold', 'safety'),
  ('weather.alert', 'safety')
) as k (kind, category)
cross join (values ('In App'::app.notification_channel), ('Email'), ('SMS'), ('Push')) as c (channel);

-- Membership helpers ------------------------------------------------------------------------------------------

create or replace function private.my_membership_in(p_org_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from app.memberships m
  where m.org_id = p_org_id and m.id in (select private.my_membership_ids())
  order by m.valid_from desc limit 1;
$$;
comment on function private.my_membership_in(uuid) is 'The signed-in person''s active membership in an org, or null.';
revoke all on function private.my_membership_in(uuid) from public, anon;
grant execute on function private.my_membership_in(uuid) to authenticated, service_role;

create or replace function private.require_membership_in(p_org_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership uuid := private.my_membership_in(p_org_id);
begin
  perform private.require_person();
  if v_membership is null then
    raise exception using errcode = '42501', message = 'only an active member of the org can do this';
  end if;
  return v_membership;
end;
$$;
comment on function private.require_membership_in(uuid) is 'The signed-in person''s active membership in an org, or an insufficient privilege error.';
revoke all on function private.require_membership_in(uuid) from public, anon;
grant execute on function private.require_membership_in(uuid) to authenticated, service_role;

-- Groups ----------------------------------------------------------------------------------------------------------

create table app.groups (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  group_kind app.group_kind not null,
  project_id uuid references app.projects (id),
  description text,
  archived_at timestamptz,
  constraint groups_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint groups_description_length check (description is null or char_length(description) <= 2000),
  constraint groups_project_kind check ((group_kind = 'Project') = (project_id is not null))
);
create index groups_project_idx on app.groups (project_id);
call private.install_domain_table('app.groups', null, null, array['app.projects', 'project_id']);
create unique index groups_name_key on app.groups (org_id, lower(btrim(name))) where deleted_at is null;
call private.describe('app.groups', 'A group space (Section 4.9 Groups): a department, project, crew or custom audience with its own chat and files. Managed in Settings, Communication.', array[
  'name', 'Group name, unique in the org.',
  'group_kind', 'Department, Project, Crew or Custom.',
  'project_id', 'Project a Project group gathers; set only for Project groups.',
  'description', 'What the group is for.',
  'archived_at', 'When the group was archived. An archived group keeps its history and takes no new messages.'
]);

create table app.group_members (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  group_id uuid not null references app.groups (id),
  membership_id uuid not null references app.memberships (id),
  group_role app.group_role not null default 'Member'
);
create index group_members_membership_idx on app.group_members (membership_id);
call private.install_domain_table('app.group_members', 'app.groups', 'group_id', array['app.memberships', 'membership_id']);
create unique index group_members_key on app.group_members (group_id, membership_id) where deleted_at is null;
call private.describe('app.group_members', 'Members of a group space. Removing a member soft deletes the row.', array[
  'group_id', 'Group the member belongs to.',
  'membership_id', 'Member of the org in the group.',
  'group_role', 'Owner or Member; owners add and remove members.'
]);

create or replace function private.my_group_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select gm.group_id from app.group_members gm
  where gm.deleted_at is null and gm.membership_id in (select private.my_membership_ids());
$$;
comment on function private.my_group_ids() is 'Groups the signed-in person belongs to.';
revoke all on function private.my_group_ids() from public, anon;
grant execute on function private.my_group_ids() to authenticated, service_role;

create or replace function private.my_owned_group_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select gm.group_id from app.group_members gm
  where gm.deleted_at is null and gm.group_role = 'Owner' and gm.membership_id in (select private.my_membership_ids());
$$;
comment on function private.my_owned_group_ids() is 'Groups the signed-in person owns.';
revoke all on function private.my_owned_group_ids() from public, anon;
grant execute on function private.my_owned_group_ids() to authenticated, service_role;

call private.install_policies('app.groups',
  $$id = any (array(select private.my_group_ids())) or org_id = any (array(select private.orgs_with_capability('org.communication.write')))$$,
  $$org_id in (select private.orgs_with_capability('org.communication.write'))$$);

call private.install_policies('app.group_members',
  $$group_id = any (array(select private.my_group_ids())) or org_id = any (array(select private.orgs_with_capability('org.communication.write')))$$,
  $$group_id = any (array(select private.my_owned_group_ids())) or org_id = any (array(select private.orgs_with_capability('org.communication.write')))$$);

-- A group keeps its kind and project; an archived group stays archived.
create or replace function private.guard_group()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.group_kind <> old.group_kind or new.project_id is distinct from old.project_id then
      perform private.refuse('group_kind_fixed', 'A group keeps its kind and project; create a new group instead.');
    end if;
    if old.archived_at is not null and new.archived_at is distinct from old.archived_at then
      perform private.refuse('group_archived', 'An archived group stays archived; create a new group instead.');
    end if;
  elsif new.archived_at is not null then
    perform private.refuse('group_archived', 'A group is created active.');
  end if;
  return new;
end;
$$;
comment on function private.guard_group() is 'Groups keep their kind and project, and archiving is final.';
revoke all on function private.guard_group() from public, anon, authenticated;
create trigger t42_guard_group before insert or update on app.groups
  for each row execute function private.guard_group();

-- A member row keeps its group and member; the members of an archived group are fixed.
create or replace function private.guard_group_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select g.archived_at from app.groups g where g.id = new.group_id) is not null then
    perform private.refuse('group_archived', 'An archived group''s members do not change.');
  end if;
  if tg_op = 'UPDATE' and (new.group_id <> old.group_id or new.membership_id <> old.membership_id) then
    perform private.refuse('group_member_fixed', 'A group member row keeps its group and member; remove it and add the member again.');
  end if;
  if tg_op = 'UPDATE' and old.deleted_at is not null and new.deleted_at is null then
    perform private.refuse('group_member_fixed', 'A removed member is added again as a new row.');
  end if;
  return new;
end;
$$;
comment on function private.guard_group_member() is 'Group members keep their group and member, and an archived group''s members are fixed.';
revoke all on function private.guard_group_member() from public, anon, authenticated;
create trigger t42_guard_group_member before insert or update on app.group_members
  for each row execute function private.guard_group_member();

create trigger t90_emit_group_created after insert on app.groups
  for each row execute function private.emit_row_event('group.created', 'project_id', 'name', 'group_kind');
create trigger t90_emit_group_archived after update of archived_at on app.groups
  for each row when (old.archived_at is null and new.archived_at is not null)
  execute function private.emit_row_event('group.archived', 'project_id', 'name');
create trigger t90_emit_group_member_added after insert on app.group_members
  for each row execute function private.emit_row_event('group_member.added', '-', 'group_id', 'membership_id', 'group_role');
create trigger t90_emit_group_member_removed after update of deleted_at on app.group_members
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_row_event('group_member.removed', '-', 'group_id', 'membership_id');

-- Audiences -------------------------------------------------------------------------------------------------------

-- Whether the signed-in person is in an audience. Takes the row's audience columns, so policies never
-- re-read their own table (ADR 0016 rule 14).
create or replace function private.in_audience(
  p_org_id uuid,
  p_kind app.audience_kind,
  p_project_id uuid,
  p_team_id uuid,
  p_role_id uuid,
  p_group_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.my_membership_in(p_org_id) is not null and case p_kind
    when 'Organization' then true
    when 'Project' then p_project_id in (select private.readable_project_ids())
    when 'Team' then exists (select 1 from app.team_members tm
      where tm.team_id = p_team_id and tm.deleted_at is null and tm.membership_id in (select private.my_membership_ids()))
    when 'Role' then exists (select 1 from app.membership_roles mr
      where mr.role_id = p_role_id and mr.deleted_at is null and mr.membership_id in (select private.my_membership_ids()))
    when 'Group' then p_group_id in (select private.my_group_ids())
    else false
  end;
$$;
comment on function private.in_audience(uuid, app.audience_kind, uuid, uuid, uuid, uuid) is 'Whether the signed-in person is in an audience: an active member of the org and, by kind, a reader of the project, a member of the team, a holder of the role or a member of the group.';
revoke all on function private.in_audience(uuid, app.audience_kind, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function private.in_audience(uuid, app.audience_kind, uuid, uuid, uuid, uuid) to authenticated, service_role;

-- Active memberships in an audience, for notifications and acknowledgment tracking.
create or replace function private.audience_membership_ids(
  p_org_id uuid,
  p_kind app.audience_kind,
  p_project_id uuid,
  p_team_id uuid,
  p_role_id uuid,
  p_group_id uuid
)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from app.memberships m
  where m.org_id = p_org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    and case p_kind
      when 'Organization' then true
      when 'Project' then exists (select 1 from app.project_members pm
        where pm.project_id = p_project_id and pm.membership_id = m.id and pm.deleted_at is null
          and pm.valid_from <= now() and (pm.valid_to is null or pm.valid_to > now()))
      when 'Team' then exists (select 1 from app.team_members tm where tm.team_id = p_team_id and tm.membership_id = m.id and tm.deleted_at is null)
      when 'Role' then exists (select 1 from app.membership_roles mr where mr.role_id = p_role_id and mr.membership_id = m.id and mr.deleted_at is null)
      when 'Group' then exists (select 1 from app.group_members gm where gm.group_id = p_group_id and gm.membership_id = m.id and gm.deleted_at is null)
      else false
    end;
$$;
comment on function private.audience_membership_ids(uuid, app.audience_kind, uuid, uuid, uuid, uuid) is 'Active memberships an audience reaches. Project audiences count the project''s members (org-wide readers are not notified).';
revoke all on function private.audience_membership_ids(uuid, app.audience_kind, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function private.audience_membership_ids(uuid, app.audience_kind, uuid, uuid, uuid, uuid) to service_role;

-- Checks an audience's columns: the kind names exactly its target, in the same org.
create or replace function private.assert_audience(
  p_org_id uuid,
  p_kind app.audience_kind,
  p_project_id uuid,
  p_team_id uuid,
  p_role_id uuid,
  p_group_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (p_kind = 'Team') <> (p_team_id is not null) or (p_kind = 'Role') <> (p_role_id is not null)
     or (p_kind = 'Group') <> (p_group_id is not null) or (p_kind = 'Project' and p_project_id is null) then
    perform private.refuse('audience_target', 'Choose the audience''s project, team, role or group, and only that one.');
  end if;
  if p_team_id is not null and not exists (select 1 from app.teams t where t.id = p_team_id and t.org_id = p_org_id and t.deleted_at is null) then
    perform private.refuse('audience_target', 'The team is not in this org.');
  end if;
  if p_role_id is not null and not exists (select 1 from app.roles r where r.id = p_role_id and (r.org_id is null or r.org_id = p_org_id) and r.deleted_at is null) then
    perform private.refuse('audience_target', 'The role is not available in this org.');
  end if;
  if p_group_id is not null and not exists (select 1 from app.groups g where g.id = p_group_id and g.org_id = p_org_id and g.deleted_at is null and g.archived_at is null) then
    perform private.refuse('audience_target', 'The group is not an active group of this org.');
  end if;
end;
$$;
comment on function private.assert_audience(uuid, app.audience_kind, uuid, uuid, uuid, uuid) is 'Refuses an audience whose kind and target disagree, or whose team, role or group is outside the org.';
revoke all on function private.assert_audience(uuid, app.audience_kind, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- Conversations ------------------------------------------------------------------------------------------------------

create table app.conversations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  conversation_kind app.conversation_kind not null,
  group_id uuid references app.groups (id),
  direct_key text,
  last_message_at timestamptz,
  constraint conversations_kind_target check (
    (conversation_kind = 'Group' and group_id is not null and direct_key is null)
    or (conversation_kind = 'Direct' and group_id is null and direct_key is not null)),
  constraint conversations_direct_key_format check (direct_key is null or direct_key ~ '^[0-9a-f-]{36}:[0-9a-f-]{36}$')
);
create unique index conversations_group_key on app.conversations (group_id);
create unique index conversations_direct_key on app.conversations (org_id, direct_key);
call private.install_domain_table('app.conversations', null, null, array['app.groups', 'group_id']);
call private.describe('app.conversations', 'A chat conversation (Section 4.9 Chat): one-to-one between two members, or the conversation of a group. Created only by the chat RPCs and group triggers.', array[
  'conversation_kind', 'Direct or Group.',
  'group_id', 'Group whose conversation this is; set for Group conversations.',
  'direct_key', 'The two membership ids of a Direct conversation, sorted and joined by a colon, so each pair has one conversation.',
  'last_message_at', 'When the latest message was sent, for sorting.'
]);

create table app.conversation_members (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  conversation_id uuid not null references app.conversations (id),
  membership_id uuid not null references app.memberships (id),
  last_read_at timestamptz,
  muted boolean not null default false
);
create index conversation_members_membership_idx on app.conversation_members (membership_id);
call private.install_domain_table('app.conversation_members', 'app.conversations', 'conversation_id', array['app.memberships', 'membership_id']);
create unique index conversation_members_key on app.conversation_members (conversation_id, membership_id) where deleted_at is null;
call private.describe('app.conversation_members', 'Who takes part in a conversation, with their read position. Group conversation members follow the group.', array[
  'conversation_id', 'Conversation.',
  'membership_id', 'Member taking part.',
  'last_read_at', 'When the member last read the conversation; drives unread counts and, when the org turns them on, read receipts.',
  'muted', 'Whether the member muted notifications for the conversation.'
]);

create table app.chat_messages (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  conversation_id uuid not null references app.conversations (id),
  author_membership_id uuid not null references app.memberships (id),
  message_kind app.chat_message_kind not null default 'Text',
  body text,
  language text,
  edited_at timestamptz,
  constraint chat_messages_body_length check (body is null or char_length(btrim(body)) between 1 and 4000),
  constraint chat_messages_text_has_body check (message_kind <> 'Text' or body is not null),
  constraint chat_messages_language_format check (language is null or language ~ '^[a-z]{2,3}(-[A-Z]{2})?$')
);
create index chat_messages_author_idx on app.chat_messages (author_membership_id);
call private.install_domain_table('app.chat_messages', 'app.conversations', 'conversation_id', array['app.memberships', 'author_membership_id']);
create index chat_messages_conversation_idx on app.chat_messages (conversation_id, created_at);
call private.describe('app.chat_messages', 'A chat message. Photos, files and voice notes are attachments on the message. Written only through app.send_chat_message; deleting soft deletes and hides it.', array[
  'conversation_id', 'Conversation the message belongs to.',
  'author_membership_id', 'Member who sent it.',
  'message_kind', 'Text, Photo, File or Voice.',
  'body', 'Message text; optional for a photo, file or voice note.',
  'language', 'Language the author wrote in (BCP 47), for translation.',
  'edited_at', 'When the author last edited the text.'
]);

create or replace function private.my_conversation_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select cm.conversation_id from app.conversation_members cm
  where cm.deleted_at is null and cm.membership_id in (select private.my_membership_ids());
$$;
comment on function private.my_conversation_ids() is 'Conversations the signed-in person takes part in.';
revoke all on function private.my_conversation_ids() from public, anon;
grant execute on function private.my_conversation_ids() to authenticated, service_role;

call private.install_policies('app.conversations', $$id in (select private.my_conversation_ids())$$);
call private.install_policies('app.conversation_members', $$conversation_id in (select private.my_conversation_ids())$$);
call private.install_policies('app.chat_messages', $$conversation_id in (select private.my_conversation_ids())$$);

-- Group conversations follow their group ---------------------------------------------------------------------------------

create or replace function private.open_group_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app.conversations (org_id, conversation_kind, group_id) values (new.org_id, 'Group', new.id);
  return null;
end;
$$;
comment on function private.open_group_conversation() is 'After insert on groups: opens the group''s conversation.';
revoke all on function private.open_group_conversation() from public, anon, authenticated;
create trigger t80_open_group_conversation after insert on app.groups
  for each row execute function private.open_group_conversation();

create or replace function private.sync_group_conversation_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation uuid := (select c.id from app.conversations c where c.group_id = new.group_id);
begin
  if new.deleted_at is null then
    insert into app.conversation_members (conversation_id, membership_id)
    select v_conversation, new.membership_id
    where not exists (select 1 from app.conversation_members cm
      where cm.conversation_id = v_conversation and cm.membership_id = new.membership_id and cm.deleted_at is null);
  else
    update app.conversation_members set deleted_at = now()
    where conversation_id = v_conversation and membership_id = new.membership_id and deleted_at is null;
  end if;
  return null;
end;
$$;
comment on function private.sync_group_conversation_member() is 'After a group member is added or removed: adds or removes them in the group conversation.';
revoke all on function private.sync_group_conversation_member() from public, anon, authenticated;
create trigger t80_sync_group_conversation_member after insert or update of deleted_at on app.group_members
  for each row execute function private.sync_group_conversation_member();

-- Chat messages keep their author, conversation and kind; only the author edits the text.
create or replace function private.guard_chat_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.conversation_id <> old.conversation_id or new.author_membership_id <> old.author_membership_id
     or new.message_kind <> old.message_kind or new.created_at <> old.created_at then
    perform private.refuse('chat_message_fixed', 'A message keeps its conversation, author and kind.');
  end if;
  if old.deleted_at is not null then
    perform private.refuse('chat_message_deleted', 'A deleted message does not change.');
  end if;
  return new;
end;
$$;
comment on function private.guard_chat_message() is 'Chat messages keep their conversation, author and kind; a deleted message is final.';
revoke all on function private.guard_chat_message() from public, anon, authenticated;
create trigger t42_guard_chat_message before update on app.chat_messages
  for each row execute function private.guard_chat_message();

-- RPCs --------------------------------------------------------------------------------------------------------------------

create or replace function app.start_direct_conversation(p_org_id uuid, p_other_membership_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_mine uuid := private.require_membership_in(p_org_id);
  v_key text;
  v_id uuid;
begin
  if p_other_membership_id = v_mine then
    perform private.refuse('conversation_self', 'Pick someone else to message.');
  end if;
  if not exists (select 1 from app.memberships m where m.id = p_other_membership_id and m.org_id = p_org_id and m.deleted_at is null
                 and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    perform private.refuse('conversation_member_inactive', 'You can message only active members of this org.');
  end if;
  v_key := least(v_mine::text, p_other_membership_id::text) || ':' || greatest(v_mine::text, p_other_membership_id::text);
  select c.id into v_id from app.conversations c where c.org_id = p_org_id and c.direct_key = v_key and c.deleted_at is null;
  if v_id is null then
    insert into app.conversations (org_id, conversation_kind, direct_key) values (p_org_id, 'Direct', v_key) returning id into v_id;
    insert into app.conversation_members (conversation_id, membership_id) values (v_id, v_mine), (v_id, p_other_membership_id);
    perform private.emit_event(p_org_id, 'conversation.started', 'conversations', v_id, null, jsonb_build_object('kind', 'Direct'));
  end if;
  return v_id;
end;
$$;
comment on function app.start_direct_conversation(uuid, uuid) is 'Opens, or returns, the one-to-one conversation between the signed-in member and another active member of the org. Returns the conversation id.';
revoke all on function app.start_direct_conversation(uuid, uuid) from public, anon;
grant execute on function app.start_direct_conversation(uuid, uuid) to authenticated, service_role;

create or replace function app.send_chat_message(
  p_conversation_id uuid,
  p_body text,
  p_message_kind app.chat_message_kind default 'Text',
  p_language text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_conversation app.conversations;
  v_mine uuid;
  v_id uuid;
  v_recipient record;
begin
  perform private.require_person();
  select * into v_conversation from app.conversations c where c.id = p_conversation_id and c.deleted_at is null;
  if v_conversation.id is null or v_conversation.id not in (select private.my_conversation_ids()) then
    raise exception using errcode = '42501', message = 'the conversation does not exist or you are not in it';
  end if;
  v_mine := private.my_membership_in(v_conversation.org_id);
  if v_conversation.group_id is not null
     and (select g.archived_at from app.groups g where g.id = v_conversation.group_id) is not null then
    perform private.refuse('group_archived', 'This group is archived and takes no new messages.');
  end if;
  insert into app.chat_messages (conversation_id, author_membership_id, message_kind, body, language)
  values (p_conversation_id, v_mine, p_message_kind, nullif(btrim(p_body), ''), nullif(btrim(p_language), ''))
  returning id into v_id;
  update app.conversations set last_message_at = now() where id = p_conversation_id;
  update app.conversation_members set last_read_at = now()
  where conversation_id = p_conversation_id and membership_id = v_mine and deleted_at is null;
  perform private.emit_event(v_conversation.org_id, 'chat_message.sent', 'chat_messages', v_id, null,
    jsonb_build_object('conversation_id', p_conversation_id, 'kind', p_message_kind));
  for v_recipient in
    select m.person_id from app.conversation_members cm join app.memberships m on m.id = cm.membership_id
    where cm.conversation_id = p_conversation_id and cm.deleted_at is null and not cm.muted and cm.membership_id <> v_mine
  loop
    perform private.notify(v_conversation.org_id, v_recipient.person_id, 'message.received', 'app.chat_messages', v_id, null,
      jsonb_build_object('conversation_id', p_conversation_id, 'kind', p_message_kind));
  end loop;
  return v_id;
end;
$$;
comment on function app.send_chat_message(uuid, text, app.chat_message_kind, text) is 'Sends a message to a conversation the signed-in member takes part in and notifies the other members who have not muted it. A photo, file or voice note is attached to the returned message id afterwards. Returns the message id.';
revoke all on function app.send_chat_message(uuid, text, app.chat_message_kind, text) from public, anon;
grant execute on function app.send_chat_message(uuid, text, app.chat_message_kind, text) to authenticated, service_role;

create or replace function app.edit_chat_message(p_message_id uuid, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_message app.chat_messages;
begin
  perform private.require_person();
  select * into v_message from app.chat_messages m where m.id = p_message_id and m.deleted_at is null;
  if v_message.id is null or v_message.author_membership_id not in (select private.my_membership_ids()) then
    raise exception using errcode = '42501', message = 'only the author edits a message';
  end if;
  update app.chat_messages set body = nullif(btrim(p_body), ''), edited_at = now() where id = p_message_id;
  return p_message_id;
end;
$$;
comment on function app.edit_chat_message(uuid, text) is 'The author edits the text of their message. Returns the message id.';
revoke all on function app.edit_chat_message(uuid, text) from public, anon;
grant execute on function app.edit_chat_message(uuid, text) to authenticated, service_role;

create or replace function app.delete_chat_message(p_message_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_message app.chat_messages;
begin
  perform private.require_person();
  select * into v_message from app.chat_messages m where m.id = p_message_id and m.deleted_at is null;
  if v_message.id is null or v_message.author_membership_id not in (select private.my_membership_ids()) then
    raise exception using errcode = '42501', message = 'only the author deletes a message';
  end if;
  update app.chat_messages set deleted_at = now() where id = p_message_id;
  perform private.emit_event(v_message.org_id, 'chat_message.deleted', 'chat_messages', p_message_id, null,
    jsonb_build_object('conversation_id', v_message.conversation_id));
  return p_message_id;
end;
$$;
comment on function app.delete_chat_message(uuid) is 'The author deletes their message; it disappears for everyone. Returns the message id.';
revoke all on function app.delete_chat_message(uuid) from public, anon;
grant execute on function app.delete_chat_message(uuid) to authenticated, service_role;

create or replace function app.mark_conversation_read(p_conversation_id uuid, p_muted boolean default null)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select c.org_id from app.conversations c where c.id = p_conversation_id and c.deleted_at is null);
  v_at timestamptz := now();
begin
  perform private.require_person();
  if v_org is null or p_conversation_id not in (select private.my_conversation_ids()) then
    raise exception using errcode = '42501', message = 'the conversation does not exist or you are not in it';
  end if;
  update app.conversation_members set last_read_at = v_at, muted = coalesce(p_muted, muted)
  where conversation_id = p_conversation_id and membership_id = private.my_membership_in(v_org) and deleted_at is null;
  return v_at;
end;
$$;
comment on function app.mark_conversation_read(uuid, boolean) is 'Marks a conversation read up to now for the signed-in member and optionally mutes or unmutes it. Returns the read time.';
revoke all on function app.mark_conversation_read(uuid, boolean) from public, anon;
grant execute on function app.mark_conversation_read(uuid, boolean) to authenticated, service_role;

-- My conversations with unread counts, newest first.
create or replace function app.my_conversations(p_org_id uuid)
returns table (
  conversation_id uuid,
  conversation_kind app.conversation_kind,
  group_id uuid,
  title text,
  other_membership_id uuid,
  last_message_at timestamptz,
  last_message_body text,
  unread_count integer,
  muted boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.conversation_kind, c.group_id,
    coalesce(g.name, other_person.full_name, ''),
    other.membership_id,
    c.last_message_at,
    (select m.body from app.chat_messages m where m.conversation_id = c.id and m.deleted_at is null order by m.created_at desc limit 1),
    (select count(*)::integer from app.chat_messages m
      where m.conversation_id = c.id and m.deleted_at is null and m.author_membership_id <> me.membership_id
        and (me.last_read_at is null or m.created_at > me.last_read_at)),
    me.muted
  from app.conversation_members me
  join app.conversations c on c.id = me.conversation_id and c.deleted_at is null
  left join app.groups g on g.id = c.group_id
  left join lateral (select cm.membership_id from app.conversation_members cm
    where cm.conversation_id = c.id and cm.deleted_at is null and cm.membership_id <> me.membership_id and c.conversation_kind = 'Direct'
    limit 1) other on true
  left join app.memberships om on om.id = other.membership_id
  left join app.people other_person on other_person.id = om.person_id
  where me.deleted_at is null and me.membership_id = private.my_membership_in(p_org_id) and c.org_id = p_org_id
  order by c.last_message_at desc nulls last, c.created_at desc;
$$;
comment on function app.my_conversations(uuid) is 'The signed-in member''s conversations in an org, newest activity first, with the other person or group as title, the latest message and the unread count.';
revoke all on function app.my_conversations(uuid) from public, anon;
grant execute on function app.my_conversations(uuid) to authenticated, service_role;

call private.install_default_retention('app.groups');
call private.install_default_retention('app.group_members');
call private.install_default_retention('app.conversations');
call private.install_default_retention('app.conversation_members');
call private.install_default_retention('app.chat_messages', interval '3 years');
