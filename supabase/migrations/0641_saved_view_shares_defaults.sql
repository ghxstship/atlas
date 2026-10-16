-- 0641_saved_view_shares_defaults.sql
-- A31 saved views (Section 11.15, Section 7.3 "saved_views, saved_view_shares"): A18's saved views
-- (0540) are saved per person and shared with the whole org. This migration adds
--   * saved_view_shares: a view shared with one or more teams instead of the whole org;
--   * saved_view_defaults: the view a person opens by default on a page (one per collection);
--   * the read rule of saved views, their filters and their sorts extended to team shares.
-- A shared view carries only its query (view type, filters, sorts, grouping, search). The rows it
-- shows are read with each viewer's own client, so a shared view respects every viewer's permissions.

-- private.my_team_ids() (A18, 0550) gives the teams the signed-in person belongs to.

-- Team shares ----------------------------------------------------------------------------------------------

create table app.saved_view_shares (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  saved_view_id uuid not null references app.saved_views (id),
  team_id uuid not null references app.teams (id)
);

create index saved_view_shares_view_idx on app.saved_view_shares (saved_view_id);
create index saved_view_shares_team_idx on app.saved_view_shares (team_id);

call private.install_domain_table('app.saved_view_shares', 'app.saved_views', 'saved_view_id', array['app.teams', 'team_id']);
create unique index saved_view_shares_view_team_key on app.saved_view_shares (saved_view_id, team_id) where deleted_at is null;
call private.describe('app.saved_view_shares', 'A saved view shared with one team of its org (Section 11.15). Members of the team can open the view; each sees only the rows their own access allows.', array[
  'saved_view_id', 'View shared.',
  'team_id', 'Team the view is shared with.'
]);

-- The owner shares and unshares (soft delete); the owner and the team's members read the share.
call private.install_policies('app.saved_view_shares',
  $$team_id in (select private.my_team_ids()) or saved_view_id in (select private.my_saved_view_ids())$$,
  $$saved_view_id in (select private.my_saved_view_ids())$$);

-- Whether a saved view is shared with one of the signed-in person's teams. Takes the view id as an
-- argument and reads only the shares table, so it never re-reads app.saved_views (ADR 0016 item 14).
create or replace function private.is_team_shared_view(p_saved_view_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.saved_view_shares s
    where s.saved_view_id = p_saved_view_id and s.deleted_at is null
      and s.team_id in (select private.my_team_ids())
  );
$$;

comment on function private.is_team_shared_view(uuid) is 'True when the saved view is shared with a team the signed-in person belongs to.';
revoke all on function private.is_team_shared_view(uuid) from public, anon;
grant execute on function private.is_team_shared_view(uuid) to authenticated, service_role;

-- Saved views, their filters and their sorts: readable by the owner, by the org when shared, and by
-- the teams the view is shared with.
call private.install_policies('app.saved_views',
  $$membership_id in (select private.my_membership_ids()) or (shared and org_id in (select private.my_org_ids())) or private.is_team_shared_view(id)$$,
  $$membership_id in (select private.my_membership_ids())$$);

create or replace function private.readable_saved_view_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select v.id from app.saved_views v
  where v.deleted_at is null
    and (v.membership_id in (select private.my_membership_ids())
      or (v.shared and v.org_id in (select private.my_org_ids()))
      or exists (
        select 1 from app.saved_view_shares s
        where s.saved_view_id = v.id and s.deleted_at is null and s.team_id in (select private.my_team_ids())
      ));
$$;

comment on function private.readable_saved_view_ids() is 'Saved views the signed-in person owns, that are shared in their orgs, or that are shared with one of their teams.';

-- A share names a team of the view's own org (the cross-org guard checks it) that still exists.
create or replace function private.guard_saved_view_share()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.saved_view_id <> old.saved_view_id or new.team_id <> old.team_id) then
    perform private.refuse('saved_view_share_immutable', 'A share keeps its view and team; remove it and share again.');
  end if;
  if new.deleted_at is null and not exists (select 1 from app.teams t where t.id = new.team_id and t.deleted_at is null) then
    perform private.refuse('saved_view_share_team_removed', 'A view can be shared only with a team that exists.');
  end if;
  return new;
