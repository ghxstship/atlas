-- 1560_recovery_codes.sql
-- A99 Authentication follow-ups (RRR-144; finding A54-001, ADR 0055). Section 7.5 invariant 8: "Access codes, second
-- factors, recovery codes and kiosk PINs are stored hashed and shown once." Supabase Auth's own recovery codes sit behind
-- a setting the local CLI cannot turn on, so XOS issues them itself, on top of Supabase Auth's second factors:
--
--   * app.generate_recovery_codes() makes ten single-use codes server side and returns them once. Only a bcrypt hash of
--     each is stored (private.recovery_codes). Making a new set deletes the old one. It needs a second factor the person
--     holds and one passed in the last 15 minutes (private.require_second_factor), like any change to how they sign in.
--   * app.redeem_recovery_code(code) answers the sign-in challenge or step-up with a code. It is the only way a code
--     raises a session, and it works only on the caller's own live session, named by the session_id claim of the JWT
--     PostgREST verified. A code that matches is spent in the same transaction (row locks queue parallel attempts), the
--     session gets the method `mfa/recovery_code` in auth.mfa_amr_claims and aal2 in auth.sessions, exactly what Supabase
--     Auth writes when a factor verifies, and the client refreshes its session to receive the aal2 token. A spent code
--     never matches again, so a replayed request is refused.
--   * Wrong codes count against the person: five in 15 minutes and every attempt is refused until the window passes.
--     Failures return an outcome instead of raising, so the count survives the transaction.
--   * Using a code, making a set and clearing one are written to private.account_security_events, and using one sends
--     the person account.recovery_code_used (category account: urgent, never held for a digest).
--   * Codes only stand in for a second factor: without a verified one they are refused and app.prune_recovery_codes()
--     deletes them after the last factor goes.
--   * private.second_factor_at() counts `mfa/recovery_code`, so the step-up check treats a code like any second factor.

-- Session claims ------------------------------------------------------------------------------------------------------------

