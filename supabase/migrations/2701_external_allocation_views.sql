-- 2701_external_allocation_views.sql
-- R8 Gateway assignment (RRR-188, ADR 0101, 0103 and 0104; owner decisions 4, 6 and 8). What the party side and the
-- people on a roster read in Gateway and Compass. Views in api_external run as their owner with explicit row filters
-- and column allowlists, as 0750 does; existing views are recreated from their latest definition with new columns
-- appended at the end only. No order price, order number, vendor, plate or other Confidential value appears, and a
-- colleague's rows never reach a person on a roster.
--
--   1. private.advance_allocation_status_rows: the combined status of every live allocation, the body of R7's
--      app.advance_allocation_status (2695) without its row filter, so one computation serves both readers.
--      app.advance_allocation_status is recreated from 2695 over it with the same columns and the same filter.
--   2. api_external.advance_allocations: the allocations of the engagements the caller answers for (their roster area,
--      private.my_engagement_ids('roster'), the set private.can_advance_engagement answers for) and the caller's own
--      (private.my_roster_entry_ids('roster')), with the computed display_status (owner decision 8: Gateway shows the
--      status; possession is confirmed only by Issue).
--   3. api_external.requestable_items: what the party side may ask for on each engagement it answers for (owner
--      decision 7): Access badges always; Parking passes, radio and cart classes, Catering, rooms, Travel and Per Diem
--      only while their offering is Provided (the only mode R7 allocates), with the caps and what is already asked.
--   4. api_external.my_roster_engagements: the engagements the caller reaches only through an Accepted roster entry,
--      with api_external.engagements' columns (2656) and the entry, its arrival and the party's lead.
--   5. api_external.my_parking_passes: the caller's own parking passes with zones and vehicle make, model and colour,
--      never the plate.
--   6. Widened: credentials (private.roster_badge_visible, category_kind appended), asset_custody (roster_entry_id
--      appended), travel, lodging, hospitality and per_diems (roster_entry_id appended) add the person's own rows
--      issued on one of their entries; engagement_offerings and engagement_up_next add the engagements of the caller's
--      live entries, so the offering gate and the Up Next venue work for a person on a roster.
-- Every view revokes all from public and anon and grants select to authenticated and service_role; the view in
-- private is revoked from signed-in users, and from the backup login xos_backup (1650 grants it every new relation).

-- 1. One status computation --------------------------------------------------------------------------------------------------

create view private.advance_allocation_status_rows as
select
  a.id as allocation_id,
  a.org_id,
  a.project_id,
  a.engagement_id as holder_engagement_id,
  a.roster_entry_id,
  a.parent_allocation_id,
  x.kind,
  x.offering,
  x.item_name,
  a.quantity,
  a.allocation_state,
  a.origin,
  a.needed_during,
  a.needed_time_zone,
  a.created_by as requested_by,
  d.created_at as decided_at,
  d.created_by as decided_by,
  case when d.to_state = 'Declined' then d.reason end as decline_reason,
  h.reserved_quantity,
  h.on_order_quantity,
  h.confirmed,
  h.awaiting_order,
  h.received_quantity,
  p.issued_quantity,
  p.returned_quantity,
  p.lost_quantity,
  p.revoked_quantity,
  case
    when a.allocation_state = 'Declined' then 'Declined'
    when a.allocation_state = 'Withdrawn' then 'Withdrawn'
    when a.allocation_state = 'Requested' then 'Requested'
    when p.issued_quantity > 0 and p.issued_quantity = a.quantity
      and p.returned_quantity + p.lost_quantity = p.issued_quantity and x.kind not in ('Credential', 'Parking Pass') then 'Returned'
    when x.kind in ('Credential', 'Parking Pass') and p.issued_quantity > 0 and p.revoked_quantity = p.issued_quantity then 'Revoked'
    when p.issued_quantity > 0 and p.issued_quantity >= a.quantity then 'Issued'
    when p.issued_quantity > 0 then 'Partly Issued'
    when h.awaiting_order then 'Awaiting Order'
    when h.on_order_quantity > 0 and not h.confirmed then 'On Order'
    when h.on_order_quantity > 0 then 'Confirmed'
    when h.order_line_quantity > 0 and h.received_quantity > 0 then 'Received'
    when a.quantity > 0 and h.reserved_quantity >= a.quantity then 'Reserved'
    else 'Approved'
  end as display_status
