-- 2960_calendar_feed_filters.sql
-- B7 Day sheets, books, calendar feeds and wrap-up report (RRR-231, ADR 0146 decision 1; gap G-50). A member keeps
-- several named feeds, each with saved content sources (cues included) and, on a project feed, an audience of
-- people, one team or one canon department and a show department.
--
--   * app.calendar_feed_source names what a feed serves. A feed's sources are a set of these fixed enum values
--     (app.calendar_feeds.sources, app.person_calendar_feeds.sources), never joined on; NULL is the 4.0 set (Shifts,
--     Meetings, Milestones, Deadlines), so every existing feed serves exactly what it served before and Cues appear
--     only when chosen. Both columns are reviewed array exceptions in docs/adr/denormalization-register.yaml:
--     app.person_calendar_feeds has no org_id (install_person_table, 1410), so it cannot carry a tenant child table.
--   * app.calendar_feeds gains name, team_id, department_code and cue_call_kind; app.person_calendar_feeds gains
--     name. Names are 1 to 80 characters, trimmed, without control characters, and unique per owner among live feeds.
--     Only the RPCs of 2961 write them: no update grant is added.
--   * app.calendar_feed_members holds a people audience as memberships of the feed's org (never app.people, which
--     has no org_id for the cross-org guard to read). Read by the feed's owner only; written only by 2961.
--   * Trash (ADR 0110): the name makes both feed tables eligible. A revoked feed never comes back (ADR 0040 item 2),
--     like personal_access_tokens, so both are listed in private.trash_excluded_tables. app.person_calendar_feeds has
--     no org_id and so can never be a Trash candidate (2390, trash_table_candidates); it is listed only as a guard.
--   * Every new column is Internal, so nothing joins private.column_classifications.

-- 1. Sources ------------------------------------------------------------------------------------------------------------

create type app.calendar_feed_source as enum ('Shifts', 'Meetings', 'Milestones', 'Deadlines', 'Cues');
comment on type app.calendar_feed_source is 'What a calendar feed serves (ADR 0146 decision 1): shifts, meetings, milestones, deadlines, and cues of a run of show. A feed without saved sources serves the first four.';

