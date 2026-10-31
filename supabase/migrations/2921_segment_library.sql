-- 2921_segment_library.sql
-- B3 Run-of-show depth (RRR-227, ADR 0142 decision 8; parity gap G-73). A segment the org runs in many shows (a
-- walk-in, an awards block, a sponsor moment) is kept once in a library and copied into any running order, where it can
-- be edited locally. When the library copy changes, the producer publishes it to the shows they choose.
--
--   * app.segment_library: the org's reusable segments. Org-wide: read by every member, written by holders of
--     show.run_of_show.write org-wide (private.orgs_with_capability, 0204). version counts changes and is never accepted
--     from a caller: a change of name, description or colour bumps it, and every statement that changes the segment's
--     cues or their department calls bumps it once.
--   * app.segment_library_cues and app.segment_library_cue_calls: the segment's cues (at most 100) and their department
--     calls, with the checks of app.cues and app.cue_calls. They stay out of Trash: they come back with their segment.
--   * app.run_segment_instances: one row each time a segment is inserted into a running order, with the version copied.
--     Written only by the two RPCs below. app.cues.segment_instance_id ties the copied cues to it: set only inside those
--     RPCs, cleared by a member who takes a cue out of the segment, never pointed at another instance, and always in the
--     cue's own running order.
--   * app.insert_library_segment copies the segment's cues and calls into a running order at a place after the last
--     called cue, renumbering the run 1..n with move_cue's parking technique (2793), at most 300 cues in all (the
--     display cap of 2780). With a start time each copy is planned from it and the durations before it (a missing
--     duration counts as none); without one the copies have no planned time. The segment's colour becomes the run's
--     colour for the segment name unless the run already has one (2920).
--   * app.publish_library_segment replaces, in each chosen run, the uncalled copy of an instance older than the library
--     with the current version, in place (Global Elements Manager semantics: local edits to those cues are replaced, and
--     the UI says so). An instance with a called cue (Called) or a cue linked to an artist's set time (Linked) is left
--     untouched; one already current answers Current; one with no live cue, or a run without an instance, answers
--     No Instance, so publishing never brings back a segment a member removed. Runs are locked one by one in id order.

insert into private.domain_event_types (code, subject, description) values
  ('segment_library.inserted', 'run_segment_instances', 'A library segment was copied into a running order.'),
  ('segment_library.published', 'segment_library', 'A library segment''s current version was published to chosen running orders.')
on conflict (code) do nothing;

-- The library ------------------------------------------------------------------------------------------------------------

create table app.segment_library (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  description text,
  color_key text,
  version integer not null default 1,
  constraint segment_library_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint segment_library_description_length check (description is null or char_length(btrim(description)) between 1 and 2000),
  constraint segment_library_color_key check (color_key is null or color_key ~ '^cat-[1-7]$'),
  constraint segment_library_version check (version >= 1)
);

call private.install_domain_table('app.segment_library');
create unique index segment_library_name_key on app.segment_library (org_id, lower(btrim(name))) where deleted_at is null;
call private.describe('app.segment_library', 'Reusable show segments of an org (ADR 0142): a named block of cues with their department calls, copied into running orders by app.insert_library_segment and republished to them by app.publish_library_segment.', array[
  'name', 'Segment name, unique in the org; copied cues take it as their segment.',
  'description', 'What the segment is.',
  'color_key', 'Colour of the segment (cat-1 to cat-7), given to a running order that has none for the name.',
  'version', 'Change counter, set by the database: one more for each change of name, description or colour and for each statement that changes the segment''s cues or calls. Never accepted from a caller.'
]);
call private.install_policies('app.segment_library',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('show.run_of_show.write'))$$);
call private.install_audit_trail('app.segment_library');
call private.install_default_retention('app.segment_library');

create table app.segment_library_cues (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  segment_library_id uuid not null references app.segment_library (id),
  position integer not null,
  label text not null,
  duration interval,
  description text,
  script text,
  constraint segment_library_cues_position_positive check (position > 0),
  constraint segment_library_cues_label_length check (char_length(btrim(label)) between 1 and 200),
  constraint segment_library_cues_duration check (duration is null or (duration >= interval '0' and duration <= interval '24 hours')),
  constraint segment_library_cues_description_length check (description is null or char_length(btrim(description)) between 1 and 2000),
  constraint segment_library_cues_script_length check (script is null or char_length(script) <= 20000)
);

