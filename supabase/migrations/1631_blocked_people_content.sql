-- 1631_blocked_people_content.sql
-- ADR 0033 decision 57 (2026-10-23, RRR-137; App Store Review Guideline 1.2): blocking a person hides what they write from
-- the person who blocked them. A52's app.blocks (1206) already records a person blocking another person, and hides
-- profiles both ways; this migration widens what a person block hides:
--   * from the blocker only, the blocked person's feed posts (polls and recognition posts included), comments on feed
--     posts, shout-outs and chat messages, in group conversations as well as direct ones, through restrictive read
--     policies, so Compass, Atlas and the API hide them alike and lifting the block shows them again. A post that
--     requires acknowledgment stays: it is an instruction from the org, and its author must already hold
--     knowledge.sop.publish;
--   * the notifications about those (message.received, announcement.posted, recognition.received, and comment.created
--     and mention.created on a feed post): hidden from the blocker's Inbox, and their email, text and push deliveries
--     recorded Suppressed and kept out of digests and text summaries, as a sandbox org's are (1530);
--   * app.my_conversations counts and previews no message by a blocked person.
-- A shout-out whose feed post was hidden (by its author, or removed by a moderator, 1630) no longer reads to anyone,
-- the people it names included.
-- app.block_member blocks the person behind a membership in one of the caller's orgs: Compass knows people by
-- membership. A block still never ends a membership, an engagement or anyone's access to work; the blocked person is
-- not told and still sees the blocker's content.

-- Who the signed-in person blocked ---------------------------------------------------------------------------------------

create or replace function private.my_blocked_person_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.blocked_person_id from app.blocks b
  where b.person_id = private.current_person_id() and b.deleted_at is null and b.blocked_person_id is not null;
$$;

comment on function private.my_blocked_person_ids() is 'People the signed-in person blocked (live person blocks, 1206).';
revoke all on function private.my_blocked_person_ids() from public, anon;
grant execute on function private.my_blocked_person_ids() to authenticated, service_role;

create or replace function private.my_blocked_membership_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from app.memberships m
  where m.person_id in (select private.my_blocked_person_ids());
$$;

comment on function private.my_blocked_membership_ids() is 'Every membership, current or ended, in any org, of the people the signed-in person blocked; content is written by memberships.';
revoke all on function private.my_blocked_membership_ids() from public, anon;
grant execute on function private.my_blocked_membership_ids() to authenticated, service_role;

create or replace function private.i_block_anyone()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.my_blocked_person_ids());
$$;

comment on function private.i_block_anyone() is 'Whether the signed-in person blocked anyone, so a read skips the per-row block checks when they did not.';
revoke all on function private.i_block_anyone() from public, anon;
grant execute on function private.i_block_anyone() to authenticated, service_role;

create or replace function private.feed_post_hidden(p_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.hidden_at is not null from app.feed_posts p where p.id = p_post_id), false);
$$;

comment on function private.feed_post_hidden(uuid) is 'Whether a feed post was hidden, by its author or a moderator; false for no such post.';
revoke all on function private.feed_post_hidden(uuid) from public, anon;
grant execute on function private.feed_post_hidden(uuid) to authenticated, service_role;

create or replace function private.is_feed_post_thread(p_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.comment_threads t where t.id = p_thread_id and t.subject_table = 'app.feed_posts');
$$;

comment on function private.is_feed_post_thread(uuid) is 'Whether a comment thread is on a feed post, the comments a block hides.';
revoke all on function private.is_feed_post_thread(uuid) from public, anon;
grant execute on function private.is_feed_post_thread(uuid) to authenticated, service_role;

-- Content ----------------------------------------------------------------------------------------------------------------

create policy feed_posts_hide_blocked_authors on app.feed_posts as restrictive for select to authenticated
  using (author_membership_id is null or requires_acknowledgment
         or not (author_membership_id = any (array(select private.my_blocked_membership_ids()))));

create policy chat_messages_hide_blocked_authors on app.chat_messages as restrictive for select to authenticated
  using (not (author_membership_id = any (array(select private.my_blocked_membership_ids()))));

