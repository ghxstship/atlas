-- 2602_custody_and_lots_to_engagements.sql
-- R1 Advancing wiring fixes (RRR-179, ADR 0100 to 0104). Lot quantities go out to an engagement as units already do
-- (0975), so vendor and crew engagements hold consumables and cable counts too.
--
--   * app.asset_lot_movements gains custodian_engagement_id. A Check Out names exactly one custodian, a member or
--     an engagement; no movement names both. The engaged party reads the movements made to their engagement while
--     the operational area is open, as asset_custody_read reads units (0975).
--   * app.apply_asset_scan (from 0975) checks a lot quantity out to one member or engagement. An engagement custodian,
--     for units and lots, must be open (not deleted, Complete or Canceled); the asset is out for the engagement's
--     project, and a different given project is refused. Reserved check-out stays for R7.
--   * asset.lot_moved events carry the engagement custodian.
-- This file is the base definition of asset_lot_movements_direction and app.apply_asset_scan for R7a and R7.

-- Lot movements to an engagement -----------------------------------------------------------------------------------

alter table app.asset_lot_movements add column custodian_engagement_id uuid references app.engagements (id);
create index asset_lot_movements_custodian_engagement_idx on app.asset_lot_movements (custodian_engagement_id);
comment on column app.asset_lot_movements.custodian_engagement_id is 'External engagement (crew, staff, vendor) that took or returned the quantity. Never set together with custodian_membership_id.';

alter table app.asset_lot_movements drop constraint asset_lot_movements_direction;
alter table app.asset_lot_movements add constraint asset_lot_movements_direction check (
  (movement_kind = 'Check Out' and delta < 0 and num_nonnulls(custodian_membership_id, custodian_engagement_id) = 1)
  or (movement_kind = 'Check In' and delta > 0)
  or movement_kind = 'Count');
alter table app.asset_lot_movements add constraint asset_lot_movements_one_custodian
  check (num_nonnulls(custodian_membership_id, custodian_engagement_id) <= 1);

call private.install_tenant_guards('app.asset_lot_movements', 'app.asset_lots', 'asset_lot_id',
  array['app.memberships', 'custodian_membership_id', 'app.projects', 'project_id', 'app.engagements', 'custodian_engagement_id']);

drop policy asset_lot_movements_read on app.asset_lot_movements;
create policy asset_lot_movements_read on app.asset_lot_movements for select to authenticated using (
  org_id in (select private.orgs_with_capability('assets.asset.read'))
  or custodian_membership_id in (select private.my_membership_ids())
  or custodian_engagement_id in (select private.my_engagement_ids('operational')));

drop trigger t90_emit_lot_moved on app.asset_lot_movements;
create trigger t90_emit_lot_moved after insert on app.asset_lot_movements
  for each row execute function private.emit_subject_event('asset.lot_moved', 'asset_lots', 'asset_lot_id', 'movement_kind', 'delta',
    'project_id', 'custodian_engagement_id');

-- Engagement custodians ------------------------------------------------------------------------------------------------

