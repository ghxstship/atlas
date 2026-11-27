-- pgTAP: migration 904180203, the attestation verifier and the ungated helper twins (ADR 0169 work package 2,
-- RRR-243). No key ships, and until one is entered nothing verifies. An attestation verifies when it is signed
-- under the Vault key for the token's own person and session and is younger than five minutes; it does not when it
-- is expired, dated ahead, replayed under another session or another person, forged, altered or malformed. Two
-- keys are accepted at once for a rotation and a short key is ignored. The twins answer as the helpers they copy,
-- and only the gate's own functions use them. The key in this suite is 32 random bytes made when the suite runs.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql
\ir 904180200_session_gate_fixture.psql

select plan(43);

create temporary table made (name text primary key, value text);
grant select, insert on made to public;

insert into world values ('s_dave', pg_temp.as_session('dave', 'aal2', interval '10 minutes'));
insert into world values ('s_dave_other', pg_temp.as_session('dave', 'aal1', interval '10 minutes'));
insert into world values ('s_mia', pg_temp.as_session('mia', 'aal1', interval '10 minutes'));
select pg_temp.as_platform();

create function pg_temp.verified(p_attestation text, p_user text default 'dave', p_session text default 's_dave') returns boolean
language sql as $$
  select a.verified from private.verify_attestation(p_attestation, pg_temp.id(p_user || '_user'), pg_temp.id(p_session)) a;
$$;

-- No key ships ------------------------------------------------------------------------------------------------------------------

select is((select count(*)::int from vault.secrets where name in ('xos_data_attest_key', 'xos_data_attest_key_next')), 0,
  'no migration creates the attestation key: the owner enters it');
select is(private.attestation_keys(), '{}'::text[], 'so the verifier holds no key');
select is(pg_temp.verified(pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('s_dave'), '203.0.113.9', p_key => repeat('a', 64))), false,
  'and until a key is entered no attestation verifies, whatever it was signed with');

-- A key of this run's own ------------------------------------------------------------------------------------------------------

select ok(pg_temp.attest_key() ~ '^[0-9a-f]{64}$', 'the suite makes its own random key in Vault');
select is(cardinality(private.attestation_keys()), 1, 'the verifier reads it under the name xos_data_attest_key');
insert into made values ('valid', pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('s_dave'), '203.0.113.9'));

-- Valid ------------------------------------------------------------------------------------------------------------------------

select results_eq($$select a.verified, a.client_address, a.signed_at = date_trunc('second', now())
                    from private.verify_attestation((select value from made where name = 'valid'), pg_temp.id('dave_user'), pg_temp.id('s_dave')) a$$,
  $$values (true, '203.0.113.9'::inet, true)$$, 'a fresh attestation for the token''s person and session verifies and gives its address and time');
select is(pg_temp.verified(pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('s_dave'), '203.0.113.9', interval '4 minutes')), true,
  'one signed four minutes ago still verifies');
select is(pg_temp.verified(pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('s_dave'), '203.0.113.9', interval '-30 seconds')), true,
  'a server clock half a minute ahead is tolerated');
select results_eq($$select a.verified, a.client_address
                    from private.verify_attestation(pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('s_dave'), null),
                      pg_temp.id('dave_user'), pg_temp.id('s_dave')) a$$,
  $$values (true, null::inet)$$, 'a server that knew no address attests the call and no address');
select results_eq($$select a.verified, a.client_address
                    from private.verify_attestation(pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('s_dave'), '::ffff:203.0.113.9'),
                      pg_temp.id('dave_user'), pg_temp.id('s_dave')) a$$,
  $$values (true, '203.0.113.9'::inet)$$, 'an IPv4 client seen through IPv6 is attested as IPv4');
select results_eq($$select a.verified, a.client_address
                    from private.verify_attestation(pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('s_dave'), '999.1.1.1'),
                      pg_temp.id('dave_user'), pg_temp.id('s_dave')) a$$,
  $$values (true, null::inet)$$, 'a signed value that is no address attests the call and no address');
select is((select a.verified from private.verify_attestation(pg_temp.attestation(pg_temp.id('dave_user'), null, '203.0.113.9'),
            pg_temp.id('dave_user'), null) a), true, 'a token that names no session, an API key through our servers, is attested with sid none');

-- Expired ----------------------------------------------------------------------------------------------------------------------

select is(pg_temp.verified(pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('s_dave'), '203.0.113.9', interval '5 minutes')), false,
  'expired: an attestation five minutes old does not verify');
select is(pg_temp.verified(pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('s_dave'), '203.0.113.9', interval '3 hours')), false,
  'expired: nor one three hours old');
select is(pg_temp.verified(pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('s_dave'), '203.0.113.9', interval '-2 minutes')), false,
  'dated two minutes ahead: refused');

-- Replayed ---------------------------------------------------------------------------------------------------------------------

select is(pg_temp.verified((select value from made where name = 'valid'), 'dave', 's_dave_other'), false,
  'replayed under another session of the same person: refused');
select is(pg_temp.verified((select value from made where name = 'valid'), 'mia', 's_mia'), false,
  'replayed under another person''s token: refused');
select is(pg_temp.verified((select value from made where name = 'valid'), 'mia', 's_dave'), false,
  'replayed under another person with the first session''s id: refused');
select is((select a.verified from private.verify_attestation((select value from made where name = 'valid'), pg_temp.id('dave_user'), null) a), false,
  'replayed under a token that names no session: refused');
