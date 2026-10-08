-- pgTAP: row level security on every identity table (Section 18 gate 4, Section 9 RLS
-- penetration): same-tenant allow, cross-tenant deny, anon deny and role band boundaries.
-- Catalog checks for Section 7.5 invariants 5 (policies), 6 (functions) and 7 (anon).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(148);

create function pg_temp.visible(p_table text, p_org text) returns integer
language plpgsql as $$
declare
  v integer;
begin
  execute format('select count(*) from %s where org_id = $1', p_table) into v using pg_temp.id(p_org);
  return v;
end $$;

-- Rows in every tenant table of both orgs, created by their own admins.
select pg_temp.as_user('bob');
insert into app.roles (org_id, code, name, band) values (pg_temp.id('org_a'), 'stage_manager', 'Stage Manager', 4);
insert into app.role_capabilities (role_id, capability_code, reach)
  select id, 'show.cue.call', 'assigned' from app.roles where code = 'stage_manager';
insert into app.user_capability_grants (membership_id, capability_code, reason)
  values (pg_temp.id('dave@org_a'), 'vendors.vendor.write', 'Vendor onboarding week.');
insert into app.record_grants (target_kind, target_id, capability_code, grantee_person_id, valid_to, reason)
  values ('workspace', pg_temp.id('ws_a'), 'projects.project.read', pg_temp.id('mia'), now() + interval '7 days', 'Co-production review.');
insert into app.delegations (delegator_membership_id, delegate_membership_id, valid_from, valid_to, reason)
  values (pg_temp.id('bob@org_a'), pg_temp.id('carol@org_a'), now(), now() + interval '2 days', 'Travel.');
select pg_temp.invite_token('bob', 'org_a', 'quinn@northwind.test', 'viewer');
select pg_temp.as_platform();
update app.subscriptions set plan_code = 'team' where org_id = pg_temp.id('org_b');
select pg_temp.as_user('xavier');
insert into app.workspace_members (workspace_id, membership_id) values (pg_temp.id('ws_b'), pg_temp.id('mia@org_b'));
insert into app.team_members (team_id, membership_id) values (pg_temp.id('team_b'), pg_temp.id('mia@org_b'));
insert into app.roles (org_id, code, name, band) values (pg_temp.id('org_b'), 'rigger', 'Rigger', 6);
insert into app.role_capabilities (role_id, capability_code, reach)
  select id, 'crew.shift.read', 'own' from app.roles where code = 'rigger';
insert into app.user_capability_grants (membership_id, capability_code, reason)
  values (pg_temp.id('mia@org_b'), 'reports.report.export', 'Season wrap report.');
insert into app.record_grants (target_kind, target_id, capability_code, grantee_person_id, valid_to, reason)
  values ('team', pg_temp.id('team_b'), 'crew.shift.read', pg_temp.id('dave'), now() + interval '7 days', 'Shared riggers.');
select pg_temp.invite_token('xavier', 'org_b', 'rhea@harborlights.test', 'viewer');
select pg_temp.as_user('mia');
insert into app.delegations (delegator_membership_id, delegate_membership_id, valid_from, valid_to, reason)
  values (pg_temp.id('mia@org_b'), pg_temp.id('xavier@org_b'), now(), now() + interval '2 days', 'Away.');
select pg_temp.as_platform();

-- Same-tenant allow and cross-tenant deny, both directions --------------------------------------
create temporary table tenant_tables (name text primary key);
grant select on tenant_tables to public;
insert into tenant_tables values
  ('app.subscriptions'), ('app.subscription_state_transitions'), ('app.workspaces'), ('app.memberships'),
  ('app.roles'), ('app.role_capabilities'), ('app.membership_roles'), ('app.workspace_members'), ('app.teams'),
  ('app.team_members'), ('app.user_capability_grants'), ('app.record_grants'), ('app.delegations'), ('app.invites');

