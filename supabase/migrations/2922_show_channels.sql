-- 2922_show_channels.sql
-- B3 Show channels (RRR-227, ADR 0142 decision 9; parity gap G-79). The crew talks beside the running cue in a show
-- channel: the chat of a Project group (0800) marked show_channel, at most one live per project. Clients never take
-- part, at any of the three doors.
--
--   * Add: private.guard_group_member, restated from its only definition (0800), refuses a member whose person is
--     engaged as Client on the channel's project (show_channel_client). private.person_engaged_as answers for another
--     person: their own Client engagement on the project, or else private.engaged_as evaluated as their user, with the
--     claims switched and restored as private.live_link_reader does (2781).
--   * Read: private.my_conversation_ids, restated from 0800, drops the show channels of projects the signed-in person
--     reaches as Client, so a member who becomes a Client after joining reads nothing more. One set-based subquery over
--     the show channels the person is in keeps the Inbox's cost flat. app.my_conversations (1631) read the members
--     table directly, so it is restated to stay within private.my_conversation_ids: no row, no preview, no count.
--   * Notify: app.send_chat_message, restated from its latest definition (1393), notifies no Client-engaged member of
--     a show channel.
--   * app.groups.show_channel is set only by app.open_show_channel and never changes (show_channel_fixed): the v1
--     groups create and holders of org.communication.write cannot make or unmake one. The column stays out of v1.json
--     (contract-audit lists it as an extra column, as ADR 0131 decision 6 did for start_tbc).
--   * app.open_show_channel opens the project's channel (or answers the live one): a Project group named for the
--     project, its members seeded from the project's members minus Client-engaged people, the caller as Owner.
--     app.join_show_channel adds a reader of the running order. app.show_channel_status answers the panel, since group
--     row level security hides a group from people outside it (holders of org.communication.write read every group
--     already).

insert into private.domain_event_types (code, subject, description) values
  ('show_channel.opened', 'groups', 'A project''s show channel was opened.')
on conflict (code) do nothing;

alter table app.groups
  add column show_channel boolean not null default false,
  add constraint groups_show_channel_kind check (not show_channel or group_kind = 'Project');

comment on column app.groups.show_channel is 'True for a project''s show channel (ADR 0142): the chat beside the running cue, which Clients never join. Set only by app.open_show_channel; never changes.';

create unique index groups_show_channel_key on app.groups (project_id)
  where show_channel and deleted_at is null and archived_at is null;

-- Whether another person is engaged as a role on a project ---------------------------------------------------------------

create or replace function private.person_engaged_as(p_person_id uuid, p_project_id uuid, p_role app.external_role_type)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_claims text := current_setting('request.jwt.claims', true);
  v_engaged boolean;
begin
  if p_person_id is null or p_project_id is null then
    return false;
  end if;
  if exists (select 1 from app.engagements e
             where e.project_id = p_project_id and e.person_id = p_person_id and e.role_type = p_role and e.deleted_at is null) then
    return true;
  end if;
  select p.user_id into v_user from app.people p where p.id = p_person_id and p.deleted_at is null;
  if v_user is null then
    return false;
  end if;
  -- As that person: a representative or an organization's member reaches an engagement without being its person.
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    v_engaged := private.engaged_as(p_project_id, p_role);
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  exception when others then
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    raise;
  end;
  return coalesce(v_engaged, false);
end;
$$;

comment on function private.person_engaged_as(uuid, uuid, app.external_role_type) is 'True when a person is engaged on a project in the role: an engagement of theirs with the role, or else private.engaged_as evaluated as their user (claims switched and restored, as 2781), which covers representatives and organization members. Used by show channels to keep Clients out (ADR 0142).';
revoke all on function private.person_engaged_as(uuid, uuid, app.external_role_type) from public, anon, authenticated;

-- Groups: show_channel is the database's -------------------------------------------------------------------------------------

-- From its only definition (0800), with the show channel rule added.
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
    if new.show_channel is distinct from old.show_channel then
      perform private.refuse('show_channel_fixed', 'A group keeps whether it is a show channel.');
    end if;
  else
    if new.archived_at is not null then
      perform private.refuse('group_archived', 'A group is created active.');
    end if;
    if new.show_channel and not private.in_trusted_operation('show_channel') then
      perform private.refuse('show_channel_fixed', 'A show channel is opened from the running order.');
    end if;
  end if;
  return new;
