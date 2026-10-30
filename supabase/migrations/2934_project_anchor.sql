-- 2934_project_anchor.sql
-- B4 Scheduling depth (RRR-228; parity gap G-44; ADR 0143 decision 4; ADR 0111; ADR 0022 block 2930 to 2939). Anchor
-- offset scheduling: a project's plan counts from its anchor day (projects.anchor_on, 1180, usually the show day), and
-- moving the anchor moves the plan with it.
--
--   * app.records.anchor_pinned: a record that stays on its dates when the anchor moves, such as a fixed permit
--     deadline. v1 selects explicit columns, so the contract does not change.
--   * app.move_project_anchor(project, anchor, commit, reason) is the only path that moves the plan. A plain update of
--     anchor_on (v1 PATCH /projects, the Set anchor control) moves nothing, and no trigger is added; the first anchor
--     is set that way (anchor_unset until then). The move:
--       - records: every live, dated record that is not Complete or Canceled, not pinned and not locked into a baseline
--         moves rigidly by the change in whole days of the project's wall clock, through P8's planner (2850). Their
--         successors outside that set (pinned, Complete or baseline-locked records; Canceled ones are left out, as P8
--         leaves them) are seeded as app.shift_records seeds them, pinned ones unlocked, and private.plan_reschedule('day')
--         refuses a cycle and a locked record it would push (reschedule_locked). A pinned record it would push refuses
--         anchor_pinned_pushed, naming it. At most 2000 records move (anchor_too_large).
--       - running orders: show_date and curfew_at move by the same local days, and their live cues' planned times too
--         (standby_at is not touched). A called cue refuses anchor_show_started.
--       - project days, and day and call sheets that are not published, move by the same days, one row at a time in
--         the order that keeps every partial unique index true at each step. Published sheets stay; an unpublished
--         sheet that would land on a published one refuses anchor_sheet_collision, naming the date.
--       - the project: anchor_on, and starts_on and ends_on when set.
--     Shifts never move (ADR 0143 decision 4): moving booked people could create double bookings nobody sees. They are
--     listed for holders of crew.shift.read, and dock slots, which are booked, for holders of logistics.shipment.read;
--     records are listed for holders of work.record.read, and running orders, cues and sheets for holders of
--     show.run_of_show.read, so the definer never shows a row its caller cannot read. Work orders, travel segments, engagement dates and
--     roster arrival windows never move and are not listed.
--   * It is security definer because P8's planner is private: it needs projects.project.write and
--     schedule.timeline.write on the project, show.run_of_show.write when a running order moves, show.day_sheet.write
--     when a day sheet moves and show.call_sheet.publish when a call sheet moves (42501). A commit takes the project's
--     reschedule lock, as app.reschedule_record does, and writes one audit event. Preview and commit return the same rows.

alter table app.records add column anchor_pinned boolean not null default false;
comment on column app.records.anchor_pinned is 'Stays on its dates when the project''s anchor moves.';