select pg_temp.as_user('alice');
select ok(pg_temp.visible(t.name, 'org_a') > 0, 'owner of Northwind reads own-org rows of ' || t.name) from tenant_tables t order by t.name;
select is(pg_temp.visible(t.name, 'org_b'), 0, 'owner of Northwind reads no Harbor Lights rows of ' || t.name) from tenant_tables t order by t.name;
select pg_temp.as_user('xavier');
select ok(pg_temp.visible(t.name, 'org_b') > 0, 'owner of Harbor Lights reads own-org rows of ' || t.name) from tenant_tables t order by t.name;
select is(pg_temp.visible(t.name, 'org_a'), 0, 'owner of Harbor Lights reads no Northwind rows of ' || t.name) from tenant_tables t order by t.name;
select pg_temp.as_user('nina');
select is(pg_temp.visible(t.name, 'org_a'), 0, 'a person without membership reads no rows of ' || t.name) from tenant_tables t order by t.name;

-- Anon deny on every table -----------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok(format('select 1 from %s', c.oid::regclass), '42501', null, 'anon cannot read ' || c.oid::regclass::text)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'app' and c.relkind = 'r' order by c.relname;
select throws_ok($$select app.create_organization('Anon Org', 'anon-org')$$, '42501', null, 'anon cannot call identity RPCs');
select pg_temp.as_platform();

-- Organizations and people -------------------------------------------------------------------------
select pg_temp.as_user('alice');
select results_eq('select id from app.organizations order by id', array[pg_temp.id('org_a')], 'an owner sees only their own org');
select ok((select count(*) from app.people where id = pg_temp.id('bob')) = 1, 'a member sees co-members');
select ok((select count(*) from app.people where id in (pg_temp.id('xavier'), pg_temp.id('nina'))) = 0, 'a member does not see people outside their orgs');
select pg_temp.as_user('mia');
select ok((select count(*) from app.people where id in (pg_temp.id('xavier'), pg_temp.id('alice'))) = 2, 'a person in two orgs sees members of both');
select pg_temp.as_user('paul');
select ok((select count(*) from app.organizations where id = pg_temp.id('org_c')) = 1, 'a partner sees its client org''s name');
select is(pg_temp.visible('app.workspaces', 'org_c') + pg_temp.visible('app.memberships', 'org_c'), 0,
  'a partner sees none of its client''s data');
select pg_temp.as_user('carol');
with u as (update app.organizations set name = 'Northwind Live Events' where id = pg_temp.id('org_a') returning 1)
select is((select count(*)::integer from u), 0, 'a manager cannot rename the org');
select pg_temp.as_user('bob');
with u as (update app.organizations set name = 'Northwind Live Events' where id = pg_temp.id('org_a') returning 1)
select is((select count(*)::integer from u), 1, 'an admin renames the org');
select throws_ok($$update app.organizations set parent_org_id = null where id = pg_temp.id('org_a')$$, '42501', null,
  'nobody re-parents an org directly');
select pg_temp.as_user('dave');
with u as (update app.people set full_name = 'Dave L. Lindqvist' where id = pg_temp.id('dave') returning 1)
select is((select count(*)::integer from u), 1, 'a person edits their own name');
with u as (update app.people set full_name = 'Renamed' where id = pg_temp.id('bob') returning 1)
select is((select count(*)::integer from u), 0, 'a person cannot edit someone else');
select throws_ok($$update app.people set user_id = null where id = pg_temp.id('dave')$$, '42501', null,
  'a person cannot unlink their sign-in');

-- Subscriptions --------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select ok(pg_temp.visible('app.subscriptions', 'org_a') = 1, 'every member sees the org''s plan');
select is(pg_temp.visible('app.subscription_state_transitions', 'org_a'), 0, 'billing history needs org.billing.read');
select pg_temp.as_user('alice');
select throws_ok($$update app.subscriptions set plan_code = 'enterprise'$$, '42501', null, 'plans change only through billing services');
select throws_ok($$insert into app.subscription_state_transitions (subscription_id, to_state, reason)
  select id, 'canceled', 'Manual.' from app.subscriptions where org_id = pg_temp.id('org_a')$$, '42501', null,
  'the transition ledger is written only by the transition RPC');

-- Workspaces, teams and their members -----------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$insert into app.workspaces (org_id, slug, name) values (pg_temp.id('org_a'), 'west', 'West')$$, '42501', null,
  'a manager cannot create workspaces');
select throws_ok($$insert into app.workspace_members (workspace_id, membership_id) values (pg_temp.id('ws_a'), pg_temp.id('carol@org_a'))$$,
  '42501', null, 'a manager cannot assign workspace members');
