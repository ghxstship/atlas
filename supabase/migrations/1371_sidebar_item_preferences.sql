-- 1371_sidebar_item_preferences.sql
-- A81 navigation and keyboard (RRR-126, finding A65-024; Section 4.5.2 "Each person can hide, reorder or pin items.
-- Reset to role default restores the starting layout.").
--   * app.sidebar_item_preferences: the person's own layout of an org's Atlas sidebar. One live row per person, org and
--     sitemap node (a module group such as group.production, or an item such as finance) holds its position among its
--     siblings and whether the person hid it. Nodes without a row keep the role default order and stay shown.
--   * Per org, like favorites (0850): modules, roles and the role-default groups differ between orgs.
--   * Hiding takes an item out of the sidebar only. It stays in search, the command menu and G navigation, and the
--     database still decides every row the page shows.
--   * app.save_sidebar_layout writes the whole layout at once; app.reset_sidebar_layout soft-deletes every row, which
--     restores the role default. Both run with the caller's rights, so the owner policies decide every row: the guard
--     gives a new row to the session person, and an update reaches only the caller's own rows.
--   * Pins stay in app.favorites (0850).

create table app.sidebar_item_preferences (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  node_id text not null,
  sort_order integer not null,
  hidden boolean not null default false,
  constraint sidebar_item_preferences_node_id check (
    node_id ~ '^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$' and char_length(node_id) <= 120),
  constraint sidebar_item_preferences_sort_order check (sort_order between 0 and 10000)
);

call private.install_domain_table('app.sidebar_item_preferences');
create unique index sidebar_item_preferences_live_key on app.sidebar_item_preferences (person_id, org_id, node_id)
  where deleted_at is null;
create index sidebar_item_preferences_person_id_idx on app.sidebar_item_preferences (person_id);
call private.describe('app.sidebar_item_preferences', 'A person''s own layout of an org''s Atlas sidebar (Section 4.5.2): the position and visibility of module groups and items. Nodes without a row keep the role default. Private to the person; Reset to role default removes every row.', array[
  'person_id', 'Person whose sidebar this is, from the session.',
  'node_id', 'Sitemap node of the group or item, for example group.production or finance.',
  'sort_order', 'Position among the node''s siblings, ascending.',
  'hidden', 'True when the person took the item out of their sidebar; it stays in search and the command menu.'
]);

-- A reset layout is personal data with no further use.
call private.install_default_retention('app.sidebar_item_preferences', interval '90 days');

create or replace function private.guard_sidebar_item_preference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.person_id <> old.person_id or new.node_id <> old.node_id then
      perform private.refuse('sidebar_item_immutable', 'A sidebar preference keeps its item; save the layout again instead.');
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      perform private.refuse('sidebar_item_immutable', 'Save the layout again instead of restoring a reset item.');
    end if;
    return new;
  end if;
  new.person_id := coalesce(private.current_person_id(), new.person_id);
  if new.person_id is null then
    perform private.refuse('sidebar_layout_person', 'Sign in to change your sidebar.');
  end if;
  if (select count(*) from app.sidebar_item_preferences s
      where s.person_id = new.person_id and s.org_id = new.org_id and s.deleted_at is null) >= 200 then
    perform private.refuse('sidebar_items_limit', 'A sidebar layout holds at most 200 items per org.');
  end if;
  return new;
end;
$$;

comment on function private.guard_sidebar_item_preference() is 'Sidebar preferences: a new row belongs to the session person; a row never changes person or node, a reset row stays reset, and a person keeps at most 200 live rows per org.';
revoke all on function private.guard_sidebar_item_preference() from public, anon, authenticated;

create trigger t40_guard_sidebar_item_preference before insert or update on app.sidebar_item_preferences
  for each row execute function private.guard_sidebar_item_preference();

call private.install_policies('app.sidebar_item_preferences',
  $$person_id = (select private.current_person_id())$$,
  $$person_id = (select private.current_person_id()) and org_id in (select private.my_org_ids())$$);

-- Writing -------------------------------------------------------------------------------------------------------------

create or replace function app.save_sidebar_layout(p_org_id uuid, p_items jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 200 then
    -- private.refuse's form; this function runs as the caller, who cannot reach the private schema.
    raise exception using errcode = 'XR001', hint = 'sidebar_layout_items',
      message = 'sidebar_layout_items: Send the sidebar as a list of at most 200 items.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
             where jsonb_typeof(e.value) <> 'object' or jsonb_typeof(e.value -> 'node') is distinct from 'string'
               or jsonb_typeof(coalesce(e.value -> 'hidden', 'false'::jsonb)) <> 'boolean')
     or (select count(distinct e.value ->> 'node') from jsonb_array_elements(p_items) e) <> jsonb_array_length(p_items) then
    raise exception using errcode = 'XR001', hint = 'sidebar_layout_items',
      message = 'sidebar_layout_items: Each sidebar item names its node once, with hidden true or false.';
  end if;

  -- Items no longer listed go back to the role default.
  update app.sidebar_item_preferences s set deleted_at = now()
  where s.org_id = p_org_id and s.deleted_at is null
    and s.node_id not in (select e.value ->> 'node' from jsonb_array_elements(p_items) e);

  insert into app.sidebar_item_preferences (org_id, node_id, sort_order, hidden)
  select p_org_id, e.value ->> 'node', (e.ordinality - 1)::integer, coalesce((e.value ->> 'hidden')::boolean, false)
  from jsonb_array_elements(p_items) with ordinality as e (value, ordinality)
  on conflict (person_id, org_id, node_id) where deleted_at is null
  do update set sort_order = excluded.sort_order, hidden = excluded.hidden;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.save_sidebar_layout(uuid, jsonb) is 'Saves the signed-in person''s sidebar layout in an org: p_items lists sitemap nodes in order as {"node": "finance", "hidden": false}; each takes its position from the list, and nodes left out return to the role default. Returns how many items were saved.';
revoke all on function app.save_sidebar_layout(uuid, jsonb) from public, anon;
grant execute on function app.save_sidebar_layout(uuid, jsonb) to authenticated;

create or replace function app.reset_sidebar_layout(p_org_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  update app.sidebar_item_preferences s set deleted_at = now()
  where s.org_id = p_org_id and s.deleted_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.reset_sidebar_layout(uuid) is 'Reset to role default: removes the signed-in person''s sidebar layout in an org. Returns how many items were reset.';
revoke all on function app.reset_sidebar_layout(uuid) from public, anon;
grant execute on function app.reset_sidebar_layout(uuid) to authenticated;
