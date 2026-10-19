-- 1203_break_glass_sessions.sql
-- A52 settings features (RRR-97, ADR 0032 amendment). Section 8.4: "an Owner can take emergency full access for one hour.
-- It requires MFA and a written reason, notifies every Admin, and is logged." Section 4.5.6 item 10 lists break-glass on
-- the Security page and Section 7.3 names break_glass_sessions. A50 retired breakGlassSessions because nothing enforced it.
--   * app.start_break_glass opens a session for the signed-in person: they need org.break_glass.use (the Owner role), a
--     session that passed a second factor (aal2, not an API key), a written reason of at least 20 characters, and no other
--     open session in the org. The session lasts exactly one hour; app.end_break_glass ends it early.
--   * Every Owner and Admin other than the holder gets an urgent account notification, and the start and the end are written
--     to the audit ledger (the table also carries the audit trail).
--   * While open, the session gives the holder emergency full access: every capability the Owner system role holds, at
--     organization reach, whatever roles they hold now (private.person_capability_reach), and it lets them past the org's
--     IP allow-list (app.network_access), so an Owner locked out of the org can still reach it.
--   * Sessions are a ledger: signed-in callers cannot insert or change them; only the two RPCs write them.

create table app.break_glass_sessions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  reason text not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  deleted_at timestamptz,
  constraint break_glass_sessions_reason_length check (char_length(btrim(reason)) between 20 and 2000),
  constraint break_glass_sessions_one_hour check (expires_at = started_at + interval '1 hour'),
  constraint break_glass_sessions_ended check (ended_at is null or ended_at between started_at and expires_at)
);

create index break_glass_sessions_person_org_idx on app.break_glass_sessions (person_id, org_id, expires_at);

call private.install_domain_table('app.break_glass_sessions');
call private.describe('app.break_glass_sessions', 'Emergency full access an Owner took for one hour with a second factor and a written reason (Section 8.4). Every Owner and Admin is notified and the audit ledger records the start and end. Written only by app.start_break_glass and app.end_break_glass.', array[
  'person_id', 'Owner who took emergency access, from the session.',
  'reason', 'Written reason, 20 to 2000 characters.',
  'started_at', 'When emergency access began.',
  'expires_at', 'When it ends on its own: one hour after it began.',
  'ended_at', 'When the holder ended it early; NULL when it ran its hour.'
]);

call private.install_policies('app.break_glass_sessions',
  $$org_id in (select private.orgs_with_capability('audit.log.read')) or person_id = private.current_person_id()$$);

call private.install_default_retention('app.break_glass_sessions');
call private.install_audit_trail('app.break_glass_sessions');

create or replace function private.break_glass_active(p_person_id uuid, p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.break_glass_sessions b
    where b.person_id = p_person_id and b.org_id = p_org_id and b.deleted_at is null
      and b.started_at <= now() and b.expires_at > now() and b.ended_at is null);
$$;

comment on function private.break_glass_active(uuid, uuid) is 'True while the person holds an open break-glass session in the org.';
revoke all on function private.break_glass_active(uuid, uuid) from public, anon, authenticated;

-- Notification kind ------------------------------------------------------------------------------------------------------

insert into private.notification_templates (kind, channel, category_code, email_template_code)
select 'access.break_glass_started', c.channel, 'account', case when c.channel = 'Email' then 'notification' end
from (values ('In App'::app.notification_channel), ('Email'), ('SMS'), ('Push')) as c (channel)
on conflict do nothing;

-- RPCs -----------------------------------------------------------------------------------------------------------------------

create or replace function app.start_break_glass(p_org_id uuid, p_reason text)
returns app.break_glass_sessions
language plpgsql
volatile
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
  if not private.has_capability(p_org_id, 'org.break_glass.use') then
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

comment on function app.start_break_glass(uuid, text) is 'Takes one hour of emergency full access in an org (Section 8.4): needs org.break_glass.use, a second-factor session (aal2, never an API key), a reason of at least 20 characters and no open session. Notifies every other Owner and Admin and writes the audit ledger. Returns the session.';
revoke all on function app.start_break_glass(uuid, text) from public, anon;
grant execute on function app.start_break_glass(uuid, text) to authenticated, service_role;

