-- 0412_show_schedule_operations.sql
-- A08 Schedule and Show (ADR 0022 range 0410 to 0419). Operations on A03's schedule and show tables:
--   * cues.project_id, stamped from the running order, so Compass sync can filter cues by project
--   * calling a cue needs show.cue.call (app.call_cue, or a direct stamp by a holder) and emits
--     cue.called; cues and running orders join the realtime publication for live cue progression
--     (journey 15)
--   * app.lock_baseline snapshots a project's dated records into a baseline and locks it in one
--     transaction (journey 14); a locked baseline never unlocks
--   * day_sheets.published_at; publishing a day sheet or a call sheet needs show.call_sheet.publish,
--     happens once, and emits an event
--   * domain events for running orders, cue calls, baseline locks, publications and dependencies

-- Events ----------------------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('run_of_show.created', 'run_of_show', 'A running order was created for a show day.'),
  ('cue.called', 'cues', 'A cue was called during a show.'),
  ('schedule_baseline.locked', 'schedule_baselines', 'A schedule baseline was captured and locked.'),
  ('day_sheet.published', 'day_sheets', 'A day sheet was published to its recipients.'),
  ('call_sheet.published', 'call_sheets', 'A call sheet was published to crew.'),
  ('record_dependency.created', 'records', 'A schedule dependency was added to a record.')
on conflict (code) do nothing;

-- Cues carry their project ---------------------------------------------------------------------------------

alter table app.cues add column project_id uuid references app.projects (id);
update app.cues c set project_id = r.project_id from app.run_of_show r where r.id = c.run_of_show_id and c.project_id is null;
alter table app.cues alter column project_id set not null;
create index cues_project_id_idx on app.cues (project_id);
comment on column app.cues.project_id is 'Project of the running order, stamped by the database from run_of_show_id so devices can sync cues by project. Never accepted from the caller.';

create or replace function private.stamp_cue_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.project_id := (select r.project_id from app.run_of_show r where r.id = new.run_of_show_id);
  return new;
end;
$$;

comment on function private.stamp_cue_project() is 'Before insert or update trigger: a cue''s project is its running order''s project.';
revoke all on function private.stamp_cue_project() from public, anon, authenticated;

create trigger t15_stamp_cue_project before insert or update on app.cues
  for each row execute function private.stamp_cue_project();

-- Calling cues ----------------------------------------------------------------------------------------------

create or replace function private.guard_cue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.run_of_show_id <> old.run_of_show_id then
    perform private.refuse('cue_run_of_show_immutable', 'A cue stays in its running order.');
  end if;
  if new.called_at is not null and (tg_op = 'INSERT' or old.called_at is null) then
    if auth.uid() is not null
       and not private.can_on_project((select r.project_id from app.run_of_show r where r.id = new.run_of_show_id), 'show.cue.call') then
      perform private.refuse('cue_call_capability', 'Only a person who may call cues on the project calls a cue.');
    end if;
    new.called_at := now();
    new.called_by := private.current_person_id();
  elsif tg_op = 'UPDATE' and old.called_at is not null then
    new.called_at := old.called_at;
    new.called_by := old.called_by;
  end if;
  return new;
end;
$$;

comment on function private.guard_cue() is 'Cues stay in their running order; a cue is called once, by a person holding show.cue.call on the project, and stamped with the database time and that person.';

