-- 2695_allocation_status.sql
-- R7 Allocations, Atlas side (RRR-187, ADR 0103 and 0104). The combined status of an allocation is computed from the
-- rows that own each state and never stored:
--
--   * app.advance_allocation_status: one row per live allocation with its decision (from the lifecycle ledger), its
--     holds, the order behind its order-line holds (procurement owns Ordered, Confirmed and Received), what was
--     issued, returned, lost or revoked (the possession rows), and display_status. A security definer view (owner
--     reads) with its own row filter, advancing.packet.read on the project, as 1622 builds app.expense_budget_lines.
--     No prices.
--   * app.allocation_holders: the holders the Assign picker offers, party pools and the people on their rosters.
--   * app.catering_counts: a catering fulfillment's roster headcount and its shared dietary needs, suppressed below
--     five, with allergies only for holders of data.restricted.read.medical (owner decisions 4 and 5). Every call
--     logs one access-log row per person counted. The BEO guest count stays the org's own figure.
-- Each view revokes all from public and anon, grants select to authenticated and service_role, and keeps select away
-- from the read-only backup login xos_backup (1650 grants it every new relation by default).

create view app.advance_allocation_status as
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
where a.deleted_at is null
  and a.project_id in (select private.project_ids_with('advancing.packet.read'));

call private.describe('app.advance_allocation_status', 'Where each allocation stands (R7, ADR 0103 and 0104), computed from the rows that own each state and never stored: the decision from the lifecycle ledger, the live holds, the order behind order-line holds (procurement owns Ordered, Confirmed and Received), and what the possession rows issued, returned, lost or revoked. Nothing is copied back onto the allocation, and no price appears. A security definer view filtered to advancing.packet.read on the project.', array[
  'allocation_id', 'Allocation.',
  'org_id', 'Producing org.',
  'project_id', 'Project.',
  'holder_engagement_id', 'Party pool''s engagement; NULL when a person holds it.',
  'roster_entry_id', 'Roster entry of the person who holds it; NULL for a pool.',
  'parent_allocation_id', 'Pool a share was split from.',
  'kind', 'Credential, Parking Pass, Asset, Catering, Lodging, Travel or Per Diem.',
  'offering', 'Offering it draws on; NULL for a badge or a site asset.',
  'item_name', 'Category, class, catering or block name; NULL for Travel and Per Diem.',
  'quantity', 'Quantity allocated.',
  'allocation_state', 'Requested, Approved, Declined or Withdrawn.',
  'origin', 'Requested, Assigned or Split.',
  'needed_during', 'When it is needed.',
  'needed_time_zone', 'IANA time zone of the window.',
  'requested_by', 'Who requested or assigned it (private.allocation_requester).',
  'decided_at', 'When it was approved or declined, from the ledger.',
  'decided_by', 'Who approved or declined it, from the ledger.',
  'decline_reason', 'Why it was declined, from the ledger.',
  'reserved_quantity', 'Quantity of live holds.',
  'on_order_quantity', 'Quantity of order-line holds whose order is Approved or Sent, not yet received.',
  'confirmed', 'True when every ordering order behind its holds was acknowledged by the vendor.',
  'awaiting_order', 'True while an order behind its holds is still Proposed.',
  'received_quantity', 'Quantity received on the order lines behind its holds, up to what each holds.',
  'issued_quantity', 'Quantity issued: credentials, units and lot quantities checked out against its holds, catering line quantities, rooms, trips or per diem days.',
  'returned_quantity', 'Issued units checked in since, and lot quantities checked in against its holds.',
  'lost_quantity', 'Issued units that went Lost without coming back.',
  'revoked_quantity', 'Issued credentials since revoked.',
  'display_status', 'Declined, Withdrawn or Requested; for Approved, in this order: Returned, Revoked, Issued, Partly Issued, Awaiting Order, On Order, Confirmed, Received, Reserved, else Approved.'
]);
revoke all on app.advance_allocation_status from public, anon;
grant select on app.advance_allocation_status to authenticated, service_role;
revoke select on app.advance_allocation_status from xos_backup;

-- Holders for the Assign picker ---------------------------------------------------------------------------------------------------

create view app.allocation_holders as
select 'Pool'::text as holder_kind, e.id as engagement_id, null::uuid as roster_entry_id, e.org_id, e.project_id,
  coalesce(ao.name, ep.full_name) as holder_name, coalesce(ao.name, ep.full_name) as party_name, e.role_type,
  null::app.roster_entry_state as entry_state, null::app.roster_person_response as person_response, null::text as role_code
from app.engagements e
left join app.counterparties c on c.id = e.counterparty_id
left join app.organizations ao on ao.id = c.organization_id
left join app.people ep on ep.id = e.person_id
where e.deleted_at is null and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
  and e.project_id in (select private.project_ids_with('advancing.packet.read'))
union all
select 'Person'::text, e.id, r.id, e.org_id, e.project_id, pp.full_name, coalesce(ao.name, ep.full_name), e.role_type,
  r.entry_state, r.person_response, r.role_code
from app.engagement_roster_entries r
join app.engagements e on e.id = r.engagement_id
join private.roster_people rp on rp.roster_entry_id = r.id
left join app.people pp on pp.id = rp.person_id
left join app.counterparties c on c.id = e.counterparty_id
left join app.organizations ao on ao.id = c.organization_id
left join app.people ep on ep.id = e.person_id
where r.deleted_at is null and r.entry_state <> 'Withdrawn' and e.deleted_at is null
  and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
  and e.project_id in (select private.project_ids_with('advancing.packet.read'));

