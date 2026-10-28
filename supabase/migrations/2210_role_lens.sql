-- 2210_role_lens.sql
-- A128 (RRR-173, S4.8.1-06, ADR 0086): the role lens of the context switcher. A person who holds several roles in
-- an org can narrow Atlas, Gateway and Compass to one of them. The lens only shapes what the shells show; row
-- level security and every RPC still decide with the person's full standing.
--
-- app.role_lens_capabilities reuses View as role's resolution (app.view_as_capabilities, 1062): each capability
-- of the role, capped at the person's own reach through private.person_capability_reach. Where View as previews
-- any role at or below the viewer's band for holders of org.view_as_role.use, the lens is open to every member
-- but only for a role their membership holds, so it never shows a role's capabilities to someone who lacks them.

create or replace function app.role_lens_capabilities(p_org_id uuid, p_role_id uuid)
returns table (capability_code text, role_reach app.capability_reach, viewer_reach app.capability_reach, lens_reach app.capability_reach)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
begin
  if not exists (
    select 1
    from app.memberships m
    join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
    join app.roles r on r.id = mr.role_id and r.deleted_at is null
    where m.person_id = v_person and m.org_id = p_org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      and r.id = p_role_id
  ) then
    perform private.refuse('role_lens_role_not_held', 'Choose one of the roles you hold in this organization.');
  end if;
  return query
  select rc.capability_code, rc.reach, v.reach, least(rc.reach, v.reach)
  from app.role_capabilities rc
  cross join lateral (select private.person_capability_reach(v_person, p_org_id, rc.capability_code, true) as reach) v
  where rc.role_id = p_role_id and rc.deleted_at is null and v.reach is not null
  order by rc.capability_code;
end;
$$;

comment on function app.role_lens_capabilities(uuid, uuid) is 'The role lens (Section 4.8.1, ADR 0086) for a member who holds the role in the org: every capability of the role with the role''s reach, the member''s own reach and the lens reach, the lesser of the two. A capability the member does not reach (an API key or app session outside its scope) is left out, so a lens never shows more than the member already holds. A role the member does not hold is refused (role_lens_role_not_held).';
revoke all on function app.role_lens_capabilities(uuid, uuid) from public, anon;
grant execute on function app.role_lens_capabilities(uuid, uuid) to authenticated, service_role;
