-- 0421_inspection_rpcs.sql
-- A09 Safety: the inspection runner's RPCs, which Atlas, the API and Compass (offline, through
-- app.apply_sync_mutation) share:
--   * app.start_inspection: opens an inspection of a project from a template
--   * app.record_inspection_result: records one item's canon result, with an optional finding photo;
--     a Failed result creates the punch item through A08's private.insert_punch_item (journey 17),
--     idempotent per result, in the same transaction
--   * app.sign_off_inspection: signs an inspection off; the guard of 0353 keeps sign-off away from
--     the inspector and freezes the results
-- Each RPC checks the capability on the project first, because it runs as definer.

create or replace function app.start_inspection(p_project_id uuid, p_template_id uuid, p_inspected_at timestamptz default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_person();
  if not private.can_on_project(p_project_id, 'safety.inspection.write') then
    raise exception using errcode = '42501', message = 'safety.inspection.write is required on the project';
  end if;
  if not exists (select 1 from app.inspection_templates t join app.projects p on p.org_id = t.org_id
                 where t.id = p_template_id and p.id = p_project_id and t.deleted_at is null) then
    raise exception using errcode = '42501', message = 'the inspection template is not visible';
  end if;
  insert into app.inspections (org_id, project_id, inspection_template_id, inspected_at)
  values ((select p.org_id from app.projects p where p.id = p_project_id), p_project_id, p_template_id, coalesce(p_inspected_at, now()))
  returning id into v_id;
  return v_id;
end;
$$;
comment on function app.start_inspection(uuid, uuid, timestamptz) is 'Starts an inspection of a project from a live template of the same org; the inspector is the session person. Needs safety.inspection.write on the project. Returns the inspection id.';
revoke all on function app.start_inspection(uuid, uuid, timestamptz) from public, anon;
grant execute on function app.start_inspection(uuid, uuid, timestamptz) to authenticated, service_role;

create or replace function app.record_inspection_result(
  p_inspection_id uuid,
  p_item_id uuid,
  p_result_enum_id text,
  p_note text default null,
  p_photo_uri text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inspection app.inspections;
  v_item app.inspection_items;
  v_result uuid;
begin
  perform private.require_person();
  select * into v_inspection from app.inspections i where i.id = p_inspection_id and i.deleted_at is null;
  if v_inspection.id is null or not private.can_on_project(v_inspection.project_id, 'safety.inspection.write') then
    raise exception using errcode = '42501', message = 'safety.inspection.write is required on the inspection''s project';
  end if;
  select * into v_item from app.inspection_items it where it.id = p_item_id and it.deleted_at is null;
  select r.id into v_result from app.inspection_results r
  where r.inspection_id = p_inspection_id and r.inspection_item_id = p_item_id and r.deleted_at is null;
  if v_result is null then
    insert into app.inspection_results (org_id, inspection_id, inspection_item_id, result_enum_id, note, photo_uri)
    values (v_inspection.org_id, p_inspection_id, p_item_id, p_result_enum_id, nullif(btrim(p_note), ''), p_photo_uri)
    returning id into v_result;
  else
    update app.inspection_results
    set result_enum_id = p_result_enum_id, note = nullif(btrim(p_note), ''), photo_uri = coalesce(p_photo_uri, photo_uri)
    where id = v_result;
  end if;
  -- A Failed result (canon INSP_FAILED, read by code) opens the punch item that corrects it.
  if exists (select 1 from xpms.std_enumeration e where e.record_id = p_result_enum_id
             and e.enum_domain = 'Inspection Result' and e.enum_code = 'INSP_FAILED') then
    perform private.insert_punch_item(v_inspection.project_id, v_item.prompt, v_inspection.record_id, v_result);
  end if;
  return v_result;
end;
$$;
comment on function app.record_inspection_result(uuid, uuid, text, text, text) is 'Records or replaces one item''s canon Inspection Result on an inspection, with a note and an optional field-media photo. A Failed result creates the punch item "Correct <item prompt>" through private.insert_punch_item, once per result (journey 17). Needs safety.inspection.write on the project; the 0353 guard refuses a signed-off inspection, an item of another template and a value outside the enumeration. Returns the result id.';
revoke all on function app.record_inspection_result(uuid, uuid, text, text, text) from public, anon;
grant execute on function app.record_inspection_result(uuid, uuid, text, text, text) to authenticated, service_role;

create or replace function app.sign_off_inspection(p_inspection_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select i.project_id from app.inspections i where i.id = p_inspection_id and i.deleted_at is null);
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, 'safety.inspection.sign_off') then
    raise exception using errcode = '42501', message = 'safety.inspection.sign_off is required on the inspection''s project';
  end if;
  if exists (select 1 from app.inspections i where i.id = p_inspection_id and i.signed_off_at is not null) then
    perform private.refuse('inspection_signed_off', 'A signed-off inspection''s results never change.');
  end if;
  update app.inspections set signed_off_at = now() where id = p_inspection_id;
  return p_inspection_id;
end;
$$;
comment on function app.sign_off_inspection(uuid) is 'Signs off an inspection once. Needs safety.inspection.sign_off on the project; the 0353 guard records who and when and refuses the inspector (separation of duties).';
revoke all on function app.sign_off_inspection(uuid) from public, anon;
grant execute on function app.sign_off_inspection(uuid) to authenticated, service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.start_inspection', 'Start an inspection from a template on the device.'),
  ('app.record_inspection_result', 'Record an inspection item''s result, note and photo; a failure opens its punch item.'),
  ('app.sign_off_inspection', 'Sign off an inspection.');
