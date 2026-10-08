-- pgTAP: access helpers and identity invariants.
--   Section 7.5 invariant 1 (org derivation, no tenant move, no cross-org references)
--   Section 7.5 invariant 3 (leaving ends access at once)
--   Section 7.5 invariant 4 (sole Owner)
--   Section 8 role bands, time-boxed access, delegations, record grants, custom roles
--   Section 8.2 a person cannot grant themselves a role or capability
--   Section 4.6.1 partner depth and partner data access
--   Section 16 plan limits
--   Section 18 gate 33 (several memberships and roles, capability union, per-person duties)
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(111);

-- Role bands (Section 8, Section 4.5.9) ------------------------------------------------------
select pg_temp.claims('alice');
select ok(private.has_capability(pg_temp.id('org_a'), 'org.members.manage'), 'owner manages members');
select ok(private.has_capability(pg_temp.id('org_a'), 'org.billing.manage'), 'owner manages billing');
select ok(private.has_capability(pg_temp.id('org_a'), 'data.restricted.read.payroll'), 'owner reads restricted payroll data');
select pg_temp.claims('bob');
select ok(private.has_capability(pg_temp.id('org_a'), 'org.members.manage'), 'admin manages members');
select ok(not private.has_capability(pg_temp.id('org_a'), 'org.billing.manage'), 'admin does not manage billing');
select ok(private.has_capability(pg_temp.id('org_a'), 'canon.extension.write'), 'admin extends canon');
select ok(private.has_capability(pg_temp.id('org_a'), 'audit.log.read'), 'admin reads the audit log');
select pg_temp.claims('carol');
select ok(private.has_capability(pg_temp.id('org_a'), 'finance.po.approve'), 'manager approves purchase orders');
select ok(private.has_capability(pg_temp.id('org_a'), 'crew.timesheet.approve'), 'manager approves timesheets');
select ok(not private.has_capability(pg_temp.id('org_a'), 'canon.extension.write'), 'manager does not extend canon');
select ok(not private.has_capability(pg_temp.id('org_a'), 'audit.log.read'), 'manager does not read the audit log');
select ok(not private.has_capability(pg_temp.id('org_a'), 'org.members.manage'), 'manager does not manage members');
select pg_temp.claims('dave');
select ok(private.has_capability(pg_temp.id('org_a'), 'finance.budget.read'), 'member reads budgets');
select ok(not private.has_capability(pg_temp.id('org_a'), 'finance.po.approve'), 'member has no finance approval');
select is(private.capability_reach(pg_temp.id('org_a'), 'work.record.write'), 'assigned'::app.capability_reach,
  'member writes work records only on assigned scopes');
select ok(not private.has_capability(pg_temp.id('org_a'), 'projects.project.create'), 'member does not create projects');
select pg_temp.claims('erin');
select ok(not private.has_capability(pg_temp.id('org_a'), 'people.directory.read'), 'collaborator does not see the people directory');
select ok(not private.has_capability(pg_temp.id('org_a'), 'work.record.write', pg_temp.id('ws_a')),
  'collaborator cannot write in a workspace they are not assigned to');
select ok(private.has_capability(pg_temp.id('org_a'), 'work.record.write', pg_temp.id('team_a')),
  'collaborator writes within their team scope');
select pg_temp.claims('frank');
select ok(private.has_capability(pg_temp.id('org_a'), 'work.record.write', pg_temp.id('ws_a')),
  'field writes within the workspace they are assigned to');
select ok(private.has_capability(pg_temp.id('org_a'), 'crew.time_entry.write', pg_temp.id('frank')),
  'field writes their own time entries');
select ok(not private.has_capability(pg_temp.id('org_a'), 'crew.time_entry.write', pg_temp.id('dave')),
  'field cannot write another person''s time entries');
