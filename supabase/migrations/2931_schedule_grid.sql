-- 2931_schedule_grid.sql
-- B4 Scheduling depth (RRR-228; parity gap G-41; ADR 0143 decision 3; ADR 0022 block 2930 to 2939). The schedule grid:
-- a day's records, or a running order's cues, typed into rows like a spreadsheet and saved in one transaction.
--
--   * app.my_schedule_capabilities_on_project(project) names which of the scheduling capabilities B4 reads the
--     signed-in person holds on a project, as app.operations_project_capabilities (0441) does for logistics. The grid
--     and day template RPCs are security invoker, so row level security and every guard decide what they write, and
--     an invoker cannot read the private schema: they ask this function for the 42501 checks their callers expect.
--     It shapes which controls the apps show; it decides no write.
--   * app.save_day_grid(project, day, rows, commit) creates and edits a day's records. A new row is inserted as quick
--     add inserts one (apps/atlas/lib/quick-add/actions.ts): XYZ Z for a kind of the Time class and Y otherwise, basis
--     Declared, the project's zone, under the project's Engagement Root node (NULL when it has none). An edited row is
--     compared and set by the values the grid loaded ({id, expect, ...}, bulk_stale as 1451). Each row runs in its own
--     subtransaction, so title grammar, records_window, a locked baseline window (reschedule_locked, as 2852) and every
--     other guard come back on their row. A date change on a record past Ready writes the replan reason "Changed in
--     the day grid." unless one is given (1451's rule).
--   * app.save_cue_grid(run, rows, commit) edits a running order: rows list every live cue once, in running order, plus
--     new rows (grid_incomplete otherwise). The grid never deletes a cue. A called cue keeps its fields (cue_called),
--     and every cue at or before the last called position keeps its place (cue_move_before_called), as P2's
--     app.move_cue (2793). Positions are renumbered densely by parking rows past the end first.
--   * Both follow private.run_bulk (1451): all or nothing, and a preview runs the same statements and undoes them
--     (SQLSTATE XB001 in an outer block), so the preview equals the commit by construction. At most 200 rows
--     (grid_too_large).

-- 1. The caller's scheduling capabilities on a project ------------------------------------------------------------------

create or replace function app.my_schedule_capabilities_on_project(p_project_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(c.code order by c.code), '{}')
  from (values
    ('schedule.timeline.read'), ('schedule.timeline.write'), ('show.run_of_show.read'), ('show.run_of_show.write'),
    ('show.day_sheet.write'), ('show.call_sheet.publish'), ('projects.project.write'), ('projects.template.write'),
    ('crew.shift.read'), ('logistics.shipment.read'), ('hospitality.fulfillment.read')
  ) as c (code)
  where p_project_id is not null and private.can_on_project(p_project_id, c.code);
$$;

comment on function app.my_schedule_capabilities_on_project(uuid) is 'Which scheduling capabilities (timeline, run of show, day and call sheets, project and template writes, shift, shipment and fulfillment reads) the signed-in person may use on a project, by the invariant 2 rule the policies apply. The invoker RPCs of B4 (2931, 2933, 2935) raise 42501 from it, and the apps show controls by it; row level security still decides every write.';
revoke all on function app.my_schedule_capabilities_on_project(uuid) from public, anon;
grant execute on function app.my_schedule_capabilities_on_project(uuid) to authenticated, service_role;

-- 2. The day grid ------------------------------------------------------------------------------------------------------------

