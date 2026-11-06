-- 2986_crew_shortages.sql
-- B9 (RRR-233; ADR 0148; parity gap G-119): one cross-event list of what is not covered yet, crew shifts and vendor
-- labor alike, for Atlas's Crew > Shortages page. Computed at read time from the tables that own each fact; nothing is
-- stored, so the page never drifts from the shifts.
--
-- app.crew_shortages(org, from, to): shifts and lines starting on those days (in each shift's own time zone; at most 62
-- days, crew_shortages_range). Shift rows only on projects where the caller reads shifts (crew.shift.read), vendor rows
-- only where they read purchase orders (procurement.po.read). Kinds:
--   open                no worker, Draft or Published; a shift held for an unfilled position names it in detail
--   agency_unfilled     an agency slot (R12) nobody on the agency's roster holds; party_name is the agency
--   awaiting_answer     a live Published shift with a worker person (the lifecycle decides it; the Waiting Offer only
--                       gives asked_at)
--   not_reconfirmed     a Waiting or No Answer "Still coming?" (2981) of the shift's current worker
--   reconfirm_declined  a Declined "Still coming?" whose shift kept its worker (scheduling.reconfirm_reopen off)
--   no_show             a live no-show (2982) without a replacement someone holds
--   vendor_unconfirmed  lines of Approved or Sent purchase orders for a labor element (xpms.elements.kind 'labor') the
--                       vendor has not acknowledged (app.po_line_supply's rule), on projects whose site window
--                       (private.project_site_window, 2683) overlaps the dates; party_name is the vendor
-- A vendor row's start is the later of the project's site start and the first day asked, so it buckets inside the range.
-- There is no map (S5-29 stays deferred).
--
-- private.may_read_worker_name: who may know a worker by name on these lists. app.people's policy, and Atlas's pages,
-- show a member or engaged person to anyone in the org (1275), and a roster person only to advancing.packet.read holders
-- (2637, app.roster_entry_people); a definer read through private.roster_people must not widen that.

create or replace function private.may_read_worker_name(p_person_id uuid, p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_person_id in (select private.visible_person_ids())
    or exists (select 1 from app.engagements e
               where e.person_id = p_person_id and e.deleted_at is null and e.org_id in (select private.my_org_ids()))
    or p_project_id in (select private.project_ids_with('advancing.packet.read')),
    false);
$$;

comment on function private.may_read_worker_name(uuid, uuid) is 'B9: true when the signed-in person may know this worker by name on a crew list: the person is someone private.visible_person_ids shows (themself or a member of their orgs), holds an engagement in one of their orgs (1275''s rule), or the project is one where they read the advancing packet (2637, the rule for a roster person''s name).';
revoke all on function private.may_read_worker_name(uuid, uuid) from public, anon;
-- Views that call it run the check with the caller's privilege, so signed-in users need this.
grant execute on function private.may_read_worker_name(uuid, uuid) to authenticated, service_role;

create or replace function app.crew_shortages(p_org_id uuid, p_from date, p_to date)
returns table (
  project_id uuid,
  project_name text,
  kind text,
  shift_id uuid,
  po_line_id uuid,
  purchase_order_id uuid,
  role_code text,
  starts_at timestamptz,
  ends_at timestamptz,
  time_zone text,
  party_name text,
  person_name text,
  quantity numeric,
  detail text,
  asked_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 61 then
    perform private.refuse('crew_shortages_range', 'Pick a range of 1 to 62 days.');
  end if;
  return query
  with shifts as (
    select s.*, pr.name as project_name,
      private.shift_worker_person_id(s.membership_id, s.engagement_id, s.roster_entry_id) as worker_person_id
    from app.shifts s
    join app.projects pr on pr.id = s.project_id and pr.deleted_at is null
    where s.org_id = p_org_id and s.deleted_at is null and s.shift_state <> 'Canceled'
      and s.project_id in (select private.project_ids_with('crew.shift.read'))
      and (s.starts_at at time zone s.time_zone)::date between p_from and p_to
  )
  -- Open shifts, held for a position or not.
  select s.project_id, s.project_name, 'open'::text, s.id, null::uuid, null::uuid, s.role_code::text, s.starts_at, s.ends_at, s.time_zone,
    null::text, null::text, null::numeric,
    (select pos.title from app.project_positions pos where pos.id = s.project_position_id and pos.deleted_at is null), null::timestamptz
  from shifts s
  where s.membership_id is null and s.engagement_id is null and s.roster_entry_id is null and s.shift_state in ('Draft', 'Published')
  union all
  -- Agency slots nobody on the roster holds.
  select s.project_id, s.project_name, 'agency_unfilled', s.id, null, null, s.role_code::text, s.starts_at, s.ends_at, s.time_zone,
    (select o.name from app.engagements e join app.counterparties c on c.id = e.counterparty_id
     join app.organizations o on o.id = c.organization_id where e.id = s.engagement_id),
    null, null,
    (select pos.title from app.project_positions pos where pos.id = s.project_position_id and pos.deleted_at is null), null
  from shifts s
  where s.engagement_id is not null and private.is_agency_slot_engagement(s.engagement_id)
  union all
  -- Published to someone who has not answered.
  select s.project_id, s.project_name, 'awaiting_answer', s.id, null, null, s.role_code::text, s.starts_at, s.ends_at, s.time_zone,
    null, (select p.full_name from app.people p where p.id = s.worker_person_id and private.may_read_worker_name(p.id, s.project_id)), null, null,
    (select r.asked_at from app.shift_responses r
     where r.shift_id = s.id and r.ask_kind = 'Offer' and r.answer = 'Waiting' and r.deleted_at is null)
  from shifts s
  where s.shift_state = 'Published' and s.worker_person_id is not null
  union all
  -- "Still coming?" unanswered, or declined while the worker stayed on.
  select s.project_id, s.project_name,
    case when r.answer = 'Declined' then 'reconfirm_declined' else 'not_reconfirmed' end,
    s.id, null, null, s.role_code::text, s.starts_at, s.ends_at, s.time_zone,
    null, (select p.full_name from app.people p where p.id = s.worker_person_id and private.may_read_worker_name(p.id, s.project_id)), null,
    case when r.answer = 'Declined' then r.reason end, r.asked_at
  from shifts s
  join app.shift_responses r on r.shift_id = s.id and r.ask_kind = 'Reconfirmation' and r.deleted_at is null
    and r.person_id = s.worker_person_id and r.answer in ('Waiting', 'No Answer', 'Declined')
  union all
  -- No-shows nobody has replaced.
  select s.project_id, s.project_name, 'no_show', s.id, null, null, s.role_code::text, s.starts_at, s.ends_at, s.time_zone,
    null, (select p.full_name from app.people p where p.id = s.worker_person_id and private.may_read_worker_name(p.id, s.project_id)), null, n.reason, null
  from shifts s
  join app.shift_no_shows n on n.shift_id = s.id and n.deleted_at is null
  where n.replacement_shift_id is null or not exists (
    select 1 from app.shifts x where x.id = n.replacement_shift_id and x.deleted_at is null and x.shift_state <> 'Canceled'
      and private.shift_worker_person_id(x.membership_id, x.engagement_id, x.roster_entry_id) is not null)
  union all
  -- Vendor labor the vendor has not acknowledged, on projects on site in these dates.
  select pr.id, pr.name, 'vendor_unconfirmed', null, l.id, po.id, null,
    greatest(lower(w.site), p_from::timestamp at time zone pr.time_zone), upper(w.site), pr.time_zone,
    (select o.name from app.vendors v join app.counterparties c on c.id = v.counterparty_id
     join app.organizations o on o.id = c.organization_id where v.id = po.vendor_id),
    null, l.quantity, l.description, null
  from app.po_lines l
  join app.purchase_orders po on po.id = l.purchase_order_id and po.deleted_at is null and po.po_state in ('Approved', 'Sent')
  join app.projects pr on pr.id = po.project_id and pr.deleted_at is null
  join xpms.elements el on el.element_id = l.element_id and el.kind = 'labor'
  cross join lateral (select private.project_site_window(pr.id) as site) w
  where l.deleted_at is null and po.org_id = p_org_id
    and pr.id in (select private.project_ids_with('procurement.po.read'))
    and not exists (select 1 from app.po_acknowledgments a where a.purchase_order_id = po.id and a.deleted_at is null)
    -- A project with no Build, Strike or dates has an unbounded window, which overlaps everything and starts nowhere.
    and w.site is not null and not lower_inf(w.site)
    and w.site && tstzrange(p_from::timestamp at time zone pr.time_zone, (p_to + 1)::timestamp at time zone pr.time_zone, '[)')
  order by 8 nulls last, 2, 3, 4;
end;
$$;

comment on function app.crew_shortages(uuid, date, date) is 'What is not covered yet in an org between two days (B9, ADR 0148; at most 62 days, crew_shortages_range), for Crew > Shortages: open shifts (detail names a position they are held for), unfilled agency slots, shifts published to someone who has not answered (asked_at from the Waiting Offer), unanswered or declined "Still coming?" asks of the current worker, no-shows without a replacement someone holds, all on projects where the caller reads shifts, and unacknowledged labor lines of Approved or Sent purchase orders on projects on site in those days where they read purchase orders. A worker''s name appears only under private.may_read_worker_name. Computed at read time; ordered by start, then project.';
revoke all on function app.crew_shortages(uuid, date, date) from public, anon;
grant execute on function app.crew_shortages(uuid, date, date) to authenticated, service_role;
