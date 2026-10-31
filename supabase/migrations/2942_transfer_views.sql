-- 2942_transfer_views.sql
-- B5 Travel, lodging, ground transport and local contacts (RRR-229, ADR 0144; parity gap G-33). What the desk, the
-- drivers and the people riding read about ground transfers (2941). Status and warnings are computed on every read,
-- never stored.
--
--   * hospitality.transfer_turnaround_minutes (packages/schemas/settings/b5.yaml, org and project, default 15): the time
--     a driver needs between a drop-off and the next pickup. private.transfer_turnaround reads it.
--   * private.transfer_tight_turnaround(transfer) compares a transfer with its driver's previous live transfer in the
--     org, whatever the reader may see, so the warning never depends on who reads it.
--   * app.transfer_board (security invoker, the A102 export relation): each live transfer with its vehicle, driver,
--     passengers, the flight it meets, its warnings and its status. Names come through private.known_person_name.
--   * app.transfer_person_options(project): the people a transfer may carry or be driven by, the same people
--     private.is_project_person admits, for the pickers. Names only: no project fact is read, so nothing is logged.
--   * api_external.my_transfers (owner-run): the caller's transfers as driver, passenger, or principal of a passenger
--     (private.party_person_visible, as api_external.lodging and api_external.travel read it, 2701), one row each with
--     the strongest role. Notes, fulfillment and car service never appear.
--   * app.roster_travel_party is recreated from 2657 with one change: a live transfer picking the person up on their
--     inbound date (project zone) books the pickup as a Ground segment does.

-- Setting -----------------------------------------------------------------------------------------------------------------
-- From `pnpm --filter @xos/schemas settings:sql b5`.

select private.define_setting('hospitality.transfer_turnaround_minutes', 'Integer', 'org.scheduling.write', array['organization', 'project'], true, p_default_integer => 15, p_min_integer => 0, p_max_integer => 240);

create or replace function private.transfer_turnaround(p_project_id uuid)
returns interval
language sql
stable
security definer
set search_path = ''
as $$
  select make_interval(mins => coalesce(
    private.setting_integer(p.org_id, 'hospitality.transfer_turnaround_minutes', null, p.id), 15)::integer)
  from app.projects p where p.id = p_project_id;
$$;

comment on function private.transfer_turnaround(uuid) is 'The turnaround a driver needs between a drop-off and the next pickup on the project: hospitality.transfer_turnaround_minutes for the project (default 15), as an interval.';
revoke all on function private.transfer_turnaround(uuid) from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need these.
grant execute on function private.transfer_turnaround(uuid) to authenticated, service_role;

create or replace function private.transfer_tight_turnaround(p_transfer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select prev.dropoff_at + private.transfer_turnaround(t.project_id) > t.pickup_at
    from app.transfers t
    join lateral (
      select x.dropoff_at from app.transfers x
      where x.org_id = t.org_id and x.driver_person_id = t.driver_person_id and x.id <> t.id and x.deleted_at is null
        and x.pickup_at < t.pickup_at
      order by x.pickup_at desc, x.id desc limit 1
    ) prev on true
    where t.id = p_transfer_id and t.driver_person_id is not null), false);
$$;

comment on function private.transfer_tight_turnaround(uuid) is 'True when the transfer''s driver drops off their previous live transfer in the org (by pickup time) less than the project''s turnaround (hospitality.transfer_turnaround_minutes) before this pickup. Reads every transfer of the driver, whatever the caller may see.';
revoke all on function private.transfer_tight_turnaround(uuid) from public, anon;
grant execute on function private.transfer_tight_turnaround(uuid) to authenticated, service_role;

-- The board --------------------------------------------------------------------------------------------------------------

