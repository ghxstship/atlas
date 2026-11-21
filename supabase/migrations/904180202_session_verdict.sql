-- The session verdict and its readers (RRR-243; ADR 0169 work package 2, the gate core; release 4.18, block 02,
-- part 2 of 4).
--
-- private.session_verdict_compute is the single place the gate's rules are decided (ADR 0169 D1). For the token on
-- the request it answers whether the session is refused as a whole and which organizations refuse it and why. Its
-- inputs are the standard claims (aal, amr, session_id), the auth.sessions row, the session's row in
-- private.session_state and one row of private.org_session_rules for each organization the person belongs to.
-- Nothing else decides a refusal: the readers below, the status functions of 904180204 and the later packages
-- (the helpers, the PostgREST pre-request, the Storage and Realtime policies) all read this one answer.
--
-- Every control ships off (904180201), and with every control off the verdict is empty after one single-row read.
--
-- The verdict is jsonb:
--   {"v": 1, "token": "session" | "api_key" | "app" | "worker" | "none",
--    "session": null | "session_ended",
--    "orgs": {"<organization id>": ["<reason>", ...]},      organizations that refuse, strongest reason first
--    "observed": [{"org": "<organization id>" | null, "control": "...", "reason": "..."}]}
--
-- Reasons, strongest first: session_ended, session_expired, session_idle, session_mfa_required, network_restricted.
--
-- Who is skipped: a request with no token, service_role, anon, and a worker token (claim xos_origin = worker). A
-- person who is no member of an organization is judged by the signed-out rule alone.
--
-- Tokens that are not sessions (ADR 0169 D1, and "What package 1 hands to the packages after it", item 2): an
-- API-key or personal API token is known by the amr method xos_api_key and by nothing else, and that test runs
-- before the rule that refuses a token with no amr timestamp, so a key token with timestamp 0 or with none is
-- exempt from the signed-out, second-factor, lifetime and idle rules. The allow-list binds it. An OAuth app token
-- (claim client_id) is exempt from the second-factor, lifetime and idle rules, needs a live session row, and is
-- bound by the allow-list in the one organization it reaches. The app_mfa rule is not built (904180201).
--
-- Missing claims fail closed once a control is on: a person's session token with no session_id, no amr timestamp
-- or no live auth.sessions row is signed out; with the lifetime control on and no amr timestamp it is expired; with
-- the idle control on and no live row it is idle; a token with no aal is not aal2.
--
-- The caller's address (ADR 0169 D4, with the staging probe's answers of 2026-11-21): the attested address when
-- the request carries a valid attestation (904180203); otherwise, when the address source is edge and the verdict
-- is asked for a direct REST call (surface postgrest), private.request_ip() at xos.trusted_proxy_hops; otherwise
-- the session's network pass while it is younger than five minutes. An API key or an app holds no pass.
--
-- New functions only. No existing function is redefined here.

-- Small readers of the configuration ------------------------------------------------------------------------------------

