-- The functions the apps read, reworked to answer from the session verdict, and the second-factor guard on the
-- policy that asks for one (RRR-243; ADR 0169 work package 2, the gate core; release 4.18, block 02, part 4 of 4).
--
-- With every control off, as 904180201 ships them, each function here answers exactly as before: the existing
-- columns are computed as they were, the new columns read as passing, and no call is refused that was not refused
-- before.
--
--   private.stamp_session_activity   new. Records an activity of the caller's session and, from a verified
--                                    attestation only, its network pass (ADR 0169 D4 and D5). The pass is dated
--                                    when the server signed the attestation, so it ends five minutes after the
--                                    server saw the address however late or often the attestation is presented,
--                                    and an older attestation never replaces a newer pass. A stamp never waits:
--                                    it reads the row without a lock, returns when there is nothing to write,
--                                    and writes only under an advisory lock it tries for.
--   app.touch_my_session             redefined from 1561_signed_in_sessions.sql, its only definition, every behavior
--                                    kept. It gains p_attestation (the signed argument of ADR 0169 D4) and stamps the
--                                    session's activity. A fifth parameter changes the signature, so the function is
--                                    dropped and created again with its grants; a call with the four old arguments
--                                    resolves to it.
--   app.my_org_auth_status           redefined from 1561_signed_in_sessions.sql, its latest definition (1330 before
--                                    it), every column kept as it was. It gains idle, network_allowed and
--                                    blocked_reason from the verdict. New output columns change the return type, so
--                                    it is dropped and created again with its grants.
--   app.network_access               redefined from 1298_break_glass_second_factor.sql, its latest definition (1201
--                                    and 1203 before it), every column kept as it was. It gains network_allowed and
--                                    blocked_reason from the verdict, and names the caller's organizations through
--                                    private.my_org_ids_base, so a refused session still gets its answer. Dropped
--                                    and created again for the new return type, with its grants.
--   app.my_session_gate              new. Each of the caller's organizations by name, and why it is closed. It
--                                    asks for the verdict once, however many organizations there are.
--   private.require_second_factor    redefined from 1333_require_second_factor.sql, its only definition, every
--                                    behavior kept. Where the signed-out control refuses the session it now refuses
--                                    session_ended: a session without a live auth.sessions row cannot step up.
--   private.guard_mfa_policy_setter  new, with trigger t45 on app.setting_values: turning security.mfa_policy to
--                                    admins or everyone needs the setter's own session at aal2 (ADR 0169 D8), in an
--                                    organization where the second-factor control is in observe or enforce.
--
-- Locks: the trigger on app.setting_values is created under lock_timeout.

set lock_timeout = '5s';

-- Recorded activity and the network pass ----------------------------------------------------------------------------------

