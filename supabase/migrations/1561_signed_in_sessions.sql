-- 1561_signed_in_sessions.sql
-- A99 Authentication follow-ups (RRR-144; finding A65-002, ADR 0055). Section 4.5.6 personal setting 4, "Security:
-- passkeys, MFA, sessions and devices": a person sees where they are signed in and signs out one session or every
-- other one.
--
--   * Sessions are Supabase Auth's (auth.sessions), read only through app.my_sessions(), which returns the caller's own
--     and nothing else. Sessions of OAuth apps are left out; Connected apps lists and revokes those.
--   * The device and place come from XOS, never from Supabase Auth: auth.sessions.ip is the first X-Forwarded-For entry,
--     which the client writes, and its user agent is the Atlas server's when Atlas signed the person in. Atlas, Gateway
--     and the API record the session's device with app.touch_my_session: the client address as clientAddress() reads it
--     behind the trusted proxies (A69-003), the approximate place the hosting platform derived from that address, and
--     the browser's user agent, at most once a minute.
--   * app.sign_out_my_session(id) ends one other session and app.sign_out_my_other_sessions() every other one, by
--     deleting the auth.sessions rows as Supabase Auth's own sign-out does (refresh tokens and amr claims cascade). Each
--     is written to the account security trail and sends account.session_signed_out.
--   * app.my_org_auth_status gains session_ended: true when the JWT's session no longer exists, so Atlas, the API runtime
--     and Compass stop accepting a signed-out session's access token at once instead of at its expiry.
--   * Admins see no one else's sessions: Section 4.5.6 lists sessions under the person's own settings, and org settings 10
--     only the org's session rules (security.session_hours, security.idle_timeout_minutes), which 1330 enforces.

create table private.session_devices (
  session_id uuid primary key references auth.sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  surface text not null,
  client_address inet,
  place text,
  user_agent text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint session_devices_surface check (surface in ('Atlas', 'Gateway', 'Compass', 'API')),
  constraint session_devices_place_length check (char_length(place) between 1 and 120),
  constraint session_devices_user_agent_length check (char_length(user_agent) between 1 and 512)
);

create index session_devices_user_idx on private.session_devices (user_id);

alter table private.session_devices enable row level security;
revoke all on private.session_devices from public, anon, authenticated;

comment on table private.session_devices is 'The device behind each Supabase Auth session, as XOS saw it (ADR 0055): written by app.touch_my_session from Atlas, Gateway, Compass and the API, read through app.my_sessions. Deleted with the session.';
comment on column private.session_devices.session_id is 'Supabase Auth session (auth.sessions.id).';
comment on column private.session_devices.user_id is 'Sign-in the session belongs to.';
comment on column private.session_devices.surface is 'Where the session was last used: Atlas, Gateway, Compass or API.';
comment on column private.session_devices.client_address is 'Client address as clientAddress() reads it behind the trusted proxies (A69-003), never the first X-Forwarded-For entry.';
comment on column private.session_devices.place is 'Approximate place the hosting platform derived from that address (city, region, country), when it gives one.';
comment on column private.session_devices.user_agent is 'The browser or app user agent, up to 512 characters, for the device name.';
comment on column private.session_devices.first_seen_at is 'When XOS first saw the session.';
comment on column private.session_devices.last_seen_at is 'When XOS last saw the session, recorded at most once a minute.';

-- Recording the device ------------------------------------------------------------------------------------------------------

create or replace function private.safe_inet(p_value text)
returns inet
language plpgsql
immutable
set search_path = ''
as $$
begin
  return host(btrim(p_value)::inet)::inet;
exception
  when invalid_text_representation or data_exception then
    return null;
end;
$$;

comment on function private.safe_inet(text) is 'A client address as inet without a prefix length, or NULL when the text is not an address.';
revoke all on function private.safe_inet(text) from public, anon, authenticated;

