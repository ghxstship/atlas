-- 3021_budget_versions.sql
-- B13 (RRR-237, gap G-210 first half; Section 4.2 Finance, ADR 0152). Budget versions: a frozen copy of a budget's
-- plan at a moment, to compare with the live budget or another version, and the frozen basis of a sent quote (3023).
--
--   * app.budget_versions: one capture of a budget, numbered per budget, with a label and a purpose. Snapshot is a
--     person's own capture and can go to Trash; Quote is the capture a sent quote prices from and can never be
--     deleted (budget_version_in_use). Every column but deleted_at is fixed (budget_version_immutable). Soft delete
--     and Trash's restore are an UPDATE of deleted_at as the caller (1031), so authenticated holds only that column.
--   * app.budget_version_lines: the lines at capture, append-only (the document_versions pattern, 0353). Plan fields
--     only, with the effective markup and client price of 3020 frozen beside them. Actual and committed are never
--     frozen: a definer-written copy of committed would leak past P4's procurement.po.read withholding (2810).
--   * app.snapshot_budget(p_budget_id, p_label): Take snapshot, for finance.budget.write on the budget's project.
--     private.capture_budget_version holds the body, which the quote send of 3023 calls with purpose Quote.
--   * app.budget_version_totals: per version, NULL-aware as app.budget_totals (0321).
-- Trash: app.budget_versions is in (titled by label); app.budget_version_lines is an Age ledger and never a candidate.

-- 1. Purpose -----------------------------------------------------------------------------------------------------------

create type app.budget_version_purpose as enum ('Snapshot', 'Quote');
comment on type app.budget_version_purpose is 'Why a budget version was captured: Snapshot (a person''s capture, to compare; can go to Trash) or Quote (the frozen basis of a sent quote version; never deleted).';

-- 2. Budget versions ---------------------------------------------------------------------------------------------------

create table app.budget_versions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  budget_id uuid not null references app.budgets (id),
  version_number bigint not null,
  label text not null,
  purpose app.budget_version_purpose not null,
  currency_code char(3) not null references private.currencies (currency_code),
  deleted_at timestamptz,
  constraint budget_versions_label_length check (label = btrim(label) and char_length(label) between 1 and 120)
);

create unique index budget_versions_number_key on app.budget_versions (budget_id, version_number);
create index budget_versions_currency_code_idx on app.budget_versions (currency_code);

call private.install_domain_table('app.budget_versions', 'app.budgets', 'budget_id');
call private.describe('app.budget_versions', 'Frozen captures of a budget''s plan (G-210, ADR 0152): a Snapshot to compare with the live budget or another version, or the Quote capture a sent quote version prices from. Written only by app.snapshot_budget and the quote send; every column but deleted_at is fixed, and a Quote capture is never deleted.', array[
  'budget_id', 'Budget captured.',
  'version_number', 'Number of the capture within its budget, issued on insert from the budget''s own sequence and never changed.',
  'label', 'What the capture is called, 1 to 120 characters, trimmed. A quote capture is labelled with the quote key and version.',
  'purpose', 'Snapshot or Quote. A Quote capture backs a sent quote and is never deleted (budget_version_in_use).',
  'currency_code', 'Currency of the budget at capture, the currency of every frozen amount of the version.'
]);

create or replace function private.guard_budget_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not private.in_trusted_operation('budget_capture') then
      perform private.refuse('budget_version_capture_only', 'A budget version is taken with Take snapshot or when a quote is sent.');
    end if;
    new.version_number := private.next_sequence(new.org_id, 'budget:' || new.budget_id::text);
    new.currency_code := (select b.currency_code from app.budgets b where b.id = new.budget_id);
    return new;
  end if;
  if new.budget_id <> old.budget_id or new.version_number <> old.version_number or new.label <> old.label
     or new.purpose <> old.purpose or new.currency_code <> old.currency_code then
    perform private.refuse('budget_version_immutable', 'A budget version never changes; take a new snapshot instead.');
  end if;
  if new.deleted_at is distinct from old.deleted_at and old.purpose = 'Quote' then
    perform private.refuse('budget_version_in_use', 'This version backs a sent quote, so it is kept.');
  end if;
  return new;
end;
$$;
comment on function private.guard_budget_version() is 'Budget versions: inserted only inside the budget_capture operation, numbered from the budget''s sequence with the budget''s currency; afterwards every column but deleted_at is fixed (budget_version_immutable), and a Quote capture is neither deleted nor restored (budget_version_in_use).';
revoke all on function private.guard_budget_version() from public, anon, authenticated;
create trigger t40_guard_budget_version before insert or update on app.budget_versions
  for each row execute function private.guard_budget_version();

call private.install_policies('app.budget_versions',
  $$budget_id in (select b.id from app.budgets b where b.project_id in (select private.project_ids_with('finance.budget.read')))$$,
  $$budget_id in (select b.id from app.budgets b where b.project_id in (select private.project_ids_with('finance.budget.write')))$$);
