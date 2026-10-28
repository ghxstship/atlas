-- 2657_roster_travel_party.sql
-- R5 Project facts, parity addition G-175 (RRR-184, competitor parity audit 2026-10-28). The travel party of a project,
-- entered once by each rostered person (2654) and read by the hospitality desk next to what it has arranged: rooms,
-- pickups and passes. No new table or view.
--
--   * app.roster_travel_party(project): one object per rostered person the producer reads by its standing rule (live
--     entries Submitted, Accepted or Returned, on live engagements Onboarding to Closing, with Travel offered), with
--     the travel request, whether a room is assigned, a pickup booked and, for credentials.credential.read holders, a
--     pass issued. It needs hospitality.fulfillment.read, the Travel kind capability, and logs every travel value it
--     returns exactly as the producer path of app.roster_project_facts does.
--   * app.roster_travel_day_counts(project): arrivals, departures, people on site, rooms and pickups needed per day,
--     from the first arrival to the last departure, at most 120 days. Counts carry no value, yet each call logs one
--     project_facts.counted row per person counted and one audit event, as R7's catering counts do.
-- A person who declined their entry is not travelling, so they are left out.

create or replace function private.travel_party_entries(p_project_id uuid)
returns table (roster_entry_id uuid, engagement_id uuid, org_id uuid, person_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, e.id, e.org_id, private.roster_entry_person(r.id)
  from app.engagement_roster_entries r
  join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
  where e.project_id = p_project_id and r.deleted_at is null
    and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
    and r.entry_state in ('Submitted', 'Accepted', 'Returned') and r.person_response <> 'Declined'
    and private.roster_entry_person(r.id) is not null
    and private.project_fact_offered(e.id, 'Travel');
$$;

comment on function private.travel_party_entries(uuid) is 'The roster entries of a project''s travel party (R5, G-175): live entries Submitted, Accepted or Returned and not declined, of live engagements Onboarding to Closing with Travel offered, each with its resolved person.';
revoke all on function private.travel_party_entries(uuid) from public, anon, authenticated;

create or replace function private.assert_travel_party_reader(p_project_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_project_id is null or not private.can_on_project(p_project_id, 'hospitality.fulfillment.read') then
    raise exception using errcode = '42501', message = 'hospitality.fulfillment.read is required on the project';
  end if;
end;
$$;

comment on function private.assert_travel_party_reader(uuid) is 'Raises insufficient privilege unless the signed-in person holds hospitality.fulfillment.read on the project.';
revoke all on function private.assert_travel_party_reader(uuid) from public, anon, authenticated;

create or replace function app.roster_travel_party(p_project_id uuid)
returns setof jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_passes boolean;
  v_row record;
  v_travel app.roster_travel_requests;
  v_room record;
begin
  perform private.require_person();
  perform private.assert_travel_party_reader(p_project_id);
  select p.time_zone into v_zone from app.projects p where p.id = p_project_id;
  v_passes := private.can_on_project(p_project_id, 'credentials.credential.read');
  for v_row in
    select x.roster_entry_id, x.engagement_id, x.org_id, x.person_id, coalesce(a.name, ep.full_name) as party_name,
      pp.full_name as person_name, r.role_code, lower(r.arrival_window) as arrival_starts_at,
      upper(r.arrival_window) as arrival_ends_at, r.arrival_time_zone
    from private.travel_party_entries(p_project_id) x
    join app.engagement_roster_entries r on r.id = x.roster_entry_id
    join app.engagements e on e.id = x.engagement_id
    left join app.counterparties c on c.id = e.counterparty_id
    left join app.organizations a on a.id = c.organization_id
    left join app.people ep on ep.id = e.person_id
    left join app.people pp on pp.id = x.person_id
    order by pp.full_name, x.roster_entry_id
  loop
    select * into v_travel from app.roster_travel_requests t where t.roster_entry_id = v_row.roster_entry_id and t.deleted_at is null;
    select aa.check_in_on, aa.check_out_on, b.title into v_room
    from app.accommodation_assignments aa
    join app.accommodation_blocks b on b.id = aa.accommodation_block_id and b.deleted_at is null and b.project_id = p_project_id
    where aa.person_id = v_row.person_id and aa.deleted_at is null
    order by aa.check_in_on, aa.id limit 1;
    if v_travel.id is not null then
      perform private.log_project_fact_event(v_row.person_id, 'project_facts.viewed', v_row.org_id, v_row.engagement_id,
        v_row.roster_entry_id, array['Travel']::app.project_fact_kind[]);
      perform private.write_audit_event(v_row.org_id, 'project_facts.viewed', 'app.engagement_roster_entries', v_row.roster_entry_id,
        jsonb_build_object('fact_kinds', jsonb_build_array('Travel')));
    end if;
    return next jsonb_build_object(
      'roster_entry_id', v_row.roster_entry_id,
      'engagement_id', v_row.engagement_id,
      'party_name', v_row.party_name,
      'person_id', v_row.person_id,
      'person_name', v_row.person_name,
      'role_code', v_row.role_code,
      'arrival_starts_at', v_row.arrival_starts_at,
      'arrival_ends_at', v_row.arrival_ends_at,
      'arrival_time_zone', v_row.arrival_time_zone,
      'travel', private.roster_travel_value(v_travel),
      'room', jsonb_build_object('assigned', v_room.check_in_on is not null, 'check_in_on', v_room.check_in_on,
        'check_out_on', v_room.check_out_on, 'block_name', v_room.title),
      'pickup', jsonb_build_object('booked', exists (
        select 1 from app.travel_segments s
        where s.person_id = v_row.person_id and s.project_id = p_project_id and s.deleted_at is null and s.travel_mode = 'Ground'
          and (v_travel.inbound_on is null or (s.departs_at at time zone v_zone)::date = v_travel.inbound_on))),
      'pass', case when v_passes then jsonb_build_object('issued', exists (
        select 1 from app.credentials k
        where k.holder_person_id = v_row.person_id and k.engagement_id = v_row.engagement_id
          and k.revoked_at is null and k.deleted_at is null)) end);
  end loop;
end;
$$;

comment on function app.roster_travel_party(uuid) is 'The travel party of a project (R5, G-175), for hospitality.fulfillment.read holders (else 42501): one object per entry of private.travel_party_entries with the party, person, role and arrival, the travel request (airport names included) or NULL, room {assigned, check_in_on, check_out_on, block_name} from live accommodation assignments of the person on the project''s blocks, pickup {booked} from a live Ground travel segment of the person on the project departing on the inbound date in the project zone (any, while no inbound date), and pass {issued} from a live unrevoked credential of the engagement, NULL without credentials.credential.read. Each entry returned with a travel request writes project_facts.viewed (Travel) in the person''s access log and the producing org''s audit ledger.';

create or replace function private.travel_party_dates(p_project_id uuid)
returns table (roster_entry_id uuid, engagement_id uuid, org_id uuid, person_id uuid, inbound_on date, outbound_on date,
  needs_lodging boolean, needs_ground_transport boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select x.roster_entry_id, x.engagement_id, x.org_id, x.person_id, t.inbound_on, t.outbound_on, t.needs_lodging,
    t.needs_ground_transport
  from private.travel_party_entries(p_project_id) x
  join app.roster_travel_requests t on t.roster_entry_id = x.roster_entry_id and t.deleted_at is null
  where t.inbound_on is not null or t.outbound_on is not null;
$$;

comment on function private.travel_party_dates(uuid) is 'The travel dates and needs of a project''s travel party with a dated travel request: the rows app.roster_travel_day_counts counts.';
revoke all on function private.travel_party_dates(uuid) from public, anon, authenticated;

create or replace function app.roster_travel_day_counts(p_project_id uuid)
returns table (
  day date,
  arriving integer,
  departing integer,
  on_site integer,
  rooms_needed integer,
  pickups_needed integer,
  truncated boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_first date;
  v_last date;
  v_truncated boolean := false;
  v_row record;
  v_org uuid;
begin
  perform private.require_person();
  perform private.assert_travel_party_reader(p_project_id);
  select p.org_id into v_org from app.projects p where p.id = p_project_id;
  select min(coalesce(t.inbound_on, t.outbound_on)), max(coalesce(t.outbound_on, t.inbound_on)) into v_first, v_last
  from private.travel_party_dates(p_project_id) t;
  if v_first is not null and v_last - v_first >= 120 then
    v_last := v_first + 119;
    v_truncated := true;
  end if;

  for v_row in select * from private.travel_party_dates(p_project_id) loop
    perform private.log_project_fact_event(v_row.person_id, 'project_facts.counted', v_row.org_id, v_row.engagement_id,
      v_row.roster_entry_id, array['Travel']::app.project_fact_kind[]);
  end loop;
  perform private.write_audit_event(v_org, 'project_facts.counted', 'app.projects', p_project_id,
    jsonb_build_object('fact_kinds', jsonb_build_array('Travel'), 'people', (select count(*) from private.travel_party_dates(p_project_id))));

  if v_first is null then
    return;
  end if;
  return query
    with t as (select * from private.travel_party_dates(p_project_id))
    select d::date,
      (select count(*)::integer from t where t.inbound_on = d::date),
      (select count(*)::integer from t where t.outbound_on = d::date),
      (select count(*)::integer from t
       where t.inbound_on <= d::date and coalesce(t.outbound_on, t.inbound_on) >= d::date),
      (select count(*)::integer from t
       where t.needs_lodging and t.inbound_on <= d::date and t.outbound_on > d::date),
      (select count(*)::integer from t where t.needs_ground_transport and t.inbound_on = d::date),
      v_truncated
    from generate_series(v_first, v_last, interval '1 day') d
    order by 1;
end;
$$;

comment on function app.roster_travel_day_counts(uuid) is 'Daily travel counts of a project''s travel party (R5, G-175), for hospitality.fulfillment.read holders (else 42501): per day from the first arrival to the last departure, people arriving and departing, on site (arrival to departure day, inclusive), rooms needed (nights from arrival to the night before departure, with needs_lodging) and pickups needed (arrivals with needs_ground_transport). At most 120 days; truncated is true on every row when the range was cut. Each call writes one project_facts.counted row (Travel) per person counted and one audit event.';

revoke all on function app.roster_travel_party(uuid) from public, anon;
revoke all on function app.roster_travel_day_counts(uuid) from public, anon;
grant execute on function app.roster_travel_party(uuid) to authenticated, service_role;
grant execute on function app.roster_travel_day_counts(uuid) to authenticated, service_role;
