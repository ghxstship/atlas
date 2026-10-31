-- 2924_showcaller_link_access.sql
-- B3 Showcaller portal (RRR-227, ADR 0142). The anonymous side of showcaller links (2923): token RPCs in the sense of
-- Section 7.5 invariant 8 (ADR 0033 decision 56). Each needs the token, a device grant earned with the access code, and
-- stays within the link's one running order. Execute is granted to anon.
--
--   * The P2 writes become private cores that take the locked running order and hold the rule logic: call, standby,
--     move, nudge and department calls. app.call_cue, standby_cue, move_cue, shift_cue_plan and save_cue_calls keep
--     their signatures, checks, refusals, comments and grants, and call the cores (as R10's submit_advance_typed calls
--     private.record_advance_answer, 2730). app.call_cue now locks the running order too, so a member's call and a
--     portal write serialize.
--   * private.showcaller_link_reader checks a read or write, in this order: a read-only (GET) transaction is refused
--     before anything (1295); the address failure limits of P1 (only without a valid grant); the token format
--     (^xscl_, so P1's xshv_ and xscr_ tokens never match); an unknown token counts a failure unless it is retired; a
--     revoked or deleted link answers invalid without counting; expiry; the grant, which must belong to this link;
--     the rate (reads 7200 an hour per grant and 40000 per link, writes 1800 an hour per grant); the portal's columns
--     still Public or Internal (showcaller_link_reclassified); the running order and its project still live; and the
--     creator still a member holding show.run_of_show.write and show.cue.call on the project, checked as the creator
--     with the claims switched and restored (showcaller_link_owner_access). A link locked by wrong codes keeps serving
--     its grants.
--   * api_public.open_showcaller_link mirrors open_live_link (2781) and caps a link at 5 unexpired device grants
--     (showcaller_link_devices).
--   * api_public.showcaller_run answers only what the portal renders: the heading, the channel, the running order's
--     live cues (at most 300) with their department calls, segment colors and Showcaller-audience custom values, and
--     for each cue whether it was called through a link and whether it is an artist's set time (so the portal can
--     disable Remove before the database refuses it). The portal's columns include the custom values, their fields and
--     choices, so reclassifying any of them stops the portal.
--     Never a person's id or name, the link's note, or another running order's rows: every query filters by the link's
--     running order.
--   * The write RPCs run as anon under the trusted operation showcaller_link with xos.showcaller_link_id set, so a call
--     is stamped with the link (2923), never with the creator, who did not make it. Each resolves its cue with the
--     link's running order in the WHERE clause; a miss answers showcaller_link_scope with one body for another run,
--     project or org and for an id that does not exist, writes nothing but a rate event, and 20 of them by one grant in
--     10 minutes delete the grant. Every write in a read-only org is refused (org_read_only) before anything is
--     written: the read-only trigger of 1063 fires only for a person, and the portal has none. Refusals of the rules
--     come back as JSON (XR001's hint, as 2730), as do bad field values (showcaller_cue_field); rate and scope counts
--     are written outside that block, so they persist. Each write adds one showcaller_link.write audit event naming
--     the link, the operation and the cue.
--   * The portal edits, removes and gives department calls to uncalled cues only (showcaller_cue_called), never
--     removes a cue linked to an artist's set time (showcaller_cue_linked), and never edits the running order itself,
--     its set times, the segment library or custom values.

-- The cores ----------------------------------------------------------------------------------------------------------------

create or replace function private.call_cue_in_run(p_run app.run_of_show, p_cue app.cues)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_called timestamptz;
begin
  if p_cue.called_at is not null then
    perform private.refuse('cue_already_called', 'This cue was already called; call the next cue.');
  end if;
  update app.cues set called_at = now() where id = p_cue.id and run_of_show_id = p_run.id returning called_at into v_called;
  return v_called;
end;
$$;

comment on function private.call_cue_in_run(app.run_of_show, app.cues) is 'Core of a cue call (2924), for app.call_cue and the showcaller link: refuses a called cue (cue_already_called) and stamps the call. The caller holds the running order''s lock and decided who may call.';
revoke all on function private.call_cue_in_run(app.run_of_show, app.cues) from public, anon, authenticated;

create or replace function private.standby_cue_in_run(p_run app.run_of_show, p_cue_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cue app.cues;
begin
  if p_cue_id is not null then
    select * into v_cue from app.cues c where c.id = p_cue_id and c.run_of_show_id = p_run.id and c.deleted_at is null;
    if v_cue.id is null then
      raise exception using errcode = '42501', message = 'the cue is not in this running order';
    end if;
    if v_cue.called_at is not null then
      perform private.refuse('cue_standby_called', 'A called cue cannot go on standby.');
    end if;
  end if;
  update app.cues set standby_at = null
  where run_of_show_id = p_run.id and standby_at is not null and id is distinct from p_cue_id;
  if p_cue_id is not null then
    update app.cues set standby_at = now() where id = p_cue_id and standby_at is null;
  end if;
end;
$$;

comment on function private.standby_cue_in_run(app.run_of_show, uuid) is 'Core of standby (2924), for app.standby_cue and the showcaller link: puts one uncalled cue of the running order on standby and clears any other, or only clears with NULL; refuses a called cue (cue_standby_called). The caller holds the running order''s lock and decided who may.';
revoke all on function private.standby_cue_in_run(app.run_of_show, uuid) from public, anon, authenticated;

create or replace function private.move_cue_in_run(p_run app.run_of_show, p_cue app.cues, p_to_position integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_count integer;
  v_target integer;
  v_last_called integer;
  v_changed uuid[];
begin
  if p_cue.called_at is not null then
    perform private.refuse('cue_move_called', 'A called cue keeps its place.');
  end if;

  select array_agg(c.id order by c.position),
    coalesce(max(o.ordinal) filter (where c.called_at is not null), 0)
  into v_ids, v_last_called
  from app.cues c
  join (select c2.id, row_number() over (order by c2.position) as ordinal
        from app.cues c2 where c2.run_of_show_id = p_run.id and c2.deleted_at is null) o on o.id = c.id
  where c.run_of_show_id = p_run.id and c.deleted_at is null;
  v_count := cardinality(v_ids);
  v_target := greatest(1, least(v_count, coalesce(p_to_position, 1)));
  if v_target <= v_last_called then
    perform private.refuse('cue_move_before_called', 'Move it after the last called cue.');
  end if;

  v_ids := array_remove(v_ids, p_cue.id);
  v_ids := v_ids[1:v_target - 1] || p_cue.id || v_ids[v_target:];

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

comment on function private.move_cue_in_run(app.run_of_show, app.cues, integer) is 'Core of a cue move (2924, from app.move_cue 2793), for app.move_cue and the showcaller link: refuses a called cue (cue_move_called) and a place at or before the last called cue (cue_move_before_called), and renumbers the run densely, writing only cues whose position changes. The caller holds the running order''s lock, reread the cue under it and decided who may. Returns the new position.';
revoke all on function private.move_cue_in_run(app.run_of_show, app.cues, integer) from public, anon, authenticated;

create or replace function private.shift_cue_plan_in_run(p_run app.run_of_show, p_seconds integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_seconds is null or p_seconds = 0 or p_seconds not between -3600 and 3600 then
    perform private.refuse('cue_shift_range', 'Nudge by up to an hour earlier or later.');
  end if;
  update app.cues set planned_at = planned_at + make_interval(secs => p_seconds)
  where run_of_show_id = p_run.id and deleted_at is null and called_at is null and planned_at is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function private.shift_cue_plan_in_run(app.run_of_show, integer) is 'Core of a nudge (2924, from app.shift_cue_plan 2793), for app.shift_cue_plan and the showcaller link: moves the planned time of every live, uncalled, planned cue of the running order by p_seconds (between -3600 and 3600, not 0; cue_shift_range). The caller holds the running order''s lock and decided who may. Returns how many cues moved.';
revoke all on function private.shift_cue_plan_in_run(app.run_of_show, integer) from public, anon, authenticated;

create or replace function private.save_cue_calls_for_cue(p_cue app.cues, p_calls jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
  v_text text;
begin
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
      where cue_id = p_cue.id and call_kind = v_key::app.cue_call_kind and deleted_at is null;
    else
      insert into app.cue_calls (org_id, cue_id, call_kind, instruction)
      values (p_cue.org_id, p_cue.id, v_key::app.cue_call_kind, v_text)
      on conflict (cue_id, call_kind) where deleted_at is null
      do update set instruction = excluded.instruction;
    end if;
  end loop;
end;
$$;

comment on function private.save_cue_calls_for_cue(app.cues, jsonb) is 'Core of saving a cue''s department calls (2924, from app.save_cue_calls 2794), for app.save_cue_calls and the showcaller link: an object keyed by app.cue_call_kind label, each text upserted and each NULL or blank soft-deleted; refuses an unknown department (cue_call_kind). The caller decided who may.';
revoke all on function private.save_cue_calls_for_cue(app.cues, jsonb) from public, anon, authenticated;

-- The P2 writes over the cores (signatures, checks, refusals, comments and grants as before) ------------------------------------

create or replace function app.call_cue(p_cue_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cue app.cues;
  v_run app.run_of_show;
begin
  perform private.require_person();
  select * into v_cue from app.cues c where c.id = p_cue_id and c.deleted_at is null;
  if v_cue.id is null or not private.can_on_project(v_cue.project_id, 'show.cue.call') then
    raise exception using errcode = '42501', message = 'show.cue.call is required on the running order';
  end if;
  select * into v_run from app.run_of_show r where r.id = v_cue.run_of_show_id for update;
  -- Read the cue again under the run's lock: a showcaller link may have called it meanwhile.
  select * into v_cue from app.cues c where c.id = p_cue_id and c.deleted_at is null;
  if v_cue.id is null then
    raise exception using errcode = '42501', message = 'show.cue.call is required on the running order';
  end if;
  return private.call_cue_in_run(v_run, v_cue);
end;
$$;

comment on function app.call_cue(uuid) is 'Calls a cue now: stamps the database time and the caller. Needs show.cue.call on the project; a cue is called once. Returns the call time.';
revoke all on function app.call_cue(uuid) from public, anon;
grant execute on function app.call_cue(uuid) to authenticated, service_role;

create or replace function app.standby_cue(p_run_of_show_id uuid, p_cue_id uuid default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.run_of_show;
begin
  perform private.require_person();
  select * into v_run from app.run_of_show r where r.id = p_run_of_show_id and r.deleted_at is null for update;
  if v_run.id is null or not private.can_on_project(v_run.project_id, 'show.cue.call') then
    raise exception using errcode = '42501', message = 'show.cue.call is required on the running order';
  end if;
  perform private.standby_cue_in_run(v_run, p_cue_id);
end;
$$;

comment on function app.standby_cue(uuid, uuid) is 'Puts one uncalled cue of a running order on standby, clearing any other standby of the run, in one transaction; a NULL cue only clears. Needs show.cue.call on the project and refuses a called cue (cue_standby_called).';
revoke all on function app.standby_cue(uuid, uuid) from public, anon;
grant execute on function app.standby_cue(uuid, uuid) to authenticated, service_role;

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
  return private.move_cue_in_run(v_run, v_cue, p_to_position);
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
begin
  perform private.require_person();
  select * into v_run from app.run_of_show r where r.id = p_run_of_show_id and r.deleted_at is null for update;
  if v_run.id is null
     or not (private.can_on_project(v_run.project_id, 'show.cue.call')
             or private.can_on_project(v_run.project_id, 'show.run_of_show.write')) then
    raise exception using errcode = '42501', message = 'show.cue.call or show.run_of_show.write is required on the running order';
  end if;
  return private.shift_cue_plan_in_run(v_run, p_seconds);
end;
$$;

comment on function app.shift_cue_plan(uuid, integer) is 'Nudges the planned time of every live, uncalled, planned cue of a running order by p_seconds (between -3600 and 3600, not 0; cue_shift_range otherwise), in one transaction. Needs show.cue.call or show.run_of_show.write on the project. Returns how many cues moved.';
revoke all on function app.shift_cue_plan(uuid, integer) from public, anon;
grant execute on function app.shift_cue_plan(uuid, integer) to authenticated, service_role;

create or replace function app.save_cue_calls(p_cue_id uuid, p_calls jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cue app.cues;
begin
  perform private.require_person();
  select * into v_cue from app.cues c where c.id = p_cue_id and c.deleted_at is null;
  if v_cue.id is null or not private.can_on_project(v_cue.project_id, 'show.run_of_show.write') then
    raise exception using errcode = '42501', message = 'show.run_of_show.write is required on the running order';
  end if;
  perform private.save_cue_calls_for_cue(v_cue, p_calls);
end;
$$;

comment on function app.save_cue_calls(uuid, jsonb) is 'Saves a cue''s department calls in one transaction: p_calls maps app.cue_call_kind labels to an instruction (upserted) or NULL or blank (the live call is soft-deleted); departments left out are untouched. Needs show.run_of_show.write on the cue''s project; refuses an unknown department (cue_call_kind).';
revoke all on function app.save_cue_calls(uuid, jsonb) from public, anon;
grant execute on function app.save_cue_calls(uuid, jsonb) to authenticated, service_role;

-- The reader ------------------------------------------------------------------------------------------------------------------------

-- Every column the portal renders. A link stops when any is classified Confidential or Restricted (Section 8.3).
create or replace function private.showcaller_portal_columns()
returns table (table_name text, column_name text)
language sql
immutable
set search_path = ''
as $$
  values
    ('app.cues', 'position'), ('app.cues', 'label'), ('app.cues', 'segment'), ('app.cues', 'planned_at'),
    ('app.cues', 'start_tbc'), ('app.cues', 'duration'), ('app.cues', 'called_at'), ('app.cues', 'standby_at'),
    ('app.cues', 'description'), ('app.cues', 'script'), ('app.cue_calls', 'call_kind'), ('app.cue_calls', 'instruction'),
    ('app.run_of_show', 'name'), ('app.run_of_show', 'show_date'), ('app.run_of_show', 'curfew_at'),
    ('app.scope_nodes', 'name'), ('app.run_segment_colors', 'segment'), ('app.run_segment_colors', 'color_key'),
    ('app.projects', 'name'), ('app.projects', 'time_zone'), ('app.org_brands', 'display_name'),
    ('app.org_brands', 'logo_light_path'), ('app.org_brands', 'logo_dark_path'), ('app.org_brands', 'accent_hex'),
    ('app.org_brands', 'suppress_powered_by'), ('app.cues', 'updated_at'),
    ('app.custom_field_values', 'value_text'), ('app.custom_field_values', 'value_number'),
    ('app.custom_field_values', 'value_date'), ('app.custom_field_values', 'value_timestamp'),
    ('app.custom_field_values', 'value_boolean'), ('app.custom_field_definitions', 'field_key'),
    ('app.custom_field_definitions', 'label'), ('app.custom_field_definitions', 'data_type'),
    ('app.custom_field_definitions', 'sort_order'), ('app.custom_field_choices', 'label'),
    ('app.custom_field_choices', 'color_key');
$$;

comment on function private.showcaller_portal_columns() is 'Every column a showcaller portal renders (ADR 0142), the Showcaller-audience custom values, their fields and choices included; private.showcaller_link_reader refuses a link once any of them is classified above Internal (showcaller_link_reclassified).';
revoke all on function private.showcaller_portal_columns() from public, anon, authenticated;

create or replace function private.showcaller_link_reader(
  p_token text,
  p_grant text,
  p_client_address text,
  p_write boolean,
  out o_link app.showcaller_links,
  out o_grant_hash text,
  out o_grant_expires_at timestamptz,
  out o_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subjects record;
  v_hash bytea;
  v_grant_hash bytea;
  v_user uuid;
  v_claims text := current_setting('request.jwt.claims', true);
  v_ok boolean;
begin
  perform private.require_read_write();
  select * into v_subjects from private.live_link_subjects(p_client_address);
  if p_token is not null and p_token ~ '^xscl_[0-9a-f]{64}$' then
    v_hash := private.share_token_hash(p_token);
    select * into o_link from app.showcaller_links l where l.token_hash = v_hash;
  end if;
  v_grant_hash := case when p_grant ~ '^xcgr_[0-9a-f]{64}$' then private.share_token_hash(p_grant) end;
  if o_link.id is not null and v_grant_hash is not null then
    select g.expires_at into o_grant_expires_at from private.showcaller_link_grants g
    where g.grant_hash = v_grant_hash and g.showcaller_link_id = o_link.id and g.expires_at > now();
  end if;
  -- The address limits stop guessing, so a device that already proved the code is never blanked by its address.
  if o_grant_expires_at is null and private.live_link_rate_limited(v_subjects.o_hop, v_subjects.o_subject) then
    o_reason := 'showcaller_link_rate_limited';
    return;
  end if;
  if o_link.id is null then
    -- A regenerated or revoked token is a portal left open, not a guess; anything else counts.
    if v_hash is null or not exists (select 1 from private.retired_showcaller_link_tokens r where r.token_hash = v_hash) then
      perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    end if;
    o_reason := 'showcaller_link_invalid';
    return;
  end if;
  if o_link.revoked_at is not null or o_link.deleted_at is not null then
    o_reason := 'showcaller_link_invalid';
    return;
  end if;
  if o_link.expires_at <= now() then
    o_reason := 'showcaller_link_expired';
    return;
  end if;
  -- A link locked by wrong codes keeps serving the devices that proved the code.
  if o_grant_expires_at is null then
    o_reason := 'showcaller_link_grant';
    return;
  end if;
  o_grant_hash := encode(v_grant_hash, 'hex');
  if p_write then
    if private.rate_limit_exceeded('showcaller_link.write', o_grant_hash, 1800, interval '1 hour') then
      o_reason := 'showcaller_link_rate_limited';
      return;
    end if;
    perform private.note_rate_event('showcaller_link.write', o_grant_hash);
  else
    if private.rate_limit_exceeded('showcaller_link.read', o_grant_hash, 7200, interval '1 hour')
       or private.rate_limit_exceeded('showcaller_link.link_read', o_link.id::text, 40000, interval '1 hour') then
      o_reason := 'showcaller_link_rate_limited';
      return;
    end if;
    perform private.note_rate_event('showcaller_link.read', o_grant_hash);
    perform private.note_rate_event('showcaller_link.link_read', o_link.id::text);
  end if;

  if exists (
    select 1 from private.showcaller_portal_columns() pc
    join private.column_classifications cc on cc.table_name = pc.table_name and cc.column_name = pc.column_name
    where cc.classification in ('Confidential', 'Restricted')
  ) then
    o_reason := 'showcaller_link_reclassified';
    return;
  end if;
  if not exists (select 1 from app.run_of_show r join app.projects p on p.id = r.project_id
                 where r.id = o_link.run_of_show_id and r.deleted_at is null and p.deleted_at is null) then
    o_reason := 'showcaller_link_run_removed';
    return;
  end if;

  -- The creator still answers for the link: a member with both capabilities. Checked as the creator, then the claims
  -- go back; reads and writes run as anon.
  select p.user_id into v_user from app.people p where p.id = o_link.created_by and p.deleted_at is null;
  if v_user is null then
    o_reason := 'showcaller_link_owner_access';
    return;
  end if;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    v_ok := private.is_member(o_link.org_id)
      and private.can_on_project(o_link.project_id, 'show.run_of_show.write')
      and private.can_on_project(o_link.project_id, 'show.cue.call');
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  exception when others then
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    raise;
  end;
  if not coalesce(v_ok, false) then
    o_reason := 'showcaller_link_owner_access';
  end if;
end;
$$;

comment on function private.showcaller_link_reader(text, text, text, boolean) is 'Checks a showcaller link read or write (ADR 0142): a read-only transaction first (1295), the address failure limits (only without a valid device grant), the token (an unknown xscl_ token counts a failure unless retired; revoked or deleted answers showcaller_link_invalid uncounted; showcaller_link_expired), the device grant of this link (showcaller_link_grant), 7200 reads an hour per grant and 40000 per link or 1800 writes an hour per grant (showcaller_link_rate_limited), the portal''s columns still Public or Internal (showcaller_link_reclassified), the running order and its project still live (showcaller_link_run_removed), and the creator still a member holding show.run_of_show.write and show.cue.call on the project, checked as the creator with the claims restored (showcaller_link_owner_access). A locked link keeps serving its grants. Returns the link, the grant''s hash and expiry, or the reason.';
revoke all on function private.showcaller_link_reader(text, text, text, boolean) from public, anon, authenticated;

-- Opening a link ----------------------------------------------------------------------------------------------------------------------

create or replace function api_public.open_showcaller_link(p_token text, p_access_code text default null, p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subjects record;
  v_hash bytea;
  v_link app.showcaller_links;
  v_grant text;
  v_grant_expires timestamptz;
begin
  perform private.require_read_write();
  select * into v_subjects from private.live_link_subjects(p_client_address);
  if private.live_link_rate_limited(v_subjects.o_hop, v_subjects.o_subject) then
    return private.live_link_refusal('showcaller_link_rate_limited');
  end if;

  if p_token is not null and p_token ~ '^xscl_[0-9a-f]{64}$' then
    v_hash := private.share_token_hash(p_token);
    select * into v_link from app.showcaller_links l where l.token_hash = v_hash for update;
  end if;
  if v_link.id is null then
    if v_hash is null or not exists (select 1 from private.retired_showcaller_link_tokens r where r.token_hash = v_hash) then
      perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    end if;
    return private.live_link_refusal('showcaller_link_invalid');
  end if;
  if v_link.revoked_at is not null or v_link.deleted_at is not null then
    return private.live_link_refusal('showcaller_link_invalid');
  end if;
  if v_link.failed_attempts >= 5 then
    perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    return private.live_link_refusal('showcaller_link_locked');
  end if;
  if v_link.expires_at <= now() then
    return private.live_link_refusal('showcaller_link_expired');
  end if;
  if nullif(btrim(coalesce(p_access_code, '')), '') is null then
    return private.live_link_refusal('showcaller_link_access_code_required');
  end if;
  if v_link.access_code_hash <> private.share_code_hash(p_token, p_access_code) then
    perform private.begin_trusted_operation('showcaller_link_service');
    update app.showcaller_links l set failed_attempts = least(l.failed_attempts + 1, 5) where l.id = v_link.id;
    perform private.end_trusted_operation('showcaller_link_service');
    perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    return private.live_link_refusal(case when v_link.failed_attempts + 1 >= 5 then 'showcaller_link_locked' else 'showcaller_link_access_code' end);
  end if;

  delete from private.showcaller_link_grants g where g.expires_at < now() - interval '1 day';
  if (select count(*) from private.showcaller_link_grants g where g.showcaller_link_id = v_link.id and g.expires_at > now()) >= 5 then
    return private.live_link_refusal('showcaller_link_devices');
  end if;
  v_grant := 'xcgr_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_grant_expires := least(v_link.expires_at, now() + interval '48 hours');
  insert into private.showcaller_link_grants (grant_hash, showcaller_link_id, expires_at)
  values (private.share_token_hash(v_grant), v_link.id, v_grant_expires);

  perform private.begin_trusted_operation('showcaller_link_service');
  update app.showcaller_links l set open_count = l.open_count + 1, last_opened_at = now() where l.id = v_link.id;
  perform private.end_trusted_operation('showcaller_link_service');

  return jsonb_build_object('status', 'ok', 'grant', v_grant, 'grant_expires_at', v_grant_expires);
end;
$$;

comment on function api_public.open_showcaller_link(text, text, text) is 'Opens a showcaller link without an account (ADR 0142; Section 7.5 invariant 8), as api_public.open_live_link does (2781): refuses a read-only (GET) call first; then, unless the address used up its failures, locks the link row and checks it: unknown (counted unless retired), revoked or deleted (showcaller_link_invalid), locked after 5 wrong codes, expired, code missing, or wrong code (counted). A link holds at most 5 unexpired device grants (showcaller_link_devices). Answers JSON: status refused with the reason, or status ok with a device grant valid until the link expires or for 48 hours, and its expiry. Counts the open.';
revoke all on function api_public.open_showcaller_link(text, text, text) from public;
grant execute on function api_public.open_showcaller_link(text, text, text) to anon, authenticated, service_role;

-- Reading the running order -------------------------------------------------------------------------------------------------------------

create or replace function api_public.showcaller_run(p_token text, p_grant text, p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_read record;
  v_link app.showcaller_links;
  v_run app.run_of_show;
  v_stage text;
  v_cues jsonb;
  v_channel text;
begin
  select * into v_read from private.showcaller_link_reader(p_token, p_grant, p_client_address, false);
  if v_read.o_reason is not null then
    return private.live_link_refusal(v_read.o_reason);
  end if;
  v_link := v_read.o_link;
  select * into v_run from app.run_of_show r where r.id = v_link.run_of_show_id and r.deleted_at is null;
  select n.name into v_stage from app.scope_nodes n where n.id = v_run.scope_node_id and n.deleted_at is null;

  select coalesce(jsonb_agg(x.o order by x.position), '[]'::jsonb) into v_cues
  from (
    select c.position, jsonb_build_object(
        'id', c.id,
        'position', c.position,
        'label', c.label,
        'segment', c.segment,
        'segment_color', sc.color_key,
        'planned_at', c.planned_at,
        'start_tbc', c.start_tbc,
        'duration_seconds', floor(extract(epoch from c.duration))::bigint,
        'called_at', c.called_at,
        'called', c.called_at is not null,
        'called_via_link', c.called_via_link_id is not null,
        'set_time', exists (select 1 from app.engagement_cues ec where ec.cue_id = c.id and ec.deleted_at is null),
        'standby_at', c.standby_at,
        'description', c.description,
        'script', c.script,
        'updated_at', c.updated_at,
        'calls', coalesce((
          select jsonb_agg(jsonb_build_object('kind', k.call_kind, 'instruction', k.instruction) order by k.call_kind)
          from app.cue_calls k where k.cue_id = c.id and k.deleted_at is null), '[]'::jsonb),
        'fields', coalesce((
          select jsonb_agg(jsonb_build_object('key', d.field_key, 'label', d.label, 'data_type', d.data_type,
              'value_text', v.value_text, 'value_number', v.value_number, 'value_date', v.value_date,
              'value_timestamp', v.value_timestamp, 'value_boolean', v.value_boolean,
              'choice_label', ch.label, 'color_key', ch.color_key) order by d.sort_order, d.field_key)
          from app.custom_field_values v
          join app.custom_field_definitions d on d.id = v.custom_field_definition_id and d.deleted_at is null
            and d.target_table = 'app.cues' and d.data_type not in ('Person', 'Money', 'Email')
          left join app.custom_field_choices ch on ch.id = v.value_choice_id and ch.deleted_at is null
          where v.target_id = c.id and v.org_id = c.org_id and v.deleted_at is null
            and (d.data_type <> 'Choice' or ch.id is not null)
            and exists (select 1 from app.cue_field_audiences a
                        where a.custom_field_definition_id = d.id and a.audience = 'Showcaller' and a.deleted_at is null)),
          '[]'::jsonb)) as o
    from app.cues c
    left join app.run_segment_colors sc on sc.run_of_show_id = c.run_of_show_id and sc.deleted_at is null
      and lower(btrim(sc.segment)) = lower(btrim(c.segment))
    where c.run_of_show_id = v_link.run_of_show_id and c.deleted_at is null
    order by c.position
    limit 300
  ) x;

  select 'xcall:' || c.channel_key into v_channel from private.showcaller_link_channels c where c.showcaller_link_id = v_link.id;
  return jsonb_build_object(
    'status', 'ok',
    'meta', private.showcaller_link_meta(v_link) || jsonb_build_object('name', v_run.name, 'show_date', v_run.show_date,
      'stage', v_stage, 'curfew_at', v_run.curfew_at, 'grant_expires_at', v_read.o_grant_expires_at),
    'channel', v_channel,
    'server_now', now(),
    'cues', v_cues);
end;
$$;

comment on function api_public.showcaller_run(text, text, text) is 'Reads a showcaller link''s running order with its device grant (ADR 0142; Section 7.5 invariant 8). Refuses as private.showcaller_link_reader does. Answers JSON: meta (brand, project name and zone, running order name, show day, stage, curfew, caller name, link and grant expiry), the Realtime channel, server_now, and the running order''s live cues in order, at most 300, each with id, position, label, segment and its color, planned_at, start_tbc, duration_seconds, called_at and called, whether it was called through a showcaller link (called_via_link, never which one or by whom), whether it is an artist''s set time (set_time, which the portal never removes), standby_at, description, script, updated_at, its department calls and its Showcaller-audience custom values (never Person, Money or Email). Never a person''s id or name, the link''s note, or another running order''s rows. Writes only rate events.';
revoke all on function api_public.showcaller_run(text, text, text) from public;
grant execute on function api_public.showcaller_run(text, text, text) to anon, authenticated, service_role;

-- Writing through the link: shared steps ------------------------------------------------------------------------------------------------

-- A write's link, its running order locked, and its grant, or the reason it is refused. Nothing is written before
-- the reason is known, except the reader's rate and failure counts.
create or replace function private.showcaller_write_context(
  p_token text,
  p_grant text,
  p_client_address text,
  out o_link app.showcaller_links,
  out o_run app.run_of_show,
  out o_grant_hash text,
  out o_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_read record;
begin
  select * into v_read from private.showcaller_link_reader(p_token, p_grant, p_client_address, true);
  if v_read.o_reason is not null then
    o_reason := v_read.o_reason;
    return;
  end if;
  o_link := v_read.o_link;
  o_grant_hash := v_read.o_grant_hash;
  if private.org_read_only(o_link.org_id) then
    o_reason := 'org_read_only';
    return;
  end if;
  select * into o_run from app.run_of_show r where r.id = o_link.run_of_show_id and r.deleted_at is null for update;
  if o_run.id is null then
    o_reason := 'showcaller_link_run_removed';
  end if;
end;
$$;

comment on function private.showcaller_write_context(text, text, text) is 'Starts a showcaller link write (ADR 0142): checks it with private.showcaller_link_reader, refuses a read-only org (org_read_only, since the 1063 trigger fires only for a person), and locks the link''s running order. Returns the link, the locked running order and the grant''s hash, or the reason.';
revoke all on function private.showcaller_write_context(text, text, text) from public, anon, authenticated;

-- The cue a write aims at, only within the link's running order.
create or replace function private.showcaller_target_cue(p_run_of_show_id uuid, p_cue_id uuid)
returns app.cues
language sql
stable
security definer
set search_path = ''
as $$
  select c.* from app.cues c where c.id = p_cue_id and c.run_of_show_id = p_run_of_show_id and c.deleted_at is null;
$$;

comment on function private.showcaller_target_cue(uuid, uuid) is 'The live cue a showcaller link write aims at, looked up with the link''s running order in the WHERE clause, or a null row.';
revoke all on function private.showcaller_target_cue(uuid, uuid) from public, anon, authenticated;

-- The one answer for a cue outside the link's running order: counted against the grant, which 20 such answers in 10
-- minutes delete.
create or replace function private.showcaller_scope_refusal(p_link_id uuid, p_grant_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.note_rate_event('showcaller_link.scope', p_grant_hash);
  if private.rate_limit_exceeded('showcaller_link.scope', p_grant_hash, 20, interval '10 minutes') then
    delete from private.showcaller_link_grants g where g.grant_hash = decode(p_grant_hash, 'hex') and g.showcaller_link_id = p_link_id;
  end if;
  return private.live_link_refusal('showcaller_link_scope');
end;
$$;

comment on function private.showcaller_scope_refusal(uuid, text) is 'Answers a showcaller link write aimed outside its running order with showcaller_link_scope, the same body for another run, project or org or an id that does not exist; counts it against the grant and deletes the grant at 20 in 10 minutes.';
revoke all on function private.showcaller_scope_refusal(uuid, text) from public, anon, authenticated;

create or replace function private.showcaller_begin(p_link_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.begin_trusted_operation('showcaller_link');
  perform set_config('xos.showcaller_link_id', p_link_id::text, true);
end;
$$;

comment on function private.showcaller_begin(uuid) is 'Marks the transaction as writing through a showcaller link (trusted operation showcaller_link, xos.showcaller_link_id), so private.guard_cue stamps a call with the link. Claims are not switched.';
revoke all on function private.showcaller_begin(uuid) from public, anon, authenticated;

create or replace function private.showcaller_end(p_link app.showcaller_links, p_operation text, p_table text, p_subject_id uuid, p_cue_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.end_trusted_operation('showcaller_link');
  perform set_config('xos.showcaller_link_id', '', true);
  if p_operation is not null then
    perform private.write_audit_event(p_link.org_id, 'showcaller_link.write', p_table, p_subject_id,
      jsonb_build_object('link_id', p_link.id, 'operation', p_operation, 'cue_id', p_cue_id));
  end if;
end;
$$;

comment on function private.showcaller_end(app.showcaller_links, text, text, uuid, uuid) is 'Ends a showcaller link write: clears the trusted operation and the link setting and, for a write that happened, adds one showcaller_link.write audit event naming the link, the operation and the cue, nothing more.';
revoke all on function private.showcaller_end(app.showcaller_links, text, text, uuid, uuid) from public, anon, authenticated;

-- The writes ------------------------------------------------------------------------------------------------------------------------------

create or replace function api_public.showcaller_call_cue(p_token text, p_grant text, p_client_address text, p_cue_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx record;
  v_cue app.cues;
  v_at timestamptz;
  v_reason text;
begin
  select * into v_ctx from private.showcaller_write_context(p_token, p_grant, p_client_address);
  if v_ctx.o_reason is not null then
    return private.live_link_refusal(v_ctx.o_reason);
  end if;
  v_cue := private.showcaller_target_cue(v_ctx.o_run.id, p_cue_id);
  if v_cue.id is null then
    return private.showcaller_scope_refusal(v_ctx.o_link.id, v_ctx.o_grant_hash);
  end if;
  perform private.showcaller_begin(v_ctx.o_link.id);
  begin
    v_at := private.call_cue_in_run(v_ctx.o_run, v_cue);
  exception when sqlstate 'XR001' then
    get stacked diagnostics v_reason = pg_exception_hint;
    perform private.showcaller_end(v_ctx.o_link, null, null, null, null);
    return private.live_link_refusal(v_reason);
  end;
  perform private.showcaller_end(v_ctx.o_link, 'call', 'app.cues', v_cue.id, v_cue.id);
  return jsonb_build_object('status', 'ok', 'called_at', v_at);
end;
$$;

comment on function api_public.showcaller_call_cue(text, text, text, uuid) is 'Calls a cue of the showcaller link''s running order (ADR 0142): checked as private.showcaller_write_context does, the cue looked up within the running order (showcaller_link_scope otherwise), then private.call_cue_in_run (cue_already_called). The call is stamped with the link, not a person. Answers JSON: status ok and called_at, or status refused and the reason.';
revoke all on function api_public.showcaller_call_cue(text, text, text, uuid) from public;
grant execute on function api_public.showcaller_call_cue(text, text, text, uuid) to anon, authenticated, service_role;

create or replace function api_public.showcaller_standby_cue(p_token text, p_grant text, p_client_address text, p_cue_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx record;
  v_cue app.cues;
  v_reason text;
begin
  select * into v_ctx from private.showcaller_write_context(p_token, p_grant, p_client_address);
  if v_ctx.o_reason is not null then
    return private.live_link_refusal(v_ctx.o_reason);
  end if;
  if p_cue_id is not null then
    v_cue := private.showcaller_target_cue(v_ctx.o_run.id, p_cue_id);
    if v_cue.id is null then
      return private.showcaller_scope_refusal(v_ctx.o_link.id, v_ctx.o_grant_hash);
    end if;
  end if;
  perform private.showcaller_begin(v_ctx.o_link.id);
  begin
    perform private.standby_cue_in_run(v_ctx.o_run, p_cue_id);
  exception when sqlstate 'XR001' then
    get stacked diagnostics v_reason = pg_exception_hint;
    perform private.showcaller_end(v_ctx.o_link, null, null, null, null);
    return private.live_link_refusal(v_reason);
  end;
  perform private.showcaller_end(v_ctx.o_link, 'standby', case when p_cue_id is null then 'app.run_of_show' else 'app.cues' end,
    coalesce(p_cue_id, v_ctx.o_run.id), p_cue_id);
  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function api_public.showcaller_standby_cue(text, text, text, uuid) is 'Puts a cue of the showcaller link''s running order on standby, or with NULL clears the standby (ADR 0142), through private.standby_cue_in_run (cue_standby_called); the cue is looked up within the running order (showcaller_link_scope otherwise). Answers JSON: status ok, or status refused and the reason.';
revoke all on function api_public.showcaller_standby_cue(text, text, text, uuid) from public;
grant execute on function api_public.showcaller_standby_cue(text, text, text, uuid) to anon, authenticated, service_role;

create or replace function api_public.showcaller_shift_plan(p_token text, p_grant text, p_client_address text, p_seconds integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx record;
  v_count integer;
  v_reason text;
begin
  select * into v_ctx from private.showcaller_write_context(p_token, p_grant, p_client_address);
  if v_ctx.o_reason is not null then
    return private.live_link_refusal(v_ctx.o_reason);
  end if;
  perform private.showcaller_begin(v_ctx.o_link.id);
  begin
    v_count := private.shift_cue_plan_in_run(v_ctx.o_run, p_seconds);
  exception when sqlstate 'XR001' then
    get stacked diagnostics v_reason = pg_exception_hint;
    perform private.showcaller_end(v_ctx.o_link, null, null, null, null);
    return private.live_link_refusal(v_reason);
  end;
  perform private.showcaller_end(v_ctx.o_link, 'shift', 'app.run_of_show', v_ctx.o_run.id, null);
  return jsonb_build_object('status', 'ok', 'moved', v_count);
end;
$$;

comment on function api_public.showcaller_shift_plan(text, text, text, integer) is 'Nudges the remaining planned times of the showcaller link''s running order by p_seconds (ADR 0142), through private.shift_cue_plan_in_run (cue_shift_range: within an hour either way, not 0). Answers JSON: status ok and how many cues moved, or status refused and the reason.';
revoke all on function api_public.showcaller_shift_plan(text, text, text, integer) from public;
grant execute on function api_public.showcaller_shift_plan(text, text, text, integer) to anon, authenticated, service_role;

create or replace function api_public.showcaller_move_cue(p_token text, p_grant text, p_client_address text, p_cue_id uuid, p_to_position integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx record;
  v_cue app.cues;
  v_position integer;
  v_reason text;
begin
  select * into v_ctx from private.showcaller_write_context(p_token, p_grant, p_client_address);
  if v_ctx.o_reason is not null then
    return private.live_link_refusal(v_ctx.o_reason);
  end if;
  v_cue := private.showcaller_target_cue(v_ctx.o_run.id, p_cue_id);
  if v_cue.id is null then
    return private.showcaller_scope_refusal(v_ctx.o_link.id, v_ctx.o_grant_hash);
  end if;
  perform private.showcaller_begin(v_ctx.o_link.id);
  begin
    v_position := private.move_cue_in_run(v_ctx.o_run, v_cue, p_to_position);
  exception when sqlstate 'XR001' then
    get stacked diagnostics v_reason = pg_exception_hint;
    perform private.showcaller_end(v_ctx.o_link, null, null, null, null);
    return private.live_link_refusal(v_reason);
  end;
  perform private.showcaller_end(v_ctx.o_link, 'move', 'app.cues', v_cue.id, v_cue.id);
  return jsonb_build_object('status', 'ok', 'position', v_position);
end;
$$;

comment on function api_public.showcaller_move_cue(text, text, text, uuid, integer) is 'Moves an uncalled cue of the showcaller link''s running order to a 1-based place (ADR 0142), through private.move_cue_in_run (cue_move_called, cue_move_before_called); the cue is looked up within the running order (showcaller_link_scope otherwise). Answers JSON: status ok and the new position, or status refused and the reason.';
revoke all on function api_public.showcaller_move_cue(text, text, text, uuid, integer) from public;
grant execute on function api_public.showcaller_move_cue(text, text, text, uuid, integer) to anon, authenticated, service_role;

create or replace function api_public.showcaller_save_cue(
  p_token text,
  p_grant text,
  p_client_address text,
  p_cue_id uuid,
  p_fields jsonb,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx record;
  v_cue app.cues;
  v_key text;
  v_label text;
  v_segment text;
  v_description text;
  v_script text;
  v_planned timestamptz;
  v_tbc boolean;
  v_duration integer;
  v_count integer;
  v_position integer;
  v_id uuid;
  v_updated timestamptz;
  v_reason text;
begin
  select * into v_ctx from private.showcaller_write_context(p_token, p_grant, p_client_address);
  if v_ctx.o_reason is not null then
    return private.live_link_refusal(v_ctx.o_reason);
  end if;
  if p_cue_id is not null then
    v_cue := private.showcaller_target_cue(v_ctx.o_run.id, p_cue_id);
    if v_cue.id is null then
      return private.showcaller_scope_refusal(v_ctx.o_link.id, v_ctx.o_grant_hash);
    end if;
    if v_cue.called_at is not null then
      return private.live_link_refusal('showcaller_cue_called');
    end if;
    if p_expected_updated_at is null or p_expected_updated_at is distinct from v_cue.updated_at then
      return private.live_link_refusal('showcaller_cue_changed');
    end if;
  end if;

  -- The fields the portal may write, each checked before anything is written.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    return private.live_link_refusal('showcaller_cue_field');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k loop
    if v_key not in ('label', 'segment', 'description', 'script', 'planned_at', 'start_tbc', 'duration_seconds') then
      return private.live_link_refusal('showcaller_cue_field');
    end if;
  end loop;
  begin
    if p_fields ? 'label' then
      if jsonb_typeof(p_fields -> 'label') <> 'string' then
        return private.live_link_refusal('showcaller_cue_field');
      end if;
      v_label := btrim(p_fields ->> 'label');
      if char_length(v_label) not between 1 and 200 then
        return private.live_link_refusal('showcaller_cue_field');
      end if;
    elsif p_cue_id is null then
      return private.live_link_refusal('showcaller_cue_field');
    end if;
    if jsonb_typeof(p_fields -> 'segment') not in ('string', 'null')
       or jsonb_typeof(p_fields -> 'description') not in ('string', 'null')
       or jsonb_typeof(p_fields -> 'script') not in ('string', 'null')
       or jsonb_typeof(p_fields -> 'planned_at') not in ('string', 'null')
       or jsonb_typeof(p_fields -> 'start_tbc') not in ('boolean', 'null')
       or jsonb_typeof(p_fields -> 'duration_seconds') not in ('number', 'null') then
      return private.live_link_refusal('showcaller_cue_field');
    end if;
    v_segment := nullif(btrim(coalesce(p_fields ->> 'segment', '')), '');
    v_description := nullif(btrim(coalesce(p_fields ->> 'description', '')), '');
    v_script := nullif(p_fields ->> 'script', '');
    v_planned := (p_fields ->> 'planned_at')::timestamptz;
    v_tbc := coalesce((p_fields ->> 'start_tbc')::boolean, false);
    v_duration := (p_fields ->> 'duration_seconds')::integer;
    if char_length(coalesce(v_segment, '')) > 200 or char_length(coalesce(v_description, '')) > 2000
       or char_length(coalesce(v_script, '')) > 20000 or coalesce(v_duration, 0) not between 0 and 86400 then
      return private.live_link_refusal('showcaller_cue_field');
    end if;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
    return private.live_link_refusal('showcaller_cue_field');
  end;

  if p_cue_id is null then
    select count(*), coalesce(max(c.position), 0) into v_count, v_position
    from app.cues c where c.run_of_show_id = v_ctx.o_run.id and c.deleted_at is null;
    if v_count >= 300 then
      return private.live_link_refusal('showcaller_cue_limit');
    end if;
  end if;

  perform private.showcaller_begin(v_ctx.o_link.id);
  begin
    if p_cue_id is null then
      insert into app.cues (run_of_show_id, position, label, segment, description, script, planned_at, start_tbc, duration)
      values (v_ctx.o_run.id, v_position + 1, v_label, v_segment, v_description, v_script, v_planned, v_tbc,
        case when v_duration is null then null else make_interval(secs => v_duration) end)
      returning id, updated_at into v_id, v_updated;
    else
      update app.cues c set
        label = case when p_fields ? 'label' then v_label else c.label end,
        segment = case when p_fields ? 'segment' then v_segment else c.segment end,
        description = case when p_fields ? 'description' then v_description else c.description end,
        script = case when p_fields ? 'script' then v_script else c.script end,
        planned_at = case when p_fields ? 'planned_at' then v_planned else c.planned_at end,
        start_tbc = case when p_fields ? 'start_tbc' then v_tbc else c.start_tbc end,
        duration = case when p_fields ? 'duration_seconds' then
          (case when v_duration is null then null else make_interval(secs => v_duration) end) else c.duration end
      where c.id = v_cue.id
      returning c.id, c.updated_at into v_id, v_updated;
    end if;
  exception
    when sqlstate 'XR001' then
      get stacked diagnostics v_reason = pg_exception_hint;
      perform private.showcaller_end(v_ctx.o_link, null, null, null, null);
      return private.live_link_refusal(v_reason);
    when check_violation or invalid_text_representation or invalid_datetime_format then
      perform private.showcaller_end(v_ctx.o_link, null, null, null, null);
      return private.live_link_refusal('showcaller_cue_field');
  end;
  perform private.showcaller_end(v_ctx.o_link, case when p_cue_id is null then 'add' else 'edit' end, 'app.cues', v_id, v_id);
  return jsonb_build_object('status', 'ok', 'cue_id', v_id, 'updated_at', v_updated);
end;
$$;

comment on function api_public.showcaller_save_cue(text, text, text, uuid, jsonb, timestamptz) is 'Adds a cue at the end of the showcaller link''s running order (p_cue_id NULL, at most 300; showcaller_cue_limit) or edits an uncalled one of its cues (ADR 0142). p_fields may hold only label (1 to 200 characters, required for a new cue), segment (up to 200), description (up to 2000), script (up to 20,000), planned_at, start_tbc and duration_seconds (0 to 86400); any other key or a bad value answers showcaller_cue_field. An edit names the cue''s updated_at as last read (showcaller_cue_changed when it moved on), and refuses a called cue (showcaller_cue_called). The cue is looked up within the running order (showcaller_link_scope otherwise). Answers JSON: status ok with the cue id and its new updated_at, or status refused and the reason.';
revoke all on function api_public.showcaller_save_cue(text, text, text, uuid, jsonb, timestamptz) from public;
grant execute on function api_public.showcaller_save_cue(text, text, text, uuid, jsonb, timestamptz) to anon, authenticated, service_role;

create or replace function api_public.showcaller_remove_cue(p_token text, p_grant text, p_client_address text, p_cue_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx record;
  v_cue app.cues;
  v_reason text;
begin
  select * into v_ctx from private.showcaller_write_context(p_token, p_grant, p_client_address);
  if v_ctx.o_reason is not null then
    return private.live_link_refusal(v_ctx.o_reason);
  end if;
  v_cue := private.showcaller_target_cue(v_ctx.o_run.id, p_cue_id);
  if v_cue.id is null then
    return private.showcaller_scope_refusal(v_ctx.o_link.id, v_ctx.o_grant_hash);
  end if;
  if v_cue.called_at is not null then
    return private.live_link_refusal('showcaller_cue_called');
  end if;
  if exists (select 1 from app.engagement_cues ec where ec.cue_id = v_cue.id and ec.deleted_at is null) then
    return private.live_link_refusal('showcaller_cue_linked');
  end if;
  perform private.showcaller_begin(v_ctx.o_link.id);
  begin
    update app.cues set deleted_at = now(), standby_at = null where id = v_cue.id;
  exception when sqlstate 'XR001' then
    get stacked diagnostics v_reason = pg_exception_hint;
    perform private.showcaller_end(v_ctx.o_link, null, null, null, null);
    return private.live_link_refusal(v_reason);
  end;
  perform private.showcaller_end(v_ctx.o_link, 'remove', 'app.cues', v_cue.id, v_cue.id);
  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function api_public.showcaller_remove_cue(text, text, text, uuid) is 'Removes an uncalled cue of the showcaller link''s running order (ADR 0142) as a soft delete: the row and its department calls stay, and the showcaller_link.write audit event names it. Refuses a called cue (showcaller_cue_called) and a cue that is an artist''s set time (showcaller_cue_linked); the cue is looked up within the running order (showcaller_link_scope otherwise). Answers JSON: status ok, or status refused and the reason.';
revoke all on function api_public.showcaller_remove_cue(text, text, text, uuid) from public;
grant execute on function api_public.showcaller_remove_cue(text, text, text, uuid) to anon, authenticated, service_role;

create or replace function api_public.showcaller_save_cue_calls(p_token text, p_grant text, p_client_address text, p_cue_id uuid, p_calls jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx record;
  v_cue app.cues;
  v_reason text;
begin
  select * into v_ctx from private.showcaller_write_context(p_token, p_grant, p_client_address);
  if v_ctx.o_reason is not null then
    return private.live_link_refusal(v_ctx.o_reason);
  end if;
  v_cue := private.showcaller_target_cue(v_ctx.o_run.id, p_cue_id);
  if v_cue.id is null then
    return private.showcaller_scope_refusal(v_ctx.o_link.id, v_ctx.o_grant_hash);
  end if;
  if v_cue.called_at is not null then
    return private.live_link_refusal('showcaller_cue_called');
  end if;
  perform private.showcaller_begin(v_ctx.o_link.id);
  begin
    perform private.save_cue_calls_for_cue(v_cue, p_calls);
  exception
    when sqlstate 'XR001' then
      get stacked diagnostics v_reason = pg_exception_hint;
      perform private.showcaller_end(v_ctx.o_link, null, null, null, null);
      return private.live_link_refusal(v_reason);
    when check_violation then
      perform private.showcaller_end(v_ctx.o_link, null, null, null, null);
      return private.live_link_refusal('showcaller_cue_field');
  end;
  perform private.showcaller_end(v_ctx.o_link, 'calls', 'app.cues', v_cue.id, v_cue.id);
  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function api_public.showcaller_save_cue_calls(text, text, text, uuid, jsonb) is 'Saves the department calls of an uncalled cue of the showcaller link''s running order (ADR 0142), through private.save_cue_calls_for_cue (cue_call_kind; an instruction over 2000 characters answers showcaller_cue_field). Refuses a called cue (showcaller_cue_called); the cue is looked up within the running order (showcaller_link_scope otherwise). Answers JSON: status ok, or status refused and the reason.';
revoke all on function api_public.showcaller_save_cue_calls(text, text, text, uuid, jsonb) from public;
grant execute on function api_public.showcaller_save_cue_calls(text, text, text, uuid, jsonb) to anon, authenticated, service_role;