select throws_ok($$insert into app.teams (org_id, name) values (pg_temp.id('org_a'), 'Audio')$$, '42501', null,
  'a manager cannot create teams');
select throws_ok($$insert into app.team_members (team_id, membership_id) values (pg_temp.id('team_a'), pg_temp.id('carol@org_a'))$$,
  '42501', null, 'a manager cannot add team members');
select pg_temp.as_user('bob');
select lives_ok($$insert into app.workspaces (org_id, slug, name) values (pg_temp.id('org_a'), 'west', 'West')$$,
  'an admin creates a workspace');
select throws_ok($$insert into app.workspaces (org_id, slug, name) values (pg_temp.id('org_b'), 'raid', 'Raid')$$, '42501', null,
  'an admin cannot create a workspace in another org');
select lives_ok($$insert into app.team_members (team_id, membership_id) values (pg_temp.id('team_a'), pg_temp.id('carol@org_a'))$$,
  'an admin adds a team member');
with u as (update app.teams set deleted_at = now() where id = pg_temp.id('team_b') returning 1)
select is((select count(*)::integer from u), 0, 'an admin cannot touch another org''s team');
select pg_temp.as_user('gina');
select ok(pg_temp.visible('app.workspaces', 'org_a') = 2, 'a viewer reads the org''s workspaces');

-- Memberships and roles -------------------------------------------------------------------------------
select pg_temp.as_user('erin');
select is((select count(*)::integer from app.memberships), 1, 'a collaborator sees only their own membership');
select is((select count(*)::integer from app.membership_roles), 1, 'a collaborator sees only their own roles');
select pg_temp.as_user('dave');
select ok((select count(*) from app.memberships where org_id = pg_temp.id('org_a')) > 1, 'a member reads the people directory');
select throws_ok($$insert into app.memberships (org_id, person_id) values (pg_temp.id('org_a'), pg_temp.id('nina'))$$, '42501', null,
  'memberships are created only by accepting an invite');
select throws_ok($$update app.memberships set valid_to = null where id = pg_temp.id('dave@org_a')$$, '42501', null,
  'a member cannot change membership dates directly');
select throws_ok($$insert into app.membership_roles (membership_id, role_id) values (pg_temp.id('gina@org_a'), pg_temp.system_role('viewer'))$$,
  '42501', null, 'a member cannot assign roles');
select throws_ok($$insert into app.roles (org_id, code, name, band) values (pg_temp.id('org_a'), 'deck_hand', 'Deck Hand', 6)$$,
  '42501', null, 'a member cannot create custom roles');
select throws_ok($$insert into app.role_capabilities (role_id, capability_code, reach)
  select id, 'show.run_of_show.read', 'organization' from app.roles where code = 'stage_manager'$$,
  '42501', null, 'a member cannot edit custom role capabilities');
select ok((select count(*) from app.roles where org_id is null) = 7, 'every member reads the system roles');
select ok((select count(*) from app.role_capabilities where org_id is null) > 0, 'every member reads the system role grants');

-- Grants, delegations and invites -----------------------------------------------------------------------
select pg_temp.as_user('gina');
select is(pg_temp.visible('app.user_capability_grants', 'org_a'), 0, 'a viewer sees no one else''s grants');
select is(pg_temp.visible('app.delegations', 'org_a'), 0, 'a viewer sees no one else''s delegations');
select is(pg_temp.visible('app.invites', 'org_a'), 0, 'a viewer sees no invites');
select is(pg_temp.visible('app.record_grants', 'org_a'), 0, 'a viewer sees no record grants');
select pg_temp.as_user('dave');
select is(pg_temp.visible('app.user_capability_grants', 'org_a'), 1, 'a member sees their own grants');
select pg_temp.as_user('carol');
select is(pg_temp.visible('app.delegations', 'org_a'), 1, 'a delegate sees the delegation to them');
select throws_ok($$insert into app.user_capability_grants (membership_id, capability_code, reason)
  values (pg_temp.id('gina@org_a'), 'reports.report.read', 'Manager grant.')$$, '42501', null,
  'a manager cannot grant capabilities');
