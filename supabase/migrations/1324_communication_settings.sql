-- 1324_communication_settings.sql
-- A76 Settings enforcement (RRR-121, A65-001, WP1): three Communication settings (Section 4.5.6 item 28) take effect.
--
--   * communication.feed_reactions_default and communication.feed_comments_default (default on): a feed post that
--     does not say whether members may react or comment takes the org's defaults. app.create_feed_post now leaves
--     both switches null unless the author sets them.
--   * communication.message_retention_days (default 730, 30 to 3,650): the nightly retention job deletes chat
--     messages older than the org's retention, skipping orgs under a legal hold on chat messages, and marks the
--     attachments of deleted messages deleted so the attachment retention removes their files. Every run is
--     recorded in private.retention_runs. The 3-year soft-delete policy on app.chat_messages still applies.

-- Feed defaults ----------------------------------------------------------------------------------------------------

create or replace function app.create_feed_post(
  p_org_id uuid,
  p_post_kind app.feed_post_kind,
  p_body text,
  p_title text default null,
  p_audience_kind app.audience_kind default 'Organization',
  p_project_id uuid default null,
  p_team_id uuid default null,
  p_role_id uuid default null,
  p_group_id uuid default null,
  p_pinned boolean default false,
  p_requires_acknowledgment boolean default false,
  p_reactions_enabled boolean default null,
  p_comments_enabled boolean default null,
  p_publish_at timestamptz default null,
  p_poll jsonb default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_mine uuid := private.require_membership_in(p_org_id);
  v_id uuid;
  v_poll uuid;
  v_option text;
  v_position smallint := 0;
begin
  if not private.has_capability(p_org_id, 'knowledge.document.write') then
    perform private.refuse('feed_post_authority', 'Posting to the feed needs knowledge.document.write.');
  end if;
  if (p_pinned or p_requires_acknowledgment) and not private.has_capability(p_org_id, 'knowledge.sop.publish') then
    perform private.refuse('feed_post_announce_authority', 'Pinning a post or requiring acknowledgment needs knowledge.sop.publish.');
  end if;
  if p_post_kind = 'Recognition' then
    perform private.refuse('feed_post_recognition', 'Recognition posts come from a shout-out; use Recognize instead.');
  end if;
  if (p_post_kind = 'Poll') <> (p_poll is not null) then
    perform private.refuse('feed_post_poll', 'A poll post carries a poll question and options, and only a poll post does.');
  end if;
  if p_publish_at is not null and p_publish_at < now() - interval '5 minutes' then
    perform private.refuse('feed_post_publish_past', 'A scheduled post needs a publish time in the future.');
  end if;
  perform private.assert_audience(p_org_id, p_audience_kind, p_project_id, p_team_id, p_role_id, p_group_id);
  if p_project_id is not null and not exists (select 1 from app.projects p where p.id = p_project_id and p.org_id = p_org_id
       and p.id in (select private.readable_project_ids())) then
    raise exception using errcode = '42501', message = 'the project does not exist or is not visible';
  end if;

  insert into app.feed_posts (org_id, author_membership_id, post_kind, title, body, audience_kind, project_id, team_id, role_id,
    group_id, pinned_at, requires_acknowledgment, reactions_enabled, comments_enabled, publish_at)
  values (p_org_id, v_mine, p_post_kind, nullif(btrim(p_title), ''), btrim(p_body), p_audience_kind, p_project_id, p_team_id,
    p_role_id, p_group_id, case when p_pinned then now() end, p_requires_acknowledgment,
    coalesce(p_reactions_enabled, private.setting_boolean(p_org_id, 'communication.feed_reactions_default'), true),
    coalesce(p_comments_enabled, private.setting_boolean(p_org_id, 'communication.feed_comments_default'), true),
    coalesce(p_publish_at, now()))
  returning id into v_id;

  if p_poll is not null then
    if jsonb_typeof(p_poll -> 'options') <> 'array' or jsonb_array_length(p_poll -> 'options') not between 2 and 10 then
      perform private.refuse('poll_options', 'A poll has 2 to 10 options.');
    end if;
    insert into app.polls (feed_post_id, question, allows_multiple, closes_at)
    values (v_id, coalesce(nullif(btrim(p_poll ->> 'question'), ''), btrim(p_body)),
      coalesce((p_poll ->> 'allows_multiple')::boolean, false), (p_poll ->> 'closes_at')::timestamptz)
    returning id into v_poll;
    for v_option in select jsonb_array_elements_text(p_poll -> 'options') loop
      v_position := v_position + 1;
      insert into app.poll_options (poll_id, position, label) values (v_poll, v_position, btrim(v_option));
    end loop;
  end if;

  perform private.notify_feed_post(v_id);
  return v_id;
end;
$$;

comment on function app.create_feed_post(uuid, app.feed_post_kind, text, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, timestamptz, jsonb) is 'Posts to the feed as the signed-in member (knowledge.document.write; pinning or requiring acknowledgment also needs knowledge.sop.publish). Reactions and comments follow the org''s communication.feed_reactions_default and communication.feed_comments_default unless the author sets them (1324). A future publish time schedules the post. A Poll post takes p_poll {question, options[2..10], allows_multiple, closes_at}. Publishing notifies the audience of announcements, polls and posts that need acknowledgment. Returns the post id.';

-- Message retention -------------------------------------------------------------------------------------------------

create or replace function private.purge_chat_messages_past_retention(p_now timestamptz default now())
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org record;
  v_ids uuid[];
  v_total bigint := 0;
begin
  for v_org in
    select o.id, coalesce(private.setting_integer(o.id, 'communication.message_retention_days'), 730) as days
    from app.organizations o
    where o.id not in (select private.held_org_ids('app.chat_messages'))
      and exists (select 1 from app.chat_messages m where m.org_id = o.id)
  loop
    begin
      select array_agg(m.id) into v_ids from app.chat_messages m
      where m.org_id = v_org.id and m.created_at < p_now - make_interval(days => v_org.days::integer);
      if v_ids is null then
        continue;
      end if;
      update app.attachments a set deleted_at = p_now
      where a.org_id = v_org.id and a.subject_table = 'app.chat_messages' and a.subject_id = any (v_ids) and a.deleted_at is null;
      perform private.begin_trusted_operation('retention_purge');
      delete from app.chat_messages m where m.id = any (v_ids);
      perform private.end_trusted_operation('retention_purge');
      v_total := v_total + cardinality(v_ids);
    exception when others then
      insert into private.retention_runs (table_name, action, rows_affected, error_message)
      values ('app.chat_messages', 'purge', 0, format('org %s: %s', v_org.id, sqlerrm));
    end;
  end loop;
  insert into private.retention_runs (table_name, action, rows_affected) values ('app.chat_messages', 'purge', v_total);
  return v_total;
end;
$$;

comment on function private.purge_chat_messages_past_retention(timestamptz) is 'Deletes chat messages older than each org''s communication.message_retention_days (1324), skipping orgs under a legal hold on chat messages, and marks the attachments of deleted messages deleted. Records the run, and any org it could not purge, in private.retention_runs. Returns the messages deleted.';
revoke all on function private.purge_chat_messages_past_retention(timestamptz) from public, anon, authenticated;

create or replace function private.run_nightly_retention()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.run_partition_maintenance();
  perform private.redact_audit_events();
  perform private.purge_chat_messages_past_retention();
  perform private.purge_expired_rows();
  perform private.prune_rate_limits();
end;
$$;

comment on function private.run_nightly_retention() is 'The nightly retention job: partition maintenance, audit redaction, chat messages past each org''s message retention (1324), row purge and rate limit pruning.';
