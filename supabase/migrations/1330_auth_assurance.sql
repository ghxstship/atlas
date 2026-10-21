-- 1330_auth_assurance.sql
-- A77 Authentication and step-up (RRR-122; findings A65-002, A65-001, A59-019 and A69-007). Section 9: "MFA: TOTP and
-- passkeys. Orgs can enforce MFA per role. Session lifetime is configurable per org. Step-up authentication is required
-- for billing, data export, role changes and API key creation." Section 8.4: break-glass requires MFA.
--
-- Second factors and passkeys live in Supabase Auth (auth.mfa_factors and its passkey tables), never in our tables. These
-- functions read the session JWT Supabase Auth issues: `aal` (aal2 once a second factor passed in the session, read by
-- private.session_aal since 0530) and `amr`, the methods the session used, each with the time it was last used. A passkey
-- sign-in is a first factor (aal1, amr `passkey`); TOTP (`totp`) and a security key or passkey enrolled as a second factor
-- (`mfa/webauthn`) raise the session to aal2.
--
--   * Step-up stays private.session_aal() = 'aal2' (Restricted exports 0530, payroll exports 0461, SCIM tokens 0638, the
--     1099-NEC file 1124, break-glass 1203 and its whole hour 1298). Atlas and Gateway now produce aal2 sessions: the
--     challenge after sign-in, and the step-up dialog that answers step_up_required and resumes the action.
--   * Changing one's own sign-in methods (removing a second factor, adding or removing a passkey) asks for a second
--     factor passed in the last 15 minutes (private.reverify_window), read through app.my_second_factor_status.
--   * private.mfa_required(person, org) reads security.mfa_policy: optional, admins (roles in band 1 or 2, the Owner and
--     Admin system roles and custom roles at their level) or everyone.
--   * app.my_org_auth_status(org) tells the Atlas proxy, the API runtime and Compass what the org asks of the caller's
--     session: a second factor (security.mfa_policy, against the caller's roles on every request, so a role change
--     applies at once), a sign-in no older than security.session_hours, and security.idle_timeout_minutes. They send the
--     person to verify, to set a factor up or to sign in again. API-key sessions are exempt: a key is a machine
--     credential bounded by its scopes and expiry.
--   * With all three enforced, the A69-007 guard that pinned them to their defaults (1299) is lifted.
-- Row level security does not read these settings; the guards above enforce them (hosted-security-settings.md).

-- Session claims -----------------------------------------------------------------------------------------------------------

create or replace function private.session_amr_at(p_methods text[])
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select max(to_timestamp((e ->> 'timestamp')::double precision))
  from jsonb_array_elements(
    case when jsonb_typeof(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'amr') = 'array'
         then nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'amr' else '[]'::jsonb end) e
  where jsonb_typeof(e) = 'object' and e ->> 'method' = any (p_methods)
    and (e ->> 'timestamp') ~ '^[0-9]+(\.[0-9]+)?$';
$$;

comment on function private.session_amr_at(text[]) is 'When the session last used one of the named methods, from the amr claim of the session JWT, or NULL.';
revoke all on function private.session_amr_at(text[]) from public, anon, authenticated;

create or replace function private.second_factor_at()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select private.session_amr_at(array['totp', 'mfa/totp', 'mfa/webauthn', 'mfa/phone', 'phone']);
$$;

comment on function private.second_factor_at() is 'When the session last passed a second factor (TOTP, or a security key or passkey enrolled as a second factor), or NULL. A passkey sign-in (amr passkey) is a first factor and does not count.';
revoke all on function private.second_factor_at() from public, anon, authenticated;

create or replace function private.session_signed_in_at()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select min(to_timestamp((e ->> 'timestamp')::double precision))
  from jsonb_array_elements(
    case when jsonb_typeof(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'amr') = 'array'
         then nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'amr' else '[]'::jsonb end) e
  where jsonb_typeof(e) = 'object' and (e ->> 'timestamp') ~ '^[0-9]+(\.[0-9]+)?$';
$$;

comment on function private.session_signed_in_at() is 'When the session signed in: the earliest method in its amr claim. Token refreshes keep it; a new sign-in starts a new session. NULL when the JWT names no method.';
revoke all on function private.session_signed_in_at() from public, anon, authenticated;

create or replace function private.reverify_window()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '15 minutes';
$$;

comment on function private.reverify_window() is 'How long a second factor counts as recent for changing one''s own sign-in methods: 15 minutes (re-authentication before changing authenticators, NIST SP 800-63B and ASVS V6).';
revoke all on function private.reverify_window() from public, anon, authenticated;

