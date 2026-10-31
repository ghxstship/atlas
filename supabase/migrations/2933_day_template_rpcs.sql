-- 2933_day_template_rpcs.sql
-- B4 Scheduling depth (RRR-228; parity gap G-42; ADR 0143 decisions 2 and 3; ADR 0022 block 2930 to 2939). Laying a
-- day template onto a day, and saving a day as one. Both run as the caller (security invoker), so row level security
-- and every guard of records and cues decide exactly as for rows typed by hand, as app.apply_template does (2851).
--
--   * app.apply_day_template(template, project, day, ...) is the dry run and the commit in one function. Each item's
--     time is its minute on the project's wall clock: (day + start_minute) at time zone project.time_zone. Record items
--     are created under the given Show node or the project's Engagement Root node; Cue items are appended, in
--     start-minute order, after the last position of the day's running order. With no running order named, the day's
--     one live running order is used; two or more refuse day_template_run_ambiguous while cue items would be created
--     (two stages are two running orders), and none skips the cue items (skip_no_running_order). An item already on
--     the day (a live record of the same kind and title starting or due that day, or a cue with the same label in the
--     run) is skipped unless duplicates are included. overlaps counts the day's live records or the run's cues whose
--     windows meet the item's. As in 2931, every write runs and a preview undoes it (SQLSTATE XB001), so the preview
--     equals the commit; a commit also records one app.day_template_applications row.
--   * app.create_day_template_from_day(project, day, name, ...) saves the day's live, non-Canceled records (by their
--     local start, else due, date) and the day's running order's planned cues as a new template. A cue with no planned
--     time has no minute to keep and is left out. More than 500 items refuse day_template_too_large; an item that would
--     start outside -1440 to 2879 minutes or last longer than 1440 refuses day_template_item_window, naming it.

-- 1. Applying a day template ----------------------------------------------------------------------------------------------

