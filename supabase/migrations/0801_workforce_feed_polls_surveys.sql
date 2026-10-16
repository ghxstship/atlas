-- 0801_workforce_feed_polls_surveys.sql
-- A29 Workforce Suite (Section 4.9 Feed, Polls and surveys; managed in Atlas Knowledge, Feed):
--   * Feed posts reach an audience (0800). Pinned posts, required acknowledgments tracked per person,
--     reactions and comments that the author or a communication admin turns off per post, and scheduled
--     posts that appear and notify at their publish time.
--   * Posting needs knowledge.document.write; pinning and requiring acknowledgment need
--     knowledge.sop.publish; org.communication.write moderates (hides any post, changes any post's rules).
--   * Comments are A18 comments on app.feed_posts; a post with comments off refuses new comments.
--   * Quick polls live in the feed as a post of kind Poll, one vote per member (or one per option when the
--     poll allows several), results as counts.
--   * Pulse surveys: Draft, Open, Closed. Anonymous surveys store answers with no respondent, no creator
--     and only the day they arrived, and results show only once the minimum number of responses is met.

create type app.feed_post_kind as enum ('Announcement', 'Update', 'Poll', 'Recognition');
comment on type app.feed_post_kind is 'Feed post kinds: an announcement, an update, a quick poll, or a recognition shout-out (written by app.recognize).';

create type app.survey_state as enum ('Draft', 'Open', 'Closed');
comment on type app.survey_state is 'Pulse survey states: Draft (questions editable), Open (taking responses) and Closed (final).';

create type app.survey_question_kind as enum ('Scale', 'Choice', 'Text');
comment on type app.survey_question_kind is 'Survey question kinds: a scale from 1 to its maximum, one choice from a list, or free text.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('survey', 'Draft', 'Open'),
  ('survey', 'Open', 'Closed');

insert into private.domain_event_types (code, subject, description) values
  ('feed_post.published', 'feed_posts', 'A feed post was published to its audience.'),
  ('feed_post.hidden', 'feed_posts', 'A feed post was hidden by its author or a communication admin.'),
  ('feed_post.acknowledged', 'feed_acknowledgments', 'A member acknowledged a feed post that required it.'),
  ('poll.voted', 'poll_votes', 'A member voted in a feed poll.'),
  ('survey.opened', 'surveys', 'A pulse survey opened for responses.'),
  ('survey.closed', 'surveys', 'A pulse survey closed.');

-- Feed posts ----------------------------------------------------------------------------------------------------

create table app.feed_posts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  author_membership_id uuid references app.memberships (id),
  post_kind app.feed_post_kind not null,
  title text,
  body text not null,
  audience_kind app.audience_kind not null default 'Organization',
  project_id uuid references app.projects (id),
  team_id uuid references app.teams (id),
  role_id uuid references app.roles (id),
  group_id uuid references app.groups (id),
  pinned_at timestamptz,
  requires_acknowledgment boolean not null default false,
  reactions_enabled boolean not null default true,
  comments_enabled boolean not null default true,
  publish_at timestamptz not null default now(),
  notified_at timestamptz,
  hidden_at timestamptz,
  hidden_reason text,
  constraint feed_posts_title_length check (title is null or char_length(btrim(title)) between 1 and 200),
  constraint feed_posts_body_length check (char_length(btrim(body)) between 1 and 10000),
  constraint feed_posts_hidden_reason check ((hidden_at is null) = (hidden_reason is null)),
  constraint feed_posts_hidden_reason_length check (hidden_reason is null or char_length(btrim(hidden_reason)) between 1 and 500),
  constraint feed_posts_audience check (
    (audience_kind = 'Team') = (team_id is not null) and (audience_kind = 'Role') = (role_id is not null)
    and (audience_kind = 'Group') = (group_id is not null) and (audience_kind <> 'Project' or project_id is not null))
);
create index feed_posts_author_idx on app.feed_posts (author_membership_id);
create index feed_posts_project_idx on app.feed_posts (project_id);
create index feed_posts_team_idx on app.feed_posts (team_id);
create index feed_posts_role_idx on app.feed_posts (role_id);
create index feed_posts_group_idx on app.feed_posts (group_id);
create index feed_posts_feed_idx on app.feed_posts (org_id, publish_at desc);
call private.install_domain_table('app.feed_posts', null, null,
  array['app.memberships', 'author_membership_id', 'app.projects', 'project_id', 'app.teams', 'team_id', 'app.groups', 'group_id']);
call private.describe('app.feed_posts', 'A feed post (Section 4.9 Feed): an announcement, update, quick poll or recognition for an audience, with pinning, required acknowledgment, per-post reaction and comment switches and a publish time. Written through the feed RPCs.', array[
  'author_membership_id', 'Member who wrote the post.',
  'post_kind', 'Announcement, Update, Poll or Recognition.',
  'title', 'Optional headline.',
  'body', 'Post text.',
  'audience_kind', 'Who the post reaches: Organization, Project, Team, Role or Group.',
  'project_id', 'Project audience; also set on any post tied to a project.',
  'team_id', 'Team audience.',
  'role_id', 'Org role audience.',
  'group_id', 'Group audience, including department groups.',
  'pinned_at', 'When the post was pinned to the top of the feed; NULL when not pinned.',
  'requires_acknowledgment', 'Whether every member of the audience must acknowledge the post.',
  'reactions_enabled', 'Whether members can react.',
  'comments_enabled', 'Whether members can comment.',
  'publish_at', 'When the post appears; a future time schedules it.',
  'notified_at', 'When the audience was notified; NULL until the post publishes.',
  'hidden_at', 'When the author or a communication admin hid the post.',
  'hidden_reason', 'Why the post was hidden.'
]);

