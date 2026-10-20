-- pgTAP: the tenant purge (1270, RRR-109). Without the mark, the guards keep refusing hard deletes (sole Owner,
-- audit ledger, append-only ledgers). private.begin_tenant_purge marks only the named orgs for the current
-- transaction: their rows can be deleted and are not audited, every other org keeps every rule, updates stay
-- refused, a legal hold refuses the mark, and no client role may set it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(24);

-- Who may purge -----------------------------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'private.begin_tenant_purge(uuid[])', 'execute'),
  'a signed-in client cannot start a tenant purge');
select ok(not has_function_privilege('anon', 'private.begin_tenant_purge(uuid[])', 'execute'), 'nor can anon');
select ok(not has_function_privilege('authenticated', 'private.in_tenant_purge(uuid)', 'execute'),
  'clients cannot probe the purge mark');
select ok(has_function_privilege('service_role', 'private.begin_tenant_purge(uuid[])', 'execute'),
  'the service role can start one');
select ok(not has_table_privilege('authenticated', 'private.tenant_purge_scope', 'insert'),
  'clients cannot write the purge mark directly');

-- Without the mark, nothing changes --------------------------------------------------------------------------
select pg_temp.as_platform();
select ok((select count(*) from app.audit_events where org_id = pg_temp.id('org_a')) > 0, 'org_a has an audit trail');
select ok((select count(*) from app.subscription_state_transitions where org_id = pg_temp.id('org_a')) > 0,
  'org_a has an append-only subscription ledger');
select throws_ok($$delete from app.membership_roles where membership_id = (select id from world where key = 'alice@org_a')$$,
  'XR001', null, 'inv_04_sole_owner: without a purge the sole Owner cannot be removed');
select throws_ok($$delete from app.audit_events where org_id = (select id from world where key = 'org_a')$$,
  'XR001', 'append_only: audit_events is an append-only ledger; only redaction changes it.',
  'inv_23_audit_retention: without a purge audit rows cannot be deleted');
select throws_ok($$delete from app.subscription_state_transitions where org_id = (select id from world where key = 'org_a')$$,
  'XR001', null, 'without a purge ledger rows cannot be deleted');
select is(private.in_tenant_purge(pg_temp.id('org_a')), false, 'no org is marked yet');

-- Refusals ------------------------------------------------------------------------------------------------------
select throws_ok($$select private.begin_tenant_purge('{}'::uuid[])$$, 'XR001',
  'tenant_purge_scope: Name at least one org to purge.', 'a purge names at least one org');
select pg_temp.as_user('xavier');
insert into app.legal_holds (org_id, matter) values (pg_temp.id('org_b'), 'Harbor lease dispute.');
select pg_temp.as_platform();
select throws_ok($$select private.begin_tenant_purge(array[(select id from world where key = 'org_b')])$$, 'XR001', null,
  'an org under an active legal hold cannot be purged');

-- Purging org_a -------------------------------------------------------------------------------------------------
select is(private.begin_tenant_purge(array[pg_temp.id('org_a')]), 1, 'the purge marks org_a');
select ok(private.in_tenant_purge(pg_temp.id('org_a')) and not private.in_tenant_purge(pg_temp.id('org_b')),
  'only the named org is marked');
select lives_ok($$delete from app.membership_roles where membership_id = (select id from world where key = 'alice@org_a')$$,
  'inv_04_sole_owner: a purged org''s sole Owner role can be deleted');
select lives_ok($$delete from app.audit_events where org_id = (select id from world where key = 'org_a')$$,
  'inv_23_audit_retention: a purged org''s audit rows can be deleted');
select lives_ok($$delete from app.subscription_state_transitions where org_id = (select id from world where key = 'org_a')$$,
  'a purged org''s ledger rows can be deleted');
insert into app.membership_roles (membership_id, role_id) values (pg_temp.id('dave@org_a'), pg_temp.system_role('viewer'));
select is((select count(*)::int from app.audit_events where org_id = pg_temp.id('org_a')), 0,
  'changes to a purged org write no audit rows');
select throws_ok($$delete from app.audit_events where org_id = (select id from world where key = 'org_b')$$,
  'XR001', null, 'inv_23_audit_retention: another org''s audit rows stay append-only during the purge');
select throws_ok($$delete from app.membership_roles where membership_id = (select id from world where key = 'xavier@org_b')$$,
  'XR001', null, 'inv_04_sole_owner: another org''s sole Owner stays protected during the purge');
select throws_ok($$update app.subscription_state_transitions set to_state = to_state where org_id = (select id from world where key = 'org_b')$$,
  'XR001', null, 'ledger updates stay refused during a purge');

-- Ending the purge ----------------------------------------------------------------------------------------------
select is(private.end_tenant_purge(), 1, 'ending the purge clears the mark');
insert into app.membership_roles (membership_id, role_id) values (pg_temp.id('erin@org_a'), pg_temp.system_role('viewer'));
select ok((select count(*) from app.audit_events where org_id = pg_temp.id('org_a')) > 0
  and not private.in_tenant_purge(pg_temp.id('org_a')),
  'inv_23_audit_retention: after the purge org_a is audited again');

select * from finish();
rollback;