end;
$$;
comment on function private.guard_group() is 'Groups keep their kind and project, archiving is final, and a show channel is made only by app.open_show_channel and stays one (show_channel_fixed, 2922).';
revoke all on function private.guard_group() from public, anon, authenticated;

-- From its only definition (0800), with the Client rule added.
create or replace function private.guard_group_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group app.groups;
begin
  select * into v_group from app.groups g where g.id = new.group_id;
  if v_group.archived_at is not null then
    perform private.refuse('group_archived', 'An archived group''s members do not change.');
  end if;
  if tg_op = 'UPDATE' and (new.group_id <> old.group_id or new.membership_id <> old.membership_id) then
    perform private.refuse('group_member_fixed', 'A group member row keeps its group and member; remove it and add the member again.');
  end if;
  if tg_op = 'UPDATE' and old.deleted_at is not null and new.deleted_at is null then
    perform private.refuse('group_member_fixed', 'A removed member is added again as a new row.');
  end if;
  if tg_op = 'INSERT' and new.deleted_at is null and v_group.show_channel
     and private.person_engaged_as((select m.person_id from app.memberships m where m.id = new.membership_id), v_group.project_id, 'Client') then
    perform private.refuse('show_channel_client', 'Clients are never in a show channel.');
  end if;
  return new;
end;
$$;
comment on function private.guard_group_member() is 'Group members keep their group and member, an archived group''s members are fixed, and nobody engaged as Client on the project joins its show channel (show_channel_client, 2922).';
revoke all on function private.guard_group_member() from public, anon, authenticated;

-- Reading: a Client reads no show channel ------------------------------------------------------------------------------------

-- From its only definition (0800), with the show channel exclusion.
create or replace function private.my_conversation_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select cm.conversation_id from app.conversation_members cm
    where cm.deleted_at is null and cm.membership_id in (select private.my_membership_ids())
  )
  select m.conversation_id from mine m
  where m.conversation_id not in (
    select c.id from app.conversations c
    join app.groups g on g.id = c.group_id
    where c.id in (select x.conversation_id from mine x) and g.show_channel
      and private.engaged_as(g.project_id, 'Client'));
$$;
comment on function private.my_conversation_ids() is 'Conversations the signed-in person takes part in, less the show channels of projects they reach as Client (2922).';
revoke all on function private.my_conversation_ids() from public, anon;
grant execute on function private.my_conversation_ids() to authenticated, service_role;

