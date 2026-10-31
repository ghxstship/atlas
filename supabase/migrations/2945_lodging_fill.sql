-- 2945_lodging_fill.sql
-- B5 Travel, lodging, ground transport and local contacts (RRR-229, ADR 0144 decisions 2 and 6; parity gaps G-66 and
-- G-67). How full the project's hotel blocks are on each night, which acts still have no room, and what the rooms cost
-- against the budget line they draw on. Every figure is computed on read; nothing is booked with a hotel, paid, or
-- written to a budget line, an expense or the ledger (XOS never holds funds).
--
--   * app.accommodation_block_nights (security invoker): one row per live block and night, rooms held, assigned and free.
--     It counts exactly what private.block_peak_occupancy (0440) counts, so the matrix and the block's own per-night
--     table never disagree.
--   * app.acts_without_rooms(project): Artist engagements in Onboarding to Closing with Lodging offered none of whose
--     people (the engaged person and the persons of live roster entries, not Withdrawn, not Declined) holds a live
--     room on the project's blocks. It reads no project fact value, so it logs nothing.
--   * app.accommodation_blocks.budget_line_id: the budget line a block draws on, of a live budget of the block's own
--     project. Linking needs finance.budget.read, and a priced block keeps the budget's currency.
--   * app.budget_line_lodging (security invoker): per live budget line, the linked blocks' held and assigned room nights
--     and amounts. It follows P4's silence rule (app.budget_line_commitments): a reader without
--     hospitality.fulfillment.read on the project sees every figure withheld, never a partial sum. Blocks priced in
--     another currency are counted and never summed. Lodging is not folded into P4's committed amount.

-- Nights -----------------------------------------------------------------------------------------------------------------

create view app.accommodation_block_nights with (security_invoker = on) as
select b.id as block_id, b.org_id, b.project_id, b.block_number, b.title, n.night, b.rooms_held,
  a.assigned, b.rooms_held - a.assigned as free, b.release_on, b.nightly_rate_minor, b.currency_code
from app.accommodation_blocks b
cross join lateral (
  select d::date as night from pg_catalog.generate_series(b.check_in_on, b.check_out_on - 1, interval '1 day') d
) n
cross join lateral (
  select count(*)::integer as assigned from app.accommodation_assignments x
  where x.accommodation_block_id = b.id and x.deleted_at is null and x.check_in_on <= n.night and x.check_out_on > n.night
) a
where b.deleted_at is null;

call private.describe('app.accommodation_block_nights', 'One row per live accommodation block and night it holds (B5, G-66): rooms held, rooms assigned to live stays covering the night, and rooms free. Computed on read with the same count as private.block_peak_occupancy, never stored. Rows follow the blocks'' policies (hospitality.fulfillment.read on the project).', array[
  'block_id', 'Accommodation block.',
  'org_id', 'Owning org.',
  'project_id', 'Project.',
  'block_number', 'Number of the block within the project.',
  'title', 'Block name.',
  'night', 'Night held (hotel local date), from check-in to the night before check-out.',
  'rooms_held', 'Rooms the block holds each night.',
  'assigned', 'Live room assignments covering the night.',
  'free', 'Rooms held and not assigned on the night.',
  'release_on', 'Cutoff date when unassigned rooms return to the hotel.',
  'nightly_rate_minor', 'Contracted nightly rate in minor units; NULL is unpriced.',
  'currency_code', 'Currency of the rate.'
]);

revoke all on app.accommodation_block_nights from public, anon;
grant select on app.accommodation_block_nights to authenticated, service_role;
-- 1650 grants the backup login SELECT on every new relation; pg_dump never reads a view's rows.
revoke select on app.accommodation_block_nights from xos_backup;

-- Acts without rooms -----------------------------------------------------------------------------------------------------