create or replace function app.my_second_factor_status()
returns table (session_aal text, second_factor_at timestamptz, recent boolean, recent_until timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select private.session_aal(),
         private.second_factor_at(),
         coalesce(private.session_aal() = 'aal2' and private.second_factor_at() > now() - private.reverify_window(), false),
         case when private.session_aal() = 'aal2' then private.second_factor_at() + private.reverify_window() end;
$$;

comment on function app.my_second_factor_status() is 'The caller''s session assurance (aal2 is the step-up the database asks for), when it last passed a second factor, and whether that was recent enough (private.reverify_window) to change the person''s own sign-in methods, and until when.';
revoke all on function app.my_second_factor_status() from public, anon;
grant execute on function app.my_second_factor_status() to authenticated;

-- MFA policy ----------------------------------------------------------------------------------------------------------------

create or replace function private.org_setting_text(p_org_id uuid, p_setting_key text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select v.value_text from app.setting_values v
     where v.org_id = p_org_id and v.setting_key = p_setting_key and v.scope_kind = 'Organization'
       and v.scope_id = p_org_id and v.deleted_at is null),
    (select d.default_text from private.setting_definitions d where d.setting_key = p_setting_key));
$$;

comment on function private.org_setting_text(uuid, text) is 'An org''s own value of a text or choice setting, or the platform default when the org set none.';
revoke all on function private.org_setting_text(uuid, text) from public, anon, authenticated;

create or replace function private.org_setting_integer(p_org_id uuid, p_setting_key text)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select v.value_integer from app.setting_values v
     where v.org_id = p_org_id and v.setting_key = p_setting_key and v.scope_kind = 'Organization'
       and v.scope_id = p_org_id and v.deleted_at is null),
    (select d.default_integer from private.setting_definitions d where d.setting_key = p_setting_key));
$$;

comment on function private.org_setting_integer(uuid, text) is 'An org''s own value of an integer setting, or the platform default when the org set none.';
revoke all on function private.org_setting_integer(uuid, text) from public, anon, authenticated;

create or replace function private.mfa_required(p_person_id uuid, p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case coalesce(private.org_setting_text(p_org_id, 'security.mfa_policy'), 'optional')
    when 'everyone' then true
    when 'admins' then exists (
      select 1
      from app.memberships m
      join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
      join app.roles r on r.id = mr.role_id
      where m.org_id = p_org_id and m.person_id = p_person_id and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        and r.band <= 2)
    else false
  end;
$$;

comment on function private.mfa_required(uuid, uuid) is 'Whether the org''s security.mfa_policy asks this person for a second factor: everyone, or admins (a role in band 1 or 2: the Owner and Admin system roles and custom roles at their level). Read against the roles held now, so a role change applies on the next request.';
revoke all on function private.mfa_required(uuid, uuid) from public, anon, authenticated;

-- What an org asks of the caller's session ---------------------------------------------------------------------------------

create or replace function app.my_org_auth_status(p_org_id uuid)
returns table (
  mfa_required boolean,
  mfa_verified boolean,
  signed_in_at timestamptz,
  session_hours integer,
  session_expires_at timestamptz,
  session_expired boolean,
  idle_timeout_minutes integer
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
begin
  if v_person is null or not exists (
      select 1 from app.memberships m
      where m.org_id = p_org_id and m.person_id = v_person and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    return;
  end if;
  if private.api_key_scopes() is not null then
    -- A machine credential: no second factor and no sign-in to age.
    return query select false, false, null::timestamptz, null::integer, null::timestamptz, false, null::integer;
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
    coalesce(private.org_setting_integer(p_org_id, 'security.idle_timeout_minutes'), 60)::integer;
end;
$$;

comment on function app.my_org_auth_status(uuid) is 'What an org asks of the caller''s session (Section 9), for the Atlas proxy, the API runtime and Compass: whether security.mfa_policy requires a second factor for the caller''s roles and whether the session passed one (aal2), when it signed in, security.session_hours and whether that lifetime is over, and security.idle_timeout_minutes. No row when the caller holds no active membership. API-key sessions are exempt.';
revoke all on function app.my_org_auth_status(uuid) from public, anon;
grant execute on function app.my_org_auth_status(uuid) to authenticated;

-- A69-007: the settings are enforced now ----------------------------------------------------------------------------------
-- 1299 kept security.mfa_policy, security.session_hours and security.idle_timeout_minutes at their defaults while nothing
-- enforced them. Atlas (proxy and every org context), the API runtime and Compass now read them through
-- app.my_org_auth_status, so any registered value may be saved again.

drop trigger if exists t43_guard_unenforced_security_settings on app.setting_values;
drop function if exists private.guard_unenforced_security_settings();
