-- 2683_hire_views_and_warnings.sql
-- R7a Supply bridge, parity additions (RRR-183; competitor parity audit 2026-10-28, gaps G-96 and G-99). Everything
-- here is computed and never stored; warnings never refuse a line.
--
--   * app.asset_unit_hire (G-96): whether each unit is hired in and when it goes back, for the Hired in, Damaged and
--     Unavailable built-in views of the units list. A definer view (owner reads) with its own row filter on
--     assets.asset.read, like app.expense_budget_lines (1622): it shows no vendor, cost, order number or order id, so
--     an asset-only reader learns only that a unit is hired in and when it is due back.
--   * private.project_site_window and private.project_docks_full_at (G-99): the project's site window (its Build and
--     Strike records, else its dates) and whether every dock it books is taken at an instant. Both answer only for a
--     project the caller reads purchase orders on.
--   * app.po_line_hire_warnings and app.hire_window_warnings (G-99): delivery and return window conflicts of rental
--     lines, saved or not yet saved, from one rule set (private.hire_window_rules), so the form and the order page
--     agree.
--
-- Each view revokes all from public and anon, grants select to authenticated and service_role, and keeps select away
-- from xos_backup (1650).

-- G-96: hired-in units ------------------------------------------------------------------------------------------------------

-- Security definer view (owner reads) with its own row filter, like app.expense_budget_lines (1622).
create view app.asset_unit_hire as
select u.id as asset_unit_id, u.org_id,
  coalesce(l.acquisition_kind, 'Purchase'::app.acquisition_kind) as acquisition_kind,
  upper(l.hire_period) as hire_ends_at,
  coalesce(l.acquisition_kind = 'Rental' and upper(l.hire_period) <= now() and u.asset_state <> 'Returned', false) as off_hire_due
from app.asset_units u
left join app.receipt_lines rl on rl.id = u.receipt_line_id and rl.deleted_at is null
left join app.po_lines l on l.id = rl.po_line_id
where u.deleted_at is null
  and u.org_id in (select private.orgs_with_capability('assets.asset.read'));

call private.describe('app.asset_unit_hire', 'Whether each live asset unit is hired in and when it goes back (R7a, G-96), read through the unit''s receipt line and order line. Computed, never stored. Owner-rights view with its own row filter (assets.asset.read in the unit''s org): it carries no vendor, cost, order number or order id, so a reader of assets who cannot read purchase orders learns only that a unit is hired in and when it is due back. app.asset_unit_provenance has the rest for procurement readers.', array[
  'asset_unit_id', 'Asset unit.',
  'org_id', 'Org.',
  'acquisition_kind', 'Rental when the unit arrived on a rental order line; Purchase otherwise, including a unit with no receipt line.',
  'hire_ends_at', 'Rental units: when the hire ends and the unit is due back to the vendor.',
  'off_hire_due', 'True for a rental unit whose hire has ended and which has not been Returned.'
]);
revoke all on app.asset_unit_hire from public, anon;
grant select on app.asset_unit_hire to authenticated, service_role;
revoke select on app.asset_unit_hire from xos_backup;

-- G-99: the site window and the docks -------------------------------------------------------------------------------------------

create or replace function private.project_site_window(p_project_id uuid)
returns tstzrange
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_project app.projects;
  v_from timestamptz;
  v_to timestamptz;
begin
  if not private.can_on_project(p_project_id, 'procurement.po.read') then
    return null;
  end if;
  select * into v_project from app.projects p where p.id = p_project_id;
  select min(r.starts_at) into v_from from app.records r
  where r.project_id = p_project_id and r.record_kind = 'Build' and r.deleted_at is null
    and r.record_state not in ('Deferred', 'Canceled');
  select max(r.ends_at) into v_to from app.records r
  where r.project_id = p_project_id and r.record_kind = 'Strike' and r.deleted_at is null
    and r.record_state not in ('Deferred', 'Canceled');
  v_from := coalesce(v_from, v_project.starts_on::timestamp at time zone v_project.time_zone);
  v_to := coalesce(v_to, (v_project.ends_on + 1)::timestamp at time zone v_project.time_zone);
  -- A Strike recorded before the Build leaves no usable window end.
  if v_from is not null and v_to is not null and v_to < v_from then
    v_to := null;
  end if;
  return tstzrange(v_from, v_to, '[)');
end;
$$;
comment on function private.project_site_window(uuid) is 'The project''s site window (R7a, G-99): from the earliest start of its live Build records (not Deferred or Canceled), else its starts_on at 00:00 in its time zone, to the latest end of its live Strike records, else the day after its ends_on at 00:00. Either bound may be unbounded when nothing sets it. NULL unless the caller reads purchase orders on the project (procurement.po.read).';
revoke all on function private.project_site_window(uuid) from public, anon;
grant execute on function private.project_site_window(uuid) to authenticated, service_role;

