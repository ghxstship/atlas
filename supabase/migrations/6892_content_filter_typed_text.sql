-- 6892_content_filter_typed_text.sql
-- Merge train 11: app.send_chat_message keeps 6242's rule that a show channel never tells a Client what was said.
-- The objectionable language filter (6195) checks the text a person typed, where they type it, and never text the
-- system adds to their write or relays from someone else. Before this, a direct message to someone out of office
-- wrote their automatic reply in the same transaction, so a reply holding a listed term (saved before 6195, or
-- holding a term added since) made the sender's clean message fail. A shout-out did the same with the recipient's
-- name, which app.recognize writes as its feed post's title.
--   * The automatic reply is filtered where its author types it: me.out_of_office.auto_reply in
--     app.personal_setting_values is refused (content_objectionable) like any other text other people read.
--   * app.send_chat_message relays an automatic reply only while it passes the filter. One that holds a listed term
--     is not sent, and the sender's message is sent as always.
--   * app.chat_messages checks a row it inserts unless it is an automatic reply (auto_reply), which is relayed text
--     already filtered as a setting; an edit to any message, an automatic reply included, is typed and is checked.
--   * app.feed_posts checks a recognition post's body, the shout-out the sender typed, and not its title, the
--     recipient's name that app.recognize adds. Names stay outside the filter (6195).

-- Automatic replies, where they are typed ------------------------------------------------------------------------------

create trigger t36_refuse_objectionable_text before insert or update of value_text, setting_key, deleted_at
  on app.personal_setting_values
  for each row when (new.setting_key = 'me.out_of_office.auto_reply' and new.deleted_at is null)
  execute function private.refuse_objectionable_text('value_text');

-- Chat messages: what the author typed ------------------------------------------------------------------------------------

drop trigger t36_refuse_objectionable_text on app.chat_messages;
create trigger t36_refuse_objectionable_text before insert or update of body on app.chat_messages
  for each row when (not new.auto_reply)
  execute function private.refuse_objectionable_text('body');
create trigger t37_refuse_objectionable_reply_edit before update of body on app.chat_messages
  for each row when (new.auto_reply)
  execute function private.refuse_objectionable_text('body');

-- Feed posts: a recognition's title is the recipient's name ------------------------------------------------------------

drop trigger t36_refuse_objectionable_text on app.feed_posts;
create trigger t36_refuse_objectionable_text before insert or update of title, body on app.feed_posts
  for each row when (new.post_kind <> 'Recognition')
  execute function private.refuse_objectionable_text('title', 'body');
create trigger t37_refuse_objectionable_recognition before insert or update of body on app.feed_posts
  for each row when (new.post_kind = 'Recognition')
  execute function private.refuse_objectionable_text('body');

-- Sending a message relays only an automatic reply that passes ---------------------------------------------------------

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
    -- A show channel never tells a Client what was said (6242).
    if v_show_project is not null and private.person_engaged_as(v_recipient.person_id, v_show_project, 'Client') then
      continue;
    end if;
    perform private.notify(v_conversation.org_id, v_recipient.person_id, 'message.received', 'app.chat_messages', v_id, null,
      jsonb_build_object('conversation_id', p_conversation_id, 'kind', p_message_kind));
  end loop;

  -- Out of office: the other person in a direct conversation answers once with their automatic reply. A reply that
  -- holds a term the filter refuses is not relayed (6892), so it never stops the sender's own message.
  if v_conversation.conversation_kind = 'Direct' then
    for v_away in
      select cm.membership_id, m.person_id,
        btrim(private.setting_text(v_conversation.org_id, 'me.out_of_office.auto_reply', null, null, m.person_id)) as reply
      from app.conversation_members cm join app.memberships m on m.id = cm.membership_id
      where cm.conversation_id = p_conversation_id and cm.deleted_at is null and cm.membership_id <> v_mine
    loop
      if coalesce(v_away.reply, '') <> '' and private.objectionable_term(left(v_away.reply, 1000)) is null
         and private.person_away(v_away.person_id, v_conversation.org_id)
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

comment on function app.send_chat_message(uuid, text, app.chat_message_kind, text) is 'Sends a message to a conversation the signed-in member takes part in and notifies the other members who have not muted it. In a direct conversation with someone out of office who wrote an automatic reply, that reply follows once for their time away (1325), and its notification names the person away (1393); a reply that holds a term the objectionable language filter refuses is not sent, and never stops the message (6892). A photo, file or voice note is attached to the returned message id afterwards. Returns the message id.';