create or replace function app.call_cue(p_cue_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cue app.cues;
  v_called timestamptz;
begin
  perform private.require_person();
  select * into v_cue from app.cues c where c.id = p_cue_id and c.deleted_at is null;
  if v_cue.id is null or not private.can_on_project(v_cue.project_id, 'show.cue.call') then
    raise exception using errcode = '42501', message = 'show.cue.call is required on the running order';
  end if;
  if v_cue.called_at is not null then
    perform private.refuse('cue_already_called', 'This cue was already called; call the next cue.');
  end if;
  update app.cues set called_at = now() where id = p_cue_id returning called_at into v_called;
  return v_called;
end;
$$;

comment on function app.call_cue(uuid) is 'Calls a cue now: stamps the database time and the caller. Needs show.cue.call on the project; a cue is called once. Returns the call time.';

create trigger t90_emit_cue_called_insert after insert on app.cues
  for each row when (new.called_at is not null)
  execute function private.emit_row_event('cue.called', 'project_id', 'run_of_show_id', 'position', 'label', 'called_at');
create trigger t90_emit_cue_called after update of called_at on app.cues
  for each row when (old.called_at is null and new.called_at is not null)
  execute function private.emit_row_event('cue.called', 'project_id', 'run_of_show_id', 'position', 'label', 'called_at');
create trigger t90_emit_run_of_show_created after insert on app.run_of_show
  for each row execute function private.emit_row_event('run_of_show.created', 'project_id', 'name', 'show_date', 'scope_node_id');

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table app.cues, app.run_of_show;
  end if;
end;
$$;

-- Baselines --------------------------------------------------------------------------------------------

create or replace function private.guard_schedule_baseline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.project_id <> old.project_id then
    perform private.refuse('baseline_project_immutable', 'A baseline stays in its project.');
  end if;
  if old.locked_at is not null and (new.locked_at is distinct from old.locked_at or new.name <> old.name) then
    perform private.refuse('baseline_locked', 'A locked baseline never changes.');
  end if;
  if old.locked_at is not null and new.deleted_at is not null and old.deleted_at is null then
    perform private.refuse('baseline_locked', 'A locked baseline is retained as schedule evidence.');
  end if;
  return new;
end;
$$;

comment on function private.guard_schedule_baseline() is 'Baselines stay in their project; once locked a baseline never unlocks, is never renamed and is never deleted.';
revoke all on function private.guard_schedule_baseline() from public, anon, authenticated;

create trigger t40_guard_schedule_baseline before update on app.schedule_baselines
  for each row execute function private.guard_schedule_baseline();
create trigger t90_emit_baseline_locked after update of locked_at on app.schedule_baselines
  for each row when (old.locked_at is null and new.locked_at is not null)
  execute function private.emit_row_event('schedule_baseline.locked', 'project_id', 'name', 'locked_at');

create or replace function app.lock_baseline(p_baseline_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_baseline app.schedule_baselines;
  v_count integer;
begin
  perform private.require_person();
  select * into v_baseline from app.schedule_baselines b where b.id = p_baseline_id and b.deleted_at is null;
  if v_baseline.id is null or not private.can_on_project(v_baseline.project_id, 'schedule.baseline.write') then
    raise exception using errcode = '42501', message = 'schedule.baseline.write is required on the baseline';
  end if;
  if v_baseline.locked_at is not null then
    perform private.refuse('baseline_locked', 'This baseline is already locked; capture a new baseline instead.');
  end if;
  insert into app.schedule_baseline_items (schedule_baseline_id, record_id, planned_starts_at, planned_ends_at)
  select v_baseline.id, r.id, coalesce(r.starts_at, r.due_at), coalesce(r.ends_at, r.due_at, r.starts_at)
  from app.records r
  where r.project_id = v_baseline.project_id and r.deleted_at is null and r.record_state <> 'Canceled'
    and (r.starts_at is not null or r.ends_at is not null or r.due_at is not null)
  on conflict (schedule_baseline_id, record_id) do nothing;
  select count(*)::integer into v_count from app.schedule_baseline_items i where i.schedule_baseline_id = v_baseline.id;
  update app.schedule_baselines set locked_at = now() where id = v_baseline.id;
  update app.record_timeline t set baseline_locked_at = now()
  where t.baseline_locked_at is null
    and t.record_id in (select i.record_id from app.schedule_baseline_items i where i.schedule_baseline_id = v_baseline.id);
  return v_count;
end;
$$;

comment on function app.lock_baseline(uuid) is 'Captures the planned window of every dated, uncanceled record of the baseline''s project and locks the baseline in one transaction; Timeline records in it are marked locked. Needs schedule.baseline.write on the project. Returns the number of records captured.';

-- Dependencies --------------------------------------------------------------------------------------------

create trigger t90_emit_record_dependency after insert on app.record_dependencies
  for each row execute function private.emit_subject_event('record_dependency.created', 'records', 'successor_record_id',
    'predecessor_record_id', 'dependency_type', 'lag');

-- Day sheets and call sheets: publication ------------------------------------------------------------------

alter table app.day_sheets add column published_at timestamptz;
comment on column app.day_sheets.published_at is 'When the day sheet was published to its recipients, stamped by the database; set once.';

create or replace function private.guard_sheet_publication()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.project_id <> old.project_id then
    perform private.refuse('sheet_project_immutable', 'A sheet stays in its project.');
  end if;
  if tg_op = 'UPDATE' and old.published_at is not null then
    new.published_at := old.published_at;
  elsif new.published_at is not null then
    if auth.uid() is not null and not private.can_on_project(new.project_id, 'show.call_sheet.publish') then
      perform private.refuse('sheet_publish_capability', 'Only a person who may publish sheets on the project publishes one.');
    end if;
    new.published_at := now();
  end if;
  return new;
end;
$$;

comment on function private.guard_sheet_publication() is 'Day sheets and call sheets stay in their project; publishing needs show.call_sheet.publish, is stamped with the database time and happens once.';
revoke all on function private.guard_sheet_publication() from public, anon, authenticated;

create trigger t40_guard_day_sheet_publication before insert or update on app.day_sheets
  for each row execute function private.guard_sheet_publication();
create trigger t40_guard_call_sheet_publication before insert or update on app.call_sheets
  for each row execute function private.guard_sheet_publication();

create trigger t90_emit_day_sheet_published_insert after insert on app.day_sheets
  for each row when (new.published_at is not null)
  execute function private.emit_row_event('day_sheet.published', 'project_id', 'day', 'published_at');
create trigger t90_emit_day_sheet_published after update of published_at on app.day_sheets
  for each row when (old.published_at is null and new.published_at is not null)
  execute function private.emit_row_event('day_sheet.published', 'project_id', 'day', 'published_at');
create trigger t90_emit_call_sheet_published_insert after insert on app.call_sheets
  for each row when (new.published_at is not null)
  execute function private.emit_row_event('call_sheet.published', 'project_id', 'day', 'published_at');
create trigger t90_emit_call_sheet_published after update of published_at on app.call_sheets
  for each row when (old.published_at is null and new.published_at is not null)
  execute function private.emit_row_event('call_sheet.published', 'project_id', 'day', 'published_at');

-- Privileges -------------------------------------------------------------------------------------------

revoke all on function app.call_cue(uuid) from public, anon;
revoke all on function app.lock_baseline(uuid) from public, anon;
grant execute on function app.call_cue(uuid) to authenticated, service_role;
grant execute on function app.lock_baseline(uuid) to authenticated, service_role;
