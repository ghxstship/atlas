-- pgTAP: the attacker's test, Storage surface (ADR 0169 "Test plan"; release 4.18, block 99; RRR-243). A member of
-- an organization that sets a rule holds a session that breaks it and reads and writes an object in the imports
-- bucket directly through the Storage API. The imports bucket is keyed by person, not by organization, so it is
-- closed to a session that any organization refuses (ADR 0169 D6). The cases are those of the REST file.
--
-- Package 2 (the gate core) created this file. What the gate core decides passes today: for every case the verdict
-- names an organization that refuses the session, which is what the Storage policy will read. Refusing the object
-- itself is the work of the restrictive policy storage_objects_session_gate: those cases are marked todo and name
-- work package 5, which removes the marks in this file. No case is skipped.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql
\ir 904180200_session_gate_fixture.psql

select plan(27);

select pg_temp.attack_rules();

-- The spreadsheet Bob uploaded while his session met every rule.
select pg_temp.attack('passing');
select lives_ok(format($$insert into storage.objects (bucket_id, name, owner_id) values ('imports', '%s/%s.csv', '%s')$$,
  pg_temp.id('bob'), gen_random_uuid(), pg_temp.id('bob_user')), 'a session that meets every rule uploads into its own imports folder');
select is((select count(*)::int from storage.objects where bucket_id = 'imports'), 1, 'and reads its upload back');

create function pg_temp.reads() returns integer
language sql as $$ select count(*)::int from storage.objects where bucket_id = 'imports' $$;

create function pg_temp.upload() returns text
language sql as $$
  select format($q$insert into storage.objects (bucket_id, name, owner_id) values ('imports', '%s/%s.csv', '%s')$q$,
    pg_temp.id('bob'), gen_random_uuid(), pg_temp.id('bob_user'))
$$;

create function pg_temp.refusing() returns integer
language sql as $$ select pg_temp.private_text('select count(*) from private.session_refused_org_ids()')::int $$;

-- A single-factor session where everyone must verify ---------------------------------------------------------------------------
select pg_temp.attack('mfa');
select is(pg_temp.refusing(), 1, 'mfa: the verdict names the organization that refuses the session');
select todo('work package 5 (the Storage policy storage_objects_session_gate) closes the imports bucket to a session an organization refuses', 2);
select is(pg_temp.reads(), 0, 'mfa: reading an object in the imports bucket is refused');
select throws_ok(pg_temp.upload(), '42501', null, 'mfa: writing an object in the imports bucket is refused');

-- A session older than the organization's lifetime -----------------------------------------------------------------------------
select pg_temp.attack('lifetime');
select is(pg_temp.refusing(), 1, 'lifetime: the verdict names the organization that refuses the session');
select todo('work package 5 (the Storage policy storage_objects_session_gate) closes the imports bucket to a session an organization refuses', 2);
select is(pg_temp.reads(), 0, 'lifetime: reading an object in the imports bucket is refused');
select throws_ok(pg_temp.upload(), '42501', null, 'lifetime: writing an object in the imports bucket is refused');

-- An idle session ----------------------------------------------------------------------------------------------------------------
select pg_temp.attack('idle');
select is(pg_temp.refusing(), 1, 'idle: the verdict names the organization that refuses the session');
select todo('work package 5 (the Storage policy storage_objects_session_gate) closes the imports bucket to a session an organization refuses', 2);
select is(pg_temp.reads(), 0, 'idle: reading an object in the imports bucket is refused');
select throws_ok(pg_temp.upload(), '42501', null, 'idle: writing an object in the imports bucket is refused');

-- An idle session that sends a touch after the timeout ----------------------------------------------------------------------
select pg_temp.attack('idle_touched');
select is(pg_temp.refusing(), 1, 'idle, then a touch: the verdict still names the organization that refuses the session');
select todo('work package 5 (the Storage policy storage_objects_session_gate) closes the imports bucket to a session an organization refuses', 2);
select is(pg_temp.reads(), 0, 'idle, then a touch: reading an object in the imports bucket is refused');
select throws_ok(pg_temp.upload(), '42501', null, 'idle, then a touch: writing an object in the imports bucket is refused');

-- A session signed out from another device ------------------------------------------------------------------------------------
select pg_temp.attack('ended');
select is(pg_temp.private_text('select private.session_refusal()'), 'session_ended', 'signed out: the verdict refuses the session as a whole');
select todo('work package 5 (the Storage policy storage_objects_session_gate) closes every bucket to a session refused as a whole', 2);
select is(pg_temp.reads(), 0, 'signed out: reading an object in the imports bucket is refused');
select throws_ok(pg_temp.upload(), '42501', null, 'signed out: writing an object in the imports bucket is refused');

-- Outside the allow-list, with a session token -------------------------------------------------------------------------------
select pg_temp.attack('network');
select is(pg_temp.refusing(), 1, 'network: the verdict names the organization that refuses the session');
select todo('work package 5 (the Storage policy storage_objects_session_gate) closes the imports bucket to a session an organization refuses', 2);
select is(pg_temp.reads(), 0, 'network: reading an object in the imports bucket is refused');
select throws_ok(pg_temp.upload(), '42501', null, 'network: writing an object in the imports bucket is refused');

-- Outside the allow-list, with an API-key token ------------------------------------------------------------------------------
select pg_temp.attack('network_key');
select is(pg_temp.refusing(), 1, 'network, API key: the verdict names the organization that refuses the token');
select todo('work package 5 (the Storage policy storage_objects_session_gate) closes the imports bucket to a token an organization refuses', 2);
select is(pg_temp.reads(), 0, 'network, API key: reading an object in the imports bucket is refused');
select throws_ok(pg_temp.upload(), '42501', null, 'network, API key: writing an object in the imports bucket is refused');

-- A token with no session_id claim ---------------------------------------------------------------------------------------------
select pg_temp.attack('no_session_id');
select is(pg_temp.private_text('select private.session_refusal()'), 'session_ended', 'no session_id: the verdict refuses the session as a whole');
select todo('work package 5 (the Storage policy storage_objects_session_gate) closes every bucket to a session refused as a whole', 2);
select is(pg_temp.reads(), 0, 'no session_id: reading an object in the imports bucket is refused');
select throws_ok(pg_temp.upload(), '42501', null, 'no session_id: writing an object in the imports bucket is refused');

-- The policy is not there yet --------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select todo('work package 5 creates the restrictive policy storage_objects_session_gate on storage.objects', 1);
select ok(exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                  and policyname = 'storage_objects_session_gate' and permissive = 'RESTRICTIVE'),
  'storage.objects carries the restrictive policy storage_objects_session_gate');

select * from finish();
rollback;
