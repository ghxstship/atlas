-- pgTAP: migration 1472, platform support sessions (A90, RRR-135, finding A65-009; Section 8 "Platform operator
-- access"). Only the org's Owner grants the platform team a session of 1 to 24 hours with a reason; it issues no
-- record grants, so operators read nothing through Atlas policies; while it is open a Support operator reads four
-- areas through the console, each read logged for the org (accesses, audit ledger) and in the console ledger; the
-- Owner and audit readers see who opened what; ending the session ends access. Partner sessions keep working
-- beside it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(31);

create function pg_temp.as_op(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

select pg_temp.new_user('olga', 'olga@platform.test', 'Olga Brandt');
select pg_temp.new_user('omar', 'omar@platform.test', 'Omar Haddad');
select pg_temp.new_user('tess', 'tess@platform.test', 'Tess Morales');
select pg_temp.as_platform();
select private.grant_platform_operator('olga@platform.test', 'Administrator', 'First platform administrator.');
select private.grant_platform_operator('omar@platform.test', 'Support', 'Support on call.');
select private.grant_platform_operator('tess@platform.test', 'Trust and Safety', 'Moderation.');

-- No session, no access ------------------------------------------------------------------------------------------------
select pg_temp.as_op('omar');
select is((select count(*)::int from app.console_support_sessions()), 0, 'no platform session is open');
select throws_ok(format($$select app.console_support_view(%L, 'Members')$$, gen_random_uuid()), '42501', null,
  'an operator opens nothing without one');
select is((select count(*)::int from app.memberships where org_id = pg_temp.id('org_a')), 0,
  'and reads no tenant row through Atlas policies');

-- The Owner grants it ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select app.grant_platform_support_session(%L, 4, 'Help.')$$, pg_temp.id('org_a')), '42501', null,
  'a Viewer cannot grant the platform access');
select pg_temp.as_user('alice');
select lives_ok(format($$insert into world select 'ps', app.grant_platform_support_session(%L, 4, %L)$$, pg_temp.id('org_a'),
  'Imports of the crew list fail with a mapping error; please look at our settings.'), 'the Owner grants the platform 4 hours with a reason');
select throws_ok(format($$select app.grant_platform_support_session(%L, 4, 'Again.')$$, pg_temp.id('org_a')), 'XR001',
  'support_session_active: A platform support session is already open; end it before granting another.', 'one open platform session at a time');
select throws_ok(format($$select app.grant_platform_support_session(%L, 25, 'Long.')$$, pg_temp.id('org_b')), '42501', null,
  'only for an org the person owns');
select pg_temp.as_platform();
select is((select grantee::text || ' ' || coalesce(grantee_org_id::text, 'none') from app.support_sessions where id = pg_temp.id('ps')),
  'Platform none', 'a platform session names no grantee org');
select is((select count(*)::int from app.support_session_grants where support_session_id = pg_temp.id('ps')), 0,
  'and issues no record grants');

-- A partner session runs beside it ---------------------------------------------------------------------------------------
select pg_temp.as_user('cora');
select lives_ok(format($$insert into world select 'pp', app.grant_support_session(%L, 2, 'Partner reviews the budget.')$$, pg_temp.id('org_c')),
  'a client Owner still grants its partner a session');
select lives_ok(format($$insert into world select 'pc', app.grant_platform_support_session(%L, 1, 'Platform checks the invite.')$$, pg_temp.id('org_c')),
  'and the platform one beside it');
select throws_ok(format($$select app.grant_support_session(%L, 2, 'Again.')$$, pg_temp.id('org_c')), 'XR001', null,
  'one open partner session at a time still holds');
select throws_ok(format($$select app.grant_platform_support_session(%L, 0, 'Zero.')$$, pg_temp.id('org_c')), 'XR001', null,
  'a session lasts at least an hour');

-- Operators read through the console -------------------------------------------------------------------------------------
select pg_temp.as_op('omar');
select is((select count(*)::int from app.console_support_sessions() where org_id = pg_temp.id('org_a')), 1,
  'Support sees the open session');
select ok((select app.console_support_view(pg_temp.id('ps'), 'Members') -> 'data' @> '[{"email": "alice@northwind.test"}]'::jsonb),
  'and reads the members while it lasts');
select is((select jsonb_typeof(app.console_support_view(pg_temp.id('ps'), 'Projects') -> 'data')), 'array', 'the projects');
select is((select jsonb_typeof(app.console_support_view(pg_temp.id('ps'), 'Settings') -> 'data')), 'array', 'the org settings');
select ok((select (app.console_support_view(pg_temp.id('ps'), 'Overview') #>> '{data,members}')::int >= 7), 'and an overview');
select pg_temp.as_op('tess');
select throws_ok(format($$select app.console_support_view(%L, 'Members')$$, pg_temp.id('ps')), '42501', null,
  'Trust and Safety holds no support sessions');

-- The org sees who opened what -------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select count(*)::int from app.support_session_accesses where support_session_id = pg_temp.id('ps')
  and operator_person_id = pg_temp.id('omar')), 4, 'each read is recorded with the operator');
select is((select count(*)::int from app.audit_events where org_id = pg_temp.id('org_a')
  and action = 'support_session_accesses.insert' and actor_person_id = pg_temp.id('omar')), 4,
  'and lands in the org''s audit ledger with the operator as the actor');
select is((select count(*)::int from app.platform_operator_actions where action = 'support_session.viewed'
  and target_org_id = pg_temp.id('org_a')), 4, 'and in the console ledger');
select pg_temp.as_user('alice');
select is((select string_agg(distinct operator_name || ' ' || area::text, ', ' order by operator_name || ' ' || area::text)
  from app.support_session_access_log(pg_temp.id('org_a'))),
  'Omar Haddad Members, Omar Haddad Overview, Omar Haddad Projects, Omar Haddad Settings', 'the Owner sees who opened which area');
select pg_temp.as_user('bob');
select is((select count(*)::int from app.support_session_accesses), 4, 'an Admin with audit.log.read reads the accesses');
select pg_temp.as_user('gina');
select throws_ok(format('select * from app.support_session_access_log(%L)', pg_temp.id('org_a')), '42501', null, 'a Viewer does not');
select pg_temp.as_platform();
select throws_ok($$update app.support_session_accesses set area = 'Overview'$$, 'XR001', null, 'the access log is append-only');

-- Ending -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_op('omar');
select throws_ok(format('select app.end_support_session(%L)', pg_temp.id('pp')), '42501', null,
  'an operator cannot end a partner session');
select lives_ok(format('select app.end_support_session(%L)', pg_temp.id('ps')), 'Support ends the platform session when done');
select throws_ok(format($$select app.console_support_view(%L, 'Members')$$, pg_temp.id('ps')), 'XR001',
  'support_session_closed: This support session has ended. The Owner can grant a new one.', 'and reads nothing after');
select pg_temp.as_user('xavier');
select throws_ok(format('select app.end_support_session(%L)', pg_temp.id('pc')), '42501', null,
  'another org''s Owner cannot end the session');
select pg_temp.as_user('cora');
select lives_ok(format('select app.end_support_session(%L)', pg_temp.id('pc')), 'the Owner ends the platform session early');

select * from finish();
rollback;
