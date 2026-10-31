-- 2794_cue_calls_save.sql
-- P2 Run of show and show calling (RRR-216, ADR 0131; gaps G-74 and G-78). The inline cue editor saves a cue's
-- department calls (app.cue_calls, 1180) in one call.
--
--   * app.save_cue_calls(cue, calls): calls is an object keyed by app.cue_call_kind label. A text value is upserted as
--     the cue's live call for that department; NULL or blank clears it (soft delete, so retention and history keep it).
--     Departments left out are untouched. An unknown key is refused (cue_call_kind).

create or replace function app.save_cue_calls(p_cue_id uuid, p_calls jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cue app.cues;
  v_key text;
  v_value jsonb;
  v_text text;
begin
  perform private.require_person();
  select * into v_cue from app.cues c where c.id = p_cue_id and c.deleted_at is null;
  if v_cue.id is null or not private.can_on_project(v_cue.project_id, 'show.run_of_show.write') then
    raise exception using errcode = '42501', message = 'show.run_of_show.write is required on the running order';
  end if;
  if p_calls is null or jsonb_typeof(p_calls) <> 'object' then
    perform private.refuse('cue_call_kind', 'Send the calls as an object keyed by department.');
  end if;
  for v_key in select k from jsonb_object_keys(p_calls) k loop
    if not exists (select 1 from unnest(enum_range(null::app.cue_call_kind)) e where e::text = v_key) then
      perform private.refuse('cue_call_kind', 'A call goes to Audio, Lighting, Video, Special Effects or Stage.');
    end if;
  end loop;
  for v_key, v_value in select k, v from jsonb_each(p_calls) as j (k, v) loop
    v_text := case when jsonb_typeof(v_value) = 'string' then nullif(btrim(v_value #>> '{}'), '') end;
    if v_text is null then
      update app.cue_calls set deleted_at = now()
      where cue_id = v_cue.id and call_kind = v_key::app.cue_call_kind and deleted_at is null;
    else
      insert into app.cue_calls (org_id, cue_id, call_kind, instruction)
      values (v_cue.org_id, v_cue.id, v_key::app.cue_call_kind, v_text)
      on conflict (cue_id, call_kind) where deleted_at is null
      do update set instruction = excluded.instruction;
    end if;
  end loop;
end;
$$;

comment on function app.save_cue_calls(uuid, jsonb) is 'Saves a cue''s department calls in one transaction: p_calls maps app.cue_call_kind labels to an instruction (upserted) or NULL or blank (the live call is soft-deleted); departments left out are untouched. Needs show.run_of_show.write on the cue''s project; refuses an unknown department (cue_call_kind).';

revoke all on function app.save_cue_calls(uuid, jsonb) from public, anon;
grant execute on function app.save_cue_calls(uuid, jsonb) to authenticated, service_role;
