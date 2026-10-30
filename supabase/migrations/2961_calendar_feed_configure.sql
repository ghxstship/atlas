-- 2961_calendar_feed_configure.sql
-- B7 (RRR-231, ADR 0146 decisions 1 and 2; gap G-50). Feeds are named and filtered through RPCs only, and the
-- audience rule that feeds and day sheets share lives here, in SQL alone.
--
--   * private.schedule_audience_memberships: the live memberships of an audience of people, one team or one canon
--     department. Team and department come from private.audience_membership_ids (1365), so the rules are not restated.
--   * private.schedule_audience_shift and private.schedule_audience_record: whether a shift or a record belongs to
--     that audience. A shift does when its membership is in the set, or, for a department, when its role is in the
--     department (left(role_code, 4), the rule of 1365), open shifts included. A record does when it is assigned to,
--     owned by or accountable to a person of the set. The three helpers read any org and record, so only definer
--     functions (and service_role) call them, as private.audience_membership_ids.
--   * private.apply_calendar_feed_configuration and private.apply_person_calendar_feed_configuration hold the shared
--     write logic and every refusal: calendar_feed_name, calendar_feed_filter_scope, calendar_feed_audience,
--     calendar_feed_people_limit and calendar_feed_sources. A null source list is the default set; an empty one is
--     refused.
--   * app.create_calendar_feed (from 1410, verbatim) and app.create_person_calendar_feed (from 1410, verbatim) take
--     the configuration in the same transaction. Their defaults keep the 4.0 two-argument call, the frozen REST
--     create and the a84 REST create working unchanged.
--   * app.configure_calendar_feed and app.configure_person_calendar_feed change a live feed of the caller's own.

-- 1. The audience rule ------------------------------------------------------------------------------------------------------

