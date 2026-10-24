-- 1700_account_security_notices.sql
--
-- Account security notices (ADR 0022, 1700-1709), A104, RRR-149; follow-ups of A77 and A99 (RRR-122, RRR-144).
-- account.security_changed was registered with copy and an Inbox description but nothing sent it: password, email and
-- phone changes happen in Supabase Auth, second factors are enrolled and removed through it, and A99's recovery codes
-- sent only account.recovery_code_used. Every change to how a person signs in now tells them once, through
-- private.notify_account (1560: the org they chose last, else their newest membership, else an org they work with):
--
--   * private.after_auth_user_security_change, a trigger on auth.users, sends change 'password' when a password
--     replaces another (a reset or a change), 'password_set' when a sign-in without one gets its first (an invite
--     accepted, or a Google sign-in that adds a password), 'password_removed' when a password is cleared (Supabase
--     Auth does so when an unconfirmed sign-in links Google), 'email' when the sign-in email changes (Supabase Auth
--     writes it once the change is confirmed) and 'phone' when the phone number is added, changed or removed. A new
--     sign-up is an insert and sends nothing.
--   * private.after_mfa_factor_change, a trigger on auth.mfa_factors, sends 'factor_added' when a second factor is
--     verified (an enrollment nobody finished sends nothing) and 'factor_removed' when a verified one is deleted. A
--     factor deleted with its sign-in sends nothing.
--   * private.after_passkey_change, a trigger on auth.webauthn_credentials (the passkeys a person signs in with
--     instead of a password, which Supabase Auth adds as it migrates its own schema), sends 'passkey_added' and
--     'passkey_removed'. A passkey that signs in only updates its row and sends nothing; one deleted with its sign-in
--     sends nothing.
--   * app.generate_recovery_codes, redefined from 1560 (its only definition), sends 'recovery_codes' with each new
--     set, which replaces the old one.
--
-- The `change` argument picks the sentence of email.kinds.account.security_changed.body in every locale (an ICU
-- select), and factorType names the factor (totp, webauthn or phone). A notice that fails is logged as a warning and
-- never blocks the change itself: Supabase Auth runs the triggers inside its own transaction. Each change sends one
-- notification; account is an urgent category, so it is never held for a digest, and 1620 (orch-notify-access, ADR
-- 0033 decision 62) lets it through quiet hours.

-- 1. Password, email and phone (auth.users) ----------------------------------------------------------------------------

create or replace function private.after_auth_user_security_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_change text;
begin
  foreach v_change in array array[
    case when nullif(new.encrypted_password, '') is distinct from nullif(old.encrypted_password, '') then
      case when nullif(old.encrypted_password, '') is null then 'password_set'
           when nullif(new.encrypted_password, '') is null then 'password_removed'
           else 'password' end end,
    case when nullif(new.email, '') is distinct from nullif(old.email, '') then 'email' end,
    case when nullif(new.phone, '') is distinct from nullif(old.phone, '') then 'phone' end]
  loop
    continue when v_change is null;
    begin
      perform private.notify_account(new.id, 'account.security_changed', jsonb_build_object('change', v_change));
    exception when others then
      raise warning 'account.security_changed (%) was not sent to sign-in %: %', v_change, new.id, sqlerrm;
    end;
  end loop;
  return null;
end;
$$;

comment on function private.after_auth_user_security_change() is 'After Supabase Auth changes a sign-in''s password, email or phone, sends the person account.security_changed once per change (change password, password_set, password_removed, email or phone; A104). A notice that fails is a warning and never blocks the change.';
revoke all on function private.after_auth_user_security_change() from public, anon, authenticated;

create trigger xos_notify_security_change after update of encrypted_password, email, phone on auth.users
  for each row
  when (nullif(new.encrypted_password, '') is distinct from nullif(old.encrypted_password, '')
        or nullif(new.email, '') is distinct from nullif(old.email, '')
        or nullif(new.phone, '') is distinct from nullif(old.phone, ''))
  execute function private.after_auth_user_security_change();

-- 2. Second factors (auth.mfa_factors) ---------------------------------------------------------------------------------

create or replace function private.after_mfa_factor_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_change text;
  v_type text;