create or replace function private.can_read_feed_post(
  p_org_id uuid,
  p_author_membership_id uuid,
  p_publish_at timestamptz,
  p_hidden_at timestamptz,
  p_audience_kind app.audience_kind,
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
  select p_author_membership_id in (select private.my_membership_ids())
    or private.has_capability(p_org_id, 'org.communication.write')
    or (p_hidden_at is null and p_publish_at <= now()
        and private.in_audience(p_org_id, p_audience_kind, p_project_id, p_team_id, p_role_id, p_group_id));
$$;
comment on function private.can_read_feed_post(uuid, uuid, timestamptz, timestamptz, app.audience_kind, uuid, uuid, uuid, uuid) is 'Whether the signed-in person reads a feed post: its author, a communication admin, or a member of its audience once it is published and not hidden.';
revoke all on function private.can_read_feed_post(uuid, uuid, timestamptz, timestamptz, app.audience_kind, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function private.can_read_feed_post(uuid, uuid, timestamptz, timestamptz, app.audience_kind, uuid, uuid, uuid, uuid) to authenticated, service_role;

call private.install_policies('app.feed_posts',
  $$private.can_read_feed_post(org_id, author_membership_id, publish_at, hidden_at, audience_kind, project_id, team_id, role_id, group_id)$$);

create or replace function private.readable_feed_post_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from app.feed_posts p
  where p.deleted_at is null and p.org_id in (select private.my_org_ids())
    and private.can_read_feed_post(p.org_id, p.author_membership_id, p.publish_at, p.hidden_at, p.audience_kind,
      p.project_id, p.team_id, p.role_id, p.group_id);
$$;
comment on function private.readable_feed_post_ids() is 'Feed posts the signed-in person reads.';
revoke all on function private.readable_feed_post_ids() from public, anon;
grant execute on function private.readable_feed_post_ids() to authenticated, service_role;

-- A post keeps its author, kind, audience and text; its switches change through the RPCs.
create or replace function private.guard_feed_post()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.author_membership_id is distinct from old.author_membership_id or new.post_kind <> old.post_kind
     or new.audience_kind <> old.audience_kind or new.project_id is distinct from old.project_id
     or new.team_id is distinct from old.team_id or new.role_id is distinct from old.role_id or new.group_id is distinct from old.group_id
     or new.body <> old.body or new.title is distinct from old.title
     or new.requires_acknowledgment <> old.requires_acknowledgment then
    perform private.refuse('feed_post_fixed', 'A post keeps its author, audience, text and acknowledgment rule; hide it and post again.');
  end if;
  if old.publish_at <= now() and new.publish_at <> old.publish_at then
    perform private.refuse('feed_post_published', 'A published post keeps its publish time.');
  end if;
  if old.hidden_at is not null and new.hidden_at is distinct from old.hidden_at then
    perform private.refuse('feed_post_hidden', 'A hidden post stays hidden.');
  end if;
  return new;
end;
$$;
comment on function private.guard_feed_post() is 'Feed posts keep their author, kind, audience, text and acknowledgment rule; a published post keeps its time; hiding is final.';
revoke all on function private.guard_feed_post() from public, anon, authenticated;
create trigger t42_guard_feed_post before update on app.feed_posts
  for each row execute function private.guard_feed_post();

-- Acknowledgments, reactions -------------------------------------------------------------------------------------------

create table app.feed_acknowledgments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  feed_post_id uuid not null references app.feed_posts (id),
  membership_id uuid not null references app.memberships (id),
  acknowledged_at timestamptz not null default now()
);
create unique index feed_acknowledgments_key on app.feed_acknowledgments (feed_post_id, membership_id);
create index feed_acknowledgments_membership_idx on app.feed_acknowledgments (membership_id);
call private.install_domain_table('app.feed_acknowledgments', 'app.feed_posts', 'feed_post_id', array['app.memberships', 'membership_id'], true);
call private.describe('app.feed_acknowledgments', 'Append-only record of members acknowledging a feed post that requires it, one per member.', array[
  'feed_post_id', 'Post acknowledged.',
  'membership_id', 'Member who acknowledged.',
  'acknowledged_at', 'When they acknowledged.'
]);
call private.install_policies('app.feed_acknowledgments',
  $$membership_id = any (array(select private.my_membership_ids()))
    or (feed_post_id in (select private.readable_feed_post_ids())
        and (org_id = any (array(select private.orgs_with_capability('org.communication.write')))
             or org_id = any (array(select private.orgs_with_capability('knowledge.sop.publish')))))$$);

create table app.feed_reactions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  feed_post_id uuid not null references app.feed_posts (id),
  membership_id uuid not null references app.memberships (id),
  reaction_code text not null references private.comment_reaction_codes (code)
);
create index feed_reactions_membership_idx on app.feed_reactions (membership_id);
create index feed_reactions_code_idx on app.feed_reactions (reaction_code);
call private.install_domain_table('app.feed_reactions', 'app.feed_posts', 'feed_post_id', array['app.memberships', 'membership_id']);
create unique index feed_reactions_key on app.feed_reactions (feed_post_id, membership_id, reaction_code) where deleted_at is null;
call private.describe('app.feed_reactions', 'Reactions on feed posts, from the curated reaction set. Removing a reaction soft deletes it.', array[
  'feed_post_id', 'Post reacted to.',
  'membership_id', 'Member who reacted.',
  'reaction_code', 'Reaction glyph code.'
]);
call private.install_policies('app.feed_reactions', $$feed_post_id in (select private.readable_feed_post_ids())$$);

-- Comments respect the post's switch: A18 comments on a feed post with comments off are refused.
create or replace function private.refuse_closed_feed_post_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open boolean;
begin
  select p.comments_enabled and p.hidden_at is null into v_open
  from app.comment_threads t join app.feed_posts p on p.id = t.subject_id
  where t.id = new.comment_thread_id and t.subject_table = 'app.feed_posts';
  if v_open is false then
    perform private.refuse('feed_post_comments_off', 'Comments are turned off on this post.');
  end if;
  return new;
end;
$$;
comment on function private.refuse_closed_feed_post_comment() is 'Before insert on comments: refuses a comment on a feed post whose comments are turned off or that is hidden.';
revoke all on function private.refuse_closed_feed_post_comment() from public, anon, authenticated;
create trigger t35_feed_post_comments_open before insert on app.comments
  for each row execute function private.refuse_closed_feed_post_comment();

insert into private.comment_subjects (table_name) values ('app.feed_posts');

-- Polls ---------------------------------------------------------------------------------------------------------------------

create table app.polls (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  feed_post_id uuid not null references app.feed_posts (id),
  question text not null,
  allows_multiple boolean not null default false,
  closes_at timestamptz,
  constraint polls_question_length check (char_length(btrim(question)) between 1 and 300)
);
create unique index polls_feed_post_key on app.polls (feed_post_id);
call private.install_domain_table('app.polls', 'app.feed_posts', 'feed_post_id');
call private.describe('app.polls', 'A quick poll in the feed, attached to a post of kind Poll.', array[
  'feed_post_id', 'Feed post the poll belongs to.',
  'question', 'Poll question.',
  'allows_multiple', 'Whether a member may pick several options.',
  'closes_at', 'When voting closes; NULL stays open.'
]);
call private.install_policies('app.polls', $$feed_post_id in (select private.readable_feed_post_ids())$$);

