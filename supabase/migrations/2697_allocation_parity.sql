-- 2697_allocation_parity.sql
-- R7 Allocations, Atlas side (RRR-187), the parity additions of the competitor audit (owner-approved 2026-10-28,
-- gaps G-174, G-91 and G-93). The overflow rule itself lives in the definitions of 2693 (private.check_allocation_caps,
-- app.request_allocation, app.assign_allocation and app.decide_allocation) and the capacity rule in 2691
-- (private.asset_class_capacity); this file adds only new objects, and recreates nothing.
--
--   1. The setting advancing.allowance_overflow (packages/schemas/settings/r7.yaml): refuse, the default, or review.
--   2. app.allocation_allowances: per offering, the cap, what is requested and approved under it, what remains and
--      what goes beyond, for the engagement's pool and for each person on its roster (G-174).
--   3. app.allocation_radio_channels: the radio channels a radio allocation is programmed with, set as a whole by
--      app.set_allocation_radio_channels (G-91). Channel numbers are joined, never copied. app.radio_channels is
--      readable only with safety.incident.read (0353), so app.project_radio_channels and app.radio_handout read the
--      channels for advancing, each under its own gate; the radio hand-out document reads app.radio_handout.
--   4. app.asset_class_availability: how many of a class are free over a window, with the unit of its element (G-93).
--   5. app.asset_reservation_conflicts: live holds that no longer fit what the class, lot or order can supply now,
--      computed and never stored (G-93).

-- 1. Settings: pasted from `pnpm --filter @xos/schemas settings:sql r7` -----------------------------------------------------

select private.define_setting('advancing.allowance_overflow', 'Choice', 'projects.settings.write', array['organization', 'project'], true, p_default_text => 'refuse', p_choices => array['refuse', 'review']);

-- 2. Remaining allowance -------------------------------------------------------------------------------------------------------

