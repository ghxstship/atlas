-- 2850_reschedule_minutes.sql
-- P8 (RRR-222; parity gap G-35; ADR 0022 block 2850 to 2859; ADR 0111 amended 2026-10-28). Minute offsets and Shift
-- time across records (Section 11.11, S11.11-01; Section 11.7, S11.7-04).
--
--   * The push rounds and the locked refusal of 2260's app.reschedule_record move into one planner,
--     private.plan_reschedule(unit), and its commit branch into private.commit_reschedule(reason), so the record move,
--     the multi-record shift and the backlog placement (2851) push successors the same way. The planner works on the
--     transaction's pg_temp.reschedule_rows, which now carries each row's project and time zone, the minute parts of
--     its move and whether it moved. Pushes join a predecessor and a successor only within one project.
--   * app.reschedule_record gains p_start_minutes and p_end_minutes (at most 14 days either way). A target moves by
--     its days and then its minutes, both on the project's wall clock (private.add_local_days, then the new
--     private.add_local_minutes). A change with no minute part pushes successors by whole days exactly as 2260 does;
--     one with a minute part pushes them by whole minutes, measured on the same wall clock. A target is moved only
--     when some offset is nonzero, so a change of nothing never trips the locked refusal and never writes the row.
--   * app.shift_records(ids, minutes) moves up to 500 selected records rigidly by the same minutes and pushes their
--     successors outside the selection, project by project, under the same per-project advisory locks as
--     app.reschedule_record. Undated and Canceled records in the selection are left where they are. A move set (the
--     selection and every successor pushed) over 500 rows is refused (shift_too_large), so its undo fits in one call
--     of app.bulk_update_records (private.run_bulk takes at most 500 rows).

-- 1. Wall-clock minutes ---------------------------------------------------------------------------------------------------

create or replace function private.add_local_minutes(p_at timestamptz, p_minutes integer, p_time_zone text)
returns timestamptz
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when p_at is null then null
    else ((p_at at time zone p_time_zone) + pg_catalog.make_interval(mins => p_minutes)) at time zone p_time_zone end;
$$;

comment on function private.add_local_minutes(timestamptz, integer, text) is 'The instant moved by whole minutes of the wall clock in a time zone, the clock a reschedule measures gaps on (ADR 0111); NULL stays NULL.';

revoke all on function private.add_local_minutes(timestamptz, integer, text) from public, anon;
grant execute on function private.add_local_minutes(timestamptz, integer, text) to authenticated, service_role;

-- 2. The working table and the shared planner ----------------------------------------------------------------------------

create or replace function private.open_reschedule_rows()
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  -- Made once per transaction (a second call in it reuses it) and emptied for each computation.
  if pg_catalog.to_regclass('pg_temp.reschedule_rows') is null then
    create temporary table pg_temp.reschedule_rows (
      record_id uuid primary key,
      project_id uuid not null,
      time_zone text not null,
      record_label text not null,
      is_target boolean not null,
      locked boolean not null,
      moved boolean not null default false,
      start_days integer not null default 0,
      end_days integer not null default 0,
      start_minutes integer not null default 0,
      end_minutes integer not null default 0,
      old_starts_at timestamptz,
      old_ends_at timestamptz,
      old_due_at timestamptz,
      starts_at timestamptz,
      ends_at timestamptz,
      due_at timestamptz
    ) on commit drop;
  end if;
  truncate pg_temp.reschedule_rows;
end;
$$;

comment on function private.open_reschedule_rows() is 'Opens (or empties) the transaction''s pg_temp.reschedule_rows, the working table of a reschedule, shift or placement: each record with its project, time zone, old and new dates, the days and minutes it moves and whether it moved.';
revoke all on function private.open_reschedule_rows() from public, anon, authenticated;