create or replace function app.apply_day_template(
  p_day_template_id uuid,
  p_project_id uuid,
  p_day date,
  p_run_of_show_id uuid default null,
  p_scope_node_id uuid default null,
  p_skip_item_ids uuid[] default '{}',
  p_include_duplicates boolean default false,
  p_commit boolean default false
)
returns table (
  item_id uuid,
  item_kind text,
  name text,
  action text,
  refusal_code text,
  starts_at timestamptz,
  ends_at timestamptz,
  due_at timestamptz,
  overlaps integer,
  duplicate_of uuid,
  created_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_project app.projects;
  v_template app.day_templates;
  v_caps text[];
  v_zone text;
  v_node uuid;
  v_run uuid;
  v_runs integer;
  v_cue_items integer;
  v_position integer;
  v_item app.day_template_items;
  v_start timestamptz;
  v_end timestamptz;
  v_due timestamptz;
  v_window tstzrange;
  v_dup uuid;
  v_overlaps integer;
  v_created uuid;
  v_xyz xpms.xyz_tag;
  v_out jsonb := '[]'::jsonb;
  v_records integer := 0;
  v_cues integer := 0;
  v_skipped integer := 0;
  v_refused boolean := false;
  v_state text;
  v_message text;
  v_hint text;
  v_rule text;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  v_caps := app.my_schedule_capabilities_on_project(p_project_id);
  if v_project.id is null or p_day is null or not ('schedule.timeline.write' = any (v_caps)) then
    raise exception using errcode = '42501', message = 'schedule.timeline.write is required on the project';
  end if;
  select * into v_template from app.day_templates t
  where t.id = p_day_template_id and t.deleted_at is null and t.org_id = v_project.org_id;
  if v_template.id is null then
    raise exception using errcode = 'XR001', hint = 'day_template_unknown',
      message = 'day_template_unknown: Choose a day template of this organization.';
  end if;
  v_zone := v_project.time_zone;
  v_node := coalesce(p_scope_node_id, (select n.id from app.scope_nodes n
    where n.project_id = p_project_id and n.scope_kind = 'Engagement Root' and n.deleted_at is null));

  -- The running order the cue items join.
  select count(*) into v_cue_items from app.day_template_items i
  where i.day_template_id = v_template.id and i.deleted_at is null and i.item_kind = 'Cue'
    and not (i.id = any (coalesce(p_skip_item_ids, '{}')));
  if p_run_of_show_id is not null then
    select r.id into v_run from app.run_of_show r
    where r.id = p_run_of_show_id and r.project_id = p_project_id and r.deleted_at is null;
    if v_run is null then
      raise exception using errcode = 'XR001', hint = 'day_template_run_unknown',
        message = 'day_template_run_unknown: Choose a running order of this project.';
    end if;
  else
    select count(*), min(r.id::text)::uuid into v_runs, v_run from app.run_of_show r
    where r.project_id = p_project_id and r.show_date = p_day and r.deleted_at is null;
    if v_runs > 1 and v_cue_items > 0 then
      raise exception using errcode = 'XR001', hint = 'day_template_run_ambiguous',
        message = 'day_template_run_ambiguous: This day has more than one running order; choose the one the cues join.';
    end if;
  end if;
  if v_run is not null and v_cue_items > 0 and not ('show.run_of_show.write' = any (v_caps)) then
    raise exception using errcode = '42501', message = 'show.run_of_show.write is required to add cues to the running order';
  end if;
  if v_run is not null then
    -- Applications to one running order serialize, as its cue moves do.
    perform 1 from app.run_of_show r where r.id = v_run for update;
    select coalesce(max(c.position), 0) into v_position from app.cues c where c.run_of_show_id = v_run and c.deleted_at is null;
  end if;

  begin
    for v_item in
      select * from app.day_template_items i
      where i.day_template_id = v_template.id and i.deleted_at is null
      order by i.start_minute, i.sort_order, i.id
    loop
      v_start := (p_day::timestamp + pg_catalog.make_interval(mins => v_item.start_minute)) at time zone v_zone;
      v_end := case when v_item.duration_minutes is not null
        then (p_day::timestamp + pg_catalog.make_interval(mins => v_item.start_minute + v_item.duration_minutes)) at time zone v_zone end;
      v_due := null;
      if v_item.item_kind = 'Record' and v_item.duration_minutes is null then
        v_due := v_start;
        v_start := null;
      end if;
      v_window := tstzrange(coalesce(v_start, v_due), coalesce(v_end, v_start, v_due), '[]');
      v_dup := null;
      v_created := null;
      v_rule := null;

      if v_item.item_kind = 'Record' then
        select r.id into v_dup from app.records r
        where r.project_id = p_project_id and r.deleted_at is null and r.record_state <> 'Canceled'
          and r.record_kind = v_item.record_kind and lower(r.title) = lower(v_item.name)
          and (coalesce(r.starts_at, r.due_at) at time zone v_zone)::date = p_day
        order by r.record_number limit 1;
        select count(*)::integer into v_overlaps from app.records r
        where r.project_id = p_project_id and r.deleted_at is null and r.record_state <> 'Canceled'
          and coalesce(r.starts_at, r.due_at) is not null
          and (coalesce(r.starts_at, r.due_at) at time zone v_zone)::date = p_day
          and tstzrange(coalesce(r.starts_at, r.due_at), coalesce(r.ends_at, r.due_at, r.starts_at), '[]') && v_window;
      else
        v_overlaps := 0;
        if v_run is not null then
          select c.id into v_dup from app.cues c
          where c.run_of_show_id = v_run and c.deleted_at is null and lower(c.label) = lower(v_item.name)
          order by c.position limit 1;
          select count(*)::integer into v_overlaps from app.cues c
          where c.run_of_show_id = v_run and c.deleted_at is null and c.planned_at is not null
            and tstzrange(c.planned_at, c.planned_at + coalesce(c.duration, interval '0'), '[]') && v_window;
        end if;
      end if;

      if v_item.id = any (coalesce(p_skip_item_ids, '{}')) then
        v_out := v_out || jsonb_build_array(jsonb_build_object('item', v_item.id, 'action', 'skip_chosen',
          'starts', v_start, 'ends', v_end, 'due', v_due, 'overlaps', v_overlaps, 'dup', v_dup));
        v_skipped := v_skipped + 1;
      elsif v_item.item_kind = 'Cue' and v_run is null then
        v_out := v_out || jsonb_build_array(jsonb_build_object('item', v_item.id, 'action', 'skip_no_running_order',
          'starts', v_start, 'ends', v_end, 'due', v_due, 'overlaps', v_overlaps, 'dup', v_dup));
        v_skipped := v_skipped + 1;
      elsif v_dup is not null and not coalesce(p_include_duplicates, false) then
        v_out := v_out || jsonb_build_array(jsonb_build_object('item', v_item.id, 'action', 'skip_duplicate',
          'starts', v_start, 'ends', v_end, 'due', v_due, 'overlaps', v_overlaps, 'dup', v_dup));
        v_skipped := v_skipped + 1;
      else
        begin
          if v_item.item_kind = 'Record' then
            insert into app.records (project_id, scope_node_id, record_kind, title, phase_code, xyz, xyz_basis,
              starts_at, ends_at, due_at, start_tbc, time_zone)
            values (p_project_id, v_node, v_item.record_kind, v_item.name, v_item.phase_code, v_item.xyz, 'Declared',
              v_start, v_end, v_due, v_item.start_tbc, v_zone)
            returning id into v_created;
            v_records := v_records + 1;
          else
            v_position := v_position + 1;
            insert into app.cues (run_of_show_id, position, label, planned_at, duration, segment, start_tbc)
            values (v_run, v_position, v_item.name, v_start,
              case when v_item.duration_minutes is not null then pg_catalog.make_interval(mins => v_item.duration_minutes) end,
              v_item.segment, v_item.start_tbc)
            returning id into v_created;
            v_cues := v_cues + 1;
          end if;
          v_out := v_out || jsonb_build_array(jsonb_build_object('item', v_item.id, 'action', 'create',
            'starts', v_start, 'ends', v_end, 'due', v_due, 'overlaps', v_overlaps, 'dup', v_dup, 'created', v_created));
        exception when others then
          get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_hint = pg_exception_hint;
          v_rule := case
            when v_state = 'XR001' then coalesce(nullif(v_hint, ''), nullif(split_part(v_message, ': ', 1), ''), 'refused')
            when v_state = '42501' then 'not_allowed'
            when v_state in ('23514', '23502', '22023', '22P02', '22007', '22008', '22003', '22001') then 'invalid'
            when v_state = '23503' then 'invalid_reference'
            when v_state = '23505' then 'conflict'
            else 'refused' end;
          v_refused := true;
          v_out := v_out || jsonb_build_array(jsonb_build_object('item', v_item.id, 'action', 'refused', 'code', v_rule,
            'starts', v_start, 'ends', v_end, 'due', v_due, 'overlaps', v_overlaps, 'dup', v_dup));
        end;
      end if;
    end loop;

    if coalesce(p_commit, false) and not v_refused then
      insert into app.day_template_applications (day_template_id, project_id, day_on, run_of_show_id, records_created,
        cues_created, items_skipped)
      values (v_template.id, p_project_id, p_day, case when v_cues > 0 then v_run end, v_records, v_cues, v_skipped);
    else
      raise exception using errcode = 'XB001', message = 'day template application undone';
    end if;
  exception when sqlstate 'XB001' then
    -- A preview, or an application with a refused item: every write of this block is undone.
    null;
  end;

  return query
  select i.id, i.item_kind::text, i.name, o ->> 'action', o ->> 'code', (o ->> 'starts')::timestamptz,
    (o ->> 'ends')::timestamptz, (o ->> 'due')::timestamptz, (o ->> 'overlaps')::integer, (o ->> 'dup')::uuid,
    case when coalesce(p_commit, false) and not v_refused then (o ->> 'created')::uuid end
  from jsonb_array_elements(v_out) with ordinality as x (o, ordinal)
  join app.day_template_items i on i.id = (o ->> 'item')::uuid
  order by x.ordinal;
end;
$$;

comment on function app.apply_day_template(uuid, uuid, date, uuid, uuid, uuid[], boolean, boolean) is 'Lays a day template onto a project day (G-42, ADR 0143 decision 3) as the caller: each item at its minute on the project''s wall clock, Record items under the given Show node or the Engagement Root node, Cue items appended in start order to the named running order or the day''s only one (day_template_run_ambiguous with several, skip_no_running_order with none). Items in p_skip_item_ids are skip_chosen; an item already on the day is skip_duplicate (with duplicate_of) unless p_include_duplicates; overlaps counts the day''s records or the run''s cues whose windows meet it. A refused item is reported with its rule. All or nothing: a preview (p_commit false) or an application with a refused item undoes every write, so the preview equals the commit; a commit records one app.day_template_applications row and returns the created ids. Needs schedule.timeline.write, and show.run_of_show.write when cues are created (42501).';
revoke all on function app.apply_day_template(uuid, uuid, date, uuid, uuid, uuid[], boolean, boolean) from public, anon;
grant execute on function app.apply_day_template(uuid, uuid, date, uuid, uuid, uuid[], boolean, boolean) to authenticated, service_role;

-- 2. Saving a day as a template ---------------------------------------------------------------------------------------------

create or replace function app.create_day_template_from_day(
  p_project_id uuid,
  p_day date,
  p_name text,
  p_description text default null,
  p_run_of_show_id uuid default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_project app.projects;
  v_zone text;
  v_run uuid;
  v_runs integer;
  v_template uuid;
  v_order integer := 0;
  v_count integer;
  v_draft jsonb;
  v_label text;
  v_row record;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null or p_day is null then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  v_zone := v_project.time_zone;
  if p_run_of_show_id is not null then
    select r.id into v_run from app.run_of_show r
    where r.id = p_run_of_show_id and r.project_id = p_project_id and r.deleted_at is null;
    if v_run is null then
      raise exception using errcode = 'XR001', hint = 'day_template_run_unknown',
        message = 'day_template_run_unknown: Choose a running order of this project.';
    end if;
  else
    select count(*), min(r.id::text)::uuid into v_runs, v_run from app.run_of_show r
    where r.project_id = p_project_id and r.show_date = p_day and r.deleted_at is null;
    if v_runs > 1 then
      raise exception using errcode = 'XR001', hint = 'day_template_run_ambiguous',
        message = 'day_template_run_ambiguous: This day has more than one running order; choose the one to save.';
    end if;
  end if;

  -- The day's items, in one value: the records by their local start (else due) date, then the run's planned cues.
  select coalesce(jsonb_agg(x order by x.start_minute, x.item_kind desc, x.name), '[]'::jsonb) into v_draft
  from (
    select 'Record' as item_kind, r.title as name, r.record_kind, r.xyz::text as xyz, r.phase_code,
      (extract(epoch from ((coalesce(r.starts_at, r.due_at) at time zone v_zone) - p_day::timestamp)) / 60)::integer as start_minute,
      case when r.starts_at is null then null
        else (extract(epoch from ((coalesce(r.ends_at, r.starts_at) at time zone v_zone) - (r.starts_at at time zone v_zone))) / 60)::integer
      end as duration_minutes,
      null::text as segment, r.start_tbc, app.record_display_key(r) || ' ' || r.title as label
    from app.records r
    where r.project_id = p_project_id and r.deleted_at is null and r.record_state <> 'Canceled'
      and coalesce(r.starts_at, r.due_at) is not null
      and (coalesce(r.starts_at, r.due_at) at time zone v_zone)::date = p_day
    union all
    select 'Cue', c.label, null, null, null,
      (extract(epoch from ((c.planned_at at time zone v_zone) - p_day::timestamp)) / 60)::integer,
      case when c.duration is not null then (extract(epoch from c.duration) / 60)::integer end,
      c.segment, c.start_tbc, c.label
    from app.cues c
    where v_run is not null and c.run_of_show_id = v_run and c.deleted_at is null and c.planned_at is not null
  ) x;

  v_count := jsonb_array_length(v_draft);
  if v_count > 500 then
    raise exception using errcode = 'XR001', hint = 'day_template_too_large',
      message = 'day_template_too_large: A day template holds at most 500 items; this day has ' || v_count || '.';
  end if;
  select d.label into v_label
  from jsonb_to_recordset(v_draft) as d (label text, start_minute integer, duration_minutes integer)
  where d.start_minute not between -1440 and 2879 or d.duration_minutes not between 0 and 1440
  order by d.start_minute limit 1;
  if v_label is not null then
    raise exception using errcode = 'XR001', hint = 'day_template_item_window',
      message = 'day_template_item_window: ' || v_label
        || ' starts more than a day from this day or lasts longer than a day, so a day template cannot hold it.';
  end if;

  insert into app.day_templates (org_id, name, description, day_type)
  values (v_project.org_id, btrim(p_name), nullif(btrim(p_description), ''),
    (select d.day_type from app.project_days d where d.project_id = p_project_id and d.day_on = p_day and d.deleted_at is null
     order by d.sort_order limit 1))
  returning id into v_template;
  for v_row in
    select * from jsonb_to_recordset(v_draft) as d (item_kind text, name text, record_kind text, xyz text,
      phase_code text, start_minute integer, duration_minutes integer, segment text, start_tbc boolean)
    order by d.start_minute, d.item_kind desc, d.name
  loop
    v_order := v_order + 1;
    insert into app.day_template_items (day_template_id, item_kind, sort_order, name, record_kind, xyz, phase_code,
      start_minute, duration_minutes, segment, start_tbc)
    values (v_template, v_row.item_kind::app.day_template_item_kind, v_order, v_row.name, v_row.record_kind,
      v_row.xyz::xpms.xyz_tag, v_row.phase_code, v_row.start_minute, v_row.duration_minutes, v_row.segment, v_row.start_tbc);
  end loop;
  return v_template;
end;
$$;

comment on function app.create_day_template_from_day(uuid, date, text, text, uuid) is 'Saves a project day as a new day template (G-42) as the caller: its live, non-Canceled records whose local start (else due) date is the day, and the planned cues of the named running order or the day''s only one (day_template_run_ambiguous with several), each at its minute from local midnight with its length (none for a due-only record), segment and TBC flag; the day''s first day type becomes the template''s. Refuses over 500 items (day_template_too_large) and an item outside -1440 to 2879 minutes or longer than 1440 (day_template_item_window, naming it). Needs projects.template.write (row level security). Returns the template id.';
revoke all on function app.create_day_template_from_day(uuid, date, text, text, uuid) from public, anon;
grant execute on function app.create_day_template_from_day(uuid, date, text, text, uuid) to authenticated, service_role;