-- Only a soft delete and Trash's restore reach the table directly; the capture RPCs write the rest.
drop policy budget_versions_insert on app.budget_versions;
revoke insert, update on app.budget_versions from authenticated;
grant update (deleted_at) on app.budget_versions to authenticated;
call private.install_default_retention('app.budget_versions');
call private.install_audit_trail('app.budget_versions');

-- 3. Frozen lines ------------------------------------------------------------------------------------------------------

create table app.budget_version_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  budget_version_id uuid not null references app.budget_versions (id),
  budget_line_id uuid not null references app.budget_lines (id),
  line_number integer not null,
  description text not null,
  line_type app.budget_line_type not null,
  urid text not null,
  cost_center_id uuid references app.cost_centers (id),
  grade_code text,
  element_id text,
  phase_code text,
  tier_code text,
  quantity numeric not null,
  unit_basis text,
  unit_price_minor bigint,
  effective_markup_bp integer,
  client_unit_price_minor bigint,
  excluded_from_quote boolean not null,
  xyz xpms.xyz_tag not null,
  xyz_basis app.xyz_basis not null,
  deleted_at timestamptz
);

create index budget_version_lines_version_number_idx on app.budget_version_lines (budget_version_id, line_number);
create index budget_version_lines_budget_line_id_idx on app.budget_version_lines (budget_line_id);
create index budget_version_lines_cost_center_id_idx on app.budget_version_lines (cost_center_id);

call private.install_domain_table('app.budget_version_lines', 'app.budget_versions', 'budget_version_id',
  array['app.budget_lines', 'budget_line_id', 'app.cost_centers', 'cost_center_id'], true);
call private.describe('app.budget_version_lines', 'The lines of a budget version as they stood at capture: plan fields with the effective markup and client price of app.budget_line_prices frozen beside them. Append-only; actual and committed are never frozen (ADR 0152).', array[
  'budget_version_id', 'Version the line belongs to.',
  'budget_line_id', 'Live line the copy was taken from; lines are only ever soft-deleted, so it always resolves.',
  'line_number', 'Line number at capture.',
  'description', 'Description at capture.',
  'line_type', 'Cost, Labor, Fee or Contingency at capture.',
  'urid', 'Canon discipline or category at capture.',
  'cost_center_id', 'Cost center at capture.',
  'grade_code', 'Price grade at capture.',
  'element_id', 'Catalog element at capture.',
  'phase_code', 'Gated phase at capture.',
  'tier_code', 'Tier of experience at capture.',
  'quantity', 'Quantity at capture.',
  'unit_basis', 'Unit of the quantity at capture.',
  'unit_price_minor', 'Cost unit price at capture in minor units of the version''s currency; NULL is unpriced.',
  'effective_markup_bp', 'Markup in force at capture in basis points (the line''s, else the budget''s default); NULL when none was. Not the line''s own markup setting.',
  'client_unit_price_minor', 'Client unit price in force at capture (the override, else the marked-up cost price); NULL when unpriced. Not the line''s override setting.',
  'excluded_from_quote', 'True when the line was internal and off the quote at capture.',
  'xyz', 'XYZ tag at capture.',
  'xyz_basis', 'Basis of the XYZ tag at capture.'
]);

call private.install_policies('app.budget_version_lines',
  $$budget_version_id in (select v.id from app.budget_versions v join app.budgets b on b.id = v.budget_id
    where b.project_id in (select private.project_ids_with('finance.budget.read')))$$);
revoke insert, update, delete on app.budget_version_lines from authenticated;
call private.install_default_retention('app.budget_version_lines');

-- 4. Capture -----------------------------------------------------------------------------------------------------------

create or replace function private.capture_budget_version(p_budget_id uuid, p_label text, p_purpose app.budget_version_purpose)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_budget app.budgets;
  v_id uuid;
begin
  select * into v_budget from app.budgets b where b.id = p_budget_id and b.deleted_at is null;
  if v_budget.id is null then
    perform private.refuse('budget_not_found', 'This budget no longer exists.');
  end if;
  perform private.begin_trusted_operation('budget_capture');
  insert into app.budget_versions (budget_id, label, purpose, version_number, currency_code)
  values (p_budget_id, left(btrim(p_label), 120), p_purpose, 0, v_budget.currency_code)
  returning id into v_id;
  insert into app.budget_version_lines (budget_version_id, budget_line_id, line_number, description, line_type, urid,
    cost_center_id, grade_code, element_id, phase_code, tier_code, quantity, unit_basis, unit_price_minor,
    effective_markup_bp, client_unit_price_minor, excluded_from_quote, xyz, xyz_basis)
  select v_id, bl.id, bl.line_number, bl.description, bl.line_type, bl.urid, bl.cost_center_id, bl.grade_code,
    bl.element_id, bl.phase_code, bl.tier_code, bl.quantity, bl.unit_basis, bl.unit_price_minor,
    p.effective_markup_bp, p.client_unit_price_minor, bl.excluded_from_quote, bl.xyz, bl.xyz_basis
  from app.budget_lines bl
  join app.budget_line_prices p on p.budget_line_id = bl.id
  where bl.budget_id = p_budget_id and bl.deleted_at is null;
  perform private.end_trusted_operation('budget_capture');
  return v_id;