create policy recognitions_hide_blocked_and_hidden on app.recognitions as restrictive for select to authenticated
  using (not (from_membership_id = any (array(select private.my_blocked_membership_ids())))
         and (feed_post_id is null or not private.feed_post_hidden(feed_post_id)));

create policy comments_hide_blocked_authors on app.comments as restrictive for select to authenticated
  using (not (author_person_id = any (array(select private.my_blocked_person_ids())))
         or not private.is_feed_post_thread(comment_thread_id));

comment on policy feed_posts_hide_blocked_authors on app.feed_posts is 'ADR 0033 decision 57 (1631): the signed-in person reads no post by someone they blocked, except a post that requires acknowledgment.';
comment on policy chat_messages_hide_blocked_authors on app.chat_messages is 'ADR 0033 decision 57 (1631): the signed-in person reads no message by someone they blocked, in any conversation.';
comment on policy recognitions_hide_blocked_and_hidden on app.recognitions is 'ADR 0033 decision 57 (1631): the signed-in person reads no shout-out by someone they blocked, and nobody reads a shout-out whose feed post was hidden.';
comment on policy comments_hide_blocked_authors on app.comments is 'ADR 0033 decision 57 (1631): the signed-in person reads no comment on a feed post by someone they blocked.';

-- Notifications about blocked people's content ---------------------------------------------------------------------------

create or replace function private.notification_content_author(
  p_kind text,
  p_subject_table text,
  p_subject_id uuid,
  p_actor_person_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_kind = 'message.received' and p_subject_table = 'app.chat_messages' then
      (select m.person_id from app.chat_messages c join app.memberships m on m.id = c.author_membership_id
       where c.id = p_subject_id)
    when p_kind = 'announcement.posted' and p_subject_table = 'app.feed_posts' then
      (select m.person_id from app.feed_posts p join app.memberships m on m.id = p.author_membership_id
       where p.id = p_subject_id and not p.requires_acknowledgment)
    when p_kind = 'recognition.received' and p_subject_table = 'app.recognitions' then
      (select m.person_id from app.recognitions r join app.memberships m on m.id = r.from_membership_id
       where r.id = p_subject_id)
    when p_kind in ('comment.created', 'mention.created') and p_subject_table = 'app.feed_posts' then p_actor_person_id
  end;
$$;

comment on function private.notification_content_author(text, text, uuid, uuid) is 'The person who wrote the content a notification is about, for the kinds a block silences: a message, a post that does not require acknowledgment, a shout-out, or a comment or mention on a feed post. NULL for every other notification.';
revoke all on function private.notification_content_author(text, text, uuid, uuid) from public, anon, authenticated;

create or replace function private.hidden_by_my_blocks(p_kind text, p_subject_table text, p_subject_id uuid, p_actor_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.notification_content_author(p_kind, p_subject_table, p_subject_id, p_actor_person_id)
                    in (select private.my_blocked_person_ids()), false);
$$;

comment on function private.hidden_by_my_blocks(text, text, uuid, uuid) is 'Whether a notification is about content by someone the signed-in person blocked.';
revoke all on function private.hidden_by_my_blocks(text, text, uuid, uuid) from public, anon;
grant execute on function private.hidden_by_my_blocks(text, text, uuid, uuid) to authenticated, service_role;

create policy notifications_hide_blocked_authors on app.notifications as restrictive for select to authenticated
  using (kind not in ('message.received', 'announcement.posted', 'recognition.received', 'comment.created', 'mention.created')
         or not (select private.i_block_anyone())
         or not private.hidden_by_my_blocks(kind, subject_table, subject_id, actor_person_id));

comment on policy notifications_hide_blocked_authors on app.notifications is 'ADR 0033 decision 57 (1631): the signed-in person''s Inbox shows no notification about content by someone they blocked.';

create or replace function private.blocked_author_sends_nothing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_notification record;
begin
  -- A text private.notify holds for the summary goes from Queued to Digest: one suppressed here stays suppressed.
  if tg_op = 'UPDATE' then
    if old.message_status = 'Suppressed' and old.last_error = 'The recipient blocked the author.'
       and new.message_status in ('Queued', 'Deferred', 'Digest') then
      new.message_status := 'Suppressed';
      new.last_error := old.last_error;
    end if;
    return new;
  end if;
  if new.message_status not in ('Queued', 'Deferred', 'Digest') then
    return new;
  end if;
  select n.recipient_person_id, n.kind, n.subject_table, n.subject_id, n.actor_person_id into v_notification
  from app.notifications n where n.id = new.notification_id and n.created_at = new.notification_created_at;
  if exists (select 1 from app.blocks b
             where b.person_id = v_notification.recipient_person_id and b.deleted_at is null
               and b.blocked_person_id = private.notification_content_author(v_notification.kind, v_notification.subject_table,
                                           v_notification.subject_id, v_notification.actor_person_id)) then
    new.message_status := 'Suppressed';
    new.last_error := 'The recipient blocked the author.';
  end if;
  return new;
end;
$$;

comment on function private.blocked_author_sends_nothing() is 'Trigger: records an email, text or push delivery about content by someone the recipient blocked Suppressed when private.notify creates it, whether it is queued, deferred or held for a digest, and keeps it Suppressed when a text is then held for the summary. A delivery queued before the block goes as queued (1631).';
revoke all on function private.blocked_author_sends_nothing() from public, anon, authenticated;

create trigger t52_blocked_author_sends_nothing before insert or update of message_status on app.notification_deliveries
  for each row execute function private.blocked_author_sends_nothing();

create or replace function private.suppressed_delivery_queues_nothing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from app.notification_deliveries d
             where d.id = new.notification_delivery_id and d.notification_created_at = new.notification_created_at
               and d.message_status = 'Suppressed') then
    return null;
  end if;
  return new;
