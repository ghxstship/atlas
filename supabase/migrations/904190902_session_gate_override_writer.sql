-- The writer of support overrides (RRR-243; ADR 0169 D8, lockout recovery; release 4.19, block 09, part 2 of 2).
--
-- ADR 0169 D8: when a session rule locks an organization out (every Owner lost their authenticator, or an
-- allow-list that no Owner can reach from), support suspends one control for that organization for at most 24
-- hours. 904180201 built the table private.session_gate_overrides with its constraints, the verdict's reading of
-- it and the trigger that writes every override and every early end to the audit ledger; nothing could write a
-- row except the database owner by hand. This migration adds the two functions that do.
--
--   app.suspend_session_gate_control(org, control, actor, reason, hours)  writes the override and tells the Owners
--   app.end_session_gate_suspension(override, actor)                      ends it before it expires
--
-- Who may call them: the holder of the secret key and nobody else. Both are executable by service_role only, so
-- no session, API key or app token reaches them through the data endpoint, and the caller names the operator as
-- text (p_actor), because the secret key carries no person.
--
-- What the Owners are told: every Owner of the organization gets the notification
-- access.session_rule_suspended (notification-kinds.yaml, category account), which names the control, the reason
-- support wrote and when the suspension ends by itself. It is sent for the platform (actorPlatform, 904110801):
-- the operator's name stays in the audit ledger and is never stored on the notification.
--
-- What an override does and does not do (904180202): while it is in force the control reads as off for that
-- organization, whatever the organization's own mode or the global mode says. It cannot lift a session refused as
-- a whole, which follows the global mode of the signed-out control alone. One override suspends one control; a
-- second override of the same control for the same organization is refused while the first is in force.
--
-- Every control ships off (ADR 0169 D7), so on the day this migration lands an override changes no verdict:
-- there is nothing to suspend. The functions exist before the first control is enforced, as the ADR requires.
--
-- New functions only. No table, policy or existing function is changed.

create or replace function app.suspend_session_gate_control(p_org_id uuid, p_control text, p_actor text, p_reason text,
  p_hours integer default 24)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org text;
  v_actor text := btrim(coalesce(p_actor, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_until timestamptz;
  v_id uuid;
  v_owner uuid;
begin
  if p_control is null or p_control not in ('ended', 'mfa', 'lifetime', 'idle', 'network') then
    perform private.refuse('session_gate_control', 'Name the control to suspend: ended, mfa, lifetime, idle or network.');
  end if;
  if char_length(v_actor) not between 3 and 200 then
    perform private.refuse('session_gate_actor', 'Name the operator who suspends the control, in 3 to 200 characters.');
  end if;
  if char_length(v_reason) not between 20 and 1000 then
    perform private.refuse('session_gate_reason', 'Write why the control is suspended, in 20 to 1,000 characters. The organization''s Owners read it.');
  end if;
  if p_hours is null or p_hours not between 1 and 24 then
    perform private.refuse('session_gate_hours', 'A suspension lasts 1 to 24 hours.');
  end if;

  -- One writer at a time for an organization, so two operators cannot each see no override and both write one.
  select o.name into v_org from app.organizations o where o.id = p_org_id and o.deleted_at is null for update;
  if not found then
    perform private.refuse('session_gate_org', 'No such organization.');
  end if;

  select o.expires_at into v_until
  from private.session_gate_overrides o
  where o.org_id = p_org_id and o.control = p_control and o.ended_at is null
    and o.starts_at <= now() and o.expires_at > now()
  order by o.expires_at desc
  limit 1;
  if found then
    perform private.refuse('session_gate_override_open',
      'This control is already suspended for this organization. End that suspension first, or wait for it to expire.');
  end if;

  v_until := now() + make_interval(hours => p_hours);
  insert into private.session_gate_overrides (org_id, control, actor, reason, starts_at, expires_at)
  values (p_org_id, p_control, v_actor, v_reason, now(), v_until)
  returning id into v_id;

  -- The trigger of 904180201 wrote session_gate_overrides.started to the audit ledger. The Owners are told now.
  for v_owner in select private.org_owner_ids(p_org_id) loop
    perform private.notify(p_org_id, v_owner, 'access.session_rule_suspended', 'session_gate_overrides', v_id, null,
      jsonb_build_object('title', v_org, 'orgName', v_org, 'control', p_control, 'reason', v_reason,
        'until', to_char(v_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'actorPlatform', true));
  end loop;
  return v_id;
end;
$$;

comment on function app.suspend_session_gate_control(uuid, text, text, text, integer) is 'Support API (service role): suspends one session gate control (ended, mfa, lifetime, idle or network) for one organization for 1 to 24 hours, for lockout recovery (ADR 0169 D8). Takes the operator as text and a reason of 20 characters or more, which the organization''s Owners read. Writes private.session_gate_overrides, which the audit ledger records, and notifies every Owner (access.session_rule_suspended). Refuses a second suspension of a control that is already suspended. Returns the override id.';
revoke all on function app.suspend_session_gate_control(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function app.suspend_session_gate_control(uuid, text, text, text, integer) to service_role;

create or replace function app.end_session_gate_suspension(p_override_id uuid, p_actor text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor text := btrim(coalesce(p_actor, ''));
  v_org uuid;
begin
  if char_length(v_actor) not between 3 and 200 then
    perform private.refuse('session_gate_actor', 'Name the operator who ends the suspension, in 3 to 200 characters.');
  end if;
  update private.session_gate_overrides o
  set ended_at = now()
  where o.id = p_override_id and o.ended_at is null and o.expires_at > now()
  returning o.org_id into v_org;
  if not found then
    return false;
  end if;
  -- The trigger of 904180201 wrote session_gate_overrides.ended with the operator who started the suspension. This
  -- names the operator who ended it.
  perform private.write_audit_event(v_org, 'session_gate_overrides.ended_by', 'private.session_gate_overrides', p_override_id,
    jsonb_build_object('actor', v_actor));
  return true;
end;
$$;

comment on function app.end_session_gate_suspension(uuid, text) is 'Support API (service role): ends a suspension written by app.suspend_session_gate_control before it expires, so the control is in force again on the next request (ADR 0169 D8). Takes the operator as text; the audit ledger records the end and who ended it. Returns false when the override does not exist, was already ended or has expired.';
revoke all on function app.end_session_gate_suspension(uuid, text) from public, anon, authenticated;
grant execute on function app.end_session_gate_suspension(uuid, text) to service_role;