select is(pg_temp.verified(pg_temp.attestation(pg_temp.id('dave_user'), null, '203.0.113.9')), false,
  'an attestation signed for no session is refused under a session token');
select is(pg_temp.verified((select value from made where name = 'valid')), true,
  'presented again by the same session inside five minutes it verifies: the window and the binding are the replay guard');

-- Forged -----------------------------------------------------------------------------------------------------------------------

select is(pg_temp.verified(pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('s_dave'), '203.0.113.9', p_key => repeat('b', 64))), false,
  'forged: signed with another key');
select is(pg_temp.verified(replace((select value from made where name = 'valid'), 'a=203.0.113.9', 'a=203.0.113.10')), false,
  'forged: the address changed after signing');
select is(pg_temp.verified(regexp_replace((select value from made where name = 'valid'), 't=[0-9]+', 't=' || (extract(epoch from now())::bigint + 20))), false,
  'forged: the time changed after signing');
select is(pg_temp.verified(regexp_replace((select value from made where name = 'valid'), 's=[0-9a-f]{64}$', 's=' || repeat('0', 64))), false,
  'forged: a made-up signature');
select is(pg_temp.verified(upper((select value from made where name = 'valid'))), false, 'forged: another spelling of the same text');

-- Malformed --------------------------------------------------------------------------------------------------------------------

select is(pg_temp.verified(null), false, 'no attestation: a direct call');
select is(pg_temp.verified(''), false, 'an empty header');
select is(pg_temp.verified('v1,t=1,a=unknown,sid=none'), false, 'an attestation with no signature');
select is(pg_temp.verified((select value from made where name = 'valid') || repeat(' ', 200)), false, 'an attestation longer than 256 characters');
select is(pg_temp.verified('v2' || substr((select value from made where name = 'valid'), 3)), false, 'another version');
select is((select count(*)::int from private.verify_attestation('garbage', pg_temp.id('dave_user'), pg_temp.id('s_dave'))), 1,
  'the verifier always answers with one row');

-- Two keys at once, and a short key ---------------------------------------------------------------------------------------------

select vault.create_secret(repeat('k', 16), 'xos_data_attest_key_next', 'pgTAP: too short on purpose');
select is(cardinality(private.attestation_keys()), 1, 'a key shorter than 32 characters is ignored');
select is(pg_temp.verified(pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('s_dave'), '203.0.113.9', p_key => repeat('k', 16))), false,
  'and an attestation signed with it does not verify');
delete from vault.secrets where name = 'xos_data_attest_key_next';
insert into made values ('next', pg_temp.attest_key('xos_data_attest_key_next'));
select is(pg_temp.verified(pg_temp.attestation(pg_temp.id('dave_user'), pg_temp.id('s_dave'), '203.0.113.9', p_key => (select value from made where name = 'next'))),
  true, 'rotation: an attestation signed with the next key verifies');
select is(pg_temp.verified((select value from made where name = 'valid')), true, 'rotation: and the current key still does');

-- On the request ---------------------------------------------------------------------------------------------------------------

select pg_temp.present_token(pg_temp.access_token(pg_temp.id('dave_user'), pg_temp.id('s_dave'), 'aal2',
  pg_temp.amr('password', interval '10 minutes', 'totp', interval '1 minute')));
select pg_temp.request_headers(jsonb_build_object('x-xos-attestation', (select value from made where name = 'valid')));
select is(pg_temp.private_text($$select a.verified::text || ' ' || host(a.client_address) from private.request_attestation() a$$), 'true 203.0.113.9',
  'the header x-xos-attestation is read from the request and verified against the token''s own sub and session_id');
select pg_temp.as_session('mia', 'aal1', interval '10 minutes');
select is(pg_temp.private_text($$select a.verified::text from private.request_attestation() a$$), 'false',
  'the same header under another person''s token is no attestation');
select pg_temp.request_headers(null);
select pg_temp.as_platform();

-- The readers of forwarding headers --------------------------------------------------------------------------------------------

select set_eq($$select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname in ('app', 'private', 'api_public', 'api_external', 'gate') and p.prosrc ~* 'x-forwarded-for|x-real-ip'$$,
  $$values ('private.request_ip')$$,
  'private.request_ip is the only function that reads a forwarding header; the verifier reads x-xos-attestation and nothing else');

-- The twins --------------------------------------------------------------------------------------------------------------------

select pg_temp.claims('mia');
select set_eq($$select private.my_org_ids_base()$$, $$select private.my_org_ids()$$, 'with every control off, private.my_org_ids_base answers as private.my_org_ids');
select set_eq($$select private.my_membership_ids_base()$$, $$select private.my_membership_ids()$$,
  'private.my_membership_ids_base answers as private.my_membership_ids');
select is(private.person_capability_reach_base(pg_temp.id('alice'), pg_temp.id('org_a'), 'org.security.write', true),
  private.person_capability_reach(pg_temp.id('alice'), pg_temp.id('org_a'), 'org.security.write', true),
  'private.person_capability_reach_base answers as private.person_capability_reach');
select pg_temp.as_platform();
select set_eq($$select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname not in ('pg_catalog', 'information_schema')
                  and p.prosrc ~ '(my_org_ids_base|my_membership_ids_base|person_capability_reach_base)'$$,
  $$values ('app.network_access'), ('app.my_session_gate'), ('app.start_break_glass'), ('private.person_capability_reach_base')$$,
  'only the gate''s recovery functions reference a twin (the reach twin calls itself for delegations)');

select * from finish();
rollback;
