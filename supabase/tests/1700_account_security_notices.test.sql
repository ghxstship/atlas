-- pgTAP: migration 1700, account security notices (A104, RRR-149; follow-ups of A77 and A99). Every change to how a
-- person signs in creates exactly one account.security_changed notification for them, through the org they chose last:
-- a password set or changed, the sign-in email or phone changed (auth.users), a second factor verified or a verified one
-- removed (auth.mfa_factors), and a new set of recovery codes (app.generate_recovery_codes). Nothing else on the sign-in
-- sends one: an unfinished enrollment, a write that changes nothing, a factor deleted with its sign-in. Creation only:
-- whether the notice waits out quiet hours is 1620's bypass list (orch-notify-access).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(34);

-- account.security_changed notifications of a person, all of them or those of one change.
create function pg_temp.notices(p_person text, p_change text default null) returns integer
language plpgsql as $$
declare
  v_count integer;
begin
  perform set_config('role', 'postgres', true);
  select count(*)::int into v_count from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_person) and n.kind = 'account.security_changed'
    and (p_change is null or n.message_args ->> 'change' = p_change);
  return v_count;
end $$;

create function pg_temp.add_factor(p_user text, p_type text, p_status text) returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  perform set_config('role', 'postgres', true);
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values (v_id, pg_temp.id(p_user || '_user'), p_type || ' ' || left(v_id::text, 8), p_type::auth.factor_type,
    p_status::auth.factor_status, now(), now(), case when p_type = 'totp' then 'JBSWY3DPEHPK3PXP' end);
  return v_id;
end $$;

select pg_temp.as_platform();

-- Schema ------------------------------------------------------------------------------------------------------------------

select has_trigger('auth', 'users', 'xos_notify_security_change', 'a sign-in''s password, email and phone changes are watched');
select has_trigger('auth', 'mfa_factors', 'xos_notify_factor_change', 'and its second factors');
select has_trigger('auth', 'webauthn_credentials', 'xos_notify_passkey_change', 'and its passkeys');
select ok(not has_function_privilege('authenticated', 'private.after_auth_user_security_change()', 'execute')
  and not has_function_privilege('authenticated', 'private.after_mfa_factor_change()', 'execute')
  and not has_function_privilege('authenticated', 'private.after_passkey_change()', 'execute'),
  'the trigger functions are not callable by a signed-in role');

-- Passwords ---------------------------------------------------------------------------------------------------------------

update auth.users set encrypted_password = extensions.crypt('first-password-1', extensions.gen_salt('bf', 4))
where id = pg_temp.id('dave_user');
select is(pg_temp.notices('dave'), 1, 'a first password creates one notice for dave');
select is(pg_temp.notices('dave', 'password_set'), 1, 'which says a password was added');
select is((select n.org_id from app.notifications n where n.recipient_person_id = pg_temp.id('dave')
  and n.kind = 'account.security_changed'), pg_temp.id('org_a'),
  'through his org, as every account notice goes (private.notify_account)');

update auth.users set encrypted_password = extensions.crypt('second-password-2', extensions.gen_salt('bf', 4))
where id = pg_temp.id('dave_user');
select is(pg_temp.notices('dave', 'password'), 1, 'a changed password creates one notice that says so');

update auth.users set encrypted_password = encrypted_password, last_sign_in_at = now(), email_confirmed_at = now()
where id = pg_temp.id('dave_user');
select is(pg_temp.notices('dave'), 2, 'a write that leaves the password, email and phone as they were sends nothing');

-- Email and phone ---------------------------------------------------------------------------------------------------------

update auth.users set email = 'dave.lindqvist@northwind.test' where id = pg_temp.id('dave_user');
select is(pg_temp.notices('dave', 'email'), 1, 'a confirmed email change creates one notice');

update auth.users set phone = '15555550160', phone_confirmed_at = now() where id = pg_temp.id('dave_user');
select is(pg_temp.notices('dave', 'phone'), 1, 'a phone number added creates one notice');
update auth.users set phone = null, phone_confirmed_at = null where id = pg_temp.id('dave_user');
select is(pg_temp.notices('dave', 'phone'), 2, 'and one more when it is removed');
select is(pg_temp.notices('dave'), 5, 'one notice for each of dave''s five changes');