begin
  if tg_op = 'DELETE' then
    -- A verified factor removed while its sign-in stays; a factor deleted with its sign-in tells nobody.
    if old.status::text <> 'verified' or not exists (select 1 from auth.users u where u.id = old.user_id) then
      return null;
    end if;
    v_user := old.user_id;
    v_change := 'factor_removed';
    v_type := old.factor_type::text;
  else
    -- Enrollment creates an unverified factor; it counts once its first code or key verifies it.
    if new.status::text <> 'verified' or (tg_op = 'UPDATE' and old.status::text = 'verified') then
      return null;
    end if;
    v_user := new.user_id;
    v_change := 'factor_added';
    v_type := new.factor_type::text;
  end if;
  begin
    perform private.notify_account(v_user, 'account.security_changed',
      jsonb_build_object('change', v_change, 'factorType', v_type));
  exception when others then
    raise warning 'account.security_changed (%) was not sent to sign-in %: %', v_change, v_user, sqlerrm;
  end;
  return null;
end;
$$;

comment on function private.after_mfa_factor_change() is 'After a second factor is verified or a verified one is removed in Supabase Auth, sends the person account.security_changed (change factor_added or factor_removed, with factorType; A104). An unfinished enrollment and a factor deleted with its sign-in send nothing; a notice that fails is a warning and never blocks the change.';
revoke all on function private.after_mfa_factor_change() from public, anon, authenticated;

create trigger xos_notify_factor_change after insert or update of status or delete on auth.mfa_factors
  for each row execute function private.after_mfa_factor_change();

-- 3. Passkeys (auth.webauthn_credentials) -----------------------------------------------------------------------------

create or replace function private.after_passkey_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  v_change text := case when tg_op = 'DELETE' then 'passkey_removed' else 'passkey_added' end;
begin
  if not exists (select 1 from auth.users u where u.id = v_user) then
    return null;
  end if;
  begin
    perform private.notify_account(v_user, 'account.security_changed', jsonb_build_object('change', v_change));
  exception when others then
    raise warning 'account.security_changed (%) was not sent to sign-in %: %', v_change, v_user, sqlerrm;
  end;
  return null;
end;
$$;

comment on function private.after_passkey_change() is 'After a passkey is added to or removed from a sign-in in Supabase Auth, sends the person account.security_changed (change passkey_added or passkey_removed; A104). A passkey deleted with its sign-in sends nothing; a notice that fails is a warning and never blocks the change.';
revoke all on function private.after_passkey_change() from public, anon, authenticated;

-- Supabase Auth creates auth.webauthn_credentials in its own migrations (2026-03, passkeys) before these run, locally and
-- on the hosted project, and its default privileges give postgres TRIGGER on it; an older Auth without passkeys simply
-- has nothing to watch. supautils lets postgres drop triggers only on the auth tables it lists, and this one is not
-- among them: a later change replaces the trigger (create or replace) or the function, never drops it.
do $$
begin
  if to_regclass('auth.webauthn_credentials') is not null
     and has_table_privilege('auth.webauthn_credentials', 'TRIGGER') then
    create trigger xos_notify_passkey_change after insert or delete on auth.webauthn_credentials
      for each row execute function private.after_passkey_change();
  else
    raise notice 'auth.webauthn_credentials is missing or not ours to watch: passkey changes send no notice';
  end if;
end;
$$;

-- 4. Recovery codes (from 1560) ----------------------------------------------------------------------------------------

create or replace function app.generate_recovery_codes()
returns table (code text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_code text;
  v_codes text[] := '{}';
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'a signed-in session is required';
  end if;
  perform private.require_second_factor('make recovery codes');
  if not private.has_verified_second_factor(v_user) then
    perform private.refuse('recovery_codes_need_factor',
      'Set up an authenticator app or a security key first; recovery codes stand in for it.');
  end if;
  delete from private.recovery_codes where user_id = v_user;
  for i in 1..10 loop
    v_code := private.new_recovery_code();
    insert into private.recovery_codes (user_id, code_hash) values (v_user, extensions.crypt(v_code, extensions.gen_salt('bf', 8)));
    v_codes := v_codes || (left(v_code, 5) || '-' || right(v_code, 5));
  end loop;
  perform private.record_security_event(v_user, 'recovery_codes_generated', jsonb_build_object('count', 10));
  -- A new set replaces the old one, so a set someone else made locks the person out of theirs (A104).
  perform private.notify_account(v_user, 'account.security_changed', jsonb_build_object('change', 'recovery_codes'));
  return query select unnest(v_codes);
end;
$$;

comment on function app.generate_recovery_codes() is 'Makes the caller ten new single-use recovery codes and returns them once, as xxxxx-xxxxx; only bcrypt hashes are kept and the old set is deleted. Needs a verified second factor and step-up (one passed in the last 15 minutes); never an API key or an app. Tells the person with account.security_changed (change recovery_codes, A104).';
revoke all on function app.generate_recovery_codes() from public, anon;
grant execute on function app.generate_recovery_codes() to authenticated;
