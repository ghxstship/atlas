-- 1365_department_feed_audience.sql
-- A80 (RRR-125), finding A65-021, Section 4.9 Feed: a feed post can reach one canon department.
--   * Who is in a department: an active member who holds an Active role assignment in a canon workforce role of
--     the department (xpms.dim_role.dept_code, through app.role_assignments), or who belongs to an active
--     Department group tagged with the department (app.groups.department_code, 1364)
--   * private.in_audience, private.audience_membership_ids and private.assert_audience gain the department code
--     (seven arguments). The six-argument forms stay for surveys and events and refuse a Department audience,
--     which only feed posts take
--   * the feed functions of 0801 pass the post's department: the read policy, publishing and its notifications,
--     acknowledgments and their tracking, poll votes, and app.create_feed_post (p_department_code)

alter table app.feed_posts drop constraint feed_posts_audience;
alter table app.feed_posts add constraint feed_posts_audience check (
  (audience_kind = 'Team') = (team_id is not null) and (audience_kind = 'Role') = (role_id is not null)
  and (audience_kind = 'Group') = (group_id is not null) and (audience_kind = 'Department') = (department_code is not null)
  and (audience_kind <> 'Project' or project_id is not null));

alter table app.surveys add constraint surveys_no_department_audience check (audience_kind <> 'Department');
alter table app.workforce_events add constraint workforce_events_no_department_audience check (audience_kind <> 'Department');

-- Department membership -------------------------------------------------------------------------------------------------

