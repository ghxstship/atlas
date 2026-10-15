-- 0410_punch_items.sql
-- A08 Work (ADR 0022 range 0410 to 0419). Punch list items (Section 4.2 Work, Section 4.5.5 Work >
-- Punch lists, journey 17). A punch item is a Task record of subtype Execute, titled "Correct <what
-- failed>", plus the facts only a punch item has: where it came from (an Inspection record or one
-- failed inspection result) and where it is (a zone, a site plan pin or a written location). Its
-- title, owner, due date and state live on the record and are never restated here (Section 3.15);
-- closing a punch item is moving its record to Complete.
--
-- Rows follow their record's visibility (invariant 2). Writes need work.punch_list.write on the
-- record's project. A09's inspection trigger creates items through private.insert_punch_item.

create table app.punch_items (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  record_id uuid not null references app.records (id),
  source_record_id uuid references app.records (id),
  inspection_result_id uuid references app.inspection_results (id),
  zone_id uuid references app.zones (id),
  site_plan_pin_id uuid references app.site_plan_pins (id),
  location_text text,
  deleted_at timestamptz,
  constraint punch_items_location_length check (location_text is null or char_length(btrim(location_text)) between 1 and 300),
  constraint punch_items_not_own_source check (source_record_id is null or source_record_id <> record_id)
);

create unique index punch_items_record_key on app.punch_items (record_id) where deleted_at is null;
create unique index punch_items_inspection_result_key on app.punch_items (inspection_result_id)
  where inspection_result_id is not null and deleted_at is null;
create index punch_items_source_record_id_idx on app.punch_items (source_record_id);
create index punch_items_zone_id_idx on app.punch_items (zone_id);
create index punch_items_site_plan_pin_id_idx on app.punch_items (site_plan_pin_id);

call private.install_domain_table('app.punch_items', 'app.records', 'record_id',
  array['app.records', 'source_record_id', 'app.inspection_results', 'inspection_result_id',
        'app.zones', 'zone_id', 'app.site_plan_pins', 'site_plan_pin_id']);
call private.describe('app.punch_items', 'Punch list items: one Task record of subtype Execute each, with where the item came from and where it is. Title, owner, due date and state are the record''s; a punch item closes when its record is Complete.', array[
  'record_id', 'The Task record (subtype Execute) that carries the correction. One punch item per record; never changes.',
  'source_record_id', 'Record the item was raised from, usually an Inspection record of the same project.',
  'inspection_result_id', 'Failed inspection result the item corrects. At most one punch item per result.',
  'zone_id', 'Zone of the project''s venue where the item is.',
  'site_plan_pin_id', 'Pin on a site plan of the project marking the item.',
  'location_text', 'Where the item is, in words, when no zone or pin says it.'
]);

create or replace function private.guard_punch_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record app.records;
  v_other uuid;