select throws_ok($$insert into app.record_grants (target_kind, target_id, capability_code, grantee_person_id, valid_to, reason)
  values ('workspace', pg_temp.id('ws_a'), 'projects.project.read', pg_temp.id('xavier'), now() + interval '1 day', 'Manager grant.')$$,
  '42501', null, 'a manager cannot grant record access');
select pg_temp.as_user('frank');
select throws_ok($$insert into app.delegations (delegator_membership_id, delegate_membership_id, valid_from, valid_to, reason)
  values (pg_temp.id('carol@org_a'), pg_temp.id('gina@org_a'), now(), now() + interval '1 day', 'Taking over.')$$,
  '42501', null, 'a person cannot create a delegation from someone else');
select pg_temp.as_user('dave');
select ok((select count(*) from app.record_grants where org_id = pg_temp.id('org_b')) = 1,
  'a grantee sees the record grant made to them by another org');
select pg_temp.as_user('bob');
select ok(pg_temp.visible('app.invites', 'org_a') > 0, 'an admin sees the org''s invites');
select throws_ok($$select token_hash from app.invites$$, '42501', null, 'nobody reads invite token hashes');
select throws_ok($$insert into app.invites (org_id, email, role_id, token_hash, expires_at, invited_by)
  values (pg_temp.id('org_a'), 'sly@northwind.test', pg_temp.system_role('viewer'), sha256('x'::bytea), now() + interval '1 day', pg_temp.id('bob'))$$,
  '42501', null, 'invites are created only by the invite RPC');
with u as (update app.invites set revoked_at = now() where email = 'quinn@northwind.test' returning 1)
select is((select count(*)::integer from u), 1, 'an admin revokes an invite');
with u as (update app.invites set revoked_at = now() where email = 'rhea@harborlights.test' returning 1)
select is((select count(*)::integer from u), 0, 'an admin cannot revoke another org''s invite');
select pg_temp.as_platform();

-- Invariant 5: policies ----------------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(tablename || '.' || policyname, ', '), '') from pg_policies
   where schemaname = 'app'
     and (replace(coalesce(qual, '') || coalesce(with_check, ''), 'SELECT auth.uid() AS uid', '') ~ 'auth\.uid\(\)')),
  '', 'every policy wraps auth.uid() in a subselect');
select is(
  (select coalesce(string_agg(tablename || '.' || policyname, ', '), '') from pg_policies
   where schemaname = 'app' and coalesce(qual, with_check) <> 'true'
     and (coalesce(qual, '') || coalesce(with_check, '')) !~ '(private\.|auth\.uid)'),
  '', 'every restricting policy calls helpers from private or auth.uid()');
select is(
  (select coalesce(string_agg(c.relname, ', '), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'app' and c.relkind = 'r'
     and not exists (select 1 from pg_policies p where p.schemaname = 'app' and p.tablename = c.relname and p.cmd in ('SELECT', 'ALL'))),
  '', 'every app table has a read policy');
select is(
  (select coalesce(string_agg(c.relname || ':' || priv.cmd, ', '), '')
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as priv (cmd)
   where n.nspname = 'app' and c.relkind = 'r'
     and (has_table_privilege('authenticated', c.oid, priv.cmd)
          or (priv.cmd <> 'DELETE' and has_any_column_privilege('authenticated', c.oid, priv.cmd)))
     and not exists (select 1 from pg_policies p where p.schemaname = 'app' and p.tablename = c.relname and p.cmd in (priv.cmd, 'ALL'))),
  '', 'every write authenticated may attempt has a matching write policy');

-- Invariant 6: functions -------------------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(p.oid::regprocedure::text, ', '), '') from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('app', 'private') and not ('search_path=""' = any(coalesce(p.proconfig, '{}')))),
  '', 'every function in app and private pins an empty search_path');
select is(
  (select coalesce(string_agg(p.oid::regprocedure::text, ', '), '') from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('app', 'private') and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')),
  '', 'no SECURITY DEFINER function is executable by anon');

-- Invariant 7: anon reaches no app or private table ---------------------------------------------------------
select is(
  (select coalesce(string_agg(c.oid::regclass::text, ', '), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('app', 'private') and c.relkind in ('r', 'v')
     and (has_table_privilege('anon', c.oid, 'select') or has_any_column_privilege('anon', c.oid, 'select'))),
  '', 'anon holds no privilege on app or private tables');

select * from finish();
rollback;
