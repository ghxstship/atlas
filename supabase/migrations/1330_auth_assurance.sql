-- 1330_auth_assurance.sql
-- A77 Authentication and step-up (RRR-122; findings A65-002, A65-001 and A59-019). Section 9: "MFA: TOTP and passkeys.
-- Orgs can enforce MFA per role. Session lifetime is configurable per org. Step-up authentication is required for
-- billing, data export, role changes and API key creation." Section 8.4: break-glass requires MFA.
--
-- Second factors and passkeys live in Supabase Auth (auth.mfa_factors and its passkey tables), never in our tables. These
-- functions read the session JWT Supabase Auth issues: `aal` (aal2 once a second factor passed in the session) and `amr`,
-- the methods the session used, each with the time it was last used. A passkey sign-in is a first factor (aal1, amr
-- `passkey`); TOTP (`totp`) and a security key or passkey enrolled as a second factor (`mfa/webauthn`) raise it to aal2.
--
--   * private.session_aal() becomes step-up assurance: aal2 only while the session's last second factor is under 15
--     minutes old (private.step_up_window). Its callers keep their refusal, step_up_required: Restricted exports (0530),
--     payroll exports (0461), SCIM tokens (0638), the 1099-NEC file (1124) and break-glass (1203). Atlas and Gateway answer
--     the refusal with the step-up dialog, which asks for a code or the security key and resumes the action.
--   * private.mfa_required(person, org) reads security.mfa_policy: optional, admins (roles in band 1 or 2, the Owner and
--     Admin system roles and custom roles at their level) or everyone.
--   * app.my_org_auth_status(org) tells the Atlas proxy, the API runtime and Compass what the org asks of the caller's
--     session: a second factor (security.mfa_policy, checked against the caller's roles on every request, so a role
--     change applies at once) and a sign-in no older than security.session_hours. They send the person to verify or to
--     sign in again. API-key sessions are exempt: a key is a machine credential bounded by its scopes and expiry.
--   * app.my_step_up_status() tells the interface whether the session is stepped up and until when.
-- Row level security does not read these settings; the guards above enforce them (hosted-security-settings.md).

-- Session claims -----------------------------------------------------------------------------------------------------------

create or replace function private.jwt_aal()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal', 'aal1');
$$;

comment on function private.jwt_aal() is 'The aal claim of the session JWT as Supabase Auth issued it: aal2 once a second factor passed in the session, otherwise aal1.';
revoke all on function private.jwt_aal() from public, anon, authenticated;

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

create or replace function private.step_up_window()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '15 minutes';
$$;

comment on function private.step_up_window() is 'How long a second factor counts as step-up after it passes: 15 minutes, the re-authentication window for sensitive actions (NIST SP 800-63B, ASVS V6).';
revoke all on function private.step_up_window() from public, anon, authenticated;

create or replace function private.session_aal()
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when private.jwt_aal() = 'aal2' and private.second_factor_at() > now() - private.step_up_window() then 'aal2'
    else 'aal1'
  end;
$$;

comment on function private.session_aal() is 'Step-up assurance of the session (Section 9): aal2 while the session JWT is aal2 and its last second factor passed within private.step_up_window(), otherwise aal1. Callers refuse with step_up_required, which Atlas and Gateway answer with the step-up dialog. private.jwt_aal() is the claim as issued.';
revoke all on function private.session_aal() from public, anon, authenticated;

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
    private.jwt_aal() = 'aal2',
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

create or replace function app.my_step_up_status()
returns table (stepped_up boolean, second_factor_at timestamptz, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select private.session_aal() = 'aal2',
         private.second_factor_at(),
         case when private.jwt_aal() = 'aal2' then private.second_factor_at() + private.step_up_window() end;
$$;

comment on function app.my_step_up_status() is 'Whether the caller''s session counts as stepped up for sensitive actions (private.session_aal), when it last passed a second factor and when that step-up lapses.';
revoke all on function app.my_step_up_status() from public, anon;
grant execute on function app.my_step_up_status() to authenticated;