create or replace function private.session_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case when (c ->> 'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (c ->> 'session_id')::uuid end
  from (select nullif(current_setting('request.jwt.claims', true), '')::jsonb as c) claims;
$$;

comment on function private.session_id() is 'The Supabase Auth session (auth.sessions.id) named by the session_id claim of the verified JWT, or NULL.';
revoke all on function private.session_id() from public, anon, authenticated;

create or replace function private.has_verified_second_factor(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.mfa_factors f
    where f.user_id = p_user_id and f.status = 'verified' and f.factor_type::text in ('totp', 'webauthn', 'phone'));
$$;

comment on function private.has_verified_second_factor(uuid) is 'Whether a sign-in holds a verified second factor in Supabase Auth: an authenticator app, a security key or passkey enrolled as a second factor, or a phone.';
revoke all on function private.has_verified_second_factor(uuid) from public, anon, authenticated;

-- Redefined from 1330 (its latest definition) to count a recovery code as a second factor.
create or replace function private.second_factor_at()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select private.session_amr_at(array['totp', 'mfa/totp', 'mfa/webauthn', 'mfa/phone', 'phone', 'mfa/recovery_code']);
$$;

comment on function private.second_factor_at() is 'When the session last passed a second factor (TOTP, a security key or passkey enrolled as a second factor, or a recovery code), or NULL. A passkey sign-in (amr passkey) is a first factor and does not count.';
revoke all on function private.second_factor_at() from public, anon, authenticated;

-- Tables --------------------------------------------------------------------------------------------------------------------

create table private.recovery_codes (
  id uuid primary key default private.uuid_v7(),
  user_id uuid not null references auth.users (id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  used_session_id uuid,
  constraint recovery_codes_hash_bcrypt check (code_hash ~ '^\$2[abxy]\$[0-9]{2}\$'),
  constraint recovery_codes_used_together check ((used_at is null) = (used_session_id is null))
);

create index recovery_codes_user_idx on private.recovery_codes (user_id);

alter table private.recovery_codes enable row level security;
revoke all on private.recovery_codes from public, anon, authenticated;

comment on table private.recovery_codes is 'Single-use MFA recovery codes (Section 7.5 invariant 8, ADR 0055): ten per sign-in, stored only as bcrypt hashes, shown once by app.generate_recovery_codes and spent by app.redeem_recovery_code. Never selectable by any signed-in role.';
comment on column private.recovery_codes.id is 'Code id.';
comment on column private.recovery_codes.user_id is 'Sign-in the code belongs to.';
comment on column private.recovery_codes.code_hash is 'bcrypt hash of the normalized code (ten characters, lower case, no separator); the code itself is never stored.';
comment on column private.recovery_codes.created_at is 'When the set the code belongs to was made.';
comment on column private.recovery_codes.used_at is 'When the code was spent; a spent code never matches again.';
comment on column private.recovery_codes.used_session_id is 'Supabase Auth session the code raised to aal2 (not a foreign key: the session row goes when it ends).';

create table private.account_security_events (
  id uuid primary key default private.uuid_v7(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  session_id uuid,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint account_security_events_kind check (kind in (
    'recovery_codes_generated', 'recovery_code_used', 'recovery_code_refused', 'recovery_codes_cleared',
    'session_signed_out', 'other_sessions_signed_out')),
  constraint account_security_events_detail_object check (jsonb_typeof(detail) = 'object')
);

create index account_security_events_user_idx on private.account_security_events (user_id, occurred_at desc);

alter table private.account_security_events enable row level security;
revoke all on private.account_security_events from public, anon, authenticated;

comment on table private.account_security_events is 'The audit trail of a person''s own sign-in security (ADR 0055): recovery codes made, used, refused or cleared, and sessions signed out from Personal settings, Security. Append-only; read by the person through app.my_security_events. Org audit events stay in app.audit_events.';
comment on column private.account_security_events.id is 'Event id.';
comment on column private.account_security_events.user_id is 'Sign-in the event is about.';
comment on column private.account_security_events.kind is 'What happened: recovery_codes_generated, recovery_code_used, recovery_code_refused, recovery_codes_cleared, session_signed_out or other_sessions_signed_out.';
comment on column private.account_security_events.session_id is 'Supabase Auth session that acted, from the JWT.';
comment on column private.account_security_events.detail is 'Facts of the event, for example the codes left after one was used or how many sessions were signed out.';
comment on column private.account_security_events.occurred_at is 'When it happened.';

create or replace function private.guard_account_security_events()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.refuse('account_security_events_append_only', 'The account security trail is never edited.');
  return null;
end;
$$;

comment on function private.guard_account_security_events() is 'Keeps private.account_security_events append-only: rows go only when their sign-in is deleted.';
revoke all on function private.guard_account_security_events() from public, anon, authenticated;

create trigger t40_guard_account_security_events before update on private.account_security_events
  for each row execute function private.guard_account_security_events();

-- Helpers -------------------------------------------------------------------------------------------------------------------

create or replace function private.record_security_event(p_user_id uuid, p_kind text, p_detail jsonb default '{}'::jsonb)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.account_security_events (user_id, kind, session_id, detail)
  values (p_user_id, p_kind, private.session_id(), coalesce(p_detail, '{}'::jsonb));
$$;

comment on function private.record_security_event(uuid, text, jsonb) is 'Writes one event to a person''s account security trail, with the acting session from the JWT.';
revoke all on function private.record_security_event(uuid, text, jsonb) from public, anon, authenticated;

create or replace function private.notify_account(p_user_id uuid, p_kind text, p_message_args jsonb default '{}'::jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid;
  v_org uuid;
begin
  select p.id into v_person from app.people p where p.user_id = p_user_id and p.deleted_at is null;
  if v_person is null then
    return null;
  end if;
  -- An account notice is about the person, not an org: it goes through the org they chose last, else their newest
  -- membership, else an org they work with as an external party, so it reaches them once with their own channels.
  select s.org_id into v_org from app.active_org_selections s
  where s.user_id = p_user_id and private.user_holds_active_membership(p_user_id, s.org_id);
  if v_org is null then
    select m.org_id into v_org from app.memberships m
    where m.person_id = v_person and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    order by m.valid_from desc limit 1;
  end if;
  if v_org is null then
    select o into v_org from private.party_org_ids(v_person) o limit 1;
  end if;
  if v_org is null then
    return null;
  end if;
  return private.notify(v_org, v_person, p_kind, null, null, null, coalesce(p_message_args, '{}'::jsonb));
end;
$$;

comment on function private.notify_account(uuid, text, jsonb) is 'Sends a person an account notice (account.* kinds) once, through the org they chose last, their newest membership or an org they work with externally. NULL when they belong to none.';
revoke all on function private.notify_account(uuid, text, jsonb) from public, anon, authenticated;

create or replace function private.new_recovery_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  -- 32 symbols, so a random byte maps without bias; no i, l, o or u, which read as 1, 1, 0 and v.
  c_alphabet constant text := '0123456789abcdefghjkmnpqrstvwxyz';
  v_bytes bytea := extensions.gen_random_bytes(10);
  v_code text := '';
begin
  for i in 0..9 loop
    v_code := v_code || substr(c_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  return v_code;
end;
$$;

comment on function private.new_recovery_code() is 'Ten random characters from a 32-symbol alphabet (50 bits), from pgcrypto''s strong random bytes.';
revoke all on function private.new_recovery_code() from public, anon, authenticated;

create or replace function private.normalize_recovery_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when n ~ '^[0-9a-hjkmnp-tv-z]{10}$' then n end
  from (select translate(lower(regexp_replace(coalesce(p_code, ''), '[[:space:]-]', '', 'g')), 'ilo', '110') as n) s;
$$;

comment on function private.normalize_recovery_code(text) is 'A typed recovery code as stored: case, spaces and the hyphen ignored, i and l read as 1 and o as 0. NULL when it cannot be a code.';
revoke all on function private.normalize_recovery_code(text) from public, anon, authenticated;

-- Making, reading and spending codes ----------------------------------------------------------------------------------------

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
  return query select unnest(v_codes);
end;
$$;

comment on function app.generate_recovery_codes() is 'Makes the caller ten new single-use recovery codes and returns them once, as xxxxx-xxxxx; only bcrypt hashes are kept and the old set is deleted. Needs a verified second factor and step-up (one passed in the last 15 minutes); never an API key or an app.';
revoke all on function app.generate_recovery_codes() from public, anon;
grant execute on function app.generate_recovery_codes() to authenticated;

create or replace function app.my_recovery_code_status()
returns table (total integer, remaining integer, created_at timestamptz, last_used_at timestamptz, usable boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer,
         (count(*) filter (where c.used_at is null))::integer,
         min(c.created_at),
         max(c.used_at),
         count(*) filter (where c.used_at is null) > 0 and private.has_verified_second_factor((select auth.uid()))
  from private.recovery_codes c
  where c.user_id = (select auth.uid());
$$;

comment on function app.my_recovery_code_status() is 'The caller''s recovery codes: how many were made, how many are left, when the set was made and last used, and whether one can be used now (a code is left and a second factor is held). Never the codes.';
revoke all on function app.my_recovery_code_status() from public, anon;
grant execute on function app.my_recovery_code_status() to authenticated;

create or replace function app.redeem_recovery_code(p_code text)
returns table (outcome text, remaining integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_session uuid := private.session_id();
  v_code text := private.normalize_recovery_code(p_code);
  v_row private.recovery_codes;
  v_match uuid;
  v_left integer;
begin
  perform private.require_read_write();
  if v_user is null then
    raise exception using errcode = '42501', message = 'a signed-in session is required';
  end if;
  if private.api_key_scopes() is not null then
    perform private.refuse('step_up_session_only', 'A recovery code needs a signed-in session, never an API key or an app.');
  end if;
  if v_session is null or not exists (
      select 1 from auth.sessions s
      where s.id = v_session and s.user_id = v_user and (s.not_after is null or s.not_after > now())) then
    raise exception using errcode = '42501', message = 'session not found';
  end if;
  if private.rate_limit_exceeded('recovery_code.failure', v_user::text, 5, interval '15 minutes') then
    return query select 'rate_limited'::text, null::integer;
    return;
  end if;
  if not private.has_verified_second_factor(v_user) then
    return query select 'no_codes'::text, null::integer;
    return;
  end if;

  if v_code is not null then
    -- Lock the unspent codes, so a parallel attempt with the same code waits and then finds it spent.
    for v_row in
      select * from private.recovery_codes c where c.user_id = v_user and c.used_at is null order by c.id for update
    loop
      if extensions.crypt(v_code, v_row.code_hash) = v_row.code_hash then
        v_match := v_row.id;
        exit;
      end if;
    end loop;
  end if;

  if v_match is null then
    perform private.note_rate_event('recovery_code.failure', v_user::text);
    perform private.record_security_event(v_user, 'recovery_code_refused');
    return query select 'code_invalid'::text, null::integer;
    return;
  end if;

  update private.recovery_codes set used_at = now(), used_session_id = v_session where id = v_match;
  -- The session passed a second factor now: the rows Supabase Auth itself writes when a factor verifies. The next
  -- token refresh carries aal2 and the method with this time.
  insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
  values (gen_random_uuid(), v_session, now(), now(), 'mfa/recovery_code')
  on conflict on constraint mfa_amr_claims_session_id_authentication_method_pkey
  do update set updated_at = excluded.updated_at;
  update auth.sessions set aal = 'aal2', updated_at = now() where id = v_session;

  select count(*)::integer into v_left from private.recovery_codes c where c.user_id = v_user and c.used_at is null;
  perform private.record_security_event(v_user, 'recovery_code_used', jsonb_build_object('remaining', v_left));
  perform private.notify_account(v_user, 'account.recovery_code_used', jsonb_build_object('remaining', v_left));
  return query select 'ok'::text, v_left;
end;
$$;

comment on function app.redeem_recovery_code(text) is 'Answers the sign-in challenge or step-up with one of the caller''s recovery codes (ADR 0055): a match is spent and raises the caller''s own session to aal2 (refresh the session to receive the token). Outcomes: ok with the codes left, code_invalid (counted), rate_limited after 5 wrong codes in 15 minutes, no_codes without a second factor. Never an API key or an app; POST only.';
revoke all on function app.redeem_recovery_code(text) from public, anon;
grant execute on function app.redeem_recovery_code(text) to authenticated;

create or replace function app.prune_recovery_codes()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_count integer;
begin
  if v_user is null or private.has_verified_second_factor(v_user) then
    return false;
  end if;
  delete from private.recovery_codes where user_id = v_user;
  get diagnostics v_count = row_count;
  if v_count > 0 then
    perform private.record_security_event(v_user, 'recovery_codes_cleared', jsonb_build_object('count', v_count));
  end if;
  return v_count > 0;
end;
$$;

comment on function app.prune_recovery_codes() is 'Deletes the caller''s recovery codes once they hold no verified second factor (called after a factor is removed). True when codes were deleted.';
revoke all on function app.prune_recovery_codes() from public, anon;
grant execute on function app.prune_recovery_codes() to authenticated;

create or replace function app.my_security_events(p_limit integer default 50)
returns table (kind text, occurred_at timestamptz, detail jsonb, this_session boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select e.kind, e.occurred_at, e.detail, e.session_id is not distinct from private.session_id()
  from private.account_security_events e
  where e.user_id = (select auth.uid())
  order by e.occurred_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

comment on function app.my_security_events(integer) is 'The caller''s own account security trail, newest first (1 to 200 events, 50 by default).';
revoke all on function app.my_security_events(integer) from public, anon;
grant execute on function app.my_security_events(integer) to authenticated;
