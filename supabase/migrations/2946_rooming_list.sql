-- 2946_rooming_list.sql
-- B5 Travel, lodging, ground transport and local contacts (RRR-229, ADR 0144 decision 5; parity gap G-67). The rooming
-- list: who on the project's travel party needs a room, the nights they need, the rooms they hold and what is missing.
-- Stays are suggested from what the project already knows and never stored.
--
--   * private.person_access_days: the project-zone days a person's live, unrevoked credentials of the engagement let them
--     in. valid_from defaults to the issue time (0352), so days are clamped to the project's starts_on and ends_on where
--     set; an open-ended credential runs to ends_on, else covers its first day only; the last day of a bounded one is
--     the day of valid_to less a microsecond. When the credential's category has live access grid windows (0352), only
--     days a window touches count. At most 120 days. B8 may later reshape access windows (ADR 0144).
--   * private.suggested_stays: each run of consecutive access days becomes one stay, check-in on the first day and
--     check-out the day after the last (source Credentials). With no access day, the travel request's inbound to
--     outbound dates when outbound is after inbound (source Travel). Access days reveal pass validity, which R5 shows
--     only to credentials.credential.read holders (2657), so a reader without it always gets the travel-date fallback.
--   * app.rooming_list(project): the entries of private.travel_party_entries (Travel offered) whose travel request needs
--     lodging and whose engagement offers Lodging. People whose engagement offers Lodging but not Travel cannot appear:
--     R5 asks needs_lodging only on the travel request (ADR 0144 decision 5). Each returned entry is logged exactly as
--     app.roster_travel_party logs it (2657): project_facts.viewed (Travel) in the person's access log and one audit
--     event. lodging_allocation_id names an Approved allocation of a block for the entry not yet fully issued, so
--     Atlas opens R7's Issue dialog for it (R5 correction 8).

create or replace function private.person_access_days(p_project_id uuid, p_person_id uuid, p_engagement_id uuid)
returns setof date
language sql
stable
security definer
set search_path = ''
as $$
  with project as (
    select p.id, p.time_zone, p.starts_on, p.ends_on from app.projects p where p.id = p_project_id
  ),
  spans as (
    select k.credential_category_id,
      greatest(private.zone_date(k.valid_from, pr.time_zone), coalesce(pr.starts_on, '-infinity'::date)) as first_day,
      least(case when k.valid_to is null then coalesce(pr.ends_on, private.zone_date(k.valid_from, pr.time_zone))
                 else private.zone_date(k.valid_to - interval '1 microsecond', pr.time_zone) end,
            coalesce(pr.ends_on, 'infinity'::date)) as last_day,
      pr.time_zone
    from app.credentials k
    cross join project pr
    where k.holder_person_id = p_person_id and k.engagement_id = p_engagement_id and k.project_id = p_project_id
      and k.revoked_at is null and k.deleted_at is null
  ),
  days as (
    select distinct d::date as day
    from spans s
    cross join lateral pg_catalog.generate_series(s.first_day, least(s.last_day, s.first_day + 119), interval '1 day') d
    where s.last_day >= s.first_day
      and (not exists (select 1 from app.access_grid g where g.credential_category_id = s.credential_category_id and g.deleted_at is null)
        or exists (select 1 from app.access_grid g
                   where g.credential_category_id = s.credential_category_id and g.deleted_at is null
                     and private.zone_date(g.window_starts_at, s.time_zone) <= d::date
                     and private.zone_date(g.window_ends_at - interval '1 microsecond', s.time_zone) >= d::date))
  )
  select day from days order by day limit 120;
$$;