-- The desk may hold hospitality.fulfillment.read without projects.project.read (app.projects' policy), so the board reads
-- the project key here rather than joining app.projects.
create or replace function private.hospitality_record_key(p_project_id uuid, p_number bigint)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.project_key || '-' || p_number::text from app.projects p
  where p.id = p_project_id and private.can_on_project(p.id, 'hospitality.fulfillment.read');
$$;

comment on function private.hospitality_record_key(uuid, bigint) is 'A hospitality record''s display key {project_key}-{number} for a reader holding hospitality.fulfillment.read on the project, else NULL.';
revoke all on function private.hospitality_record_key(uuid, bigint) from public, anon;
grant execute on function private.hospitality_record_key(uuid, bigint) to authenticated, service_role;

create view app.transfer_board with (security_invoker = on) as
select t.id, t.org_id, t.project_id, t.transfer_number, private.hospitality_record_key(t.project_id, t.transfer_number) as transfer_key,
  t.fulfillment_id, t.vehicle_id, v.label as vehicle_label, v.vehicle_type, v.seats,
  t.driver_person_id, private.known_person_name(t.driver_person_id) as driver_name,
  t.pickup_place, t.pickup_at, t.pickup_time_zone, t.dropoff_place, t.dropoff_at, t.dropoff_time_zone,
  t.meets_travel_segment_id, s.service_identifier as meets_service_identifier, s.arrives_at as meets_flight_arrives_at,
  coalesce(s.arrives_at > t.pickup_at, false) as meets_flight_after_pickup,
  coalesce(x.passenger_count, 0)::integer as passenger_count,
  x.primary_person_id as primary_passenger_id, private.known_person_name(x.primary_person_id) as primary_passenger_name,
  private.transfer_tight_turnaround(t.id) as tight_turnaround,
  case
    when now() >= t.dropoff_at then 'Done'
    when t.driver_person_id is null or t.vehicle_id is null then 'Unassigned'
    when now() >= t.pickup_at then 'Underway'
    else 'Assigned'
  end as status,
  t.notes
from app.transfers t
left join app.transfer_vehicles v on v.id = t.vehicle_id
left join app.travel_segments s on s.id = t.meets_travel_segment_id and s.deleted_at is null
left join lateral (
  select count(*) as passenger_count, (array_agg(q.person_id) filter (where q.is_primary))[1] as primary_person_id
  from app.transfer_passengers q where q.transfer_id = t.id and q.deleted_at is null
) x on true
where t.deleted_at is null;

call private.describe('app.transfer_board', 'Each live ground transfer the reader may see (B5, G-33) with its vehicle, driver, passengers, the flight it meets, its warnings and its status, computed on every read. Rows follow the transfers'' policies (hospitality.fulfillment.read on the project). The relation the transfers export reads (A102).', array[
  'id', 'Transfer.',
  'org_id', 'Owning org.',
  'project_id', 'Project.',
  'transfer_number', 'Number within the project.',
  'transfer_key', 'Display key {project_key}-{transfer_number}.',
  'fulfillment_id', 'Travel fulfillment the transfer belongs to, when one does.',
  'vehicle_id', 'Vehicle; NULL while unassigned.',
  'vehicle_label', 'Vehicle label.',
  'vehicle_type', 'Vehicle type.',
  'seats', 'Passenger seats of the vehicle; the driver is not counted.',
  'driver_person_id', 'Driver; NULL while unassigned.',
  'driver_name', 'Driver''s full name when the reader may know them by name (private.known_person_name).',
  'pickup_place', 'Pickup place.',
  'pickup_at', 'Pickup instant.',
  'pickup_time_zone', 'IANA zone of the pickup time.',
  'dropoff_place', 'Drop-off place.',
  'dropoff_at', 'Drop-off instant, the planner''s estimate.',
  'dropoff_time_zone', 'IANA zone of the drop-off time.',
  'meets_travel_segment_id', 'Flight the pickup meets, when it meets one.',
  'meets_service_identifier', 'Flight number of the met flight.',
  'meets_flight_arrives_at', 'Arrival instant of the met flight, when known.',
  'meets_flight_after_pickup', 'True when the met flight lands after the pickup time: Flight lands after pickup.',
  'passenger_count', 'Live passengers.',
  'primary_passenger_id', 'Primary passenger, when one is marked.',
  'primary_passenger_name', 'Primary passenger''s full name when the reader may know them by name.',
  'tight_turnaround', 'True when the driver''s previous live drop-off plus the project''s turnaround (hospitality.transfer_turnaround_minutes) is after this pickup (private.transfer_tight_turnaround).',
  'status', 'Done once the drop-off time has passed; otherwise Unassigned without a driver or a vehicle, Underway between pickup and drop-off, else Assigned. Computed with now().',
  'notes', 'Notes for the desk.'
]);

revoke all on app.transfer_board from public, anon;
grant select on app.transfer_board to authenticated, service_role;
-- 1650 grants the backup login SELECT on every new relation; pg_dump never reads a view's rows.
revoke select on app.transfer_board from xos_backup;

-- The people a transfer may carry -----------------------------------------------------------------------------------------

create or replace function app.transfer_person_options(p_project_id uuid)
returns table (
  person_id uuid,
  full_name text,
  party_name text,
  roster_entry_id uuid,
  membership_id uuid,
  engagement_id uuid
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
    with project as (
      select p.id, p.org_id from app.projects p where p.id = p_project_id
    ),
    members as (
      select m.person_id, m.id as membership_id
      from app.memberships m
      join project on project.org_id = m.org_id
      where m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    ),
    engaged as (
      select distinct on (e.person_id) e.person_id, e.id as engagement_id, o.name as party_name
      from app.engagements e
      left join app.counterparties c on c.id = e.counterparty_id
      left join app.organizations o on o.id = c.organization_id
      where e.project_id = p_project_id and e.person_id is not null and e.deleted_at is null
        and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
      order by e.person_id, (e.engagement_state = 'Active') desc, e.start_date desc, e.id desc
    ),
    rostered as (
      select distinct on (rp.person_id) rp.person_id, r.id as roster_entry_id, e.id as engagement_id,
        coalesce(o.name, ep.full_name) as party_name
      from private.roster_people rp
      join app.engagement_roster_entries r on r.id = rp.roster_entry_id
      join app.engagements e on e.id = r.engagement_id
      left join app.counterparties c on c.id = e.counterparty_id
      left join app.organizations o on o.id = c.organization_id
      left join app.people ep on ep.id = e.person_id
      where e.project_id = p_project_id and e.deleted_at is null and rp.person_id is not null
        and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
        and r.deleted_at is null and r.entry_state <> 'Withdrawn' and r.person_response <> 'Declined'
      order by rp.person_id, (e.engagement_state = 'Active') desc, r.id
    )
    select h.id, h.full_name, coalesce(g.party_name, ro.party_name), ro.roster_entry_id, mm.membership_id,
      coalesce(g.engagement_id, ro.engagement_id)
    from (select x.person_id from members x union select y.person_id from engaged y union select z.person_id from rostered z) who
    join app.people h on h.id = who.person_id and h.deleted_at is null
    left join members mm on mm.person_id = who.person_id
    left join engaged g on g.person_id = who.person_id
    left join rostered ro on ro.person_id = who.person_id
    order by h.full_name, h.id;
end;
$$;

comment on function app.transfer_person_options(uuid) is 'The people a ground transfer of the project may carry or be driven by (B5), the same people private.is_project_person admits: current members of the project''s org with their membership, people named on the project''s live engagements (Onboarding to Closing) with that engagement and the supplying account, and the persons of live roster entries (not Withdrawn, not Declined) on those engagements with the entry and the party. One row per person. Needs hospitality.fulfillment.read on the project (42501 otherwise). Names only: no project fact is read, so nothing is logged.';
revoke all on function app.transfer_person_options(uuid) from public, anon;
grant execute on function app.transfer_person_options(uuid) to authenticated, service_role;

-- What drivers and passengers read -----------------------------------------------------------------------------------------

create or replace view api_external.my_transfers as
with mine as (
  select t.id,
    case
      when t.driver_person_id = private.current_person_id() then 'Driver'
      when exists (select 1 from app.transfer_passengers q
                   where q.transfer_id = t.id and q.deleted_at is null and q.person_id = private.current_person_id()) then 'Passenger'
      when exists (select 1 from app.transfer_passengers q
                   where q.transfer_id = t.id and q.deleted_at is null and private.party_person_visible(t.project_id, q.person_id)) then 'Party'
    end as my_role
  from app.transfers t
  where t.deleted_at is null
    and (t.project_id in (select private.readable_project_ids())
      or private.is_engaged_party(t.project_id)
      or exists (select 1 from app.engagement_roster_entries r
                 join app.engagements e on e.id = r.engagement_id
                 where r.id in (select private.my_roster_entry_ids('operational')) and e.project_id = t.project_id))
)
select t.id, t.project_id, p.name as project_name, p.project_key || '-' || t.transfer_number::text as transfer_key, m.my_role,
  t.pickup_place, t.pickup_at, t.pickup_time_zone, t.dropoff_place, t.dropoff_at, t.dropoff_time_zone,
  v.label as vehicle_label, v.vehicle_type, v.seats, d.full_name as driver_name,
  (select count(*)::integer from app.transfer_passengers q where q.transfer_id = t.id and q.deleted_at is null) as passenger_count,
  coalesce((
    select array_agg(g.full_name order by q.is_primary desc, g.full_name, q.id)
    from app.transfer_passengers q join app.people g on g.id = q.person_id
    where q.transfer_id = t.id and q.deleted_at is null
      and (m.my_role = 'Driver' or q.person_id = private.current_person_id() or private.party_person_visible(t.project_id, q.person_id))
  ), '{}') as passenger_names,
  (select g.full_name from app.transfer_passengers q join app.people g on g.id = q.person_id
   where q.transfer_id = t.id and q.deleted_at is null and q.is_primary
     and (m.my_role = 'Driver' or q.person_id = private.current_person_id() or private.party_person_visible(t.project_id, q.person_id))
  ) as primary_passenger_name,
  s.service_identifier as meets_service_identifier, s.arrives_at as meets_arrives_at,
  case
    when now() >= t.dropoff_at then 'Done'
    when t.driver_person_id is null or t.vehicle_id is null then 'Unassigned'
    when now() >= t.pickup_at then 'Underway'
    else 'Assigned'
  end as status
from mine m
join app.transfers t on t.id = m.id
join app.projects p on p.id = t.project_id
left join app.transfer_vehicles v on v.id = t.vehicle_id
left join app.people d on d.id = t.driver_person_id
left join app.travel_segments s on s.id = t.meets_travel_segment_id and s.deleted_at is null
where m.my_role is not null;

comment on view api_external.my_transfers is 'Ground transfers of the caller (B5, G-33), one row each with the strongest role: Driver, then Passenger, then Party (a passenger has the caller as a principal of a live engagement on the project: the person, the supplying account''s Owner or Admin, or an artist''s Advance representative, private.party_person_visible). Each needs project reach: a readable project, an engagement in the operational area, or an operational roster entry on it. A driver reads every passenger''s name; anyone else only their own and those they answer for. Notes, fulfillment and car service never appear. Status is Done, Unassigned, Underway or Assigned, as on app.transfer_board.';
comment on column api_external.my_transfers.my_role is 'Driver, Passenger or Party: the caller''s strongest role on the transfer.';
comment on column api_external.my_transfers.seats is 'Passenger seats of the vehicle; the driver is not counted.';
comment on column api_external.my_transfers.passenger_names is 'Names of the live passengers, primary first: all of them for the driver, otherwise only the caller and the passengers they answer for.';
comment on column api_external.my_transfers.primary_passenger_name is 'Name of the primary passenger when the caller may read it.';

revoke all on api_external.my_transfers from public, anon;
grant select on api_external.my_transfers to authenticated, service_role;

-- The travel party counts transfers as pickups (from 2657) ------------------------------------------------------------------

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
      'pickup', jsonb_build_object('booked', v_travel.inbound_on is not null and (exists (
        select 1 from app.travel_segments s
        where s.person_id = v_row.person_id and s.project_id = p_project_id and s.deleted_at is null and s.travel_mode = 'Ground'
          and (s.departs_at at time zone v_zone)::date = v_travel.inbound_on) or exists (
        select 1 from app.transfer_passengers q
        join app.transfers tr on tr.id = q.transfer_id and tr.deleted_at is null and tr.project_id = p_project_id
        where q.person_id = v_row.person_id and q.deleted_at is null
          and (tr.pickup_at at time zone v_zone)::date = v_travel.inbound_on))),
      'pass', case when v_passes then jsonb_build_object('issued', exists (
        select 1 from app.credentials k
        where k.holder_person_id = v_row.person_id and k.engagement_id = v_row.engagement_id
          and k.revoked_at is null and k.deleted_at is null)) end);
  end loop;
end;
$$;

comment on function app.roster_travel_party(uuid) is 'The travel party of a project (R5, G-175), for hospitality.fulfillment.read holders (else 42501): one object per entry of private.travel_party_entries with the party, person, role and arrival, the travel request (airport names included) or NULL, room {assigned, check_in_on, check_out_on, block_name} from live accommodation assignments of the person on the project''s blocks, pickup {booked} from a live Ground travel segment of the person on the project departing on the inbound date in the project zone, or a live transfer of the project carrying the person as a live passenger with its pickup on that date (B5; false while there is no inbound date), and pass {issued} from a live unrevoked credential of the engagement, NULL without credentials.credential.read. Each entry returned with a travel request writes project_facts.viewed (Travel) in the person''s access log and the producing org''s audit ledger.';

revoke all on function app.roster_travel_party(uuid) from public, anon;
grant execute on function app.roster_travel_party(uuid) to authenticated, service_role;
