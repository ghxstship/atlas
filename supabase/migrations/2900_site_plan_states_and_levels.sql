-- 2900_site_plan_states_and_levels.sql
-- B1 Places depth on image plans (RRR-225; competitor parity audit 2026-10-28, gaps G-02 and G-06; ADR 0140 D1 and D2).
--
--   * Site plan states (G-02): app.site_plans.plan_state is a stored workflow column, Draft, Locked, Live or Archived,
--     changed only through app.transition_site_plan on the lifecycle engine (0300) with its ledger, as work orders do
--     (0411). A project holds at most one Live plan per venue and level. Deleting a plan is still deleted_at and Trash.
--   * Existing plans start in Draft (the column default) and get one ledger row each, so every plan's ledger has a
--     start (ADR 0140 D2). A plan deleted before 2900 stays deleted: on 4.0 the Atlas "Archive" button, v1 DELETE and
--     Trash all set deleted_at and cannot be told apart, so moving those plans to Archived would bring back plans
--     people deleted. They stay in Trash, restorable for the 7 years of their retention.
--   * Levels (G-06): app.venue_levels names the levels of a venue in an order (basements below 0). Spaces and plans
--     may name a level of their own venue. Levels sort by level_order, then name; app.reorder_venue_levels renumbers
--     a venue's levels in one statement, so the order carries no uniqueness that a swap would trip over.

-- Plan states ------------------------------------------------------------------------------------------------------------

create type app.site_plan_state as enum ('Draft', 'Locked', 'Live', 'Archived');
comment on type app.site_plan_state is 'Site plan lifecycle (ADR 0140 D1): Draft while the layout is drawn, Locked when the layout is fixed, Live as the plan crews work from, Archived when retired and read-only.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('site_plan', 'Draft', 'Locked'),
  ('site_plan', 'Locked', 'Draft'),
  ('site_plan', 'Locked', 'Live'),
  ('site_plan', 'Live', 'Locked'),
  ('site_plan', 'Draft', 'Archived'),
  ('site_plan', 'Locked', 'Archived'),
  ('site_plan', 'Live', 'Archived'),
  ('site_plan', 'Archived', 'Draft')
on conflict do nothing;

insert into private.domain_event_types (code, subject, description) values
  ('site_plan.state_changed', 'site_plans', 'A site plan moved to another state (Draft, Locked, Live or Archived).'),
  ('venue_level.created', 'venue_levels', 'A level was added to a venue.'),
  ('venue_level.archived', 'venue_levels', 'A venue level was archived.')
on conflict (code) do nothing;

alter table app.site_plans add column plan_state app.site_plan_state not null default 'Draft';
comment on column app.site_plans.plan_state is 'Lifecycle state (ADR 0140 D1). Changes only through app.transition_site_plan, which writes app.site_plan_state_transitions. Only a Draft plan takes layout writes.';
create index site_plans_plan_state_idx on app.site_plans (plan_state);

create table app.site_plan_state_transitions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  site_plan_id uuid not null references app.site_plans (id),
  from_state app.site_plan_state,
  to_state app.site_plan_state not null,
  reason text not null,
  constraint site_plan_state_transitions_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index site_plan_state_transitions_site_plan_id_idx on app.site_plan_state_transitions (site_plan_id);

call private.install_domain_table('app.site_plan_state_transitions', 'app.site_plans', 'site_plan_id', '{}', true);
call private.describe('app.site_plan_state_transitions', 'Append-only ledger of site plan state changes, written only by app.transition_site_plan, plan creation and migration 2900.', array[
  'site_plan_id', 'Site plan that changed state.',
  'from_state', 'State before the change; NULL for the creation entry.',
  'to_state', 'State after the change.',
  'reason', 'Why the state changed.'
]);
call private.install_policies('app.site_plan_state_transitions',
  $$site_plan_id in (select x.id from app.site_plans x where x.project_id in (select private.project_ids_with('places.venue.read')))$$);
call private.install_default_retention('app.site_plan_state_transitions');

-- Every plan that exists now gets the start of its ledger; plans created from here on get it from t80.
insert into app.site_plan_state_transitions (site_plan_id, from_state, to_state, reason)
select p.id, null, 'Draft', 'State added (2900).' from app.site_plans p;

create trigger t41_site_plan_state before insert or update on app.site_plans
  for each row execute function private.guard_lifecycle_state('plan_state', 'site_plan', 'Draft');