update auth.users set encrypted_password = extensions.crypt('third-password-3', extensions.gen_salt('bf', 4)),
  phone = '15555550161', phone_confirmed_at = now()
where id = pg_temp.id('erin_user');
select is(pg_temp.notices('erin'), 2, 'two changes in one write create a notice each');

select lives_ok($$update auth.users set encrypted_password = extensions.crypt('fourth-password-4', extensions.gen_salt('bf', 4))
  where id = pg_temp.id('nina_user')$$, 'a sign-in that belongs to no org still changes its password');
select is(pg_temp.notices('nina'), 0, 'and nobody is told, since an account notice needs an org');

-- Second factors ----------------------------------------------------------------------------------------------------------

insert into world values ('dave_totp', pg_temp.add_factor('dave', 'totp', 'unverified'));
select is(pg_temp.notices('dave', 'factor_added'), 0, 'an enrollment nobody finished sends nothing');
update auth.mfa_factors set status = 'verified', updated_at = now() where id = pg_temp.id('dave_totp');
select is(pg_temp.notices('dave', 'factor_added'), 1, 'verifying the factor creates one notice');
select is((select n.message_args ->> 'factorType' from app.notifications n where n.recipient_person_id = pg_temp.id('dave')
  and n.message_args ->> 'change' = 'factor_added'), 'totp', 'naming the kind of factor');
update auth.mfa_factors set friendly_name = 'Work phone', updated_at = now() where id = pg_temp.id('dave_totp');
select is(pg_temp.notices('dave', 'factor_added'), 1, 'renaming a factor sends nothing');

insert into world values ('dave_key', pg_temp.add_factor('dave', 'webauthn', 'verified'));
select is(pg_temp.notices('dave', 'factor_added'), 2, 'a security key verified as it is added creates one more');

insert into world values ('dave_pending', pg_temp.add_factor('dave', 'totp', 'unverified'));
delete from auth.mfa_factors where id = pg_temp.id('dave_pending');
select is(pg_temp.notices('dave', 'factor_removed'), 0, 'an unfinished enrollment deleted sends nothing');
delete from auth.mfa_factors where id = pg_temp.id('dave_key');
select is(pg_temp.notices('dave', 'factor_removed'), 1, 'removing a verified factor creates one notice');
select is(pg_temp.notices('dave'), 8, 'dave has one notice for each of his eight changes');

-- Passkeys ----------------------------------------------------------------------------------------------------------------

insert into auth.webauthn_credentials (user_id, credential_id, public_key, friendly_name)
values (pg_temp.id('dave_user'), '\x0102'::bytea, '\x0304'::bytea, 'Laptop')
returning id as dave_passkey \gset
select is(pg_temp.notices('dave', 'passkey_added'), 1, 'a passkey added creates one notice');
update auth.webauthn_credentials set sign_count = sign_count + 1, last_used_at = now() where id = :'dave_passkey';
select is(pg_temp.notices('dave'), 9, 'signing in with it sends nothing');
delete from auth.webauthn_credentials where id = :'dave_passkey';
select is(pg_temp.notices('dave', 'passkey_removed'), 1, 'removing it creates one notice');

-- A sign-in deleted with its factors ----------------------------------------------------------------------------------------

select pg_temp.add_factor('gina', 'totp', 'verified');
select is(pg_temp.notices('gina', 'factor_added'), 1, 'gina verified a factor');
select lives_ok($$delete from auth.users where id = pg_temp.id('gina_user')$$, 'her sign-in can be deleted');
select is(pg_temp.notices('gina', 'factor_removed'), 0, 'and the factor deleted with it tells nobody');

-- Recovery codes ----------------------------------------------------------------------------------------------------------

select pg_temp.add_factor('alice', 'totp', 'verified');
select pg_temp.as_user_stepped_up('alice');
select is((select count(*)::int from app.generate_recovery_codes()), 10, 'alice makes a set of recovery codes');
select is(pg_temp.notices('alice', 'recovery_codes'), 1, 'which creates one notice');
select is((select count(*)::int from app.generate_recovery_codes()), 10, 'and a new set that replaces it');
select is(pg_temp.notices('alice', 'recovery_codes'), 2, 'which creates one more');

select * from finish();
rollback;
