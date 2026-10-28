-- 2260_timeline_reschedule.sql
-- A133 (RRR-195; ADR 0022 block 2260 to 2269). Drag to reschedule on the timeline (Section 11.11, S11.11-01).
--
--   * app.reschedule_record(record, start days, end days, commit, reason) moves or resizes one record by whole days
--     of its project's calendar and pushes every successor whose dependency the change would break, by the fewest
--     whole days that keep it, through the whole downstream chain. Moving a record earlier never pulls a successor
--     with it, and a dependency that was already broken before the change keeps its gap: only what the change adds
--     is pushed (ADR 0111).
--   * Preview mode returns the rows the change would move and writes nothing; commit mode computes the same rows the
--     same way and writes them in one transaction under a per-project lock, so what the person saw is what lands.
--     Both modes refuse the same things: a dependency cycle, a record or successor that is locked (a Timeline window
--     locked into a baseline, or a Complete record), a change that would end a record before it starts, and a resize
--     of a record that carries one date.
--   * Baselines are never touched: each returned row carries the record's window in the project's latest locked
--     baseline, so the preview shows the variance the change makes. Canceled records neither move nor hold others.

create or replace function private.add_local_days(p_at timestamptz, p_days integer, p_time_zone text)
returns timestamptz
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when p_at is null then null
    else ((p_at at time zone p_time_zone) + pg_catalog.make_interval(days => p_days)) at time zone p_time_zone end;
$$;

comment on function private.add_local_days(timestamptz, integer, text) is 'The instant moved by whole calendar days in a time zone, keeping its wall-clock time across daylight saving changes; NULL stays NULL.';

revoke all on function private.add_local_days(timestamptz, integer, text) from public, anon;
grant execute on function private.add_local_days(timestamptz, integer, text) to authenticated, service_role;