create trigger t80_log_site_plan_state after insert on app.site_plans
  for each row execute function private.log_initial_state('app.site_plan_state_transitions', 'site_plan_id', 'plan_state');
create trigger t90_emit_site_plan_state after insert on app.site_plan_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('site_plan.state_changed', 'site_plans', 'site_plan_id', 'from_state', 'to_state', 'reason');

-- Levels -------------------------------------------------------------------------------------------------------------------

create table app.venue_levels (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  venue_id uuid not null references app.venues (id),
  name text not null,
  level_order integer not null default 0,
  deleted_at timestamptz,
  constraint venue_levels_name_length check (char_length(btrim(name)) between 1 and 100 and name = btrim(name)),
  constraint venue_levels_order_range check (level_order between -20 and 200)
);

create index venue_levels_venue_id_idx on app.venue_levels (venue_id, level_order);
create unique index venue_levels_name_key on app.venue_levels (venue_id, lower(btrim(name))) where deleted_at is null;

call private.install_domain_table('app.venue_levels', 'app.venues', 'venue_id');
call private.install_policies('app.venue_levels',
  $$venue_id in (select v.id from app.venues v where v.org_id in (select private.orgs_with_capability('places.venue.read'))
    or v.id in (select p.venue_id from app.projects p where p.id in (select private.readable_project_ids())))$$,
  $$org_id in (select private.orgs_with_capability('places.space.write'))$$);
call private.describe('app.venue_levels', 'Named levels of a venue (G-06), such as Basement, Ground or Mezzanine. Spaces and site plans may name a level of their own venue. Listed by level_order, then name.', array[
  'venue_id', 'Venue the level belongs to. Never changes.',
  'name', 'Level name, unique within the venue among live levels.',
  'level_order', 'Where the level sorts, lowest first; basements take negative numbers. Levels with the same order sort by name.'
]);
call private.install_default_retention('app.venue_levels');
call private.install_audit_trail('app.venue_levels');

create or replace function private.guard_venue_level()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.venue_id <> old.venue_id then
    perform private.refuse('venue_level_venue_immutable', 'A level stays in its venue.');
  end if;
  return new;
end;
$$;
comment on function private.guard_venue_level() is 'Venue levels never move to another venue.';
revoke all on function private.guard_venue_level() from public, anon, authenticated;
create trigger t40_guard_venue_level before update on app.venue_levels
  for each row execute function private.guard_venue_level();

create trigger t90_emit_venue_level_created after insert on app.venue_levels
  for each row execute function private.emit_row_event('venue_level.created', '-', 'venue_id', 'name', 'level_order');
create trigger t90_emit_venue_level_archived after update on app.venue_levels
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_row_event('venue_level.archived', '-', 'venue_id', 'name');

alter table app.spaces add column venue_level_id uuid references app.venue_levels (id);
create index spaces_venue_level_id_idx on app.spaces (venue_level_id);
comment on column app.spaces.venue_level_id is 'Level of the space''s own venue it is on; NULL when the venue has no levels or the level is not recorded.';

alter table app.site_plans add column venue_level_id uuid references app.venue_levels (id);
create index site_plans_venue_level_id_idx on app.site_plans (venue_level_id);
comment on column app.site_plans.venue_level_id is 'Level the plan draws, a level of the plan''s venue; a plan with a level names its venue.';

create or replace function private.guard_level_venue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_level_venue uuid;
begin
  if new.venue_level_id is null then
    return new;
  end if;
  select l.venue_id into v_level_venue from app.venue_levels l where l.id = new.venue_level_id;
  if v_level_venue is distinct from new.venue_id then
    if tg_table_name = 'spaces' then
      perform private.refuse('space_level_venue', 'A space''s level is a level of the space''s own venue.');
    end if;
    perform private.refuse('site_plan_level_venue', 'A plan''s level is a level of the venue it draws; choose the venue first.');
  end if;
  return new;
end;
$$;
comment on function private.guard_level_venue() is 'Before insert or update on spaces and site plans: a level is a level of the row''s own venue, so a plan with a level names that venue (space_level_venue, site_plan_level_venue).';
revoke all on function private.guard_level_venue() from public, anon, authenticated;
create trigger t42_guard_space_level before insert or update of venue_id, venue_level_id on app.spaces
  for each row execute function private.guard_level_venue();
create trigger t42_guard_site_plan_level before insert or update of venue_id, venue_level_id on app.site_plans
  for each row execute function private.guard_level_venue();

