-- The gated helpers (RRR-243; ADR 0169 work package 3; release 4.19, block 09, part 1 of 2).
--
-- ADR 0169 D6: the three helpers at the root of row-level security leave out the organizations that refuse the
-- current session, so every policy and function built on them (private.has_capability, private.capability_reach,
-- private.orgs_with_capability, private.project_ids_with and the policies of about a thousand tables) closes a
-- refusing organization without being touched.
--
--   private.my_org_ids()               the caller's organizations, without those that refuse the session
--   private.my_membership_ids()        the caller's memberships, without those in an organization that refuses it
--   private.person_capability_reach()  no reach for the caller in an organization that refuses the session
--
-- A session refused as a whole (session_ended) keeps no organization, no membership and no reach.
--
-- Every control ships off (ADR 0169 D7, owner decision 1). With every control off the verdict is empty after one
-- single-row read of private.session_gate_config, private.session_refusal() is NULL and
-- private.session_refused_org_ids() is empty, so the three helpers answer exactly as before. Nothing here switches
-- a control, registers anything on the request path or installs a policy that refuses.
--
-- The bodies are those of the ungated twins of 904180203 (private.my_org_ids_base, private.my_membership_ids_base,
-- private.person_capability_reach_base, copied from the helpers' latest definitions: 1563 for my_org_ids and
-- person_capability_reach, 0204 for my_membership_ids), each with the gate's test added. The helpers do not call
-- the twins: a catalog test holds that only the recovery functions and two read policies reference a twin.
--
-- How each reads the verdict (ADR 0169, "Asking for the verdict once per request"):
--   * the two set-returning helpers read  private.session_refusal() is null  and
--     org_id <> all (array(select private.session_refused_org_ids())) : one evaluation for each call of the helper,
--     and policies call the helpers as  in (select private.my_org_ids()) , one InitPlan for each statement;
--   * private.person_capability_reach runs per row through private.has_capability, so it reads
--     private.session_org_refusal(p_org_id) once: the verdict the pre-request stored in the transaction-local
--     setting when there is one, else a fresh one, which is the single-row configuration read while every control
--     is off.
--
-- The reach is gated for the caller's own person only. The verdict is about the session on the request, so the
-- reach of another person (the delegator in the delegation branch, or the people a sender picks as recipients) is
-- never changed by the caller's session. The caller's own reach through a delegation is closed with the rest: the
-- test runs before any branch.
--
-- The verdict itself never reads a gated helper (it reads app.memberships, private.org_session_rules and the
-- claims), so the helpers cannot call themselves through it. The suite of this migration holds that by walking
-- the functions private.session_verdict_compute reaches.
--
-- Read policies. A refused session must still name its organization, so /auth/mfa, /auth/session-ended,
-- /auth/network-restricted and the Compass gate can say which organization is closed (ADR 0169 D6):
--   * app.organizations: organizations_read (0205) read a member's organizations through private.my_org_ids();
--     that branch now reads private.my_org_ids_base(). The two capability branches stay gated.
--   * app.memberships: memberships_read (0205) already admits the caller's own memberships by
--     person_id = private.current_person_id(), which reads no gated helper, so the policy is not changed. The
--     suite pins that branch.
--
-- Locks: three function replacements and one ALTER POLICY, which takes a brief exclusive lock on
-- app.organizations, under lock_timeout.

set lock_timeout = '5s';

-- private.my_org_ids --------------------------------------------------------------------------------------------------------

create or replace function private.my_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.org_id from app.memberships m
  where m.person_id = private.current_person_id()
    and m.deleted_at is null
    and m.valid_from <= now()
    and (m.valid_to is null or m.valid_to > now())
    and (private.oauth_client_id() is null or m.org_id = private.oauth_org_id())
    -- ADR 0169 D6: not a session refused as a whole, and not an organization that refuses it.
    and private.session_refusal() is null
    and m.org_id <> all (array(select private.session_refused_org_ids()));
$$;

comment on function private.my_org_ids() is 'Orgs where the signed-in person holds an active membership; for an app''s session only the org that registered the app (ADR 0055). Leaves out every organization that refuses the current session, and answers nothing for a session refused as a whole (ADR 0169 D6). With every session gate control off it answers as private.my_org_ids_base.';
revoke all on function private.my_org_ids() from public, anon;
grant execute on function private.my_org_ids() to authenticated, service_role;