create or replace function private.calendar_feed_sources_valid(p_sources app.calendar_feed_source[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_sources is null or (
    cardinality(p_sources) between 1 and 5
    and array_position(p_sources, null) is null
    and cardinality(p_sources) = (select count(distinct s) from unnest(p_sources) s));
$$;
comment on function private.calendar_feed_sources_valid(app.calendar_feed_source[]) is 'True for a calendar feed''s saved sources: null (the default set), or 1 to 5 values without nulls or duplicates. Used by the checks on both feed tables, which run as whoever writes a row (a member revoking a feed), so members may execute it.';
revoke all on function private.calendar_feed_sources_valid(app.calendar_feed_source[]) from public, anon;
grant execute on function private.calendar_feed_sources_valid(app.calendar_feed_source[]) to authenticated, service_role;

create or replace function private.calendar_feed_effective_sources(p_sources app.calendar_feed_source[])
returns app.calendar_feed_source[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_sources, array['Shifts', 'Meetings', 'Milestones', 'Deadlines']::app.calendar_feed_source[]);
$$;
comment on function private.calendar_feed_effective_sources(app.calendar_feed_source[]) is 'The sources a feed serves: its saved set, or the 4.0 set (Shifts, Meetings, Milestones, Deadlines) when none is saved.';
revoke all on function private.calendar_feed_effective_sources(app.calendar_feed_source[]) from public, anon, authenticated;

-- 2. Member and project feeds -------------------------------------------------------------------------------------------

alter table app.calendar_feeds
  add column name text,
  add column sources app.calendar_feed_source[],
  add column team_id uuid references app.teams (id),
  add column department_code text references xpms.dim_department (dept_code),
  add column cue_call_kind app.cue_call_kind,
  add constraint calendar_feeds_name_format check (
    name is null or (char_length(name) between 1 and 80 and name = btrim(name) and name !~ '[[:cntrl:]]')),
  add constraint calendar_feeds_sources_valid check (private.calendar_feed_sources_valid(sources)),
  add constraint calendar_feeds_cues_need_project check (
    project_id is not null or not ('Cues' = any (coalesce(sources, '{}')))),
  add constraint calendar_feeds_one_audience check (num_nonnulls(team_id, department_code) <= 1),
  add constraint calendar_feeds_member_unfiltered check (
    project_id is not null or (team_id is null and department_code is null and cue_call_kind is null));

create index calendar_feeds_team_id_idx on app.calendar_feeds (team_id);
create index calendar_feeds_department_code_idx on app.calendar_feeds (department_code);
create unique index calendar_feeds_name_key on app.calendar_feeds (membership_id, lower(name))
  where name is not null and deleted_at is null and revoked_at is null;

comment on column app.calendar_feeds.name is 'Name the member gave the feed; it names the subscribed calendar. Null uses the default name. Unique per member among live feeds.';
comment on column app.calendar_feeds.sources is 'What the feed serves. Null is the default set: shifts, meetings, milestones and deadlines. Cues only on a project feed.';
comment on column app.calendar_feeds.team_id is 'Project feed audience: only this team''s members'' shifts and records. At most one of team, department and people.';
comment on column app.calendar_feeds.department_code is 'Project feed audience: only this canon department''s members'' shifts and records, and shifts whose role is in it.';
comment on column app.calendar_feeds.cue_call_kind is 'Show department filter of a project feed: only cues that have a call of this department, with its instruction.';

-- The new team reference gets the cross-org guard, keeping the project's.
call private.install_tenant_guards('app.calendar_feeds', 'app.memberships', 'membership_id',
  array['app.projects', 'project_id', 'app.teams', 'team_id']);

-- 1410's list plus the new columns. Only the RPCs of 2961 write them.
revoke select on app.calendar_feeds from authenticated;
grant select (id, org_id, membership_id, project_id, token_hint, last_accessed_at, rotated_at, revoked_at, created_at, created_by,
  updated_at, updated_by, deleted_at, name, sources, team_id, department_code, cue_call_kind) on app.calendar_feeds to authenticated;

-- 3. Personal feeds -------------------------------------------------------------------------------------------------------

alter table app.person_calendar_feeds
  add column name text,
  add column sources app.calendar_feed_source[],
  add constraint person_calendar_feeds_name_format check (
    name is null or (char_length(name) between 1 and 80 and name = btrim(name) and name !~ '[[:cntrl:]]')),
  add constraint person_calendar_feeds_sources_valid check (private.calendar_feed_sources_valid(sources));

create unique index person_calendar_feeds_name_key on app.person_calendar_feeds (person_id, lower(name))
  where name is not null and deleted_at is null and revoked_at is null;

comment on column app.person_calendar_feeds.name is 'Name the person gave the feed; it names the subscribed calendar. Null uses the default name. Unique per person among live feeds.';
comment on column app.person_calendar_feeds.sources is 'What the feed serves. Null is the default set: shifts, meetings, milestones and deadlines.';

revoke select on app.person_calendar_feeds from authenticated;
grant select (id, person_id, token_hint, last_accessed_at, rotated_at, revoked_at, created_at, created_by, updated_at, updated_by,
  deleted_at, name, sources) on app.person_calendar_feeds to authenticated;

-- 4. A people audience ---------------------------------------------------------------------------------------------------

create table app.calendar_feed_members (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  calendar_feed_id uuid not null references app.calendar_feeds (id),
  membership_id uuid not null references app.memberships (id),
  deleted_at timestamptz
);

create unique index calendar_feed_members_key on app.calendar_feed_members (calendar_feed_id, membership_id) where deleted_at is null;
create index calendar_feed_members_membership_id_idx on app.calendar_feed_members (membership_id);

call private.install_domain_table('app.calendar_feed_members', 'app.calendar_feeds', 'calendar_feed_id', array['app.memberships', 'membership_id']);
call private.describe('app.calendar_feed_members', 'The people audience of a project calendar feed (ADR 0146 decision 1): the feed serves only these members'' shifts and the records assigned to, owned by or accountable to them, never more than its owner may see. Written only by the feed RPCs.', array[
  'calendar_feed_id', 'Feed whose audience this member is in.',
  'membership_id', 'Membership of the feed''s org in the audience.'
]);
call private.install_policies('app.calendar_feed_members',
  $$calendar_feed_id in (select f.id from app.calendar_feeds f where f.membership_id in (select private.my_membership_ids()))$$);
revoke insert, update, delete on app.calendar_feed_members from authenticated;
call private.install_audit_trail('app.calendar_feed_members');
call private.install_default_retention('app.calendar_feed_members', interval '90 days');

-- 5. Trash ----------------------------------------------------------------------------------------------------------------

insert into private.trash_excluded_tables (table_name, rationale) values
  ('calendar_feeds', 'A revoked feed never comes back (ADR 0040 item 2), like personal_access_tokens.'),
  ('person_calendar_feeds', 'A revoked feed never comes back (ADR 0040 item 2), like personal_access_tokens. Listed as a guard: without org_id it is never a Trash candidate.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();
