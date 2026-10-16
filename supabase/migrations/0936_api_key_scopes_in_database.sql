-- Security finding A22-001: an API key's scopes were enforced only in the /api/v1 runtime.
--
-- api-token mints a five-minute Supabase JWT for the key's service account (ADR 0003, migration 0921).
-- That JWT is an ordinary authenticated session, so a holder who sent it straight to PostgREST got
-- every capability of the service account's roles, whatever scopes the key carried.
--
-- Fix: the database applies the scopes too. A JWT minted for an API key carries
-- amr [{"method": "xos_api_key"}] and a scopes array. When such a session asks for one of its
-- caller's own capabilities, person_capability_reach returns no reach for any capability whose
-- group (the segment before the first dot, as in the runtime's assertScope) is outside the scopes.
-- Every capability helper (has_capability, capability_reach, project_ids_with, record_ids_with,
-- orgs_with_capability) resolves through person_capability_reach, so RLS and RPC checks follow.
-- Reach computed for other people (for example, who on a project may be assigned) is unchanged.

create or replace function private.api_key_scopes()
returns text[]
language sql
stable
set search_path = ''
as $$
  select case
    when c ? 'amr' and jsonb_typeof(c -> 'amr') = 'array'
         and exists (select 1 from jsonb_array_elements(c -> 'amr') e
                     where jsonb_typeof(e) = 'object' and e ->> 'method' = 'xos_api_key')
    then coalesce((select array_agg(s) from jsonb_array_elements_text(
                     case when jsonb_typeof(c -> 'scopes') = 'array' then c -> 'scopes' else '[]'::jsonb end) s),
                  '{}'::text[])
  end
  from (select nullif(current_setting('request.jwt.claims', true), '')::jsonb as c) claims;
$$;

comment on function private.api_key_scopes() is 'The scopes of the API key behind the current session, or null when the session was not minted for an API key (A22-001). An API-key session with no scopes returns an empty array, which permits nothing.';
revoke all on function private.api_key_scopes() from public, anon, authenticated;

create or replace function private.person_capability_reach(p_person_id uuid, p_org_id uuid, p_capability text, p_include_delegations boolean)
 RETURNS app.capability_reach
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $$
begin
  if p_person_id is null or p_org_id is null then
    return null;
  end if;
  -- A22-001: an API-key session reaches only the capability groups in the key's scopes.
  if p_person_id = private.current_person_id()
     and private.api_key_scopes() is not null
     and not (split_part(p_capability, '.', 1) = any (private.api_key_scopes())) then
    return null;
  end if;
  return (
    select max(s.reach) from (
      select rc.reach
      from app.memberships m
      join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
      join app.roles r on r.id = mr.role_id and r.deleted_at is null
      join app.role_capabilities rc on rc.role_id = r.id and rc.deleted_at is null
      where m.person_id = p_person_id and m.org_id = p_org_id
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        and rc.capability_code = p_capability
      union all
      select 'organization'::app.capability_reach
      from app.user_capability_grants g
      join app.memberships m on m.id = g.membership_id
      where m.person_id = p_person_id and m.org_id = p_org_id
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        and g.capability_code = p_capability and g.scope_id is null and g.deleted_at is null
        and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
      union all
      select 'organization'::app.capability_reach
      from app.record_grants rg
      where rg.org_id = p_org_id and rg.target_kind = 'organization' and rg.target_id = p_org_id
        and rg.capability_code = p_capability and rg.deleted_at is null
        and rg.valid_from <= now() and rg.valid_to > now()
        and (rg.grantee_person_id = p_person_id
             or rg.grantee_org_id in (select private.person_org_ids(p_person_id)))
      union all
      select private.person_capability_reach(dm.person_id, p_org_id, p_capability, false)
      from app.delegations d
      join app.memberships em on em.id = d.delegate_membership_id
      join app.memberships dm on dm.id = d.delegator_membership_id
      where p_include_delegations
        and d.org_id = p_org_id and d.deleted_at is null
        and d.valid_from <= now() and d.valid_to > now()
        and em.person_id = p_person_id
        and em.deleted_at is null and em.valid_from <= now() and (em.valid_to is null or em.valid_to > now())
        and dm.deleted_at is null and dm.valid_from <= now() and (dm.valid_to is null or dm.valid_to > now())
        and (d.capability_code = p_capability
             or (d.capability_code is null and exists (
               select 1 from app.capabilities c where c.code = p_capability and c.capability_class = 'approve')))
    ) s
  );
end;
$$;
