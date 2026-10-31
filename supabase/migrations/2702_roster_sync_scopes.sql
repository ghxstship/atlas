-- 2702_roster_sync_scopes.sql
-- R8 Compass Today (RRR-188, ADR 0101; Section 8.7 and Section 13). A person on a roster syncs their own entries, the
-- gear they hold and the project they work, and nothing of a colleague's. private.my_engagement_ids never matches a
-- rostered person (ADR 0101 decision 4), so each reader here calls private.my_roster_entry_ids('operational'): live
-- entries accepted by the reviewer and the person, on an Active or Closing engagement.
--
--   * private.sync_scope_grants: the scope key rosterEntryIds joins the allowed keys (sync_scope_grants_scope_key,
--     0942:23). private.sync_scope_rows is recreated from 0942:42-77 with rosterEntryIds and the entries' projects
--     as engagedProjectIds, both with audience crew, the Compass audience a person on a roster works as. Self entries
--     are left out: the engaged person syncs their own engagement through engagementIds already. A project the person
--     also works through their own engagement is not repeated as crew, so its audience stays that engagement's role type.
--   * Triggers on app.engagement_roster_entries (insert, a change of state, answer or engagement, and soft delete) and on
--     app.engagement_state_transitions refresh the scopes of the people on the roster (0942:143-159 is the refresh).
--   * private.asset_unit_assigned_to_me and app.resolve_asset_code are recreated from 1111, and
--     private.require_scan_access from 0975, so a unit whose current custody names one of the caller's operational
--     entries resolves for them and stays unknown to everyone else, colleagues included.

-- Scope keys ---------------------------------------------------------------------------------------------------------------

alter table private.sync_scope_grants drop constraint sync_scope_grants_scope_key;
alter table private.sync_scope_grants add constraint sync_scope_grants_scope_key check (scope_key in ('personIds', 'membershipIds',
  'readableProjectIds', 'orgIds', 'engagementIds', 'engagedProjectIds', 'rosterEntryIds'));
comment on column private.sync_scope_grants.scope_key is 'personIds, membershipIds, readableProjectIds, orgIds, engagementIds, engagedProjectIds or rosterEntryIds (R8).';