end;
$$;

comment on function private.guard_saved_view_share() is 'Saved view shares: the view and team never change, and the team must exist.';
revoke all on function private.guard_saved_view_share() from public, anon, authenticated;
create trigger t41_guard_saved_view_share before insert or update on app.saved_view_shares
  for each row execute function private.guard_saved_view_share();

-- Defaults per page ------------------------------------------------------------------------------------------

create table app.saved_view_defaults (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  collection_key text not null,
  saved_view_id uuid not null references app.saved_views (id),
  constraint saved_view_defaults_collection_format check (collection_key ~ '^[a-z][a-z0-9_]*(/[a-z][a-z0-9_]*)?$')
);

create index saved_view_defaults_membership_idx on app.saved_view_defaults (membership_id);
create index saved_view_defaults_view_idx on app.saved_view_defaults (saved_view_id);

call private.install_domain_table('app.saved_view_defaults', 'app.memberships', 'membership_id', array['app.saved_views', 'saved_view_id']);
create unique index saved_view_defaults_one_per_page on app.saved_view_defaults (membership_id, collection_key) where deleted_at is null;
call private.describe('app.saved_view_defaults', 'The saved view a person opens by default on a page (Section 11.15): one per person and collection. A default whose view the person can no longer read is ignored.', array[
  'membership_id', 'Member whose default it is.',
  'collection_key', 'Collection (page) the default applies to; the same key as the view''s.',
  'saved_view_id', 'View opened by default.'
]);

call private.install_policies('app.saved_view_defaults',
  $$membership_id in (select private.my_membership_ids())$$,
  $$membership_id in (select private.my_membership_ids())$$);

create or replace function private.guard_saved_view_default()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection text;
begin
  if new.deleted_at is not null then
    return new;
  end if;
  if new.saved_view_id not in (select private.readable_saved_view_ids()) then
    perform private.refuse('saved_view_default_unreadable', 'A default must be a view you own or one shared with you.');
  end if;
  select v.collection_key into v_collection from app.saved_views v where v.id = new.saved_view_id;
  if v_collection is distinct from new.collection_key then
    perform private.refuse('saved_view_default_collection', 'A default view must belong to the page it is the default for.');
  end if;
  return new;
end;
$$;

comment on function private.guard_saved_view_default() is 'Saved view defaults: the view is one the person can read and belongs to the same collection.';
revoke all on function private.guard_saved_view_default() from public, anon, authenticated;
create trigger t41_guard_saved_view_default before insert or update on app.saved_view_defaults
  for each row execute function private.guard_saved_view_default();

-- Choosing a default replaces the earlier one for the page in one statement.
create or replace function app.set_saved_view_default(p_saved_view_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_view app.saved_views;
  v_membership uuid;
  v_id uuid;
begin
  select * into v_view from app.saved_views v
  where v.id = p_saved_view_id and v.id in (select private.readable_saved_view_ids());
  if v_view.id is null then
    raise exception using errcode = '42501', message = 'the saved view does not exist or is not visible';
  end if;
  select m.id into v_membership from app.memberships m
  where m.id in (select private.my_membership_ids()) and m.org_id = v_view.org_id;
  if v_membership is null then
    raise exception using errcode = '42501', message = 'only a member of the view''s org can make it a default';
  end if;
  update app.saved_view_defaults d set deleted_at = now()
  where d.membership_id = v_membership and d.collection_key = v_view.collection_key and d.deleted_at is null;
  insert into app.saved_view_defaults (membership_id, collection_key, saved_view_id)
  values (v_membership, v_view.collection_key, v_view.id)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.set_saved_view_default(uuid) is 'Makes a saved view the signed-in person''s default for its page, replacing any earlier default. Only a view the person can read, in an org they belong to; the default guard checks the page. Returns the default''s id.';
revoke all on function app.set_saved_view_default(uuid) from public, anon;
grant execute on function app.set_saved_view_default(uuid) to authenticated, service_role;

call private.install_default_retention('app.saved_view_shares');
call private.install_default_retention('app.saved_view_defaults');