from app.advance_allocations a
cross join lateral (
  select private.allocation_kind(a) as kind, private.allocation_offering_kind(a) as offering,
    coalesce(
      (select k.name from app.credential_categories k where k.id = a.credential_category_id),
      (select c.name from app.asset_classes c where c.id = a.asset_class_id),
      (select f.title from app.fulfillments f where f.id = a.fulfillment_id),
      (select b.title from app.accommodation_blocks b where b.id = a.accommodation_block_id)) as item_name
) x
left join lateral (
  select t.created_at, t.created_by, t.to_state, t.reason
  from app.advance_allocation_state_transitions t
  where t.advance_allocation_id = a.id and t.from_state = 'Requested' and t.to_state in ('Approved', 'Declined')
  order by t.created_at desc, t.id desc limit 1
) d on true
cross join lateral (
  select
    coalesce(sum(r.quantity), 0) as reserved_quantity,
    coalesce(sum(r.quantity) filter (where r.po_line_id is not null), 0) as order_line_quantity,
    coalesce(sum(greatest(r.quantity - least(r.quantity, s.received), 0))
      filter (where r.po_line_id is not null and s.po_state in ('Approved', 'Sent')), 0) as on_order_quantity,
    coalesce(bool_and(s.acknowledged) filter (where r.po_line_id is not null and s.po_state in ('Approved', 'Sent')), false) as confirmed,
    coalesce(bool_or(s.po_state = 'Proposed') filter (where r.po_line_id is not null), false) as awaiting_order,
    coalesce(sum(least(r.quantity, s.received)) filter (where r.po_line_id is not null), 0) as received_quantity
  from app.asset_reservations r
  left join lateral (
    select po.po_state,
      exists (select 1 from app.po_acknowledgments k where k.purchase_order_id = po.id and k.deleted_at is null) as acknowledged,
      coalesce((select sum(rl.quantity_received) from app.receipt_lines rl
                join app.goods_receipts g on g.id = rl.goods_receipt_id and g.deleted_at is null
                where rl.po_line_id = l.id and rl.deleted_at is null), 0) as received
    from app.po_lines l join app.purchase_orders po on po.id = l.purchase_order_id
    where l.id = r.po_line_id
  ) s on true
  where r.advance_allocation_id = a.id and r.released_at is null and r.deleted_at is null
) h
cross join lateral (
  select
    case
      when x.kind in ('Credential', 'Parking Pass') then
        (select count(*) from app.credentials c where c.allocation_id = a.id and c.deleted_at is null)
      when x.kind = 'Asset' then
        (select count(*) from (select distinct c.asset_unit_id from app.asset_custody c
          join app.asset_reservations r on r.id = c.reservation_id where r.advance_allocation_id = a.id) u)
        + (select coalesce(sum(-m.delta), 0) from app.asset_lot_movements m join app.asset_reservations r on r.id = m.reservation_id
           where r.advance_allocation_id = a.id and m.movement_kind = 'Check Out')
      when x.kind = 'Catering' then
        (select coalesce(sum(l.quantity), 0) from app.fulfillment_lines l where l.allocation_id = a.id and l.deleted_at is null)
      when x.kind = 'Lodging' then
        (select count(*) from app.accommodation_assignments s where s.allocation_id = a.id and s.deleted_at is null)
      when x.kind = 'Travel' then
        (select count(*) from app.travel_segments t where t.allocation_id = a.id and t.deleted_at is null)
      when x.kind = 'Per Diem' then
        (select count(*) from app.per_diems pd where pd.allocation_id = a.id and pd.deleted_at is null)
      else 0
    end::numeric as issued_quantity,
    case when x.kind = 'Asset' then
      (select count(*) from (
        select distinct c.asset_unit_id from app.asset_custody c
        join app.asset_reservations r on r.id = c.reservation_id
        where r.advance_allocation_id = a.id
          and exists (select 1 from app.asset_custody l where l.asset_unit_id = c.asset_unit_id
                      and (l.created_at, l.id) > (c.created_at, c.id)
                      and l.custodian_membership_id is null and l.custodian_engagement_id is null)) u)
      + (select coalesce(sum(m.delta), 0) from app.asset_lot_movements m join app.asset_reservations r on r.id = m.reservation_id
         where r.advance_allocation_id = a.id and m.movement_kind = 'Check In')
    else 0 end::numeric as returned_quantity,
    case when x.kind = 'Asset' then
      (select count(*) from (
        select distinct c.asset_unit_id from app.asset_custody c
        join app.asset_reservations r on r.id = c.reservation_id
        join app.asset_units un on un.id = c.asset_unit_id
        where r.advance_allocation_id = a.id and un.asset_state = 'Lost'
          and not exists (select 1 from app.asset_custody l where l.asset_unit_id = c.asset_unit_id
                          and (l.created_at, l.id) > (c.created_at, c.id)
                          and l.custodian_membership_id is null and l.custodian_engagement_id is null)) u)
    else 0 end::numeric as lost_quantity,
    case when x.kind in ('Credential', 'Parking Pass') then
      (select count(*) from app.credentials c where c.allocation_id = a.id and c.deleted_at is null and c.revoked_at is not null)
    else 0 end::numeric as revoked_quantity
) p
where a.deleted_at is null;

