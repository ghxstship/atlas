-- 1393_notification_sender_fixes.sql
-- Orchestrator block (ADR 0022, 1390 to 1399), RRR-125. Fixes to the notification dispatcher and the push and SMS
-- senders of A80 (1361, 1367) found by the batch-c audit. Each function below starts from its latest definition
-- (named in its section) and keeps every behavior later migrations added.
--   1. A Twilio status callback settles every delivery its text carried, so all the held texts of a summary
--      (record_sms_summary writes one SID on each) become Delivered or Bounced, not only the newest.
--   2. Held texts sent as a summary honor a category-scoped SMS suppression, as single texts do.
--   3. Every notification carries the actorName its copy names. Chat messages, feed posts, surveys, event
--      invitations, training assignments and recognition passed none, so rendering their push, SMS and email copy
--      ({actorName} sent you a message...) threw, and each delivery ended Failed after five attempts.

-- 1. Status callbacks settle every delivery of the text (from 1361) ----------------------------------------------------

create or replace function app.record_sms_status(p_provider_message_id text, p_status text, p_error text default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_provider_message_id is null or not exists (
    select 1 from app.notification_deliveries d where d.channel = 'SMS' and d.provider_message_id = p_provider_message_id) then
    return false;
  end if;
  -- A summary text carries several held deliveries under one SID (1367); its status settles all of them.
  if p_status = 'delivered' then
    update app.notification_deliveries set message_status = 'Delivered'
    where channel = 'SMS' and provider_message_id = p_provider_message_id and message_status in ('Sent', 'Delivered');
  elsif p_status in ('undelivered', 'failed') then
    update app.notification_deliveries set message_status = 'Bounced', last_error = left(coalesce(p_error, p_status), 2000)
    where channel = 'SMS' and provider_message_id = p_provider_message_id and message_status in ('Sent', 'Delivered');
  end if;
  return true;
end;
$$;

comment on function app.record_sms_status(text, text, text) is 'SMS webhook API (service role): records a Twilio status callback by message SID for every delivery the text carried, all the held texts of a summary included (1393). delivered marks them Delivered; undelivered and failed mark them Bounced with the carrier error (a retry would fail the same way). Other statuses change nothing. Returns false for an unknown SID.';

-- 2. Summaries honor category-scoped suppressions (from 1367) ----------------------------------------------------------

create or replace function app.claim_sms_summaries(p_limit integer default 50)
returns table (
  org_id uuid, recipient_person_id uuid, address text, delivery_ids uuid[], held_count integer,
  kind text, message_args jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_group record;
  v_person uuid;
  v_active boolean;
  v_project uuid;
  v_quiet timestamptz;
  v_address text;
  v_reason text;
  v_ids uuid[];
  v_drop uuid[];
  v_top record;
begin
  for v_group in
    select q.org_id, q.membership_id from app.sms_summary_queue q
    where q.sent_at is null and q.deleted_at is null and q.due_at <= now()
    group by q.org_id, q.membership_id
    order by min(q.due_at)
    limit least(greatest(p_limit, 1), 200)
  loop
    select array_agg(q.notification_delivery_id order by q.notification_created_at) into v_ids
    from (select q2.notification_delivery_id, q2.notification_created_at from app.sms_summary_queue q2
          where q2.org_id = v_group.org_id and q2.membership_id = v_group.membership_id
            and q2.sent_at is null and q2.deleted_at is null and q2.due_at <= now()
          for update skip locked) q;
    if v_ids is null then
      continue;
    end if;
    select m.person_id, (m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
    into v_person, v_active from app.memberships m where m.id = v_group.membership_id;
    select n.project_id into v_project from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    where d.id = any (v_ids) order by n.created_at desc limit 1;

    v_reason := null;
    v_address := private.recipient_address(v_person, 'SMS');
    if not coalesce(v_active, false) then
      v_reason := 'Recipient no longer belongs to the org.';
    else
      -- The member may have moved their quiet hours or their zone since the texts were held.
      v_quiet := private.sms_quiet_until(v_group.membership_id, v_project, now());
      if v_quiet is not null then
        update app.sms_summary_queue set due_at = v_quiet
        where notification_delivery_id = any (v_ids) and sent_at is null;
        continue;
      end if;
      if v_address is null then
        v_reason := 'No verified address on the channel.';
      elsif exists (select 1 from app.suppression_list s
                    where s.org_id = v_group.org_id and s.channel = 'SMS' and s.address = v_address and s.lifted_at is null
                      and s.deleted_at is null
                      and (s.reason in ('Hard Bounce', 'Complaint', 'STOP', 'Manual') or s.category_code is null)) then
        v_reason := 'Address is on the suppression list.';
      elsif not coalesce((select c.may_text from app.sms_consent_status c
                          where c.org_id = v_group.org_id and c.phone_e164 = v_address), false) then
        v_reason := 'No SMS consent for the number.';
      end if;
    end if;
    if v_reason is not null then
      update app.notification_deliveries set message_status = 'Suppressed', last_error = v_reason where id = any (v_ids);
      update app.sms_summary_queue set sent_at = now() where notification_delivery_id = any (v_ids) and sent_at is null;
      continue;
    end if;

    -- A suppression limited to a category (an unsubscribe from it) drops the held texts of that category, as
    -- app.claim_notification_deliveries does for a single text; they neither count nor become the summary's line.
    select array_agg(d.id) into v_drop
    from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    join private.notification_templates t on t.kind = n.kind and t.channel = 'SMS'
    left join private.email_templates e on e.code = t.email_template_code
    where d.id = any (v_ids)
      and not coalesce(e.transactional, false)
      and exists (select 1 from app.suppression_list s
                  where s.org_id = v_group.org_id and s.channel = 'SMS' and s.address = v_address and s.lifted_at is null
                    and s.deleted_at is null and s.category_code = t.category_code);
    if v_drop is not null then
      update app.notification_deliveries set message_status = 'Suppressed', last_error = 'Address is on the suppression list.'
      where id = any (v_drop);
      update app.sms_summary_queue set sent_at = now() where notification_delivery_id = any (v_drop) and sent_at is null;
      v_ids := array(select u.x from unnest(v_ids) with ordinality u(x, i) where u.x <> all (v_drop) order by u.i);
      if cardinality(v_ids) = 0 then
        continue;
      end if;
    end if;

    -- The most important held text: an urgent category first, then the latest.
    select n.kind, n.message_args into v_top
    from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    join private.notification_templates t on t.kind = n.kind and t.channel = 'SMS'
    join private.notification_categories c on c.code = t.category_code
    where d.id = any (v_ids)
    order by c.urgent desc, n.created_at desc
    limit 1;

    -- Claimed: due again in 10 minutes unless the outcome is recorded.
    update app.sms_summary_queue set due_at = now() + interval '10 minutes'
    where notification_delivery_id = any (v_ids) and sent_at is null;
    update app.notification_deliveries set attempt_count = attempt_count + 1 where id = any (v_ids);

    org_id := v_group.org_id;
    recipient_person_id := v_person;
    address := v_address;
    delivery_ids := v_ids;
    held_count := cardinality(v_ids);
    kind := v_top.kind;
    message_args := v_top.message_args;
    return next;
  end loop;
end;
$$;

comment on function app.claim_sms_summaries(integer) is 'SMS sender API (service role): claims the members whose held texts are due (their quiet hours ended), one row per member and org with every held delivery, the count and the most important text (an urgent category first, then the latest). Holds again a member still inside quiet hours, and suppresses, with the reason, the held texts of someone who left the org, lost their verified number, is suppressed or withdrew consent. A suppression limited to a category drops only the held texts of that category (1393). A claimed summary is due again after 10 minutes unless its outcome is recorded.';

-- 3. Every notification names its actor (private.notify from 1367, send_chat_message from 1325, notify_feed_post from
-- 1365) ----------------------------------------------------------------------------------------------------------------

create or replace function private.notify(
  p_org_id uuid,
  p_recipient_person_id uuid,
  p_kind text,
  p_subject_table text default null,
  p_subject_id uuid default null,
  p_project_id uuid default null,
  p_message_args jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
  v_category text := (select distinct t.category_code from private.notification_templates t where t.kind = p_kind);
  v_urgent boolean;
  v_args jsonb := coalesce(p_message_args, '{}'::jsonb);
  v_bypass boolean;
  v_id uuid;
  v_created timestamptz;
  v_channel app.notification_channel;
  v_quiet timestamptz;
  v_digest timestamptz;
  v_delivery uuid;
begin
  -- The copy of most kinds names who acted ({actorName}); an emitter that names nobody gets the signed-in person,
  -- or the org when a job acts.
  if nullif(v_args ->> 'actorName', '') is null then
    v_args := v_args || jsonb_build_object('actorName', coalesce(
      (select p.full_name from app.people p where p.id = private.current_person_id()),
      (select o.name from app.organizations o where o.id = p_org_id), ''));
  end if;
  v_bypass := private.bypasses_quiet_hours(p_kind, v_args, now());
  select m.id into v_membership from app.memberships m
  where m.org_id = p_org_id and m.person_id = p_recipient_person_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  order by m.valid_from desc limit 1;
  if v_membership is null and p_org_id not in (select private.party_org_ids(p_recipient_person_id)) then
    return null;
  end if;
  v_urgent := (select c.urgent from private.notification_categories c where c.code = v_category);
  insert into app.notifications (org_id, recipient_person_id, kind, actor_person_id, subject_table, subject_id, project_id, message_args,
    archived_at)
  values (p_org_id, p_recipient_person_id, p_kind, private.current_person_id(), p_subject_table, p_subject_id, p_project_id,
    v_args,
    case when v_membership is not null and v_category is not null and not private.channel_enabled(v_membership, v_category, 'In App')
         then now() end)
  returning id, created_at into v_id, v_created;

  if v_membership is null then
    -- An external party: their own Email and Push choices; quiet hours and digests are membership settings.
    foreach v_channel in array array['Email', 'Push']::app.notification_channel[] loop
      if private.person_channel_enabled(p_recipient_person_id, v_category, v_channel) then
        insert into app.notification_deliveries (notification_id, notification_created_at, channel, message_status, deliver_after)
        values (v_id, v_created, v_channel, 'Queued', now());
      end if;
    end loop;
    return v_id;
  end if;

  foreach v_channel in array array['Email', 'SMS', 'Push']::app.notification_channel[] loop
    if private.channel_enabled(v_membership, v_category, v_channel) then
      v_quiet := case
        when v_bypass then null
        when v_channel = 'SMS' then private.sms_quiet_until(v_membership, p_project_id, now())
        when v_channel = 'Push' then private.local_quiet_until(v_membership, now()) end;
      v_digest := case when v_channel = 'Email' and not v_urgent then private.next_digest_at(v_membership, now()) end;
      insert into app.notification_deliveries (notification_id, notification_created_at, channel, message_status, deliver_after)
      values (v_id, v_created, v_channel,
        (case when v_digest is not null then 'Digest' when v_quiet is not null then 'Deferred' else 'Queued' end)::app.message_status,
        coalesce(v_digest, v_quiet, now()))
      returning id into v_delivery;
      if v_digest is not null then
        insert into app.email_digest_queue (notification_delivery_id, notification_created_at, membership_id, due_at)
        values (v_delivery, v_created, v_membership, v_digest);
      elsif v_channel = 'SMS' and v_quiet is not null then
        perform private.hold_sms_for_summary(v_delivery, v_created, v_membership, v_quiet);
      end if;
    end if;
  end loop;
  return v_id;
end;
$$;

comment on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) is 'Creates a notification and its outside deliveries. Its message arguments always carry actorName: the emitter''s, else the signed-in person''s name, else the org''s when a job acts (1393). An active member gets one delivery per channel they receive the category on (their preference, the org default and mandatory categories, 1362). During quiet hours a push waits (Deferred) and a text is held for the member''s summary (1367); only kinds on the bypass list go at once (ADR 0033 decision 35). Non-urgent email joins the digest when the member chose one. With In App off the notification is recorded already archived. An external party of the org (1131) gets the notification and an Email and a Push delivery as their own preferences allow, at once. Anyone else gets nothing (invariant 3). Returns the notification id, or null.';

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

comment on function app.send_chat_message(uuid, text, app.chat_message_kind, text) is 'Sends a message to a conversation the signed-in member takes part in and notifies the other members who have not muted it. In a direct conversation with someone out of office who wrote an automatic reply, that reply follows once for their time away (1325), and its notification names the person away (1393). A photo, file or voice note is attached to the returned message id afterwards. Returns the message id.';

create or replace function private.notify_feed_post(p_post_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post app.feed_posts;
  v_person uuid;
  v_author text;
begin
  select * into v_post from app.feed_posts p where p.id = p_post_id;
  if v_post.notified_at is not null or v_post.publish_at > now() or v_post.hidden_at is not null or v_post.deleted_at is not null then
    return;
  end if;
  update app.feed_posts set notified_at = now() where id = p_post_id;
  perform private.emit_event(v_post.org_id, 'feed_post.published', 'feed_posts', v_post.id, v_post.project_id,
    jsonb_build_object('post_kind', v_post.post_kind, 'audience_kind', v_post.audience_kind,
      'requires_acknowledgment', v_post.requires_acknowledgment, 'pinned', v_post.pinned_at is not null));
  if v_post.post_kind in ('Announcement', 'Poll') or v_post.requires_acknowledgment then
    -- A scheduled post is published by a job, so the author is named from the post, not the session (1393).
    v_author := (select p.full_name from app.memberships m join app.people p on p.id = m.person_id
                 where m.id = v_post.author_membership_id);
    for v_person in
      select m.person_id from app.memberships m
      where m.id in (select private.audience_membership_ids(v_post.org_id, v_post.audience_kind, v_post.project_id,
        v_post.team_id, v_post.role_id, v_post.group_id, v_post.department_code))
        and m.id is distinct from v_post.author_membership_id
    loop
      perform private.notify(v_post.org_id, v_person, 'announcement.posted', 'app.feed_posts', v_post.id, v_post.project_id,
        jsonb_build_object('title', coalesce(v_post.title, left(v_post.body, 80)), 'requires_acknowledgment', v_post.requires_acknowledgment)
          || case when v_author is null then '{}'::jsonb else jsonb_build_object('actorName', v_author) end);
    end loop;
  end if;
end;
$$;
comment on function private.notify_feed_post(uuid) is 'Publishes a due feed post once: stamps notified_at, emits feed_post.published and notifies the audience (a department included, 1365) of announcements, polls and posts that need acknowledgment, naming the post''s author (1393).';

-- Privileges (create or replace keeps them; restated for review) -------------------------------------------------------

revoke all on function app.record_sms_status(text, text, text) from public, anon, authenticated;
grant execute on function app.record_sms_status(text, text, text) to service_role;
revoke all on function app.claim_sms_summaries(integer) from public, anon, authenticated;
grant execute on function app.claim_sms_summaries(integer) to service_role;
revoke all on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function app.send_chat_message(uuid, text, app.chat_message_kind, text) from public, anon;
grant execute on function app.send_chat_message(uuid, text, app.chat_message_kind, text) to authenticated, service_role;
revoke all on function private.notify_feed_post(uuid) from public, anon, authenticated;
