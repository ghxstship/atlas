-- pgTAP: migration 1470, the platform team for the operator console (A90, RRR-135, finding A65-009). Only a live
-- operator reaches a console RPC, only with the role's permission, only in a second-factor session; the platform
-- names the first Administrator, Administrators manage the roster (never themselves, never the last Administrator),
-- grants are revoked once and never edited, and every roster change lands in the append-only console ledger.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(27);

-- An operator's session: authenticated, with the assurance level its JWT would carry.
create function pg_temp.as_op(p_key text, p_aal text default 'aal2') returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', p_aal)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

select pg_temp.new_user('olga', 'olga@platform.test', 'Olga Brandt');
select pg_temp.new_user('omar', 'omar@platform.test', 'Omar Haddad');
select pg_temp.new_user('tess', 'tess@platform.test', 'Tess Morales');

-- Nobody is an operator yet ------------------------------------------------------------------------------------------
select pg_temp.as_op('nina');
select is((select count(*)::int from app.console_whoami()), 0, 'a person off the platform team gets no operator row');
select throws_ok($$select * from app.console_operators()$$, '42501', 'the operator console is for the platform team',
  'and every console RPC refuses them');
select throws_ok($$select private.grant_platform_operator('nina@nowhere.test', 'Administrator', 'Self service.')$$, '42501', null,
  'a signed-in person cannot reach the platform''s own grant');

-- The platform names the first Administrator ---------------------------------------------------------------------------
select pg_temp.as_platform();
select isnt(private.grant_platform_operator('Olga@Platform.test', 'Administrator', 'First platform administrator.'), null,
  'the platform grants the first Administrator by account email, case aside');
select throws_ok($$select private.grant_platform_operator('nobody@platform.test', 'Support', 'No account.')$$, 'XR001',
  'operator_no_account: No account uses that email. The person signs up once, then gets the role.',
  'an email without an account is refused');

-- The second factor ----------------------------------------------------------------------------------------------------
select pg_temp.as_op('olga', 'aal1');
select is((select operator_role::text || ' ' || second_factor::text from app.console_whoami()), 'Administrator false',
  'whoami names the role and that the session has not passed a second factor');
select throws_ok($$select * from app.console_operators()$$, 'XR001', null,
  'without a second factor every console action is refused (step_up_required)');
select pg_temp.as_op('olga');
select is((select count(*)::int from app.console_operators()), 1, 'with one, the Administrator reads the roster');
select ok((select 'operators.manage' = any (permissions) and 'plans.write' = any (permissions) from app.console_whoami()),
  'an Administrator holds every permission');

-- Administrators manage the roster -------------------------------------------------------------------------------------
select isnt(app.console_grant_operator('omar@platform.test', 'Support', 'Joins support for the launch.'), null,
  'an Administrator adds a Support operator');
select isnt(app.console_grant_operator('tess@platform.test', 'Trust and Safety', 'Runs the moderation queue.'), null,
  'and a Trust and Safety operator');
select throws_ok($$select app.console_grant_operator('olga@platform.test', 'Support', 'A second role.')$$, 'XR001',
  'operator_self: An operator never grants themselves a role.', 'never to themselves');
select throws_ok($$select app.console_grant_operator('omar@platform.test', 'Administrator', 'Promotion.')$$, 'XR001', null,
  'one live grant per person (operator_exists)');
select throws_ok($$select app.console_grant_operator('alice@northwind.test', 'Support', '')$$, 'XR001', null,
  'a grant needs a reason (operator_reason)');
select is((select count(*)::int from app.platform_operator_actions where action = 'platform_operator.granted'
  and operator_person_id = pg_temp.id('olga')), 2, 'each grant lands in the console ledger with the Administrator');

-- Roles set what an operator may do ------------------------------------------------------------------------------------
select pg_temp.as_op('omar');
select ok((select 'support.sessions' = any (permissions) and not 'plans.write' = any (permissions) from app.console_whoami()),
  'Support holds support sessions but not plans');
select throws_ok($$select * from app.console_operators()$$, '42501', null, 'and cannot read the roster');
select is((select count(*)::int from app.platform_operators), 3, 'operators read the platform team');
select pg_temp.as_op('alice');
select is((select count(*)::int from app.platform_operators), 0, 'tenant members do not');
select is((select count(*)::int from app.platform_operator_actions), 0, 'nor the console ledger');

-- Revoking ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_op('olga');
select throws_ok(format('select app.console_revoke_operator(%L, %L)',
    (select id from app.platform_operators where person_id = pg_temp.id('olga')), 'Leaving.'),
  'XR001', 'operator_last_administrator: The platform team keeps at least one Administrator. Grant another first.',
  'the last Administrator stays');
select lives_ok(format('select app.console_revoke_operator(%L, %L)',
    (select id from app.platform_operators where person_id = pg_temp.id('omar')), 'Moved to another team.'),
  'an Administrator revokes a role with a reason');
select pg_temp.as_op('omar');
select is((select count(*)::int from app.console_whoami()), 0, 'a revoked operator is off the platform team at once');
select is((select count(*)::int from app.platform_operators), 1, 'and reads only their own past grant');

-- Grants and the ledger never change -----------------------------------------------------------------------------------
select pg_temp.as_platform();
select throws_ok(format($$update app.platform_operators set operator_role = 'Administrator' where person_id = %L$$, pg_temp.id('tess')),
  'XR001', null, 'a grant keeps its role (platform_operator_immutable)');
select throws_ok(format($$delete from app.platform_operators where person_id = %L$$, pg_temp.id('tess')),
  'XR001', null, 'and is never deleted');
select throws_ok($$update app.platform_operator_actions set reason = 'Edited.'$$, 'XR001', null,
  'the console ledger is append-only');

select * from finish();
rollback;
