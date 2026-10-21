-- 1391_feed_post_defaults_and_departments.sql
--
-- Orchestrator block (ADR 0022, 1390-1399). 1324 (A76) made a new feed post take the org's
-- communication.feed_reactions_default and communication.feed_comments_default unless the author sets them; 1365 (A80)
-- then recreated app.create_feed_post with a Department audience (p_department_code) from the earlier body, which dropped
-- those defaults (p_reactions_enabled and p_comments_enabled went back to default true). This recreates it with both:
-- the Department audience, and null meaning "the org's default" for reactions and comments. Same arguments as 1365.

drop function app.create_feed_post(uuid, app.feed_post_kind, text, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, timestamptz, jsonb, text);

create function app.create_feed_post(
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
  p_poll jsonb default null,
  p_department_code text default null
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
  perform private.assert_audience(p_org_id, p_audience_kind, p_project_id, p_team_id, p_role_id, p_group_id, p_department_code);
  if p_project_id is not null and not exists (select 1 from app.projects p where p.id = p_project_id and p.org_id = p_org_id
       and p.id in (select private.readable_project_ids())) then
    raise exception using errcode = '42501', message = 'the project does not exist or is not visible';
  end if;

  insert into app.feed_posts (org_id, author_membership_id, post_kind, title, body, audience_kind, project_id, team_id, role_id,
    group_id, department_code, pinned_at, requires_acknowledgment, reactions_enabled, comments_enabled, publish_at)
  values (p_org_id, v_mine, p_post_kind, nullif(btrim(p_title), ''), btrim(p_body), p_audience_kind, p_project_id, p_team_id,
    p_role_id, p_group_id, p_department_code, case when p_pinned then now() end, p_requires_acknowledgment,
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
comment on function app.create_feed_post(uuid, app.feed_post_kind, text, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, timestamptz, jsonb, text) is 'Posts to the feed as the signed-in member (knowledge.document.write; pinning or requiring acknowledgment also needs knowledge.sop.publish). Reactions and comments follow the org''s communication.feed_reactions_default and communication.feed_comments_default unless the author sets them (1324, kept by 1391). A Department audience names a canon department code (p_department_code, 1365). A future publish time schedules the post. A Poll post takes p_poll {question, options[2..10], allows_multiple, closes_at}. Publishing notifies the audience of announcements, polls and posts that need acknowledgment. Returns the post id.';
revoke all on function app.create_feed_post(uuid, app.feed_post_kind, text, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, timestamptz, jsonb, text) from public, anon;
grant execute on function app.create_feed_post(uuid, app.feed_post_kind, text, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, timestamptz, jsonb, text) to authenticated, service_role;