end;
$$;

comment on function private.suppressed_delivery_queues_nothing() is 'Trigger: a Suppressed delivery never joins an email digest or a text summary; the row is skipped (1631).';
revoke all on function private.suppressed_delivery_queues_nothing() from public, anon, authenticated;

create trigger t52_suppressed_delivery_queues_nothing before insert on app.email_digest_queue
  for each row execute function private.suppressed_delivery_queues_nothing();
create trigger t52_suppressed_delivery_queues_nothing before insert on app.sms_summary_queue
  for each row execute function private.suppressed_delivery_queues_nothing();

-- Conversations (from 0800) ----------------------------------------------------------------------------------------------

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
  order by c.last_message_at desc nulls last, c.created_at desc;
$$;

comment on function app.my_conversations(uuid) is 'The signed-in member''s conversations in an org, newest activity first, with the other person or group as title, the latest message and the unread count; messages by people the member blocked are neither previewed nor counted (1631).';

-- Blocking from Compass --------------------------------------------------------------------------------------------------

create or replace function app.block_member(p_membership_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_target uuid;
  v_id uuid;
begin
  select m.person_id into v_target from app.memberships m
  where m.id = p_membership_id and m.org_id in (select private.my_org_ids());
  if v_target is null then
    raise exception using errcode = '42501', message = 'the member does not exist or is not visible';
  end if;
  if v_target = v_person then
    perform private.refuse('block_self', 'A person cannot block themselves.');
  end if;
  select b.id into v_id from app.blocks b
  where b.person_id = v_person and b.blocked_person_id = v_target and b.deleted_at is null;
  if v_id is not null then
    return v_id;
  end if;
  insert into app.blocks (person_id, blocked_urn) values (v_person, 'urn:xpms:person:' || v_target::text)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.block_member(uuid) is 'Blocks the person behind a membership in one of the signed-in person''s orgs, current or ended (ADR 0033 decision 57): their posts, comments on posts, shout-outs and messages disappear for the blocker (1631). Idempotent; returns the block id. Unblocking is setting deleted_at on the block, as before (1206).';
revoke all on function app.block_member(uuid) from public, anon;
grant execute on function app.block_member(uuid) to authenticated, service_role;

comment on table app.blocks is 'People and organizations a person has blocked (Section 4.5.6 Profile Privacy). A block hides the blocker''s profile from the blocked person and from every member of a blocked organization, and hides the blocked profile from the blocker. A person block also hides the blocked person''s feed posts (except those that require acknowledgment), comments on posts, shout-outs and chat messages, and the notifications about them, from the blocker (ADR 0033 decision 57, 1631). It never ends a membership or an engagement. Read and written only by the blocker.';