-- At most one Live plan per project, venue and level (ADR 0140 D1); the transition RPC checks first, so a person sees the
-- refusal rather than a unique violation. A restore from Trash that would make a second one is refused by this index.
create unique index site_plans_one_live on app.site_plans (project_id, venue_id, venue_level_id) nulls not distinct
  where plan_state = 'Live' and deleted_at is null;

-- RPCs -----------------------------------------------------------------------------------------------------------------------

create or replace function app.transition_site_plan(
  p_site_plan_id uuid,
  p_expected app.site_plan_state,
  p_next app.site_plan_state,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_plan app.site_plans;
begin
  perform private.require_person();
  select * into v_plan from app.site_plans p where p.id = p_site_plan_id and p.deleted_at is null;
  if v_plan.id is null or not private.can_on_project(v_plan.project_id, 'places.site_plan.write') then
    raise exception using errcode = '42501', message = 'places.site_plan.write is required on the site plan';
  end if;
  if p_next in ('Locked', 'Live') and v_plan.image_uri = 'attachments/pending' then
    perform private.refuse('site_plan_no_drawing', 'Use a drawing on the plan before you lock it or make it live.');
  end if;
  if p_next = 'Live' and exists (
    select 1 from app.site_plans o
    where o.project_id = v_plan.project_id and o.id <> v_plan.id and o.plan_state = 'Live' and o.deleted_at is null
      and o.venue_id is not distinct from v_plan.venue_id and o.venue_level_id is not distinct from v_plan.venue_level_id) then
    perform private.refuse('site_plan_live_exists', 'Another plan of this project, venue and level is live. Move it back to Locked first.');
  end if;
  return private.transition_lifecycle('site_plan', 'app.site_plans', 'plan_state', 'app.site_plan_state_transitions',
    'site_plan_id', p_site_plan_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_site_plan(uuid, app.site_plan_state, app.site_plan_state, text) is 'Moves a site plan to another state with compare-and-set on the expected state (ADR 0140 D1). Refuses Locked or Live while the plan has no drawing (site_plan_no_drawing) and a second Live plan of the same project, venue and level (site_plan_live_exists). Needs places.site_plan.write on the project. Returns the ledger entry id.';
revoke all on function app.transition_site_plan(uuid, app.site_plan_state, app.site_plan_state, text) from public, anon;
grant execute on function app.transition_site_plan(uuid, app.site_plan_state, app.site_plan_state, text) to authenticated, service_role;

create or replace function app.reorder_venue_levels(p_venue_id uuid, p_level_ids uuid[])
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_level_ids is null or cardinality(p_level_ids) <> (select count(distinct x) from unnest(p_level_ids) x)
     or (select count(*) from app.venue_levels l where l.venue_id = p_venue_id and l.deleted_at is null) <> cardinality(p_level_ids)
     or exists (select 1 from unnest(p_level_ids) x
                where not exists (select 1 from app.venue_levels l where l.id = x and l.venue_id = p_venue_id and l.deleted_at is null)) then
    raise exception using errcode = 'XR001', hint = 'venue_level_reorder',
      message = 'venue_level_reorder: Reorder lists every live level of the venue exactly once.';
  end if;
  -- The venue's order values, lowest first, are handed out in the new order, so basements keep their negative numbers.
  with wanted as (
    select x.id, x.ord from unnest(p_level_ids) with ordinality as x (id, ord)
  ), slots as (
    select l.level_order, row_number() over (order by l.level_order, lower(l.name), l.id) as ord
    from app.venue_levels l where l.venue_id = p_venue_id and l.deleted_at is null
  )
  update app.venue_levels l set level_order = s.level_order
  from wanted w join slots s on s.ord = w.ord
  where l.id = w.id and l.level_order is distinct from s.level_order;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.reorder_venue_levels(uuid, uuid[]) is 'Puts a venue''s live levels in the given order in one statement, handing out the venue''s existing order values lowest first. Runs as the caller, so the levels'' write policy (places.space.write) decides; as an invoker it raises its refusal (SQLSTATE XR001) itself. Refuses a list that is not every live level of the venue exactly once (venue_level_reorder). Returns how many levels moved.';
revoke all on function app.reorder_venue_levels(uuid, uuid[]) from public, anon;
grant execute on function app.reorder_venue_levels(uuid, uuid[]) to authenticated, service_role;
