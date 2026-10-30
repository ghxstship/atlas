-- 2936_schedule_clashes.sql
-- B4 Scheduling depth (RRR-228; parity gaps G-46 and G-47; ADR 0143 decisions 5, 6 and 8; ADR 0103; ADR 0022 block 2930
-- to 2939). Cross-production conflicts and running-order clashes, computed at read time and never stored. SQL returns
-- candidate facts; packages/data/src/schedule-clashes.ts (classifyClash) applies the org's thresholds and decides each
-- one's severity, so no acknowledgement or severity is kept. Nothing here fixes a clash: each row links to where a
-- planner fixes it.
--
--   * scheduling.changeover_minutes (default 15, 0 to 240) and scheduling.travel_buffer_minutes (default 120, 0 to 720),
--     organization settings written with org.scheduling.write.
--   * app.schedule_clashes(org, from, to, project) runs as the caller (security invoker): a clash is returned only
--     when the caller reads both of its sides (decision 6). At most 92 days. Rules:
--       person_double_booked     two live shifts of one person overlap, on one project or two of the org;
--       person_in_transit        a live shift overlaps a travel segment of its person, [departs, arrives);
--       supplier_overlap         one company (an engagement with no person, role Vendor or Contractor, Onboarding to
--                                Closing) is engaged on two projects over overlapping dates at different or unknown
--                                venues; people a vendor supplies are covered by the person rules;
--       supplier_dock_overlap    dock slots of one company's engagements overlap in time at different venues;
--       set_two_stages           one artist (an engagement's person, else its company) has set cues in two live running
--                                orders of different nodes or spaces whose windows [planned, planned + length) overlap;
--       changeover               consecutive set cues of different engagements in one running order, by planned time,
--                                with under 240 minutes between them (a negative gap is an overlap);
--       arrival_near_call        a segment arrives within 720 minutes before, or any time after, its person's first call
--                                (set cue or live shift) on the project that starts after the segment departs;
--       departure_near_call_end  a segment departs within 720 minutes after, or any time before, the end of its
--                                person's last call on the project that started before it departs;
--       past_curfew              P2's planned end (the last live cue by position, planned time plus length) is after
--                                the running order's curfew_at.
--     gap_minutes is the gap the rule measures; tbc is true when a cue input is TBC (start_tbc), and draft when a
--     shift input is Draft, so classifyClash lowers the severity.
--   * app.travel_request_clashes(project) compares R5's requested travel dates (Confidential, 2654) with the calls of
--     each person in the travel party. It is security definer and logged by R5's rules (2657): it needs
--     hospitality.fulfillment.read (private.assert_travel_party_reader, 42501); a person whose requested date is
--     returned gets one project_facts.viewed (Travel) row and one audit event, every other person compared one
--     project_facts.counted row, and the project one project_facts.counted audit event with the people count. Shifts
--     count only for holders of crew.shift.read on the project, and cues only for show.run_of_show.read holders. Its
--     rows are shown in their own panel and never cached, listed with schedule_clashes or exported.

select private.define_setting('scheduling.changeover_minutes', 'Integer', 'org.scheduling.write', array['organization'], false,
  p_default_integer => 15, p_min_integer => 0, p_max_integer => 240);
select private.define_setting('scheduling.travel_buffer_minutes', 'Integer', 'org.scheduling.write', array['organization'], false,
  p_default_integer => 120, p_min_integer => 0, p_max_integer => 720);

-- 1. Clashes the caller can see ---------------------------------------------------------------------------------------------

create or replace function app.schedule_clashes(p_org_id uuid, p_from date, p_to date, p_project_id uuid default null)
returns table (
  rule text,
  project_id uuid,
  other_project_id uuid,
  day date,
  subject_table text,
  subject_id uuid,
  other_table text,
  other_id uuid,
  party_kind text,
  party_id uuid,
  party_name text,
  other_party_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  other_starts_at timestamptz,
  other_ends_at timestamptz,
  gap_minutes integer,
  tbc boolean,
  draft boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lo timestamptz;
  v_hi timestamptz;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  if p_org_id is null or p_from is null or p_to is null or p_to < p_from or p_to - p_from > 91 then
    raise exception using errcode = '22023', message = 'clashes cover 1 to 92 days of one organization';
  end if;
  -- A day either side covers every zone; each row is then kept by its project-local day.
  v_lo := p_from::timestamp at time zone 'UTC' - interval '1 day';
  v_hi := (p_to + 1)::timestamp at time zone 'UTC' + interval '1 day';

  return query
  with all_projects as (
    select p.id, p.time_zone, p.venue_id from app.projects p where p.org_id = p_org_id and p.deleted_at is null
  ), shifts as (
    select s.id, s.project_id, s.starts_at, s.ends_at, s.shift_state, coalesce(m.person_id, e.person_id) as person_id
    from app.shifts s
    join all_projects ap on ap.id = s.project_id
    left join app.memberships m on m.id = s.membership_id
    left join app.engagements e on e.id = s.engagement_id
    where s.deleted_at is null and s.shift_state <> 'Canceled' and coalesce(m.person_id, e.person_id) is not null
      and s.ends_at > v_lo - interval '2 days' and s.starts_at < v_hi + interval '2 days'
  ), set_cues as (
    -- Set cues: cues of live running orders linked to a live engagement (0760).
    select c.id, c.run_of_show_id, r.project_id, r.scope_node_id, c.space_id, c.position, c.planned_at,
      c.planned_at + coalesce(c.duration, interval '0') as ends_at, c.start_tbc, ec.engagement_id,
      e.person_id, coalesce(e.person_id, e.counterparty_id) as party_id,
      case when e.person_id is not null then 'person' else 'counterparty' end as party_kind,
      coalesce(pp.full_name, app.counterparty_name(cp)) as party_name
    from app.engagement_cues ec
    join app.engagements e on e.id = ec.engagement_id and e.deleted_at is null
    join app.cues c on c.id = ec.cue_id and c.deleted_at is null and c.planned_at is not null
    join app.run_of_show r on r.id = c.run_of_show_id and r.deleted_at is null
    join all_projects ap on ap.id = r.project_id
    left join lateral app.person_names(array[e.person_id]) pp on true
    left join app.counterparties cp on cp.id = e.counterparty_id
    where ec.deleted_at is null
      and c.planned_at > v_lo - interval '2 days' and c.planned_at < v_hi + interval '2 days'
  ), calls as (
    -- A person's calls on a project: set cues and live shifts.
    select sc.person_id, sc.project_id, 'cues'::text as call_table, sc.id as call_id, sc.planned_at as call_at,
      sc.ends_at as call_ends_at, sc.start_tbc as tbc, false as draft
    from set_cues sc where sc.person_id is not null
    union all
    select s.person_id, s.project_id, 'shifts', s.id, s.starts_at, s.ends_at, false, s.shift_state = 'Draft' from shifts s
  ), travel as (
    select t.id, t.project_id, t.person_id, t.departs_at, t.arrives_at
    from app.travel_segments t
    join all_projects ap on ap.id = t.project_id
    where t.deleted_at is null and t.departs_at > v_lo - interval '3 days' and t.departs_at < v_hi + interval '3 days'
  ), suppliers as (
    select e.id, e.project_id, e.counterparty_id, e.start_date, e.end_date, ap.venue_id, ap.time_zone,
      app.counterparty_name(cp) as party_name
    from app.engagements e
    join all_projects ap on ap.id = e.project_id
    join app.counterparties cp on cp.id = e.counterparty_id
    where e.deleted_at is null and e.person_id is null and e.counterparty_id is not null
      and e.role_type in ('Vendor', 'Contractor') and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
  ), candidates as (
    -- person_double_booked
    select 'person_double_booked'::text as rule, a.project_id, b.project_id as other_project_id,
      'shifts'::text as subject_table, a.id as subject_id, 'shifts'::text as other_table, b.id as other_id,
      'person'::text as party_kind, a.person_id as party_id, pp.full_name as party_name, null::text as other_party_name,
      a.starts_at, a.ends_at, b.starts_at as other_starts_at, b.ends_at as other_ends_at,
      (extract(epoch from (least(a.ends_at, b.ends_at) - greatest(a.starts_at, b.starts_at))) / 60)::integer as gap_minutes,
      false as tbc, a.shift_state = 'Draft' or b.shift_state = 'Draft' as draft
    from shifts a
    join shifts b on b.person_id = a.person_id and b.id > a.id
      and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
    left join lateral app.person_names(array[a.person_id]) pp on true
    union all
    -- person_in_transit
    select 'person_in_transit', s.project_id, t.project_id, 'shifts', s.id, 'travel_segments', t.id,
      'person', s.person_id, pp.full_name, null, s.starts_at, s.ends_at, t.departs_at, coalesce(t.arrives_at, t.departs_at),
      (extract(epoch from (least(s.ends_at, coalesce(t.arrives_at, t.departs_at)) - greatest(s.starts_at, t.departs_at))) / 60)::integer,
      false, s.shift_state = 'Draft'
    from shifts s
    join travel t on t.person_id = s.person_id
      and tstzrange(s.starts_at, s.ends_at) && tstzrange(t.departs_at, coalesce(t.arrives_at, t.departs_at))
    left join lateral app.person_names(array[s.person_id]) pp on true
    union all
    -- supplier_overlap
    select 'supplier_overlap', a.project_id, b.project_id, 'engagements', a.id, 'engagements', b.id,
      'counterparty', a.counterparty_id, a.party_name, null,
      a.start_date::timestamp at time zone a.time_zone,
      case when a.end_date is null then 'infinity'::timestamptz else (a.end_date + 1)::timestamp at time zone a.time_zone end,
      b.start_date::timestamp at time zone b.time_zone,
      case when b.end_date is null then 'infinity'::timestamptz else (b.end_date + 1)::timestamp at time zone b.time_zone end,
      null::integer, false, false
    from suppliers a
    join suppliers b on b.counterparty_id = a.counterparty_id and b.project_id <> a.project_id and b.id > a.id
      and daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]')
      and (a.venue_id is null or b.venue_id is null or a.venue_id <> b.venue_id)
    where daterange(greatest(a.start_date, b.start_date), least(coalesce(a.end_date, p_to), coalesce(b.end_date, p_to)), '[]')
      && daterange(p_from, p_to, '[]')
    union all
    -- supplier_dock_overlap
    select 'supplier_dock_overlap', a.project_id, b.project_id, 'dock_slots', a.id, 'dock_slots', b.id,
      'counterparty', ea.counterparty_id, app.counterparty_name(cp), null, a.starts_at, a.ends_at, b.starts_at, b.ends_at,
      (extract(epoch from (least(a.ends_at, b.ends_at) - greatest(a.starts_at, b.starts_at))) / 60)::integer, false, false
    from app.dock_slots a
    join app.engagements ea on ea.id = a.engagement_id and ea.counterparty_id is not null
    join app.zones za on za.id = a.zone_id
    join all_projects pa on pa.id = a.project_id
    join app.dock_slots b on b.id > a.id and b.deleted_at is null
      and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
    join app.engagements eb on eb.id = b.engagement_id and eb.counterparty_id = ea.counterparty_id
    join app.zones zb on zb.id = b.zone_id and zb.venue_id <> za.venue_id
    join all_projects pb on pb.id = b.project_id
    join app.counterparties cp on cp.id = ea.counterparty_id
    where a.deleted_at is null and a.ends_at > v_lo and a.starts_at < v_hi
    union all
    -- set_two_stages
    select 'set_two_stages', a.project_id, b.project_id, 'cues', a.id, 'cues', b.id, a.party_kind, a.party_id,
      a.party_name, null, a.planned_at, a.ends_at, b.planned_at, b.ends_at,
      (extract(epoch from (least(a.ends_at, b.ends_at) - greatest(a.planned_at, b.planned_at))) / 60)::integer,
      a.start_tbc or b.start_tbc, false
    from set_cues a
    join set_cues b on b.party_id = a.party_id and b.id > a.id and b.run_of_show_id <> a.run_of_show_id
      and (a.scope_node_id is distinct from b.scope_node_id or a.space_id is distinct from b.space_id)
      and tstzrange(a.planned_at, a.ends_at) && tstzrange(b.planned_at, b.ends_at)
    union all
    -- changeover
    select 'changeover', x.project_id, x.project_id, 'cues', x.prev_id, 'cues', x.id, x.party_kind, x.party_id,
      x.prev_party_name, x.party_name, x.prev_planned_at, x.prev_ends_at, x.planned_at, x.ends_at,
      floor(extract(epoch from (x.planned_at - x.prev_ends_at)) / 60)::integer, x.prev_tbc or x.start_tbc, false
    from (
      select sc.*,
        lag(sc.id) over w as prev_id, lag(sc.engagement_id) over w as prev_engagement_id,
        lag(sc.party_name) over w as prev_party_name, lag(sc.planned_at) over w as prev_planned_at,
        lag(sc.ends_at) over w as prev_ends_at, lag(sc.start_tbc) over w as prev_tbc
      from set_cues sc
      window w as (partition by sc.run_of_show_id order by sc.planned_at, sc.position)
    ) x
    where x.prev_id is not null and x.prev_engagement_id <> x.engagement_id
      and extract(epoch from (x.planned_at - x.prev_ends_at)) < 240 * 60
    union all
    -- arrival_near_call
    select 'arrival_near_call', t.project_id, t.project_id, 'travel_segments', t.id, c.call_table, c.call_id,
      'person', t.person_id, pp.full_name, null, t.departs_at, t.arrives_at, c.call_at, c.call_ends_at,
      floor(extract(epoch from (c.call_at - t.arrives_at)) / 60)::integer, c.tbc, c.draft
    from travel t
    cross join lateral (
      select k.* from calls k
      where k.person_id = t.person_id and k.project_id = t.project_id and k.call_at > t.departs_at
      order by k.call_at, k.call_id limit 1
    ) c
    left join lateral app.person_names(array[t.person_id]) pp on true
    where t.arrives_at is not null and extract(epoch from (c.call_at - t.arrives_at)) < 720 * 60
    union all
    -- departure_near_call_end
    select 'departure_near_call_end', t.project_id, t.project_id, 'travel_segments', t.id, c.call_table, c.call_id,
      'person', t.person_id, pp.full_name, null, t.departs_at, t.arrives_at, c.call_at, c.call_ends_at,
      floor(extract(epoch from (t.departs_at - c.call_ends_at)) / 60)::integer, c.tbc, c.draft
    from travel t
    cross join lateral (
      select k.* from calls k
      where k.person_id = t.person_id and k.project_id = t.project_id and k.call_at < t.departs_at
      order by k.call_at desc, k.call_id desc limit 1
    ) c
    left join lateral app.person_names(array[t.person_id]) pp on true
    where extract(epoch from (t.departs_at - c.call_ends_at)) < 720 * 60
    union all
    -- past_curfew: P2's planned end, the last live cue by position
    select 'past_curfew', r.project_id, r.project_id, 'run_of_show', r.id, 'cues', l.id, null, null, r.name, null,
      l.planned_at, l.planned_at + coalesce(l.duration, interval '0'), r.curfew_at, r.curfew_at,
      ceil(extract(epoch from (l.planned_at + coalesce(l.duration, interval '0') - r.curfew_at)) / 60)::integer,
      l.start_tbc, false
    from app.run_of_show r
    join all_projects ap on ap.id = r.project_id
    cross join lateral (
      select c.* from app.cues c where c.run_of_show_id = r.id and c.deleted_at is null
      order by c.position desc limit 1
    ) l
    where r.deleted_at is null and r.curfew_at is not null and l.planned_at is not null
      and l.planned_at + coalesce(l.duration, interval '0') > r.curfew_at
      and r.curfew_at > v_lo and r.curfew_at < v_hi
  )
  select k.rule, k.project_id, k.other_project_id, (k.starts_at at time zone p.time_zone)::date, k.subject_table,
    k.subject_id, k.other_table, k.other_id, k.party_kind, k.party_id, k.party_name, k.other_party_name, k.starts_at,
    k.ends_at, k.other_starts_at, k.other_ends_at, k.gap_minutes, k.tbc, k.draft
  from candidates k
  join all_projects p on p.id = k.project_id
  where (p_project_id is null or k.project_id = p_project_id or k.other_project_id = p_project_id)
    and (k.rule = 'supplier_overlap'
         or (k.starts_at at time zone p.time_zone)::date between p_from and p_to)
  order by 4, k.rule, k.subject_id, k.other_id;
end;
$$;

comment on function app.schedule_clashes(uuid, date, date, uuid) is 'Candidate scheduling clashes of an org over 1 to 92 days (G-46, G-47, ADR 0143 decisions 5 and 6), computed at read time as the caller, so a clash shows only to someone who reads both of its sides: person_double_booked, person_in_transit, supplier_overlap (one company engaged on two projects over overlapping dates at different or unknown venues), supplier_dock_overlap, set_two_stages, changeover (under 240 minutes between consecutive sets of different engagements), arrival_near_call and departure_near_call_end (within 720 minutes of a call, or past it) and past_curfew (P2''s planned end after curfew_at). Each row names its project-local day, both sides, the party, the windows, the gap in minutes and whether a TBC cue or a Draft shift is an input. packages/data applies the org''s thresholds (scheduling.changeover_minutes, scheduling.travel_buffer_minutes) and the severity; nothing is stored.';
revoke all on function app.schedule_clashes(uuid, date, date, uuid) from public, anon;
grant execute on function app.schedule_clashes(uuid, date, date, uuid) to authenticated, service_role;

-- 2. Requested travel against calls (R5) -----------------------------------------------------------------------------------

create or replace function app.travel_request_clashes(p_project_id uuid)
returns table (
  rule text,
  person_id uuid,
  person_name text,
  roster_entry_id uuid,
  requested_on date,
  call_day date,
  call_table text,
  call_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_zone text;
  v_org uuid;
  v_shifts boolean;
  v_cues boolean;
  v_row record;
  v_first record;
  v_last record;
  v_found boolean;
  v_people integer := 0;
begin
  perform private.require_person();
  perform private.assert_travel_party_reader(p_project_id);
  select p.time_zone, p.org_id into v_zone, v_org from app.projects p where p.id = p_project_id;
  v_shifts := private.can_on_project(p_project_id, 'crew.shift.read');
  v_cues := private.can_on_project(p_project_id, 'show.run_of_show.read');

  create temporary table if not exists pg_temp.travel_request_clash_rows (
    rule text, person_id uuid, person_name text, roster_entry_id uuid, requested_on date, call_day date,
    call_table text, call_id uuid
  ) on commit drop;
  truncate pg_temp.travel_request_clash_rows;

  for v_row in
    select t.*, pp.full_name from private.travel_party_dates(p_project_id) t
    left join lateral app.person_names(array[t.person_id]) pp on true
    order by pp.full_name, t.roster_entry_id
  loop
    v_people := v_people + 1;
    v_found := false;
    -- The person's calls on the project: live shifts and set cues, as the caller may read them.
    with calls as (
      select 'shifts'::text as call_table, s.id as call_id, s.starts_at as call_at
      from app.shifts s
      left join app.memberships m on m.id = s.membership_id
      left join app.engagements e on e.id = s.engagement_id
      where v_shifts and s.project_id = p_project_id and s.deleted_at is null and s.shift_state <> 'Canceled'
        and coalesce(m.person_id, e.person_id) = v_row.person_id
      union all
      select 'cues', c.id, c.planned_at
      from app.engagement_cues ec
      join app.engagements e on e.id = ec.engagement_id and e.deleted_at is null
      join app.cues c on c.id = ec.cue_id and c.deleted_at is null and c.planned_at is not null
      join app.run_of_show r on r.id = c.run_of_show_id and r.deleted_at is null
      where v_cues and ec.deleted_at is null and r.project_id = p_project_id and e.person_id = v_row.person_id
    )
    select x.call_table, x.call_id, (x.call_at at time zone v_zone)::date as call_day into v_first
    from calls x order by x.call_at, x.call_id limit 1;

    if v_first.call_id is not null then
      with calls as (
        select 'shifts'::text as call_table, s.id as call_id, s.starts_at as call_at
        from app.shifts s
        left join app.memberships m on m.id = s.membership_id
        left join app.engagements e on e.id = s.engagement_id
        where v_shifts and s.project_id = p_project_id and s.deleted_at is null and s.shift_state <> 'Canceled'
          and coalesce(m.person_id, e.person_id) = v_row.person_id
        union all
        select 'cues', c.id, c.planned_at
        from app.engagement_cues ec
        join app.engagements e on e.id = ec.engagement_id and e.deleted_at is null
        join app.cues c on c.id = ec.cue_id and c.deleted_at is null and c.planned_at is not null
        join app.run_of_show r on r.id = c.run_of_show_id and r.deleted_at is null
        where v_cues and ec.deleted_at is null and r.project_id = p_project_id and e.person_id = v_row.person_id
      )
      select x.call_table, x.call_id, (x.call_at at time zone v_zone)::date as call_day into v_last
      from calls x order by x.call_at desc, x.call_id desc limit 1;

      if v_row.inbound_on is not null and v_row.inbound_on > v_first.call_day then
        insert into pg_temp.travel_request_clash_rows values ('requested_arrival_after_call', v_row.person_id,
          v_row.full_name, v_row.roster_entry_id, v_row.inbound_on, v_first.call_day, v_first.call_table, v_first.call_id);
        v_found := true;
      end if;
      if v_row.outbound_on is not null and v_row.outbound_on < v_last.call_day then
        insert into pg_temp.travel_request_clash_rows values ('requested_departure_before_call', v_row.person_id,
          v_row.full_name, v_row.roster_entry_id, v_row.outbound_on, v_last.call_day, v_last.call_table, v_last.call_id);
        v_found := true;
      end if;
    end if;

    if v_found then
      perform private.log_project_fact_event(v_row.person_id, 'project_facts.viewed', v_row.org_id, v_row.engagement_id,
        v_row.roster_entry_id, array['Travel']::app.project_fact_kind[]);
      perform private.write_audit_event(v_row.org_id, 'project_facts.viewed', 'app.engagement_roster_entries', v_row.roster_entry_id,
        jsonb_build_object('fact_kinds', jsonb_build_array('Travel')));
    else
      perform private.log_project_fact_event(v_row.person_id, 'project_facts.counted', v_row.org_id, v_row.engagement_id,
        v_row.roster_entry_id, array['Travel']::app.project_fact_kind[]);
    end if;
  end loop;
  perform private.write_audit_event(v_org, 'project_facts.counted', 'app.projects', p_project_id,
    jsonb_build_object('fact_kinds', jsonb_build_array('Travel'), 'people', v_people, 'check', 'travel_request_clashes'));

  return query
  select x.rule, x.person_id, x.person_name, x.roster_entry_id, x.requested_on, x.call_day, x.call_table, x.call_id
  from pg_temp.travel_request_clash_rows x
  order by x.person_name, x.rule;
end;
$$;

comment on function app.travel_request_clashes(uuid) is 'R5''s requested travel against calls (G-47, ADR 0143 decision 6), for hospitality.fulfillment.read holders (else 42501): for each person of the project''s travel party with a dated travel request (private.travel_party_dates, so nothing while Travel is not offered), requested_arrival_after_call when the requested inbound date is after the local date of their first call (a live shift, for crew.shift.read holders, or a set cue, for show.run_of_show.read holders) and requested_departure_before_call when the outbound date is before that of their last call. Logged by R5''s rules (2657): one project_facts.viewed (Travel) row and one audit event per person whose requested date is returned, one project_facts.counted row per other person compared, and one project_facts.counted audit event on the project with the people count. Never cached, listed with app.schedule_clashes or exported.';
revoke all on function app.travel_request_clashes(uuid) from public, anon;
grant execute on function app.travel_request_clashes(uuid) to authenticated, service_role;
