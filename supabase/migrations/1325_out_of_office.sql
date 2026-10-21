-- 1325_out_of_office.sql
-- A76 Settings enforcement (RRR-121, A65-001, WP1): Out of Office (Section 4.5.6 personal settings item 9: "dates,
-- delegate for approvals, auto-reply in messages") takes effect from the four me.out_of_office.* settings.
--
--   * private.person_away: a person is away in an org while me.out_of_office.enabled is on and today, in their time
--     zone, falls between me.out_of_office.starts_on and me.out_of_office.ends_on (either may be empty).
--   * Approvals go to the delegate: while an approver is away, the people they delegated to in that org
--     (app.delegations, active now) may decide the steps the approver could decide and are notified in their
--     place. An away approver with no delegate is still notified, so no approval goes unseen.
--   * Automatic reply: a direct message to someone away who wrote me.out_of_office.auto_reply gets that reply,
--     once per conversation for the time they are away, marked as automatic (app.chat_messages.auto_reply).

alter table app.chat_messages add column auto_reply boolean not null default false;
comment on column app.chat_messages.auto_reply is 'True for the automatic out-of-office reply sent for a member who is away (me.out_of_office.auto_reply), never typed by them.';

-- Away -------------------------------------------------------------------------------------------------------------

create or replace function private.setting_date(p_value text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  return p_value::date;
exception when others then
  return null;
end;
$$;

comment on function private.setting_date(text) is 'A date setting''s text (YYYY-MM-DD) as a date, or null when empty or not a date.';
revoke all on function private.setting_date(text) from public, anon, authenticated;

create or replace function private.person_away(p_person_id uuid, p_org_id uuid, p_at timestamptz default now())
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_zone text := coalesce(private.setting_text(p_org_id, 'locale.time_zone', null, null, p_person_id), 'UTC');
  v_today date;
  v_starts date;
  v_ends date;
begin
  if p_person_id is null or not coalesce(private.setting_boolean(p_org_id, 'me.out_of_office.enabled', null, null, p_person_id), false) then
    return false;
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_zone) then
    v_zone := 'UTC';
  end if;
  v_today := (p_at at time zone v_zone)::date;
  v_starts := private.setting_date(private.setting_text(p_org_id, 'me.out_of_office.starts_on', null, null, p_person_id));
  v_ends := private.setting_date(private.setting_text(p_org_id, 'me.out_of_office.ends_on', null, null, p_person_id));
  return (v_starts is null or v_starts <= v_today) and (v_ends is null or v_today <= v_ends);
end;
$$;

comment on function private.person_away(uuid, uuid, timestamptz) is 'True while a person is out of office in an org (1325): me.out_of_office.enabled is on and the day in their time zone falls between me.out_of_office.starts_on and me.out_of_office.ends_on when those are set.';
revoke all on function private.person_away(uuid, uuid, timestamptz) from public, anon, authenticated;

create or replace function private.away_since(p_person_id uuid, p_org_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (private.setting_date(private.setting_text(p_org_id, 'me.out_of_office.starts_on', null, null, p_person_id)))::timestamptz,
    (select max(v.updated_at) from app.personal_setting_values v
     where v.person_id = p_person_id and v.setting_key = 'me.out_of_office.enabled' and v.deleted_at is null
       and (v.org_id is null or v.org_id = p_org_id)),
    '-infinity'::timestamptz);
$$;

comment on function private.away_since(uuid, uuid) is 'When a person''s current time away began: their me.out_of_office.starts_on, else when they last turned out of office on.';
revoke all on function private.away_since(uuid, uuid) from public, anon, authenticated;

-- Approvals go to the delegate --------------------------------------------------------------------------------------

create or replace function private.away_delegate_person_ids(p_org_id uuid, p_delegator_membership_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct em.person_id
  from app.delegations d
  join app.memberships dm on dm.id = d.delegator_membership_id
  join app.memberships em on em.id = d.delegate_membership_id
  where d.org_id = p_org_id and d.delegator_membership_id = p_delegator_membership_id and d.deleted_at is null
    and d.valid_from <= now() and d.valid_to > now()
    and em.deleted_at is null and em.valid_from <= now() and (em.valid_to is null or em.valid_to > now())
    and private.person_away(dm.person_id, p_org_id);
$$;

comment on function private.away_delegate_person_ids(uuid, uuid) is 'The people a member delegated to in an org, while that member is out of office (1325); empty while they are in.';
revoke all on function private.away_delegate_person_ids(uuid, uuid) from public, anon, authenticated;

create or replace function private.is_step_approver(p_org_id uuid, p_role_id uuid, p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with eligible as (
    select m.id, m.person_id from app.memberships m
    where m.org_id = p_org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      and (m.id = p_membership_id
           or (p_role_id is not null and exists (select 1 from app.membership_roles mr
               where mr.membership_id = m.id and mr.role_id = p_role_id and mr.deleted_at is null)))
  )
  select (p_membership_id is not null or p_role_id is not null) and (
    exists (select 1 from eligible e where e.person_id = private.current_person_id())
    or exists (select 1 from eligible e
               where private.current_person_id() in (select private.away_delegate_person_ids(p_org_id, e.id))));
$$;

comment on function private.is_step_approver(uuid, uuid, uuid) is 'True when the signed-in person may decide a step naming this role or membership in the org: they hold the role through an active membership, they are the member, or they are the delegate of such an approver who is out of office (1325).';

create or replace function private.step_approver_person_ids(p_policy_id uuid, p_step_order smallint)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with eligible as (
    select distinct m.id, m.person_id, s.org_id
    from app.approval_steps s
    join app.memberships m on m.org_id = s.org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    where s.approval_policy_id = p_policy_id and s.step_order = p_step_order and s.deleted_at is null
      and (m.id = s.approver_membership_id
           or exists (select 1 from app.membership_roles mr
                      where mr.membership_id = m.id and mr.role_id = s.approver_role_id and mr.deleted_at is null))
  )
  select e.person_id from eligible e
  where not exists (select 1 from private.away_delegate_person_ids(e.org_id, e.id))
  union
  select d from eligible e cross join lateral private.away_delegate_person_ids(e.org_id, e.id) d;
$$;

comment on function private.step_approver_person_ids(uuid, smallint) is 'People who may decide one step of a policy now, for notifications. An approver who is out of office with a delegate is replaced by the delegate (1325).';

-- Automatic reply ---------------------------------------------------------------------------------------------------

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
        perform private.notify(v_conversation.org_id, private.current_person_id(), 'message.received', 'app.chat_messages', v_reply, null,
          jsonb_build_object('conversation_id', p_conversation_id, 'kind', 'Text', 'autoReply', true));
      end if;
    end loop;
  end if;
  return v_id;
end;
$$;

comment on function app.send_chat_message(uuid, text, app.chat_message_kind, text) is 'Sends a message to a conversation the signed-in member takes part in and notifies the other members who have not muted it. In a direct conversation with someone out of office who wrote an automatic reply, that reply follows once for their time away (1325). A photo, file or voice note is attached to the returned message id afterwards. Returns the message id.';
