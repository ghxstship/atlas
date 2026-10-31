-- 2793_cue_move_and_nudge.sql
-- P2 Run of show and show calling (RRR-216, ADR 0131 decision 3; gaps G-78 and G-75). Reordering and nudging a running
-- order are one transaction each, so a follower never sees a half-moved list.
--
--   * app.move_cue(cue, ordinal) moves an uncalled cue to a 1-based place among the run's live cues and renumbers the
--     run densely (1..n). A called cue keeps its place, and nothing moves to or before the last called cue. Only rows
--     whose position changes are written: they are parked past the end first, so cues_position_positive and
--     cues_position_key hold at every row step. The run is locked for update, so concurrent moves serialize.
--   * app.shift_cue_plan(run, seconds) nudges the planned time of every live, uncalled, planned cue of the run by up to
--     an hour either way. The showcaller (show.cue.call) may nudge as well as an editor (show.run_of_show.write);
--     capabilities.yaml describes show.cue.call accordingly. A later cue bump extends this function rather than adding
--     a second one.
--   * The description of show.cue.call says so. The generator rewrites 0203 for a fresh database; this update brings
--     a database where 0203 already ran to the same text.

create or replace function app.move_cue(p_cue_id uuid, p_to_position integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cue app.cues;
  v_run app.run_of_show;
  v_ids uuid[];
  v_count integer;
  v_target integer;
  v_last_called integer;
  v_changed uuid[];
begin
  perform private.require_person();
  select * into v_cue from app.cues c where c.id = p_cue_id and c.deleted_at is null;
  if v_cue.id is not null then
    select * into v_run from app.run_of_show r where r.id = v_cue.run_of_show_id and r.deleted_at is null for update;
  end if;
  if v_run.id is null or not private.can_on_project(v_run.project_id, 'show.run_of_show.write') then
    raise exception using errcode = '42501', message = 'show.run_of_show.write is required on the running order';
  end if;
  -- Read the cue again under the run's lock: another move or call may have committed meanwhile.
  select * into v_cue from app.cues c where c.id = p_cue_id and c.deleted_at is null;
  if v_cue.id is null or v_cue.run_of_show_id <> v_run.id then
    raise exception using errcode = '42501', message = 'show.run_of_show.write is required on the running order';
  end if;
  if v_cue.called_at is not null then
    perform private.refuse('cue_move_called', 'A called cue keeps its place.');
  end if;

  select array_agg(c.id order by c.position),
    coalesce(max(o.ordinal) filter (where c.called_at is not null), 0)
  into v_ids, v_last_called
  from app.cues c
  join (select c2.id, row_number() over (order by c2.position) as ordinal
        from app.cues c2 where c2.run_of_show_id = v_run.id and c2.deleted_at is null) o on o.id = c.id
  where c.run_of_show_id = v_run.id and c.deleted_at is null;
  v_count := cardinality(v_ids);
  v_target := greatest(1, least(v_count, coalesce(p_to_position, 1)));
  if v_target <= v_last_called then
    perform private.refuse('cue_move_before_called', 'Move it after the last called cue.');
  end if;

  v_ids := array_remove(v_ids, p_cue_id);
  v_ids := v_ids[1:v_target - 1] || p_cue_id || v_ids[v_target:];

  select array_agg(c.id) into v_changed
  from app.cues c
  join unnest(v_ids) with ordinality as w (id, ordinal) on w.id = c.id
  where c.position <> w.ordinal;
  update app.cues set position = position + 1000000 where id = any (v_changed);
  update app.cues c set position = w.ordinal::integer
  from unnest(v_ids) with ordinality as w (id, ordinal)
  where c.id = w.id and c.id = any (v_changed);

  return v_target;
end;
$$;

comment on function app.move_cue(uuid, integer) is 'Moves an uncalled cue to a 1-based place among its running order''s live cues (clamped to the list) and renumbers the run densely, in one transaction under a lock on the run. Needs show.run_of_show.write on the project; refuses a called cue (cue_move_called) and a place at or before the last called cue (cue_move_before_called). Writes only the cues whose position changes. Returns the cue''s new position.';

revoke all on function app.move_cue(uuid, integer) from public, anon;
grant execute on function app.move_cue(uuid, integer) to authenticated, service_role;

create or replace function app.shift_cue_plan(p_run_of_show_id uuid, p_seconds integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.run_of_show;
  v_count integer;
begin
  perform private.require_person();
  select * into v_run from app.run_of_show r where r.id = p_run_of_show_id and r.deleted_at is null for update;
  if v_run.id is null
     or not (private.can_on_project(v_run.project_id, 'show.cue.call')
             or private.can_on_project(v_run.project_id, 'show.run_of_show.write')) then
    raise exception using errcode = '42501', message = 'show.cue.call or show.run_of_show.write is required on the running order';
  end if;
  if p_seconds is null or p_seconds = 0 or p_seconds not between -3600 and 3600 then
    perform private.refuse('cue_shift_range', 'Nudge by up to an hour earlier or later.');
  end if;
  update app.cues set planned_at = planned_at + make_interval(secs => p_seconds)
  where run_of_show_id = v_run.id and deleted_at is null and called_at is null and planned_at is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.shift_cue_plan(uuid, integer) is 'Nudges the planned time of every live, uncalled, planned cue of a running order by p_seconds (between -3600 and 3600, not 0; cue_shift_range otherwise), in one transaction. Needs show.cue.call or show.run_of_show.write on the project. Returns how many cues moved.';

revoke all on function app.shift_cue_plan(uuid, integer) from public, anon;
grant execute on function app.shift_cue_plan(uuid, integer) to authenticated, service_role;

update app.capabilities
set description = 'Call cues live during a show: go, standby and nudging the remaining planned times.'
where code = 'show.cue.call';