create or replace function app.allocation_allowances(p_engagement_id uuid)
returns table (
  offering app.offering_kind,
  roster_entry_id uuid,
  mode text,
  cap numeric,
  requested numeric,
  approved numeric,
  remaining numeric,
  beyond numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_all boolean;
  v_own uuid[];
begin
  perform private.require_person();
  select e.* into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null then
    raise exception using errcode = '42501', message = 'the engagement is not readable';
  end if;
  v_all := private.can_on_project(v_engagement.project_id, 'advancing.packet.read') or private.can_advance_engagement(v_engagement.id);
  if not v_all then
    select array_agg(r.id) into v_own from app.engagement_roster_entries r
    where r.engagement_id = v_engagement.id and r.id in (select private.my_roster_entry_ids('roster'));
    if v_own is null then
      raise exception using errcode = '42501', message = 'the engagement is not readable';
    end if;
  end if;
  return query
    with offers as (
      select o.offering, o.offering_mode, o.cap_per_engagement, o.cap_per_person
      from private.effective_offerings(v_engagement.id) o where o.offering_mode <> 'Not Offered'
    ),
    live as (
      select a.roster_entry_id, private.allocation_offering_kind(a) as offering, a.allocation_state, a.quantity
      from app.advance_allocations a
      where a.deleted_at is null and a.allocation_state in ('Requested', 'Approved')
        and (a.engagement_id = v_engagement.id
          or a.roster_entry_id in (select r.id from app.engagement_roster_entries r where r.engagement_id = v_engagement.id))
    ),
    rows_ as (
      select f.offering, null::uuid as roster_entry_id, f.offering_mode::text as mode, f.cap_per_engagement::numeric as cap,
        coalesce((select sum(l.quantity) from live l where l.offering = f.offering and l.allocation_state = 'Requested'), 0) as requested,
        coalesce((select sum(l.quantity) from live l where l.offering = f.offering and l.allocation_state = 'Approved'), 0) as approved
      from offers f
      where v_all
      union all
      select f.offering, r.id, f.offering_mode::text, f.cap_per_person::numeric,
        coalesce((select sum(l.quantity) from live l where l.offering = f.offering and l.roster_entry_id = r.id
                  and l.allocation_state = 'Requested'), 0),
        coalesce((select sum(l.quantity) from live l where l.offering = f.offering and l.roster_entry_id = r.id
                  and l.allocation_state = 'Approved'), 0)
      from offers f
      cross join app.engagement_roster_entries r
      where r.engagement_id = v_engagement.id and r.deleted_at is null and r.entry_state <> 'Withdrawn'
        and (v_all or r.id = any (v_own))
    )
    select x.offering, x.roster_entry_id, x.mode, x.cap, x.requested, x.approved,
      case when x.cap is null then null else greatest(x.cap - x.requested - x.approved, 0) end,
      case when x.cap is null then null else greatest(x.requested + x.approved - x.cap, 0) end
    from rows_ x
    order by x.offering, x.roster_entry_id nulls first;
end;
$$;
comment on function app.allocation_allowances(uuid) is 'The remaining allowance of an engagement''s offerings (G-174): one row per offered offering for the pool (cap_per_engagement, roster_entry_id NULL) and one per live roster entry and offering (cap_per_person), with the live Requested and Approved quantities under the engagement and its entries, or under the entry; remaining is the cap less both, never below 0, and beyond the excess; both NULL when there is no cap. Read by advancing.packet.read on the project and the party side (private.can_advance_engagement); a person on the roster reads only their own entry''s rows; anyone else gets 42501.';
revoke all on function app.allocation_allowances(uuid) from public, anon;
grant execute on function app.allocation_allowances(uuid) to authenticated, service_role;

-- 3. Radio channels per allocation ------------------------------------------------------------------------------------------------

create table app.allocation_radio_channels (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  advance_allocation_id uuid not null references app.advance_allocations (id),
  radio_channel_id uuid not null references app.radio_channels (id),
  deleted_at timestamptz
);
create index allocation_radio_channels_advance_allocation_id_idx on app.allocation_radio_channels (advance_allocation_id);
create index allocation_radio_channels_radio_channel_id_idx on app.allocation_radio_channels (radio_channel_id);
create unique index allocation_radio_channels_live_key on app.allocation_radio_channels (advance_allocation_id, radio_channel_id)
  where deleted_at is null;

call private.install_domain_table('app.allocation_radio_channels', 'app.advance_allocations', 'advance_allocation_id',
  array['app.radio_channels', 'radio_channel_id']);
call private.describe('app.allocation_radio_channels', 'The radio channels a radio allocation is programmed with (G-91), linked to the project''s channels and never copied. Set as a whole by app.set_allocation_radio_channels, which soft-deletes the links it drops.', array[
  'advance_allocation_id', 'Radio allocation, a party''s pool or one person''s share.',
  'radio_channel_id', 'Channel of the allocation''s project.'
]);
call private.install_policies('app.allocation_radio_channels',
  $$advance_allocation_id in (select a.id from app.advance_allocations a where a.project_id in (select private.project_ids_with('advancing.packet.read')))$$);
revoke insert, update, delete on app.allocation_radio_channels from authenticated;
call private.install_default_retention('app.allocation_radio_channels');
call private.install_audit_trail('app.allocation_radio_channels');

create or replace function private.guard_allocation_radio_channel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allocation app.advance_allocations;
begin
  if tg_op = 'UPDATE' then
    if new.advance_allocation_id <> old.advance_allocation_id or new.radio_channel_id <> old.radio_channel_id
       or (old.deleted_at is not null and new.deleted_at is null) then
      perform private.refuse('allocation_channel_immutable', 'A channel link is set again through the allocation''s channels.');
    end if;
    return new;
  end if;
  select a.* into v_allocation from app.advance_allocations a where a.id = new.advance_allocation_id;
  if v_allocation.asset_class_id is null then
    perform private.refuse('allocation_channel_not_asset', 'Only an asset allocation is programmed with radio channels.');
  end if;
  if (select c.offering from app.asset_classes c where c.id = v_allocation.asset_class_id) is distinct from 'Radios' then
    perform private.refuse('allocation_channel_not_radio', 'Only radios are programmed with channels.');
  end if;
  if not exists (select 1 from app.radio_channels r
                 where r.id = new.radio_channel_id and r.project_id = v_allocation.project_id and r.deleted_at is null) then
    perform private.refuse('allocation_channel_project', 'A radio is programmed with channels of its own project.');
  end if;
  if v_allocation.allocation_state in ('Declined', 'Withdrawn') or v_allocation.deleted_at is not null then
    perform private.refuse('allocation_channel_state', 'A declined or withdrawn allocation takes no channels.');
  end if;
  return new;
end;
$$;
comment on function private.guard_allocation_radio_channel() is 'Allocation radio channels: a new link names an asset allocation (allocation_channel_not_asset) of the Radios class (allocation_channel_not_radio), a live channel of the allocation''s project (allocation_channel_project), and an allocation that is not Declined or Withdrawn (allocation_channel_state). A link is only soft-deleted afterwards, never moved or restored.';
revoke all on function private.guard_allocation_radio_channel() from public, anon, authenticated;
create trigger t40_guard_allocation_radio_channel before insert or update on app.allocation_radio_channels
  for each row execute function private.guard_allocation_radio_channel();

insert into private.trash_excluded_tables (table_name, rationale) values
  ('allocation_radio_channels', 'Channel links are replaced as a set through app.set_allocation_radio_channels; a restored single row would bypass that.')
on conflict (table_name) do nothing;

create or replace function private.can_program_radios(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_on_project(p_project_id, 'advancing.packet.write') or private.can_on_project(p_project_id, 'safety.radio_channel.write');
$$;
comment on function private.can_program_radios(uuid) is 'True when the signed-in person may set the channels of a project''s radio allocations: advancing.packet.write or safety.radio_channel.write on the project.';
revoke all on function private.can_program_radios(uuid) from public, anon, authenticated;

create or replace function app.set_allocation_radio_channels(p_allocation_id uuid, p_radio_channel_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_allocation app.advance_allocations;
  v_ids uuid[] := array(select distinct x from unnest(coalesce(p_radio_channel_ids, '{}')) x where x is not null);
begin
  perform private.require_person();
  select a.* into v_allocation from app.advance_allocations a where a.id = p_allocation_id and a.deleted_at is null for update;
  if v_allocation.id is null or not private.can_program_radios(v_allocation.project_id) then
    raise exception using errcode = '42501', message = 'advancing.packet.write or safety.radio_channel.write is required';
  end if;
  if cardinality(v_ids) > 16 then
    perform private.refuse('allocation_channel_count', 'A radio is programmed with 0 to 16 channels.');
  end if;
  update app.allocation_radio_channels set deleted_at = now()
  where advance_allocation_id = v_allocation.id and deleted_at is null and not (radio_channel_id = any (v_ids));
  insert into app.allocation_radio_channels (advance_allocation_id, radio_channel_id)
  select v_allocation.id, x from unnest(v_ids) x
  where not exists (select 1 from app.allocation_radio_channels c
                    where c.advance_allocation_id = v_allocation.id and c.radio_channel_id = x and c.deleted_at is null);
end;
$$;
comment on function app.set_allocation_radio_channels(uuid, uuid[]) is 'Sets the radio channels of a radio allocation as a whole (G-91): advancing.packet.write or safety.radio_channel.write on the project, else 42501; 0 to 16 distinct channels (allocation_channel_count). Soft-deletes the live links not in the set and adds the new ones; the link guard refuses a channel of another project, an allocation that is not a radio, and one that is Declined or Withdrawn.';
revoke all on function app.set_allocation_radio_channels(uuid, uuid[]) from public, anon;
grant execute on function app.set_allocation_radio_channels(uuid, uuid[]) to authenticated, service_role;

create or replace function app.project_radio_channels(p_project_id uuid)
returns table (id uuid, channel_number integer, name text, zone_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if not private.can_program_radios(p_project_id) then
    raise exception using errcode = '42501', message = 'advancing.packet.write or safety.radio_channel.write is required';
  end if;
  return query select r.id, r.channel_number, r.name, r.zone_id from app.radio_channels r
    where r.project_id = p_project_id and r.deleted_at is null order by r.channel_number, r.name;
end;
$$;
comment on function app.project_radio_channels(uuid) is 'A project''s radio channels for programming radio allocations (G-91), for advancing.packet.write or safety.radio_channel.write on the project: app.radio_channels itself is read only with safety.incident.read (0353). Ordered by channel number.';
revoke all on function app.project_radio_channels(uuid) from public, anon;
grant execute on function app.project_radio_channels(uuid) to authenticated, service_role;

create or replace function app.radio_handout(p_project_id uuid)
returns table (
  allocation_id uuid,
  roster_entry_id uuid,
  person_name text,
  party_name text,
  class_name text,
  quantity numeric,
  tags_issued text[],
  channel_numbers integer[],
  channel_names text[],
  display_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if not private.can_on_project(p_project_id, 'advancing.packet.read') then
    raise exception using errcode = '42501', message = 'advancing.packet.read is required';
  end if;
  return query
    select s.allocation_id, s.roster_entry_id,
      coalesce(h.holder_name, ''), coalesce(h.party_name, ''), coalesce(s.item_name, ''), s.quantity,
      coalesce((select array_agg(distinct u.asset_tag order by u.asset_tag)
                from app.asset_custody c
                join app.asset_reservations r on r.id = c.reservation_id
                join app.asset_units u on u.id = c.asset_unit_id
                where r.advance_allocation_id = s.allocation_id
                  and not exists (select 1 from app.asset_custody l where l.asset_unit_id = c.asset_unit_id
                                  and (l.created_at, l.id) > (c.created_at, c.id)
                                  and l.custodian_membership_id is null and l.custodian_engagement_id is null)), '{}'),
      coalesce((select array_agg(rc.channel_number order by rc.channel_number, rc.name)
                from app.allocation_radio_channels x join app.radio_channels rc on rc.id = x.radio_channel_id
                where x.advance_allocation_id = s.allocation_id and x.deleted_at is null), '{}'),
      coalesce((select array_agg(rc.name order by rc.channel_number, rc.name)
                from app.allocation_radio_channels x join app.radio_channels rc on rc.id = x.radio_channel_id
                where x.advance_allocation_id = s.allocation_id and x.deleted_at is null), '{}'),
      s.display_status
    from app.advance_allocation_status s
    join app.asset_classes k on k.id = (select a.asset_class_id from app.advance_allocations a where a.id = s.allocation_id)
    left join app.allocation_holders h on h.project_id = s.project_id
      and h.roster_entry_id is not distinct from s.roster_entry_id
      and h.engagement_id = coalesce(s.holder_engagement_id, (select r.engagement_id from app.engagement_roster_entries r where r.id = s.roster_entry_id))
    where s.project_id = p_project_id and k.offering = 'Radios' and s.allocation_state = 'Approved' and s.quantity > 0
    order by coalesce(h.party_name, ''), coalesce(h.holder_name, ''), s.allocation_id;
end;
$$;
comment on function app.radio_handout(uuid) is 'The radio hand-out of a project (G-91): every Approved radio allocation with quantity left, with the person (or the party for a pool), the party, the class, the tags issued and still out, the channel numbers and names it is programmed with, and its status, sorted by party, then person. Needs advancing.packet.read on the project, else 42501; it reads channels through the allocation links, so coordinators without safety.incident.read see them. The radio-handout document and the allocations page read it.';
revoke all on function app.radio_handout(uuid) from public, anon;
grant execute on function app.radio_handout(uuid) to authenticated, service_role;

-- 4. Availability ---------------------------------------------------------------------------------------------------------------------

create or replace function app.asset_class_availability(p_asset_class_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  serviceable_units integer,
  lot_quantity numeric,
  on_order_quantity numeric,
  total numeric,
  peak_reserved numeric,
  available numeric,
  unit_basis text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_class app.asset_classes;
  v_window tstzrange;
begin
  perform private.require_person();
  select c.* into v_class from app.asset_classes c where c.id = p_asset_class_id and c.deleted_at is null;
  if v_class.id is null or not (private.has_capability(v_class.org_id, 'assets.asset.read')
       or exists (select 1 from private.project_ids_with('advancing.packet.read') x
                  join app.projects p on p.id = x where p.org_id = v_class.org_id)) then
    raise exception using errcode = '42501', message = 'assets.asset.read or advancing.packet.read is required';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    perform private.refuse('availability_window', 'Ask for a window from a start to a later end, at most 400 days long.');
  end if;
  v_window := tstzrange(p_from, p_to, '[)');
  return query
    select c.serviceable_units, c.lot_quantity, c.on_order_quantity,
      c.serviceable_units + c.lot_quantity + c.on_order_quantity,
      private.asset_reservation_peak(v_class.id, v_window, 'all', null),
      greatest(c.serviceable_units + c.lot_quantity + c.on_order_quantity - private.asset_reservation_peak(v_class.id, v_window, 'all', null), 0),
      e.unit_basis::text
    from private.asset_class_capacity(v_class.id, v_window) c
    cross join xpms.elements e
    where e.element_id = v_class.element_id;
end;
$$;
comment on function app.asset_class_availability(uuid, timestamptz, timestamptz) is 'How many of an asset class are free over a window (G-93): the class capacity (private.asset_class_capacity: serviceable owned units, owned lot quantity, quantity on order that covers the window) and its total, the peak held at once over [p_from, p_to) (private.asset_reservation_peak), and available, the total less that peak, never below 0, in the unit basis of the class element, so linear stock reads in its unit. For assets.asset.read in the class''s org or advancing.packet.read on one of its projects, else 42501; a window that runs backwards or beyond 400 days refuses availability_window.';
revoke all on function app.asset_class_availability(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function app.asset_class_availability(uuid, timestamptz, timestamptz) to authenticated, service_role;

-- 5. Conflicts -------------------------------------------------------------------------------------------------------------------------

-- The row filter sits in the holds, so every branch of the union keeps it.
create view app.asset_reservation_conflicts as
select c.* from (
  with holds as (
    select r.id as reservation_id, r.advance_allocation_id as allocation_id, r.org_id, r.project_id, a.asset_class_id,
      r.asset_unit_id, r.asset_lot_id, r.po_line_id, r.quantity, a.needed_during,
      case when r.asset_lot_id is not null then private.lot_reservation_issued(r.id)
           else private.unit_reservation_issued(r.id, null) end as issued
    from app.asset_reservations r
    join app.advance_allocations a on a.id = r.advance_allocation_id
    where r.released_at is null and r.deleted_at is null and a.deleted_at is null and a.allocation_state = 'Approved'
      and upper(a.needed_during) > now()
      and (r.project_id in (select private.project_ids_with('advancing.packet.read'))
        or r.org_id in (select private.orgs_with_capability('assets.asset.read')))
  ),
  open_holds as (
    select h.*, k.serviceable_units, k.lot_quantity, k.on_order_quantity
    from holds h
    cross join lateral private.asset_class_capacity(h.asset_class_id, h.needed_during) k
    where h.issued < h.quantity
  )
  select h.reservation_id, h.allocation_id, h.org_id, h.project_id, h.asset_class_id, h.asset_unit_id, h.asset_lot_id, h.po_line_id,
    h.quantity, h.needed_during, 'Unit Unavailable'::text as conflict
  from open_holds h join app.asset_units u on u.id = h.asset_unit_id
  where u.asset_state in ('Damaged', 'In Maintenance', 'Lost', 'Retired', 'Returned')
  union all
  select h.reservation_id, h.allocation_id, h.org_id, h.project_id, h.asset_class_id, h.asset_unit_id, h.asset_lot_id, h.po_line_id,
    h.quantity, h.needed_during, 'Class Over Reserved'
  from open_holds h
  where (h.asset_lot_id is null and h.po_line_id is null
         and private.asset_reservation_peak(h.asset_class_id, h.needed_during, 'stock', null) > h.serviceable_units)
     or private.asset_reservation_peak(h.asset_class_id, h.needed_during, 'all', null) > h.serviceable_units + h.lot_quantity + h.on_order_quantity
  union all
  select h.reservation_id, h.allocation_id, h.org_id, h.project_id, h.asset_class_id, h.asset_unit_id, h.asset_lot_id, h.po_line_id,
    h.quantity, h.needed_during, 'Lot Over Reserved'
  from open_holds h
  where h.asset_lot_id is not null
    and private.asset_reservation_peak(h.asset_class_id, h.needed_during, 'lot', h.asset_lot_id) > private.lot_owned_quantity(h.asset_lot_id)
  union all
  select h.reservation_id, h.allocation_id, h.org_id, h.project_id, h.asset_class_id, h.asset_unit_id, h.asset_lot_id, h.po_line_id,
    h.quantity, h.needed_during, 'Order Short'
  from open_holds h
  join app.po_lines l on l.id = h.po_line_id
  join app.purchase_orders po on po.id = l.purchase_order_id
  where po.po_state = 'Canceled' or po.deleted_at is not null or l.deleted_at is not null
     or private.asset_reservation_peak(h.asset_class_id, h.needed_during, 'line', h.po_line_id) > private.po_line_open_quantity(h.po_line_id)
) c;

call private.describe('app.asset_reservation_conflicts', 'Live holds that no longer fit what can supply them (G-93), computed and never stored: one row per conflict of each live, unreleased, not fully issued hold of an Approved allocation whose window has not ended. Unit Unavailable: the pinned unit is now Damaged, In Maintenance, Lost, Retired or Returned. Class Over Reserved: the peak held over the window is above what the class can supply now. Lot Over Reserved: above the lot''s owned quantity. Order Short: the order is Canceled, or ordered minus returned is below what its line holds. A security definer view filtered to advancing.packet.read on the project or assets.asset.read in the org.', array[
  'reservation_id', 'Hold.',
  'allocation_id', 'Allocation the hold serves.',
  'org_id', 'Org.',
  'project_id', 'Project.',
  'asset_class_id', 'Class held.',
  'asset_unit_id', 'Pinned unit, for a unit hold.',
  'asset_lot_id', 'Lot, for a lot hold.',
  'po_line_id', 'Order line, for an order-line hold.',
  'quantity', 'Quantity held.',
  'needed_during', 'Window of the allocation.',
  'conflict', 'Unit Unavailable, Class Over Reserved, Lot Over Reserved or Order Short.'
]);
revoke all on app.asset_reservation_conflicts from public, anon;
grant select on app.asset_reservation_conflicts to authenticated, service_role;
revoke select on app.asset_reservation_conflicts from xos_backup;

select private.sync_trash_tables();

-- The conflicts view calls these with the caller's execute privilege (see 2695).
grant execute on function private.unit_reservation_issued(uuid, uuid) to authenticated;
grant execute on function private.lot_reservation_issued(uuid) to authenticated;
grant execute on function private.asset_class_capacity(uuid, tstzrange) to authenticated;
grant execute on function private.asset_reservation_peak(uuid, tstzrange, text, uuid) to authenticated;
grant execute on function private.lot_owned_quantity(uuid) to authenticated;
grant execute on function private.po_line_open_quantity(uuid) to authenticated;