create or replace function private.session_gate_mode(p_org_id uuid, p_control text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_control not in ('ended', 'mfa', 'lifetime', 'idle', 'network') then 'off'
    when c.suspensions and exists (
      select 1 from private.session_gate_overrides o
      where o.org_id = p_org_id and o.control = p_control and o.ended_at is null
        and o.starts_at <= now() and o.expires_at > now()) then 'off'
    else coalesce(
      (select g.mode from private.session_gate_orgs g where c.org_modes and g.org_id = p_org_id and g.control = p_control),
      case p_control when 'ended' then c.ended when 'mfa' then c.mfa when 'lifetime' then c.lifetime
                     when 'idle' then c.idle else c.network end)
  end
  from private.session_gate_config c
  where c.singleton;
$$;

comment on function private.session_gate_mode(uuid, text) is 'The mode in force for one control (ended, mfa, lifetime, idle, network) in one organization: off while a support override suspends it, else the organization''s own mode, else the global mode. NULL organization gives the global mode.';
revoke all on function private.session_gate_mode(uuid, text) from public, anon, authenticated;

create or replace function private.session_idle_span(p_created_at timestamptz, p_refreshed_at timestamptz,
  p_last_activity_at timestamptz, p_longest_gap interval, p_at timestamptz)
returns interval
language sql
immutable
set search_path = ''
as $$
  select greatest(
    coalesce(p_longest_gap, interval '0'),
    case when p_refreshed_at > coalesce(p_last_activity_at, p_created_at)
         then p_refreshed_at - coalesce(p_last_activity_at, p_created_at) else interval '0' end,
    p_at - greatest(coalesce(p_last_activity_at, p_created_at), coalesce(p_refreshed_at, p_created_at)));
$$;

comment on function private.session_idle_span(timestamptz, timestamptz, timestamptz, interval, timestamptz) is 'The longest time a session went without an activity, as of p_at (ADR 0169 D1): the greatest of the longest gap recorded so far, the gap from the last recorded activity (or the sign-in) to the last token refresh, and the time since the later of the two. The one formula the verdict and the activity stamp share, so a stamp after a timeout cannot shorten the span.';
revoke all on function private.session_idle_span(timestamptz, timestamptz, timestamptz, interval, timestamptz) from public, anon, authenticated;

-- The verdict -------------------------------------------------------------------------------------------------------------

create or replace function private.session_verdict_compute(p_surface text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_raw text := nullif(current_setting('request.jwt.claims', true), '');
  v_claims jsonb;
  v_config private.session_gate_config;
  v_token text;
  v_user uuid;
  v_person uuid;
  v_session_id uuid;
  v_signed_in timestamptz;
  v_aal2 boolean;
  v_live boolean := false;
  v_created timestamptz;
  v_refreshed timestamptz;
  v_last_activity timestamptz;
  v_longest_gap interval;
  v_pass_address inet;
  v_pass_at timestamptz;
  v_ended boolean;
  v_session_reason text;
  v_org_modes jsonb := '{}'::jsonb;
  v_suspended jsonb := '{}'::jsonb;
  v_org record;
  v_mode text;
  v_reasons jsonb;
  v_orgs jsonb := '{}'::jsonb;
  v_observed jsonb := '[]'::jsonb;
  v_address_known boolean := false;
  v_attested boolean := false;
  v_address inet;
  v_compared boolean := false;
  v_fact boolean;
  v_edge inet;
begin
  if v_raw is null then
    return '{"v": 1, "token": "none", "session": null, "orgs": {}, "observed": []}'::jsonb;
  end if;
  v_claims := v_raw::jsonb;
  if coalesce(v_claims ->> 'role', '') <> 'authenticated' then
    return '{"v": 1, "token": "none", "session": null, "orgs": {}, "observed": []}'::jsonb;
  end if;

  select * into v_config from private.session_gate_config c where c.singleton;
  if not found
     or (v_config.ended = 'off' and v_config.mfa = 'off' and v_config.lifetime = 'off' and v_config.idle = 'off'
         and v_config.network = 'off' and not v_config.org_modes) then
    return '{"v": 1, "token": "none", "session": null, "orgs": {}, "observed": []}'::jsonb;
  end if;

  -- The kind of token. A worker's signed claim comes first; the API-key method is tested before anything reads an
  -- amr timestamp, so a key token with timestamp 0 or none is a key token and never a session without timestamps.
  v_token := case
    when v_claims ->> 'xos_origin' = 'worker' then 'worker'
    when jsonb_typeof(v_claims -> 'amr') = 'array' and exists (
           select 1 from jsonb_array_elements(v_claims -> 'amr') e
           where jsonb_typeof(e) = 'object' and e ->> 'method' = 'xos_api_key') then 'api_key'
    when v_claims ? 'client_id' then 'app'
    else 'session' end;
  if v_token = 'worker' then
    return '{"v": 1, "token": "worker", "session": null, "orgs": {}, "observed": []}'::jsonb;
  end if;

  v_user := case when (v_claims ->> 'sub') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (v_claims ->> 'sub')::uuid end;
  v_session_id := private.session_id();
  v_signed_in := private.session_signed_in_at();
  v_aal2 := coalesce(v_claims ->> 'aal', '') = 'aal2';

  if v_token in ('session', 'app') and v_user is not null and v_session_id is not null then
    select s.created_at, greatest(s.updated_at, s.refreshed_at at time zone 'UTC')
    into v_created, v_refreshed
    from auth.sessions s
    where s.id = v_session_id and s.user_id = v_user and (s.not_after is null or s.not_after > now());
    v_live := found;
    if v_live and v_token = 'session' then
      select st.last_activity_at, st.longest_gap, st.pass_address, st.pass_at
      into v_last_activity, v_longest_gap, v_pass_address, v_pass_at
      from private.session_state st
      where st.session_id = v_session_id;
    end if;
  end if;

  -- Signed out: a person's session token that names no person, no session, no sign-in time or no live session row.
  -- An app token needs the live row. A key token is not a session.
  v_ended := case v_token
    when 'session' then v_user is null or v_session_id is null or v_signed_in is null or not v_live
    when 'app' then not v_live
    else false end;

  if v_ended then
    if v_config.ended = 'enforce' then
      v_session_reason := 'session_ended';
    elsif v_config.ended = 'observe' then
      v_observed := v_observed || jsonb_build_object('org', null, 'control', 'ended', 'reason', 'session_ended');
    end if;
  end if;

  if v_user is not null then
    select p.id into v_person from app.people p where p.user_id = v_user and p.deleted_at is null;
  end if;

  if v_person is not null then
    if v_config.org_modes then
      select coalesce(jsonb_object_agg(g.org_id::text || '/' || g.control, g.mode), '{}'::jsonb) into v_org_modes
      from private.session_gate_orgs g
      where g.org_id in (select m.org_id from app.memberships m where m.person_id = v_person);
    end if;
    if v_config.suspensions then
      select coalesce(jsonb_object_agg(o.org_id::text || '/' || o.control, true), '{}'::jsonb) into v_suspended
      from private.session_gate_overrides o
      where o.ended_at is null and o.starts_at <= now() and o.expires_at > now()
        and o.org_id in (select m.org_id from app.memberships m where m.person_id = v_person);
    end if;

    for v_org in
      select distinct m.org_id,
        coalesce(r.mfa_policy, 'optional') as mfa_policy,
        coalesce(r.session_hours,
          (select d.default_integer::integer from private.setting_definitions d where d.setting_key = 'security.session_hours'),
          336) as session_hours,
        coalesce(r.idle_timeout_minutes,
          (select d.default_integer::integer from private.setting_definitions d where d.setting_key = 'security.idle_timeout_minutes'),
          60) as idle_timeout_minutes,
        coalesce(r.ip_allowlist, false) as ip_allowlist
      from app.memberships m
      left join private.org_session_rules r on r.org_id = m.org_id
      where m.person_id = v_person and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        and (v_token <> 'app' or m.org_id = private.oauth_org_id())
      order by m.org_id
    loop
      v_reasons := '[]'::jsonb;

      -- ended
      if v_ended then
        v_mode := case when v_suspended ? (v_org.org_id::text || '/ended') then 'off'
                       else coalesce(v_org_modes ->> (v_org.org_id::text || '/ended'), v_config.ended) end;
        if v_mode = 'enforce' then
          v_reasons := v_reasons || '"session_ended"'::jsonb;
        elsif v_mode = 'observe' and v_config.ended <> 'observe' then
          v_observed := v_observed || jsonb_build_object('org', v_org.org_id, 'control', 'ended', 'reason', 'session_ended');
        end if;
      end if;

      if v_token = 'session' then
        -- lifetime: the earliest amr timestamp plus the organization's session_hours has passed. No timestamp is expired.
        v_mode := case when v_suspended ? (v_org.org_id::text || '/lifetime') then 'off'
                       else coalesce(v_org_modes ->> (v_org.org_id::text || '/lifetime'), v_config.lifetime) end;
        if v_mode <> 'off' then
          v_fact := v_signed_in is null or v_signed_in + make_interval(hours => v_org.session_hours) <= now();
          if v_fact and v_mode = 'enforce' then
            v_reasons := v_reasons || '"session_expired"'::jsonb;
          elsif v_fact then
            v_observed := v_observed || jsonb_build_object('org', v_org.org_id, 'control', 'lifetime', 'reason', 'session_expired');
          end if;
        end if;

        -- idle: the longest time without an activity exceeds the organization's idle_timeout_minutes. No live row, or a
        -- row with no sign-in time, is idle.
        v_mode := case when v_suspended ? (v_org.org_id::text || '/idle') then 'off'
                       else coalesce(v_org_modes ->> (v_org.org_id::text || '/idle'), v_config.idle) end;
        if v_mode <> 'off' then
          v_fact := not v_live or v_created is null
            or private.session_idle_span(v_created, v_refreshed, v_last_activity, v_longest_gap, now())
               > make_interval(mins => v_org.idle_timeout_minutes);
          if v_fact and v_mode = 'enforce' then
            v_reasons := v_reasons || '"session_idle"'::jsonb;
          elsif v_fact then
            v_observed := v_observed || jsonb_build_object('org', v_org.org_id, 'control', 'idle', 'reason', 'session_idle');
          end if;
        end if;

        -- mfa: the organization asks this person for a second factor and the token is not aal2.
        v_mode := case when v_suspended ? (v_org.org_id::text || '/mfa') then 'off'
                       else coalesce(v_org_modes ->> (v_org.org_id::text || '/mfa'), v_config.mfa) end;
        if v_mode <> 'off' and v_org.mfa_policy <> 'optional' and not v_aal2 then
          v_fact := private.mfa_required(v_person, v_org.org_id);
          if v_fact and v_mode = 'enforce' then
            v_reasons := v_reasons || '"session_mfa_required"'::jsonb;
          elsif v_fact then
            v_observed := v_observed || jsonb_build_object('org', v_org.org_id, 'control', 'mfa', 'reason', 'session_mfa_required');
          end if;
        end if;
      end if;

      -- network: the organization enforces its allow-list, the caller's address is outside it, and the caller holds
      -- no open break-glass session at aal2. It binds sessions, API keys and apps.
      v_mode := case when v_suspended ? (v_org.org_id::text || '/network') then 'off'
                     else coalesce(v_org_modes ->> (v_org.org_id::text || '/network'), v_config.network) end;
      if v_mode <> 'off' and v_org.ip_allowlist and private.ip_allowlist_enforced(v_org.org_id) then
        if not v_address_known then
          select a.verified, a.client_address into v_attested, v_address from private.request_attestation() a;
          v_attested := coalesce(v_attested, false);
          if not v_attested then
            if v_config.address_source = 'edge' and p_surface = 'postgrest' then
              v_address := private.safe_inet(host(private.request_ip()));
            elsif v_token = 'session' and v_pass_at > now() - interval '5 minutes' then
              v_address := v_pass_address;
            else
              v_address := null;
            end if;
          end if;
          v_address_known := true;
        end if;
        v_fact := not (v_address is not null and exists (
                         select 1 from app.org_ip_allowlist a
                         where a.org_id = v_org.org_id and a.deleted_at is null and v_address <<= a.cidr))
                  and not private.break_glass_reaches_me(v_org.org_id);
        if v_fact and v_mode = 'enforce' then
          v_reasons := v_reasons || '"network_restricted"'::jsonb;
        elsif v_fact then
          v_observed := v_observed || jsonb_build_object('org', v_org.org_id, 'control', 'network', 'reason', 'network_restricted');
        end if;
        -- ADR 0169 D4: before the address source is switched to edge, observe compares the edge address of each
        -- direct REST call that holds a fresh pass with the address of that pass. Counted once for the call.
        if not v_compared and v_config.network = 'observe' and v_config.address_source = 'pass' and p_surface = 'postgrest'
           and not v_attested and v_token = 'session' and v_pass_at > now() - interval '5 minutes' then
          v_edge := private.safe_inet(host(private.request_ip()));
          v_observed := v_observed || jsonb_build_object('org', null, 'control', 'network',
            'reason', case when v_edge is not distinct from v_pass_address then 'edge_matches_pass' else 'edge_differs_from_pass' end);
          v_compared := true;
        end if;
      end if;

      if jsonb_array_length(v_reasons) > 0 then
        v_orgs := v_orgs || jsonb_build_object(v_org.org_id::text, v_reasons);
      end if;
    end loop;
  end if;

  return jsonb_build_object('v', 1, 'token', v_token, 'session', v_session_reason, 'orgs', v_orgs, 'observed', v_observed);
end;
$$;

comment on function private.session_verdict_compute(text) is 'Decides the session gate''s rules for the token on the request (ADR 0169 D1) and returns the verdict as jsonb: the kind of token, whether the session is refused as a whole (session_ended), the organizations that refuse it with their reasons, strongest first, and what observe mode would have refused. p_surface names where it is asked; only postgrest (the pre-request of a direct REST call) may read the edge address. Reads the configuration on every call, changes nothing, and is empty after one single-row read while every control is off. Callers read it through private.session_verdict.';
revoke all on function private.session_verdict_compute(text) from public, anon, authenticated;

-- One verdict per request ---------------------------------------------------------------------------------------------------

create or replace function private.session_verdict_key()
returns text
language sql
stable
set search_path = ''
as $$
  select md5(coalesce(current_setting('request.jwt.claims', true), '') || '|'
    || coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-xos-attestation', ''));
$$;

comment on function private.session_verdict_key() is 'Binds a stored verdict to the token and the attestation it was computed for, so a verdict stored for one request is never read for another token in the same transaction.';
revoke all on function private.session_verdict_key() from public, anon, authenticated;

create or replace function private.session_verdict()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_stored text := nullif(current_setting('xos.session_verdict', true), '');
  v_verdict jsonb;
begin
  if v_stored is not null then
    v_verdict := v_stored::jsonb;
    if v_verdict ->> 'k' = private.session_verdict_key() then
      return v_verdict;
    end if;
  end if;
  return private.session_verdict_compute(null);
end;
$$;

comment on function private.session_verdict() is 'The verdict for the current request (ADR 0169 D1): the one private.session_verdict_store kept in the transaction-local setting xos.session_verdict when it was stored for this token, otherwise computed now. Every reader, helper and policy asks this function.';
revoke all on function private.session_verdict() from public, anon;
grant execute on function private.session_verdict() to authenticated, service_role;

create or replace function private.session_gate_log_line(p_control text, p_surface text, p_org_id uuid, p_token text, p_reason text)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'xos_session_gate ' || jsonb_build_object('control', p_control, 'surface', p_surface, 'org_id', p_org_id,
    'token', p_token, 'reason', p_reason)::text;
$$;

comment on function private.session_gate_log_line(text, text, uuid, text, text) is 'The Postgres log line observe mode writes for one call enforce would have refused (ADR 0169 D7): the marker xos_session_gate and the control, surface, organization, kind of token and reason. It carries no person, session, address or email.';
revoke all on function private.session_gate_log_line(text, text, uuid, text, text) from public, anon, authenticated;

create or replace function private.session_gate_observe(p_surface text, p_verdict jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_surface text := lower(btrim(coalesce(p_surface, '')));
  v_item jsonb;
begin
  if p_verdict is null or jsonb_typeof(p_verdict -> 'observed') is distinct from 'array'
     or jsonb_array_length(p_verdict -> 'observed') = 0 then
    return;
  end if;
  if v_surface !~ '^[a-z][a-z0-9_]{1,39}$' then
    v_surface := 'other';
  end if;
  for v_item in select e from jsonb_array_elements(p_verdict -> 'observed') e loop
    raise log '%', private.session_gate_log_line(v_item ->> 'control', v_surface, (v_item ->> 'org')::uuid,
      p_verdict ->> 'token', v_item ->> 'reason');
  end loop;
  if current_setting('transaction_read_only', true) = 'on' then
    return;
  end if;
  insert into private.session_gate_observations as o (observed_on, control, surface, org_id, token_type, reason, calls)
  select (now() at time zone 'UTC')::date, e ->> 'control', v_surface, (e ->> 'org')::uuid, p_verdict ->> 'token',
         e ->> 'reason', count(*)
  from jsonb_array_elements(p_verdict -> 'observed') e
  group by 2, 4, 6
  order by 2, 4, 6
  on conflict (observed_on, control, surface, org_id, token_type, reason) do update
    set calls = o.calls + excluded.calls, last_seen_at = now();
end;
$$;

comment on function private.session_gate_observe(text, jsonb) is 'Records what observe mode saw in a verdict (ADR 0169 D7): one Postgres log line for each call enforce would have refused and, on a read-write transaction, a count in private.session_gate_observations. Refuses nothing. Called by private.session_verdict_store; a package that asks the verdict on another surface calls it with its own surface name.';
revoke all on function private.session_gate_observe(text, jsonb) from public, anon, authenticated;

create or replace function private.session_verdict_store(p_surface text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_verdict jsonb := private.session_verdict_compute(p_surface) || jsonb_build_object('k', private.session_verdict_key());
begin
  perform set_config('xos.session_verdict', v_verdict::text, true);
  perform private.session_gate_observe(p_surface, v_verdict);
  return v_verdict;
end;
$$;

comment on function private.session_verdict_store(text) is 'Computes the verdict once for the request, keeps it in the transaction-local setting xos.session_verdict for every later reader, records what observe mode saw, and returns it. The PostgREST pre-request calls it with surface postgrest (ADR 0169 D2); nothing else stores a verdict.';
revoke all on function private.session_verdict_store(text) from public, anon, authenticated;

-- Readers -----------------------------------------------------------------------------------------------------------------

create or replace function private.session_refusal()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.session_verdict() ->> 'session';
$$;

comment on function private.session_refusal() is 'The reason the session is refused as a whole (session_ended), or NULL. A whole refusal stands whatever an organization''s own mode or a support override says.';
revoke all on function private.session_refusal() from public, anon;
grant execute on function private.session_refusal() to authenticated, service_role;

create or replace function private.session_refused_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select k::uuid from jsonb_object_keys(private.session_verdict() -> 'orgs') k;
$$;

comment on function private.session_refused_org_ids() is 'The organizations that refuse the current session (ADR 0169 D1). Helpers and policies read it once per statement as org_id <> all (array(select private.session_refused_org_ids())). Empty while every control is off.';
revoke all on function private.session_refused_org_ids() from public, anon;
grant execute on function private.session_refused_org_ids() to authenticated, service_role;

create or replace function private.session_org_refusal(p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(v ->> 'session', v -> 'orgs' -> p_org_id::text ->> 0)
  from (select private.session_verdict() as v) verdict;
$$;

comment on function private.session_org_refusal(uuid) is 'Why one organization is closed to the current session: session_ended for a session refused as a whole, else the organization''s strongest reason, else NULL.';
revoke all on function private.session_org_refusal(uuid) from public, anon;
grant execute on function private.session_org_refusal(uuid) to authenticated, service_role;

create or replace function private.session_direct_refusal()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(v ->> 'session', (
    select r.reason
    from jsonb_each(v -> 'orgs') o
    cross join lateral jsonb_array_elements_text(o.value) r (reason)
    order by array_position(array['session_ended', 'session_expired', 'session_idle', 'session_mfa_required',
                                  'network_restricted'], r.reason)
    limit 1))
  from (select private.session_verdict() as v) verdict;
$$;

comment on function private.session_direct_refusal() is 'The reason a direct call is refused whole, or NULL (ADR 0169 D2, owner decision 6): session_ended for a session refused as a whole, else the strongest reason of any organization that refuses it, because on a direct call the strictest organization governs.';
revoke all on function private.session_direct_refusal() from public, anon, authenticated;

create or replace function private.session_ended_refused()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(v ->> 'session' = 'session_ended', false)
      or exists (select 1 from jsonb_each(v -> 'orgs') o where o.value ? 'session_ended')
  from (select private.session_verdict() as v) verdict;
$$;

comment on function private.session_ended_refused() is 'True when the signed-out control refuses the current session, as a whole or for any organization. private.require_second_factor reads it, so a signed-out session cannot step up.';
revoke all on function private.session_ended_refused() from public, anon, authenticated;

-- What a refused session still reaches ----------------------------------------------------------------------------------

create or replace function private.session_gate_open_functions()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['my_session_gate', 'my_org_auth_status', 'network_access', 'redeem_recovery_code', 'touch_my_session',
               'my_sessions', 'sign_out_my_session', 'sign_out_my_other_sessions', 'start_break_glass', 'ensure_my_profile'];
$$;

comment on function private.session_gate_open_functions() is 'The functions of the app schema a session refused by an organization still reaches on a direct call, so it can recover (ADR 0169 D2): the gate and status readers, the recovery code, the activity touch, the person''s own sessions, break-glass and the profile bootstrap. app.delete_my_account is not among them: a signed-out token must not delete an account, so the replay of a finished deletion answers only through our servers.';
revoke all on function private.session_gate_open_functions() from public, anon, authenticated;

create or replace function private.session_gate_reachable(p_schema text, p_function text, p_whole boolean)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_schema = 'api_public'
    or (not coalesce(p_whole, true) and p_schema = 'app' and p_function = any (private.session_gate_open_functions())), false);
$$;

comment on function private.session_gate_reachable(text, text, boolean) is 'Whether a refused session may still call a function on a direct call (ADR 0169 D2). p_schema is the schema of the request''s profile header and p_function the function name, NULL for a table. A session refused as a whole (p_whole) reaches the api_public schema only; a session an organization refuses also reaches private.session_gate_open_functions. Tables are never reachable.';
revoke all on function private.session_gate_reachable(text, text, boolean) from public, anon, authenticated;
