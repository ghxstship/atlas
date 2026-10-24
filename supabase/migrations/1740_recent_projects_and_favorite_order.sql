-- 1740_recent_projects_and_favorite_order.sql
-- A113 (RRR-158), finding A65-024, Section 4.5.2 ("Favorites ... reorderable by drag and keyboard"; "Projects (five
-- most recent plus All projects)") and Section 11.7 (drag and drop with a keyboard path).
--
--   * Projects join the subjects of app.recent_views (1440), so the sidebar can list the five projects a person
--     opened most recently under the pinned Projects entry. app.record_recent_view, restated from 1440 (its only
--     definition), accepts projects; it still reads the project with the caller's own row level security, so a
--     project they cannot open is never recorded.
--   * private.trim_recent_views, restated from 1440, keeps projects apart from everything else: the last 50 records,
--     incidents, documents, SOPs and articles stay the command menu's recents (Section 11.7), and opening projects
--     never pushes one of them out. A person keeps at most 50 recent projects per org besides.
--   * app.recent_projects lists them, newest first, read as the caller: a project they can no longer read, or one
--     that was deleted, drops out.
--   * app.reorder_favorites puts the caller's favorites in an org in the order given, in one UPDATE that runs with
--     the caller's rights, so the owner policies of app.favorites (0850) decide every row: ids of anyone else's
--     favorites are not visible and change nothing.

-- Recent projects -----------------------------------------------------------------------------------------------------

alter table app.recent_views drop constraint recent_views_subject_table;
alter table app.recent_views add constraint recent_views_subject_table
  check (subject_table in ('records', 'incidents', 'documents', 'sops', 'handbook_articles', 'projects'));

call private.describe('app.recent_views', 'What a person opened (Section 11.7: the last 50 records each person viewed appear before they type; Section 4.5.2: the five most recent projects under Projects): each record, incident, document, SOP, handbook article or project once, with when they last opened it. At most 50 projects and 50 of everything else per person and org; rows go after 90 days and when the person is deleted. Only the person reads or writes their own rows.', array[
  'subject_table', 'Table of what was opened: records, incidents, documents, sops, handbook_articles or projects.'
]);

create or replace function private.trim_recent_views()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Projects and everything else are kept apart, so opening projects never pushes a record out of the 50.
  delete from app.recent_views v
  where v.id in (
    select r.id from app.recent_views r
    where r.person_id = new.person_id and r.org_id = new.org_id and r.deleted_at is null
      and (r.subject_table = 'projects') = (new.subject_table = 'projects')
    order by r.viewed_at desc, r.id desc
    offset 50);
  return null;
end;
$$;

comment on function private.trim_recent_views() is 'Keeps a person''s 50 most recently opened records, incidents, documents, SOPs and articles in an org (Section 11.7: the last 50), and apart from them their 50 most recently opened projects, and deletes the rest.';
revoke all on function private.trim_recent_views() from public, anon, authenticated;

create or replace function app.record_recent_view(p_org_id uuid, p_subject_table text, p_subject_id uuid)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_found boolean;
begin
  if auth.uid() is null or p_org_id is null or p_subject_id is null
     or p_subject_table is null
     or p_subject_table not in ('records', 'incidents', 'documents', 'sops', 'handbook_articles', 'projects') then
    return false;
  end if;
  -- Read with the caller's own row level security: something they cannot read is never recorded.
  execute format('select true from app.%I s where s.id = $1 and s.org_id = $2 and s.deleted_at is null', p_subject_table)
    into v_found using p_subject_id, p_org_id;
  if v_found is null then
    return false;
  end if;
  insert into app.recent_views (org_id, person_id, subject_table, subject_id)
  values (p_org_id, (select s.person_id from app.search_context(p_org_id) s), p_subject_table, p_subject_id)
  on conflict (person_id, org_id, subject_table, subject_id) where deleted_at is null
  do update set viewed_at = clock_timestamp();
  return true;
end;
$$;

comment on function app.record_recent_view(uuid, text, uuid) is 'Records that the signed-in person opened a record, incident, document, SOP, handbook article (Section 11.7 recents) or project (Section 4.5.2, the recent projects under Projects). Runs as the caller: something they cannot read is not recorded and the call returns false. Opening it again moves it to the top; at most 50 projects and 50 of everything else are kept per person and org.';
revoke all on function app.record_recent_view(uuid, text, uuid) from public, anon;
grant execute on function app.record_recent_view(uuid, text, uuid) to authenticated, service_role;

create or replace function app.recent_projects(p_org_id uuid, p_limit integer default 5)
returns table (
  project_id uuid,
  project_key text,
  name text,
  viewed_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.id, p.project_key, p.name, v.viewed_at
  from app.recent_views v
  join app.projects p on p.id = v.subject_id and p.org_id = v.org_id and p.deleted_at is null
  where v.subject_table = 'projects' and v.org_id = p_org_id and v.deleted_at is null
  order by v.viewed_at desc, v.id desc
  limit least(greatest(coalesce(p_limit, 5), 1), 50);
$$;

comment on function app.recent_projects(uuid, integer) is 'The projects the signed-in person opened most recently in an org, newest first, at most p_limit (5 by default, 50 at most), for the recent projects under Projects in the sidebar (Section 4.5.2). Read with their own row level security, so a project they can no longer read, or one that was deleted, drops out.';
revoke all on function app.recent_projects(uuid, integer) from public, anon;
grant execute on function app.recent_projects(uuid, integer) to authenticated, service_role;

-- Favorite order ------------------------------------------------------------------------------------------------------

create or replace function app.reorder_favorites(p_org_id uuid, p_favorite_ids uuid[])
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_favorite_ids is null or cardinality(p_favorite_ids) > 50 or array_position(p_favorite_ids, null) is not null
     or (select count(distinct x) from unnest(p_favorite_ids) x) <> cardinality(p_favorite_ids) then
    -- private.refuse's form; this function runs as the caller, who cannot reach the private schema.
    raise exception using errcode = 'XR001', hint = 'favorites_order',
      message = 'favorites_order: Send the favorites as a list of at most 50 ids, each once.';
  end if;

  -- One statement under the owner policies: the caller reads and writes only their own favorites. Those listed take
  -- their place from the list; any not listed (pinned in another tab meanwhile) follow in their current order.
  update app.favorites f set sort_order = o.position
  from (
    select l.id, (row_number() over (order by g.ordinality nulls last, l.sort_order, l.created_at, l.id) - 1)::integer
      as position
    from app.favorites l
    left join unnest(p_favorite_ids) with ordinality as g (id, ordinality) on g.id = l.id
    where l.org_id = p_org_id and l.deleted_at is null
  ) o
  where f.id = o.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.reorder_favorites(uuid, uuid[]) is 'Puts the signed-in person''s favorites in an org in the order of p_favorite_ids (Section 4.5.2, reordered by drag or keyboard), in one update that runs as the caller, so only their own favorites change. Favorites not listed follow in their current order. Returns how many favorites took a position.';
revoke all on function app.reorder_favorites(uuid, uuid[]) from public, anon;
grant execute on function app.reorder_favorites(uuid, uuid[]) to authenticated, service_role;