select ok(not private.has_capability(pg_temp.id('org_a'), 'crew.timesheet.approve'), 'field does not approve timesheets');
select ok(not private.has_capability(pg_temp.id('org_a'), 'finance.budget.read'), 'field does not see finance');
select pg_temp.claims('gina');
select ok(private.has_capability(pg_temp.id('org_a'), 'reports.report.read'), 'viewer reads reports');
select ok(not private.has_capability(pg_temp.id('org_a'), 'work.record.write', pg_temp.id('ws_a')), 'viewer writes nothing');
select ok(private.has_capability(pg_temp.id('org_a'), 'me.profile.write', pg_temp.id('gina')), 'viewer edits their own profile');
select pg_temp.claims('nina');
select ok(not private.is_member(pg_temp.id('org_a')), 'a person without membership is not a member');
select ok(not private.has_capability(pg_temp.id('org_a'), 'home.dashboard.read'), 'a non-member holds no capability');
select throws_ok($$select private.has_capability(pg_temp.id('org_a'), 'finance.po.approves')$$, '22023', null,
  'an unknown capability code raises instead of answering');
select pg_temp.as_platform();
select ok(not private.has_capability(pg_temp.id('org_a'), 'home.dashboard.read'), 'no signed-in person holds no capability');

-- Gate 33: one person, several memberships and roles ---------------------------------------
select pg_temp.claims('mia');
select is((select count(*)::integer from private.my_org_ids()), 2, 'mia belongs to two orgs');
select is(private.capability_reach(pg_temp.id('org_a'), 'finance.budget.read'), 'organization'::app.capability_reach,
  'mia reads budgets in Northwind through her member role');
select is(private.capability_reach(pg_temp.id('org_a'), 'crew.time_entry.write'), 'own'::app.capability_reach,
  'mia clocks her own time in Northwind through her field role');
select is(private.capability_reach(pg_temp.id('org_a'), 'work.record.write'), 'assigned'::app.capability_reach,
  'the union keeps the widest reach of mia''s roles');
select ok(private.has_capability(pg_temp.id('org_a'), 'crew.time_entry.write', pg_temp.id('mia')),
  'capabilities of both roles apply at once');
select ok(not private.has_capability(pg_temp.id('org_b'), 'finance.budget.read'), 'mia''s Northwind roles do not reach Harbor Lights');
select ok(private.has_capability(pg_temp.id('org_b'), 'reports.report.read'), 'mia reads Harbor Lights reports as a viewer');
select ok(not private.has_capability(pg_temp.id('org_b'), 'reports.report.write'), 'mia writes nothing in Harbor Lights');

-- Separation of duties is checked against the person, never the role.
select pg_temp.as_user('bob');
insert into app.user_capability_grants (membership_id, capability_code, reason, valid_to)
values (pg_temp.id('mia@org_a'), 'org.members.manage', 'Covers member admin during the festival.', now() + interval '7 days');
select pg_temp.as_user('mia');
select throws_like(
  $$insert into app.membership_roles (membership_id, role_id) values (pg_temp.id('mia@org_a'), pg_temp.system_role('viewer'))$$,
  'sod_self_grant:%', 'holding several roles and a grant, mia still cannot grant herself a role');
select pg_temp.as_platform();

-- Section 8.2: no self-grants -----------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_like(
  $$insert into app.membership_roles (membership_id, role_id) values (pg_temp.id('alice@org_a'), pg_temp.system_role('admin'))$$,
  'sod_self_grant:%', 'an owner cannot grant themselves a role');
select pg_temp.as_user('bob');
select throws_like(
  $$insert into app.user_capability_grants (membership_id, capability_code, reason)
    values (pg_temp.id('bob@org_a'), 'finance.po.approve', 'Self grant.')$$,
  'sod_self_grant:%', 'an admin cannot grant themselves a capability');
select throws_like(
  $$insert into app.record_grants (target_kind, target_id, capability_code, grantee_person_id, valid_to, reason)
    values ('workspace', pg_temp.id('ws_a'), 'projects.project.read', pg_temp.id('bob'), now() + interval '1 day', 'Self grant.')$$,
  'sod_self_grant:%', 'an admin cannot grant themselves record access');
select throws_like(
  $$insert into app.membership_roles (membership_id, role_id) values (pg_temp.id('dave@org_a'), pg_temp.system_role('owner'))$$,
  'role_band:%', 'an admin cannot assign the Owner role');