create or replace function private.department_membership_ids(p_org_id uuid, p_department_code text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from app.memberships m
  where m.org_id = p_org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    and (exists (select 1 from app.role_assignments ra
                 where ra.org_id = p_org_id and ra.person_id = m.person_id and ra.deleted_at is null
                   and ra.assignment_state = 'Active' and left(ra.role_code, 4) = p_department_code)
      or exists (select 1 from app.group_members gm join app.groups g on g.id = gm.group_id
                 where gm.membership_id = m.id and gm.deleted_at is null and g.org_id = p_org_id and g.deleted_at is null
                   and g.archived_at is null and g.department_code = p_department_code));
$$;
comment on function private.department_membership_ids(uuid, text) is 'Active memberships of an org in a canon department: holders of an Active role assignment in one of the department''s workforce roles, and members of an active Department group tagged with it.';

-- Audiences with a department ------------------------------------------------------------------------------------------

create or replace function private.in_audience(
  p_org_id uuid,
  p_kind app.audience_kind,
  p_project_id uuid,
  p_team_id uuid,
  p_role_id uuid,
  p_group_id uuid,
  p_department_code text
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
    when 'Department' then private.my_membership_in(p_org_id) in (select private.department_membership_ids(p_org_id, p_department_code))
    when 'Role' then exists (select 1 from app.membership_roles mr
      where mr.role_id = p_role_id and mr.deleted_at is null and mr.membership_id in (select private.my_membership_ids()))
    when 'Group' then p_group_id in (select private.my_group_ids())
    else false
  end;
$$;
comment on function private.in_audience(uuid, app.audience_kind, uuid, uuid, uuid, uuid, text) is 'Whether the signed-in person is in an audience: an active member of the org and, by kind, a reader of the project, a member of the team, in the canon department, a holder of the role or a member of the group.';

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
  select private.in_audience(p_org_id, p_kind, p_project_id, p_team_id, p_role_id, p_group_id, null::text);
$$;
comment on function private.in_audience(uuid, app.audience_kind, uuid, uuid, uuid, uuid) is 'The audience check of rows without a department audience (surveys, events): private.in_audience with no department.';

create or replace function private.audience_membership_ids(
  p_org_id uuid,
  p_kind app.audience_kind,
  p_project_id uuid,
  p_team_id uuid,
  p_role_id uuid,
  p_group_id uuid,
  p_department_code text
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
      when 'Department' then m.id in (select private.department_membership_ids(p_org_id, p_department_code))
      when 'Role' then exists (select 1 from app.membership_roles mr where mr.role_id = p_role_id and mr.membership_id = m.id and mr.deleted_at is null)
      when 'Group' then exists (select 1 from app.group_members gm where gm.group_id = p_group_id and gm.membership_id = m.id and gm.deleted_at is null)
      else false
    end;
$$;
comment on function private.audience_membership_ids(uuid, app.audience_kind, uuid, uuid, uuid, uuid, text) is 'Active memberships an audience reaches, for notifications and acknowledgment tracking. Project audiences count the project''s members; Department audiences the department''s (private.department_membership_ids).';

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
  select private.audience_membership_ids(p_org_id, p_kind, p_project_id, p_team_id, p_role_id, p_group_id, null::text);
$$;
comment on function private.audience_membership_ids(uuid, app.audience_kind, uuid, uuid, uuid, uuid) is 'The memberships of an audience without a department (surveys, events).';

create or replace function private.assert_audience(
  p_org_id uuid,
  p_kind app.audience_kind,
  p_project_id uuid,
  p_team_id uuid,
  p_role_id uuid,
  p_group_id uuid,
  p_department_code text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (p_kind = 'Team') <> (p_team_id is not null) or (p_kind = 'Role') <> (p_role_id is not null)
     or (p_kind = 'Group') <> (p_group_id is not null) or (p_kind = 'Department') <> (p_department_code is not null)
     or (p_kind = 'Project' and p_project_id is null) then
    perform private.refuse('audience_target', 'Choose the audience''s project, team, department, role or group, and only that one.');
  end if;
  if p_department_code is not null and not exists (select 1 from xpms.dim_department d where d.dept_code = p_department_code) then
    perform private.refuse('audience_target', 'The department is not a canon department.');
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
comment on function private.assert_audience(uuid, app.audience_kind, uuid, uuid, uuid, uuid, text) is 'Refuses an audience whose kind and target disagree, a department outside canon, or a team, role or group outside the org.';

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
  if p_kind = 'Department' then
    perform private.refuse('audience_target', 'Only feed posts reach a department; choose another audience.');
  end if;
  perform private.assert_audience(p_org_id, p_kind, p_project_id, p_team_id, p_role_id, p_group_id, null::text);
end;
$$;
comment on function private.assert_audience(uuid, app.audience_kind, uuid, uuid, uuid, uuid) is 'The audience check of surveys and events, which take no Department audience.';

-- Feed posts read with their department ---------------------------------------------------------------------------------

create or replace function private.can_read_feed_post(
  p_org_id uuid,
  p_author_membership_id uuid,
  p_publish_at timestamptz,
  p_hidden_at timestamptz,
  p_audience_kind app.audience_kind,
  p_project_id uuid,
  p_team_id uuid,
  p_role_id uuid,
  p_group_id uuid,
  p_department_code text
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
        and private.in_audience(p_org_id, p_audience_kind, p_project_id, p_team_id, p_role_id, p_group_id, p_department_code));
$$;
comment on function private.can_read_feed_post(uuid, uuid, timestamptz, timestamptz, app.audience_kind, uuid, uuid, uuid, uuid, text) is 'Whether the signed-in person reads a feed post: its author, a communication admin, or a member of its audience (department included, 1365) once it is published and not hidden.';

call private.install_policies('app.feed_posts',
  $$private.can_read_feed_post(org_id, author_membership_id, publish_at, hidden_at, audience_kind, project_id, team_id, role_id, group_id, department_code)$$);

drop function private.can_read_feed_post(uuid, uuid, timestamptz, timestamptz, app.audience_kind, uuid, uuid, uuid, uuid);

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
      p.project_id, p.team_id, p.role_id, p.group_id, p.department_code);
$$;
comment on function private.readable_feed_post_ids() is 'Feed posts the signed-in person reads.';

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
     or new.department_code is distinct from old.department_code
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
comment on function private.guard_feed_post() is 'Feed posts keep their author, kind, audience (department included), text and acknowledgment rule; a published post keeps its time; hiding is final.';

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
        v_post.team_id, v_post.role_id, v_post.group_id, v_post.department_code))
        and m.id is distinct from v_post.author_membership_id
    loop
      perform private.notify(v_post.org_id, v_person, 'announcement.posted', 'app.feed_posts', v_post.id, v_post.project_id,
        jsonb_build_object('title', coalesce(v_post.title, left(v_post.body, 80)), 'requires_acknowledgment', v_post.requires_acknowledgment));
    end loop;
  end if;
end;
$$;
comment on function private.notify_feed_post(uuid) is 'Publishes a due feed post once: stamps notified_at, emits feed_post.published and notifies the audience (a department included, 1365) of announcements, polls and posts that need acknowledgment.';

drop function app.create_feed_post(uuid, app.feed_post_kind, text, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, timestamptz, jsonb);

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
  p_reactions_enabled boolean default true,
  p_comments_enabled boolean default true,
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
    p_role_id, p_group_id, p_department_code, case when p_pinned then now() end, p_requires_acknowledgment, p_reactions_enabled,
    p_comments_enabled, coalesce(p_publish_at, now()))
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
comment on function app.create_feed_post(uuid, app.feed_post_kind, text, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, timestamptz, jsonb, text) is 'Posts to the feed as the signed-in member (knowledge.document.write; pinning or requiring acknowledgment also needs knowledge.sop.publish). A Department audience names a canon department code (p_department_code, 1365). A future publish time schedules the post. A Poll post takes p_poll {question, options[2..10], allows_multiple, closes_at}. Publishing notifies the audience of announcements, polls and posts that need acknowledgment. Returns the post id.';

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
       and private.in_audience(v_post.org_id, v_post.audience_kind, v_post.project_id, v_post.team_id, v_post.role_id,
         v_post.group_id, v_post.department_code)) then
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
      v_post.role_id, v_post.group_id, v_post.department_code))
    order by a.acknowledged_at nulls first, pe.full_name;