create or replace function private.scan_engagement_project(p_engagement_id uuid, p_project_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
begin
  select e.* into v_engagement from app.engagements e where e.id = p_engagement_id;
  if v_engagement.id is null or v_engagement.deleted_at is not null or v_engagement.engagement_state in ('Complete', 'Canceled') then
    perform private.refuse('asset_scan_engagement_closed', 'Gear goes to an engagement that is still open.');
  end if;
  if p_project_id is not null and p_project_id <> v_engagement.project_id then
    perform private.refuse('asset_scan_engagement_project', 'Gear handed to an engagement is out for the engagement''s own project.');
  end if;
  return v_engagement.project_id;
end;
$$;
comment on function private.scan_engagement_project(uuid, uuid) is 'Scans to an engagement custodian (R1): refuses an engagement that is deleted, Complete or Canceled, and a given project other than the engagement''s; returns the engagement''s project, which the custody row or lot movement is out for.';
revoke all on function private.scan_engagement_project(uuid, uuid) from public, anon, authenticated;

-- Applying a scan event -------------------------------------------------------------------------------------

create or replace function app.apply_asset_scan(
  p_event_id uuid,
  p_org_id uuid,
  p_code text,
  p_action app.asset_scan_action,
  p_custodian_membership_id uuid default null,
  p_custodian_engagement_id uuid default null,
  p_venue_id uuid default null,
  p_project_id uuid default null,
  p_note text default null,
  p_quantity numeric default null
)
returns table (outcome text, subject_kind text, subject_id uuid, ledger_id uuid, asset_state app.asset_state, on_hand numeric)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_found record;
  v_unit app.asset_units%rowtype;
  v_lot app.asset_lots%rowtype;
  v_current record;
  v_existing record;
  v_project uuid;
  v_venue uuid;
  v_target app.asset_state;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform private.require_scan_access(p_org_id);
  if not private.reads_all_assets(p_org_id) then
    raise exception using errcode = '42501', message = 'assets.custody.write is required';
  end if;
  if p_event_id is null then
    perform private.refuse('asset_scan_event_required', 'Every scan carries the event id the device minted.');
  end if;
  select * into v_found from private.find_asset_code(p_org_id, p_code);
  if v_found.o_rule is not null then
    perform private.refuse(v_found.o_rule, 'NO_ANSWER: no single asset or lot carries this code.');
  end if;

  -- Lots ------------------------------------------------------------------------------------------------
  if v_found.o_lot_id is not null then
    select * into v_lot from app.asset_lots l where l.id = v_found.o_lot_id for update;
    select m.id, m.asset_lot_id into v_existing from app.asset_lot_movements m where m.id = p_event_id;
    if v_existing.id is not null then
      if v_existing.asset_lot_id <> v_lot.id then
        perform private.refuse('asset_scan_event_reused', 'This scan event already moved another lot.');
      end if;
      return query select 'duplicate'::text, 'lot'::text, v_lot.id, p_event_id, null::app.asset_state,
        (select b.on_hand from app.asset_lot_balances b where b.asset_lot_id = v_lot.id);
      return;
    end if;
    if p_action = 'transfer' then
      perform private.refuse('asset_scan_lot_transfer', 'Check a lot quantity in, then out again, to pass it on.');
    end if;
    if p_quantity is null or p_quantity <= 0 then
      perform private.refuse('asset_scan_quantity_required', 'Say how many of the lot move.');
    end if;
    -- A quantity checked out to an engagement is out for the engagement's project.
    v_project := p_project_id;
    if p_action = 'check-out' and p_custodian_engagement_id is not null then
      v_project := coalesce(p_project_id, (select e.project_id from app.engagements e where e.id = p_custodian_engagement_id));
    end if;
    if not (private.has_capability(p_org_id, 'assets.custody.write')
            or (v_project is not null and private.can_on_project(v_project, 'assets.custody.write'))) then
      raise exception using errcode = '42501', message = 'assets.custody.write is required';
    end if;
    if p_action = 'check-out' and num_nonnulls(p_custodian_membership_id, p_custodian_engagement_id) <> 1 then
      perform private.refuse('asset_scan_custodian_required', 'Name the one member or engagement that takes the quantity.');
    end if;
    if p_action = 'check-out' and p_custodian_engagement_id is not null then
      v_project := private.scan_engagement_project(p_custodian_engagement_id, p_project_id);
    end if;
    insert into app.asset_lot_movements (id, org_id, asset_lot_id, movement_kind, delta, custodian_membership_id, custodian_engagement_id,
      project_id, note)
    values (p_event_id, v_lot.org_id, v_lot.id,
            case when p_action = 'check-out' then 'Check Out' else 'Check In' end::app.asset_lot_movement_kind,
            case when p_action = 'check-out' then -p_quantity else p_quantity end,
            p_custodian_membership_id, p_custodian_engagement_id, v_project, v_note);
    return query select 'applied'::text, 'lot'::text, v_lot.id, p_event_id, null::app.asset_state,
      (select b.on_hand from app.asset_lot_balances b where b.asset_lot_id = v_lot.id);
    return;
  end if;

  -- Units -----------------------------------------------------------------------------------------------
  -- Lock the unit so a replay racing its first attempt sees the first attempt's custody row.
  select * into v_unit from app.asset_units u where u.id = v_found.o_unit_id for update;
  select c.id, c.asset_unit_id into v_existing from app.asset_custody c where c.id = p_event_id;
  if v_existing.id is not null then
    if v_existing.asset_unit_id <> v_unit.id then
      perform private.refuse('asset_scan_event_reused', 'This scan event already moved another asset.');
    end if;
    return query select 'duplicate'::text, 'unit'::text, v_unit.id, p_event_id, v_unit.asset_state, null::numeric;
    return;
  end if;

  if v_unit.asset_state in ('Proposed', 'Received', 'In Maintenance', 'Damaged', 'Lost', 'Retired') then
    perform private.refuse('asset_scan_unavailable', format('The asset is %s and cannot move by scan.', v_unit.asset_state));
  end if;
  if (p_action = 'check-out' and v_unit.asset_state not in ('Available', 'Reserved'))
     or (p_action in ('check-in', 'transfer') and v_unit.asset_state <> 'Deployed') then
    perform private.refuse('asset_scan_state_conflict', format('The asset is %s now; refresh before you scan again.', v_unit.asset_state));
  end if;

  select c.custodian_membership_id, c.project_id into v_current
  from app.asset_custody c where c.asset_unit_id = v_unit.id order by c.created_at desc, c.id desc limit 1;
  v_project := case when p_action = 'check-in' then null else coalesce(p_project_id, v_current.project_id) end;
  -- An asset handed to an engagement is out for the engagement's project.
  if p_action <> 'check-in' and p_custodian_engagement_id is not null then
    v_project := coalesce(p_project_id, (select e.project_id from app.engagements e where e.id = p_custodian_engagement_id), v_project);
  end if;
  if not (private.has_capability(p_org_id, 'assets.custody.write')
          or (coalesce(v_project, v_current.project_id) is not null
              and private.can_on_project(coalesce(v_project, v_current.project_id), 'assets.custody.write'))) then
    raise exception using errcode = '42501', message = 'assets.custody.write is required';
  end if;

  if p_action = 'check-in' then
    v_venue := coalesce(p_venue_id, v_unit.home_venue_id);
    if v_venue is null then
      perform private.refuse('asset_scan_place_required', 'Name the place the asset comes back to.');
    end if;
    insert into app.asset_custody (id, org_id, asset_unit_id, custodian_membership_id, venue_id, project_id, note)
    values (p_event_id, v_unit.org_id, v_unit.id, null, v_venue, null, v_note);
    v_target := 'Available';
  else
    if num_nonnulls(p_custodian_membership_id, p_custodian_engagement_id) <> 1 then
      perform private.refuse('asset_scan_custodian_required', 'Name the one member or engagement that takes the asset.');
    end if;
    if p_custodian_engagement_id is not null then
      v_project := private.scan_engagement_project(p_custodian_engagement_id, p_project_id);
    end if;
    insert into app.asset_custody (id, org_id, asset_unit_id, custodian_membership_id, custodian_engagement_id, venue_id, project_id, note)
    values (p_event_id, v_unit.org_id, v_unit.id, p_custodian_membership_id, p_custodian_engagement_id, p_venue_id, v_project, v_note);
    v_target := case when p_action = 'check-out' then 'Deployed' end;
  end if;

  if v_target is not null and v_target <> v_unit.asset_state then
    perform private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions',
      'asset_unit_id', v_unit.id, v_unit.asset_state::text, v_target::text,
      case when p_action = 'check-out' then 'Checked out by scan.' else 'Checked in by scan.' end);
  end if;
  return query select 'applied'::text, 'unit'::text, v_unit.id, p_event_id, coalesce(v_target, v_unit.asset_state), null::numeric;
end;
$$;
comment on function app.apply_asset_scan(uuid, uuid, text, app.asset_scan_action, uuid, uuid, uuid, uuid, text, numeric) is 'Applies one Compass scan event in one transaction: resolves the code, writes the custody row or lot movement under the device''s event id, and moves the unit state (check-out to Deployed, check-in to Available). A unit or a lot quantity goes to exactly one member or engagement; an engagement must be open (not Complete or Canceled) and the asset is out for its project, so a different given project is refused (R1). A replayed event id returns duplicate and changes nothing. Units that are not in a state the action starts from are refused with their current state. Needs assets.custody.write org-wide or on the project.';
revoke all on function app.apply_asset_scan(uuid, uuid, text, app.asset_scan_action, uuid, uuid, uuid, uuid, text, numeric) from public, anon;
grant execute on function app.apply_asset_scan(uuid, uuid, text, app.asset_scan_action, uuid, uuid, uuid, uuid, text, numeric) to authenticated, service_role;
