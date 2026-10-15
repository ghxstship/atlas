-- 0450_assets_scans_lots.sql
-- A12 Assets (RRR-24), range 0450 to 0459 (ADR 0022). Builds on A03's 0352:
--   1. The lot movement ledger: lot quantity on hand is derived (opening count plus movements),
--      never edited in place (Section 3.15, rule 2), and never goes below zero.
--   2. Scan resolution helpers: the scan action enum and private.find_asset_code, which turns a
--      scanned code into one unit or lot or names the rule that refused, never a guess (Section 3.7).
--      The scan RPCs reference engagements (0700), so they live in the late slot, 0975.
--   3. app.count_asset_lot records a recount as a Count movement.
--   4. Domain events (and so audit, activity and webhooks) for maintenance, damage and lot moves.

-- Domain events ---------------------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('asset.maintenance_recorded', 'asset_units', 'Maintenance was recorded on an asset unit.'),
  ('asset.damage_reported', 'asset_units', 'Damage was reported against an asset unit.'),
  ('asset.lot_moved', 'asset_lots', 'An asset lot was counted, checked out or checked in.')
on conflict (code) do nothing;

create trigger t90_emit_maintenance after insert on app.asset_maintenance
  for each row execute function private.emit_subject_event('asset.maintenance_recorded', 'asset_units', 'asset_unit_id', 'performed_on', 'cost_minor', 'currency_code');
create trigger t90_emit_damage after insert on app.asset_damage
  for each row execute function private.emit_subject_event('asset.damage_reported', 'asset_units', 'asset_unit_id', 'project_id', 'reported_at');

-- Lot movement ledger ---------------------------------------------------------------------------------------

create type app.asset_lot_movement_kind as enum ('Count', 'Check Out', 'Check In');
comment on type app.asset_lot_movement_kind is 'Why a lot quantity moved: a recount, a check-out to a person, or a check-in.';

create table app.asset_lot_movements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  asset_lot_id uuid not null references app.asset_lots (id),
  movement_kind app.asset_lot_movement_kind not null,
  delta numeric not null,
  custodian_membership_id uuid references app.memberships (id),
  project_id uuid references app.projects (id),
  note text,
  constraint asset_lot_movements_delta_nonzero check (delta <> 0),
  constraint asset_lot_movements_direction check (
    (movement_kind = 'Check Out' and delta < 0 and custodian_membership_id is not null)
    or (movement_kind = 'Check In' and delta > 0)
    or movement_kind = 'Count'),
  constraint asset_lot_movements_note_length check (note is null or char_length(note) <= 1000)
);
create index asset_lot_movements_lot_idx on app.asset_lot_movements (asset_lot_id);
create index asset_lot_movements_custodian_idx on app.asset_lot_movements (custodian_membership_id);
create index asset_lot_movements_project_idx on app.asset_lot_movements (project_id);
call private.install_domain_table('app.asset_lot_movements', 'app.asset_lots', 'asset_lot_id',
  array['app.memberships', 'custodian_membership_id', 'app.projects', 'project_id'], true);
call private.describe('app.asset_lot_movements', 'Append-only lot ledger: each row moves a lot quantity by a delta, for a recount, a check-out to a person or a check-in. On hand is the opening count plus the deltas (app.asset_lot_balances).', array[
  'asset_lot_id', 'Lot moved.', 'movement_kind', 'Count, Check Out or Check In.', 'delta', 'Signed change to the quantity on hand; negative for a check-out.',
  'custodian_membership_id', 'Member who took or returned the quantity.', 'project_id', 'Project the quantity is out for.', 'note', 'Movement note.'
]);
call private.install_policies('app.asset_lot_movements',
  $$org_id in (select private.orgs_with_capability('assets.asset.read')) or custodian_membership_id in (select private.my_membership_ids())$$);
create trigger t90_emit_lot_moved after insert on app.asset_lot_movements
  for each row execute function private.emit_subject_event('asset.lot_moved', 'asset_lots', 'asset_lot_id', 'movement_kind', 'delta', 'project_id');

comment on column app.asset_lots.quantity is 'Opening count when the lot was created. Fixed afterwards; recounts and moves are rows of app.asset_lot_movements.';

create or replace function private.guard_asset_lot_quantity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.quantity is distinct from old.quantity then
    perform private.refuse('asset_lot_quantity_ledger', 'A lot quantity changes through a count or a movement, not an edit.');
  end if;
  return new;
end;
$$;
comment on function private.guard_asset_lot_quantity() is 'Asset lots: the opening count is fixed; the quantity on hand moves through the lot ledger.';
revoke all on function private.guard_asset_lot_quantity() from public, anon, authenticated;
create trigger t41_guard_asset_lot_quantity before update of quantity on app.asset_lots
  for each row execute function private.guard_asset_lot_quantity();

create or replace function private.guard_asset_lot_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opening numeric;
  v_moved numeric;
begin
  -- Serialize movements of one lot on its row so two check-outs cannot both pass the balance check.
  select l.quantity into v_opening from app.asset_lots l where l.id = new.asset_lot_id and l.deleted_at is null for update;
  if v_opening is null then
    perform private.refuse('asset_lot_unknown', 'The lot does not exist or was archived.');
  end if;
  select coalesce(sum(m.delta), 0) into v_moved from app.asset_lot_movements m where m.asset_lot_id = new.asset_lot_id;
  if v_opening + v_moved + new.delta < 0 then
    perform private.refuse('asset_lot_insufficient', format('Only %s are on hand in this lot.', v_opening + v_moved));
  end if;
  return new;