create or replace function app.end_break_glass(p_session_id uuid)
returns app.break_glass_sessions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_session app.break_glass_sessions;
begin
  select * into v_session from app.break_glass_sessions b where b.id = p_session_id and b.deleted_at is null for update;
  if v_session.id is null or v_session.person_id <> v_person then
    raise exception using errcode = '42501', message = 'only the holder ends their emergency access';
  end if;
  if v_session.ended_at is not null or v_session.expires_at <= now() then
    perform private.refuse('break_glass_closed', 'This emergency access has already ended.');
  end if;
  perform private.begin_trusted_operation('break_glass_end');
  update app.break_glass_sessions b set ended_at = now() where b.id = v_session.id returning * into v_session;
  perform private.end_trusted_operation('break_glass_end');
  perform private.write_audit_event(v_session.org_id, 'break_glass_sessions.ended', 'app.break_glass_sessions', v_session.id,
    jsonb_build_object('person_id', v_person, 'ended_at', v_session.ended_at));
  return v_session;
end;
$$;

comment on function app.end_break_glass(uuid) is 'Ends the caller''s own open break-glass session before its hour is up, and writes the audit ledger.';
revoke all on function app.end_break_glass(uuid) from public, anon;
grant execute on function app.end_break_glass(uuid) to authenticated, service_role;

create or replace function private.guard_break_glass_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and private.in_trusted_operation('break_glass_end')
     and new.ended_at is not null and old.ended_at is null
     and (to_jsonb(new) - array['ended_at', 'updated_at', 'updated_by']) = (to_jsonb(old) - array['ended_at', 'updated_at', 'updated_by']) then
    return new;
  end if;
  if tg_op = 'UPDATE' and auth.uid() is not null then
    perform private.refuse('break_glass_ledger', 'Emergency access is a ledger: it ends through app.end_break_glass and never changes otherwise.');
  end if;
  return new;
end;
$$;

comment on function private.guard_break_glass_session() is 'Break-glass sessions change only by app.end_break_glass setting ended_at; anything else a signed-in caller tries is refused.';
revoke all on function private.guard_break_glass_session() from public, anon, authenticated;

create trigger t40_guard_break_glass_session before update on app.break_glass_sessions
  for each row execute function private.guard_break_glass_session();

-- Enforcement: emergency full access -------------------------------------------------------------------------------------
-- 0936's person_capability_reach, with one more branch: an open break-glass session reaches every capability the Owner
-- system role holds, at organization reach. API-key scopes still apply first.

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
      -- membership is active.
      select 'organization'::app.capability_reach
      from app.break_glass_sessions b
      join app.memberships m on m.person_id = b.person_id and m.org_id = b.org_id
      join app.role_capabilities rc on rc.capability_code = p_capability and rc.deleted_at is null
        and rc.reach = 'organization'
        and rc.role_id = (select r.id from app.roles r where r.org_id is null and r.code = 'owner')
      where b.person_id = p_person_id and b.org_id = p_org_id and b.deleted_at is null
        and b.started_at <= now() and b.expires_at > now() and b.ended_at is null
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
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

-- Enforcement: past the IP allow-list ------------------------------------------------------------------------------------

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
  return query select private.ip_allowlist_enforced(p_org_id),
    private.ip_allowed(p_org_id, v_ip) or private.break_glass_active(private.current_person_id(), p_org_id),
    (v_ip is not null and exists (select 1 from app.org_ip_allowlist a
                                  where a.org_id = p_org_id and a.deleted_at is null and v_ip <<= a.cidr));
end;
$$;

comment on function app.network_access(uuid, text) is 'Whether the given client address may reach one of the caller''s orgs (Section 9 IP allow-list): enforced says whether the org enforces its list, allowed whether the caller passes (an address inside the list, or an open break-glass session of the caller, 1203), and covered whether a listed network contains the address (so turning enforcement on would keep the caller in). Answers only for orgs the caller belongs to (no row otherwise). The public API runtime and Atlas call it with the address their proxy reports.';