create or replace function private.sync_scope_rows(p_user_id uuid)
returns table (scope_key text, scope_value text, audience text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_rows jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  select coalesce(jsonb_agg(jsonb_build_object('k', r.k, 'v', r.v, 'a', r.a)), '[]'::jsonb) into v_rows
  from (
    select 'personIds' as k, p.id::text as v, 'Self' as a from app.people p where p.id = private.current_person_id()
    union
    select 'membershipIds', m::text, 'Internal' from private.my_membership_ids() m
    union
    select 'orgIds', o::text, 'Internal' from private.my_org_ids() o
    union
    select 'readableProjectIds', p.id::text, 'Internal' from app.projects p
    where p.id in (select private.readable_project_ids())
       or p.org_id in (select private.oversight_org_ids('projects.project.read'))
    union
    select 'engagementIds', e.id::text, e.role_type::text from app.engagements e
    where e.id in (select private.my_engagement_ids('operational')) and e.engagement_state in ('Active', 'Closing')
    union
    select 'engagedProjectIds', e.project_id::text, e.role_type::text from app.engagements e
    where e.id in (select private.my_engagement_ids('operational')) and e.engagement_state in ('Active', 'Closing')
    union
    select 'rosterEntryIds', r.id::text, 'crew' from app.engagement_roster_entries r
    join app.engagements e on e.id = r.engagement_id
    where r.id in (select private.my_roster_entry_ids('operational')) and r.entry_state = 'Accepted' and not r.is_self
      and e.engagement_state in ('Active', 'Closing')
    union
    select 'engagedProjectIds', e.project_id::text, 'crew' from app.engagement_roster_entries r
    join app.engagements e on e.id = r.engagement_id
    where r.id in (select private.my_roster_entry_ids('operational')) and r.entry_state = 'Accepted' and not r.is_self
      and e.engagement_state in ('Active', 'Closing')
      -- A project the person also works through their own engagement keeps that engagement's role type as audience.
      and e.project_id not in (select o.project_id from app.engagements o
                               where o.id in (select private.my_engagement_ids('operational'))
                                 and o.engagement_state in ('Active', 'Closing'))
  ) r;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  return query select x ->> 'k', x ->> 'v', x ->> 'a' from jsonb_array_elements(v_rows) x;
end;
$$;

comment on function private.sync_scope_rows(uuid) is 'The sync scopes of a user, computed with the same helpers as row level security by evaluating them under the user''s claims, then restoring the caller''s claims. readableProjectIds is exactly the projects read policy. When a person reaches one project through two engagements, the first role type in canon order is the audience. A person on a party''s roster holds rosterEntryIds and their projects as engagedProjectIds, audience crew, for each live entry accepted by both sides on an Active or Closing engagement, self entries left out, and a project the person also works through their own engagement keeps that engagement''s audience (R8).';
revoke all on function private.sync_scope_rows(uuid) from public, anon, authenticated;

-- Refresh on roster changes -----------------------------------------------------------------------------------------------------

create or replace function private.sync_scope_roster_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb[] := array_remove(array[case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end], null);
  v_row jsonb;
  v_people uuid[] := '{}';
begin
  foreach v_row in array v_rows loop
    if tg_argv[0] = 'entry' then
      v_people := v_people || array(
        select private.roster_entry_person_id(coalesce((v_row ->> 'is_self')::boolean, false), (v_row ->> 'person_id')::uuid, e.person_id)
        from app.engagements e where e.id = (v_row ->> 'engagement_id')::uuid);
    else
      v_people := v_people || array(
        select private.roster_entry_person_id(r.is_self, r.person_id, e.person_id)
        from app.engagement_roster_entries r join app.engagements e on e.id = r.engagement_id
        where r.engagement_id = (v_row ->> 'engagement_id')::uuid and r.deleted_at is null and r.entry_state <> 'Withdrawn');
    end if;
  end loop;
  perform private.refresh_sync_scopes_of_people(array_remove(v_people, null));
  return null;
end;
$$;

comment on function private.sync_scope_roster_trigger() is 'R8: after a roster entry changes (argument entry) or its engagement changes state (argument engagement), refreshes the sync scopes of the people on it, resolved through private.roster_entry_person_id (the engaged person for a self entry).';
revoke all on function private.sync_scope_roster_trigger() from public, anon, authenticated;

create trigger t96_sync_scopes after insert or update of entry_state, person_response, person_id, engagement_id, deleted_at
  on app.engagement_roster_entries
  for each row execute function private.sync_scope_roster_trigger('entry');
create trigger t97_sync_roster_scopes after insert on app.engagement_state_transitions
  for each row execute function private.sync_scope_roster_trigger('engagement');

-- Scans resolve the holder's own gear -----------------------------------------------------------------------------------------------

create or replace function private.require_scan_access(p_org_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if private.has_capability(p_org_id, 'assets.asset.read') then
    return;
  end if;
  if exists (select 1 from private.project_ids_with('assets.custody.write') x
             join app.projects p on p.id = x where p.org_id = p_org_id) then
    return;
  end if;
  if exists (select 1 from private.my_engagement_ids('operational') x
             join app.engagements e on e.id = x where e.org_id = p_org_id) then
    return;
  end if;
  if exists (select 1 from private.my_roster_entry_ids('operational') x
             join app.engagement_roster_entries r on r.id = x
             join app.engagements e on e.id = r.engagement_id where e.org_id = p_org_id) then
    return;
  end if;
  raise exception using errcode = '42501', message = 'assets.asset.read or assets.custody.write is required';
end;
$$;
comment on function private.require_scan_access(uuid) is 'Scanning needs assets.asset.read org-wide, assets.custody.write on a project of the org (field crew carrying gear), an operational engagement with the org (external crew syncing the gear they hold), or an operational roster entry on one of the org''s engagements (R8).';
revoke all on function private.require_scan_access(uuid) from public, anon, authenticated;

create or replace function private.asset_unit_assigned_to_me(p_asset_unit_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (private.api_key_scopes() is null or 'assets' = any (private.api_key_scopes()))
    and exists (
      select 1 from (
        select ac.custodian_membership_id, ac.custodian_engagement_id, ac.roster_entry_id, ac.project_id
        from app.asset_custody ac
        where ac.asset_unit_id = p_asset_unit_id and ac.deleted_at is null
        order by ac.created_at desc, ac.id desc
        limit 1
      ) k
      where k.custodian_membership_id in (select private.my_membership_ids())
         or k.custodian_engagement_id in (select private.my_engagement_ids('operational'))
         or k.roster_entry_id in (select private.my_roster_entry_ids('operational'))
         or k.project_id in (select private.project_ids_with('assets.asset.read')));
$$;

comment on function private.asset_unit_assigned_to_me(uuid) is 'True when the asset unit''s current custody is the signed-in person (membership, operational engagement, or operational roster entry, R8) or a project on which they hold assets.asset.read (SIM-006). Takes the unit id (ADR 0016 item 14); false for an API-key session without the assets scope.';
revoke all on function private.asset_unit_assigned_to_me(uuid) from public, anon;
grant execute on function private.asset_unit_assigned_to_me(uuid) to authenticated, service_role;

create or replace function app.resolve_asset_code(p_org_id uuid, p_code text)
returns table (
  subject_kind text,
  subject_id uuid,
  asset_tag text,
  class_name text,
  asset_state app.asset_state,
  home_venue_id uuid,
  custodian_membership_id uuid,
  custodian_engagement_id uuid,
  custody_venue_id uuid,
  custody_project_id uuid,
  custody_since timestamptz,
  lot_venue_id uuid,
  on_hand numeric,
  refusal text,
  reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_found record;
begin
  perform private.require_scan_access(p_org_id);
  select * into v_found from private.find_asset_code(p_org_id, p_code);
  -- Without org-wide asset read, a unit resolves only when it is assigned to the caller (their project, themselves or
  -- one of their operational roster entries: SIM-006, R8) and a lot only for field crew carrying gear; anything else
  -- is unknown, so a scan never reveals gear the person may not see.
  if v_found.o_rule is null and not private.has_capability(p_org_id, 'assets.asset.read')
     and ((v_found.o_lot_id is not null and not private.reads_all_assets(p_org_id))
          or (v_found.o_unit_id is not null and not private.asset_unit_assigned_to_me(v_found.o_unit_id))) then
    v_found.o_unit_id := null;
    v_found.o_lot_id := null;
    v_found.o_rule := 'asset_code_unknown';
  end if;
  if v_found.o_rule is not null then
    return query select null::text, null::uuid, null::text, null::text, null::app.asset_state, null::uuid, null::uuid, null::uuid, null::uuid,
      null::uuid, null::timestamptz, null::uuid, null::numeric, 'NO_ANSWER'::text, v_found.o_rule;
    return;
  end if;
  if v_found.o_lot_id is not null then
    return query
      select 'lot'::text, l.id, null::text, c.name, null::app.asset_state, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid,
             null::timestamptz, l.venue_id, b.on_hand, null::text, null::text
      from app.asset_lots l
      join app.asset_classes c on c.id = l.asset_class_id
      join app.asset_lot_balances b on b.asset_lot_id = l.id
      where l.id = v_found.o_lot_id;
    return;
  end if;
  return query
    select 'unit'::text, u.id, u.asset_tag, c.name, u.asset_state, u.home_venue_id,
           k.custodian_membership_id, k.custodian_engagement_id, k.venue_id, k.project_id, k.created_at, null::uuid, null::numeric, null::text, null::text
    from app.asset_units u
    join app.asset_classes c on c.id = u.asset_class_id
    left join lateral (
      select ac.custodian_membership_id, ac.custodian_engagement_id, ac.venue_id, ac.project_id, ac.created_at
      from app.asset_custody ac where ac.asset_unit_id = u.id
      order by ac.created_at desc, ac.id desc limit 1
    ) k on true
    where u.id = v_found.o_unit_id;
end;
$$;

comment on function app.resolve_asset_code(uuid, text) is 'Compass scan lookup: the unit or lot a scanned code names, with its state, custodian and quantity on hand, or a NO_ANSWER row naming asset_code_unknown or asset_code_ambiguous. Needs assets.asset.read or assets.custody.write on a project of the org, or an operational engagement or roster entry with it. Without org-wide asset read, a unit resolves only when assigned to the caller''s project, to the caller or to one of their operational roster entries (SIM-006, R8).';
revoke all on function app.resolve_asset_code(uuid, text) from public, anon;
grant execute on function app.resolve_asset_code(uuid, text) to authenticated, service_role;

-- People already on rosters get their scopes now.
select private.refresh_sync_scopes_of_people(array(
  select distinct private.roster_entry_person_id(r.is_self, r.person_id, e.person_id)
  from app.engagement_roster_entries r join app.engagements e on e.id = r.engagement_id
  where r.deleted_at is null and r.entry_state = 'Accepted' and not r.is_self and e.engagement_state in ('Active', 'Closing')));