end;
$$;
comment on function app.feed_acknowledgment_status(uuid) is 'Each member of a post''s audience (a department included) with when they acknowledged it, outstanding first. For the author, communication admins and holders of knowledge.sop.publish.';

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
     or not private.in_audience(v_post.org_id, v_post.audience_kind, v_post.project_id, v_post.team_id, v_post.role_id,
       v_post.group_id, v_post.department_code) then
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

-- Privileges --------------------------------------------------------------------------------------------------------------

revoke all on function private.department_membership_ids(uuid, text) from public, anon;
grant execute on function private.department_membership_ids(uuid, text) to authenticated, service_role;
revoke all on function private.in_audience(uuid, app.audience_kind, uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function private.in_audience(uuid, app.audience_kind, uuid, uuid, uuid, uuid, text) to authenticated, service_role;
revoke all on function private.audience_membership_ids(uuid, app.audience_kind, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.audience_membership_ids(uuid, app.audience_kind, uuid, uuid, uuid, uuid, text) to service_role;
revoke all on function private.assert_audience(uuid, app.audience_kind, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.can_read_feed_post(uuid, uuid, timestamptz, timestamptz, app.audience_kind, uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function private.can_read_feed_post(uuid, uuid, timestamptz, timestamptz, app.audience_kind, uuid, uuid, uuid, uuid, text) to authenticated, service_role;
revoke all on function app.create_feed_post(uuid, app.feed_post_kind, text, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, timestamptz, jsonb, text) from public, anon;
grant execute on function app.create_feed_post(uuid, app.feed_post_kind, text, text, app.audience_kind, uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, timestamptz, jsonb, text) to authenticated, service_role;
