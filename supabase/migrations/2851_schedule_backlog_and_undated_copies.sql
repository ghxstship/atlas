-- 2851_schedule_backlog_and_undated_copies.sql
-- P8 (RRR-222; parity gap G-36; ADR 0022 block 2850 to 2859; ADR 0111 amended 2026-10-28). The schedule's unscheduled
-- backlog and copies without dates (Section 11.11, S11.11-01; Section 4.9, S4.9-01).
--
--   * app.place_record(record, day) gives an undated record its first dates on a day of its project's calendar, the
--     placement a drag from the Unscheduled list onto the timeline makes: a Milestone is due at 17:00, any other kind
--     runs from 09:00 to 17:00. It is not a move (app.reschedule_record refuses undated records); its successors are
--     pushed by whole days until their dependencies hold, through 2850's planner, as a move pushes them. A dependency
--     on a predecessor that the placement breaks is allowed, as ADR 0111 allows broken dependencies. Complete and
--     Canceled records stay unscheduled.
--   * app.apply_template gains p_without_dates: the project still takes the start date, and every templated record is
--     created undated, to wait in the schedule's Unscheduled list.
--   * app.create_template_from_project gains p_keep_dates (default true): false saves every record item with no due
--     offset.
-- The v1 API calls both with named parameters and is unchanged; the frozen v1 contract is not extended.

-- 1. Placing an undated record -------------------------------------------------------------------------------------------

