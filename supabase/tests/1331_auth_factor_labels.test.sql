-- pgTAP: migration 1331, second-factor labels (A77, RRR-122). A person renames their own second factors only; another
-- person's factor reads as not found; a label is 1 to 80 characters and goes with its factor. The table is private: signed-in
-- callers reach it only through the two RPCs. Anon denied.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(10);

select pg_temp.as_platform();
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), pg_temp.id('alice_user'), 'Phone', 'totp', 'verified', now(), now());
insert into world select 'alice_factor', f.id from auth.mfa_factors f where f.user_id = pg_temp.id('alice_user');
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), pg_temp.id('bob_user'), 'Key', 'webauthn', 'verified', now(), now());
insert into world select 'bob_factor', f.id from auth.mfa_factors f where f.user_id = pg_temp.id('bob_user');

select has_table('private', 'auth_factor_labels', 'private.auth_factor_labels exists');

select pg_temp.as_user('alice');
select lives_ok($$select app.set_auth_factor_label((select id from world where key = 'alice_factor'), '  Work phone  ')$$,
  'a person renames their own factor');
select is((select label from app.my_auth_factor_labels()), 'Work phone', 'and reads the trimmed name back');
select lives_ok($$select app.set_auth_factor_label((select id from world where key = 'alice_factor'), 'Old phone')$$,
  'renaming again replaces the name');
select is((select count(*)::int from app.my_auth_factor_labels()), 1, 'one name per factor');
select throws_ok($$select app.set_auth_factor_label((select id from world where key = 'alice_factor'), '   ')$$,
  'XR001', 'factor_label_length: Name the factor in 1 to 80 characters.', 'a blank name is refused');
select throws_ok($$select app.set_auth_factor_label((select id from world where key = 'bob_factor'), 'Mine now')$$,
  '42501', 'factor not found', 'another person''s factor reads as not found');
select throws_ok($$select * from private.auth_factor_labels$$, '42501', null, 'the table itself is private');

select pg_temp.as_platform();
delete from auth.mfa_factors where id = pg_temp.id('alice_factor');
select is((select count(*)::int from private.auth_factor_labels where user_id = pg_temp.id('alice_user')), 0,
  'removing the factor removes its name');

select pg_temp.as_anon();
select throws_ok($$select * from app.my_auth_factor_labels()$$, '42501', null, 'anon cannot read names');

select * from finish();
rollback;