create or replace function private.plan_reschedule(p_unit text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_rounds integer := 0;
  v_limit integer;
  v_changed integer;
  v_locked text;
begin
  if p_unit is null or p_unit not in ('day', 'minute') then
    raise exception using errcode = '22023', message = 'the push unit is day or minute';
  end if;

  -- Successors, round by round: each round pushes every successor of a moved record by what its tightest dependency
  -- needs beyond the gap it had before the change, measured on the project's wall clock, in whole days or whole
  -- minutes. A predecessor with no old dates (a record placed from the backlog, 2851) had a gap of zero. The graph is
  -- acyclic, so the rounds end within one round per record; past that the schedule is circular.
  v_limit := (select count(*) from pg_temp.reschedule_rows) + 1;
  loop
    v_rounds := v_rounds + 1;
    if v_rounds > v_limit then
      perform private.refuse('reschedule_cycle', 'This schedule is circular; remove a dependency before moving the record.');
    end if;
    with edges as (
      select s.record_id as successor_id,
        extract(epoch from (
          case when d.dependency_type in ('Finish to Start', 'Finish to Finish')
            then coalesce(p.ends_at, p.due_at, p.starts_at) else coalesce(p.starts_at, p.due_at, p.ends_at) end
          at time zone s.time_zone)
          - (case when d.dependency_type in ('Finish to Start', 'Start to Start')
            then coalesce(s.starts_at, s.due_at, s.ends_at) else coalesce(s.ends_at, s.due_at, s.starts_at) end
          at time zone s.time_zone)
          + d.lag) as gap_now,
        greatest(0, extract(epoch from (
          case when d.dependency_type in ('Finish to Start', 'Finish to Finish')
            then coalesce(p.old_ends_at, p.old_due_at, p.old_starts_at) else coalesce(p.old_starts_at, p.old_due_at, p.old_ends_at) end
          at time zone s.time_zone)
          - (case when d.dependency_type in ('Finish to Start', 'Start to Start')
            then coalesce(s.old_starts_at, s.old_due_at, s.old_ends_at) else coalesce(s.old_ends_at, s.old_due_at, s.old_starts_at) end
          at time zone s.time_zone)
          + d.lag)) as gap_before
      from app.record_dependencies d
      join pg_temp.reschedule_rows p on p.record_id = d.predecessor_record_id and p.moved
      join pg_temp.reschedule_rows s on s.record_id = d.successor_record_id and not s.is_target and s.project_id = p.project_id
      where d.deleted_at is null
    ), pushes as (
      select e.successor_id,
        max(ceil((e.gap_now - e.gap_before) / case when p_unit = 'day' then 86400.0 else 60.0 end))::integer as amount
      from edges e
      where e.gap_now > e.gap_before
      group by e.successor_id
    )
    update pg_temp.reschedule_rows w set
      moved = true,
      start_days = w.start_days + case when p_unit = 'day' then x.amount else 0 end,
      end_days = w.end_days + case when p_unit = 'day' then x.amount else 0 end,
      start_minutes = w.start_minutes + case when p_unit = 'minute' then x.amount else 0 end,
      end_minutes = w.end_minutes + case when p_unit = 'minute' then x.amount else 0 end,
      starts_at = case when p_unit = 'day' then private.add_local_days(w.starts_at, x.amount, w.time_zone)
        else private.add_local_minutes(w.starts_at, x.amount, w.time_zone) end,
      ends_at = case when p_unit = 'day' then private.add_local_days(w.ends_at, x.amount, w.time_zone)
        else private.add_local_minutes(w.ends_at, x.amount, w.time_zone) end,
      due_at = case when p_unit = 'day' then private.add_local_days(w.due_at, x.amount, w.time_zone)
        else private.add_local_minutes(w.due_at, x.amount, w.time_zone) end
    from pushes x
    where w.record_id = x.successor_id and x.amount > 0;
    get diagnostics v_changed = row_count;
    exit when v_changed = 0;
  end loop;

  select w.record_label into v_locked from pg_temp.reschedule_rows w
  where w.locked and w.moved
  order by w.is_target desc, w.record_label limit 1;
  if v_locked is not null then
    perform private.refuse('reschedule_locked', v_locked || ' is locked: it is complete or its window is locked into a baseline.');
  end if;
end;
$$;

comment on function private.plan_reschedule(text) is 'The push rounds of a reschedule (ADR 0111) on pg_temp.reschedule_rows: every successor of a moved row in its project is pushed, in whole days (unit day) or whole minutes (unit minute) of the project''s wall clock, by what its tightest dependency needs beyond the gap it had before the change, through the whole chain. Refuses a circular schedule and a locked row (Complete, or a Timeline window locked into a baseline) that would move, naming it.';
revoke all on function private.plan_reschedule(text) from public, anon, authenticated;

create or replace function private.commit_reschedule(p_reason text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  perform 1 from app.records r
  where r.id in (select w.record_id from pg_temp.reschedule_rows w where w.moved)
  order by r.id for update;
  update app.records r set
    starts_at = w.starts_at,
    ends_at = w.ends_at,
    due_at = w.due_at,
    replan_reason = case when nullif(btrim(p_reason), '') is not null then btrim(p_reason) else r.replan_reason end
  from pg_temp.reschedule_rows w
  where r.id = w.record_id and w.moved;
end;
$$;

comment on function private.commit_reschedule(text) is 'Writes the moved rows of pg_temp.reschedule_rows to app.records under row locks taken in id order, with the reason as the replan reason when one is given (ADR 0111).';
revoke all on function private.commit_reschedule(text) from public, anon, authenticated;

-- 3. One record, by days and minutes -------------------------------------------------------------------------------------

drop function app.reschedule_record(uuid, integer, integer, boolean, text);

create function app.reschedule_record(
  p_record_id uuid,
  p_start_days integer,
  p_end_days integer,
  p_commit boolean default false,
  p_reason text default null,
  p_start_minutes integer default 0,
  p_end_minutes integer default 0
)
returns table (
  record_id uuid,
  is_target boolean,
  shift_start_days integer,
  shift_end_days integer,
  old_starts_at timestamptz,
  old_ends_at timestamptz,
  old_due_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  due_at timestamptz,
  baseline_starts_at timestamptz,
  baseline_ends_at timestamptz,
  shift_start_minutes integer,
  shift_end_minutes integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_record app.records;
  v_time_zone text;
begin
  perform private.require_person();
  if p_start_days is null or p_end_days is null or abs(p_start_days) > 3660 or abs(p_end_days) > 3660 then
    raise exception using errcode = '22023', message = 'start and end shifts are whole days, at most ten years';
  end if;
  if p_start_minutes is null or p_end_minutes is null or abs(p_start_minutes) > 1440 * 14 or abs(p_end_minutes) > 1440 * 14 then
    raise exception using errcode = '22023', message = 'start and end minute shifts are whole minutes, at most fourteen days';
  end if;
  select * into v_record from app.records r where r.id = p_record_id and r.deleted_at is null;
  if v_record.id is null or not private.can_on_project(v_record.project_id, 'schedule.timeline.write') then
    raise exception using errcode = '42501', message = 'schedule.timeline.write is required on the record''s project';
  end if;
  if p_commit then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reschedule:' || v_record.project_id::text, 0));
    select * into v_record from app.records r where r.id = p_record_id for update;
  end if;
  if v_record.starts_at is null and v_record.ends_at is null and v_record.due_at is null then
    perform private.refuse('reschedule_undated', 'Give the record a date before moving it on the timeline.');
  end if;
  if (p_start_days, p_start_minutes) is distinct from (p_end_days, p_end_minutes)
     and (v_record.starts_at is null)::int + (v_record.ends_at is null)::int + (v_record.due_at is null)::int = 2 then
    perform private.refuse('reschedule_single_date', 'A record with one date moves; give it a start and an end to resize it.');
  end if;
  v_time_zone := (select p.time_zone from app.projects p where p.id = v_record.project_id);

  -- A cycle through the record is refused before anything moves: the walk downstream comes back to it. The walk
  -- visits each record once (UNION, as 0310's guard does), not each path, so schedules whose chains split and rejoin
  -- stay cheap. A cycle downstream that misses the record is caught by the planner's round limit.
  if exists (
    with recursive walk (record_id) as (
      select d.successor_record_id from app.record_dependencies d
      where d.predecessor_record_id = p_record_id and d.deleted_at is null
      union
      select d.successor_record_id from app.record_dependencies d
      join walk w on d.predecessor_record_id = w.record_id
      where d.deleted_at is null
    )
    select 1 from walk w where w.record_id = p_record_id
  ) then
    perform private.refuse('reschedule_cycle', 'This schedule is circular; remove a dependency before moving the record.');
  end if;

  perform private.open_reschedule_rows();
  insert into pg_temp.reschedule_rows (record_id, project_id, time_zone, record_label, is_target, locked,
    old_starts_at, old_ends_at, old_due_at, starts_at, ends_at, due_at)
  select r.id, r.project_id, v_time_zone, app.record_display_key(r) || ' ' || r.title, r.id = p_record_id,
    r.record_state = 'Complete' or coalesce(t.baseline_locked_at is not null, false),
    r.starts_at, r.ends_at, r.due_at, r.starts_at, r.ends_at, r.due_at
  from app.records r
  left join app.record_timeline t on t.record_id = r.id
  where r.deleted_at is null and r.record_state <> 'Canceled' and r.project_id = v_record.project_id
    and (r.id = p_record_id or r.id in (
      with recursive walk (record_id) as (
        select d.successor_record_id from app.record_dependencies d
        where d.predecessor_record_id = p_record_id and d.deleted_at is null
        union
        select d.successor_record_id from app.record_dependencies d
        join walk w on d.predecessor_record_id = w.record_id
        where d.deleted_at is null
      )
      select w.record_id from walk w));
  if not exists (select 1 from pg_temp.reschedule_rows w where w.is_target) then
    perform private.refuse('reschedule_canceled', 'A canceled record stays where it was.');
  end if;

  -- The record itself moves only when some part of the change is nonzero: by its days, then its minutes, on the
  -- project's wall clock. Its due time is the end of its window when it has no end, so it moves with the end.
  if p_start_days <> 0 or p_end_days <> 0 or p_start_minutes <> 0 or p_end_minutes <> 0 then
    update pg_temp.reschedule_rows w set
      moved = true,
      start_days = p_start_days,
      end_days = p_end_days,
      start_minutes = p_start_minutes,
      end_minutes = p_end_minutes,
      starts_at = private.add_local_minutes(private.add_local_days(w.old_starts_at, p_start_days, v_time_zone), p_start_minutes, v_time_zone),
      ends_at = private.add_local_minutes(private.add_local_days(w.old_ends_at, p_end_days, v_time_zone), p_end_minutes, v_time_zone),
      due_at = private.add_local_minutes(private.add_local_days(w.old_due_at, p_end_days, v_time_zone), p_end_minutes, v_time_zone)
    where w.is_target;
  end if;
  if exists (
    select 1 from pg_temp.reschedule_rows w
    where w.is_target and coalesce(w.ends_at, w.due_at, w.starts_at) < coalesce(w.starts_at, w.due_at, w.ends_at)
  ) then
    perform private.refuse('reschedule_window', 'A record cannot end before it starts.');
  end if;

  -- A change with a minute part pushes successors by whole minutes; a whole-day change keeps 2260's day pushes.
  perform private.plan_reschedule(case when p_start_minutes = 0 and p_end_minutes = 0 then 'day' else 'minute' end);

  if p_commit then
    perform private.commit_reschedule(p_reason);
  end if;

  return query
  select w.record_id, w.is_target, w.start_days, w.end_days, w.old_starts_at, w.old_ends_at, w.old_due_at,
    w.starts_at, w.ends_at, w.due_at, b.planned_starts_at, b.planned_ends_at, w.start_minutes, w.end_minutes
  from pg_temp.reschedule_rows w
  left join lateral (
    select i.planned_starts_at, i.planned_ends_at
    from app.schedule_baseline_items i
    join app.schedule_baselines sb on sb.id = i.schedule_baseline_id
    where i.record_id = w.record_id and sb.project_id = v_record.project_id
      and sb.locked_at is not null and sb.deleted_at is null
    order by sb.locked_at desc
    limit 1
  ) b on true
  where w.is_target or w.moved
  order by w.is_target desc, coalesce(w.starts_at, w.due_at, w.ends_at), w.record_id;
end;
$$;

comment on function app.reschedule_record(uuid, integer, integer, boolean, text, integer, integer) is 'Moves or resizes a record by whole days and then whole minutes of its project''s wall clock, and pushes the successors whose dependencies the change would break (ADR 0111): by whole days when the change has no minute part, else by whole minutes. Preview mode (p_commit false) writes nothing; commit mode writes the same rows in one transaction. Refuses cycles, a canceled record, locked records (Complete, or a Timeline window locked into a baseline), a window that ends before it starts and a resize of a one-date record. Returns the record and every record it moves, with their old and new dates, the days and minutes each moves and their latest baseline window. Needs schedule.timeline.write on the project.';

revoke all on function app.reschedule_record(uuid, integer, integer, boolean, text, integer, integer) from public, anon;
grant execute on function app.reschedule_record(uuid, integer, integer, boolean, text, integer, integer) to authenticated, service_role;

-- 4. Several records, by the same minutes ----------------------------------------------------------------------------------

create or replace function app.shift_records(
  p_record_ids uuid[],
  p_minutes integer,
  p_commit boolean default false,
  p_reason text default null
)
returns table (
  record_id uuid,
  is_target boolean,
  shift_start_days integer,
  shift_end_days integer,
  old_starts_at timestamptz,
  old_ends_at timestamptz,
  old_due_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  due_at timestamptz,
  baseline_starts_at timestamptz,
  baseline_ends_at timestamptz,
  shift_start_minutes integer,
  shift_end_minutes integer,
  project_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ids uuid[];
  v_project uuid;
  v_cycle uuid;
begin
  perform private.require_person();
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_record_ids, '{}')) x where x is not null;
  if cardinality(v_ids) = 0 then
    perform private.refuse('shift_empty', 'Select at least one record to shift.');
  end if;
  if cardinality(v_ids) > 500 then
    perform private.refuse('shift_too_large', 'Shift at most 500 records at a time.');
  end if;
  if p_minutes is null or p_minutes = 0 or abs(p_minutes) > 10080 then
    raise exception using errcode = '22023', message = 'the shift is a nonzero number of whole minutes, at most seven days';
  end if;
  -- Every selected record must exist and be on a project the caller reschedules.
  if exists (
    select 1 from unnest(v_ids) x
    left join app.records r on r.id = x and r.deleted_at is null
    where r.id is null or not private.can_on_project(r.project_id, 'schedule.timeline.write')
  ) then
    raise exception using errcode = '42501', message = 'schedule.timeline.write is required on every selected record''s project';
  end if;

  if p_commit then
    -- The same per-project locks as app.reschedule_record, taken in project order, then the selection under row locks
    -- in id order, re-read after the locks: nothing below is seeded from a read taken before them.
    for v_project in
      select distinct r.project_id from app.records r where r.id = any (v_ids) order by r.project_id
    loop
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reschedule:' || v_project::text, 0));
    end loop;
    perform 1 from app.records r where r.id = any (v_ids) order by r.id for update;
  end if;

  perform private.open_reschedule_rows();
  -- The targets: every selected record that is dated, live and not Canceled moves rigidly by the minutes. Undated and
  -- Canceled records in the selection stay where they are and are not returned.
  insert into pg_temp.reschedule_rows (record_id, project_id, time_zone, record_label, is_target, locked, moved,
    start_minutes, end_minutes, old_starts_at, old_ends_at, old_due_at, starts_at, ends_at, due_at)
  select r.id, r.project_id, p.time_zone, app.record_display_key(r) || ' ' || r.title, true,
    r.record_state = 'Complete' or coalesce(t.baseline_locked_at is not null, false), true,
    p_minutes, p_minutes, r.starts_at, r.ends_at, r.due_at,
    private.add_local_minutes(r.starts_at, p_minutes, p.time_zone),
    private.add_local_minutes(r.ends_at, p_minutes, p.time_zone),
    private.add_local_minutes(r.due_at, p_minutes, p.time_zone)
  from app.records r
  join app.projects p on p.id = r.project_id
  left join app.record_timeline t on t.record_id = r.id
  where r.id = any (v_ids) and r.deleted_at is null and r.record_state <> 'Canceled'
    and (r.starts_at is not null or r.ends_at is not null or r.due_at is not null);

  -- A cycle through any target is refused before anything moves, as app.reschedule_record refuses one through its
  -- record: the walk from each target visits each downstream record once.
  with recursive walk (start_id, record_id) as (
    select d.predecessor_record_id, d.successor_record_id from app.record_dependencies d
    join pg_temp.reschedule_rows w on w.record_id = d.predecessor_record_id and w.is_target
    where d.deleted_at is null
    union
    select w.start_id, d.successor_record_id from app.record_dependencies d
    join walk w on d.predecessor_record_id = w.record_id
    where d.deleted_at is null
  )
  select w.start_id into v_cycle from walk w where w.record_id = w.start_id limit 1;
  if v_cycle is not null then
    perform private.refuse('reschedule_cycle', 'This schedule is circular; remove a dependency before moving the record.');
  end if;

  -- Successors outside the selection, per project: the records downstream of a target in the target's own project.
  insert into pg_temp.reschedule_rows (record_id, project_id, time_zone, record_label, is_target, locked,
    old_starts_at, old_ends_at, old_due_at, starts_at, ends_at, due_at)
  select r.id, r.project_id, p.time_zone, app.record_display_key(r) || ' ' || r.title, false,
    r.record_state = 'Complete' or coalesce(t.baseline_locked_at is not null, false),
    r.starts_at, r.ends_at, r.due_at, r.starts_at, r.ends_at, r.due_at
  from (
    with recursive walk (project_id, record_id) as (
      select w.project_id, d.successor_record_id from app.record_dependencies d
      join pg_temp.reschedule_rows w on w.record_id = d.predecessor_record_id and w.is_target
      where d.deleted_at is null
      union
      select w.project_id, d.successor_record_id from app.record_dependencies d
      join walk w on d.predecessor_record_id = w.record_id
      where d.deleted_at is null
    )
    select distinct w.project_id, w.record_id from walk w
  ) x
  join app.records r on r.id = x.record_id and r.project_id = x.project_id
  join app.projects p on p.id = r.project_id
  left join app.record_timeline t on t.record_id = r.id
  where r.deleted_at is null and r.record_state <> 'Canceled'
    and r.id not in (select w.record_id from pg_temp.reschedule_rows w);

  perform private.plan_reschedule('minute');

  if (select count(*) from pg_temp.reschedule_rows w where w.moved) > 500 then
    perform private.refuse('shift_too_large', 'This shift would move more than 500 records with their successors; shift fewer at a time.');
  end if;

  if p_commit then
    perform private.commit_reschedule(p_reason);
  end if;

  return query
  select w.record_id, w.is_target, w.start_days, w.end_days, w.old_starts_at, w.old_ends_at, w.old_due_at,
    w.starts_at, w.ends_at, w.due_at, b.planned_starts_at, b.planned_ends_at, w.start_minutes, w.end_minutes, w.project_id
  from pg_temp.reschedule_rows w
  left join lateral (
    select i.planned_starts_at, i.planned_ends_at
    from app.schedule_baseline_items i
    join app.schedule_baselines sb on sb.id = i.schedule_baseline_id
    where i.record_id = w.record_id and sb.project_id = w.project_id
      and sb.locked_at is not null and sb.deleted_at is null
    order by sb.locked_at desc
    limit 1
  ) b on true
  where w.moved
  order by w.is_target desc, w.project_id, coalesce(w.starts_at, w.due_at, w.ends_at), w.record_id;
end;
$$;

comment on function app.shift_records(uuid[], integer, boolean, text) is 'Shifts 1 to 500 selected records by the same nonzero minutes (at most seven days) on each project''s wall clock and pushes their successors outside the selection by whole minutes, project by project (ADR 0111). Selected records move rigidly together, so a dependency between two of them keeps its gap; undated and Canceled ones stay where they are and are not returned. Preview mode (p_commit false) writes nothing; commit mode takes the per-project locks of app.reschedule_record and writes the same rows in one transaction. Refuses an empty or oversized selection, a move set over 500 rows, a cycle and a locked record that would move. Needs schedule.timeline.write on every selected record''s project. Returns every moved record with its project.';

revoke all on function app.shift_records(uuid[], integer, boolean, text) from public, anon;
grant execute on function app.shift_records(uuid[], integer, boolean, text) to authenticated, service_role;