create or replace function private.schedule_audience_memberships(
  p_org_id uuid, p_person_ids uuid[], p_team_id uuid, p_department_code text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from app.memberships m
  where cardinality(coalesce(p_person_ids, '{}')) > 0 and p_team_id is null and p_department_code is null
    and m.org_id = p_org_id and m.person_id = any (p_person_ids)
    and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  union
  select x from private.audience_membership_ids(p_org_id, 'Team', null, p_team_id, null, null, null) x
  where cardinality(coalesce(p_person_ids, '{}')) = 0 and p_team_id is not null and p_department_code is null
    and exists (select 1 from app.teams t where t.id = p_team_id and t.org_id = p_org_id and t.deleted_at is null)
  union
  select x from private.audience_membership_ids(p_org_id, 'Department', null, null, null, null, p_department_code) x
  where cardinality(coalesce(p_person_ids, '{}')) = 0 and p_team_id is null and p_department_code is not null;
$$;
comment on function private.schedule_audience_memberships(uuid, uuid[], uuid, text) is 'Live memberships of an org in a schedule audience (ADR 0146 decision 2): those of the named people, of the active members of a live team of the org, or of a canon department (private.audience_membership_ids, 1365). Exactly one of the three may be given; with none, or more than one, it returns nothing. Shared by calendar feeds and day sheets.';

create or replace function private.schedule_audience_shift(
  p_membership_id uuid, p_role_code text, p_memberships uuid[], p_department_code text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_membership_id = any (p_memberships), false)
    or (p_department_code is not null and left(p_role_code, 4) = p_department_code);
$$;
comment on function private.schedule_audience_shift(uuid, text, uuid[], text) is 'Whether a shift belongs to a schedule audience: its membership is in the audience''s set, or, for a department audience, its role is in the department (left(role_code, 4), the rule of 1365), open shifts included.';

create or replace function private.schedule_audience_record(p_record_id uuid, p_memberships uuid[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.record_assignments ra
                 where ra.record_id = p_record_id and ra.deleted_at is null and ra.membership_id = any (p_memberships))
    or exists (select 1 from app.records r join app.memberships m on m.id = any (p_memberships)
               where r.id = p_record_id and m.person_id in (r.owner_party_id, r.accountable_party_id));
$$;
comment on function private.schedule_audience_record(uuid, uuid[]) is 'Whether a record belongs to a schedule audience: a live assignment names one of its memberships, or its owner or accountable party is the person of one of them.';

-- 2. Shared write logic --------------------------------------------------------------------------------------------------

create or replace function private.calendar_feed_name_value(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text := btrim(p_name);
begin
  if p_name is null then
    return null;
  end if;
  if v_name = '' or char_length(v_name) > 80 or v_name ~ '[[:cntrl:]]' then
    perform private.refuse('calendar_feed_name', 'Give the feed a name of 1 to 80 characters.');
  end if;
  return v_name;
end;
$$;
comment on function private.calendar_feed_name_value(text) is 'A calendar feed name as stored: trimmed, 1 to 80 characters without control characters, or null for the default name. Refuses calendar_feed_name otherwise.';

create or replace function private.calendar_feed_sources_value(p_sources app.calendar_feed_source[])
returns app.calendar_feed_source[]
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_sources is not null and not (cardinality(p_sources) > 0 and private.calendar_feed_sources_valid(p_sources)) then
    perform private.refuse('calendar_feed_sources', 'Choose at least one thing for the feed to show, each once.');
  end if;
  return p_sources;
end;
$$;
comment on function private.calendar_feed_sources_value(app.calendar_feed_source[]) is 'A calendar feed''s sources as stored: null for the default set, or 1 to 5 distinct sources. Refuses calendar_feed_sources for an empty or repeated list.';

create or replace function private.apply_calendar_feed_configuration(
  p_feed_id uuid,
  p_name text,
  p_sources app.calendar_feed_source[],
  p_person_ids uuid[],
  p_team_id uuid,
  p_department_code text,
  p_cue_call_kind app.cue_call_kind)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_feed app.calendar_feeds;
  v_name text := private.calendar_feed_name_value(p_name);
  v_sources app.calendar_feed_source[] := private.calendar_feed_sources_value(p_sources);
  v_people uuid[] := (select array_agg(distinct x) from unnest(coalesce(p_person_ids, '{}')) x where x is not null);
  v_members uuid[];
begin
  select * into v_feed from app.calendar_feeds f where f.id = p_feed_id;

  if v_name is not null and exists (
    select 1 from app.calendar_feeds f
    where f.membership_id = v_feed.membership_id and f.id <> v_feed.id and lower(f.name) = lower(v_name)
      and f.deleted_at is null and f.revoked_at is null) then
    perform private.refuse('calendar_feed_name', 'You already have a feed with this name. Choose another name.');
  end if;

  if v_feed.project_id is null and ('Cues' = any (coalesce(v_sources, '{}')) or cardinality(coalesce(v_people, '{}')) > 0
     or p_team_id is not null or p_department_code is not null or p_cue_call_kind is not null) then
    perform private.refuse('calendar_feed_filter_scope', 'Cues, an audience and a show department are for project feeds only.');
  end if;

  if num_nonnulls(v_people, p_team_id, p_department_code) > 1 then
    perform private.refuse('calendar_feed_audience', 'Choose one audience: people, a team or a department.');
  end if;
  if cardinality(coalesce(v_people, '{}')) > 50 then
    perform private.refuse('calendar_feed_people_limit', 'A feed can follow at most 50 people.');
  end if;
  if p_team_id is not null and not exists (
    select 1 from app.teams t where t.id = p_team_id and t.org_id = v_feed.org_id and t.deleted_at is null) then
    perform private.refuse('calendar_feed_audience', 'That team is not in this organization.');
  end if;
  if p_department_code is not null and not exists (
    select 1 from xpms.dim_department d where d.dept_code = p_department_code) then
    perform private.refuse('calendar_feed_audience', 'That department does not exist.');
  end if;
  if v_people is not null then
    v_members := array(select private.schedule_audience_memberships(v_feed.org_id, v_people, null, null));
    if (select count(distinct m.person_id) from app.memberships m where m.id = any (v_members)) < cardinality(v_people) then
      perform private.refuse('calendar_feed_audience', 'Everyone in a feed''s audience must be a member of this organization.');
    end if;
  end if;

  update app.calendar_feeds
  set name = v_name, sources = v_sources, team_id = p_team_id, department_code = p_department_code, cue_call_kind = p_cue_call_kind
  where id = v_feed.id;

  update app.calendar_feed_members set deleted_at = now()
  where calendar_feed_id = v_feed.id and deleted_at is null and not (membership_id = any (coalesce(v_members, '{}')));
  insert into app.calendar_feed_members (calendar_feed_id, membership_id)
  select v_feed.id, m from unnest(coalesce(v_members, '{}')) m
  where not exists (select 1 from app.calendar_feed_members x
                    where x.calendar_feed_id = v_feed.id and x.membership_id = m and x.deleted_at is null);
end;
$$;
comment on function private.apply_calendar_feed_configuration(uuid, text, app.calendar_feed_source[], uuid[], uuid, text, app.cue_call_kind) is 'Sets a member or project feed''s name, sources, audience and show department and replaces its people audience (old rows soft-deleted). Called only by app.create_calendar_feed and app.configure_calendar_feed after they authorized the caller. Refuses calendar_feed_name, calendar_feed_filter_scope, calendar_feed_audience, calendar_feed_people_limit and calendar_feed_sources.';

create or replace function private.apply_person_calendar_feed_configuration(
  p_feed_id uuid, p_name text, p_sources app.calendar_feed_source[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_feed app.person_calendar_feeds;
  v_name text := private.calendar_feed_name_value(p_name);
  v_sources app.calendar_feed_source[] := private.calendar_feed_sources_value(p_sources);
begin
  select * into v_feed from app.person_calendar_feeds f where f.id = p_feed_id;
  if v_name is not null and exists (
    select 1 from app.person_calendar_feeds f
    where f.person_id = v_feed.person_id and f.id <> v_feed.id and lower(f.name) = lower(v_name)
      and f.deleted_at is null and f.revoked_at is null) then
    perform private.refuse('calendar_feed_name', 'You already have a feed with this name. Choose another name.');
  end if;
  update app.person_calendar_feeds set name = v_name, sources = v_sources where id = v_feed.id;
end;
$$;
comment on function private.apply_person_calendar_feed_configuration(uuid, text, app.calendar_feed_source[]) is 'Sets a person''s own feed''s name and sources. Called only by app.create_person_calendar_feed and app.configure_person_calendar_feed. Refuses calendar_feed_name and calendar_feed_sources.';

-- 3. Create with a configuration (from 1410) -------------------------------------------------------------------------------

drop function app.create_calendar_feed(uuid, uuid);

create or replace function app.create_calendar_feed(
  p_org_id uuid,
  p_project_id uuid default null,
  p_name text default null,
  p_sources app.calendar_feed_source[] default null,
  p_person_ids uuid[] default null,
  p_team_id uuid default null,
  p_department_code text default null,
  p_cue_call_kind app.cue_call_kind default null)
returns table (calendar_feed_id uuid, feed_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
  v_token text := private.new_calendar_feed_token();
  v_id uuid;
begin
  select m.id into v_membership from app.memberships m
  where m.id in (select private.my_membership_ids()) and m.org_id = p_org_id limit 1;
  if v_membership is null or not private.has_capability(p_org_id, 'me.calendar_feeds.write', private.current_person_id()) then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if p_project_id is not null and p_project_id not in (select private.readable_project_ids()) then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  if (select count(*) from app.calendar_feeds f where f.membership_id = v_membership and f.revoked_at is null and f.deleted_at is null) >= 20 then
    perform private.refuse('calendar_feed_limit', 'You have 20 calendar feeds in this organization. Revoke one before you add another.');
  end if;
  insert into app.calendar_feeds (membership_id, project_id, token_hash, token_hint)
  values (v_membership, p_project_id, extensions.digest(v_token, 'sha256'), right(v_token, 4))
  returning id into v_id;
  perform private.apply_calendar_feed_configuration(v_id, p_name, p_sources, p_person_ids, p_team_id, p_department_code, p_cue_call_kind);
  return query select v_id, v_token;
end;
$$;
comment on function app.create_calendar_feed(uuid, uuid, text, app.calendar_feed_source[], uuid[], uuid, text, app.cue_call_kind) is 'Creates a calendar feed for the signed-in member, of their own schedule or of a project they can read, with an optional name, sources, audience and show department (ADR 0146), and returns its token once. At most 20 live feeds per membership. Called with two arguments it creates a 4.0 feed.';

drop function app.create_person_calendar_feed();

create or replace function app.create_person_calendar_feed(
  p_name text default null, p_sources app.calendar_feed_source[] default null)
returns table (calendar_feed_id uuid, feed_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_token text := private.new_calendar_feed_token();
  v_id uuid;
begin
  if (select count(*) from app.person_calendar_feeds f where f.person_id = v_person and f.revoked_at is null and f.deleted_at is null) >= 20 then
    perform private.refuse('calendar_feed_limit', 'You have 20 calendar feeds. Revoke one before you add another.');
  end if;
  insert into app.person_calendar_feeds (person_id, token_hash, token_hint)
  values (v_person, extensions.digest(v_token, 'sha256'), right(v_token, 4))
  returning id into v_id;
  perform private.apply_person_calendar_feed_configuration(v_id, p_name, p_sources);
  return query select v_id, v_token;
end;
$$;
comment on function app.create_person_calendar_feed(text, app.calendar_feed_source[]) is 'Creates the signed-in person''s own calendar feed across their engagements, with an optional name and sources (ADR 0146), and returns its token once. At most 20 live feeds per person.';

-- 4. Configure a live feed -------------------------------------------------------------------------------------------------

create or replace function app.configure_calendar_feed(
  p_calendar_feed_id uuid,
  p_name text default null,
  p_sources app.calendar_feed_source[] default null,
  p_person_ids uuid[] default null,
  p_team_id uuid default null,
  p_department_code text default null,
  p_cue_call_kind app.cue_call_kind default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_feed app.calendar_feeds;
begin
  select * into v_feed from app.calendar_feeds f
  where f.id = p_calendar_feed_id and f.membership_id in (select private.my_membership_ids())
    and f.revoked_at is null and f.deleted_at is null
  for update;
  if v_feed.id is null or not private.has_capability(v_feed.org_id, 'me.calendar_feeds.write', private.current_person_id()) then
    raise exception using errcode = '42501', message = 'calendar feed not found';
  end if;
  perform private.apply_calendar_feed_configuration(v_feed.id, p_name, p_sources, p_person_ids, p_team_id, p_department_code, p_cue_call_kind);
end;
$$;
comment on function app.configure_calendar_feed(uuid, text, app.calendar_feed_source[], uuid[], uuid, text, app.cue_call_kind) is 'Replaces the name, sources, audience and show department of one of the signed-in member''s live calendar feeds (ADR 0146). The token and the subscription URL stay. Another member''s or a revoked feed is not found.';

create or replace function app.configure_person_calendar_feed(
  p_calendar_feed_id uuid, p_name text default null, p_sources app.calendar_feed_source[] default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_feed app.person_calendar_feeds;
begin
  select * into v_feed from app.person_calendar_feeds f
  where f.id = p_calendar_feed_id and f.person_id = private.current_person_id()
    and f.revoked_at is null and f.deleted_at is null
  for update;
  if v_feed.id is null then
    raise exception using errcode = '42501', message = 'calendar feed not found';
  end if;
  perform private.apply_person_calendar_feed_configuration(v_feed.id, p_name, p_sources);
end;
$$;
comment on function app.configure_person_calendar_feed(uuid, text, app.calendar_feed_source[]) is 'Replaces the name and sources of one of the signed-in person''s own live calendar feeds (ADR 0146). The token and the subscription URL stay.';

-- 5. Privileges ------------------------------------------------------------------------------------------------------------

revoke all on function private.schedule_audience_memberships(uuid, uuid[], uuid, text) from public, anon, authenticated;
grant execute on function private.schedule_audience_memberships(uuid, uuid[], uuid, text) to service_role;
revoke all on function private.schedule_audience_shift(uuid, text, uuid[], text) from public, anon, authenticated;
grant execute on function private.schedule_audience_shift(uuid, text, uuid[], text) to service_role;
revoke all on function private.schedule_audience_record(uuid, uuid[]) from public, anon, authenticated;
grant execute on function private.schedule_audience_record(uuid, uuid[]) to service_role;
revoke all on function private.calendar_feed_name_value(text) from public, anon, authenticated;
revoke all on function private.calendar_feed_sources_value(app.calendar_feed_source[]) from public, anon, authenticated;
revoke all on function private.apply_calendar_feed_configuration(uuid, text, app.calendar_feed_source[], uuid[], uuid, text, app.cue_call_kind) from public, anon, authenticated;
revoke all on function private.apply_person_calendar_feed_configuration(uuid, text, app.calendar_feed_source[]) from public, anon, authenticated;

revoke all on function app.create_calendar_feed(uuid, uuid, text, app.calendar_feed_source[], uuid[], uuid, text, app.cue_call_kind) from public, anon;
grant execute on function app.create_calendar_feed(uuid, uuid, text, app.calendar_feed_source[], uuid[], uuid, text, app.cue_call_kind) to authenticated, service_role;
revoke all on function app.create_person_calendar_feed(text, app.calendar_feed_source[]) from public, anon;
grant execute on function app.create_person_calendar_feed(text, app.calendar_feed_source[]) to authenticated, service_role;
revoke all on function app.configure_calendar_feed(uuid, text, app.calendar_feed_source[], uuid[], uuid, text, app.cue_call_kind) from public, anon;
grant execute on function app.configure_calendar_feed(uuid, text, app.calendar_feed_source[], uuid[], uuid, text, app.cue_call_kind) to authenticated, service_role;
revoke all on function app.configure_person_calendar_feed(uuid, text, app.calendar_feed_source[]) from public, anon;
grant execute on function app.configure_person_calendar_feed(uuid, text, app.calendar_feed_source[]) to authenticated, service_role;
