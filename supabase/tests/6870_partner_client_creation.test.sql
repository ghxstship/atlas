-- pgTAP: migration 6870. A partner creates client organizations only once a platform operator has turned that on
-- for it, and it is off by default. The trigger holds whichever function inserts the client, an Administrator turns
-- it on or off with a reason on the console ledger, and the partner console can ask whether to offer it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(19);

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
select pg_temp.as_platform();
select private.grant_platform_operator('olga@platform.test', 'Administrator', 'First platform administrator.');
select private.grant_platform_operator('omar@platform.test', 'Support', 'Support on call.');

-- Off by default --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select is(app.partner_client_creation_allowed(pg_temp.id('org_a')), false, 'an org that was never allowed is off');
select throws_like(
  $$select * from app.create_client_organization(pg_temp.id('org_a'), 'Harbor Client', 'harbor-client', 'h@client.test')$$,
  'partner_clients_not_enabled:%', 'an Owner of a top-level org cannot create a client without an operator''s grant');
select pg_temp.as_platform();
select is_empty($$select 1 from app.organizations where slug = 'harbor-client'$$, 'and nothing was created');
select throws_like(
  $$insert into app.organizations (name, slug, parent_org_id) values ('Direct Client', 'direct-client', pg_temp.id('org_a'))$$,
  'partner_clients_not_enabled:%', 'the trigger holds a client inserted by any path');
select throws_like(
  $$insert into app.organizations (name, slug, parent_org_id) values ('Fourth Level', 'fourth-level', pg_temp.id('org_c'))$$,
  'partner_depth:%', 'the depth check still answers first for a client of a client');
select lives_ok(
  $$insert into app.organizations (name, slug) values ('Standalone Org', 'standalone-org')$$,
  'an org with no partner is not affected');

-- The partner console's read --------------------------------------------------------------------------------------------
select pg_temp.as_user('paul');
select is(app.partner_client_creation_allowed(pg_temp.id('org_p')), true, 'a partner that was allowed reads on');
select pg_temp.as_user('dave');
select throws_ok($$select app.partner_client_creation_allowed(pg_temp.id('org_a'))$$, '42501', null,
  'a member without org.partner.manage cannot ask');

-- The operator console --------------------------------------------------------------------------------------------------
select pg_temp.as_op('omar');
select is((select allowed from app.console_partner_client_grant(pg_temp.id('org_a'))), false, 'Support reads the setting');
select throws_ok($$select app.console_set_partner_clients(pg_temp.id('org_a'), true, 'Signed partner agreement PA-1.')$$,
  '42501', null, 'Support cannot change it');
select pg_temp.as_op('olga');
select throws_like($$select app.console_set_partner_clients(pg_temp.id('org_a'), true, ' ')$$,
  'partner_clients_reason:%', 'turning it on needs a reason');
select throws_like($$select app.console_set_partner_clients(pg_temp.id('org_c'), true, 'Signed partner agreement PA-2.')$$,
  'partner_is_client:%', 'a client org cannot be allowed clients of its own');
select is(app.console_set_partner_clients(pg_temp.id('org_a'), true, 'Signed partner agreement PA-1.'), true,
  'an Administrator turns it on with a reason');
select throws_like($$select app.console_set_partner_clients(pg_temp.id('org_a'), true, 'Again.')$$,
  'partner_clients_unchanged:%', 'turning it on twice is refused');
select pg_temp.as_platform();
select is((select reason from private.partner_client_grants where org_id = pg_temp.id('org_a')), 'Signed partner agreement PA-1.',
  'the grant keeps the reason');
select is((select count(*)::int from app.platform_operator_actions where action = 'partner_clients.enabled'
  and target_org_id = pg_temp.id('org_a') and operator_person_id = pg_temp.id('olga')), 1, 'and lands on the console ledger');

select pg_temp.as_user('alice');
select lives_ok(
  $$select * from app.create_client_organization(pg_temp.id('org_a'), 'Harbor Client', 'harbor-client', 'h@client.test')$$,
  'once allowed, the Owner creates a client');

-- Turning it off --------------------------------------------------------------------------------------------------------
select pg_temp.as_op('olga');
select is(app.console_set_partner_clients(pg_temp.id('org_a'), false, 'Partner agreement ended.'), false, 'an Administrator turns it off');
select pg_temp.as_user('alice');
select throws_like(
  $$select * from app.create_client_organization(pg_temp.id('org_a'), 'Second Client', 'second-client', 's@client.test')$$,
  'partner_clients_not_enabled:%', 'after which no new client can be created, and the existing one stays');

select * from finish();
rollback;