select lives_ok(
  $$insert into app.membership_roles (membership_id, role_id) values (pg_temp.id('dave@org_a'), pg_temp.system_role('manager'))$$,
  'an admin assigns a role below their band to someone else');
select is(
  (select granted_by from app.membership_roles where membership_id = pg_temp.id('dave@org_a') and role_id = pg_temp.system_role('manager')),
  pg_temp.id('bob'), 'the assignment records who granted it');
select pg_temp.as_user('carol');
select throws_ok(
  $$insert into app.membership_roles (membership_id, role_id) values (pg_temp.id('gina@org_a'), pg_temp.system_role('member'))$$,
  '42501', null, 'a manager cannot assign roles');
select pg_temp.as_platform();

-- Custom roles: grant only what you hold ------------------------------------------------------
select pg_temp.as_user('bob');
insert into app.roles (org_id, code, name, band, description)
values (pg_temp.id('org_a'), 'finance_lead', 'Finance Lead', 3, 'Runs budgets and approvals.');
select throws_like(
  $$insert into app.role_capabilities (role_id, capability_code, reach)
    select id, 'org.billing.read', 'organization' from app.roles where code = 'finance_lead'$$,
  'grant_exceeds_holder:%', 'an admin cannot put a capability they lack into a custom role');
select lives_ok(
  $$insert into app.role_capabilities (role_id, capability_code, reach)
    select id, 'finance.po.approve', 'organization' from app.roles where code = 'finance_lead'$$,
  'an admin builds a custom role from capabilities they hold');
select throws_like(
  $$insert into app.roles (org_id, code, name, band) values (pg_temp.id('org_a'), 'owner', 'Owner Two', 2)$$,
  'role_code_reserved:%', 'a custom role cannot reuse a system role code');
select lives_ok(
  $$insert into app.membership_roles (membership_id, role_id)
    select pg_temp.id('erin@org_a'), id from app.roles where code = 'finance_lead'$$,
  'an admin assigns the custom role');
select pg_temp.claims('erin');
select ok(private.has_capability(pg_temp.id('org_a'), 'finance.po.approve'), 'a custom role adds its capabilities to the member''s union');
select pg_temp.claims('bob');
select throws_like(
  $$update app.roles set description = 'Changed.' where org_id is null and code = 'owner'$$,
  'system_role_immutable:%', 'system roles cannot be edited by a person');
select pg_temp.as_user('xavier');
select throws_like(
  $$insert into app.roles (org_id, code, name, band) values (pg_temp.id('org_b'), 'stage_lead', 'Stage Lead', 4)$$,
  'plan_feature_unavailable:%', 'custom roles need the Team plan');
select pg_temp.as_platform();

-- Time-boxed access (Section 8) ----------------------------------------------------------------
update app.memberships set valid_from = now() - interval '10 days', valid_to = now() - interval '1 day'
where id = pg_temp.id('gina@org_a');
select pg_temp.claims('gina');
select ok(not private.is_member(pg_temp.id('org_a')), 'an expired membership is not a membership');
select ok(not private.has_capability(pg_temp.id('org_a'), 'reports.report.read'), 'an expired membership grants nothing');
select pg_temp.as_platform();
insert into app.memberships (org_id, person_id, valid_from) values (pg_temp.id('org_a'), pg_temp.id('nina'), now() + interval '1 day');
select pg_temp.claims('nina');
select ok(not private.is_member(pg_temp.id('org_a')), 'a membership that has not started is not a membership');
select pg_temp.as_platform();
select throws_like(
  $$insert into app.memberships (org_id, person_id, valid_from) values (pg_temp.id('org_a'), pg_temp.id('nina'), now() + interval '2 days')$$,
  'membership_overlap:%', 'membership periods for one person in one org never overlap');

insert into app.user_capability_grants (membership_id, capability_code, reason, valid_from, valid_to)
values (pg_temp.id('dave@org_a'), 'audit.log.export', 'Ended grant.', now() - interval '3 days', now() - interval '1 day'),
       (pg_temp.id('dave@org_a'), 'org.webhooks.manage', 'Future grant.', now() + interval '1 day', null),
       (pg_temp.id('dave@org_a'), 'org.integrations.manage', 'Current grant.', now() - interval '1 day', now() + interval '1 day');
