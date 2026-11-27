-- Break-glass stays reachable by a session an organization refuses (RRR-243; ADR 0169 D2 and D8; release 4.19,
-- block 09, part 3).
--
-- ADR 0169 D8: break-glass at aal2 from outside the allow-list is honored inside the verdict, and its start
-- function is reachable by a refused session (it is on private.session_gate_open_functions). app.start_break_glass
-- (1203) checked org.break_glass.use through private.has_capability. Since 904190901 that reach follows the session
-- gate, so an Owner outside the listed networks would be told the capability is missing and could not take the
-- emergency access that lifts the allow-list for them. The check now reads the ungated twin,
-- private.person_capability_reach_base, as the gate's other recovery functions do (ADR 0169 D6: the twins serve the
-- recovery functions).
--
-- A session refused as a whole by the signed-out control is refused here with session_ended, as
-- private.require_second_factor refuses it: the twin would otherwise let a signed-out token at aal2 take emergency
-- access.
--
-- With every control off the two checks answer exactly as before: private.has_capability without a scope is true
-- exactly when the reach is organization, which is what the twin answers while no control refuses, and
-- private.session_ended_refused() is false. The rest of the body is 1203's, unchanged. Nothing switches a control.
--
-- One function replacement; its comment and grants (1203) are kept.

create or replace function app.start_break_glass(p_org_id uuid, p_reason text)
returns app.break_glass_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_session app.break_glass_sessions;
  v_recipient uuid;
  v_actor text;
  v_org text;
begin
  if private.api_key_scopes() is not null then
    perform private.refuse('break_glass_session_only', 'Emergency access is taken in a signed-in session, never with an API key.');
  end if;
  -- ADR 0169 D1: a signed-out session cannot take emergency access.
  if private.session_ended_refused() then
    perform private.refuse('session_ended', 'This session was signed out. Sign in again to take emergency access.');
  end if;
  -- ADR 0169 D8: the ungated reach, so an organization that refuses the session does not hide the capability that
  -- recovers from that refusal.
  if private.person_capability_reach_base(v_person, p_org_id, 'org.break_glass.use', true) is distinct from 'organization' then
    raise exception using errcode = '42501', message = 'org.break_glass.use is required';
  end if;
  if private.session_aal() <> 'aal2' then
    perform private.refuse('step_up_required', 'Verify with your second factor before taking emergency access.');
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 20 then
    perform private.refuse('break_glass_reason', 'Write why you need emergency access, in at least 20 characters.');
  end if;
  perform 1 from app.organizations o where o.id = p_org_id for update;
  if private.break_glass_active(v_person, p_org_id) then
    perform private.refuse('break_glass_open', 'You already hold emergency access in this org.');
  end if;

  insert into app.break_glass_sessions (org_id, person_id, reason, started_at, expires_at)
  values (p_org_id, v_person, btrim(p_reason), now(), now() + interval '1 hour')
  returning * into v_session;

  perform private.write_audit_event(p_org_id, 'break_glass_sessions.started', 'app.break_glass_sessions', v_session.id,
    jsonb_build_object('person_id', v_person, 'expires_at', v_session.expires_at, 'reason', v_session.reason));

  select coalesce(p.full_name, 'An Owner') into v_actor from app.people p where p.id = v_person;
  select o.name into v_org from app.organizations o where o.id = p_org_id;
  for v_recipient in
    select distinct m.person_id
    from app.memberships m
    join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
    join app.roles r on r.id = mr.role_id and r.org_id is null and r.code in ('owner', 'admin')
    where m.org_id = p_org_id and m.person_id <> v_person and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  loop
    perform private.notify(p_org_id, v_recipient, 'access.break_glass_started', 'break_glass_sessions', v_session.id, null,
      jsonb_build_object('title', v_org, 'orgName', v_org, 'actorName', v_actor, 'reason', v_session.reason));
  end loop;
  return v_session;
end;
$$;