create index segment_library_cues_segment_idx on app.segment_library_cues (segment_library_id);

call private.install_domain_table('app.segment_library_cues', 'app.segment_library', 'segment_library_id');
create unique index segment_library_cues_position_key on app.segment_library_cues (segment_library_id, position) where deleted_at is null;
call private.describe('app.segment_library_cues', 'Cues of a library segment, at most 100, in order. Copied with the segment into running orders.', array[
  'segment_library_id', 'Library segment.',
  'position', 'Order in the segment.',
  'label', 'Cue label, as on app.cues.',
  'duration', 'Planned length.',
  'description', 'What happens on the cue.',
  'script', 'What is said on the cue, up to 20,000 characters.'
]);
call private.install_policies('app.segment_library_cues',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('show.run_of_show.write'))$$);
call private.install_default_retention('app.segment_library_cues');

create table app.segment_library_cue_calls (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  segment_library_cue_id uuid not null references app.segment_library_cues (id),
  call_kind app.cue_call_kind not null,
  instruction text not null,
  constraint segment_library_cue_calls_instruction_length check (char_length(btrim(instruction)) between 1 and 2000)
);

call private.install_domain_table('app.segment_library_cue_calls', 'app.segment_library_cues', 'segment_library_cue_id');
create unique index segment_library_cue_calls_kind_key on app.segment_library_cue_calls (segment_library_cue_id, call_kind) where deleted_at is null;
call private.describe('app.segment_library_cue_calls', 'Department calls of a library cue, one per department, copied into app.cue_calls with the cue.', array[
  'segment_library_cue_id', 'Library cue the call belongs to.',
  'call_kind', 'Department the call is given to.',
  'instruction', 'What the department does on the cue.'
]);
call private.install_policies('app.segment_library_cue_calls',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('show.run_of_show.write'))$$);
call private.install_default_retention('app.segment_library_cue_calls');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('segment_library_cues', 'A library cue comes back with its segment, which is restored from Trash.'),
  ('segment_library_cue_calls', 'A library cue''s department call comes back with its segment.')
on conflict (table_name) do nothing;

-- Versions ---------------------------------------------------------------------------------------------------------------

create or replace function private.guard_segment_library()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
  elsif private.in_trusted_operation('segment_library_version') then
    new.version := old.version + 1;
  elsif (new.name, new.description, new.color_key) is distinct from (old.name, old.description, old.color_key) then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

comment on function private.guard_segment_library() is 'Library segments: version starts at 1 and is set only by the database, one more for a change of name, description or colour, or for a statement that changed the segment''s cues or calls (trusted operation segment_library_version).';
revoke all on function private.guard_segment_library() from public, anon, authenticated;

create trigger t40_guard_segment_library before insert or update on app.segment_library
  for each row execute function private.guard_segment_library();

create or replace function private.guard_segment_library_cue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.segment_library_id <> old.segment_library_id then
    perform private.refuse('segment_library_cue_fixed', 'A library cue stays in its segment.');
  end if;
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null)
     and (select count(*) from app.segment_library_cues c
          where c.segment_library_id = new.segment_library_id and c.deleted_at is null and c.id <> new.id) >= 100 then
    perform private.refuse('segment_library_cue_limit', 'A library segment holds at most 100 cues.');
  end if;
  return new;
end;
$$;

comment on function private.guard_segment_library_cue() is 'Library cues stay in their segment, and a segment holds at most 100 live cues (segment_library_cue_limit).';
revoke all on function private.guard_segment_library_cue() from public, anon, authenticated;

create trigger t40_guard_segment_library_cue before insert or update on app.segment_library_cues
  for each row execute function private.guard_segment_library_cue();

