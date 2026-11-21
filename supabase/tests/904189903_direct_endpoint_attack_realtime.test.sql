-- pgTAP: the attacker's test, Realtime surface (ADR 0169 "Test plan"; release 4.18, block 99; RRR-243). A member of
-- an organization that sets a rule holds a session that breaks it and uses Realtime directly: receives Postgres
-- Changes of a published table (Realtime evaluates the table's select policies with the subscriber's claims for
-- every change), and joins a private channel (Realtime sets realtime.topic and the caller's role, then reads and
-- inserts realtime.messages). The cases are those of the REST file.
--
-- Package 2 (the gate core) created this file. What the gate core decides passes today: for every case the verdict
-- names an organization that refuses the session, which is what the Realtime policies will read. Refusing the
-- change and the join is the work of work package 6: those cases are marked todo and name it, and it removes the
-- marks in this file. The staging probe of 2026-11-21 did not answer what a channel join policy can read (Q3b), so
-- the channel half of package 6 also waits for that question to be run again. No case is skipped, except that a
-- database on which Realtime has made no partition of realtime.messages for today cannot store a message at all;
-- the channel cases then say so by name instead of running.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql
\ir 904180200_session_gate_fixture.psql

select plan(36);

select pg_temp.attack_rules();

-- A document channel, as 2060_realtime_channel_rules.test.sql sets one up.
select pg_temp.as_user('carol');
with x as (insert into app.sops (org_id, code, title, body) values (pg_temp.id('org_a'), 'SOP-169', 'Gate Check', 'Check every gate.') returning id)
insert into world select 'sop', id from x;
insert into world select 'doc', (app.open_doc('app.sops', pg_temp.id('sop'), 'body') ->> 'doc_id')::uuid;
select pg_temp.as_platform();

create function pg_temp.changes() returns integer
language sql as $$ select count(*)::int from app.projects where org_id = pg_temp.id('org_a') $$;

create function pg_temp.join_channel() returns void
language sql as $$ select set_config('realtime.topic', 'doc:' || pg_temp.id('doc'), true) $$;

create function pg_temp.received() returns integer
language sql as $$ select count(*)::int from realtime.messages where topic = 'doc:' || pg_temp.id('doc') $$;

create function pg_temp.send() returns text
language sql as $$
  select format($q$insert into realtime.messages (topic, extension, event, payload, private) values (%L, 'broadcast', 'yjs', '{"update": "AQI="}', true)$q$,
    'doc:' || pg_temp.id('doc'))
$$;

create function pg_temp.refusing() returns integer
language sql as $$ select pg_temp.private_text('select count(*) from private.session_refused_org_ids()')::int $$;

