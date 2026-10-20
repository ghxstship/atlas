-- 1299_unenforced_security_settings.sql
-- A69 security review (RRR-114), finding A69-007. Settings, Security offers three org settings that nothing enforces:
--   * security.mfa_policy ("Who must use a second factor to sign in": optional, admins or everyone);
--   * security.session_hours ("How long a sign-in lasts before the person signs in again");
--   * security.idle_timeout_minutes ("Sign out after this many minutes without activity").
-- No sign-in, proxy, API or database code reads them, and Atlas has no screen to enroll or verify a second factor, so an
-- Owner who chose "everyone" or an 8-hour session was told members were protected when they were not. ADR 0032 retired
-- settings like these for the same reason ("would report protection that does not exist").
-- Until enforcement is built (an owner decision, see legal/qa/findings/A69-007.md), each keeps its default and the
-- database refuses any other value with setting_not_enforced. No org holds another value today; a value written
-- before this migration is left in place and reported by the pgTAP suite.

create or replace function private.guard_unenforced_security_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null and (
       (new.setting_key = 'security.mfa_policy' and coalesce(new.value_text, 'optional') <> 'optional')
    or (new.setting_key = 'security.session_hours' and coalesce(new.value_integer, 336) <> 336)
    or (new.setting_key = 'security.idle_timeout_minutes' and coalesce(new.value_integer, 60) <> 60)) then
    perform private.refuse('setting_not_enforced',
      'XOS does not enforce this setting yet, so it keeps its default. Changing it would not protect anyone.');
  end if;
  return new;
end;
$$;

comment on function private.guard_unenforced_security_settings() is 'Keeps security.mfa_policy (optional), security.session_hours (336) and security.idle_timeout_minutes (60) at their defaults while nothing enforces them, so the Security page never reports protection that does not exist (A69-007).';
revoke all on function private.guard_unenforced_security_settings() from public, anon, authenticated;

create trigger t43_guard_unenforced_security_settings before insert or update on app.setting_values
  for each row when (new.setting_key in ('security.mfa_policy', 'security.session_hours', 'security.idle_timeout_minutes'))
  execute function private.guard_unenforced_security_settings();