create or replace function app.save_day_grid(p_project_id uuid, p_day date, p_rows jsonb, p_commit boolean default false)
returns table (row_index integer, record_id uuid, action text, refusal_code text, refusal_message text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_project app.projects;
  v_root uuid;
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_index integer;
  v_old app.records;
  v_id uuid;
  v_kind text;
  v_xyz text;
  v_key text;
  v_starts timestamptz;
  v_ends timestamptz;
  v_due timestamptz;
  v_dates_changed boolean;
  v_count integer;
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
  if v_project.id is null or p_day is null
     or not ('schedule.timeline.write' = any (app.my_schedule_capabilities_on_project(p_project_id))) then
    raise exception using errcode = '42501', message = 'schedule.timeline.write is required on the project';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception using errcode = 'XR001', hint = 'grid_empty', message = 'grid_empty: Type at least one row before saving.';
  end if;
  if jsonb_array_length(p_rows) > 200 then
    raise exception using errcode = 'XR001', hint = 'grid_too_large', message = 'grid_too_large: A grid saves at most 200 rows at a time.';
  end if;
  select n.id into v_root from app.scope_nodes n
  where n.project_id = p_project_id and n.scope_kind = 'Engagement Root' and n.deleted_at is null;

  begin
    for v_item, v_index in select e, o::integer from jsonb_array_elements(p_rows) with ordinality as x (e, o) loop
      v_id := null;
      begin
        if jsonb_typeof(v_item) is distinct from 'object' then
          raise exception using errcode = '22023', message = 'each row is an object';
        end if;
        if v_item ? 'id' and nullif(v_item ->> 'id', '') is not null then
          -- An edited row: read as the caller, so a row they cannot see is not found.
          v_id := (v_item ->> 'id')::uuid;
          select * into v_old from app.records r
          where r.id = v_id and r.project_id = p_project_id and r.deleted_at is null for update;
          if v_old.id is null then
            raise exception using errcode = 'XR001', hint = 'bulk_row_not_found',
              message = 'bulk_row_not_found: This row no longer exists or is not available to you.';
          end if;
          -- Compare and set: each value the grid loaded must still hold (1451's bulk_stale).
          for v_key in select k from jsonb_object_keys(coalesce(v_item -> 'expect', '{}'::jsonb)) k loop
            if v_key not in ('title', 'starts_at', 'ends_at', 'due_at', 'start_tbc', 'owner_party_id', 'updated_at') then
              raise exception using errcode = '22023', message = format('%s is not a field the day grid compares', v_key);
            end if;
            if (case v_key
                 when 'title' then v_old.title is distinct from (v_item -> 'expect' ->> v_key)
                 when 'starts_at' then v_old.starts_at is distinct from (v_item -> 'expect' ->> v_key)::timestamptz
                 when 'ends_at' then v_old.ends_at is distinct from (v_item -> 'expect' ->> v_key)::timestamptz
                 when 'due_at' then v_old.due_at is distinct from (v_item -> 'expect' ->> v_key)::timestamptz
                 when 'start_tbc' then v_old.start_tbc is distinct from (v_item -> 'expect' ->> v_key)::boolean
                 when 'owner_party_id' then v_old.owner_party_id is distinct from (v_item -> 'expect' ->> v_key)::uuid
                 else v_old.updated_at is distinct from (v_item -> 'expect' ->> v_key)::timestamptz
               end) then
              raise exception using errcode = 'XR001', hint = 'bulk_stale',
                message = 'bulk_stale: Someone changed this row after you loaded it; reload to see the change.';
            end if;
          end loop;
          if v_item ? 'record_kind' and v_item ->> 'record_kind' is distinct from v_old.record_kind then
            raise exception using errcode = 'XR001', hint = 'record_kind_immutable',
              message = 'record_kind_immutable: A record keeps its kind; create a record of the other kind instead.';
          end if;
          v_starts := case when v_item ? 'starts_at' then (v_item ->> 'starts_at')::timestamptz else v_old.starts_at end;
          v_ends := case when v_item ? 'ends_at' then (v_item ->> 'ends_at')::timestamptz else v_old.ends_at end;
          v_due := case when v_item ? 'due_at' then (v_item ->> 'due_at')::timestamptz else v_old.due_at end;
          v_dates_changed := v_starts is distinct from v_old.starts_at or v_ends is distinct from v_old.ends_at
            or v_due is distinct from v_old.due_at;
          -- A Timeline window locked into a baseline keeps its start and end (2852's rule).
          if (v_starts is distinct from v_old.starts_at or v_ends is distinct from v_old.ends_at)
             and exists (select 1 from app.record_timeline t where t.record_id = v_old.id and t.baseline_locked_at is not null) then
            raise exception using errcode = 'XR001', hint = 'reschedule_locked',
              message = 'reschedule_locked: ' || app.record_display_key(v_old) || ' ' || v_old.title
                || ' is locked: it is complete or its window is locked into a baseline.';
          end if;
          if v_dates_changed
             or (v_item ? 'title' and (v_item ->> 'title') is distinct from v_old.title)
             or (v_item ? 'start_tbc' and coalesce((v_item ->> 'start_tbc')::boolean, false) is distinct from v_old.start_tbc)
             or (v_item ? 'owner_party_id' and nullif(v_item ->> 'owner_party_id', '')::uuid is distinct from v_old.owner_party_id) then
            update app.records r set
              title = case when v_item ? 'title' then btrim(v_item ->> 'title') else r.title end,
              starts_at = v_starts,
              ends_at = v_ends,
              due_at = v_due,
              start_tbc = case when v_item ? 'start_tbc' then coalesce((v_item ->> 'start_tbc')::boolean, false) else r.start_tbc end,
              owner_party_id = case when v_item ? 'owner_party_id' then nullif(v_item ->> 'owner_party_id', '')::uuid else r.owner_party_id end,
              replan_reason = case when v_dates_changed and v_old.record_state not in ('Proposed', 'Ready')
                then coalesce(nullif(btrim(v_item ->> 'replan_reason'), ''), 'Changed in the day grid.') else r.replan_reason end
            where r.id = v_old.id;
            get diagnostics v_count = row_count;
            if v_count = 0 then
              raise exception using errcode = '42501', message = 'work.record.write is required on this record';
            end if;
            v_out := v_out || jsonb_build_array(jsonb_build_object('i', v_index, 'id', v_id, 'action', 'update'));
          else
            v_out := v_out || jsonb_build_array(jsonb_build_object('i', v_index, 'id', v_id, 'action', 'unchanged'));
          end if;
        else
          -- A new row: as quick add creates a record.
          v_kind := v_item ->> 'record_kind';
          select case when k.record_class = 'Time' then 'Z' else 'Y' end into v_xyz
          from xpms.dim_record_kind k where k.record_kind = v_kind;
          if v_xyz is null then
            raise exception using errcode = 'XR001', hint = 'grid_kind',
              message = 'grid_kind: Choose a record kind for the new row.';
          end if;
          insert into app.records (project_id, scope_node_id, record_kind, title, xyz, xyz_basis, starts_at, ends_at, due_at,
            start_tbc, owner_party_id, time_zone)
          values (p_project_id, v_root, v_kind, btrim(coalesce(v_item ->> 'title', '')), v_xyz::xpms.xyz_tag, 'Declared',
            (v_item ->> 'starts_at')::timestamptz, (v_item ->> 'ends_at')::timestamptz, (v_item ->> 'due_at')::timestamptz,
            coalesce((v_item ->> 'start_tbc')::boolean, false), nullif(v_item ->> 'owner_party_id', '')::uuid,
            v_project.time_zone)
          returning id into v_id;
          v_out := v_out || jsonb_build_array(jsonb_build_object('i', v_index, 'id', v_id, 'action', 'create'));
        end if;
      exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_hint = pg_exception_hint;
        v_rule := case
          when v_state = 'XR001' then coalesce(nullif(v_hint, ''), nullif(split_part(v_message, ': ', 1), ''), 'refused')
          when v_state = '42501' then 'not_allowed'
          when v_state in ('23514', '23502', '22023', '22P02', '22007', '22008', '22003', '22001') then 'invalid'
          when v_state = '23503' then 'invalid_reference'
          when v_state = '23505' then 'conflict'
          else 'refused' end;
        if v_state = 'XR001' and position(v_rule || ': ' in v_message) = 1 then
          v_message := substr(v_message, char_length(v_rule) + 3);
        end if;
        v_refused := true;
        v_out := v_out || jsonb_build_array(jsonb_build_object('i', v_index, 'id', v_id, 'action', 'refused',
          'code', v_rule, 'message', v_message));
      end;
    end loop;
    if not coalesce(p_commit, false) or v_refused then
      raise exception using errcode = 'XB001', message = 'grid save undone';
    end if;
  exception when sqlstate 'XB001' then
    -- Every write of this block is undone: a preview, or a save with a refused row.
    null;
  end;

  return query
  select (o ->> 'i')::integer, (o ->> 'id')::uuid, o ->> 'action', o ->> 'code', o ->> 'message'
  from jsonb_array_elements(v_out) o
  order by (o ->> 'i')::integer;
end;
$$;

comment on function app.save_day_grid(uuid, date, jsonb, boolean) is 'Saves the day grid of a project (G-41, ADR 0143 decision 3) as the caller: up to 200 rows [{id?, expect?, title, record_kind (new rows), starts_at, ends_at, due_at, start_tbc, owner_party_id, replan_reason?}]. A row without id creates a record as quick add does (XYZ Z for a Time kind, else Y, basis Declared, the project''s zone, under its Engagement Root node); a row with id updates the fields it names after compare and set on its expect values (bulk_stale). Each row runs in its own subtransaction, so the title grammar, records_window, a baseline-locked window (reschedule_locked) and every guard refuse on their row. All or nothing: with any refused row, or p_commit false, every write is undone, so a preview returns exactly what a commit writes. Needs schedule.timeline.write on the project (42501). Returns one row per input row with the record, action (create, update, unchanged, refused) and refusal.';
revoke all on function app.save_day_grid(uuid, date, jsonb, boolean) from public, anon;
grant execute on function app.save_day_grid(uuid, date, jsonb, boolean) to authenticated, service_role;

-- 3. The cue grid ------------------------------------------------------------------------------------------------------------

create or replace function app.save_cue_grid(p_run_of_show_id uuid, p_rows jsonb, p_commit boolean default false)
returns table (row_index integer, record_id uuid, action text, refusal_code text, refusal_message text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_run app.run_of_show;
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_index integer;
  v_old app.cues;
  v_id uuid;
  v_key text;
  v_live uuid[];
  v_ids uuid[] := '{}';
  v_last_called integer;
  v_ordinal integer;
  v_minutes numeric;
  v_duration interval;
  v_changed boolean;
  v_count integer;
  v_refused boolean := false;
  v_state text;
  v_message text;
  v_hint text;
  v_rule text;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  select * into v_run from app.run_of_show r where r.id = p_run_of_show_id and r.deleted_at is null;
  if v_run.id is null
     or not ('show.run_of_show.write' = any (app.my_schedule_capabilities_on_project(v_run.project_id))) then
    raise exception using errcode = '42501', message = 'show.run_of_show.write is required on the running order';
  end if;
  -- Saves of one running order serialize, as app.move_cue's do.
  perform 1 from app.run_of_show r where r.id = v_run.id for update;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception using errcode = 'XR001', hint = 'grid_empty', message = 'grid_empty: Type at least one row before saving.';
  end if;
  if jsonb_array_length(p_rows) > 200 then
    raise exception using errcode = 'XR001', hint = 'grid_too_large', message = 'grid_too_large: A grid saves at most 200 rows at a time.';
  end if;

  -- The live cues in running order, and the place of the last called one.
  select coalesce(array_agg(c.id order by c.position), '{}'),
    coalesce(max(o.ordinal) filter (where c.called_at is not null), 0)
  into v_live, v_last_called
  from app.cues c
  join (select c2.id, row_number() over (order by c2.position) as ordinal
        from app.cues c2 where c2.run_of_show_id = v_run.id and c2.deleted_at is null) o on o.id = c.id
  where c.run_of_show_id = v_run.id and c.deleted_at is null;

  -- Every live cue appears exactly once; the grid never deletes a cue.
  if (select count(*) from jsonb_array_elements(p_rows) e where nullif(e ->> 'id', '') is not null)
       <> (select count(distinct e ->> 'id') from jsonb_array_elements(p_rows) e where nullif(e ->> 'id', '') is not null)
     or exists (select 1 from unnest(v_live) l
                where not exists (select 1 from jsonb_array_elements(p_rows) e where e ->> 'id' = l::text))
     or exists (select 1 from jsonb_array_elements(p_rows) e
                where nullif(e ->> 'id', '') is not null and not ((e ->> 'id')::uuid = any (v_live))) then
    raise exception using errcode = 'XR001', hint = 'grid_incomplete',
      message = 'grid_incomplete: Reload the running order: the grid lists every cue once, and someone added or removed a cue.';
  end if;

  begin
    for v_item, v_index in select e, o::integer from jsonb_array_elements(p_rows) with ordinality as x (e, o) loop
      v_id := null;
      begin
        if v_item ? 'duration_minutes' and v_item -> 'duration_minutes' <> 'null'::jsonb then
          v_minutes := (v_item ->> 'duration_minutes')::numeric;
          if v_minutes < 0 or v_minutes > 1440 or v_minutes <> trunc(v_minutes) then
            raise exception using errcode = '22023', message = 'duration_minutes is whole minutes, 0 to 1440';
          end if;
          v_duration := pg_catalog.make_interval(mins => v_minutes::integer);
        else
          v_duration := null;
        end if;
        if nullif(v_item ->> 'id', '') is not null then
          v_id := (v_item ->> 'id')::uuid;
          select * into v_old from app.cues c where c.id = v_id and c.deleted_at is null;
          v_ordinal := array_position(v_live, v_id);
          for v_key in select k from jsonb_object_keys(coalesce(v_item -> 'expect', '{}'::jsonb)) k loop
            if v_key not in ('label', 'planned_at', 'duration_minutes', 'segment', 'start_tbc', 'updated_at') then
              raise exception using errcode = '22023', message = format('%s is not a field the cue grid compares', v_key);
            end if;
            if (case v_key
                 when 'label' then v_old.label is distinct from (v_item -> 'expect' ->> v_key)
                 when 'planned_at' then v_old.planned_at is distinct from (v_item -> 'expect' ->> v_key)::timestamptz
                 when 'duration_minutes' then (extract(epoch from v_old.duration) / 60) is distinct from (v_item -> 'expect' ->> v_key)::numeric
                 when 'segment' then v_old.segment is distinct from (v_item -> 'expect' ->> v_key)
                 when 'start_tbc' then v_old.start_tbc is distinct from (v_item -> 'expect' ->> v_key)::boolean
                 else v_old.updated_at is distinct from (v_item -> 'expect' ->> v_key)::timestamptz
               end) then
              raise exception using errcode = 'XR001', hint = 'bulk_stale',
                message = 'bulk_stale: Someone changed this row after you loaded it; reload to see the change.';
            end if;
          end loop;
          v_changed := (v_item ? 'label' and btrim(v_item ->> 'label') is distinct from v_old.label)
            or (v_item ? 'planned_at' and (v_item ->> 'planned_at')::timestamptz is distinct from v_old.planned_at)
            or (v_item ? 'duration_minutes' and v_duration is distinct from v_old.duration)
            or (v_item ? 'segment' and nullif(btrim(v_item ->> 'segment'), '') is distinct from v_old.segment)
            or (v_item ? 'start_tbc' and coalesce((v_item ->> 'start_tbc')::boolean, false) is distinct from v_old.start_tbc);
          if v_old.called_at is not null and (v_changed or v_ordinal <> v_index) then
            raise exception using errcode = 'XR001', hint = 'cue_called',
              message = 'cue_called: This cue has been called; it keeps its place and its fields.';
          end if;
          if v_ordinal <> v_index and (v_ordinal <= v_last_called or v_index <= v_last_called) then
            raise exception using errcode = 'XR001', hint = 'cue_move_before_called',
              message = 'cue_move_before_called: Cues move only after the last called cue.';
          end if;
          if v_changed then
            update app.cues c set
              label = case when v_item ? 'label' then btrim(v_item ->> 'label') else c.label end,
              planned_at = case when v_item ? 'planned_at' then (v_item ->> 'planned_at')::timestamptz else c.planned_at end,
              duration = case when v_item ? 'duration_minutes' then v_duration else c.duration end,
              segment = case when v_item ? 'segment' then nullif(btrim(v_item ->> 'segment'), '') else c.segment end,
              start_tbc = case when v_item ? 'start_tbc' then coalesce((v_item ->> 'start_tbc')::boolean, false) else c.start_tbc end
            where c.id = v_id;
            get diagnostics v_count = row_count;
            if v_count = 0 then
              raise exception using errcode = '42501', message = 'show.run_of_show.write is required on the running order';
            end if;
          end if;
          v_out := v_out || jsonb_build_array(jsonb_build_object('i', v_index, 'id', v_id,
            'action', case when v_changed then 'update' when v_ordinal <> v_index then 'move' else 'unchanged' end));
        else
          if v_index <= v_last_called then
            raise exception using errcode = 'XR001', hint = 'cue_move_before_called',
              message = 'cue_move_before_called: Cues move only after the last called cue.';
          end if;
          -- Parked past the end; the renumbering below gives it its place.
          insert into app.cues (run_of_show_id, position, label, planned_at, duration, segment, start_tbc)
          values (v_run.id, 2000000 + v_index, btrim(coalesce(v_item ->> 'label', '')), (v_item ->> 'planned_at')::timestamptz,
            v_duration, nullif(btrim(v_item ->> 'segment'), ''), coalesce((v_item ->> 'start_tbc')::boolean, false))
          returning id into v_id;
          v_out := v_out || jsonb_build_array(jsonb_build_object('i', v_index, 'id', v_id, 'action', 'create'));
        end if;
        v_ids := v_ids || v_id;
      exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_hint = pg_exception_hint;
        v_rule := case
          when v_state = 'XR001' then coalesce(nullif(v_hint, ''), nullif(split_part(v_message, ': ', 1), ''), 'refused')
          when v_state = '42501' then 'not_allowed'
          when v_state in ('23514', '23502', '22023', '22P02', '22007', '22008', '22003', '22001') then 'invalid'
          when v_state = '23503' then 'invalid_reference'
          when v_state = '23505' then 'conflict'
          else 'refused' end;
        if v_state = 'XR001' and position(v_rule || ': ' in v_message) = 1 then
          v_message := substr(v_message, char_length(v_rule) + 3);
        end if;
        v_refused := true;
        v_out := v_out || jsonb_build_array(jsonb_build_object('i', v_index, 'id', v_id, 'action', 'refused',
          'code', v_rule, 'message', v_message));
      end;
    end loop;

    if not v_refused then
      -- Dense positions in the grid's order: the rows that change place are parked past the end first, so
      -- cues_position_positive and cues_position_key hold at every row step (2793).
      update app.cues c set position = c.position + 1000000
      from unnest(v_ids) with ordinality as w (id, ordinal)
      where c.id = w.id and c.position <> w.ordinal and c.position < 1000000;
      update app.cues c set position = w.ordinal::integer
      from unnest(v_ids) with ordinality as w (id, ordinal)
      where c.id = w.id and c.position <> w.ordinal;
    end if;
    if not coalesce(p_commit, false) or v_refused then
      raise exception using errcode = 'XB001', message = 'grid save undone';
    end if;
  exception when sqlstate 'XB001' then
    null;
  end;

  return query
  select (o ->> 'i')::integer, (o ->> 'id')::uuid, o ->> 'action', o ->> 'code', o ->> 'message'
  from jsonb_array_elements(v_out) o
  order by (o ->> 'i')::integer;
end;
$$;

comment on function app.save_cue_grid(uuid, jsonb, boolean) is 'Saves the cue grid of a running order (G-41, ADR 0143 decision 3) as the caller: up to 200 rows in running order, [{id?, expect?, label, planned_at, duration_minutes (0 to 1440), segment, start_tbc}], listing every live cue exactly once plus new rows (grid_incomplete otherwise); the grid never deletes a cue. A called cue keeps its fields and place (cue_called), and nothing moves to or before the last called cue (cue_move_before_called), as app.move_cue. Edited rows are compared and set on their expect values (bulk_stale). Positions are renumbered densely by parking moved rows past the end. All or nothing: with any refused row, or p_commit false, every write is undone, so a preview returns exactly what a commit writes. Needs show.run_of_show.write on the project (42501). Returns one row per input row with the cue (record_id), action (create, update, move, unchanged, refused) and refusal.';
revoke all on function app.save_cue_grid(uuid, jsonb, boolean) from public, anon;
grant execute on function app.save_cue_grid(uuid, jsonb, boolean) to authenticated, service_role;