-- One bump per statement: the segments whose cues (or the cues' calls) the statement changed.
create or replace function private.bump_segment_library_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if tg_table_name = 'segment_library_cues' then
    select array_agg(distinct (to_jsonb(r) ->> 'segment_library_id')::uuid) into v_ids from changed_rows r;
  else
    select array_agg(distinct c.segment_library_id) into v_ids
    from changed_rows r join app.segment_library_cues c on c.id = (to_jsonb(r) ->> 'segment_library_cue_id')::uuid;
  end if;
  if v_ids is not null then
    perform private.begin_trusted_operation('segment_library_version');
    update app.segment_library set updated_at = now() where id = any (v_ids);
    perform private.end_trusted_operation('segment_library_version');
  end if;
  return null;
end;
$$;

comment on function private.bump_segment_library_version() is 'Statement trigger on library cues and their calls: raises the version of each segment the statement changed, once.';
revoke all on function private.bump_segment_library_version() from public, anon, authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['segment_library_cues', 'segment_library_cue_calls'] loop
    execute format('create trigger t90_bump_segment_library_insert after insert on app.%I referencing new table as changed_rows '
      'for each statement execute function private.bump_segment_library_version()', v_table);
    execute format('create trigger t90_bump_segment_library_update after update on app.%I referencing new table as changed_rows '
      'for each statement execute function private.bump_segment_library_version()', v_table);
    execute format('create trigger t90_bump_segment_library_delete after delete on app.%I referencing old table as changed_rows '
      'for each statement execute function private.bump_segment_library_version()', v_table);
  end loop;
end;
$$;

-- Instances in running orders -----------------------------------------------------------------------------------------------

create table app.run_segment_instances (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  run_of_show_id uuid not null references app.run_of_show (id),
  segment_library_id uuid not null references app.segment_library (id),
  library_version integer not null,
  constraint run_segment_instances_version check (library_version >= 1)
);

create index run_segment_instances_run_idx on app.run_segment_instances (run_of_show_id);
create index run_segment_instances_segment_idx on app.run_segment_instances (segment_library_id);

call private.install_child_table('app.run_segment_instances', 'app.run_of_show', 'run_of_show_id', 'show.run_of_show.read',
  'show.run_of_show.write', array['app.segment_library', 'segment_library_id']);
call private.describe('app.run_segment_instances', 'A library segment copied into a running order (ADR 0142), with the library version the copy holds. Written only by app.insert_library_segment and app.publish_library_segment.', array[
  'run_of_show_id', 'Running order the segment was copied into.',
  'segment_library_id', 'Library segment copied.',
  'library_version', 'Version of the library segment the copy holds; publishing replaces an older copy.'
]);
revoke insert, update on app.run_segment_instances from authenticated;
call private.install_default_retention('app.run_segment_instances');

create or replace function private.guard_run_segment_instance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.in_trusted_operation('segment_library') then
    perform private.refuse('segment_instance_fixed', 'A segment is copied into a running order and republished only through the segment library.');
  end if;
  if tg_op = 'UPDATE' and (new.run_of_show_id <> old.run_of_show_id or new.segment_library_id <> old.segment_library_id) then
    perform private.refuse('segment_instance_fixed', 'A copied segment stays in its running order and library segment.');
  end if;
  return new;
end;
$$;

comment on function private.guard_run_segment_instance() is 'Segment instances are written only inside the segment library RPCs (trusted operation segment_library) and keep their running order and library segment.';
revoke all on function private.guard_run_segment_instance() from public, anon, authenticated;

create trigger t40_guard_run_segment_instance before insert or update on app.run_segment_instances
  for each row execute function private.guard_run_segment_instance();

alter table app.cues add column segment_instance_id uuid references app.run_segment_instances (id);
create index cues_segment_instance_idx on app.cues (segment_instance_id);
call private.add_cross_org_references('app.cues', array['app.run_segment_instances', 'segment_instance_id']);
comment on column app.cues.segment_instance_id is 'Library segment copy the cue came from (app.run_segment_instances), set by the segment library RPCs. A member may clear it to take the cue out of the copy; it never points at another copy.';

create or replace function private.guard_cue_segment_instance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.segment_instance_id is null or (tg_op = 'UPDATE' and new.segment_instance_id is not distinct from old.segment_instance_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.segment_instance_id is not null then
    perform private.refuse('cue_segment_instance', 'A cue never moves to another copy of a segment; clear it instead.');
  end if;
  if not private.in_trusted_operation('segment_library') then
    perform private.refuse('cue_segment_instance', 'Cues join a library segment copy only through the segment library.');
  end if;
  if (select i.run_of_show_id from app.run_segment_instances i where i.id = new.segment_instance_id) is distinct from new.run_of_show_id then
    perform private.refuse('cue_segment_instance', 'A cue''s segment copy is in its own running order.');
  end if;
  return new;
end;
$$;

comment on function private.guard_cue_segment_instance() is 'A cue''s segment_instance_id is set only by the segment library RPCs (trusted operation segment_library), to a copy in the cue''s running order; a member may clear it, and it never points at another copy (cue_segment_instance).';
revoke all on function private.guard_cue_segment_instance() from public, anon, authenticated;

create trigger t41_guard_cue_segment_instance before insert or update of segment_instance_id on app.cues
  for each row execute function private.guard_cue_segment_instance();

-- Copying a segment into a running order ----------------------------------------------------------------------------------------

-- Shared by insert and publish. The caller holds the run's lock and the segment_library trusted operation. Places the
-- segment's live cues at a 1-based place among the run's live cues and renumbers the run 1..n: only cues whose position
-- changes are written, parked past the end first so cues_position_key holds at every row (as move_cue, 2793).
create or replace function private.place_library_cues(
  p_run_of_show_id uuid,
  p_library app.segment_library,
  p_ordinal integer,
  p_instance_id uuid,
  p_starts_at timestamptz
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_n integer;
  v_lc app.segment_library_cues;
  v_cue uuid;
  v_at timestamptz := p_starts_at;
  v_i integer := 0;
begin
  select array_agg(c.id order by c.position) into v_ids
  from app.cues c where c.run_of_show_id = p_run_of_show_id and c.deleted_at is null;
  select count(*) into v_n from app.segment_library_cues lc where lc.segment_library_id = p_library.id and lc.deleted_at is null;

  with final as (
    select w.id, (case when w.ordinal < p_ordinal then w.ordinal else w.ordinal + v_n end)::integer as pos
    from unnest(coalesce(v_ids, '{}'::uuid[])) with ordinality as w (id, ordinal)
  )
  update app.cues c set position = c.position + 1000000 from final f where c.id = f.id and c.position <> f.pos;
  with final as (
    select w.id, (case when w.ordinal < p_ordinal then w.ordinal else w.ordinal + v_n end)::integer as pos
    from unnest(coalesce(v_ids, '{}'::uuid[])) with ordinality as w (id, ordinal)
  )
  update app.cues c set position = f.pos from final f where c.id = f.id and c.position <> f.pos;

  for v_lc in
    select * from app.segment_library_cues lc where lc.segment_library_id = p_library.id and lc.deleted_at is null order by lc.position
  loop
    insert into app.cues (run_of_show_id, position, label, duration, description, script, segment, segment_instance_id, planned_at)
    values (p_run_of_show_id, p_ordinal + v_i, v_lc.label, v_lc.duration, v_lc.description, v_lc.script, btrim(p_library.name),
      p_instance_id, v_at)
    returning id into v_cue;
    insert into app.cue_calls (cue_id, call_kind, instruction)
    select v_cue, k.call_kind, k.instruction from app.segment_library_cue_calls k
    where k.segment_library_cue_id = v_lc.id and k.deleted_at is null;
    if v_at is not null then
      v_at := v_at + coalesce(v_lc.duration, interval '0');
    end if;
    v_i := v_i + 1;
  end loop;

  if p_library.color_key is not null and not exists (
    select 1 from app.run_segment_colors s
    where s.run_of_show_id = p_run_of_show_id and lower(btrim(s.segment)) = lower(btrim(p_library.name)) and s.deleted_at is null
  ) then
    insert into app.run_segment_colors (run_of_show_id, segment, color_key) values (p_run_of_show_id, btrim(p_library.name), p_library.color_key);
  end if;
  return v_n;
end;
$$;

comment on function private.place_library_cues(uuid, app.segment_library, integer, uuid, timestamptz) is 'Copies a library segment''s live cues and their department calls into a running order at a 1-based place, renumbering the run 1..n and planning the copies from p_starts_at and the durations before them (a missing duration counts as none), or leaving them unplanned. Gives the run the segment''s colour for its name when it has none. The caller holds the run''s lock and the segment_library trusted operation. Returns how many cues it copied.';
revoke all on function private.place_library_cues(uuid, app.segment_library, integer, uuid, timestamptz) from public, anon, authenticated;

create or replace function app.insert_library_segment(
  p_run_of_show_id uuid,
  p_segment_library_id uuid,
  p_before_position integer default null,
  p_starts_at timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.run_of_show;
  v_library app.segment_library;
  v_count integer;
  v_last_called integer;
  v_n integer;
  v_ordinal integer;
  v_instance uuid;
begin
  perform private.require_person();
  select * into v_run from app.run_of_show r where r.id = p_run_of_show_id and r.deleted_at is null for update;
  if v_run.id is null or not private.can_on_project(v_run.project_id, 'show.run_of_show.write') then
    raise exception using errcode = '42501', message = 'show.run_of_show.write is required on the running order';
  end if;
  select * into v_library from app.segment_library s
  where s.id = p_segment_library_id and s.deleted_at is null and s.org_id = v_run.org_id;
  if v_library.id is null then
    raise exception using errcode = '42501', message = 'library segment not found';
  end if;
  select count(*) into v_n from app.segment_library_cues lc where lc.segment_library_id = v_library.id and lc.deleted_at is null;
  if v_n = 0 then
    perform private.refuse('segment_library_empty', 'This library segment has no cues yet.');
  end if;

  select count(*), coalesce(max(o.ordinal) filter (where o.called), 0)
  into v_count, v_last_called
  from (select c.called_at is not null as called, row_number() over (order by c.position) as ordinal
        from app.cues c where c.run_of_show_id = v_run.id and c.deleted_at is null) o;
  if v_count + v_n > 300 then
    perform private.refuse('segment_insert_cue_limit', 'A running order holds at most 300 cues.');
  end if;
  v_ordinal := greatest(1, least(v_count + 1, coalesce(p_before_position, v_count + 1)));
  if v_ordinal <= v_last_called then
    perform private.refuse('segment_insert_before_called', 'Insert the segment after the last called cue.');
  end if;

  perform private.begin_trusted_operation('segment_library');
  insert into app.run_segment_instances (run_of_show_id, segment_library_id, library_version)
  values (v_run.id, v_library.id, v_library.version)
  returning id into v_instance;
  perform private.place_library_cues(v_run.id, v_library, v_ordinal, v_instance, p_starts_at);
  perform private.end_trusted_operation('segment_library');

  perform private.emit_event(v_run.org_id, 'segment_library.inserted', 'run_segment_instances', v_instance, v_run.project_id,
    jsonb_build_object('segment_library_id', v_library.id, 'run_of_show_id', v_run.id, 'library_version', v_library.version,
      'cues', v_n));
  return v_instance;
end;
$$;

comment on function app.insert_library_segment(uuid, uuid, integer, timestamptz) is 'Copies a library segment of the running order''s org, with its department calls, into the running order before the cue at the 1-based place p_before_position (clamped; NULL appends), renumbering the run 1..n in one transaction under a lock on the run (ADR 0142). Planned times follow p_starts_at and the durations, or stay NULL. Needs show.run_of_show.write on the project; refuses an empty segment (segment_library_empty), a place at or before the last called cue (segment_insert_before_called) and a run that would pass 300 cues (segment_insert_cue_limit). Returns the new app.run_segment_instances id.';
revoke all on function app.insert_library_segment(uuid, uuid, integer, timestamptz) from public, anon;
grant execute on function app.insert_library_segment(uuid, uuid, integer, timestamptz) to authenticated, service_role;

create or replace function app.publish_library_segment(p_segment_library_id uuid, p_run_ids uuid[])
returns table (run_of_show_id uuid, segment_instance_id uuid, outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_library app.segment_library;
  v_run_id uuid;
  v_run app.run_of_show;
  v_instance app.run_segment_instances;
  v_live integer;
  v_called integer;
  v_linked boolean;
  v_first integer;
  v_start timestamptz;
  v_others integer;
  v_n integer;
  v_ordinal integer;
  v_published integer := 0;
  v_any boolean;
begin
  perform private.require_person();
  select * into v_library from app.segment_library s
  where s.id = p_segment_library_id and s.deleted_at is null and s.org_id in (select private.my_org_ids());
  if v_library.id is null then
    raise exception using errcode = '42501', message = 'library segment not found';
  end if;
  if p_run_ids is null or cardinality(p_run_ids) = 0 or cardinality(p_run_ids) > 50 then
    perform private.refuse('segment_publish_runs', 'Publish to between 1 and 50 running orders at a time.');
  end if;
  select count(*) into v_n from app.segment_library_cues lc where lc.segment_library_id = v_library.id and lc.deleted_at is null;

  perform private.begin_trusted_operation('segment_library');
  for v_run_id in select distinct x from unnest(p_run_ids) x where x is not null order by x loop
    select * into v_run from app.run_of_show r where r.id = v_run_id and r.deleted_at is null for update;
    if v_run.id is null or v_run.org_id <> v_library.org_id
       or not private.can_on_project(v_run.project_id, 'show.run_of_show.write') then
      raise exception using errcode = '42501', message = 'show.run_of_show.write is required on every running order';
    end if;
    v_any := false;
    for v_instance in
      select * from app.run_segment_instances i
      where i.run_of_show_id = v_run.id and i.segment_library_id = v_library.id and i.deleted_at is null
      order by i.created_at, i.id
    loop
      v_any := true;
      select count(*), count(*) filter (where c.called_at is not null),
        coalesce(bool_or(exists (select 1 from app.engagement_cues ec where ec.cue_id = c.id and ec.deleted_at is null)), false),
        min(c.position)
      into v_live, v_called, v_linked, v_first
      from app.cues c where c.segment_instance_id = v_instance.id and c.deleted_at is null;
      if v_live = 0 then
        return query select v_run.id, v_instance.id, 'No Instance'::text;
      elsif v_instance.library_version >= v_library.version then
        return query select v_run.id, v_instance.id, 'Current'::text;
      elsif v_called > 0 then
        return query select v_run.id, v_instance.id, 'Called'::text;
      elsif v_linked then
        return query select v_run.id, v_instance.id, 'Linked'::text;
      else
        select count(*) filter (where c.segment_instance_id is distinct from v_instance.id),
          count(*) filter (where c.segment_instance_id is distinct from v_instance.id and c.position < v_first)
        into v_others, v_ordinal
        from app.cues c where c.run_of_show_id = v_run.id and c.deleted_at is null;
        if v_others + v_n > 300 then
          perform private.refuse('segment_insert_cue_limit', 'A running order holds at most 300 cues.');
        end if;
        select c.planned_at into v_start from app.cues c
        where c.segment_instance_id = v_instance.id and c.deleted_at is null order by c.position limit 1;
        update app.cues c set deleted_at = now() where c.segment_instance_id = v_instance.id and c.deleted_at is null;
        perform private.place_library_cues(v_run.id, v_library, v_ordinal + 1, v_instance.id, v_start);
        update app.run_segment_instances i set library_version = v_library.version where i.id = v_instance.id;
        v_published := v_published + 1;
        return query select v_run.id, v_instance.id, 'Published'::text;
      end if;
    end loop;
    if not v_any then
      return query select v_run.id, null::uuid, 'No Instance'::text;
    end if;
  end loop;
  perform private.end_trusted_operation('segment_library');

  perform private.emit_event(v_library.org_id, 'segment_library.published', 'segment_library', v_library.id, null,
    jsonb_build_object('library_version', v_library.version, 'runs', cardinality(p_run_ids), 'published', v_published));
end;
$$;

comment on function app.publish_library_segment(uuid, uuid[]) is 'Publishes a library segment''s current version to up to 50 chosen running orders of its org (segment_publish_runs otherwise), locking them one by one in id order (ADR 0142). Answers one row per copy of the segment in each run: Published (its live uncalled cues were replaced in place by the current copies, with their department calls, and the run renumbered 1..n), Current (already this version), Called (a cue was called) or Linked (a cue is an artist''s set time), both left untouched, or No Instance (the run holds no live copy). Local edits to replaced cues, custom values included, are lost. Needs show.run_of_show.write on every run; no other run changes.';
revoke all on function app.publish_library_segment(uuid, uuid[]) from public, anon;
grant execute on function app.publish_library_segment(uuid, uuid[]) to authenticated, service_role;

select private.sync_trash_tables();