end;
$$;
comment on function private.capture_budget_version(uuid, text, app.budget_version_purpose) is 'Captures a live budget as a version of the given purpose in one statement: every live line with its effective markup and client price (app.budget_line_prices). Callers authorize first; app.snapshot_budget and the quote send (3023) call it. Returns the version id.';
revoke all on function private.capture_budget_version(uuid, text, app.budget_version_purpose) from public, anon, authenticated;

create or replace function app.snapshot_budget(p_budget_id uuid, p_label text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select b.project_id from app.budgets b where b.id = p_budget_id and b.deleted_at is null);
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, 'finance.budget.write') then
    raise exception using errcode = '42501', message = 'finance.budget.write is required on the budget''s project';
  end if;
  if p_label is null or char_length(btrim(p_label)) not between 1 and 120 then
    perform private.refuse('budget_version_label', 'Name the snapshot in 1 to 120 characters.');
  end if;
  return private.capture_budget_version(p_budget_id, p_label, 'Snapshot');
end;
$$;
comment on function app.snapshot_budget(uuid, text) is 'Take snapshot (G-210): captures a live budget as a Snapshot version with its lines, effective markups and client prices frozen. Needs finance.budget.write on the budget''s project; the label runs 1 to 120 characters (budget_version_label). Returns the version id.';
revoke all on function app.snapshot_budget(uuid, text) from public, anon;
grant execute on function app.snapshot_budget(uuid, text) to authenticated, service_role;

-- 5. Totals ------------------------------------------------------------------------------------------------------------

create view app.budget_version_totals with (security_invoker = true) as
select v.id as budget_version_id, v.budget_id, v.currency_code,
  count(l.id)::integer as line_count,
  count(l.id) filter (where l.unit_price_minor is null)::integer as unpriced_count,
  coalesce(sum(private.extended_minor(l.quantity, l.unit_price_minor)), 0)::bigint as priced_total_minor,
  case when count(l.id) filter (where l.unit_price_minor is null) > 0 then null
       else coalesce(sum(private.extended_minor(l.quantity, l.unit_price_minor)), 0) end::bigint as total_minor,
  case when count(l.id) filter (where not l.excluded_from_quote) = 0
         or count(l.id) filter (where not l.excluded_from_quote and l.client_unit_price_minor is null) > 0 then null
       else coalesce(sum(private.extended_minor(l.quantity, l.client_unit_price_minor)) filter (where not l.excluded_from_quote), 0)
  end::bigint as client_total_minor,
  count(l.id) filter (where not l.excluded_from_quote and l.client_unit_price_minor is null)::integer as client_unpriced_count,
  case when count(l.id) filter (where not l.excluded_from_quote) = 0
         or count(l.id) filter (where not l.excluded_from_quote
                                  and (l.client_unit_price_minor is null or l.unit_price_minor is null)) > 0 then null
       else coalesce(sum(private.extended_minor(l.quantity, l.client_unit_price_minor)
                          - private.extended_minor(l.quantity, l.unit_price_minor)) filter (where not l.excluded_from_quote), 0)
  end::bigint as margin_minor
from app.budget_versions v
left join app.budget_version_lines l on l.budget_version_id = v.id
where v.deleted_at is null
group by v.id, v.budget_id, v.currency_code;

call private.describe('app.budget_version_totals', 'Totals of a live budget version, NULL-aware as app.budget_totals (0321): the cost total is NULL while any line is unpriced; the client total and margin cover the lines that were on quotes and are NULL while any of them has no client price (or no cost price, for the margin).', array[
  'budget_version_id', 'Budget version.',
  'budget_id', 'Budget captured.',
  'currency_code', 'Currency of the version.',
  'line_count', 'Lines captured.',
  'unpriced_count', 'Lines captured without a cost price.',
  'priced_total_minor', 'Sum of the extended amounts of the priced lines.',
  'total_minor', 'Sum of every extended amount; NULL while any line is unpriced.',
  'client_total_minor', 'Sum of the client amounts of the lines on quotes; NULL while any is unpriced or none is on quotes.',
  'client_unpriced_count', 'Lines on quotes without a client price.',
  'margin_minor', 'Client total less the cost total of the lines on quotes; NULL whenever either is unknown.'
]);

revoke all on app.budget_version_totals from public, anon;
grant select on app.budget_version_totals to authenticated, service_role;
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'xos_backup') then
    revoke select on app.budget_version_totals from xos_backup;
  end if;
end;
$$;

select private.sync_trash_tables();
