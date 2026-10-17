-- 1111_field_asset_visibility.sql
-- A42 Compass launch gaps, SIM-006. The Field role holds assets.asset.read at assigned reach, but asset
-- units are org records with no project, and their read policies admitted only org-wide readers, so a
-- Field member saw no unit at all and every asset scan in Compass read "Unknown code". Owner decision
-- 2026-10-17: a Field member reads the units assigned to their project or checked out to them, and no
-- others.
--   * private.asset_unit_assigned_to_me(unit): the unit's current custody (the latest asset_custody row)
--     is the caller's membership or operational engagement, or is out for a project on which the caller
--     holds assets.asset.read (assigned reach counts). It takes the unit id as its argument (ADR 0016
--     item 14) and answers false to an API-key session without the assets scope (A22-001).
--   * asset_units and asset_identifiers read: org-wide readers as before, or a unit assigned to the caller.
--   * app.resolve_asset_code answers the same way for units, so the server lookup agrees with what Compass
--     downloads. Lots keep their earlier rule. "Reserved" is an asset state, not a record that names a
--     project, so a reservation counts once the desk checks the unit out to the project.

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
        select ac.custodian_membership_id, ac.custodian_engagement_id, ac.project_id
        from app.asset_custody ac
        where ac.asset_unit_id = p_asset_unit_id and ac.deleted_at is null
        order by ac.created_at desc, ac.id desc
        limit 1
      ) k
      where k.custodian_membership_id in (select private.my_membership_ids())
         or k.custodian_engagement_id in (select private.my_engagement_ids('operational'))
         or k.project_id in (select private.project_ids_with('assets.asset.read')));
$$;

comment on function private.asset_unit_assigned_to_me(uuid) is 'True when the asset unit''s current custody is the signed-in person (membership or operational engagement) or a project on which they hold assets.asset.read (SIM-006). Takes the unit id (ADR 0016 item 14); false for an API-key session without the assets scope.';
revoke all on function private.asset_unit_assigned_to_me(uuid) from public, anon;
grant execute on function private.asset_unit_assigned_to_me(uuid) to authenticated, service_role;

drop policy asset_units_read on app.asset_units;
create policy asset_units_read on app.asset_units for select to authenticated using (
  org_id in (select private.orgs_with_capability('assets.asset.read'))
  or private.asset_unit_assigned_to_me(id));

drop policy asset_identifiers_read on app.asset_identifiers;
create policy asset_identifiers_read on app.asset_identifiers for select to authenticated using (
  org_id in (select private.orgs_with_capability('assets.asset.read'))
  or (asset_unit_id is not null and private.asset_unit_assigned_to_me(asset_unit_id)));

-- The scan lookup answers the same way ---------------------------------------------------------------------

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
  -- Without org-wide asset read, a unit resolves only when it is assigned to the caller (their project or
  -- themselves, SIM-006) and a lot only for field crew carrying gear; anything else is unknown, so a scan
  -- never reveals gear the person may not see.
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

comment on function app.resolve_asset_code(uuid, text) is 'Compass scan lookup: the unit or lot a scanned code names, with its state, custodian and quantity on hand, or a NO_ANSWER row naming asset_code_unknown or asset_code_ambiguous. Needs assets.asset.read or assets.custody.write on a project of the org. Without org-wide asset read, a unit resolves only when assigned to the caller''s project or to the caller (SIM-006).';
revoke all on function app.resolve_asset_code(uuid, text) from public, anon;
grant execute on function app.resolve_asset_code(uuid, text) to authenticated, service_role;