-- private.my_membership_ids -------------------------------------------------------------------------------------------------

create or replace function private.my_membership_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from app.memberships m
  where m.person_id = private.current_person_id()
    and m.deleted_at is null
    and m.valid_from <= now()
    and (m.valid_to is null or m.valid_to > now())
    -- ADR 0169 D6: not a session refused as a whole, and not a membership of an organization that refuses it.
    and private.session_refusal() is null
    and m.org_id <> all (array(select private.session_refused_org_ids()));
$$;

comment on function private.my_membership_ids() is 'Active memberships of the signed-in person. Leaves out the memberships of every organization that refuses the current session, and answers nothing for a session refused as a whole (ADR 0169 D6). With every session gate control off it answers as private.my_membership_ids_base.';
revoke all on function private.my_membership_ids() from public, anon;
grant execute on function private.my_membership_ids() to authenticated, service_role;

-- private.person_capability_reach -------------------------------------------------------------------------------------------

create or replace function private.person_capability_reach(p_person_id uuid, p_org_id uuid, p_capability text, p_include_delegations boolean)
returns app.capability_reach
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_person_id is null or p_org_id is null then
    return null;
  end if;
  -- ADR 0169 D6: the caller reaches nothing in an organization that refuses the current session, and nothing
  -- anywhere when the session is refused as a whole. The reach of another person is not the session's to change.
  if p_person_id = private.current_person_id()
     and private.session_org_refusal(p_org_id) is not null then
    return null;
  end if;
  -- A22-001: an API-key session reaches only the capability groups in the key's scopes.
  if p_person_id = private.current_person_id()
     and private.api_key_scopes() is not null
     and not (split_part(p_capability, '.', 1) = any (private.api_key_scopes())) then
    return null;
  end if;
  -- A99 (ADR 0055): an app's session reaches only the org that registered the app.
  if p_person_id = private.current_person_id()
     and private.oauth_client_id() is not null
     and p_org_id is distinct from private.oauth_org_id() then
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
      -- 1203: an open break-glass session (Section 8.4) reaches the Owner role's capabilities org-wide, while the
      -- membership is active. 1298 (A69-009): only for the holder themself, in a second-factor session that is not an
      -- API key, so it never reaches a delegate or another session of the holder.
      select 'organization'::app.capability_reach
      from app.break_glass_sessions b
      join app.memberships m on m.person_id = b.person_id and m.org_id = b.org_id
      join app.role_capabilities rc on rc.capability_code = p_capability and rc.deleted_at is null
        and rc.reach = 'organization'
        and rc.role_id = (select r.id from app.roles r where r.org_id is null and r.code = 'owner')
      where b.person_id = p_person_id and b.org_id = p_org_id and b.deleted_at is null
        and b.started_at <= now() and b.expires_at > now() and b.ended_at is null
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        and p_person_id = private.current_person_id()
        and private.session_aal() = 'aal2'
        and private.api_key_scopes() is null
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

comment on function private.person_capability_reach(uuid, uuid, text, boolean) is 'The widest reach a person holds for a capability in an org, through roles, direct grants, an organization record grant, the holder''s own open break-glass session at aal2, and delegations. For the signed-in person it is NULL in an organization that refuses the current session, and everywhere for a session refused as a whole (ADR 0169 D6); another person''s reach is not changed by the caller''s session. With every session gate control off it answers as private.person_capability_reach_base.';
revoke all on function private.person_capability_reach(uuid, uuid, text, boolean) from public, anon, authenticated;

-- The read policy on app.organizations ---------------------------------------------------------------------------------------

alter policy organizations_read on app.organizations
  using (
    id in (select private.my_org_ids_base())
    or id in (select private.orgs_with_capability('org.settings.read'))
    or parent_org_id in (select private.orgs_with_capability('org.partner.manage'))
  );

comment on policy organizations_read on app.organizations is 'A member reads the organizations they belong to, also when one of them refuses the current session (ADR 0169 D6: the ungated twin, so a refused session can still name its organization); the two capability branches follow the session gate.';

reset lock_timeout;