create or replace function private.clean_label(p_value text, p_max integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(left(btrim(regexp_replace(coalesce(p_value, ''), '[[:cntrl:]]+', ' ', 'g')), p_max), '');
$$;

comment on function private.clean_label(text, integer) is 'Text with control characters replaced, trimmed and cut to p_max characters; NULL when empty.';
revoke all on function private.clean_label(text, integer) from public, anon, authenticated;

create or replace function app.touch_my_session(p_surface text, p_client_address text, p_place text, p_user_agent text)
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
end;
$$;

comment on function app.touch_my_session(text, text, text, text) is 'Records the device behind the caller''s own session (from the JWT): the surface (Atlas, Gateway, Compass or API), the client address read behind the trusted proxies, the approximate place and the user agent. Writes at most once a minute unless something changed; ignores API keys, apps and unknown sessions.';
revoke all on function app.touch_my_session(text, text, text, text) from public, anon;
grant execute on function app.touch_my_session(text, text, text, text) to authenticated;

-- Listing and ending sessions -----------------------------------------------------------------------------------------------

create or replace function app.my_sessions()
returns table (
  session_id uuid,
  is_current boolean,
  signed_in_at timestamptz,
  last_active_at timestamptz,
  second_factor boolean,
  surface text,
  client_address text,
  place text,
  user_agent text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id,
         s.id = private.session_id(),
         s.created_at,
         greatest(s.created_at, s.updated_at, s.refreshed_at at time zone 'UTC', d.last_seen_at),
         s.aal::text = 'aal2',
         d.surface,
         host(d.client_address),
         d.place,
         d.user_agent
  from auth.sessions s
  left join private.session_devices d on d.session_id = s.id
  where s.user_id = (select auth.uid())
    and s.oauth_client_id is null
    and (s.not_after is null or s.not_after > now())
    and private.api_key_scopes() is null
  order by s.id = private.session_id() desc,
           greatest(s.created_at, s.updated_at, s.refreshed_at at time zone 'UTC', d.last_seen_at) desc;
$$;

comment on function app.my_sessions() is 'The caller''s own signed-in sessions, this one first, then by last activity: when each signed in and was last active, whether it passed a second factor, and the surface, client address, approximate place and user agent XOS recorded. Sessions of OAuth apps are left out (Connected apps lists them).';
revoke all on function app.my_sessions() from public, anon;
grant execute on function app.my_sessions() to authenticated;

create or replace function private.require_own_session()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or private.api_key_scopes() is not null then
    raise exception using errcode = '42501', message = 'a signed-in session is required';
  end if;
  return private.session_id();
end;
$$;

comment on function private.require_own_session() is 'The caller''s session id; refuses anon, API keys and OAuth apps, which never manage a person''s sessions.';
revoke all on function private.require_own_session() from public, anon, authenticated;

create or replace function app.sign_out_my_session(p_session_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_current uuid := private.require_own_session();
  v_device private.session_devices;
begin
  if p_session_id is not distinct from v_current then
    perform private.refuse('session_current', 'Sign out of this device with Sign out instead.');
  end if;
  select * into v_device from private.session_devices d where d.session_id = p_session_id and d.user_id = v_user;
  delete from auth.sessions s where s.id = p_session_id and s.user_id = v_user and s.oauth_client_id is null;
  if not found then
    raise exception using errcode = '42501', message = 'session not found';
  end if;
  perform private.record_security_event(v_user, 'session_signed_out', jsonb_strip_nulls(jsonb_build_object(
    'session_id', p_session_id, 'surface', v_device.surface, 'client_address', host(v_device.client_address),
    'place', v_device.place)));
  perform private.notify_account(v_user, 'account.session_signed_out', jsonb_build_object('count', 1));
end;
$$;

comment on function app.sign_out_my_session(uuid) is 'Signs out one of the caller''s other sessions at once: its refresh token stops working and Atlas, the API and Compass refuse its access token (session_ended). This session is refused (session_current); another person''s reads as not found. Writes the account security trail and sends account.session_signed_out.';
revoke all on function app.sign_out_my_session(uuid) from public, anon;
grant execute on function app.sign_out_my_session(uuid) to authenticated;

create or replace function app.sign_out_my_other_sessions()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_current uuid := private.require_own_session();
  v_count integer;
begin
  if v_current is null then
    raise exception using errcode = '42501', message = 'session not found';
  end if;
  delete from auth.sessions s where s.user_id = v_user and s.id <> v_current and s.oauth_client_id is null;
  get diagnostics v_count = row_count;
  if v_count > 0 then
    perform private.record_security_event(v_user, 'other_sessions_signed_out', jsonb_build_object('count', v_count));
    perform private.notify_account(v_user, 'account.session_signed_out', jsonb_build_object('count', v_count));
  end if;
  return v_count;
end;
$$;

comment on function app.sign_out_my_other_sessions() is 'Signs out every session of the caller except this one (OAuth apps stay connected; revoke them under Connected apps). Returns how many ended; writes the account security trail and sends account.session_signed_out when any did.';
revoke all on function app.sign_out_my_other_sessions() from public, anon;
grant execute on function app.sign_out_my_other_sessions() to authenticated;

-- A signed-out session ends at once wherever the org guard runs -------------------------------------------------------------
-- Redefined from 1330 (its latest definition, every behavior kept) with session_ended appended. A new output column
-- changes the return type, so the function is dropped and created again with its grants.

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
  session_ended boolean
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
begin
  if v_person is null or not exists (
      select 1 from app.memberships m
      where m.org_id = p_org_id and m.person_id = v_person and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    return;
  end if;
  if private.api_key_scopes() is not null then
    -- A machine credential or an app: no second factor and no sign-in to age.
    return query select false, false, null::timestamptz, null::integer, null::timestamptz, false, null::integer, false;
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
      where s.id = v_session and s.user_id = (select auth.uid()) and (s.not_after is null or s.not_after > now()));
end;
$$;

comment on function app.my_org_auth_status(uuid) is 'What an org asks of the caller''s session (Section 9), for the Atlas proxy, the API runtime and Compass: whether security.mfa_policy requires a second factor for the caller''s roles and whether the session passed one (aal2), when it signed in, security.session_hours and whether that lifetime is over, security.idle_timeout_minutes, and whether the session was signed out (session_ended: its auth.sessions row is gone). No row when the caller holds no active membership. API keys and OAuth apps are exempt.';
revoke all on function app.my_org_auth_status(uuid) from public, anon;
grant execute on function app.my_org_auth_status(uuid) to authenticated;