create or replace function app.place_record(
  p_record_id uuid,
  p_day date,
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
  if p_day is null then
    raise exception using errcode = '22023', message = 'the day to place the record on is required';
  end if;
  select * into v_record from app.records r where r.id = p_record_id and r.deleted_at is null;
  if v_record.id is null or not private.can_on_project(v_record.project_id, 'schedule.timeline.write') then
    raise exception using errcode = '42501', message = 'schedule.timeline.write is required on the record''s project';
  end if;
  if p_commit then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reschedule:' || v_record.project_id::text, 0));
    select * into v_record from app.records r where r.id = p_record_id for update;
  end if;
  if v_record.starts_at is not null or v_record.ends_at is not null or v_record.due_at is not null then
    perform private.refuse('place_dated', 'This record already has dates; drag its bar instead.');
  end if;
  if v_record.record_state in ('Complete', 'Canceled') then
    perform private.refuse('reschedule_locked',
      app.record_display_key(v_record) || ' ' || v_record.title || ' is locked: it is complete or canceled, so it stays unscheduled.');
  end if;
  v_time_zone := (select p.time_zone from app.projects p where p.id = v_record.project_id);

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

  -- The placement: old dates stay null, so the planner reads the gap the record had as zero and pushes successors
  -- until their dependencies hold.
  update pg_temp.reschedule_rows w set
    moved = true,
    starts_at = case when v_record.record_kind = 'Milestone' then null else (p_day + time '09:00') at time zone v_time_zone end,
    ends_at = case when v_record.record_kind = 'Milestone' then null else (p_day + time '17:00') at time zone v_time_zone end,
    due_at = case when v_record.record_kind = 'Milestone' then (p_day + time '17:00') at time zone v_time_zone end
  where w.is_target;

  perform private.plan_reschedule('day');

  if (select count(*) from pg_temp.reschedule_rows w where w.moved) > 500 then
    perform private.refuse('shift_too_large', 'This placement would move more than 500 records with their successors.');
  end if;

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
  where w.moved
  order by w.is_target desc, coalesce(w.starts_at, w.due_at, w.ends_at), w.record_id;
end;
$$;

comment on function app.place_record(uuid, date, boolean, text) is 'Places an undated record on a day of its project''s calendar (the schedule''s Unscheduled list, ADR 0111): a Milestone is due at 17:00, any other kind runs from 09:00 to 17:00 project time. Successors are pushed by whole days until their dependencies hold; a dependency on a predecessor the placement breaks is allowed. Preview mode (p_commit false) writes nothing; commit mode takes the reschedule lock and writes the same rows. Refuses a dated record (place_dated), a Complete or Canceled one and a placement that would push a locked record. Needs schedule.timeline.write on the project. Returns the record and every record it moves, as app.reschedule_record does.';

revoke all on function app.place_record(uuid, date, boolean, text) from public, anon;
grant execute on function app.place_record(uuid, date, boolean, text) to authenticated, service_role;

-- 2. Applying a template without dates ------------------------------------------------------------------------------------
-- Restated from 1032, its only definition, with the trailing p_without_dates.

drop function app.apply_template(uuid, text, text, text, date, uuid);

create function app.apply_template(
  p_template_id uuid,
  p_project_key text,
  p_name text,
  p_time_zone text default null,
  p_starts_on date default null,
  p_venue_id uuid default null,
  p_without_dates boolean default false
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_template app.templates;
  v_version app.template_versions;
  v_project uuid;
  v_root uuid;
  v_key text := upper(btrim(p_project_key));
  v_zone text;
  v_item app.template_items;
  v_nodes integer := 0;
  v_records integer := 0;
  v_application uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  select * into v_template from app.templates t where t.id = p_template_id and t.deleted_at is null;
  if v_template.id is null then
    raise exception using errcode = '42501', message = 'template not found';
  end if;
  if v_template.current_version_id is null then
    raise exception using errcode = 'XR001', hint = 'template_unpublished',
      message = 'template_unpublished: Publish a version of the template before creating projects from it.';
  end if;
  select * into v_version from app.template_versions v where v.id = v_template.current_version_id;
  v_zone := coalesce(nullif(btrim(p_time_zone), ''), v_version.default_time_zone);
  if v_zone is null then
    raise exception using errcode = 'XR001', hint = 'template_time_zone_required',
      message = 'template_time_zone_required: Choose the project''s time zone; the template does not set one.';
  end if;

  v_project := app.create_project(v_template.org_id, v_key, p_name, v_zone, v_version.default_jurisdiction_id,
    v_version.default_region_code, v_version.default_tier_code, p_venue_id, p_starts_on,
    case when p_starts_on is not null and v_version.duration_days is not null then p_starts_on + v_version.duration_days - 1 end,
    v_version.default_currency_code, v_template.description);
  select n.id into v_root from app.scope_nodes n where n.project_id = v_project and n.parent_id is null and n.deleted_at is null;

  for v_item in
    select * from app.template_items i
    where i.template_version_id = v_version.id and i.deleted_at is null
    order by i.sort_order, i.id
  loop
    if v_item.item_kind = 'Scope Node' then
      insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name, venue_id)
      values (v_project, v_root, v_item.scope_kind, v_key || '-' || v_item.scope_code_suffix, v_item.name,
        case when v_item.scope_kind = 'Show' then p_venue_id end);
      v_nodes := v_nodes + 1;
    else
      insert into app.records (project_id, scope_node_id, record_kind, title, phase_code, xyz, xyz_basis, due_at, time_zone)
      values (v_project, v_root, v_item.record_kind, v_item.name, v_item.phase_code, v_item.xyz, 'Declared',
        case when not coalesce(p_without_dates, false) and p_starts_on is not null and v_item.due_offset_days is not null
          then ((p_starts_on + v_item.due_offset_days)::timestamp + time '17:00') at time zone v_zone end,
        v_zone);
      v_records := v_records + 1;
    end if;
  end loop;

  insert into app.template_applications (template_id, template_version_id, project_id, scope_nodes_created, records_created)
  values (v_template.id, v_version.id, v_project, v_nodes, v_records)
  returning id into v_application;
  return v_application;
end;
$$;

comment on function app.apply_template(uuid, text, text, text, date, uuid, boolean) is 'Creates a project from a template''s current version as the caller: app.create_project with the version''s defaults (the given time zone wins), then its scope nodes under the engagement root ({KEY}-{suffix}) and its records, due at 17:00 project time on the start date plus their offset, or undated when p_without_dates is true (they wait in the schedule''s Unscheduled list; the project still takes the start date). Row level security and the guards of every table decide. Records the application and returns its id.';
revoke all on function app.apply_template(uuid, text, text, text, date, uuid, boolean) from public, anon;
grant execute on function app.apply_template(uuid, text, text, text, date, uuid, boolean) to authenticated, service_role;

-- 3. Saving a template without due offsets --------------------------------------------------------------------------------
-- Restated from 1032, its only definition, with the trailing p_keep_dates.

drop function app.create_template_from_project(uuid, text, text);

create function app.create_template_from_project(
  p_project_id uuid,
  p_name text,
  p_description text default null,
  p_keep_dates boolean default true
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_project app.projects;
  v_template uuid;
  v_version uuid;
  v_order integer := 0;
  v_node record;
  v_record record;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  insert into app.templates (org_id, name, description) values (v_project.org_id, btrim(p_name), nullif(btrim(p_description), ''))
  returning id into v_template;
  insert into app.template_versions (template_id, notes, default_time_zone, default_tier_code, default_region_code,
    default_jurisdiction_id, default_currency_code, duration_days)
  values (v_template, 'Saved from project ' || v_project.project_key || '.', v_project.time_zone, v_project.tier_code,
    v_project.region_code, v_project.jurisdiction_id, v_project.currency,
    case when v_project.starts_on is not null and v_project.ends_on is not null then v_project.ends_on - v_project.starts_on + 1 end)
  returning id into v_version;
  for v_node in
    select n.scope_kind, n.scope_code, n.name from app.scope_nodes n
    where n.project_id = v_project.id and n.parent_id is not null and n.deleted_at is null
      and n.scope_kind in ('Standing Venue', 'Show')
      and n.scope_code like v_project.project_key || '-%'
    order by n.path
  loop
    v_order := v_order + 1;
    insert into app.template_items (template_version_id, item_kind, sort_order, name, scope_kind, scope_code_suffix)
    values (v_version, 'Scope Node', v_order, v_node.name, v_node.scope_kind,
      left(substr(v_node.scope_code, char_length(v_project.project_key) + 2), 16));
  end loop;
  for v_record in
    select r.record_kind, r.title, r.phase_code, r.xyz, r.due_at from app.records r
    where r.project_id = v_project.id and r.deleted_at is null and r.record_state not in ('Canceled', 'Complete')
    order by r.record_number
  loop
    v_order := v_order + 1;
    insert into app.template_items (template_version_id, item_kind, sort_order, name, record_kind, xyz, phase_code, due_offset_days)
    values (v_version, 'Record', v_order, v_record.title, v_record.record_kind, v_record.xyz, v_record.phase_code,
      case when coalesce(p_keep_dates, true) and v_project.starts_on is not null and v_record.due_at is not null
        then greatest(least((v_record.due_at at time zone v_project.time_zone)::date - v_project.starts_on, 3660), -3660) end);
  end loop;
  perform app.publish_template_version(v_version);
  return v_template;
end;
$$;

comment on function app.create_template_from_project(uuid, text, text, boolean) is 'Saves a project as a new template, as the caller: its defaults, its show and standing venue scope nodes and its open records (due dates kept relative to the project start, or none when p_keep_dates is false) become a published first version. Needs projects.template.write. Returns the template id.';
revoke all on function app.create_template_from_project(uuid, text, text, boolean) from public, anon;
grant execute on function app.create_template_from_project(uuid, text, text, boolean) to authenticated, service_role;