comment on function private.person_access_days(uuid, uuid, uuid) is 'The project-zone days the person''s live, unrevoked credentials of the engagement on the project let them in, clamped to the project''s starts_on and ends_on where set: an open-ended credential runs to ends_on (else its first day only), a bounded one to the day of valid_to less a microsecond. When a credential''s category has live access grid windows, only the days a window touches. At most 120 days, in order.';
revoke all on function private.person_access_days(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function private.suggested_stays(
  p_project_id uuid,
  p_person_id uuid,
  p_engagement_id uuid,
  p_inbound_on date,
  p_outbound_on date,
  p_use_credentials boolean
)
returns table (check_in_on date, check_out_on date, source text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_use_credentials then
    return query
      select min(a.day), max(a.day) + 1, 'Credentials'::text
      from (
        select d.day, d.day - (row_number() over (order by d.day))::integer as run
        from private.person_access_days(p_project_id, p_person_id, p_engagement_id) d (day)
      ) a
      group by a.run
      order by 1;
    if found then
      return;
    end if;
  end if;
  if p_inbound_on is not null and p_outbound_on is not null and p_outbound_on > p_inbound_on then
    return query select p_inbound_on, p_outbound_on, 'Travel'::text;
  end if;
end;
$$;

comment on function private.suggested_stays(uuid, uuid, uuid, date, date, boolean) is 'Stays suggested for a person on the project, never stored: with p_use_credentials, each run of consecutive access days (private.person_access_days; a gap of a day or more splits runs) as check-in on the first day and check-out the day after the last (source Credentials); otherwise, or with no access day, the travel request''s inbound to outbound dates when outbound is after inbound (source Travel). No row when neither gives dates.';
revoke all on function private.suggested_stays(uuid, uuid, uuid, date, date, boolean) from public, anon, authenticated;

create or replace function app.rooming_list(p_project_id uuid)
returns setof jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_creds boolean;
  v_row record;
  v_suggested jsonb;
  v_assigned jsonb;
  v_needed integer;
  v_uncovered integer;
  v_cost jsonb;
  v_allocation uuid;
begin
  perform private.require_person();
  perform private.assert_travel_party_reader(p_project_id);
  v_creds := private.can_on_project(p_project_id, 'credentials.credential.read');
  for v_row in
    select x.roster_entry_id, x.engagement_id, x.org_id, x.person_id, coalesce(a.name, ep.full_name) as party_name,
      pp.full_name as person_name, r.role_code, t.inbound_on, t.outbound_on
    from private.travel_party_entries(p_project_id) x
    join app.roster_travel_requests t on t.roster_entry_id = x.roster_entry_id and t.deleted_at is null and t.needs_lodging
    join app.engagement_roster_entries r on r.id = x.roster_entry_id
    join app.engagements e on e.id = x.engagement_id
    left join app.counterparties c on c.id = e.counterparty_id
    left join app.organizations a on a.id = c.organization_id
    left join app.people ep on ep.id = e.person_id
    left join app.people pp on pp.id = x.person_id
    where private.project_fact_offered(x.engagement_id, 'Lodging')
    order by pp.full_name, x.roster_entry_id
  loop
    select coalesce(jsonb_agg(jsonb_build_object('check_in_on', s.check_in_on, 'check_out_on', s.check_out_on, 'source', s.source)
      order by s.check_in_on), '[]'::jsonb) into v_suggested
    from private.suggested_stays(p_project_id, v_row.person_id, v_row.engagement_id, v_row.inbound_on, v_row.outbound_on, v_creds) s;

    select coalesce(jsonb_agg(jsonb_build_object('assignment_id', aa.id, 'block_id', b.id, 'block_title', b.title,
      'check_in_on', aa.check_in_on, 'check_out_on', aa.check_out_on, 'allocation_id', aa.allocation_id)
      order by aa.check_in_on, aa.id), '[]'::jsonb) into v_assigned
    from app.accommodation_assignments aa
    join app.accommodation_blocks b on b.id = aa.accommodation_block_id and b.deleted_at is null and b.project_id = p_project_id
    where aa.person_id = v_row.person_id and aa.deleted_at is null;

    select count(*)::integer, count(*) filter (where not exists (
        select 1 from app.accommodation_assignments aa
        join app.accommodation_blocks b on b.id = aa.accommodation_block_id and b.deleted_at is null and b.project_id = p_project_id
        where aa.person_id = v_row.person_id and aa.deleted_at is null and aa.check_in_on <= n.night and aa.check_out_on > n.night))::integer
      into v_needed, v_uncovered
    from (select distinct d::date as night
          from jsonb_to_recordset(v_suggested) as s (check_in_on date, check_out_on date, source text)
          cross join lateral pg_catalog.generate_series(s.check_in_on, s.check_out_on - 1, interval '1 day') d) n;

    select coalesce(jsonb_agg(jsonb_build_object('currency_code', c.currency_code, 'nights', c.nights, 'amount_minor', c.amount_minor)
      order by c.currency_code nulls last), '[]'::jsonb) into v_cost
    from (
      select b.currency_code, sum(aa.check_out_on - aa.check_in_on)::integer as nights,
        case when bool_or(b.nightly_rate_minor is null) then null
             else sum((aa.check_out_on - aa.check_in_on)::bigint * b.nightly_rate_minor) end as amount_minor
      from app.accommodation_assignments aa
      join app.accommodation_blocks b on b.id = aa.accommodation_block_id and b.deleted_at is null and b.project_id = p_project_id
      where aa.person_id = v_row.person_id and aa.deleted_at is null
      group by b.currency_code
    ) c;

    select a.id into v_allocation
    from app.advance_allocations a
    join private.advance_allocation_status_rows s on s.allocation_id = a.id
    where a.roster_entry_id = v_row.roster_entry_id and a.accommodation_block_id is not null and a.allocation_state = 'Approved'
      and a.deleted_at is null and coalesce(s.issued_quantity, 0) < a.quantity
    order by a.created_at, a.id limit 1;

    perform private.log_project_fact_event(v_row.person_id, 'project_facts.viewed', v_row.org_id, v_row.engagement_id,
      v_row.roster_entry_id, array['Travel']::app.project_fact_kind[]);
    perform private.write_audit_event(v_row.org_id, 'project_facts.viewed', 'app.engagement_roster_entries', v_row.roster_entry_id,
      jsonb_build_object('fact_kinds', jsonb_build_array('Travel')));

    return next jsonb_build_object(
      'roster_entry_id', v_row.roster_entry_id,
      'engagement_id', v_row.engagement_id,
      'party_name', v_row.party_name,
      'person_id', v_row.person_id,
      'person_name', v_row.person_name,
      'role_code', v_row.role_code,
      'suggested_stays', v_suggested,
      'assigned_stays', v_assigned,
      'uncovered_nights', v_uncovered,
      'status', case
        when v_needed = 0 then 'No Dates'
        when v_uncovered = 0 then 'Covered'
        when v_uncovered = v_needed then 'Missing'
        else 'Partial' end,
      'cost', v_cost,
      'lodging_allocation_id', v_allocation);
  end loop;
end;
$$;

comment on function app.rooming_list(uuid) is 'The rooming list of a project (B5, G-67), for hospitality.fulfillment.read holders (else 42501): one object per entry of private.travel_party_entries whose travel request needs lodging and whose engagement offers Lodging, with the party, person and role; suggested_stays [{check_in_on, check_out_on, source}] from credential access days (Credentials, only for credentials.credential.read holders) or the travel dates (Travel); assigned_stays [{assignment_id, block_id, block_title, check_in_on, check_out_on, allocation_id}] from live assignments on the project''s live blocks; uncovered_nights, the suggested nights no assignment covers; status No Dates (nothing suggested), Covered, Missing (no suggested night covered) or Partial; cost [{currency_code, nights, amount_minor}] per currency of the assigned nights times the block''s rate, amount NULL when a block is unpriced; and lodging_allocation_id, an Approved block allocation of the entry not yet fully issued. Each entry returned writes project_facts.viewed (Travel) in the person''s access log and the producing org''s audit ledger, as app.roster_travel_party does.';

revoke all on function app.rooming_list(uuid) from public, anon;
grant execute on function app.rooming_list(uuid) to authenticated, service_role;
