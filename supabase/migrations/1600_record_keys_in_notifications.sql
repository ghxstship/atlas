-- 1600_record_keys_in_notifications.sql
--
-- Record keys in record notifications (ADR 0022, 1600-1609), RRR-125. An Inbox item about a record opens the record
-- (/{org}/r/{key}) when its notification carries the record's key (apps/atlas lib/inbox/describe.ts), but every emitter
-- of a notification about a record passed only its title, so an assignment opened My Work and a comment or a mention on
-- a record opened nothing. private.record_key reads the key, {project_key}-{record_number} as app.record_display_key
-- does, and each of those emitters is recreated from its latest definition with recordKey added to the message arguments
-- and nothing else changed:
--   * private.after_comment_mention and private.notify_comment_subscribers (0580): mention.created and comment.created
--     whose subject is a record (app.records); a comment on any other subject carries no key;
--   * private.notify_record_assignment (1394): assignment.created;
--   * app.send_automation_notice (1481): automation.notice about the event's subject, when the event is about a record
--     (a domain event names it records).
-- No later migration redefines any of the four.

-- 1. The record key ----------------------------------------------------------------------------------------------------

create or replace function private.record_key(p_record_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.project_key || '-' || r.record_number::text
  from app.records r join app.projects p on p.id = r.project_id
  where r.id = p_record_id;
$$;

comment on function private.record_key(uuid) is 'A record''s display key, {project_key}-{record_number} as app.record_display_key reads it (Section 4.5.1), for the notifications about the record, whose Inbox items open /{org}/r/{key} (1600). Null when no record has the id.';

-- 2. Comments and mentions (from 0580) ---------------------------------------------------------------------------------

create or replace function private.after_comment_mention()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ctx record;
begin
  select * into v_ctx from private.comment_context(new.comment_id);
  if v_ctx.author_person_id <> private.current_person_id() and not private.in_trusted_operation('comment_from_email') then
    perform private.refuse('comment_mention_author', 'Only the author mentions people in a comment.');
  end if;
  if not private.person_may_read_subject(new.mentioned_person_id, v_ctx.subject) then
    perform private.refuse('comment_mention_no_access', 'Only people who can open the subject can be mentioned.');
  end if;
  insert into app.thread_subscriptions (comment_thread_id, person_id, subscribed)
  values (v_ctx.comment_thread_id, new.mentioned_person_id, true)
  on conflict (comment_thread_id, person_id) where deleted_at is null do nothing;
  if new.mentioned_person_id <> v_ctx.author_person_id then
    perform private.notify(new.org_id, new.mentioned_person_id, 'mention.created', v_ctx.subject_table, v_ctx.subject_id,
      (v_ctx.subject ->> 'project_id')::uuid,
      jsonb_build_object('actorName', coalesce((select p.full_name from app.people p where p.id = v_ctx.author_person_id), ''),
        'title', private.subject_title(v_ctx.subject))
        || case when v_ctx.subject_table = 'app.records'
             then jsonb_build_object('recordKey', private.record_key(v_ctx.subject_id)) else '{}'::jsonb end);
  end if;
  return null;
end;
$$;

comment on function private.after_comment_mention() is 'After insert trigger on mentions: only the author mentions, only people who can reach the subject, and each mention subscribes the person to the thread and notifies them (category mentions), with the record''s key when the subject is a record (1600).';

create or replace function private.notify_comment_subscribers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ctx record;
  v_person uuid;
begin
  if new.deleted_at is not null then
    return null;
  end if;
  select * into v_ctx from private.comment_context(new.id);
  for v_person in
    select s.person_id from app.thread_subscriptions s
    where s.comment_thread_id = new.comment_thread_id and s.subscribed and s.deleted_at is null
      and s.person_id <> new.author_person_id
      and not exists (select 1 from app.comment_mentions m where m.comment_id = new.id and m.mentioned_person_id = s.person_id and m.deleted_at is null)
  loop
    if private.person_may_read_subject(v_person, v_ctx.subject) then
      perform private.notify(new.org_id, v_person, 'comment.created', v_ctx.subject_table, v_ctx.subject_id,
        (v_ctx.subject ->> 'project_id')::uuid,
        jsonb_build_object('actorName', coalesce((select p.full_name from app.people p where p.id = new.author_person_id), ''),
          'title', private.subject_title(v_ctx.subject))
          || case when v_ctx.subject_table = 'app.records'
               then jsonb_build_object('recordKey', private.record_key(v_ctx.subject_id)) else '{}'::jsonb end);
    end if;
  end loop;
  return null;
end;
$$;

comment on function private.notify_comment_subscribers() is 'Deferred constraint trigger on comments: at commit, once the comment''s mentions exist, notifies every subscriber except the author and the people the comment mentions (who got a mention notification), and only those who can still reach the subject, with the record''s key when the subject is a record (1600).';

-- 3. Record assignments (from 1394) ------------------------------------------------------------------------------------

create or replace function private.notify_record_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid;
  v_record record;
begin
  if new.deleted_at is not null then
    return null;
  end if;
  v_person := (select m.person_id from app.memberships m where m.id = new.membership_id);
  if v_person is null or v_person is not distinct from private.current_person_id() then
    return null;
  end if;
  select r.title, r.project_id into v_record from app.records r where r.id = new.record_id and r.deleted_at is null;
  if not found then
    return null;
  end if;
  perform private.notify(new.org_id, v_person, 'assignment.created', 'app.records', new.record_id, v_record.project_id,
    jsonb_build_object('title', v_record.title, 'recordKey', private.record_key(new.record_id)));
  return null;
end;
$$;

comment on function private.notify_record_assignment() is 'Tells a member assigned to a live record (1394): assignment.created with the record''s title and key (1600); the actor is whoever assigned them. Assigning oneself tells nobody.';

-- 4. Automation notices (from 1481) ------------------------------------------------------------------------------------

create or replace function app.send_automation_notice(p_run_id uuid, p_recipient_person_id uuid, p_title text, p_body text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.automation_runs := private.owned_running_automation_run(p_run_id);
  v_name text := (select a.name from app.automations a where a.id = v_run.automation_id);
  v_subject_id text := v_run.event_payload -> 'subject' ->> 'id';
  v_project text := v_run.event_payload ->> 'project_id';
begin
  if not private.automation_member_active(v_run.org_id, p_recipient_person_id) then
    perform private.refuse('automation_person_not_member', 'Notify a member of this organization.');
  end if;
  if p_title is null or char_length(btrim(p_title)) not between 1 and 200 then
    perform private.refuse('automation_notice_title', 'A notification title is 1 to 200 characters.');
  end if;
  if p_body is not null and char_length(btrim(p_body)) > 2000 then
    perform private.refuse('automation_notice_body', 'A notification message is at most 2,000 characters.');
  end if;
  return private.notify(v_run.org_id, p_recipient_person_id, 'automation.notice',
    case when v_subject_id is not null then v_run.event_payload -> 'subject' ->> 'table' end,
    v_subject_id::uuid,
    case when exists (select 1 from app.projects p where p.id::text = v_project) then v_project::uuid end,
    jsonb_build_object('automationName', v_name, 'title', btrim(p_title), 'body', coalesce(nullif(btrim(p_body), ''), btrim(p_title)))
      || case when v_subject_id is not null and v_run.event_payload -> 'subject' ->> 'table' in ('records', 'app.records')
           then jsonb_build_object('recordKey', private.record_key(v_subject_id::uuid)) else '{}'::jsonb end);
end;
$$;

comment on function app.send_automation_notice(uuid, uuid, text, text) is 'The notify action (automationRuns.notify, ADR 0047): during a run, its automation''s owner notifies a member of the org (automation.notice) about the event''s subject, with the record''s key when the subject is a record (1600). Needs org.automations.write; the run must be running.';

-- Privileges (create or replace keeps them; restated for review) -------------------------------------------------------

revoke all on function private.record_key(uuid) from public, anon, authenticated;
revoke all on function private.after_comment_mention() from public, anon, authenticated;
revoke all on function private.notify_comment_subscribers() from public, anon, authenticated;
revoke all on function private.notify_record_assignment() from public, anon, authenticated;
revoke all on function app.send_automation_notice(uuid, uuid, text, text) from public, anon;
grant execute on function app.send_automation_notice(uuid, uuid, text, text) to authenticated;