create table app.poll_options (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  poll_id uuid not null references app.polls (id),
  position smallint not null,
  label text not null,
  constraint poll_options_label_length check (char_length(btrim(label)) between 1 and 120),
  constraint poll_options_position check (position between 1 and 10)
);
create unique index poll_options_position_key on app.poll_options (poll_id, position);
call private.install_domain_table('app.poll_options', 'app.polls', 'poll_id');
call private.describe('app.poll_options', 'Options of a feed poll, 2 to 10, in order.', array[
  'poll_id', 'Poll.',
  'position', 'Order, from 1.',
  'label', 'Option text.'
]);
call private.install_policies('app.poll_options',
  $$exists (select 1 from app.polls p where p.id = poll_id and p.feed_post_id in (select private.readable_feed_post_ids()))$$);

create table app.poll_votes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  poll_id uuid not null references app.polls (id),
  poll_option_id uuid not null references app.poll_options (id),
  membership_id uuid not null references app.memberships (id)
);
create unique index poll_votes_key on app.poll_votes (poll_option_id, membership_id);
create index poll_votes_poll_idx on app.poll_votes (poll_id, membership_id);
create index poll_votes_membership_idx on app.poll_votes (membership_id);
call private.install_domain_table('app.poll_votes', 'app.polls', 'poll_id', array['app.poll_options', 'poll_option_id', 'app.memberships', 'membership_id'], true);
call private.describe('app.poll_votes', 'Append-only votes in a feed poll. Members read their own votes; totals come from app.poll_results.', array[
  'poll_id', 'Poll voted in.',
  'poll_option_id', 'Option chosen.',
  'membership_id', 'Member who voted.'
]);
call private.install_policies('app.poll_votes', $$membership_id = any (array(select private.my_membership_ids()))$$);

-- Feed RPCs ---------------------------------------------------------------------------------------------------------------

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
    for v_person in
      select m.person_id from app.memberships m
      where m.id in (select private.audience_membership_ids(v_post.org_id, v_post.audience_kind, v_post.project_id,
        v_post.team_id, v_post.role_id, v_post.group_id))
        and m.id is distinct from v_post.author_membership_id
    loop
      perform private.notify(v_post.org_id, v_person, 'announcement.posted', 'app.feed_posts', v_post.id, v_post.project_id,
        jsonb_build_object('title', coalesce(v_post.title, left(v_post.body, 80)), 'requires_acknowledgment', v_post.requires_acknowledgment));
    end loop;
  end if;
end;
$$;
comment on function private.notify_feed_post(uuid) is 'Publishes a due feed post once: stamps notified_at, emits feed_post.published and notifies the audience of announcements, polls and posts that need acknowledgment.';
revoke all on function private.notify_feed_post(uuid) from public, anon, authenticated;

