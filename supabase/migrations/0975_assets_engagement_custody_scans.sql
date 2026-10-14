-- 0975_assets_engagement_custody_scans.sql
-- A12 Assets (RRR-24), late slot 0975 to 0979: everything that references app.engagements (0700).
--   1. Custody to an engagement: external crew hold gear through their engagement (Section 4.5.7,
--      Compass Asset scan for assigned gear). Custody goes to a membership or an engagement, never
--      both.
--   2. app.resolve_asset_code: the unit or lot a scanned code names, or a NO_ANSWER refusal row.
--      External parties resolve only the gear their engagements hold.
--   3. app.apply_asset_scan applies one scan event atomically: custody row or lot movement plus the
--      state move, keyed by the device-minted event id, so a replay after any delay changes nothing
--      and answers duplicate. The server wins conflicts (Section 3.15, rule 5).

-- Custody to an engagement ---------------------------------------------------------------------------------

alter table app.asset_custody add column custodian_engagement_id uuid references app.engagements (id);
create index asset_custody_custodian_engagement_idx on app.asset_custody (custodian_engagement_id);
comment on column app.asset_custody.custodian_engagement_id is 'External engagement (crew, staff, vendor) that holds the asset. Never set together with custodian_membership_id.';
alter table app.asset_custody drop constraint asset_custody_somewhere;
alter table app.asset_custody add constraint asset_custody_somewhere
  check (num_nonnulls(custodian_membership_id, custodian_engagement_id, venue_id) >= 1);
alter table app.asset_custody add constraint asset_custody_one_custodian
  check (num_nonnulls(custodian_membership_id, custodian_engagement_id) <= 1);
call private.install_tenant_guards('app.asset_custody', 'app.asset_units', 'asset_unit_id',
  array['app.memberships', 'custodian_membership_id', 'app.projects', 'project_id', 'app.venues', 'venue_id',
        'app.engagements', 'custodian_engagement_id']);
drop policy asset_custody_read on app.asset_custody;
create policy asset_custody_read on app.asset_custody for select to authenticated using (
  org_id in (select private.orgs_with_capability('assets.asset.read'))
  or custodian_membership_id in (select private.my_membership_ids())
  or custodian_engagement_id in (select private.my_engagement_ids('operational')));

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
  raise exception using errcode = '42501', message = 'assets.asset.read or assets.custody.write is required';
end;
$$;
comment on function private.require_scan_access(uuid) is 'Scanning needs assets.asset.read org-wide, assets.custody.write on a project of the org (field crew carrying gear), or an operational engagement with the org (external crew syncing the gear they hold).';
revoke all on function private.require_scan_access(uuid) from public, anon, authenticated;

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
  -- External parties resolve only units their own engagements hold now; anything else is unknown
  -- to them, so a scan never reveals gear they may not see.
  if v_found.o_rule is null and not private.reads_all_assets(p_org_id)
     and (v_found.o_lot_id is not null or not exists (
       select 1 from (
         select ac.custodian_engagement_id from app.asset_custody ac where ac.asset_unit_id = v_found.o_unit_id
         order by ac.created_at desc, ac.id desc limit 1) k
       where k.custodian_engagement_id in (select private.my_engagement_ids('operational')))) then
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
comment on function app.resolve_asset_code(uuid, text) is 'Compass scan lookup: the unit or lot a scanned code names, with its state, custodian and quantity on hand, or a NO_ANSWER row naming asset_code_unknown or asset_code_ambiguous. Needs assets.asset.read or assets.custody.write on a project of the org; an external party resolves only the units their engagements hold.';
revoke all on function app.resolve_asset_code(uuid, text) from public, anon;
grant execute on function app.resolve_asset_code(uuid, text) to authenticated, service_role;

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
    if not (private.has_capability(p_org_id, 'assets.custody.write')
            or (p_project_id is not null and private.can_on_project(p_project_id, 'assets.custody.write'))) then
      raise exception using errcode = '42501', message = 'assets.custody.write is required';
    end if;
    if p_action = 'check-out' and p_custodian_membership_id is null then
      perform private.refuse('asset_scan_custodian_required', 'Name the person who takes the quantity.');
    end if;
    insert into app.asset_lot_movements (id, org_id, asset_lot_id, movement_kind, delta, custodian_membership_id, project_id, note)
    values (p_event_id, v_lot.org_id, v_lot.id,
            case when p_action = 'check-out' then 'Check Out' else 'Check In' end::app.asset_lot_movement_kind,
            case when p_action = 'check-out' then -p_quantity else p_quantity end,
            p_custodian_membership_id, p_project_id, v_note);
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
    if v_project is null and p_custodian_engagement_id is not null then
      v_project := (select e.project_id from app.engagements e where e.id = p_custodian_engagement_id);
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
comment on function app.apply_asset_scan(uuid, uuid, text, app.asset_scan_action, uuid, uuid, uuid, uuid, text, numeric) is 'Applies one Compass scan event in one transaction: resolves the code, writes the custody row or lot movement under the device''s event id, and moves the unit state (check-out to Deployed, check-in to Available). A replayed event id returns duplicate and changes nothing. Units that are not in a state the action starts from are refused with their current state. Needs assets.custody.write org-wide or on the project.';
revoke all on function app.apply_asset_scan(uuid, uuid, text, app.asset_scan_action, uuid, uuid, uuid, uuid, text, numeric) from public, anon;
grant execute on function app.apply_asset_scan(uuid, uuid, text, app.asset_scan_action, uuid, uuid, uuid, uuid, text, numeric) to authenticated, service_role;


-- Custody events name the engagement too ---------------------------------------------------------------------

drop trigger t90_emit_custody on app.asset_custody;
create trigger t90_emit_custody after insert on app.asset_custody
  for each row execute function private.emit_subject_event('asset.custody_changed', 'asset_units', 'asset_unit_id',
    'custodian_membership_id', 'custodian_engagement_id', 'venue_id', 'project_id');

-- Retention (0550 runs after 0450, so the lot ledger takes its policy here) ------------------------------------

call private.install_default_retention('app.asset_lot_movements');