create or replace function app.acts_without_rooms(p_project_id uuid)
returns table (
  engagement_id uuid,
  act_name text,
  engagement_state app.engagement_state,
  people_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if p_project_id is null or not private.can_on_project(p_project_id, 'hospitality.fulfillment.read') then
    raise exception using errcode = '42501', message = 'hospitality.fulfillment.read is required on the project';
  end if;
  return query
    with acts as (
      select e.id, e.engagement_state, coalesce(o.name, ep.full_name) as act_name
      from app.engagements e
      left join app.counterparties c on c.id = e.counterparty_id
      left join app.organizations o on o.id = c.organization_id
      left join app.people ep on ep.id = e.person_id
      where e.project_id = p_project_id and e.deleted_at is null and e.role_type = 'Artist'
        and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
        and private.project_fact_offered(e.id, 'Lodging')
    ),
    people as (
      select a.id as engagement_id, e.person_id
      from acts a join app.engagements e on e.id = a.id
      where e.person_id is not null
      union
      select a.id, rp.person_id
      from acts a
      join app.engagement_roster_entries r on r.engagement_id = a.id
      join private.roster_people rp on rp.roster_entry_id = r.id
      where r.deleted_at is null and r.entry_state <> 'Withdrawn' and r.person_response <> 'Declined' and rp.person_id is not null
    )
    select a.id, a.act_name, a.engagement_state, (select count(*)::integer from people p where p.engagement_id = a.id)
    from acts a
    where not exists (
      select 1 from people p
      join app.accommodation_assignments x on x.person_id = p.person_id and x.deleted_at is null
      join app.accommodation_blocks b on b.id = x.accommodation_block_id and b.deleted_at is null and b.project_id = p_project_id
      where p.engagement_id = a.id)
    order by a.act_name, a.id;
end;
$$;

comment on function app.acts_without_rooms(uuid) is 'Artist engagements of the project in Onboarding to Closing with Lodging offered (B5, G-66) none of whose people (the engaged person and the persons of live roster entries, not Withdrawn, not Declined) holds a live room assignment on the project''s live blocks, with the act''s name (the supplying account, else the engaged person), its state and how many people it has. Needs hospitality.fulfillment.read on the project (42501 otherwise). Reads no project fact value, so it logs nothing.';
revoke all on function app.acts_without_rooms(uuid) from public, anon;
grant execute on function app.acts_without_rooms(uuid) to authenticated, service_role;

-- Blocks draw on a budget line ------------------------------------------------------------------------------------------

alter table app.accommodation_blocks add column budget_line_id uuid references app.budget_lines (id);
create index accommodation_blocks_budget_line_id_idx on app.accommodation_blocks (budget_line_id);
call private.add_cross_org_references('app.accommodation_blocks', array['app.budget_lines', 'budget_line_id']);
comment on column app.accommodation_blocks.budget_line_id is 'Budget line the block''s cost draws on, of a live budget of the same project; held and assigned amounts are derived (app.budget_line_lodging), never written to the line. Linking needs finance.budget.read, and a priced block keeps the budget''s currency.';

create or replace function private.guard_block_budget_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_currency char(3);
begin
  if new.budget_line_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.budget_line_id is not distinct from old.budget_line_id
     and new.currency_code is not distinct from old.currency_code
     and new.nightly_rate_minor is not distinct from old.nightly_rate_minor then
    return new;
  end if;
  if (tg_op = 'INSERT' or new.budget_line_id is distinct from old.budget_line_id)
     and auth.uid() is not null and not private.can_on_project(new.project_id, 'finance.budget.read') then
    raise exception using errcode = '42501', message = 'finance.budget.read is required to link a block to a budget line';
  end if;
  select b.project_id, b.currency_code into v_project, v_currency
  from app.budget_lines bl join app.budgets b on b.id = bl.budget_id
  where bl.id = new.budget_line_id and bl.deleted_at is null and b.deleted_at is null;
  if v_project is null or v_project <> new.project_id then
    perform private.refuse('accommodation_block_budget_project', 'A block draws on a live budget line of its own project.');
  end if;
  if new.nightly_rate_minor is not null and new.currency_code is distinct from v_currency then
    perform private.refuse('accommodation_block_budget_currency', format('The budget is in %s; a priced block keeps its currency.', v_currency));
  end if;
  return new;
end;
$$;

comment on function private.guard_block_budget_line() is 'When a block''s budget line, currency or rate changes and it names a line: linking needs finance.budget.read on the project (42501); the line is a live line of a live budget of the block''s project (accommodation_block_budget_project), and a priced block is in the budget''s currency (accommodation_block_budget_currency).';
revoke all on function private.guard_block_budget_line() from public, anon, authenticated;
create trigger t41_guard_block_budget_line before insert or update on app.accommodation_blocks
  for each row execute function private.guard_block_budget_line();

-- Lodging against the budget line -------------------------------------------------------------------------------------

create view app.budget_line_lodging with (security_invoker = on) as
select bl.id as budget_line_id, b.id as budget_id, b.project_id, b.currency_code,
  case when w.is_withheld then null else coalesce(l.block_count, 0) end::integer as block_count,
  case when w.is_withheld then null else coalesce(l.other_currency_block_count, 0) end::integer as other_currency_block_count,
  case when w.is_withheld then null else coalesce(l.held_room_nights, 0) end::bigint as held_room_nights,
  case when w.is_withheld or coalesce(l.unpriced_count, 0) > 0 then null else coalesce(l.held_minor, 0) end::bigint as held_minor,
  case when w.is_withheld then null else coalesce(l.assigned_room_nights, 0) end::bigint as assigned_room_nights,
  case when w.is_withheld or coalesce(l.unpriced_count, 0) > 0 then null else coalesce(l.assigned_minor, 0) end::bigint as assigned_minor,
  w.is_withheld as is_lodging_withheld
from app.budget_lines bl
join app.budgets b on b.id = bl.budget_id
cross join lateral (
  select b.project_id not in (select private.project_ids_with('hospitality.fulfillment.read')) as is_withheld
) w
left join lateral (
  select
    count(*) filter (where k.counted) as block_count,
    count(*) filter (where not k.counted) as other_currency_block_count,
    count(*) filter (where k.counted and k.nightly_rate_minor is null) as unpriced_count,
    sum(k.rooms_held::bigint * (k.check_out_on - k.check_in_on)) filter (where k.counted) as held_room_nights,
    sum(k.rooms_held::bigint * (k.check_out_on - k.check_in_on) * k.nightly_rate_minor) filter (where k.counted) as held_minor,
    sum(k.assigned_nights) filter (where k.counted) as assigned_room_nights,
    sum(k.assigned_nights * k.nightly_rate_minor) filter (where k.counted) as assigned_minor
  from (
    select x.*, (x.nightly_rate_minor is null or x.currency_code = b.currency_code) as counted,
      (select coalesce(sum(a.check_out_on - a.check_in_on), 0)::bigint from app.accommodation_assignments a
       where a.accommodation_block_id = x.id and a.deleted_at is null) as assigned_nights
    from app.accommodation_blocks x
    where x.budget_line_id = bl.id and x.deleted_at is null
  ) k
) l on true
where bl.deleted_at is null and b.deleted_at is null
  and (w.is_withheld or coalesce(l.block_count, 0) + coalesce(l.other_currency_block_count, 0) > 0);

call private.describe('app.budget_line_lodging', 'Lodging drawn on each live budget line of a live budget (B5, G-67): the live accommodation blocks linked to the line, their held room nights (rooms held times nights) and assigned room nights (live assignments), and those times the nightly rate in the budget''s currency. Derived on read; nothing is written to the line, an expense or the ledger, and it is not part of committed. Withheld from a reader who cannot read the project''s blocks (hospitality.fulfillment.read), never shown partial. Lines without a linked block are left out, except for a withheld reader.', array[
  'budget_line_id', 'Budget line.',
  'budget_id', 'Budget of the line.',
  'project_id', 'Project of the budget.',
  'currency_code', 'Currency of the budget, and of every amount summed.',
  'block_count', 'Linked live blocks summed: unpriced or in the budget''s currency. NULL when withheld.',
  'other_currency_block_count', 'Linked live blocks priced in another currency: counted, never summed. NULL when withheld.',
  'held_room_nights', 'Rooms held times nights of the summed blocks. NULL when withheld.',
  'held_minor', 'Held room nights times the nightly rate, in minor units. NULL when withheld or when a summed block is unpriced.',
  'assigned_room_nights', 'Nights of the live room assignments on the summed blocks. NULL when withheld.',
  'assigned_minor', 'Assigned room nights times the block''s nightly rate, in minor units. NULL when withheld or when a summed block is unpriced.',
  'is_lodging_withheld', 'True when the reader lacks hospitality.fulfillment.read on the project, so every figure is NULL rather than partial.'
]);

revoke all on app.budget_line_lodging from public, anon;
grant select on app.budget_line_lodging to authenticated, service_role;
revoke select on app.budget_line_lodging from xos_backup;