select pg_temp.claims('dave');
select ok(not private.has_capability(pg_temp.id('org_a'), 'audit.log.export'), 'an ended grant gives nothing');
select ok(not private.has_capability(pg_temp.id('org_a'), 'org.webhooks.manage'), 'a grant that has not started gives nothing');
select ok(private.has_capability(pg_temp.id('org_a'), 'org.integrations.manage'), 'a current grant gives its capability');
select pg_temp.as_platform();

-- Delegations ----------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.delegations (delegator_membership_id, delegate_membership_id, capability_code, valid_from, valid_to, reason)
values (pg_temp.id('carol@org_a'), pg_temp.id('mia@org_a'), null, now() - interval '1 hour', now() + interval '1 day',
        'Out of office for the load-out.');
select pg_temp.claims('mia');
select ok(private.has_capability(pg_temp.id('org_a'), 'crew.timesheet.approve'), 'a delegate gains the delegator''s approvals');
select ok(not private.has_capability(pg_temp.id('org_a'), 'finance.budget.write'), 'a delegation of approvals does not pass on writes');
select pg_temp.as_user('dave');
select throws_like(
  $$insert into app.delegations (delegator_membership_id, delegate_membership_id, capability_code, valid_from, valid_to, reason)
    values (pg_temp.id('dave@org_a'), pg_temp.id('frank@org_a'), 'org.billing.manage', now(), now() + interval '1 day', 'Cover.')$$,
  'grant_exceeds_holder:%', 'a person delegates only what they hold');
select throws_like(
  $$insert into app.delegations (delegator_membership_id, delegate_membership_id, valid_from, valid_to, reason)
    values (pg_temp.id('dave@org_a'), pg_temp.id('dave@org_a'), now(), now() + interval '1 day', 'Self.')$$,
  'sod_self_grant:%', 'a person cannot delegate to themselves');
select pg_temp.as_platform();

-- Invariant 1: org derivation, no tenant move, no cross-org references ------------------------
with r as (
  insert into app.workspace_members (org_id, workspace_id, membership_id)
  values (pg_temp.id('org_b'), pg_temp.id('ws_a'), pg_temp.id('dave@org_a'))
  returning org_id
)
select is((select org_id from r), pg_temp.id('org_a'), 'org_id comes from the parent row, never from the caller');
select throws_like(
  $$insert into app.workspace_members (workspace_id, membership_id) values (pg_temp.id('ws_a'), pg_temp.id('xavier@org_b'))$$,
  'cross_org_reference:%', 'a workspace member from another org is refused');
select throws_like(
  $$insert into app.team_members (team_id, membership_id) values (pg_temp.id('team_b'), pg_temp.id('dave@org_a'))$$,
  'cross_org_reference:%', 'a team member from another org is refused');
select throws_like(
  $$insert into app.membership_roles (membership_id, role_id)
    select pg_temp.id('xavier@org_b'), id from app.roles where code = 'finance_lead'$$,
  'cross_org_reference:%', 'a custom role of another org cannot be assigned');
select throws_like(
  $$insert into app.delegations (delegator_membership_id, delegate_membership_id, valid_from, valid_to, reason)
    values (pg_temp.id('carol@org_a'), pg_temp.id('xavier@org_b'), now(), now() + interval '1 day', 'Cross org.')$$,
  'cross_org_reference:%', 'a delegation to another org is refused');
select throws_like(
  $$insert into app.user_capability_grants (membership_id, capability_code, scope_kind, scope_id, reason)
    values (pg_temp.id('dave@org_a'), 'work.record.write', 'workspace', pg_temp.id('ws_b'), 'Cross org.')$$,
  'cross_org_reference:%', 'a grant scoped to another org''s workspace is refused');
select throws_like(
  $$update app.workspaces set org_id = pg_temp.id('org_b') where id = pg_temp.id('ws_a')$$,
  'tenant_move:%', 'a workspace cannot move to another org');