create or replace function app.move_project_anchor(
  p_project_id uuid,
  p_anchor_on date,
  p_commit boolean default false,
  p_reason text default null
)
returns table (
  item_kind text,
  item_id uuid,
  label text,
  moves boolean,
  stays_because text,
  old_at timestamptz,
  new_at timestamptz,
  old_on date,
  new_on date,
  shift_days integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_project app.projects;
  v_delta integer;
  v_zone text;
  v_count integer;
  v_label text;
  v_day date;
  v_row record;
  v_shifts boolean;
  v_docks boolean;
  v_records boolean;
  v_show boolean;
begin
  perform private.require_person();
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null or not private.can_on_project(p_project_id, 'projects.project.write')
     or not private.can_on_project(p_project_id, 'schedule.timeline.write') then
    raise exception using errcode = '42501', message = 'projects.project.write and schedule.timeline.write are required on the project';
  end if;
  if p_anchor_on is null then
    raise exception using errcode = '22023', message = 'the new anchor is a date';
  end if;
  if p_commit then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reschedule:' || p_project_id::text, 0));
    select * into v_project from app.projects p where p.id = p_project_id for update;
  end if;
  if v_project.anchor_on is null then
    perform private.refuse('anchor_unset', 'Set the project''s anchor day before moving it.');
  end if;
  v_delta := p_anchor_on - v_project.anchor_on;
  if abs(v_delta) > 3660 then
    raise exception using errcode = '22023', message = 'the anchor moves at most ten years either way';
  end if;
  v_zone := v_project.time_zone;
  v_shifts := private.can_on_project(p_project_id, 'crew.shift.read');
  v_docks := private.can_on_project(p_project_id, 'logistics.shipment.read');
  v_records := private.can_on_project(p_project_id, 'work.record.read');
  v_show := private.can_on_project(p_project_id, 'show.run_of_show.read');

  -- Records through P8's planner -----------------------------------------------------------------------------------------
  perform private.open_reschedule_rows();
  insert into pg_temp.reschedule_rows (record_id, project_id, time_zone, record_label, is_target, locked, moved,
    start_days, end_days, old_starts_at, old_ends_at, old_due_at, starts_at, ends_at, due_at)
  select r.id, r.project_id, v_zone, app.record_display_key(r) || ' ' || r.title, true, false, v_delta <> 0,
    v_delta, v_delta, r.starts_at, r.ends_at, r.due_at,
    private.add_local_days(r.starts_at, v_delta, v_zone),
    private.add_local_days(r.ends_at, v_delta, v_zone),
    private.add_local_days(r.due_at, v_delta, v_zone)
  from app.records r
  left join app.record_timeline t on t.record_id = r.id
  where r.project_id = p_project_id and r.deleted_at is null and r.record_state not in ('Complete', 'Canceled')
    and not r.anchor_pinned and t.baseline_locked_at is null
    and (r.starts_at is not null or r.ends_at is not null or r.due_at is not null);
  get diagnostics v_count = row_count;
  if v_count > 2000 then
    perform private.refuse('anchor_too_large', 'This anchor move would move more than 2000 records; move the plan in parts.');
  end if;

  if v_delta <> 0 then
    -- Successors outside the moving set, as app.shift_records seeds them: downstream of a target in the project.
    insert into pg_temp.reschedule_rows (record_id, project_id, time_zone, record_label, is_target, locked,
      old_starts_at, old_ends_at, old_due_at, starts_at, ends_at, due_at)
    select r.id, r.project_id, v_zone, app.record_display_key(r) || ' ' || r.title, false,
      r.record_state = 'Complete' or coalesce(t.baseline_locked_at is not null, false),
      r.starts_at, r.ends_at, r.due_at, r.starts_at, r.ends_at, r.due_at
    from (
      with recursive walk (record_id) as (
        select d.successor_record_id from app.record_dependencies d
        join pg_temp.reschedule_rows w on w.record_id = d.predecessor_record_id and w.is_target
        where d.deleted_at is null
        union
        select d.successor_record_id from app.record_dependencies d
        join walk w on d.predecessor_record_id = w.record_id
        where d.deleted_at is null
      )
      select distinct w.record_id from walk w
    ) x
    join app.records r on r.id = x.record_id and r.project_id = p_project_id
    left join app.record_timeline t on t.record_id = r.id
    where r.deleted_at is null and r.record_state <> 'Canceled'
      and r.id not in (select w.record_id from pg_temp.reschedule_rows w);

    perform private.plan_reschedule('day');

    select w.record_label into v_label from pg_temp.reschedule_rows w
    join app.records r on r.id = w.record_id
    where not w.is_target and w.moved and r.anchor_pinned
    order by w.record_label limit 1;
    if v_label is not null then
      perform private.refuse('anchor_pinned_pushed',
        v_label || ' stays on its dates when the anchor moves, and this move would push it; unpin it or move its predecessor first.');
    end if;
  end if;

  -- What moves and what stays, computed before anything is written so preview and commit return the same rows ----------
  create temporary table if not exists pg_temp.anchor_rows (
    item_kind text, item_id uuid, label text, moves boolean, stays_because text,
    old_at timestamptz, new_at timestamptz, old_on date, new_on date, shift_days integer, ordinal integer,
    visible boolean not null default true
  ) on commit drop;
  truncate pg_temp.anchor_rows;

  insert into pg_temp.anchor_rows values ('Project', v_project.id, v_project.project_key || ' ' || v_project.name,
    v_delta <> 0, null, null, null, v_project.anchor_on, p_anchor_on, v_delta, 0);

  insert into pg_temp.anchor_rows
  select 'Record', w.record_id, w.record_label, w.moved, null,
    coalesce(w.old_starts_at, w.old_due_at, w.old_ends_at), coalesce(w.starts_at, w.due_at, w.ends_at), null, null,
    w.start_days, 1
  from pg_temp.reschedule_rows w where w.is_target;

  insert into pg_temp.anchor_rows
  select 'Record', r.id, app.record_display_key(r) || ' ' || r.title, false,
    case when r.starts_at is null and r.ends_at is null and r.due_at is null then 'undated'
      when r.record_state = 'Complete' then 'complete'
      when t.baseline_locked_at is not null then 'baseline_locked'
      else 'pinned' end,
    coalesce(r.starts_at, r.due_at, r.ends_at), coalesce(r.starts_at, r.due_at, r.ends_at), null, null, 0, 2
  from app.records r
  left join app.record_timeline t on t.record_id = r.id
  where r.project_id = p_project_id and r.deleted_at is null and r.record_state <> 'Canceled'
    and r.id not in (select w.record_id from pg_temp.reschedule_rows w where w.is_target);

  if exists (
    select 1 from app.cues c join app.run_of_show s on s.id = c.run_of_show_id
    where s.project_id = p_project_id and s.deleted_at is null and c.deleted_at is null and c.called_at is not null
  ) and v_delta <> 0 then
    perform private.refuse('anchor_show_started', 'A cue of this project''s running orders has been called, so its shows have started and stay on their dates.');
  end if;
  insert into pg_temp.anchor_rows
  select 'Running Order', s.id, s.name, v_delta <> 0, null, s.curfew_at, private.add_local_days(s.curfew_at, v_delta, v_zone),
    s.show_date, s.show_date + v_delta, v_delta, 3
  from app.run_of_show s where s.project_id = p_project_id and s.deleted_at is null;
  insert into pg_temp.anchor_rows
  select 'Cue', c.id, c.label, v_delta <> 0 and c.planned_at is not null, case when c.planned_at is null then 'undated' end,
    c.planned_at, private.add_local_days(c.planned_at, v_delta, v_zone), null, null, v_delta, 4
  from app.cues c join app.run_of_show s on s.id = c.run_of_show_id
  where s.project_id = p_project_id and s.deleted_at is null and c.deleted_at is null;

  insert into pg_temp.anchor_rows
  select 'Project Day', d.id, coalesce(d.label, d.day_type::text), v_delta <> 0, null, null, null,
    d.day_on, d.day_on + v_delta, v_delta, 5
  from app.project_days d where d.project_id = p_project_id and d.deleted_at is null;
  insert into pg_temp.anchor_rows
  select 'Day Sheet', d.id, d.day::text, v_delta <> 0 and d.published_at is null,
    case when d.published_at is not null then 'published' end, null, null, d.day,
    case when d.published_at is null then d.day + v_delta else d.day end, case when d.published_at is null then v_delta else 0 end, 6
  from app.day_sheets d where d.project_id = p_project_id and d.deleted_at is null;
  insert into pg_temp.anchor_rows
  select 'Call Sheet', c.id, c.day::text, v_delta <> 0 and c.published_at is null,
    case when c.published_at is not null then 'published' end, null, null, c.day,
    case when c.published_at is null then c.day + v_delta else c.day end, case when c.published_at is null then v_delta else 0 end, 7
  from app.call_sheets c where c.project_id = p_project_id and c.deleted_at is null;

  if v_shifts then
    insert into pg_temp.anchor_rows
    select 'Shift', s.id, coalesce(pp.full_name, s.role_code, 'Open shift'), false, 'shift', s.starts_at, s.starts_at,
      null, null, 0, 8
    from app.shifts s
    left join app.memberships m on m.id = s.membership_id
    left join app.people pp on pp.id = m.person_id
    where s.project_id = p_project_id and s.deleted_at is null and s.shift_state <> 'Canceled';
  end if;
  if v_docks then
    insert into pg_temp.anchor_rows
    select 'Dock Slot', d.id, z.code || ' ' || z.name, false, 'booked', d.starts_at, d.starts_at, null, null, 0, 9
    from app.dock_slots d join app.zones z on z.id = d.zone_id
    where d.project_id = p_project_id and d.deleted_at is null;
  end if;

  -- The definer returns only rows its caller reads: records with work.record.read, running orders, cues and sheets with
  -- show.run_of_show.read (their tables' read capability). Hidden rows still move, and still count in the checks below.
  update pg_temp.anchor_rows a set visible = false
  where (a.item_kind = 'Record' and not v_records)
     or (a.item_kind in ('Running Order', 'Cue', 'Day Sheet', 'Call Sheet') and not v_show);

  -- Capabilities for what moves, and the published sheets an unpublished one would land on.
  if v_delta <> 0 then
    if exists (select 1 from pg_temp.anchor_rows a where a.item_kind = 'Running Order')
       and not private.can_on_project(p_project_id, 'show.run_of_show.write') then
      raise exception using errcode = '42501', message = 'show.run_of_show.write is required to move the running orders';
    end if;
    if exists (select 1 from pg_temp.anchor_rows a where a.item_kind = 'Day Sheet' and a.moves)
       and not private.can_on_project(p_project_id, 'show.day_sheet.write') then
      raise exception using errcode = '42501', message = 'show.day_sheet.write is required to move the day sheets';
    end if;
    if exists (select 1 from pg_temp.anchor_rows a where a.item_kind = 'Call Sheet' and a.moves)
       and not private.can_on_project(p_project_id, 'show.call_sheet.publish') then
      raise exception using errcode = '42501', message = 'show.call_sheet.publish is required to move the call sheets';
    end if;
    select a.new_on into v_day from pg_temp.anchor_rows a
    join pg_temp.anchor_rows b on b.item_kind = a.item_kind and b.stays_because = 'published' and b.old_on = a.new_on
    where a.item_kind in ('Day Sheet', 'Call Sheet') and a.moves
    order by a.new_on limit 1;
    if v_day is not null then
      perform private.refuse('anchor_sheet_collision',
        'A published sheet already covers ' || v_day::text || '; it stays, so the sheet that would move onto it cannot.');
    end if;
  end if;

  -- The commit ----------------------------------------------------------------------------------------------------------
  if p_commit and v_delta <> 0 then
    perform private.commit_reschedule(p_reason);

    update app.run_of_show s set show_date = s.show_date + v_delta,
      curfew_at = private.add_local_days(s.curfew_at, v_delta, v_zone)
    where s.project_id = p_project_id and s.deleted_at is null;
    update app.cues c set planned_at = private.add_local_days(c.planned_at, v_delta, v_zone)
    from app.run_of_show s
    where s.id = c.run_of_show_id and s.project_id = p_project_id and s.deleted_at is null
      and c.deleted_at is null and c.planned_at is not null;

    -- One row at a time, the far end first, so (project, day) stays unique at every step.
    for v_row in
      select a.item_kind, a.item_id, a.new_on from pg_temp.anchor_rows a
      where a.item_kind in ('Project Day', 'Day Sheet', 'Call Sheet') and a.moves
      order by a.item_kind, case when v_delta > 0 then -extract(epoch from a.old_on::timestamp) else extract(epoch from a.old_on::timestamp) end
    loop
      if v_row.item_kind = 'Project Day' then
        update app.project_days set day_on = v_row.new_on where id = v_row.item_id;
      elsif v_row.item_kind = 'Day Sheet' then
        update app.day_sheets set day = v_row.new_on where id = v_row.item_id;
      else
        update app.call_sheets set day = v_row.new_on where id = v_row.item_id;
      end if;
    end loop;

    update app.projects p set anchor_on = p_anchor_on,
      starts_on = case when p.starts_on is not null then p.starts_on + v_delta end,
      ends_on = case when p.ends_on is not null then p.ends_on + v_delta end
    where p.id = p_project_id;

    perform private.write_audit_event(v_project.org_id, 'project.anchor_moved', 'app.projects', p_project_id,
      jsonb_build_object('from', v_project.anchor_on, 'to', p_anchor_on, 'reason', nullif(btrim(p_reason), ''),
        'counts', (select jsonb_object_agg(k.item_kind, k.n) from (
          select a.item_kind, count(*) as n from pg_temp.anchor_rows a where a.moves group by a.item_kind) k)));
  end if;

  return query
  select a.item_kind, a.item_id, a.label, a.moves, a.stays_because, a.old_at, a.new_at, a.old_on, a.new_on, a.shift_days
  from pg_temp.anchor_rows a
  where a.visible
  order by a.ordinal, coalesce(a.old_at, a.old_on::timestamptz), a.label, a.item_id;
end;
$$;

comment on function app.move_project_anchor(uuid, date, boolean, text) is 'Moves a project''s anchor day and its plan with it (G-44, ADR 0143 decision 4): every live, dated record that is not Complete, Canceled, pinned (anchor_pinned) or baseline-locked moves rigidly by the change in whole days of the project''s wall clock through P8''s planner, which refuses a cycle and a locked successor it would push (reschedule_locked); a pinned successor it would push refuses anchor_pinned_pushed. Running orders (show date, curfew) and their cues, project days and unpublished day and call sheets move by the same days; published sheets stay (anchor_sheet_collision when an unpublished one would land on one); the project''s anchor, start and end move. Shifts never move and are listed for crew.shift.read holders; dock slots are listed as booked for logistics.shipment.read holders; records are listed for work.record.read holders, and running orders, cues and sheets for show.run_of_show.read holders, so no row the caller cannot read is returned. Refuses anchor_unset, anchor_too_large (over 2000 records), anchor_show_started (a called cue) and a change beyond 3660 days (22023). Needs projects.project.write and schedule.timeline.write, plus show.run_of_show.write, show.day_sheet.write or show.call_sheet.publish for what moves (42501). Preview (p_commit false) writes nothing; commit takes the project''s reschedule lock, writes the same rows and one project.anchor_moved audit event. Returns every item with whether it moves, why it stays, its old and new time or date and the days it moves.';
revoke all on function app.move_project_anchor(uuid, date, boolean, text) from public, anon;
grant execute on function app.move_project_anchor(uuid, date, boolean, text) to authenticated, service_role;