comment on view private.advance_allocation_status_rows is 'The combined status of every live allocation (R7, ADR 0103), computed from the rows that own each state: the body of app.advance_allocation_status without a row filter (2701). Read only by views owned by the migration role, which filter it: app.advance_allocation_status (advancing.packet.read) and api_external.advance_allocations (the party side and the person).';
revoke all on private.advance_allocation_status_rows from public, anon, authenticated;
revoke select on private.advance_allocation_status_rows from xos_backup;

create or replace view app.advance_allocation_status as
select s.allocation_id, s.org_id, s.project_id, s.holder_engagement_id, s.roster_entry_id, s.parent_allocation_id,
  s.kind, s.offering, s.item_name, s.quantity, s.allocation_state, s.origin, s.needed_during,
  s.needed_time_zone, s.requested_by, s.decided_at, s.decided_by, s.decline_reason, s.reserved_quantity,
  s.on_order_quantity, s.confirmed, s.awaiting_order, s.received_quantity, s.issued_quantity,
  s.returned_quantity, s.lost_quantity, s.revoked_quantity, s.display_status
from private.advance_allocation_status_rows s
where s.project_id in (select private.project_ids_with('advancing.packet.read'));

revoke all on app.advance_allocation_status from public, anon;
grant select on app.advance_allocation_status to authenticated, service_role;
revoke select on app.advance_allocation_status from xos_backup;

-- 2. Allocations in Gateway ------------------------------------------------------------------------------------------------

create view api_external.advance_allocations as
select s.allocation_id, x.engagement_id, s.roster_entry_id,
  case when s.roster_entry_id is not null then pp.full_name end as person_name,
  s.kind, s.item_name, s.quantity, s.allocation_state, s.display_status, s.reserved_quantity, s.issued_quantity,
  s.returned_quantity, s.parent_allocation_id, lower(s.needed_during) as needed_from, upper(s.needed_during) as needed_to,
  s.needed_time_zone, s.requested_by = private.current_person_id() as requested_by_me, s.decline_reason
from private.advance_allocation_status_rows s
cross join lateral (
  select coalesce(s.holder_engagement_id, (select r.engagement_id from app.engagement_roster_entries r where r.id = s.roster_entry_id))
    as engagement_id
) x
left join private.roster_people rp on rp.roster_entry_id = s.roster_entry_id
left join app.people pp on pp.id = rp.person_id
where x.engagement_id in (select private.my_engagement_ids('roster'))
   or s.roster_entry_id in (select private.my_roster_entry_ids('roster'));

call private.describe('api_external.advance_allocations', 'What a party''s engagement is allocated (R8, ADR 0103 and 0104): its pool and the share of each person on its roster, for the party side (the engagements whose roster area the caller reaches: the engaged person of an Artist engagement or one no account supplies, the supplying account''s Owner or Admin, an Advancing Lead, an Advance representative), and a person''s own rows on their entries. The status is computed (app.advance_allocation_status); prices, order numbers, vendors and other people''s asset tags never appear.', array[
  'allocation_id', 'Allocation.',
  'engagement_id', 'Engagement it is held under: the pool''s own, or the roster entry''s.',
  'roster_entry_id', 'Roster entry of the person who holds it; NULL for the party''s pool.',
  'person_name', 'Name of the person who holds it; NULL for the pool.',
  'kind', 'Credential, Parking Pass, Asset, Catering, Lodging, Travel or Per Diem.',
  'item_name', 'Category, class, catering or block name; NULL for Travel and Per Diem.',
  'quantity', 'Quantity allocated; a pool goes down as it is shared out.',
  'allocation_state', 'Requested, Approved, Declined or Withdrawn.',
  'display_status', 'Computed status: Declined, Withdrawn or Requested; for Approved, Returned, Revoked, Issued, Partly Issued, Awaiting Order, On Order, Confirmed, Received, Reserved or Approved.',
  'reserved_quantity', 'Quantity held for it.',
  'issued_quantity', 'Quantity handed over.',
  'returned_quantity', 'Quantity handed back.',
  'parent_allocation_id', 'Pool a person''s share was split from.',
  'needed_from', 'When it is needed from.',
  'needed_to', 'When it is needed until.',
  'needed_time_zone', 'IANA time zone of the window.',
  'requested_by_me', 'True when the caller asked for it.',
  'decline_reason', 'Why production declined it.'
]);

