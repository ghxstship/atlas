-- 1298_break_glass_second_factor.sql
-- A69 security review (RRR-114), finding A69-009. Break-glass (1203) asked for a second factor only to start. The
-- emergency reach was keyed on the person, so for the whole hour:
--   * any session of the holder reached the Owner role's capabilities and passed the IP allow-list, including a
--     password-only (aal1) session on another device, which is exactly what a stolen password gives;
--   * anyone holding a delegation from the holder inherited it, because the delegation branch of
--     private.person_capability_reach asks for the delegator's reach, and that included the break-glass branch;
--   * a session that ran its hour left no event in the audit ledger, only the early end did.
-- Fixes:
--   * the break-glass branch of private.person_capability_reach applies only to the signed-in holder themself, in a
--     second-factor (aal2) session that is not an API key, so it never flows through a delegation or to another
--     session of the holder;
--   * app.network_access lets the holder past the allow-list only in such a session;
--   * private.audit_expired_break_glass writes break_glass_sessions.expired for every session that ran its hour, every
--     five minutes, so the ledger shows the start, the early end or the expiry of each session.
-- The capability reach is otherwise 1203's, unchanged.

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

create or replace function private.break_glass_reaches_me(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.session_aal() = 'aal2' and private.api_key_scopes() is null
    and private.break_glass_active(private.current_person_id(), p_org_id);
$$;

comment on function private.break_glass_reaches_me(uuid) is 'True while the signed-in person holds an open break-glass session in the org and calls in a second-factor (aal2) session that is not an API key; only then does the session lift the IP allow-list (A69-009).';
revoke all on function private.break_glass_reaches_me(uuid) from public, anon, authenticated;

create or replace function app.network_access(p_org_id uuid, p_ip text)
returns table (enforced boolean, allowed boolean, covered boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ip inet;
begin
  if p_org_id is null or not (p_org_id in (select private.my_org_ids())) then
    return;
  end if;
  begin
    v_ip := nullif(btrim(coalesce(p_ip, '')), '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;
  -- An IPv4 client behind a dual-stack proxy arrives as ::ffff:a.b.c.d; compare it as IPv4.
  if v_ip is not null and family(v_ip) = 6 and host(v_ip) ~ '^::ffff:[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$' then
    v_ip := substr(host(v_ip), 8)::inet;
  end if;
  return query select private.ip_allowlist_enforced(p_org_id),
    private.ip_allowed(p_org_id, v_ip) or private.break_glass_reaches_me(p_org_id),
    (v_ip is not null and exists (select 1 from app.org_ip_allowlist a
                                  where a.org_id = p_org_id and a.deleted_at is null and v_ip <<= a.cidr));
end;
$$;

comment on function app.network_access(uuid, text) is 'Whether the given client address may reach one of the caller''s orgs (Section 9 IP allow-list): enforced says whether the org enforces its list, allowed whether the caller passes (an address inside the list, or the caller''s own open break-glass session used from a second-factor session, 1203 and 1298), and covered whether a listed network contains the address (so turning enforcement on would keep the caller in). Answers only for orgs the caller belongs to (no row otherwise). The public API runtime and Atlas call it with the address their proxy reports.';
revoke all on function app.network_access(uuid, text) from public, anon;
grant execute on function app.network_access(uuid, text) to authenticated, service_role;

-- The natural end of a session in the audit ledger ------------------------------------------------------------------------

create or replace function private.audit_expired_break_glass()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session record;
  v_count integer := 0;
begin
  for v_session in
    select b.id, b.org_id, b.person_id, b.expires_at from app.break_glass_sessions b
    where b.ended_at is null and b.deleted_at is null and b.expires_at <= now() and b.expires_at > now() - interval '7 days'
      and not exists (select 1 from app.audit_events e where e.subject_id = b.id and e.action = 'break_glass_sessions.expired')
  loop
    perform private.write_audit_event(v_session.org_id, 'break_glass_sessions.expired', 'app.break_glass_sessions', v_session.id,
      jsonb_build_object('person_id', v_session.person_id, 'expired_at', v_session.expires_at));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function private.audit_expired_break_glass() is 'Writes break_glass_sessions.expired to the audit ledger once for every break-glass session that ran its hour without being ended early (A69-009). Run every five minutes by pg_cron; returns how many it wrote.';
revoke all on function private.audit_expired_break_glass() from public, anon, authenticated;

select cron.schedule('xos_audit_expired_break_glass', '*/5 * * * *', $$select private.audit_expired_break_glass()$$);