begin
  select * into v_record from app.records r where r.id = new.record_id;
  if tg_op = 'UPDATE' and new.record_id <> old.record_id then
    perform private.refuse('punch_item_record_immutable', 'A punch item stays on its record.');
  end if;
  if tg_op = 'INSERT' and (v_record.record_kind <> 'Task' or v_record.record_subtype is distinct from 'Execute') then
    perform private.refuse('punch_item_task', 'A punch item is a Task record of subtype Execute.');
  end if;
  if new.source_record_id is not null then
    select r.project_id into v_other from app.records r where r.id = new.source_record_id;
    if v_other is distinct from v_record.project_id then
      perform private.refuse('same_project', 'A punch item''s source record belongs to the item''s project.');
    end if;
  end if;
  if new.inspection_result_id is not null then
    select i.project_id into v_other
    from app.inspection_results ir join app.inspections i on i.id = ir.inspection_id
    where ir.id = new.inspection_result_id;
    if v_other is distinct from v_record.project_id then
      perform private.refuse('same_project', 'A punch item corrects an inspection result of its own project.');
    end if;
  end if;
  if new.site_plan_pin_id is not null then
    select sp.project_id into v_other
    from app.site_plan_pins pin join app.site_plans sp on sp.id = pin.site_plan_id
    where pin.id = new.site_plan_pin_id;
    if v_other is distinct from v_record.project_id then
      perform private.refuse('same_project', 'A punch item''s pin is on a site plan of its own project.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_punch_item() is 'Punch items: a Task record of subtype Execute that never changes, with a source record, inspection result and site plan pin of the same project.';
revoke all on function private.guard_punch_item() from public, anon, authenticated;

create trigger t40_guard_punch_item before insert or update on app.punch_items
  for each row execute function private.guard_punch_item();

-- Events ---------------------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('punch_item.created', 'punch_items', 'A punch list item was raised, with its Task record.')
on conflict (code) do nothing;

create or replace function private.emit_punch_item_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.emit_event(new.org_id, 'punch_item.created', 'punch_items', new.id,
    (select r.project_id from app.records r where r.id = new.record_id),
    jsonb_build_object('record_id', new.record_id, 'source_record_id', new.source_record_id,
      'inspection_result_id', new.inspection_result_id, 'zone_id', new.zone_id));
  return null;
end;
$$;

comment on function private.emit_punch_item_created() is 'After insert trigger: emits punch_item.created with the item''s project.';
revoke all on function private.emit_punch_item_created() from public, anon, authenticated;

create trigger t90_emit_punch_item_created after insert on app.punch_items
  for each row execute function private.emit_punch_item_created();

-- Creation -------------------------------------------------------------------------------------------

create or replace function private.punch_title(p_what text)
returns text
language sql
immutable
set search_path = ''
as $$
  select left('Correct ' || btrim(regexp_replace(replace(btrim(p_what), chr(8212), ','), '[.!?:;,]+$', '')), 200);
$$;

comment on function private.punch_title(text) is 'The title of a punch item''s Task record: "Correct <what failed>", without closing punctuation or em dashes, at most 200 characters.';
revoke all on function private.punch_title(text) from public, anon, authenticated;

create or replace function private.insert_punch_item(
  p_project_id uuid,
  p_what text,
  p_source_record_id uuid default null,
  p_inspection_result_id uuid default null,
  p_zone_id uuid default null,
  p_site_plan_pin_id uuid default null,
  p_location_text text default null,
  p_owner_party_id uuid default null,
  p_due_at timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_source app.records;
  v_record uuid;
  v_item uuid;
begin
  if p_what is null or char_length(btrim(p_what)) = 0 then
    perform private.refuse('punch_item_what_required', 'A punch item says what must be corrected.');
  end if;
  if p_inspection_result_id is not null then
    select pi.id into v_item from app.punch_items pi
    where pi.inspection_result_id = p_inspection_result_id and pi.deleted_at is null;
    if v_item is not null then
      return v_item;
    end if;
  end if;
  if p_source_record_id is not null then
    select * into v_source from app.records r where r.id = p_source_record_id;
  end if;
  insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, phase_code, urid, xyz,
    xyz_basis, owner_party_id, due_at)
  values (p_project_id, v_source.scope_node_id, 'Task', 'Execute', private.punch_title(p_what), v_source.phase_code,
    v_source.urid, coalesce(v_source.xyz, 'Y'), case when v_source.id is null then 'Declared'::app.xyz_basis else v_source.xyz_basis end,
    p_owner_party_id, p_due_at)
  returning id into v_record;
  insert into app.punch_items (record_id, source_record_id, inspection_result_id, zone_id, site_plan_pin_id, location_text)
  values (v_record, p_source_record_id, p_inspection_result_id, p_zone_id, p_site_plan_pin_id, nullif(btrim(p_location_text), ''))
  returning id into v_item;
  return v_item;
end;
$$;

comment on function private.insert_punch_item(uuid, text, uuid, uuid, uuid, uuid, text, uuid, timestamptz) is 'Creates a punch item and its Task record (subtype Execute, "Correct <what>") in one step; the Task takes the source record''s scope node, phase, URID and XYZ tag, or a Declared Y (Process) tag without one. Idempotent per inspection result: a second call returns the existing item. No capability check: callers authorize first (app.create_punch_item, A09''s inspection trigger).';
revoke all on function private.insert_punch_item(uuid, text, uuid, uuid, uuid, uuid, text, uuid, timestamptz) from public, anon, authenticated;

create or replace function app.create_punch_item(
  p_project_id uuid,
  p_what text,
  p_source_record_id uuid default null,
  p_zone_id uuid default null,
  p_site_plan_pin_id uuid default null,
  p_location_text text default null,
  p_owner_party_id uuid default null,
  p_due_at timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if not exists (select 1 from private.project_ids_with('work.punch_list.write') x where x = p_project_id) then
    raise exception using errcode = '42501', message = 'work.punch_list.write is required on the project';
  end if;
  return private.insert_punch_item(p_project_id, p_what, p_source_record_id, null, p_zone_id, p_site_plan_pin_id,
    p_location_text, p_owner_party_id, p_due_at);
end;
$$;

comment on function app.create_punch_item(uuid, text, uuid, uuid, uuid, text, uuid, timestamptz) is 'Raises a punch item with its Task record. Needs work.punch_list.write on the project. Returns the punch item id.';
revoke all on function app.create_punch_item(uuid, text, uuid, uuid, uuid, text, uuid, timestamptz) from public, anon;
grant execute on function app.create_punch_item(uuid, text, uuid, uuid, uuid, text, uuid, timestamptz) to authenticated, service_role;

-- Policies -------------------------------------------------------------------------------------------

call private.install_policies('app.punch_items',
  $$record_id in (select private.record_ids_with('work.record.read'))$$,
  $$record_id in (select r.id from app.records r where r.project_id in (select private.project_ids_with('work.punch_list.write')))$$);