create or replace function private.stamp_session_activity(p_attestation text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_session uuid := private.session_id();
  v_created timestamptz;
  v_refreshed timestamptz;
  v_verified boolean := false;
  v_address inet;
  v_signed_at timestamptz;
  v_pass_at timestamptz;
  v_last_activity timestamptz;
  v_stored_address inet;
  v_stored_pass_at timestamptz;
begin
  if v_user is null or v_session is null or private.api_key_scopes() is not null
     or current_setting('transaction_read_only', true) = 'on' then
    return;
  end if;
  select s.created_at, greatest(s.updated_at, s.refreshed_at at time zone 'UTC') into v_created, v_refreshed
  from auth.sessions s
  where s.id = v_session and s.user_id = v_user and (s.not_after is null or s.not_after > now());
  if not found then
    return;
  end if;
  -- The pass is written from a verified attestation only: the signed argument, or the header our servers send. It is
  -- dated when the server signed it, never later than now, so a pass ends five minutes after the server saw the
  -- address, not five minutes after the attestation was last presented.
  select a.verified, a.client_address, a.signed_at into v_verified, v_address, v_signed_at
  from private.verify_attestation(coalesce(p_attestation, private.request_header('x-xos-attestation')), v_user, v_session) a;
  v_verified := coalesce(v_verified, false) and v_address is not null and v_signed_at is not null;
  v_pass_at := case when v_verified then least(now(), v_signed_at) end;

  -- Nothing to write: the last recorded activity is under a minute old, and the attestation is absent, older than
  -- the stored pass, or under a minute newer at the same address. This read takes no lock, so the requests of one
  -- session inside a minute do not touch each other.
  select st.last_activity_at, st.pass_address, st.pass_at into v_last_activity, v_stored_address, v_stored_pass_at
  from private.session_state st
  where st.session_id = v_session;
  if found and v_last_activity >= now() - interval '1 minute'
     and not (v_verified and (v_stored_pass_at is null or v_stored_pass_at < v_pass_at - interval '1 minute'
                              or (v_stored_address is distinct from v_address and v_stored_pass_at < v_pass_at))) then
    return;
  end if;
  -- One request at a time writes the session's row, and the others do not wait for it: the request that holds the
  -- lock records the same activity. The advisory lock covers the session's first stamp as well, where two inserts
  -- would wait on each other at the primary key.
  if not pg_try_advisory_xact_lock(private.session_gate_lock_key('stamp', v_session::text)) then
    return;
  end if;

  insert into private.session_state as st (session_id, last_activity_at, longest_gap, pass_address, pass_at)
  values (v_session, now(),
          private.session_idle_span(v_created, v_refreshed, null, interval '0', now()),
          case when v_verified then v_address end, v_pass_at)
  on conflict (session_id) do update
    set longest_gap = private.session_idle_span(v_created, v_refreshed, st.last_activity_at, st.longest_gap, now()),
        last_activity_at = now(),
        pass_address = case when v_verified and (st.pass_at is null or st.pass_at < v_pass_at) then v_address else st.pass_address end,
        pass_at = case when v_verified and (st.pass_at is null or st.pass_at < v_pass_at) then v_pass_at else st.pass_at end
    where st.last_activity_at < now() - interval '1 minute'
       or (v_verified and (st.pass_at is null or st.pass_at < v_pass_at - interval '1 minute'
                           or (st.pass_address is distinct from v_address and st.pass_at < v_pass_at)));
end;
$$;

comment on function private.stamp_session_activity(text) is 'Records an activity of the caller''s own live session in private.session_state (ADR 0169 D5), folding the time since the last one into the longest gap, and renews the session''s network pass when the call carries a verified attestation with an address, as the argument or as the request header (ADR 0169 D4). The pass is dated when the server signed the attestation and never later than now, and only a newer attestation replaces it, so replaying an attestation neither extends a pass nor moves it back to an earlier address. Writes at most once a minute unless a newer attestation names another address, and nothing on a read-only transaction, for an API key, an app or a session that is gone. It never waits on another request of the same session: it returns without a lock when there is nothing to write, and skips the write when another request is making it. app.touch_my_session and the PostgREST pre-request call it.';
revoke all on function private.stamp_session_activity(text) from public, anon, authenticated;

-- Recording the device, the activity and the pass -------------------------------------------------------------------------

drop function if exists app.touch_my_session(text, text, text, text);

create or replace function app.touch_my_session(p_surface text, p_client_address text, p_place text, p_user_agent text,
  p_attestation text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_session uuid := private.session_id();
  v_address inet := private.safe_inet(p_client_address);
  v_place text := private.clean_label(p_place, 120);
  v_agent text := private.clean_label(p_user_agent, 512);
begin
  if v_user is null or v_session is null or private.api_key_scopes() is not null
     or p_surface is null or p_surface not in ('Atlas', 'Gateway', 'Compass', 'API') then
    return;
  end if;
  if not exists (select 1 from auth.sessions s where s.id = v_session and s.user_id = v_user) then
    return;
  end if;
  insert into private.session_devices as d (session_id, user_id, surface, client_address, place, user_agent)
  values (v_session, v_user, p_surface, v_address, v_place, v_agent)
  on conflict (session_id) do update
    set surface = excluded.surface,
        client_address = coalesce(excluded.client_address, d.client_address),
        place = case when excluded.client_address is null then d.place else excluded.place end,
        user_agent = coalesce(excluded.user_agent, d.user_agent),
        last_seen_at = now()
    where d.last_seen_at < now() - interval '1 minute'
       or d.surface is distinct from excluded.surface
       or (excluded.client_address is not null and d.client_address is distinct from excluded.client_address)
       or (excluded.user_agent is not null and d.user_agent is distinct from excluded.user_agent);
  perform private.stamp_session_activity(p_attestation);
end;
$$;

comment on function app.touch_my_session(text, text, text, text, text) is 'Records the device behind the caller''s own session (from the JWT): the surface (Atlas, Gateway, Compass or API), the client address read behind the trusted proxies, the approximate place and the user agent. Writes at most once a minute unless something changed; ignores API keys, apps and unknown sessions. It also counts as an activity of the session for the idle timeout and, when p_attestation or the request header carries a verified server attestation, renews the session''s five-minute network pass at the attested address, never at p_client_address (ADR 0169 D4 and D5).';
revoke all on function app.touch_my_session(text, text, text, text, text) from public, anon;
grant execute on function app.touch_my_session(text, text, text, text, text) to authenticated;

-- What an org asks of the caller's session ---------------------------------------------------------------------------------

drop function if exists app.my_org_auth_status(uuid);

create function app.my_org_auth_status(p_org_id uuid)
returns table (
  mfa_required boolean,
  mfa_verified boolean,
  signed_in_at timestamptz,
  session_hours integer,
  session_expires_at timestamptz,
  session_expired boolean,
  idle_timeout_minutes integer,
  session_ended boolean,
  idle boolean,
  network_allowed boolean,
  blocked_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_hours integer;
  v_signed_in timestamptz;
  v_session uuid := private.session_id();
  v_verdict jsonb;
  v_reasons jsonb;
  v_blocked text;
begin
  if v_person is null or not exists (
      select 1 from app.memberships m
      where m.org_id = p_org_id and m.person_id = v_person and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    return;
  end if;
  -- ADR 0169: the three new columns come from the session verdict and read as passing while every control is off.
  v_verdict := private.session_verdict();
  v_reasons := coalesce(v_verdict -> 'orgs' -> p_org_id::text, '[]'::jsonb);
  v_blocked := coalesce(v_verdict ->> 'session', v_reasons ->> 0);
  if private.api_key_scopes() is not null then
    -- A machine credential or an app: no second factor and no sign-in to age. The allow-list binds it.
    return query select false, false, null::timestamptz, null::integer, null::timestamptz, false, null::integer, false,
      false, not (v_reasons ? 'network_restricted'), v_blocked;
    return;
  end if;
  v_hours := coalesce(private.org_setting_integer(p_org_id, 'security.session_hours'), 336)::integer;
  v_signed_in := private.session_signed_in_at();
  return query select
    private.mfa_required(v_person, p_org_id),
    private.session_aal() = 'aal2',
    v_signed_in,
    v_hours,
    v_signed_in + make_interval(hours => v_hours),
    coalesce(v_signed_in + make_interval(hours => v_hours) <= now(), false),
    coalesce(private.org_setting_integer(p_org_id, 'security.idle_timeout_minutes'), 60)::integer,
    v_session is not null and not exists (
      select 1 from auth.sessions s
      where s.id = v_session and s.user_id = (select auth.uid()) and (s.not_after is null or s.not_after > now())),
    v_reasons ? 'session_idle',
    not (v_reasons ? 'network_restricted'),
    v_blocked;
end;
$$;

comment on function app.my_org_auth_status(uuid) is 'What an org asks of the caller''s session (Section 9), for the Atlas proxy, the API runtime and Compass: whether security.mfa_policy requires a second factor for the caller''s roles and whether the session passed one (aal2), when it signed in, security.session_hours and whether that lifetime is over, security.idle_timeout_minutes, and whether the session was signed out (session_ended: its auth.sessions row is gone). From the session verdict (ADR 0169): idle (the idle timeout refuses the session), network_allowed (false when the allow-list refuses it) and blocked_reason (the reason the org is closed to the session, or NULL); the three read as passing while their controls are off. No row when the caller holds no active membership. API keys and OAuth apps are exempt from all but the allow-list.';
revoke all on function app.my_org_auth_status(uuid) from public, anon;
grant execute on function app.my_org_auth_status(uuid) to authenticated;

-- What Atlas and the API ask about the network -----------------------------------------------------------------------------

drop function if exists app.network_access(uuid, text);

create function app.network_access(p_org_id uuid, p_ip text)
returns table (enforced boolean, allowed boolean, covered boolean, network_allowed boolean, blocked_reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ip inet;
  v_verdict jsonb;
  v_reasons jsonb;
begin
  if p_org_id is null or not (p_org_id in (select private.my_org_ids_base())) then
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
  v_verdict := private.session_verdict();
  v_reasons := coalesce(v_verdict -> 'orgs' -> p_org_id::text, '[]'::jsonb);
  return query select private.ip_allowlist_enforced(p_org_id),
    private.ip_allowed(p_org_id, v_ip) or private.break_glass_reaches_me(p_org_id),
    (v_ip is not null and exists (select 1 from app.org_ip_allowlist a
                                  where a.org_id = p_org_id and a.deleted_at is null and v_ip <<= a.cidr)),
    not (v_reasons ? 'network_restricted'),
    coalesce(v_verdict ->> 'session', v_reasons ->> 0);
end;
$$;

comment on function app.network_access(uuid, text) is 'Whether the given client address may reach one of the caller''s orgs (Section 9 IP allow-list): enforced says whether the org enforces its list, allowed whether the caller passes (an address inside the list, or the caller''s own open break-glass session used from a second-factor session, 1203 and 1298), and covered whether a listed network contains the address (so turning enforcement on would keep the caller in). From the session verdict (ADR 0169): network_allowed (false when the allow-list refuses this session at the address the database itself established: the attestation, the network pass or the edge) and blocked_reason (the reason the org is closed to the session, or NULL); both read as passing while their controls are off. Answers only for orgs the caller belongs to (no row otherwise), also for a session an org refuses. The public API runtime and Atlas call it with the address their proxy reports.';
revoke all on function app.network_access(uuid, text) from public, anon;
grant execute on function app.network_access(uuid, text) to authenticated, service_role;

-- Which organization refuses the session, and why ---------------------------------------------------------------------------

create or replace function app.my_session_gate()
returns table (org_id uuid, org_name text, closed boolean, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  -- The verdict is read once, and each organization's reason is taken from it as private.session_org_refusal gives
  -- it. Asking that reader for each organization computes the whole verdict each time when none is stored.
  with verdict as materialized (select private.session_verdict() as j)
  select o.id, o.name,
         coalesce(v.j ->> 'session', v.j -> 'orgs' -> o.id::text ->> 0) is not null,
         coalesce(v.j ->> 'session', v.j -> 'orgs' -> o.id::text ->> 0)
  from verdict v
  cross join app.organizations o
  where o.id in (select private.my_org_ids_base())
  order by o.name, o.id;
$$;

comment on function app.my_session_gate() is 'Each organization the caller belongs to, by name, with whether it is closed to the caller''s session and why (ADR 0169 D2): session_ended, session_expired, session_idle, session_mfa_required or network_restricted, the strongest reason first. A refused session can still call it, so Atlas, Gateway and Compass can say which organization refuses and what to do. Nothing is closed while every control is off. The verdict is decided once for the call, however many organizations the caller belongs to.';
revoke all on function app.my_session_gate() from public, anon;
grant execute on function app.my_session_gate() to authenticated;

-- The one step-up check -----------------------------------------------------------------------------------------------------

create or replace function private.require_second_factor(p_action text, p_recent boolean default true)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.api_key_scopes() is not null then
    perform private.refuse('step_up_session_only', format('%s needs a signed-in session, never an API key.', p_action));
  end if;
  -- ADR 0169 D1: where the signed-out control refuses the session, it has no live session row and cannot step up.
  if private.session_ended_refused() then
    perform private.refuse('session_ended', format('This session was signed out. Sign in again to %s.', p_action));
  end if;
  if private.session_aal() is distinct from 'aal2'
     or (p_recent and coalesce(private.second_factor_at() > now() - private.reverify_window(), false) is false) then
    perform private.refuse('step_up_required', format('Confirm it is you with your second factor to %s.', p_action));
  end if;
end;
$$;

comment on function private.require_second_factor(text, boolean) is 'The one step-up check (A77): refuses step_up_session_only for an API key, session_ended where the signed-out control of the session gate refuses the session (ADR 0169), and step_up_required unless the session is aal2 and, when p_recent (the default), passed a second factor within private.reverify_window(). p_action names the action in the refusal, for example "delete the organization".';
revoke all on function private.require_second_factor(text, boolean) from public, anon, authenticated;

-- Asking everyone for a second factor needs one ---------------------------------------------------------------------------

create or replace function private.guard_mfa_policy_setter()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null and new.scope_kind = 'Organization'
     and coalesce(new.value_text, 'optional') <> 'optional'
     and (tg_op = 'INSERT' or old.deleted_at is not null or old.value_text is distinct from new.value_text)
     and (select auth.uid()) is not null
     and private.session_gate_mode(new.org_id, 'mfa') <> 'off' then
    perform private.require_second_factor('require a second factor in this organization', false);
  end if;
  return new;
end;
$$;

comment on function private.guard_mfa_policy_setter() is 'Before trigger on app.setting_values for security.mfa_policy (ADR 0169 D8): in an organization where the second-factor control of the session gate is in observe or enforce, a person who turns the policy to admins or everyone must do so from a second-factor (aal2) session, so at least one Owner holds a working factor before the database starts refusing sessions without one. Platform processes are not asked.';
revoke all on function private.guard_mfa_policy_setter() from public, anon, authenticated;

drop trigger if exists t45_guard_mfa_policy_setter on app.setting_values;
create trigger t45_guard_mfa_policy_setter before insert or update on app.setting_values
  for each row when (new.setting_key = 'security.mfa_policy')
  execute function private.guard_mfa_policy_setter();

reset lock_timeout;
