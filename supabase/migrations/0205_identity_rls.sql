-- 0205_identity_rls.sql
-- A02 Platform Data. Table privileges and row level security for the identity core
-- (Section 7.5 invariants 5 and 7). Policies use helpers from private, wrap auth.uid() in a
-- subselect, and pair read and write halves. Set-returning helpers sit inside
-- org_id in (select ...) so each runs once per statement.
-- anon receives nothing: it has no usage on app (0001) and no privilege on these tables.

-- Privileges ---------------------------------------------------------------------------------

revoke all on
  app.organizations, app.people, app.subscriptions, app.subscription_state_transitions, app.workspaces,
  app.memberships, app.roles, app.role_capabilities, app.membership_roles, app.workspace_members,
  app.teams, app.team_members, app.user_capability_grants, app.record_grants, app.delegations, app.invites
from public, anon, authenticated;

grant select on
  app.organizations, app.people, app.subscriptions, app.subscription_state_transitions, app.workspaces,
  app.memberships, app.roles, app.role_capabilities, app.membership_roles, app.workspace_members,
  app.teams, app.team_members, app.user_capability_grants, app.record_grants, app.delegations
to authenticated;

-- The invite token hash stays out of reach even of the people who manage invites.
grant select (id, org_id, email, role_id, expires_at, invited_by, partner_bootstrap, failed_attempts, accepted_at,
  accepted_person_id, revoked_at, created_at, created_by, updated_at, updated_by, deleted_at)
on app.invites to authenticated;

grant all on
  app.organizations, app.people, app.subscriptions, app.subscription_state_transitions, app.workspaces,
  app.memberships, app.roles, app.role_capabilities, app.membership_roles, app.workspace_members,
  app.teams, app.team_members, app.user_capability_grants, app.record_grants, app.delegations, app.invites
to service_role;

-- Writes reach only the columns a person may change. org_id, audit columns and identity
-- columns are never writable by authenticated; RPCs in 0206 handle the rest.
grant update (name, slug) on app.organizations to authenticated;
grant update (full_name) on app.people to authenticated;
grant insert (org_id, slug, name), update (slug, name, deleted_at) on app.workspaces to authenticated;
grant insert (workspace_id, membership_id), update (deleted_at) on app.workspace_members to authenticated;
grant insert (org_id, name, description), update (name, description, deleted_at) on app.teams to authenticated;
grant insert (team_id, membership_id), update (deleted_at) on app.team_members to authenticated;
grant insert (membership_id, role_id), update (deleted_at) on app.membership_roles to authenticated;
grant insert (org_id, code, name, band, description), update (name, description, deleted_at) on app.roles to authenticated;
grant insert (role_id, capability_code, reach), update (deleted_at) on app.role_capabilities to authenticated;
grant insert (membership_id, capability_code, scope_kind, scope_id, valid_from, valid_to, reason),
  update (valid_to, deleted_at) on app.user_capability_grants to authenticated;
grant insert (target_kind, target_id, capability_code, grantee_person_id, grantee_org_id, valid_from, valid_to, reason),
  update (valid_to, deleted_at) on app.record_grants to authenticated;
grant insert (delegator_membership_id, delegate_membership_id, capability_code, valid_from, valid_to, reason),
  update (valid_to, deleted_at) on app.delegations to authenticated;
grant update (revoked_at) on app.invites to authenticated;

-- Organizations ----------------------------------------------------------------------------------

create policy organizations_read on app.organizations for select to authenticated
  using (
    id in (select private.my_org_ids())
    or id in (select private.orgs_with_capability('org.settings.read'))
    or parent_org_id in (select private.orgs_with_capability('org.partner.manage'))
  );
create policy organizations_insert on app.organizations for insert to authenticated
  with check (parent_org_id in (select private.orgs_with_capability('org.partner.manage')));
create policy organizations_update on app.organizations for update to authenticated
  using (id in (select private.orgs_with_capability('org.general.write')))
  with check (id in (select private.orgs_with_capability('org.general.write')));
create policy organizations_delete on app.organizations for delete to authenticated
  using (id in (select private.orgs_with_capability('org.organization.delete')));

-- People ------------------------------------------------------------------------------------------

create policy people_read on app.people for select to authenticated
  using (user_id = (select auth.uid()) or id in (select private.visible_person_ids()));
create policy people_insert on app.people for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy people_update on app.people for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy people_delete on app.people for delete to authenticated
  using (user_id = (select auth.uid()));

-- Subscriptions --------------------------------------------------------------------------------------

create policy subscriptions_read on app.subscriptions for select to authenticated
  using (org_id in (select private.my_org_ids()));
create policy subscriptions_insert on app.subscriptions for insert to authenticated
  with check (org_id in (select private.orgs_with_capability('org.billing.manage')));