create or replace function private.publish_due_feed_posts()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select p.id from app.feed_posts p
    where p.notified_at is null and p.publish_at <= now() and p.hidden_at is null and p.deleted_at is null
    order by p.publish_at
  loop
    perform private.notify_feed_post(v_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
comment on function private.publish_due_feed_posts() is 'Cron job: publishes scheduled feed posts whose time has come. Returns how many it published.';
revoke all on function private.publish_due_feed_posts() from public, anon, authenticated;
select cron.schedule('xos_publish_scheduled_feed_posts', '*/5 * * * *', 'select private.publish_due_feed_posts()');

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
  p_reactions_enabled boolean default true,
  p_comments_enabled boolean default true,
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
    p_role_id, p_group_id, case when p_pinned then now() end, p_requires_acknowledgment, p_reactions_enabled, p_comments_enabled,
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
comment on function app.create_feed_post(uuid, app.feed_post_kind, text, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, timestamptz, jsonb) is 'Posts to the feed as the signed-in member (knowledge.document.write; pinning or requiring acknowledgment also needs knowledge.sop.publish). A future publish time schedules the post. A Poll post takes p_poll {question, options[2..10], allows_multiple, closes_at}. Publishing notifies the audience of announcements, polls and posts that need acknowledgment. Returns the post id.';
revoke all on function app.create_feed_post(uuid, app.feed_post_kind, text, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, timestamptz, jsonb) from public, anon;
grant execute on function app.create_feed_post(uuid, app.feed_post_kind, text, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, timestamptz, jsonb) to authenticated, service_role;

create or replace function app.update_feed_post(
  p_post_id uuid,
  p_pinned boolean default null,
  p_reactions_enabled boolean default null,
  p_comments_enabled boolean default null,
  p_publish_at timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post app.feed_posts;
  v_author boolean;
  v_admin boolean;
begin
  perform private.require_person();
  select * into v_post from app.feed_posts p where p.id = p_post_id and p.deleted_at is null;
  if v_post.id is null or v_post.id not in (select private.readable_feed_post_ids()) then
    raise exception using errcode = '42501', message = 'the post does not exist or is not visible';
  end if;
  v_author := v_post.author_membership_id in (select private.my_membership_ids());
  v_admin := private.has_capability(v_post.org_id, 'org.communication.write');
  if not v_author and not v_admin then
    perform private.refuse('feed_post_not_author', 'Only the author or a communication admin changes a post.');
  end if;
  if p_pinned is not null and not v_admin and not private.has_capability(v_post.org_id, 'knowledge.sop.publish') then
    perform private.refuse('feed_post_announce_authority', 'Pinning a post needs knowledge.sop.publish.');
  end if;
  update app.feed_posts set
    pinned_at = case when p_pinned is null then pinned_at when p_pinned then coalesce(pinned_at, now()) else null end,
    reactions_enabled = coalesce(p_reactions_enabled, reactions_enabled),
    comments_enabled = coalesce(p_comments_enabled, comments_enabled),
    publish_at = coalesce(p_publish_at, publish_at)
  where id = p_post_id;
  return p_post_id;
end;
$$;
comment on function app.update_feed_post(uuid, boolean, boolean, boolean, timestamptz) is 'The author or a communication admin pins or unpins a post (knowledge.sop.publish or org.communication.write), turns reactions or comments on or off, or moves a scheduled post. Returns the post id.';
revoke all on function app.update_feed_post(uuid, boolean, boolean, boolean, timestamptz) from public, anon;
grant execute on function app.update_feed_post(uuid, boolean, boolean, boolean, timestamptz) to authenticated, service_role;

create or replace function app.hide_feed_post(p_post_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post app.feed_posts;
begin
  perform private.require_person();
  select * into v_post from app.feed_posts p where p.id = p_post_id and p.deleted_at is null;
  if v_post.id is null or v_post.id not in (select private.readable_feed_post_ids()) then
    raise exception using errcode = '42501', message = 'the post does not exist or is not visible';
  end if;
  if v_post.author_membership_id not in (select private.my_membership_ids())
     and not private.has_capability(v_post.org_id, 'org.communication.write') then
    perform private.refuse('feed_post_not_author', 'Only the author or a communication admin hides a post.');
  end if;
  update app.feed_posts set hidden_at = now(), hidden_reason = btrim(p_reason), pinned_at = null where id = p_post_id;
  perform private.emit_event(v_post.org_id, 'feed_post.hidden', 'feed_posts', p_post_id, v_post.project_id,
    jsonb_build_object('reason', btrim(p_reason)));
  return p_post_id;
end;
$$;
comment on function app.hide_feed_post(uuid, text) is 'The author or a communication admin hides a post with a reason; it leaves the feed for everyone else. Returns the post id.';
revoke all on function app.hide_feed_post(uuid, text) from public, anon;
grant execute on function app.hide_feed_post(uuid, text) to authenticated, service_role;

create or replace function app.acknowledge_feed_post(p_post_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post app.feed_posts;
  v_mine uuid;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_post from app.feed_posts p where p.id = p_post_id and p.deleted_at is null;
  if v_post.id is null or not (v_post.hidden_at is null and v_post.publish_at <= now()
       and private.in_audience(v_post.org_id, v_post.audience_kind, v_post.project_id, v_post.team_id, v_post.role_id, v_post.group_id)) then
    raise exception using errcode = '42501', message = 'the post does not exist or is not in your feed';
  end if;
  if not v_post.requires_acknowledgment then
    perform private.refuse('feed_post_no_acknowledgment', 'This post does not ask for acknowledgment.');
  end if;
  v_mine := private.my_membership_in(v_post.org_id);
  select a.id into v_id from app.feed_acknowledgments a where a.feed_post_id = p_post_id and a.membership_id = v_mine;
  if v_id is null then
    insert into app.feed_acknowledgments (feed_post_id, membership_id) values (p_post_id, v_mine) returning id into v_id;
    perform private.emit_event(v_post.org_id, 'feed_post.acknowledged', 'feed_acknowledgments', v_id, v_post.project_id,
      jsonb_build_object('feed_post_id', p_post_id));
  end if;
  return v_id;
end;
$$;
comment on function app.acknowledge_feed_post(uuid) is 'Records that the signed-in member acknowledged a published post that requires it. Acknowledging twice returns the first record. Returns the acknowledgment id.';
revoke all on function app.acknowledge_feed_post(uuid) from public, anon;
grant execute on function app.acknowledge_feed_post(uuid) to authenticated, service_role;

create or replace function app.react_to_feed_post(p_post_id uuid, p_reaction_code text, p_on boolean default true)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post app.feed_posts;
  v_mine uuid;
begin
  perform private.require_person();
  select * into v_post from app.feed_posts p where p.id = p_post_id and p.deleted_at is null;
  if v_post.id is null or v_post.id not in (select private.readable_feed_post_ids()) then
    raise exception using errcode = '42501', message = 'the post does not exist or is not visible';
  end if;
  if not v_post.reactions_enabled or v_post.hidden_at is not null then
    perform private.refuse('feed_post_reactions_off', 'Reactions are turned off on this post.');
  end if;
  if not exists (select 1 from private.comment_reaction_codes c where c.code = p_reaction_code) then
    perform private.refuse('reaction_code_unknown', 'Pick a reaction from the reaction set.');
  end if;
  v_mine := private.require_membership_in(v_post.org_id);
  if p_on then
    insert into app.feed_reactions (feed_post_id, membership_id, reaction_code)
    select p_post_id, v_mine, p_reaction_code
    where not exists (select 1 from app.feed_reactions r where r.feed_post_id = p_post_id and r.membership_id = v_mine
      and r.reaction_code = p_reaction_code and r.deleted_at is null);
  else
    update app.feed_reactions set deleted_at = now()
    where feed_post_id = p_post_id and membership_id = v_mine and reaction_code = p_reaction_code and deleted_at is null;
  end if;
  return p_on;
end;
$$;
comment on function app.react_to_feed_post(uuid, text, boolean) is 'Adds or removes the signed-in member''s reaction on a post whose reactions are on. Returns whether the reaction is now on.';
revoke all on function app.react_to_feed_post(uuid, text, boolean) from public, anon;
grant execute on function app.react_to_feed_post(uuid, text, boolean) to authenticated, service_role;

-- Who in a post's audience has acknowledged it, for its author and admins.
create or replace function app.feed_acknowledgment_status(p_post_id uuid)
returns table (membership_id uuid, person_id uuid, full_name text, acknowledged_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_post app.feed_posts;
begin
  perform private.require_person();
  select * into v_post from app.feed_posts p where p.id = p_post_id and p.deleted_at is null;
  if v_post.id is null or v_post.id not in (select private.readable_feed_post_ids()) then
    raise exception using errcode = '42501', message = 'the post does not exist or is not visible';
  end if;
  if v_post.author_membership_id not in (select private.my_membership_ids())
     and not private.has_capability(v_post.org_id, 'org.communication.write')
     and not private.has_capability(v_post.org_id, 'knowledge.sop.publish') then
    perform private.refuse('feed_acknowledgment_status_authority', 'Acknowledgment tracking is for the author and communication admins.');
  end if;
  return query
    select m.id, m.person_id, coalesce(pe.full_name, ''), a.acknowledged_at
    from app.memberships m
    join app.people pe on pe.id = m.person_id
    left join app.feed_acknowledgments a on a.feed_post_id = v_post.id and a.membership_id = m.id
    where m.id in (select private.audience_membership_ids(v_post.org_id, v_post.audience_kind, v_post.project_id, v_post.team_id,
      v_post.role_id, v_post.group_id))
    order by a.acknowledged_at nulls first, pe.full_name;
end;
$$;
comment on function app.feed_acknowledgment_status(uuid) is 'Each member of a post''s audience with when they acknowledged it, outstanding first. For the author, communication admins and holders of knowledge.sop.publish.';
revoke all on function app.feed_acknowledgment_status(uuid) from public, anon;
grant execute on function app.feed_acknowledgment_status(uuid) to authenticated, service_role;

create or replace function app.vote_in_poll(p_poll_id uuid, p_option_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_poll app.polls;
  v_post app.feed_posts;
  v_mine uuid;
  v_option uuid;
begin
  perform private.require_person();
  select * into v_poll from app.polls p where p.id = p_poll_id and p.deleted_at is null;
  select * into v_post from app.feed_posts p where p.id = v_poll.feed_post_id and p.deleted_at is null;
  if v_poll.id is null or v_post.hidden_at is not null or v_post.publish_at > now()
     or not private.in_audience(v_post.org_id, v_post.audience_kind, v_post.project_id, v_post.team_id, v_post.role_id, v_post.group_id) then
    raise exception using errcode = '42501', message = 'the poll does not exist or is not in your feed';
  end if;
  if v_poll.closes_at is not null and v_poll.closes_at <= now() then
    perform private.refuse('poll_closed', 'This poll has closed.');
  end if;
  if coalesce(cardinality(p_option_ids), 0) = 0 or (not v_poll.allows_multiple and cardinality(p_option_ids) > 1) then
    perform private.refuse('poll_choice_count', 'Pick one option, or several when the poll allows it.');
  end if;
  v_mine := private.my_membership_in(v_post.org_id);
  if exists (select 1 from app.poll_votes v where v.poll_id = p_poll_id and v.membership_id = v_mine) then
    perform private.refuse('poll_already_voted', 'You already voted in this poll.');
  end if;
  foreach v_option in array p_option_ids loop
    if not exists (select 1 from app.poll_options o where o.id = v_option and o.poll_id = p_poll_id and o.deleted_at is null) then
      perform private.refuse('poll_option_unknown', 'Pick options from this poll.');
    end if;
    insert into app.poll_votes (poll_id, poll_option_id, membership_id) values (p_poll_id, v_option, v_mine);
  end loop;
  perform private.emit_event(v_post.org_id, 'poll.voted', 'polls', p_poll_id, v_post.project_id,
    jsonb_build_object('choices', cardinality(p_option_ids)));
  return cardinality(p_option_ids);
end;
$$;
comment on function app.vote_in_poll(uuid, uuid[]) is 'Votes once in an open feed poll the signed-in member can see: one option, or several when the poll allows it. Returns the number of options chosen.';
revoke all on function app.vote_in_poll(uuid, uuid[]) from public, anon;
grant execute on function app.vote_in_poll(uuid, uuid[]) to authenticated, service_role;

create or replace function app.poll_results(p_poll_id uuid)
returns table (poll_option_id uuid, option_position smallint, label text, votes integer, voters integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from app.polls p where p.id = p_poll_id and p.deleted_at is null
                 and p.feed_post_id in (select private.readable_feed_post_ids())) then
    raise exception using errcode = '42501', message = 'the poll does not exist or is not visible';
  end if;
  return query
    select o.id, o.position, o.label,
      (select count(*)::integer from app.poll_votes v where v.poll_option_id = o.id),
      (select count(distinct v.membership_id)::integer from app.poll_votes v where v.poll_id = p_poll_id)
    from app.poll_options o where o.poll_id = p_poll_id and o.deleted_at is null order by o.position;
end;
$$;
comment on function app.poll_results(uuid) is 'Vote counts per option of a poll the caller can see, with the number of members who voted.';
revoke all on function app.poll_results(uuid) from public, anon;
grant execute on function app.poll_results(uuid) to authenticated, service_role;

-- Pulse surveys ---------------------------------------------------------------------------------------------------------------

create table app.surveys (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  author_membership_id uuid references app.memberships (id),
  title text not null,
  description text,
  audience_kind app.audience_kind not null default 'Organization',
  project_id uuid references app.projects (id),
  team_id uuid references app.teams (id),
  role_id uuid references app.roles (id),
  group_id uuid references app.groups (id),
  is_anonymous boolean not null default true,
  min_responses smallint not null default 5,
  survey_state app.survey_state not null default 'Draft',
  closes_at timestamptz,
  constraint surveys_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint surveys_description_length check (description is null or char_length(description) <= 2000),
  constraint surveys_min_responses check (min_responses between 3 and 1000),
  constraint surveys_audience check (
    (audience_kind = 'Team') = (team_id is not null) and (audience_kind = 'Role') = (role_id is not null)
    and (audience_kind = 'Group') = (group_id is not null) and (audience_kind <> 'Project' or project_id is not null))
);
create index surveys_author_idx on app.surveys (author_membership_id);
create index surveys_project_idx on app.surveys (project_id);
create index surveys_team_idx on app.surveys (team_id);
create index surveys_role_idx on app.surveys (role_id);
create index surveys_group_idx on app.surveys (group_id);
create index surveys_state_idx on app.surveys (org_id, survey_state);
call private.install_domain_table('app.surveys', null, null,
  array['app.memberships', 'author_membership_id', 'app.projects', 'project_id', 'app.teams', 'team_id', 'app.groups', 'group_id']);
call private.describe('app.surveys', 'A pulse survey (Section 4.9 Polls and surveys) for an audience, anonymous by default, whose results show only once the minimum number of responses is met.', array[
  'author_membership_id', 'Member who wrote the survey.',
  'title', 'Survey title.',
  'description', 'What the survey asks about and why.',
  'audience_kind', 'Who the survey reaches.',
  'project_id', 'Project audience.',
  'team_id', 'Team audience.',
  'role_id', 'Org role audience.',
  'group_id', 'Group audience.',
  'is_anonymous', 'Whether answers are stored with no respondent.',
  'min_responses', 'Responses needed before anyone sees results, 3 or more.',
  'survey_state', 'Draft, Open or Closed.',
  'closes_at', 'When the survey stops taking responses; NULL until closed by hand.'
]);

create or replace function private.can_read_survey(
  p_org_id uuid,
  p_author_membership_id uuid,
  p_state app.survey_state,
  p_audience_kind app.audience_kind,
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
  select p_author_membership_id in (select private.my_membership_ids())
    or private.has_capability(p_org_id, 'org.communication.write')
    or private.has_capability(p_org_id, 'knowledge.sop.publish')
    or (p_state <> 'Draft' and private.in_audience(p_org_id, p_audience_kind, p_project_id, p_team_id, p_role_id, p_group_id));
$$;
comment on function private.can_read_survey(uuid, uuid, app.survey_state, app.audience_kind, uuid, uuid, uuid, uuid) is 'Whether the signed-in person reads a survey: its author, survey managers (knowledge.sop.publish, org.communication.write), or its audience once it opens.';
revoke all on function private.can_read_survey(uuid, uuid, app.survey_state, app.audience_kind, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function private.can_read_survey(uuid, uuid, app.survey_state, app.audience_kind, uuid, uuid, uuid, uuid) to authenticated, service_role;

call private.install_policies('app.surveys',
  $$private.can_read_survey(org_id, author_membership_id, survey_state, audience_kind, project_id, team_id, role_id, group_id)$$);

create or replace function private.readable_survey_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from app.surveys s
  where s.deleted_at is null and s.org_id in (select private.my_org_ids())
    and private.can_read_survey(s.org_id, s.author_membership_id, s.survey_state, s.audience_kind, s.project_id, s.team_id, s.role_id, s.group_id);
$$;
comment on function private.readable_survey_ids() is 'Surveys the signed-in person reads.';
revoke all on function private.readable_survey_ids() from public, anon;
grant execute on function private.readable_survey_ids() to authenticated, service_role;

call private.install_lifecycle('app.surveys', 'survey_id', 'survey_state', 'survey', 'Draft',
  $$survey_id in (select private.readable_survey_ids())$$);

create table app.survey_questions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  survey_id uuid not null references app.surveys (id),
  position smallint not null,
  prompt text not null,
  question_kind app.survey_question_kind not null,
  choices text[],
  scale_max smallint,
  is_required boolean not null default true,
  constraint survey_questions_prompt_length check (char_length(btrim(prompt)) between 1 and 500),
  constraint survey_questions_position check (position between 1 and 50),
  constraint survey_questions_choices check ((question_kind = 'Choice') = (choices is not null and cardinality(choices) between 2 and 10)),
  constraint survey_questions_scale check ((question_kind = 'Scale') = (scale_max is not null) and (scale_max is null or scale_max in (5, 10)))
);
create unique index survey_questions_position_key on app.survey_questions (survey_id, position);
call private.install_domain_table('app.survey_questions', 'app.surveys', 'survey_id');
call private.describe('app.survey_questions', 'Questions of a pulse survey, in order. They change only while the survey is a draft.', array[
  'survey_id', 'Survey.',
  'position', 'Order, from 1.',
  'prompt', 'Question text.',
  'question_kind', 'Scale, Choice or Text.',
  'choices', 'Options of a Choice question, 2 to 10.',
  'scale_max', 'Top of a Scale question: 5 or 10.',
  'is_required', 'Whether a response must answer it.'
]);
call private.install_policies('app.survey_questions', $$survey_id in (select private.readable_survey_ids())$$);

create table app.survey_participations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  survey_id uuid not null references app.surveys (id),
  membership_id uuid not null references app.memberships (id)
);
create unique index survey_participations_key on app.survey_participations (survey_id, membership_id);
create index survey_participations_membership_idx on app.survey_participations (membership_id);
call private.install_domain_table('app.survey_participations', 'app.surveys', 'survey_id', array['app.memberships', 'membership_id'], true);
call private.describe('app.survey_participations', 'Append-only record that a member has responded to a survey, so each member responds once. It never links to the answers of an anonymous survey.', array[
  'survey_id', 'Survey responded to.',
  'membership_id', 'Member who responded.'
]);
call private.install_policies('app.survey_participations', $$membership_id = any (array(select private.my_membership_ids()))$$);

create table app.survey_responses (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  survey_id uuid not null references app.surveys (id),
  respondent_membership_id uuid references app.memberships (id)
);
create index survey_responses_survey_idx on app.survey_responses (survey_id);
create index survey_responses_respondent_idx on app.survey_responses (respondent_membership_id);
call private.install_domain_table('app.survey_responses', 'app.surveys', 'survey_id', array['app.memberships', 'respondent_membership_id'], true);
call private.describe('app.survey_responses', 'Append-only survey responses. For an anonymous survey the respondent, creator and time of day are never stored.', array[
  'survey_id', 'Survey answered.',
  'respondent_membership_id', 'Member who answered; NULL for an anonymous survey.'
]);
call private.install_policies('app.survey_responses', $$respondent_membership_id = any (array(select private.my_membership_ids()))$$);

create table app.survey_answers (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  survey_response_id uuid not null references app.survey_responses (id),
  survey_question_id uuid not null references app.survey_questions (id),
  scale_value smallint,
  choice text,
  text_value text,
  constraint survey_answers_one_value check (num_nonnulls(scale_value, choice, text_value) = 1),
  constraint survey_answers_text_length check (text_value is null or char_length(btrim(text_value)) between 1 and 2000)
);
create unique index survey_answers_key on app.survey_answers (survey_response_id, survey_question_id);
create index survey_answers_question_idx on app.survey_answers (survey_question_id);
call private.install_domain_table('app.survey_answers', 'app.survey_responses', 'survey_response_id', array['app.survey_questions', 'survey_question_id'], true);
call private.describe('app.survey_answers', 'Append-only answers of a survey response, one per question.', array[
  'survey_response_id', 'Response the answer belongs to.',
  'survey_question_id', 'Question answered.',
  'scale_value', 'Scale answer.',
  'choice', 'Choice answer.',
  'text_value', 'Free text answer.'
]);
call private.install_policies('app.survey_answers',
  $$exists (select 1 from app.survey_responses r where r.id = survey_response_id and r.respondent_membership_id = any (array(select private.my_membership_ids())))$$);

-- Anonymous responses carry no creator and only the day they arrived (runs after the audit stamp).
create or replace function private.anonymize_survey_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_anonymous boolean;
begin
  if tg_table_name = 'survey_responses' then
    v_anonymous := (to_jsonb(new) ->> 'respondent_membership_id') is null;
  else
    v_anonymous := exists (select 1 from app.survey_responses r
      where r.id = (to_jsonb(new) ->> 'survey_response_id')::uuid and r.respondent_membership_id is null);
  end if;
  if v_anonymous then
    new.created_by := null;
    new.updated_by := null;
    new.created_at := date_trunc('day', new.created_at);
    new.updated_at := new.created_at;
  end if;
  return new;
end;
$$;
comment on function private.anonymize_survey_row() is 'Before insert, after the audit stamp: strips the creator and the time of day from anonymous survey responses and answers.';
revoke all on function private.anonymize_survey_row() from public, anon, authenticated;
create trigger t95_anonymize_survey_response before insert on app.survey_responses
  for each row execute function private.anonymize_survey_row();
create trigger t95_anonymize_survey_answer before insert on app.survey_answers
  for each row execute function private.anonymize_survey_row();

-- Survey questions change only while the survey is a draft.
create or replace function private.guard_survey_question()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select s.survey_state from app.surveys s where s.id = new.survey_id) <> 'Draft' then
    perform private.refuse('survey_not_draft', 'Questions change only while the survey is a draft.');
  end if;
  return new;
end;
$$;
comment on function private.guard_survey_question() is 'Survey questions are written and edited only while their survey is a draft.';
revoke all on function private.guard_survey_question() from public, anon, authenticated;
create trigger t42_guard_survey_question before insert or update on app.survey_questions
  for each row execute function private.guard_survey_question();

-- A survey keeps its audience and anonymity once it leaves draft.
create or replace function private.guard_survey()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.survey_state <> 'Draft' and (new.is_anonymous <> old.is_anonymous or new.min_responses <> old.min_responses
     or new.audience_kind <> old.audience_kind or new.project_id is distinct from old.project_id
     or new.team_id is distinct from old.team_id or new.role_id is distinct from old.role_id or new.group_id is distinct from old.group_id
     or new.title <> old.title) then
    perform private.refuse('survey_not_draft', 'An open survey keeps its title, audience, anonymity and threshold.');
  end if;
  if new.author_membership_id is distinct from old.author_membership_id then
    perform private.refuse('survey_author_fixed', 'A survey keeps its author.');
  end if;
  return new;
end;
$$;
comment on function private.guard_survey() is 'A survey keeps its author, and its title, audience, anonymity and threshold once it opens.';
revoke all on function private.guard_survey() from public, anon, authenticated;
create trigger t42_guard_survey before update on app.surveys
  for each row execute function private.guard_survey();

-- Survey RPCs ---------------------------------------------------------------------------------------------------------------

create or replace function app.create_survey(
  p_org_id uuid,
  p_title text,
  p_questions jsonb,
  p_description text default null,
  p_audience_kind app.audience_kind default 'Organization',
  p_project_id uuid default null,
  p_team_id uuid default null,
  p_role_id uuid default null,
  p_group_id uuid default null,
  p_is_anonymous boolean default true,
  p_min_responses smallint default 5,
  p_closes_at timestamptz default null
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
  v_question jsonb;
  v_position smallint := 0;
begin
  if not private.has_capability(p_org_id, 'knowledge.sop.publish') then
    perform private.refuse('survey_authority', 'Writing surveys needs knowledge.sop.publish.');
  end if;
  if jsonb_typeof(p_questions) <> 'array' or jsonb_array_length(p_questions) not between 1 and 50 then
    perform private.refuse('survey_questions', 'A survey has 1 to 50 questions.');
  end if;
  perform private.assert_audience(p_org_id, p_audience_kind, p_project_id, p_team_id, p_role_id, p_group_id);
  insert into app.surveys (org_id, author_membership_id, title, description, audience_kind, project_id, team_id, role_id, group_id,
    is_anonymous, min_responses, closes_at)
  values (p_org_id, v_mine, btrim(p_title), nullif(btrim(p_description), ''), p_audience_kind, p_project_id, p_team_id, p_role_id,
    p_group_id, p_is_anonymous, p_min_responses, p_closes_at)
  returning id into v_id;
  for v_question in select jsonb_array_elements(p_questions) loop
    v_position := v_position + 1;
    insert into app.survey_questions (survey_id, position, prompt, question_kind, choices, scale_max, is_required)
    values (v_id, v_position, btrim(v_question ->> 'prompt'), (v_question ->> 'kind')::app.survey_question_kind,
      case when v_question ? 'choices' then array(select jsonb_array_elements_text(v_question -> 'choices')) end,
      (v_question ->> 'scale_max')::smallint, coalesce((v_question ->> 'required')::boolean, true));
  end loop;
  return v_id;
end;
$$;
comment on function app.create_survey(uuid, text, jsonb, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, smallint, timestamptz) is 'Drafts a pulse survey (knowledge.sop.publish) with questions [{prompt, kind Scale|Choice|Text, choices, scale_max 5|10, required}]. Anonymous by default with at least 3 responses before results show. Returns the survey id.';
revoke all on function app.create_survey(uuid, text, jsonb, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, smallint, timestamptz) from public, anon;
grant execute on function app.create_survey(uuid, text, jsonb, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, smallint, timestamptz) to authenticated, service_role;

create or replace function app.transition_survey(p_survey_id uuid, p_expected app.survey_state, p_next app.survey_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_survey app.surveys;
  v_ledger uuid;
  v_person uuid;
begin
  perform private.require_person();
  select * into v_survey from app.surveys s where s.id = p_survey_id and s.deleted_at is null;
  if v_survey.id is null or v_survey.id not in (select private.readable_survey_ids()) then
    raise exception using errcode = '42501', message = 'the survey does not exist or is not visible';
  end if;
  if v_survey.author_membership_id not in (select private.my_membership_ids())
     and not private.has_capability(v_survey.org_id, 'knowledge.sop.publish') then
    perform private.refuse('survey_authority', 'Opening and closing surveys needs knowledge.sop.publish.');
  end if;
  v_ledger := private.transition_lifecycle('survey', 'app.surveys', 'survey_state', 'app.survey_state_transitions', 'survey_id',
    p_survey_id, p_expected::text, p_next::text, p_reason);
  if p_next = 'Open' then
    perform private.emit_event(v_survey.org_id, 'survey.opened', 'surveys', p_survey_id, v_survey.project_id,
      jsonb_build_object('anonymous', v_survey.is_anonymous, 'min_responses', v_survey.min_responses));
    for v_person in
      select m.person_id from app.memberships m
      where m.id in (select private.audience_membership_ids(v_survey.org_id, v_survey.audience_kind, v_survey.project_id,
        v_survey.team_id, v_survey.role_id, v_survey.group_id))
    loop
      perform private.notify(v_survey.org_id, v_person, 'survey.opened', 'app.surveys', p_survey_id, v_survey.project_id,
        jsonb_build_object('title', v_survey.title, 'anonymous', v_survey.is_anonymous));
    end loop;
  elsif p_next = 'Closed' then
    update app.surveys set closes_at = least(coalesce(closes_at, now()), now()) where id = p_survey_id;
    perform private.emit_event(v_survey.org_id, 'survey.closed', 'surveys', p_survey_id, v_survey.project_id,
      jsonb_build_object('responses', (select count(*) from app.survey_responses r where r.survey_id = p_survey_id)));
  end if;
  return v_ledger;
end;
$$;
comment on function app.transition_survey(uuid, app.survey_state, app.survey_state, text) is 'Opens a draft survey (notifying its audience) or closes an open one. Needs the author or knowledge.sop.publish. Returns the ledger entry id.';
revoke all on function app.transition_survey(uuid, app.survey_state, app.survey_state, text) from public, anon;
grant execute on function app.transition_survey(uuid, app.survey_state, app.survey_state, text) to authenticated, service_role;

create or replace function app.respond_to_survey(p_survey_id uuid, p_answers jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_survey app.surveys;
  v_mine uuid;
  v_response uuid;
  v_question app.survey_questions;
  v_answer jsonb;
begin
  perform private.require_person();
  select * into v_survey from app.surveys s where s.id = p_survey_id and s.deleted_at is null;
  if v_survey.id is null or not private.in_audience(v_survey.org_id, v_survey.audience_kind, v_survey.project_id, v_survey.team_id,
       v_survey.role_id, v_survey.group_id) then
    raise exception using errcode = '42501', message = 'the survey does not exist or is not for you';
  end if;
  if v_survey.survey_state <> 'Open' or (v_survey.closes_at is not null and v_survey.closes_at <= now()) then
    perform private.refuse('survey_not_open', 'This survey is not taking responses.');
  end if;
  v_mine := private.my_membership_in(v_survey.org_id);
  if exists (select 1 from app.survey_participations p where p.survey_id = p_survey_id and p.membership_id = v_mine) then
    perform private.refuse('survey_already_responded', 'You already responded to this survey.');
  end if;
  if jsonb_typeof(p_answers) <> 'object' then
    perform private.refuse('survey_answers', 'Answers come as an object keyed by question id.');
  end if;
  insert into app.survey_participations (survey_id, membership_id) values (p_survey_id, v_mine);
  insert into app.survey_responses (survey_id, respondent_membership_id)
  values (p_survey_id, case when v_survey.is_anonymous then null else v_mine end)
  returning id into v_response;
  for v_question in select * from app.survey_questions q where q.survey_id = p_survey_id and q.deleted_at is null order by q.position loop
    v_answer := p_answers -> v_question.id::text;
    if v_answer is null or v_answer = 'null'::jsonb or (jsonb_typeof(v_answer) = 'string' and btrim(v_answer #>> '{}') = '') then
      if v_question.is_required then
        perform private.refuse('survey_answer_required', format('Answer question %s; it is required.', v_question.position));
      end if;
      continue;
    end if;
    if v_question.question_kind = 'Scale' then
      if jsonb_typeof(v_answer) <> 'number' or (v_answer #>> '{}')::numeric not between 1 and v_question.scale_max
         or (v_answer #>> '{}')::numeric <> trunc((v_answer #>> '{}')::numeric) then
        perform private.refuse('survey_answer_scale', format('Question %s takes a whole number from 1 to %s.', v_question.position, v_question.scale_max));
      end if;
      insert into app.survey_answers (survey_response_id, survey_question_id, scale_value) values (v_response, v_question.id, (v_answer #>> '{}')::smallint);
    elsif v_question.question_kind = 'Choice' then
      if not ((v_answer #>> '{}') = any (v_question.choices)) then
        perform private.refuse('survey_answer_choice', format('Question %s takes one of its listed choices.', v_question.position));
      end if;
      insert into app.survey_answers (survey_response_id, survey_question_id, choice) values (v_response, v_question.id, v_answer #>> '{}');
    else
      insert into app.survey_answers (survey_response_id, survey_question_id, text_value) values (v_response, v_question.id, btrim(v_answer #>> '{}'));
    end if;
  end loop;
  return case when v_survey.is_anonymous then null else v_response end;
end;
$$;
comment on function app.respond_to_survey(uuid, jsonb) is 'Responds once to an open survey for the signed-in member, with answers keyed by question id (a number for Scale, a listed choice for Choice, text for Text). Returns the response id, or null for an anonymous survey so nothing links the caller to it.';
revoke all on function app.respond_to_survey(uuid, jsonb) from public, anon;
grant execute on function app.respond_to_survey(uuid, jsonb) to authenticated, service_role;

create or replace function app.survey_results(p_survey_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_survey app.surveys;
  v_responses integer;
  v_met boolean;
begin
  perform private.require_person();
  select * into v_survey from app.surveys s where s.id = p_survey_id and s.deleted_at is null;
  if v_survey.id is null or v_survey.id not in (select private.readable_survey_ids()) then
    raise exception using errcode = '42501', message = 'the survey does not exist or is not visible';
  end if;
  if v_survey.author_membership_id not in (select private.my_membership_ids())
     and not private.has_capability(v_survey.org_id, 'knowledge.sop.publish')
     and not private.has_capability(v_survey.org_id, 'org.communication.write') then
    perform private.refuse('survey_results_authority', 'Survey results are for the author and survey managers.');
  end if;
  v_responses := (select count(*)::integer from app.survey_responses r where r.survey_id = p_survey_id);
  v_met := v_responses >= v_survey.min_responses;
  return jsonb_build_object(
    'survey_id', v_survey.id,
    'responses', v_responses,
    'min_responses', v_survey.min_responses,
    'threshold_met', v_met,
    'audience', (select count(*) from private.audience_membership_ids(v_survey.org_id, v_survey.audience_kind, v_survey.project_id,
      v_survey.team_id, v_survey.role_id, v_survey.group_id)),
    'questions', case when not v_met then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'question_id', q.id, 'position', q.position, 'prompt', q.prompt, 'kind', q.question_kind, 'scale_max', q.scale_max,
        'answered', (select count(*) from app.survey_answers a where a.survey_question_id = q.id),
        'average', (select round(avg(a.scale_value), 2) from app.survey_answers a where a.survey_question_id = q.id),
        'counts', case
          when q.question_kind = 'Choice' then (select coalesce(jsonb_object_agg(c.choice, (select count(*) from app.survey_answers a
              where a.survey_question_id = q.id and a.choice = c.choice)), '{}'::jsonb) from unnest(q.choices) as c (choice))
          when q.question_kind = 'Scale' then (select coalesce(jsonb_object_agg(g.v::text, (select count(*) from app.survey_answers a
              where a.survey_question_id = q.id and a.scale_value = g.v)), '{}'::jsonb) from generate_series(1, q.scale_max) as g (v))
        end,
        'texts', case when q.question_kind = 'Text' then (select coalesce(jsonb_agg(a.text_value order by a.text_value), '[]'::jsonb)
          from app.survey_answers a where a.survey_question_id = q.id) end
      ) order by q.position)
      from app.survey_questions q where q.survey_id = p_survey_id and q.deleted_at is null), '[]'::jsonb) end
  );
end;
$$;
comment on function app.survey_results(uuid) is 'Survey results for its author and survey managers: response and audience counts, and per question the average, counts and texts, only once the minimum number of responses is met. Text answers are sorted, not in arrival order.';
revoke all on function app.survey_results(uuid) from public, anon;
grant execute on function app.survey_results(uuid) to authenticated, service_role;

call private.install_default_retention('app.feed_posts');
call private.install_default_retention('app.feed_acknowledgments');
call private.install_default_retention('app.feed_reactions');
call private.install_default_retention('app.polls');
call private.install_default_retention('app.poll_options');
call private.install_default_retention('app.poll_votes');
call private.install_default_retention('app.surveys');
call private.install_default_retention('app.survey_state_transitions');
call private.install_default_retention('app.survey_questions');
call private.install_default_retention('app.survey_participations');
call private.install_default_retention('app.survey_responses');
call private.install_default_retention('app.survey_answers');