-- 3. What may be asked for ----------------------------------------------------------------------------------------------------

create view api_external.requestable_items as
with eng as (
  select e.id, e.org_id, e.project_id from app.engagements e
  where e.deleted_at is null and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
    and e.id in (select private.my_engagement_ids('roster'))
),
offers as (
  select g.id as engagement_id, o.offering, o.cap_per_engagement, o.cap_per_person
  from eng g cross join lateral private.my_engagement_offerings(g.id) o
  where o.offering_mode = 'Provided'
),
items as (
  select g.id as engagement_id, 'credential_category'::text as item_kind, k.id as item_id, k.name,
    case when k.category_kind = 'Parking' then 'Parking'::app.offering_kind end as offering
  from eng g join app.credential_categories k on k.project_id = g.project_id and k.deleted_at is null
  union all
  select g.id, 'asset_class', c.id, c.name, c.offering
  from eng g join app.asset_classes c on c.org_id = g.org_id and c.offering is not null and c.deleted_at is null
  union all
  select g.id, 'fulfillment', f.id, f.title, 'Catering'::app.offering_kind
  from eng g join app.fulfillments f on f.project_id = g.project_id and f.fulfillment_kind = 'Catering' and f.deleted_at is null
  union all
  select g.id, 'accommodation_block', b.id, b.title, 'Lodging'::app.offering_kind
  from eng g join app.accommodation_blocks b on b.project_id = g.project_id and b.deleted_at is null
  union all
  select g.id, 'service', null::uuid, k::text, k::text::app.offering_kind
  from eng g cross join unnest(array['Travel', 'Per Diem']::app.allocation_service_kind[]) k
)
select i.engagement_id, i.item_kind, i.item_id, i.name, i.offering, o.cap_per_engagement, o.cap_per_person,
  coalesce((
    select sum(a.quantity) from app.advance_allocations a
    where a.deleted_at is null and a.allocation_state in ('Requested', 'Approved')
      and (a.engagement_id = i.engagement_id
        or a.roster_entry_id in (select r.id from app.engagement_roster_entries r where r.engagement_id = i.engagement_id))
      and case i.item_kind
        when 'credential_category' then a.credential_category_id = i.item_id
        when 'asset_class' then a.asset_class_id = i.item_id
        when 'fulfillment' then a.fulfillment_id = i.item_id
        when 'accommodation_block' then a.accommodation_block_id = i.item_id
        else a.service_kind::text = i.name
      end), 0) as requested_quantity
from items i
left join offers o on o.engagement_id = i.engagement_id and o.offering = i.offering
where i.offering is null or o.offering is not null;

call private.describe('api_external.requestable_items', 'What the party side may ask for on each engagement it answers for (R8, owner decision 7): the project''s Access badges always, and its Parking passes, the org''s radio and cart classes, Catering, accommodation blocks, Travel and Per Diem only while the offering is Provided on the engagement. With the caps and the quantity already asked for or approved under the engagement and its roster.', array[
  'engagement_id', 'Engagement it may be asked for on.',
  'item_kind', 'credential_category, asset_class, fulfillment, accommodation_block or service: the p_item_kind of app.request_engaged_allocation.',
  'item_id', 'The category, class, fulfillment or block; NULL for a service.',
  'name', 'Its name; Travel or Per Diem for a service.',
  'offering', 'Offering it draws on; NULL for an Access badge, which is no offering.',
  'cap_per_engagement', 'Most of the offering the engagement may have; NULL for no cap.',
  'cap_per_person', 'Most of the offering one person may have; NULL for no cap.',
  'requested_quantity', 'Quantity of this item already requested or approved under the engagement and its roster.'
]);

-- 4. Engagements reached through a roster entry ------------------------------------------------------------------------------

create view api_external.my_roster_engagements as
select e.id, e.org_id, o.name as org_name, e.project_id, p.name as project_name, e.role_type, e.role_code, xr.job_title,
  e.person_id, c.organization_id as account_id, e.pay_basis, e.arrangement,
  null::bigint as rate_minor, null::text as rate_currency_code,
  e.start_date, e.end_date, e.engagement_state, a.areas, p.time_zone as project_time_zone, e.roster_locks_at,
  r.id as roster_entry_id, r.role_code as entry_role_code,
  lower(r.arrival_window) as arrival_window_start, upper(r.arrival_window) as arrival_window_end, r.arrival_time_zone,
  coalesce(lead.full_name, owner.full_name) as lead_name