select throws_like(
  $$update app.workspace_members set workspace_id = pg_temp.id('ws_b') where membership_id = pg_temp.id('frank@org_a')$$,
  'tenant_move:%', 're-parenting a row into another org is a tenant move');
select throws_like(
  $$update app.memberships set org_id = pg_temp.id('org_b') where id = pg_temp.id('dave@org_a')$$,
  'tenant_move:%', 'a membership cannot move to another org');

-- Partner hierarchy (Section 4.6.1) -------------------------------------------------------------
select is((select parent_org_id from app.organizations where id = pg_temp.id('org_c')), pg_temp.id('org_p'),
  'a partner creates a client org under itself');
select throws_like(
  $$insert into app.organizations (name, slug, parent_org_id) values ('Fourth Level', 'fourth-level', pg_temp.id('org_c'))$$,
  'partner_depth:%', 'a client org cannot have clients of its own');
select throws_like(
  $$update app.organizations set parent_org_id = pg_temp.id('org_b') where id = pg_temp.id('org_p')$$,
  'partner_depth:%', 'a partner cannot have a parent partner');
select throws_ok(
  $$update app.organizations set parent_org_id = id where id = pg_temp.id('org_a')$$,
  '23514', null, 'an org cannot be its own partner');
select pg_temp.claims('paul');
select ok(not private.is_member(pg_temp.id('org_c')), 'partner staff are not members of the client org');
select ok(not private.has_capability(pg_temp.id('org_c'), 'projects.project.read'), 'partner staff have no client data access by default');
select pg_temp.as_user('cora');
insert into app.record_grants (target_kind, target_id, capability_code, grantee_org_id, valid_to, reason)
values ('organization', pg_temp.id('org_c'), 'projects.project.read', pg_temp.id('org_p'), now() + interval '30 days',
        'Partner agreement, support clause.');
select pg_temp.claims('paul');
select ok(private.has_capability(pg_temp.id('org_c'), 'projects.project.read'), 'a standing partner grant gives partner staff its capability');
select ok(not private.has_capability(pg_temp.id('org_c'), 'finance.budget.read'), 'a partner grant gives only the capability it names');
select pg_temp.as_user('cora');
update app.record_grants set valid_to = now() where grantee_org_id = pg_temp.id('org_p');
select pg_temp.claims('paul');
select ok(not private.has_capability(pg_temp.id('org_c'), 'projects.project.read'), 'an expired partner grant gives nothing');
select pg_temp.as_platform();

-- Plan limits (Section 16) ------------------------------------------------------------------------
select is(private.plan_limit(pg_temp.id('org_b'), 'seats'), 1::bigint, 'an Access org has one seat');
select is(private.plan_limit(pg_temp.id('org_a'), 'seats'), null::bigint, 'a Team org has unlimited seats');
select is((select seats from private.membership_band_counts(pg_temp.id('org_b'))), 1::bigint,
  'viewers do not take seats');
select is((select field_members from private.membership_band_counts(pg_temp.id('org_a'))), 1::bigint,
  'field members are metered separately');
create temporary table nina_invite as
  select pg_temp.invite_token('xavier', 'org_b', 'nina@nowhere.test', 'member') as token;
grant select on nina_invite to public;
select pg_temp.as_user('nina');
select throws_like($$select * from app.accept_invite((select token from nina_invite))$$,
  'plan_limit_exceeded:%', 'joining as a second seat on the Access plan is refused');
select pg_temp.as_platform();

-- Subscription lifecycle -----------------------------------------------------------------------
select lives_ok(
  $$select private.transition_subscription((select id from app.subscriptions where org_id = pg_temp.id('org_b')),
    'active', 'past_due', 'Card declined.')$$,
  'a subscription moves along an allowed transition');
select is((select subscription_state from app.subscriptions where org_id = pg_temp.id('org_b')), 'past_due'::app.subscription_state,
  'the new state is stored');
select is((select count(*)::integer from app.subscription_state_transitions where org_id = pg_temp.id('org_b')), 2,
  'creation and the change are both in the ledger');