create policy subscriptions_update on app.subscriptions for update to authenticated
  using (org_id in (select private.orgs_with_capability('org.billing.manage')))
  with check (org_id in (select private.orgs_with_capability('org.billing.manage')));
create policy subscriptions_delete on app.subscriptions for delete to authenticated
  using (org_id in (select private.orgs_with_capability('org.billing.manage')));

create policy subscription_state_transitions_read on app.subscription_state_transitions for select to authenticated
  using (org_id in (select private.orgs_with_capability('org.billing.read')));
create policy subscription_state_transitions_insert on app.subscription_state_transitions for insert to authenticated
  with check (org_id in (select private.orgs_with_capability('org.billing.manage')));

-- Workspaces and teams ----------------------------------------------------------------------------

create policy workspaces_read on app.workspaces for select to authenticated
  using (org_id in (select private.my_org_ids()));
create policy workspaces_insert on app.workspaces for insert to authenticated
  with check (org_id in (select private.orgs_with_capability('org.workspaces.manage')));
create policy workspaces_update on app.workspaces for update to authenticated
  using (org_id in (select private.orgs_with_capability('org.workspaces.manage')))
  with check (org_id in (select private.orgs_with_capability('org.workspaces.manage')));
create policy workspaces_delete on app.workspaces for delete to authenticated
  using (org_id in (select private.orgs_with_capability('org.workspaces.manage')));

create policy workspace_members_read on app.workspace_members for select to authenticated
  using (org_id in (select private.my_org_ids()));
create policy workspace_members_insert on app.workspace_members for insert to authenticated
  with check (org_id in (select private.orgs_with_capability('org.workspaces.manage')));
create policy workspace_members_update on app.workspace_members for update to authenticated
  using (org_id in (select private.orgs_with_capability('org.workspaces.manage')))
  with check (org_id in (select private.orgs_with_capability('org.workspaces.manage')));
create policy workspace_members_delete on app.workspace_members for delete to authenticated
  using (org_id in (select private.orgs_with_capability('org.workspaces.manage')));

create policy teams_read on app.teams for select to authenticated
  using (org_id in (select private.my_org_ids()));
create policy teams_insert on app.teams for insert to authenticated
  with check (org_id in (select private.orgs_with_capability('org.teams.manage')));
create policy teams_update on app.teams for update to authenticated
  using (org_id in (select private.orgs_with_capability('org.teams.manage')))
  with check (org_id in (select private.orgs_with_capability('org.teams.manage')));
create policy teams_delete on app.teams for delete to authenticated
  using (org_id in (select private.orgs_with_capability('org.teams.manage')));

create policy team_members_read on app.team_members for select to authenticated
  using (org_id in (select private.my_org_ids()));
create policy team_members_insert on app.team_members for insert to authenticated
  with check (org_id in (select private.orgs_with_capability('org.teams.manage')));
create policy team_members_update on app.team_members for update to authenticated
  using (org_id in (select private.orgs_with_capability('org.teams.manage')))
  with check (org_id in (select private.orgs_with_capability('org.teams.manage')));
create policy team_members_delete on app.team_members for delete to authenticated
  using (org_id in (select private.orgs_with_capability('org.teams.manage')));

-- Memberships and roles ---------------------------------------------------------------------------
-- A member always sees their own memberships and roles; the directory needs
-- people.directory.read or org.members.read.

create policy memberships_read on app.memberships for select to authenticated
  using (
    person_id = (select private.current_person_id())
    or org_id in (select private.orgs_with_capability('people.directory.read'))
    or org_id in (select private.orgs_with_capability('org.members.read'))
  );
create policy memberships_insert on app.memberships for insert to authenticated
  with check (org_id in (select private.orgs_with_capability('org.members.manage')));
create policy memberships_update on app.memberships for update to authenticated
  using (
    person_id = (select private.current_person_id())
    or org_id in (select private.orgs_with_capability('org.members.manage'))
  )
  with check (
    person_id = (select private.current_person_id())
    or org_id in (select private.orgs_with_capability('org.members.manage'))
  );
create policy memberships_delete on app.memberships for delete to authenticated
  using (org_id in (select private.orgs_with_capability('org.members.manage')));

create policy membership_roles_read on app.membership_roles for select to authenticated
  using (
    membership_id in (select private.my_membership_ids())
    or org_id in (select private.orgs_with_capability('people.directory.read'))
    or org_id in (select private.orgs_with_capability('org.members.read'))
  );
create policy membership_roles_insert on app.membership_roles for insert to authenticated
  with check (org_id in (select private.orgs_with_capability('org.members.manage')));
create policy membership_roles_update on app.membership_roles for update to authenticated
  using (
    membership_id in (select private.my_membership_ids())
    or org_id in (select private.orgs_with_capability('org.members.manage'))
  )
  with check (
    membership_id in (select private.my_membership_ids())
    or org_id in (select private.orgs_with_capability('org.members.manage'))
  );