from (
  select distinct on (x.engagement_id) x.*
  from app.engagement_roster_entries x
  where x.id in (select private.my_roster_entry_ids('onboarding')) and x.entry_state = 'Accepted' and not x.is_self
  order by x.engagement_id, x.created_at, x.id
) r
join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
join app.organizations o on o.id = e.org_id
join app.projects p on p.id = e.project_id
left join xpms.role xr on xr.role_code = e.role_code
left join app.counterparties c on c.id = e.counterparty_id
cross join lateral (
  select array(select k from unnest(array['operational', 'onboarding', 'roster']) k
               where r.id in (select private.my_roster_entry_ids(k)) order by k) as areas
) a
left join lateral (
  select lp.full_name from app.account_engagement_assignments x
  join app.account_memberships m on m.id = x.account_membership_id and m.deleted_at is null
  join app.people lp on lp.id = m.person_id
  where x.engagement_id = e.id and x.duty = 'Advancing Lead' and x.deleted_at is null
  order by x.created_at, x.id limit 1
) lead on true
left join lateral (
  select op.full_name from app.account_memberships m
  join app.account_membership_roles mr on mr.account_membership_id = m.id and mr.account_role = 'Account Owner' and mr.deleted_at is null
  join app.people op on op.id = m.person_id
  where m.org_id = c.organization_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  order by m.valid_from, m.id limit 1
) owner on true
where e.id not in (select private.my_engagement_ids('engagement'));

call private.describe('api_external.my_roster_engagements', 'The engagements the caller reaches only through a roster entry (R8, ADR 0100 roster-member): one row per engagement where they hold a live entry accepted by the reviewer and by themselves, with the columns of api_external.engagements (the rate never shows) and the entry, its arrival window and the party''s Advancing Lead, else its Account Owner, by full name only. areas are the roster areas of the entry (private.my_roster_entry_ids: roster, onboarding, operational). Engagements the caller reaches as a party read from api_external.engagements instead.', array[
  'id', 'Engagement.', 'org_id', 'Producing org.', 'org_name', 'Producing org name.', 'project_id', 'Project.',
  'project_name', 'Project name.', 'role_type', 'External role type of the engagement.', 'role_code', 'Role the engagement is for.',
  'job_title', 'Job title of that role.', 'person_id', 'Person the engagement names, if any.', 'account_id', 'Supplying account.',
  'pay_basis', 'Pay basis.', 'arrangement', 'Arrangement.', 'rate_minor', 'Always NULL here: the party''s rate is not the person''s.',
  'rate_currency_code', 'Always NULL here.', 'start_date', 'First day.', 'end_date', 'Last day.',
  'engagement_state', 'Engagement state.', 'areas', 'Roster areas open to the caller on the entry.',
  'project_time_zone', 'IANA time zone of the project.', 'roster_locks_at', 'Names lock (R5).',
  'roster_entry_id', 'The caller''s roster entry.', 'entry_role_code', 'Role the caller works, from the Roles Library.',
  'arrival_window_start', 'Arrival window start.', 'arrival_window_end', 'Arrival window end.',
  'arrival_time_zone', 'IANA time zone of the arrival window.',
  'lead_name', 'Whom to ask on the party side: its Advancing Lead on the engagement, else its Account Owner.'
]);

-- 5. Parking passes --------------------------------------------------------------------------------------------------------------

create view api_external.my_parking_passes as
select c.id as credential_id, k.project_id, c.credential_number, k.name as category_name, c.valid_from, c.valid_to, c.revoked_at,
  coalesce(z.codes, '{}') as zone_codes, coalesce(z.names, '{}') as zone_names,
  v.make as vehicle_make, v.model as vehicle_model, v.color as vehicle_color, c.holder_person_id
from app.credentials c
join app.credential_categories k on k.id = c.credential_category_id and k.deleted_at is null and k.category_kind = 'Parking'
left join lateral (
  select array_agg(zn.code order by zn.code) as codes, array_agg(zn.name order by zn.code) as names
  from app.access_grid g join app.zones zn on zn.id = g.zone_id and zn.deleted_at is null
  where g.credential_category_id = k.id and g.deleted_at is null
) z on true
left join lateral (
  select rv.make, rv.model, rv.color from app.credential_vehicles cv
  join app.roster_vehicles rv on rv.id = cv.roster_vehicle_id and rv.deleted_at is null
  where cv.credential_id = c.id and cv.deleted_at is null
  limit 1
) v on true
where c.deleted_at is null and c.holder_person_id = private.current_person_id();