call private.describe('app.allocation_holders', 'Who an allocation can go to on a project (R7), for the Assign picker: each open engagement as a party pool, and each live roster entry of one as a person, with the person''s name (private.roster_people), the party''s name and the entry''s state. A security definer view filtered to advancing.packet.read on the project.', array[
  'holder_kind', 'Pool for a party''s engagement, Person for a roster entry.',
  'engagement_id', 'Engagement of the pool or of the entry.',
  'roster_entry_id', 'Roster entry; NULL for a pool.',
  'org_id', 'Producing org.',
  'project_id', 'Project.',
  'holder_name', 'The party''s name for a pool, the person''s for an entry; NULL for an unclaimed invitation.',
  'party_name', 'The supplying account''s name, else the engaged person''s.',
  'role_type', 'External role type of the engagement.',
  'entry_state', 'Review state of the entry; NULL for a pool.',
  'person_response', 'The person''s answer; NULL for a pool.',
  'role_code', 'Role the person works, for the default radio channel hint; NULL for a pool.'
]);
revoke all on app.allocation_holders from public, anon;
grant select on app.allocation_holders to authenticated, service_role;
revoke select on app.allocation_holders from xos_backup;

-- Catering counts ------------------------------------------------------------------------------------------------------------------

create or replace function private.catering_people(p_fulfillment_id uuid)
returns table (person_id uuid, roster_entry_id uuid, engagement_id uuid, dietary_needs app.dietary_need[], has_allergies boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (l.person_id) l.person_id, a.roster_entry_id, r.engagement_id,
    case when s.id is not null then coalesce(w.dietary_needs, '{}') end,
    case when s.id is not null then w.allergies is not null else false end
  from app.fulfillment_lines l
  join app.advance_allocations a on a.id = l.allocation_id
  join app.engagement_roster_entries r on r.id = a.roster_entry_id
  left join app.work_detail_shares s on s.roster_entry_id = a.roster_entry_id and s.revoked_at is null and s.deleted_at is null
    and 'Dietary Needs' = any (s.categories)
  left join app.person_work_details w on w.person_id = l.person_id and w.deleted_at is null
  where l.fulfillment_id = p_fulfillment_id and l.deleted_at is null and l.person_id is not null
  order by l.person_id, s.shared_at desc nulls last;
$$;
comment on function private.catering_people(uuid) is 'The distinct people with live allocated lines on a catering fulfillment, with their roster entry and, only when their live share on that entry includes Dietary Needs, their dietary needs and whether they recorded allergies. Callers authorize and log.';
revoke all on function private.catering_people(uuid) from public, anon, authenticated;

create or replace function app.catering_counts(p_fulfillment_id uuid)
returns table (dietary_need text, headcount integer, suppressed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fulfillment app.fulfillments;
  v_medical boolean;
  v_person record;
begin
  perform private.require_person();
  select f.* into v_fulfillment from app.fulfillments f where f.id = p_fulfillment_id and f.deleted_at is null;
  if v_fulfillment.id is null or not private.can_on_project(v_fulfillment.project_id, 'hospitality.fulfillment.read') then
    raise exception using errcode = '42501', message = 'hospitality.fulfillment.read is required';
  end if;
  v_medical := private.can_on_project(v_fulfillment.project_id, 'data.restricted.read.medical');

  return query select null::text, count(*)::integer, false from private.catering_people(v_fulfillment.id);
  return query
    select n.need::text,
      case when count(c.person_id) < 5 then null else count(c.person_id)::integer end,
      count(c.person_id) < 5
    from unnest(enum_range(null::app.dietary_need)) n (need)
    left join private.catering_people(v_fulfillment.id) c on n.need = any (c.dietary_needs)
    group by n.need order by n.need;
  if v_medical then
    return query
      select 'Allergies'::text,
        case when count(*) filter (where c.has_allergies) < 5 then null else (count(*) filter (where c.has_allergies))::integer end,
        count(*) filter (where c.has_allergies) < 5
      from private.catering_people(v_fulfillment.id) c;
  end if;

  for v_person in select * from private.catering_people(v_fulfillment.id) c where c.dietary_needs is not null loop
    perform private.log_work_detail_event(v_person.person_id, 'dietary_needs.counted', v_fulfillment.org_id, v_person.engagement_id,
      array['Dietary Needs']::app.work_detail_category[], '{}', null, v_person.roster_entry_id);
    if v_medical and v_person.has_allergies then
      perform private.log_work_detail_event(v_person.person_id, 'allergies.counted', v_fulfillment.org_id, v_person.engagement_id,
        array['Dietary Needs']::app.work_detail_category[], '{}', null, v_person.roster_entry_id);
    end if;
  end loop;
end;
$$;
comment on function app.catering_counts(uuid) is 'A catering fulfillment''s roster counts (R7, owner decisions 4 and 5): hospitality.fulfillment.read on the project, else 42501. The row with dietary_need NULL is the headcount of distinct people with live allocated lines, never suppressed. One row per app.dietary_need counts the people whose live share on their roster entry includes Dietary Needs (Confidential), with headcount NULL and suppressed true below 5. An Allergies row counts the shared people with allergies only for holders of data.restricted.read.medical (Restricted). Every call logs one dietary_needs.counted row per shared person counted, and allergies.counted per person counted in the Allergies row, in the person''s access log. The BEO guest count stays the org''s own figure.';
revoke all on function app.catering_counts(uuid) from public, anon;
grant execute on function app.catering_counts(uuid) to authenticated, service_role;

-- Function calls inside a definer view run with the caller's execute privilege (as 2601 grants
-- private.engagement_principal), so signed-in users execute the helpers the views call. They take ids and read
-- through the owner; the private schema itself stays closed to them.
grant execute on function private.allocation_kind(app.advance_allocations) to authenticated;
grant execute on function private.allocation_offering_kind(app.advance_allocations) to authenticated;