create policy membership_roles_delete on app.membership_roles for delete to authenticated
  using (org_id in (select private.orgs_with_capability('org.members.manage')));

create policy roles_read on app.roles for select to authenticated
  using (org_id is null or org_id in (select private.my_org_ids()));
create policy roles_insert on app.roles for insert to authenticated
  with check (org_id in (select private.orgs_with_capability('org.roles.manage')));
create policy roles_update on app.roles for update to authenticated
  using (org_id in (select private.orgs_with_capability('org.roles.manage')))
  with check (org_id in (select private.orgs_with_capability('org.roles.manage')));
create policy roles_delete on app.roles for delete to authenticated
  using (org_id in (select private.orgs_with_capability('org.roles.manage')));

create policy role_capabilities_read on app.role_capabilities for select to authenticated
  using (org_id is null or org_id in (select private.my_org_ids()));
create policy role_capabilities_insert on app.role_capabilities for insert to authenticated
  with check (org_id in (select private.orgs_with_capability('org.roles.manage')));
create policy role_capabilities_update on app.role_capabilities for update to authenticated
  using (org_id in (select private.orgs_with_capability('org.roles.manage')))
  with check (org_id in (select private.orgs_with_capability('org.roles.manage')));
create policy role_capabilities_delete on app.role_capabilities for delete to authenticated
  using (org_id in (select private.orgs_with_capability('org.roles.manage')));

-- Grants and delegations ------------------------------------------------------------------------------

create policy user_capability_grants_read on app.user_capability_grants for select to authenticated
  using (
    membership_id in (select private.my_membership_ids())
    or org_id in (select private.orgs_with_capability('org.members.read'))
  );
create policy user_capability_grants_insert on app.user_capability_grants for insert to authenticated
  with check (org_id in (select private.orgs_with_capability('org.members.manage')));
create policy user_capability_grants_update on app.user_capability_grants for update to authenticated
  using (org_id in (select private.orgs_with_capability('org.members.manage')))
  with check (org_id in (select private.orgs_with_capability('org.members.manage')));
create policy user_capability_grants_delete on app.user_capability_grants for delete to authenticated
  using (org_id in (select private.orgs_with_capability('org.members.manage')));

create policy record_grants_read on app.record_grants for select to authenticated
  using (
    grantee_person_id = (select private.current_person_id())
    or grantee_org_id in (select private.my_org_ids())
    or org_id in (select private.orgs_with_capability('org.access_grants.manage'))
  );
create policy record_grants_insert on app.record_grants for insert to authenticated
  with check (org_id in (select private.orgs_with_capability('org.access_grants.manage')));
create policy record_grants_update on app.record_grants for update to authenticated
  using (org_id in (select private.orgs_with_capability('org.access_grants.manage')))
  with check (org_id in (select private.orgs_with_capability('org.access_grants.manage')));
create policy record_grants_delete on app.record_grants for delete to authenticated
  using (org_id in (select private.orgs_with_capability('org.access_grants.manage')));

create policy delegations_read on app.delegations for select to authenticated
  using (
    delegator_membership_id in (select private.my_membership_ids())
    or delegate_membership_id in (select private.my_membership_ids())
    or org_id in (select private.orgs_with_capability('org.members.read'))
  );
create policy delegations_insert on app.delegations for insert to authenticated
  with check (
    delegator_membership_id in (select private.my_membership_ids())
    or org_id in (select private.orgs_with_capability('org.members.manage'))
  );
create policy delegations_update on app.delegations for update to authenticated
  using (
    delegator_membership_id in (select private.my_membership_ids())
    or org_id in (select private.orgs_with_capability('org.members.manage'))
  )
  with check (
    delegator_membership_id in (select private.my_membership_ids())
    or org_id in (select private.orgs_with_capability('org.members.manage'))
  );
create policy delegations_delete on app.delegations for delete to authenticated
  using (org_id in (select private.orgs_with_capability('org.members.manage')));

-- Invites ---------------------------------------------------------------------------------------------

create policy invites_read on app.invites for select to authenticated
  using (
    org_id in (select private.orgs_with_capability('org.members.invite'))
    or org_id in (select private.orgs_with_capability('org.members.read'))
  );
create policy invites_insert on app.invites for insert to authenticated
  with check (org_id in (select private.orgs_with_capability('org.members.invite')));
create policy invites_update on app.invites for update to authenticated
  using (org_id in (select private.orgs_with_capability('org.members.invite')))
  with check (org_id in (select private.orgs_with_capability('org.members.invite')));
create policy invites_delete on app.invites for delete to authenticated
  using (org_id in (select private.orgs_with_capability('org.members.invite')));
