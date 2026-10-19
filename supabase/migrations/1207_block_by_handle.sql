-- 1207_block_by_handle.sql
-- A52 settings features (RRR-97). Personal settings, Profile Privacy (Section 4.5.6) lists blocked people and
-- organizations. People know a profile by its handle (/u/{handle}, /c/{handle}), so:
--   * app.block_profile blocks the person or organization a handle names, but only a profile the caller can see right now
--     (or has already blocked, so blocking again is idempotent),
--     answering the same refusal for a hidden or unknown handle, so it never reveals that a hidden profile exists;
--   * app.my_blocks lists the caller's blocks with the handle and name of each blocked profile, for the settings page,
--     since the blocker cannot read a stranger's person row directly.

create or replace function app.block_profile(p_kind text, p_handle text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_urn text;
  v_id uuid;
  v_pp app.person_profiles;
  v_op app.organization_profiles;
begin
  if p_kind = 'person' then
    v_pp := private.person_profile_by_handle(p_handle);
    if v_pp.id is not null then
      v_urn := 'urn:xpms:person:' || v_pp.person_id::text;
      if not private.profile_visible_to_me(v_pp.person_id, v_pp.visibility)
         and not exists (select 1 from app.blocks b where b.person_id = v_person and b.blocked_urn = v_urn and b.deleted_at is null) then
        v_urn := null;
      end if;
    end if;
  elsif p_kind = 'organization' then
    v_op := private.organization_profile_by_handle(p_handle);
    if v_op.id is not null then
      v_urn := 'urn:xpms:organization:' || v_op.org_id::text;
      if not private.org_profile_visible_to_me(v_op.org_id, v_op.visibility)
         and not exists (select 1 from app.blocks b where b.person_id = v_person and b.blocked_urn = v_urn and b.deleted_at is null) then
        v_urn := null;
      end if;
    end if;
  end if;
  if v_urn is null then
    perform private.refuse('block_handle_unknown', 'No profile with this handle is visible to you.');
  end if;
  select b.id into v_id from app.blocks b where b.person_id = v_person and b.blocked_urn = v_urn and b.deleted_at is null;
  if v_id is not null then
    return v_id;
  end if;
  insert into app.blocks (person_id, blocked_urn) values (v_person, v_urn) returning id into v_id;
  return v_id;
end;
$$;

comment on function app.block_profile(text, text) is 'Blocks the person (p_kind person) or organization (p_kind organization) a profile handle names, following a live handle redirect. Only a profile the caller can see now (or has already blocked) is blocked; a hidden or unknown handle is refused alike (block_handle_unknown). Idempotent; returns the block id.';
revoke all on function app.block_profile(text, text) from public, anon;
grant execute on function app.block_profile(text, text) to authenticated, service_role;

create or replace function app.my_blocks()
returns table (id uuid, blocked_kind text, blocked_handle text, blocked_name text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id,
    case when b.blocked_person_id is not null then 'person' else 'organization' end,
    coalesce(pp.handle, op.handle),
    coalesce(pe.full_name, o.name),
    b.created_at
  from app.blocks b
  left join app.person_profiles pp on pp.person_id = b.blocked_person_id and pp.deleted_at is null
  left join app.people pe on pe.id = b.blocked_person_id
  left join app.organization_profiles op on op.org_id = b.blocked_organization_id and op.deleted_at is null
  left join app.organizations o on o.id = b.blocked_organization_id
  where b.person_id = private.current_person_id() and b.deleted_at is null
  order by b.created_at desc;
$$;

comment on function app.my_blocks() is 'The signed-in person''s live blocks, newest first, with the kind, handle and name of each blocked profile.';
revoke all on function app.my_blocks() from public, anon;
grant execute on function app.my_blocks() to authenticated, service_role;