create or replace function app.reschedule_record(
  p_record_id uuid,
  p_start_days integer,
  p_end_days integer,
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
  baseline_ends_at timestamptz
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
  v_rounds integer := 0;
  v_limit integer;
  v_changed integer;
  v_locked text;
begin
  perform private.require_person();
  if p_start_days is null or p_end_days is null or abs(p_start_days) > 3660 or abs(p_end_days) > 3660 then
    raise exception using errcode = '22023', message = 'start and end shifts are whole days, at most ten years';
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
  if p_start_days <> p_end_days
     and (v_record.starts_at is null)::int + (v_record.ends_at is null)::int + (v_record.due_at is null)::int = 2 then
    perform private.refuse('reschedule_single_date', 'A record with one date moves; give it a start and an end to resize it.');
  end if;
  v_time_zone := (select p.time_zone from app.projects p where p.id = v_record.project_id);

  -- The record and everything downstream of it; a cycle anywhere downstream is refused before anything moves.
  if exists (
    with recursive walk (record_id) as (
      select d.successor_record_id from app.record_dependencies d
      where d.predecessor_record_id = p_record_id and d.deleted_at is null
      union all
      select d.successor_record_id from app.record_dependencies d
      join walk w on d.predecessor_record_id = w.record_id
      where d.deleted_at is null
    ) cycle record_id set is_cycle using path
    select 1 from walk w where w.is_cycle or w.record_id = p_record_id
  ) then
    perform private.refuse('reschedule_cycle', 'This schedule is circular; remove a dependency before moving the record.');
  end if;

  -- A working table for this transaction, made once per transaction (a second call in it reuses it).
  if pg_catalog.to_regclass('pg_temp.reschedule_rows') is null then
    create temporary table pg_temp.reschedule_rows (
      record_id uuid primary key,
      record_label text not null,
      is_target boolean not null,
      locked boolean not null,
      start_days integer not null default 0,
      end_days integer not null default 0,
      old_starts_at timestamptz,
      old_ends_at timestamptz,
      old_due_at timestamptz,
      starts_at timestamptz,
      ends_at timestamptz,
      due_at timestamptz
    ) on commit drop;
  end if;
  truncate pg_temp.reschedule_rows;

  insert into pg_temp.reschedule_rows (record_id, record_label, is_target, locked, old_starts_at, old_ends_at, old_due_at,
    starts_at, ends_at, due_at)
  select r.id, app.record_display_key(r) || ' ' || r.title, r.id = p_record_id,
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
    perform private.refuse('reschedule_locked', 'A canceled record stays where it was.');
  end if;

  -- The record itself. Its due time is the end of its window when it has no end, so it moves with the end.
  update pg_temp.reschedule_rows w set
    start_days = p_start_days,
    end_days = p_end_days,
    starts_at = private.add_local_days(w.old_starts_at, p_start_days, v_time_zone),
    ends_at = private.add_local_days(w.old_ends_at, p_end_days, v_time_zone),
    due_at = private.add_local_days(w.old_due_at, p_end_days, v_time_zone)
  where w.is_target;
  if exists (
    select 1 from pg_temp.reschedule_rows w
    where w.is_target and coalesce(w.ends_at, w.due_at, w.starts_at) < coalesce(w.starts_at, w.due_at, w.ends_at)
  ) then
    perform private.refuse('reschedule_window', 'A record cannot end before it starts.');
  end if;

  -- Successors, round by round: each round pushes every successor of a moved record by the whole days its tightest
  -- dependency needs beyond the gap it had before the change, measured on the project's wall clock. The graph is
  -- acyclic, so the rounds end within one round per record.
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
          at time zone v_time_zone)
          - (case when d.dependency_type in ('Finish to Start', 'Start to Start')
            then coalesce(s.starts_at, s.due_at, s.ends_at) else coalesce(s.ends_at, s.due_at, s.starts_at) end
          at time zone v_time_zone)
          + d.lag) as gap_now,
        greatest(0, extract(epoch from (
          case when d.dependency_type in ('Finish to Start', 'Finish to Finish')
            then coalesce(p.old_ends_at, p.old_due_at, p.old_starts_at) else coalesce(p.old_starts_at, p.old_due_at, p.old_ends_at) end
          at time zone v_time_zone)
          - (case when d.dependency_type in ('Finish to Start', 'Start to Start')
            then coalesce(s.old_starts_at, s.old_due_at, s.old_ends_at) else coalesce(s.old_ends_at, s.old_due_at, s.old_starts_at) end
          at time zone v_time_zone)
          + d.lag)) as gap_before
      from app.record_dependencies d
      join pg_temp.reschedule_rows p on p.record_id = d.predecessor_record_id and (p.start_days <> 0 or p.end_days <> 0)
      join pg_temp.reschedule_rows s on s.record_id = d.successor_record_id and not s.is_target
      where d.deleted_at is null
    ), pushes as (
      select e.successor_id, max(ceil((e.gap_now - e.gap_before) / 86400.0))::integer as days
      from edges e
      where e.gap_now > e.gap_before
      group by e.successor_id
    )
    update pg_temp.reschedule_rows w set
      start_days = w.start_days + x.days,
      end_days = w.end_days + x.days,
      starts_at = private.add_local_days(w.starts_at, x.days, v_time_zone),
      ends_at = private.add_local_days(w.ends_at, x.days, v_time_zone),
      due_at = private.add_local_days(w.due_at, x.days, v_time_zone)
    from pushes x
    where w.record_id = x.successor_id and x.days > 0;
    get diagnostics v_changed = row_count;
    exit when v_changed = 0;
  end loop;

  select w.record_label into v_locked from pg_temp.reschedule_rows w
  where w.locked and (w.start_days <> 0 or w.end_days <> 0)
  order by w.is_target desc, w.record_label limit 1;
  if v_locked is not null then
    perform private.refuse('reschedule_locked', v_locked || ' is locked: it is complete or its window is locked into a baseline.');
  end if;

  if p_commit then
    perform 1 from app.records r
    where r.id in (select w.record_id from pg_temp.reschedule_rows w where w.start_days <> 0 or w.end_days <> 0)
    order by r.id for update;
    update app.records r set
      starts_at = w.starts_at,
      ends_at = w.ends_at,
      due_at = w.due_at,
      replan_reason = case when nullif(btrim(p_reason), '') is not null then btrim(p_reason) else r.replan_reason end
    from pg_temp.reschedule_rows w
    where r.id = w.record_id and (w.start_days <> 0 or w.end_days <> 0);
  end if;

  return query
  select w.record_id, w.is_target, w.start_days, w.end_days, w.old_starts_at, w.old_ends_at, w.old_due_at,
    w.starts_at, w.ends_at, w.due_at, b.planned_starts_at, b.planned_ends_at
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
  where w.is_target or w.start_days <> 0 or w.end_days <> 0
  order by w.is_target desc, coalesce(w.starts_at, w.due_at, w.ends_at), w.record_id;
end;
$$;

comment on function app.reschedule_record(uuid, integer, integer, boolean, text) is 'Moves or resizes a record by whole days of its project''s calendar and pushes the successors whose dependencies the change would break (ADR 0111). Preview mode (p_commit false) writes nothing; commit mode writes the same rows in one transaction. Refuses cycles, locked records (Complete, or a Timeline window locked into a baseline), a window that ends before it starts and a resize of a one-date record. Returns the record and every record it moves, with their old and new dates and their latest baseline window. Needs schedule.timeline.write on the project.';

revoke all on function app.reschedule_record(uuid, integer, integer, boolean, text) from public, anon;
grant execute on function app.reschedule_record(uuid, integer, integer, boolean, text) to authenticated, service_role;