-- From its latest definition (1631), kept within private.my_conversation_ids.
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
    (select m.body from app.chat_messages m
     where m.conversation_id = c.id and m.deleted_at is null
       and m.author_membership_id not in (select private.my_blocked_membership_ids())
     order by m.created_at desc limit 1),
    (select count(*)::integer from app.chat_messages m
      where m.conversation_id = c.id and m.deleted_at is null and m.author_membership_id <> me.membership_id
        and m.author_membership_id not in (select private.my_blocked_membership_ids())
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
    and c.id in (select private.my_conversation_ids())
  order by c.last_message_at desc nulls last, c.created_at desc;
$$;

comment on function app.my_conversations(uuid) is 'The signed-in member''s conversations in an org, newest activity first, with the other person or group as title, the latest message and the unread count; messages by people the member blocked are neither previewed nor counted (1631), and a show channel of a project the member reaches as Client is not listed (2922).';
revoke all on function app.my_conversations(uuid) from public, anon;
grant execute on function app.my_conversations(uuid) to authenticated, service_role;

-- Notifying: never a Client ------------------------------------------------------------------------------------------------------

-- From its latest definition (1393), with the show channel recipient rule.
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
  v_away record;
  v_reply uuid;
  v_show_project uuid;
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
  select g.project_id into v_show_project from app.groups g where g.id = v_conversation.group_id and g.show_channel;
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
    -- A show channel never tells a Client what was said (2922).
    if v_show_project is not null and private.person_engaged_as(v_recipient.person_id, v_show_project, 'Client') then
      continue;
    end if;
    perform private.notify(v_conversation.org_id, v_recipient.person_id, 'message.received', 'app.chat_messages', v_id, null,
      jsonb_build_object('conversation_id', p_conversation_id, 'kind', p_message_kind));
  end loop;

  -- Out of office: the other person in a direct conversation answers once with their automatic reply.
  if v_conversation.conversation_kind = 'Direct' then
    for v_away in
      select cm.membership_id, m.person_id,
        btrim(private.setting_text(v_conversation.org_id, 'me.out_of_office.auto_reply', null, null, m.person_id)) as reply
      from app.conversation_members cm join app.memberships m on m.id = cm.membership_id
      where cm.conversation_id = p_conversation_id and cm.deleted_at is null and cm.membership_id <> v_mine
    loop
      if coalesce(v_away.reply, '') <> '' and private.person_away(v_away.person_id, v_conversation.org_id)
         and not exists (select 1 from app.chat_messages x
                         where x.conversation_id = p_conversation_id and x.author_membership_id = v_away.membership_id
                           and x.auto_reply and x.created_at >= private.away_since(v_away.person_id, v_conversation.org_id)) then
        insert into app.chat_messages (conversation_id, author_membership_id, message_kind, body, auto_reply)
        values (p_conversation_id, v_away.membership_id, 'Text', left(v_away.reply, 1000), true)
        returning id into v_reply;
        -- The automatic reply comes from the person who is away, not from the sender it answers (1393).
        perform private.notify(v_conversation.org_id, private.current_person_id(), 'message.received', 'app.chat_messages', v_reply, null,
          jsonb_build_object('conversation_id', p_conversation_id, 'kind', 'Text', 'autoReply', true,
            'actorName', coalesce((select p.full_name from app.people p where p.id = v_away.person_id),
                                  (select o.name from app.organizations o where o.id = v_conversation.org_id))));
      end if;
    end loop;
  end if;
  return v_id;
end;
$$;

comment on function app.send_chat_message(uuid, text, app.chat_message_kind, text) is 'Sends a message to a conversation the signed-in member takes part in and notifies the other members who have not muted it, except, in a show channel, anyone engaged as Client on its project (2922). In a direct conversation with someone out of office who wrote an automatic reply, that reply follows once for their time away (1325), and its notification names the person away (1393). A photo, file or voice note is attached to the returned message id afterwards. Returns the message id.';
revoke all on function app.send_chat_message(uuid, text, app.chat_message_kind, text) from public, anon;
grant execute on function app.send_chat_message(uuid, text, app.chat_message_kind, text) to authenticated, service_role;

-- Opening, joining and the panel's status -------------------------------------------------------------------------------------------

create or replace function private.live_show_channel(p_project_id uuid)
returns app.groups
language sql
stable
security definer
set search_path = ''
as $$
  select g.* from app.groups g
  where g.project_id = p_project_id and g.show_channel and g.deleted_at is null and g.archived_at is null;
$$;

comment on function private.live_show_channel(uuid) is 'The project''s live show channel group, or a null row.';
revoke all on function private.live_show_channel(uuid) from public, anon, authenticated;

create or replace function app.open_show_channel(p_project_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_project app.projects;
  v_group app.groups;
  v_mine uuid;
  v_base text;
  v_name text;
  v_n integer := 1;
  v_member uuid;
begin
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null or not private.is_member(v_project.org_id)
     or not private.can_on_project(v_project.id, 'show.run_of_show.write') then
    raise exception using errcode = '42501', message = 'show.run_of_show.write is required on the project';
  end if;
  v_mine := private.my_membership_in(v_project.org_id);
  -- One opener at a time per project, so two people opening at once get the same channel.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('xos_show_channel:' || v_project.id::text));
  v_group := private.live_show_channel(v_project.id);
  perform private.begin_trusted_operation('show_channel');
  if v_group.id is null then
    v_base := left('Show channel · ' || btrim(v_project.name), 120);
    v_name := v_base;
    while exists (select 1 from app.groups g where g.org_id = v_project.org_id and lower(btrim(g.name)) = lower(btrim(v_name))
                  and g.deleted_at is null) loop
      v_n := v_n + 1;
      v_name := left(v_base, 120 - char_length(' (' || v_n || ')')) || ' (' || v_n || ')';
    end loop;
    insert into app.groups (org_id, name, group_kind, project_id, show_channel, description)
    values (v_project.org_id, v_name, 'Project', v_project.id, true, 'Show channel: the crew''s chat beside the running cue. Clients are never in it.')
    returning * into v_group;
    insert into app.group_members (group_id, membership_id, group_role) values (v_group.id, v_mine, 'Owner');
    for v_member in
      select a.id from private.audience_membership_ids(v_project.org_id, 'Project', v_project.id, null, null, null, null) a(id)
      where a.id <> v_mine
    loop
      if not private.person_engaged_as((select m.person_id from app.memberships m where m.id = v_member), v_project.id, 'Client') then
        insert into app.group_members (group_id, membership_id, group_role) values (v_group.id, v_member, 'Member');
      end if;
    end loop;
    perform private.emit_event(v_project.org_id, 'show_channel.opened', 'groups', v_group.id, v_project.id,
      jsonb_build_object('name', v_name));
  elsif not exists (select 1 from app.group_members gm where gm.group_id = v_group.id and gm.membership_id = v_mine and gm.deleted_at is null)
        and not private.person_engaged_as(v_person, v_project.id, 'Client') then
    insert into app.group_members (group_id, membership_id, group_role) values (v_group.id, v_mine, 'Member');
  end if;
  perform private.end_trusted_operation('show_channel');
  return (select c.id from app.conversations c where c.group_id = v_group.id);
end;
$$;

comment on function app.open_show_channel(uuid) is 'Opens the project''s show channel (ADR 0142) and returns its conversation: a Project group marked show_channel, named Show channel · and the project''s name (deduplicated, at most 120 characters), with the caller as Owner and the project''s members as Members, less anyone engaged as Client. When the project already has a live channel, answers it and adds the caller if they are not in it. Needs membership of the project''s org and show.run_of_show.write on the project.';
revoke all on function app.open_show_channel(uuid) from public, anon;
grant execute on function app.open_show_channel(uuid) to authenticated, service_role;

create or replace function app.join_show_channel(p_project_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_group app.groups := private.live_show_channel(p_project_id);
  v_mine uuid;
begin
  if v_group.id is null or not private.is_member(v_group.org_id)
     or not private.can_on_project(p_project_id, 'show.run_of_show.read') then
    raise exception using errcode = '42501', message = 'show channel not found';
  end if;
  if private.person_engaged_as(v_person, p_project_id, 'Client') then
    perform private.refuse('show_channel_client', 'Clients are never in a show channel.');
  end if;
  v_mine := private.my_membership_in(v_group.org_id);
  if not exists (select 1 from app.group_members gm where gm.group_id = v_group.id and gm.membership_id = v_mine and gm.deleted_at is null) then
    insert into app.group_members (group_id, membership_id, group_role) values (v_group.id, v_mine, 'Member');
  end if;
  return (select c.id from app.conversations c where c.group_id = v_group.id);
end;
$$;

comment on function app.join_show_channel(uuid) is 'Adds the signed-in member to the project''s live show channel and returns its conversation (ADR 0142). Needs membership of the org and show.run_of_show.read on the project; refuses anyone engaged as Client (show_channel_client). Idempotent.';
revoke all on function app.join_show_channel(uuid) from public, anon;
grant execute on function app.join_show_channel(uuid) to authenticated, service_role;

create or replace function app.show_channel_status(p_project_id uuid)
returns table (channel_exists boolean, conversation_id uuid, am_member boolean, can_join boolean, can_open boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_person uuid := private.require_person();
  v_project app.projects;
  v_group app.groups;
  v_member boolean := false;
  v_client boolean;
  v_reader boolean;
begin
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null or not private.is_member(v_project.org_id)
     or not private.can_on_project(v_project.id, 'show.run_of_show.read') then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  v_group := private.live_show_channel(v_project.id);
  v_client := private.person_engaged_as(v_person, v_project.id, 'Client');
  v_reader := not v_client;
  if v_group.id is not null then
    v_member := exists (select 1 from app.group_members gm
      where gm.group_id = v_group.id and gm.deleted_at is null and gm.membership_id = private.my_membership_in(v_project.org_id));
  end if;
  return query select
    v_group.id is not null,
    case when v_member and not v_client then (select c.id from app.conversations c where c.group_id = v_group.id) end,
    v_member and not v_client,
    v_group.id is not null and not v_member and v_reader,
    v_group.id is null and v_reader and private.can_on_project(v_project.id, 'show.run_of_show.write');
end;
$$;

comment on function app.show_channel_status(uuid) is 'The show channel panel''s state for the signed-in member (ADR 0142): whether the project has a live show channel, its conversation (only for a member), whether the caller is in it, may join it (show.run_of_show.read, not a Client) or may open it (no channel yet and show.run_of_show.write). Needs membership of the org and show.run_of_show.read on the project.';
revoke all on function app.show_channel_status(uuid) from public, anon;
grant execute on function app.show_channel_status(uuid) to authenticated, service_role;