call private.describe('api_external.my_parking_passes', 'The caller''s own parking passes (R8): credentials of a Parking category with the zones its access grid opens and the make, model and colour of the vehicle it was issued for. The plate never appears.', array[
  'credential_id', 'Parking pass.', 'project_id', 'Project.', 'credential_number', 'Number printed on the pass.',
  'category_name', 'Parking category.', 'valid_from', 'Valid from.', 'valid_to', 'Valid until.', 'revoked_at', 'When it was revoked.',
  'zone_codes', 'Codes of the zones it opens.', 'zone_names', 'Names of the zones it opens, in the order of zone_codes.',
  'vehicle_make', 'Make of the vehicle it is for.', 'vehicle_model', 'Model of the vehicle.', 'vehicle_color', 'Colour of the vehicle.',
  'holder_person_id', 'The caller, the pass holder: the column Compass''s download scope checks.'
]);

-- 6. Widened views -------------------------------------------------------------------------------------------------------------

create or replace function private.roster_badge_visible(p_engagement_id uuid, p_holder_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_engagement_id is not null and p_holder_person_id = private.current_person_id() and exists (
    select 1 from app.engagement_roster_entries r
    where r.engagement_id = p_engagement_id and r.id in (select private.my_roster_entry_ids('operational')));
$$;
comment on function private.roster_badge_visible(uuid, uuid) is 'R8: true when a badge is the signed-in person''s own and was issued under an engagement on whose roster they hold a live entry accepted by both sides while it is Active or Closing (private.my_roster_entry_ids(''operational'')). Takes the badge''s engagement_id and holder (ADR 0016 item 14).';
revoke all on function private.roster_badge_visible(uuid, uuid) from public, anon;
grant execute on function private.roster_badge_visible(uuid, uuid) to authenticated, service_role;

create or replace function private.my_roster_allocation(p_allocation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_allocation_id is not null and exists (
    select 1 from app.advance_allocations a
    where a.id = p_allocation_id and a.roster_entry_id in (select private.my_roster_entry_ids('operational')));
$$;
comment on function private.my_roster_allocation(uuid) is 'R8: true when an allocation is held by one of the signed-in person''s operational roster entries (Active or Closing, accepted by both sides). Takes the allocation id a possession row carries.';
revoke all on function private.my_roster_allocation(uuid) from public, anon;
grant execute on function private.my_roster_allocation(uuid) to authenticated, service_role;

create or replace view api_external.credentials as
select c.id, k.project_id, p.name as project_name, k.code as category_code, k.name as category_name, c.holder_person_id,
  h.full_name as holder_name, c.credential_number, c.valid_from, c.valid_to, c.revoked_at, c.engagement_id, k.category_kind
from app.credentials c
join app.credential_categories k on k.id = c.credential_category_id and k.deleted_at is null
join app.projects p on p.id = k.project_id
join app.people h on h.id = c.holder_person_id
where c.deleted_at is null
  and (private.party_person_visible(k.project_id, c.holder_person_id) or private.party_badge_visible(c.engagement_id)
    or private.roster_badge_visible(c.engagement_id, c.holder_person_id));

comment on view api_external.credentials is 'Badges the caller may read (Section 8.7): those of people whose engagement on the project has the caller as a principal (the person, the supplying account''s Owner or Admin, or an artist''s Advance representative) while its operational area is open, the party badges issued under an engagement for its principals, and a person''s own badges issued under an engagement whose roster they are on (R8). Who issued or revoked a badge never appears.';
comment on column api_external.credentials.category_kind is 'Access for a badge, Parking for a parking pass (R7).';

create or replace view api_external.asset_custody as
select c.id, c.asset_unit_id, u.asset_tag, k.name as class_name, u.asset_state, c.custodian_engagement_id as engagement_id,
  c.project_id, p.name as project_name, c.created_at as held_since, c.roster_entry_id
from app.asset_custody c
join app.asset_units u on u.id = c.asset_unit_id and u.deleted_at is null
join app.asset_classes k on k.id = u.asset_class_id
left join app.projects p on p.id = c.project_id
where (c.custodian_engagement_id in (select private.my_engagement_ids('operational'))
    or c.roster_entry_id in (select private.my_roster_entry_ids('operational'))
    or (c.roster_entry_id is null and c.custodian_engagement_id in (select private.my_engagement_ids('roster'))))
  and not exists (
    select 1 from app.asset_custody n
    where n.asset_unit_id = c.asset_unit_id and (n.created_at, n.id) > (c.created_at, c.id));

comment on view api_external.asset_custody is 'Asset units the caller''s engagements hold now: the latest custody row of each unit, while the operational area is open (Section 8.7); a person''s own units on their operational roster entries, and the party''s pool custody for the people who answer for it (R8). Handover notes and other custodians never appear.';
comment on column api_external.asset_custody.roster_entry_id is 'Roster entry of the person who holds the unit; NULL when the party holds it (R8).';

create or replace view api_external.lodging as
select a.id, b.project_id, p.name as project_name, b.title as block_title, o.name as hotel_name, a.person_id, g.full_name as guest_name,
  a.check_in_on, a.check_out_on
from app.accommodation_assignments a
join app.accommodation_blocks b on b.id = a.accommodation_block_id and b.deleted_at is null
join app.projects p on p.id = b.project_id
join app.people g on g.id = a.person_id
left join app.counterparties c on c.id = b.counterparty_id
left join app.organizations o on o.id = c.organization_id
where a.deleted_at is null and (private.party_person_visible(b.project_id, a.person_id)
  or (a.person_id = private.current_person_id() and private.my_roster_allocation(a.allocation_id)));

comment on view api_external.lodging is 'Room assignments of people whose engagement on the project has the caller as a principal (the person, the supplying account''s Owner or Admin, or an artist''s Advance representative) while that engagement is in the operational area (Section 8.7), and a person''s own rooms issued on one of their roster entries (R8). Contracted rates and room counts never appear.';

create or replace view api_external.hospitality as
select l.id, f.id as fulfillment_id, f.project_id, p.name as project_name, f.fulfillment_kind, f.title, o.name as supplier_name,
  f.starts_at, f.ends_at, l.description, l.quantity, l.person_id
from app.fulfillment_lines l
join app.fulfillments f on f.id = l.fulfillment_id and f.deleted_at is null
join app.projects p on p.id = f.project_id
left join app.counterparties c on c.id = f.counterparty_id
left join app.organizations o on o.id = c.organization_id
where l.deleted_at is null and (private.party_person_visible(f.project_id, l.person_id)
  or (l.person_id = private.current_person_id() and private.my_roster_allocation(l.allocation_id)));

comment on view api_external.hospitality is 'Travel, lodging, catering and amenity lines for people whose engagement on the project has the caller as a principal (the person, the supplying account''s Owner or Admin, or an artist''s Advance representative) while that engagement is in the operational area, and a person''s own lines issued on one of their roster entries (R8). Prices never appear.';

create or replace view api_external.travel as
select t.id, t.engagement_id, t.project_id, p.name as project_name, t.travel_mode, t.operator_name, t.service_identifier,
  t.confirmation_identifier, t.departs_from, t.departs_at, t.departs_time_zone, t.arrives_at_place, t.arrives_at, t.arrives_time_zone
from app.travel_segments t
join app.projects p on p.id = t.project_id
where t.deleted_at is null
  and ((t.engagement_id in (select private.my_engagement_ids('operational'))
        and (t.person_id = private.current_person_id() or private.engagement_principal(t.engagement_id)))
    or (t.person_id = private.current_person_id() and private.my_roster_allocation(t.allocation_id)));

comment on view api_external.travel is 'Flights and ground transport booked under the caller''s engagements (Section 4.5.8 Crew Travel and Lodging), while the operational area is open: the traveller''s own, those of an engagement the caller answers for (the supplying account''s Owner or Admin, or an artist''s Advance representative), and a person''s own trips issued on one of their roster entries (R8). What the org paid never appears.';

create or replace view api_external.per_diems as
select d.id, d.engagement_id, d.project_id, p.name as project_name, d.day, d.amount_minor, d.currency_code, d.roster_entry_id
from app.per_diems d
join app.projects p on p.id = d.project_id
where d.deleted_at is null
  and ((d.engagement_id in (select private.my_engagement_ids('operational')) and private.engagement_principal(d.engagement_id))
    or d.roster_entry_id in (select private.my_roster_entry_ids('operational')));

comment on view api_external.per_diems is 'Per diem allowances paid through engagements the caller answers for (Section 4.5.8 Crew Per Diem): the person''s own, and those of the people the caller''s account supplies for its Owner and Admin, while the operational area is open; and a person''s own days on their operational roster entries (R8).';
comment on column api_external.per_diems.roster_entry_id is 'Roster entry the day is paid on; NULL for an engagement''s own per diem (R8).';

-- The offering gate and Up Next for a person on a roster --------------------------------------------------------------------------

create or replace function private.my_engagement_offerings(p_engagement_id uuid)
returns table (
  offering app.offering_kind,
  offering_mode app.offering_mode,
  cap_per_engagement integer,
  cap_per_person integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.offering, o.offering_mode, o.cap_per_engagement, o.cap_per_person
  from private.effective_offerings(p_engagement_id) o
  where exists (select 1 from private.engagement_scope(p_engagement_id) a where a = 'engagement')
     or exists (select 1 from app.engagement_roster_entries r
                where r.engagement_id = p_engagement_id and r.id in (select private.my_roster_entry_ids('roster')));
$$;

comment on function private.my_engagement_offerings(uuid) is 'The offerings of one live engagement whose engagement area the signed-in person reaches as an external party (private.engagement_scope, with the Section 8.7 time box), or on whose roster they hold a live entry (R8), from private.effective_offerings, without the deciding layer; no rows for any other engagement. Serves api_external.engagement_offerings (R3) and api_external.requestable_items (R8).';
revoke all on function private.my_engagement_offerings(uuid) from public, anon;
grant execute on function private.my_engagement_offerings(uuid) to authenticated, service_role;

create or replace view api_external.engagement_offerings as
select e.id as engagement_id, m.offering, m.offering_mode, m.cap_per_engagement, m.cap_per_person
from app.engagements e
cross join lateral private.my_engagement_offerings(e.id) m
where e.deleted_at is null
  and (e.id in (select private.my_engagement_ids('engagement'))
    or e.id in (select r.engagement_id from app.engagement_roster_entries r where r.id in (select private.my_roster_entry_ids('roster'))));

comment on view api_external.engagement_offerings is 'What the producing org offers on the caller''s engagements (R3, owner decision 7): one row per offering for each engagement whose engagement area the caller reaches, or on whose roster they hold a live entry (R8), Not Offered unless the org, the project or an audience rule offers it. The layer that decided never appears.';

create or replace view api_external.engagement_up_next as
select e.id as engagement_id, e.project_id,
  v.name as venue_name, v.street_address as venue_street_address, v.locality as venue_locality, v.postal_code as venue_postal_code,
  case when exists (
    select 1 from app.memberships m
    where m.person_id = e.created_by and m.org_id = e.org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
  then cp.full_name end as contact_name,
  n.starts_at as next_call_at, n.time_zone as next_call_time_zone, n.call_kind as next_call_kind
from app.engagements e
join app.projects p on p.id = e.project_id
left join app.venues v on v.id = p.venue_id and v.deleted_at is null
left join app.people cp on cp.id = e.created_by
cross join lateral (select array(select s from private.engagement_scope(e.id) s) as areas) a
left join lateral (
  select x.starts_at, x.time_zone, x.call_kind
  from (
    select s.starts_at, s.time_zone, 'Shift'::text as call_kind
    from app.shifts s
    where s.engagement_id = e.id and s.deleted_at is null and s.shift_state in ('Published', 'Accepted') and s.starts_at > now()
    union all
    select d.starts_at, p.time_zone, 'Dock Slot'::text
    from app.dock_slots d
    where d.engagement_id = e.id and d.deleted_at is null and d.checked_in_at is null and d.starts_at > now()
    union all
    select c.planned_at, p.time_zone, 'Set'::text
    from app.engagement_cues ec
    join app.cues c on c.id = ec.cue_id and c.deleted_at is null
    join app.run_of_show r on r.id = c.run_of_show_id and r.deleted_at is null
    where ec.engagement_id = e.id and ec.deleted_at is null and c.planned_at > now() and c.called_at is null
  ) x
  where 'operational' = any (a.areas)
  order by x.starts_at
  limit 1
) n on true
where e.deleted_at is null
  and (e.id in (select private.my_engagement_ids('engagement'))
    or e.id in (select r.engagement_id from app.engagement_roster_entries r where r.id in (select private.my_roster_entry_ids('roster'))));

comment on view api_external.engagement_up_next is 'What Gateway Home''s Up Next card shows for the caller''s engagements (Section 4.4.4): the project''s venue, the org member who set up the engagement while they still belong to the org, and, while the operational area is open, the next call: a Published or Accepted shift, a dock slot not yet checked in or a set cue not yet called. A person on a roster reads the venue and the contact of their entries'' engagements; the party''s calls stay the party''s (R8).';

revoke all on api_external.advance_allocations, api_external.requestable_items, api_external.my_roster_engagements,
  api_external.my_parking_passes, api_external.credentials, api_external.asset_custody, api_external.lodging,
  api_external.hospitality, api_external.travel, api_external.per_diems, api_external.engagement_offerings,
  api_external.engagement_up_next
  from public, anon;
grant select on api_external.advance_allocations, api_external.requestable_items, api_external.my_roster_engagements,
  api_external.my_parking_passes, api_external.credentials, api_external.asset_custody, api_external.lodging,
  api_external.hospitality, api_external.travel, api_external.per_diems, api_external.engagement_offerings,
  api_external.engagement_up_next
  to authenticated, service_role;