create or replace function private.project_docks_full_at(p_project_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_at is not null
    and private.can_on_project(p_project_id, 'procurement.po.read')
    and exists (select 1 from app.dock_slots d where d.project_id = p_project_id and d.deleted_at is null)
    and not exists (
      select 1 from (select distinct d.zone_id from app.dock_slots d where d.project_id = p_project_id and d.deleted_at is null) z
      where not exists (
        select 1 from app.dock_slots s
        where s.zone_id = z.zone_id and s.deleted_at is null and s.starts_at <= p_at and s.ends_at > p_at));
$$;
comment on function private.project_docks_full_at(uuid, timestamptz) is 'True when the project books dock slots and every dock zone it books has a live slot covering the instant, so a delivery or collection then finds no free dock (R7a, G-99). False unless the caller reads purchase orders on the project (procurement.po.read).';
revoke all on function private.project_docks_full_at(uuid, timestamptz) from public, anon;
grant execute on function private.project_docks_full_at(uuid, timestamptz) to authenticated, service_role;

create or replace function private.hire_window_rules(p_project_id uuid, p_hire tstzrange, p_site_window tstzrange)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select w.warning from (values
    (1, 'Delivery After Load In', lower(p_hire) > lower(p_site_window)),
    (2, 'Return Before Load Out', upper(p_hire) < upper(p_site_window)),
    (3, 'Hire Beyond Site Window', lower(p_hire) < lower(p_site_window) - interval '1 day'
                                   or upper(p_hire) > upper(p_site_window) + interval '1 day'),
    (4, 'Delivery Docks Full', private.project_docks_full_at(p_project_id, lower(p_hire))),
    (5, 'Return Docks Full', private.project_docks_full_at(p_project_id, upper(p_hire)))
  ) w (ord, warning, applies)
  where w.applies
  order by w.ord;
$$;
comment on function private.hire_window_rules(uuid, tstzrange, tstzrange) is 'The delivery and return window rules of a hire period against a site window, in a fixed order (R7a, G-99). A rule whose site-window bound is NULL (unbounded) gives no warning. The dock rules answer only for a caller who reads purchase orders on the project.';
revoke all on function private.hire_window_rules(uuid, tstzrange, tstzrange) from public, anon;
grant execute on function private.hire_window_rules(uuid, tstzrange, tstzrange) to authenticated, service_role;

-- G-99: warnings on saved rental lines --------------------------------------------------------------------------------------------

create view app.po_line_hire_warnings with (security_invoker = on) as
select x.po_line_id, x.org_id, x.project_id, x.purchase_order_id, x.hire_period, x.site_window, w.warning
from (
  select l.id as po_line_id, l.org_id, po.project_id, l.purchase_order_id, l.hire_period,
    private.project_site_window(po.project_id) as site_window
  from app.po_lines l
  join app.purchase_orders po on po.id = l.purchase_order_id and po.deleted_at is null and po.po_state <> 'Canceled'
  where l.deleted_at is null and l.acquisition_kind = 'Rental'
) x
cross join lateral private.hire_window_rules(x.project_id, x.hire_period, x.site_window) w (warning);

call private.describe('app.po_line_hire_warnings', 'Delivery and return window conflicts of live rental lines on orders that are not Canceled (R7a, G-99), one row per warning: Delivery After Load In (the hire starts after the site window opens), Return Before Load Out (it ends before the window closes), Hire Beyond Site Window (it starts more than a day before or ends more than a day after the window), Delivery Docks Full and Return Docks Full (every dock the project books is taken at the hire''s start or end). A NULL (unbounded) site-window bound gives no warning for the rules that use it. Warnings never refuse a line. Computed, never stored; runs as the reader, so procurement''s row level security applies.', array[
  'po_line_id', 'Rental purchase order line.',
  'org_id', 'Org.',
  'project_id', 'Project of the order.',
  'purchase_order_id', 'Purchase order.',
  'hire_period', 'When the hire starts and ends.',
  'site_window', 'The project''s site window (private.project_site_window).',
  'warning', 'Which window rule the line breaks.'
]);
revoke all on app.po_line_hire_warnings from public, anon;
grant select on app.po_line_hire_warnings to authenticated, service_role;
revoke select on app.po_line_hire_warnings from xos_backup;

-- G-99: warnings on a line being entered -----------------------------------------------------------------------------------------

create or replace function app.hire_window_warnings(p_project_id uuid, p_hire_from timestamptz, p_hire_to timestamptz)
returns setof text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_project_id is null or not private.can_on_project(p_project_id, 'procurement.po.read') then
    raise exception using errcode = '42501', message = 'procurement.po.read is required on the project';
  end if;
  if p_hire_from is null or p_hire_to is null or p_hire_to <= p_hire_from then
    perform private.refuse('hire_period_order', 'A hire ends after it starts.');
  end if;
  return query select r from private.hire_window_rules(p_project_id, tstzrange(p_hire_from, p_hire_to, '[)'),
    private.project_site_window(p_project_id)) r;
end;
$$;
comment on function app.hire_window_warnings(uuid, timestamptz, timestamptz) is 'The delivery and return window warnings a rental line with this hire would raise on the project, before it is saved (R7a, G-99): the same rules as app.po_line_hire_warnings. Needs procurement.po.read on the project; refuses a hire that does not end after it starts (hire_period_order). Warnings never refuse the line itself.';
revoke all on function app.hire_window_warnings(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function app.hire_window_warnings(uuid, timestamptz, timestamptz) to authenticated, service_role;