select throws_like(
  $$select private.transition_subscription((select id from app.subscriptions where org_id = pg_temp.id('org_b')),
    'active', 'past_due', 'Stale.')$$,
  'subscription_state_conflict:%', 'compare-and-set refuses a stale expected state');
select throws_like(
  $$select private.transition_subscription((select id from app.subscriptions where org_id = pg_temp.id('org_b')),
    'past_due', 'trialing', 'Backwards.')$$,
  'subscription_transition_not_allowed:%', 'a transition outside the rules is refused');
select throws_like(
  $$update app.subscription_state_transitions set reason = 'Edited.' where org_id = pg_temp.id('org_b')$$,
  'append_only:%', 'the transition ledger is append-only');

-- Invariant 4: sole Owner --------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_like($$select app.leave_organization(pg_temp.id('org_a'))$$,
  'sole_owner:%', 'the sole Owner cannot leave');
select throws_like(
  $$update app.membership_roles set deleted_at = now()
    where membership_id = pg_temp.id('alice@org_a') and role_id = pg_temp.system_role('owner')$$,
  'sole_owner:%', 'the sole Owner cannot demote themselves');
select pg_temp.as_user('bob');
select throws_like(
  $$update app.membership_roles set deleted_at = now()
    where membership_id = pg_temp.id('alice@org_a') and role_id = pg_temp.system_role('owner')$$,
  'role_band:%', 'an admin cannot remove an Owner');
select throws_ok($$select app.end_membership(pg_temp.id('alice@org_a'))$$, '42501', null,
  'an admin cannot end an Owner''s membership');
select pg_temp.as_platform();
select throws_like(
  $$update app.membership_roles set deleted_at = now()
    where membership_id = pg_temp.id('xavier@org_b') and role_id = pg_temp.system_role('owner')$$,
  'sole_owner:%', 'even a platform process cannot leave an org without an Owner');
select pg_temp.as_user('alice');
select lives_ok(
  $$insert into app.membership_roles (membership_id, role_id) values (pg_temp.id('bob@org_a'), pg_temp.system_role('owner'))$$,
  'an Owner makes another member an Owner');
select lives_ok(
  $$update app.membership_roles set deleted_at = now()
    where membership_id = pg_temp.id('alice@org_a') and role_id = pg_temp.system_role('owner')$$,
  'with a second Owner, an Owner may step down');
select pg_temp.as_user('bob');
select throws_like($$select app.leave_organization(pg_temp.id('org_a'))$$,
  'sole_owner:%', 'the new sole Owner cannot leave either');
select pg_temp.as_platform();

-- Invariant 3: leaving ends access at once ---------------------------------------------------------
select pg_temp.as_user('dave');
select isnt_empty($$select 1 from app.workspaces where org_id = pg_temp.id('org_a')$$, 'before leaving, dave sees Northwind workspaces');
select lives_ok($$select app.leave_organization(pg_temp.id('org_a'))$$, 'a member leaves');
select is_empty($$select 1 from app.workspaces where org_id = pg_temp.id('org_a')$$, 'after leaving, dave sees no Northwind workspace');
select is_empty($$select 1 from app.organizations where id = pg_temp.id('org_a')$$, 'after leaving, dave no longer sees the org');
select pg_temp.claims('dave');
select ok(not private.is_member(pg_temp.id('org_a')), 'after leaving, dave is not a member');
select ok(not private.has_capability(pg_temp.id('org_a'), 'org.integrations.manage'), 'after leaving, direct grants stop too');
select pg_temp.as_user('carol');
select throws_ok($$select app.end_membership(pg_temp.id('erin@org_a'))$$, '42501', null, 'a manager cannot remove members');
select pg_temp.as_user('bob');
select lives_ok($$select app.end_membership(pg_temp.id('erin@org_a'))$$, 'an owner removes a member');
select pg_temp.claims('erin');
select ok(not private.is_member(pg_temp.id('org_a')), 'a removed member loses access at once');
select pg_temp.as_platform();

select * from finish();
rollback;