create function pg_temp.partition_today() returns boolean
language sql as $$
  select to_regclass('realtime.messages') is not null and exists (
    select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'realtime.messages'::regclass
      and localtimestamp >= substring(pg_get_expr(c.relpartbound, c.oid) from $re$FROM \('([^']+)'\)$re$)::timestamp
      and localtimestamp < substring(pg_get_expr(c.relpartbound, c.oid) from $re$TO \('([^']+)'\)$re$)::timestamp)
$$;

-- The two channel cases of one scenario: the refused session receives nothing and sends nothing.
create function pg_temp.channel_cases(p_label text, p_todo boolean default true) returns setof text
language plpgsql as $$
begin
  if not pg_temp.partition_today() then
    return next skip('Realtime has made no partition of realtime.messages for today on this database; work package 6 finishes the channel cases', 2);
    return;
  end if;
  perform pg_temp.join_channel();
  if p_todo then
    perform todo('work package 6 (Realtime), once probe question 3b is answered, refuses the join of a private channel', 2);
  end if;
  return next is(pg_temp.received(), 0, p_label || ': a private channel delivers nothing to the session');
  return next throws_ok(pg_temp.send(), '42501', null, p_label || ': and takes nothing from it');
end $$;

-- A session that meets every rule receives changes and uses the channel.
select pg_temp.attack('passing');
select ok(pg_temp.changes() > 0, 'a session that meets every rule receives the changes of its organization''s projects');
create function pg_temp.passing_channel() returns setof text
language plpgsql as $$
begin
  if not pg_temp.partition_today() then
    return next skip('Realtime has made no partition of realtime.messages for today on this database', 2);
    return;
  end if;
  perform pg_temp.join_channel();
  return next lives_ok(pg_temp.send(), 'and broadcasts on a private channel it may write');
  return next is(pg_temp.received(), 1, 'and receives there');
end $$;
select pg_temp.passing_channel();

-- A single-factor session where everyone must verify ---------------------------------------------------------------------------
select pg_temp.attack('mfa');
select is(pg_temp.refusing(), 1, 'mfa: the verdict names the organization that refuses the session');
select todo('work package 6 (Realtime) puts the restrictive select policy on every published table', 1);
select is(pg_temp.changes(), 0, 'mfa: no change of a published table is delivered');
select pg_temp.channel_cases('mfa');

-- A session older than the organization's lifetime -----------------------------------------------------------------------------
select pg_temp.attack('lifetime');
select is(pg_temp.refusing(), 1, 'lifetime: the verdict names the organization that refuses the session');
select todo('work package 6 (Realtime) puts the restrictive select policy on every published table', 1);
select is(pg_temp.changes(), 0, 'lifetime: no change of a published table is delivered');
select pg_temp.channel_cases('lifetime');

-- An idle session ----------------------------------------------------------------------------------------------------------------
select pg_temp.attack('idle');
select is(pg_temp.refusing(), 1, 'idle: the verdict names the organization that refuses the session');
select todo('work package 6 (Realtime) puts the restrictive select policy on every published table', 1);
select is(pg_temp.changes(), 0, 'idle: no change of a published table is delivered');
select pg_temp.channel_cases('idle');

-- An idle session that sends a touch after the timeout ----------------------------------------------------------------------
select pg_temp.attack('idle_touched');
select is(pg_temp.refusing(), 1, 'idle, then a touch: the verdict still names the organization that refuses the session');
select todo('work package 6 (Realtime) puts the restrictive select policy on every published table', 1);
select is(pg_temp.changes(), 0, 'idle, then a touch: no change of a published table is delivered');
select pg_temp.channel_cases('idle, then a touch');

-- A session signed out from another device ------------------------------------------------------------------------------------
select pg_temp.attack('ended');
select is(pg_temp.private_text('select private.session_refusal()'), 'session_ended', 'signed out: the verdict refuses the session as a whole');
select todo('work package 6 (Realtime) puts the restrictive select policy on every published table', 1);
select is(pg_temp.changes(), 0, 'signed out: no change of a published table is delivered');
select pg_temp.channel_cases('signed out');

-- Outside the allow-list, with a session token -------------------------------------------------------------------------------
select pg_temp.attack('network');
select is(pg_temp.refusing(), 1, 'network: the verdict names the organization that refuses the session');
select todo('work package 6 (Realtime) puts the restrictive select policy on every published table', 1);
select is(pg_temp.changes(), 0, 'network: no change of a published table is delivered');
select pg_temp.channel_cases('network');

-- Outside the allow-list, with an API-key token ------------------------------------------------------------------------------
select pg_temp.attack('network_key');
select is(pg_temp.refusing(), 1, 'network, API key: the verdict names the organization that refuses the token');
select todo('work package 6 (Realtime) puts the restrictive select policy on every published table', 1);
select is(pg_temp.changes(), 0, 'network, API key: no change of a published table is delivered');
-- An API key's scopes do not reach a document channel today, so these two already hold; they must keep holding.
select pg_temp.channel_cases('network, API key', false);

-- A token with no session_id claim ---------------------------------------------------------------------------------------------
select pg_temp.attack('no_session_id');
select is(pg_temp.private_text('select private.session_refusal()'), 'session_ended', 'no session_id: the verdict refuses the session as a whole');
select todo('work package 6 (Realtime) puts the restrictive select policy on every published table', 1);
select is(pg_temp.changes(), 0, 'no session_id: no change of a published table is delivered');
select pg_temp.channel_cases('no session_id');

-- Every published table ----------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select todo('work package 6 (Realtime) puts the restrictive select policy on every published table', 1);
select is_empty($$select t.schemaname || '.' || t.tablename from pg_publication_tables t
                  where t.pubname = 'supabase_realtime'
                    and not exists (select 1 from pg_policies p where p.schemaname = t.schemaname and p.tablename = t.tablename
                                    and p.permissive = 'RESTRICTIVE' and p.cmd = 'SELECT')$$,
  'every table in the supabase_realtime publication carries a restrictive select policy');

select * from finish();
rollback;