end;
$$;
comment on function private.guard_asset_lot_movement() is 'Lot ledger: a movement never takes the quantity on hand below zero; movements of one lot serialize on the lot row.';
revoke all on function private.guard_asset_lot_movement() from public, anon, authenticated;
create trigger t45_guard_asset_lot_movement before insert on app.asset_lot_movements
  for each row execute function private.guard_asset_lot_movement();

create view app.asset_lot_balances with (security_invoker = true) as
select l.id as asset_lot_id, l.org_id, l.quantity as opening_quantity,
       l.quantity + coalesce((select sum(m.delta) from app.asset_lot_movements m where m.asset_lot_id = l.id), 0) as on_hand
from app.asset_lots l
where l.deleted_at is null;
comment on view app.asset_lot_balances is 'Quantity on hand per live lot: the opening count plus every ledger delta. Derived, never stored.';
comment on column app.asset_lot_balances.asset_lot_id is 'Lot.';
comment on column app.asset_lot_balances.org_id is 'Owning org.';
comment on column app.asset_lot_balances.opening_quantity is 'Opening count.';
comment on column app.asset_lot_balances.on_hand is 'Quantity on hand now.';
revoke all on app.asset_lot_balances from public, anon;
grant select on app.asset_lot_balances to authenticated, service_role;

-- Scan resolution helpers ---------------------------------------------------------------------------------

create type app.asset_scan_action as enum ('check-out', 'check-in', 'transfer');
comment on type app.asset_scan_action is 'What a scan does: hand gear to a person, bring it back to a place, or pass it between people.';

create or replace function private.reads_all_assets(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_capability(p_org_id, 'assets.asset.read')
    or exists (select 1 from private.project_ids_with('assets.custody.write') x
               join app.projects p on p.id = x where p.org_id = p_org_id);
$$;
comment on function private.reads_all_assets(uuid) is 'True when scans may resolve any asset of the org; external parties resolve only the gear they hold.';
revoke all on function private.reads_all_assets(uuid) from public, anon, authenticated;

-- Finds the subject a code names inside an org. Returns at most one of a unit or a lot, or the rule
-- that refused: asset_code_unknown or asset_code_ambiguous.
create or replace function private.find_asset_code(p_org_id uuid, p_code text, out o_unit_id uuid, out o_lot_id uuid, out o_rule text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text := btrim(coalesce(p_code, ''));
  v_tag text := upper(btrim(coalesce(p_code, '')));
  v_candidates text[];
  v_count integer;
begin
  if char_length(v_code) = 0 or char_length(v_code) > 200 then
    o_rule := 'asset_code_unknown';
    return;
  end if;
  if v_code ~* '^LOT:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select l.id into o_lot_id from app.asset_lots l
    where l.org_id = p_org_id and l.id = substr(v_code, 5)::uuid and l.deleted_at is null;
    if o_lot_id is null then o_rule := 'asset_code_unknown'; end if;
    return;
  end if;
  select u.id into o_unit_id from app.asset_units u
  where u.org_id = p_org_id and u.asset_tag = v_tag and u.deleted_at is null;
  if o_unit_id is not null then
    return;
  end if;
  v_candidates := array[v_code];
  if v_code ~ '^[0-9]+$' and char_length(v_code) in (8, 12, 13, 14) then
    v_candidates := v_candidates || lpad(v_code, 14, '0');
  end if;
  select count(distinct i.asset_unit_id), min(i.asset_unit_id::text)::uuid into v_count, o_unit_id
  from app.asset_identifiers i
  join app.asset_units u on u.id = i.asset_unit_id and u.deleted_at is null
  where i.org_id = p_org_id and i.value = any (v_candidates) and i.deleted_at is null;
  if v_count = 0 then
    o_unit_id := null;
    o_rule := 'asset_code_unknown';
  elsif v_count > 1 then
    o_unit_id := null;
    o_rule := 'asset_code_ambiguous';
  end if;
end;
$$;
comment on function private.find_asset_code(uuid, text) is 'Code lookup order: lot label LOT:<id>, then asset tag (trimmed and uppercased), then an external identifier value, with GTIN-8, 12 and 13 also tried as GTIN-14. Never guesses between two units.';
revoke all on function private.find_asset_code(uuid, text) from public, anon, authenticated;

-- Recounting a lot ------------------------------------------------------------------------------------------

create or replace function app.count_asset_lot(p_asset_lot_id uuid, p_counted numeric, p_note text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_on_hand numeric;
  v_id uuid;
begin
  perform private.require_person();
  select l.org_id into v_org from app.asset_lots l where l.id = p_asset_lot_id and l.deleted_at is null for update;
  if v_org is null or not private.has_capability(v_org, 'assets.asset.write') then
    raise exception using errcode = '42501', message = 'assets.asset.write is required';
  end if;
  if p_counted is null or p_counted < 0 then
    perform private.refuse('asset_lot_count_negative', 'A count is zero or more.');
  end if;
  select b.on_hand into v_on_hand from app.asset_lot_balances b where b.asset_lot_id = p_asset_lot_id;
  if p_counted = v_on_hand then
    return null;
  end if;
  insert into app.asset_lot_movements (org_id, asset_lot_id, movement_kind, delta, note)
  values (v_org, p_asset_lot_id, 'Count', p_counted - v_on_hand, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return v_id;
end;
$$;
comment on function app.count_asset_lot(uuid, numeric, text) is 'Records a recount of a lot as a Count movement of the difference; returns null when the count matches what is on hand. Needs assets.asset.write org-wide.';
revoke all on function app.count_asset_lot(uuid, numeric, text) from public, anon;
grant execute on function app.count_asset_lot(uuid, numeric, text) to authenticated, service_role;
