-- 0202_identity_core.sql
-- A02 Platform Data. The canonical identity core (Section 4.8.1, Section 7.3 final names,
-- ADR 0005): organizations, people, subscriptions, workspaces, memberships, roles,
-- capability grants, record grants, delegations, invites and teams.
--
-- organizations and people are platform identity rows, not tenant rows: an organization is
-- the tenant root (a tenant is an organization with a subscription) and a person is global
-- across tenants. Every other table here is a tenant table carrying org_id. roles and
-- role_capabilities allow a null org_id for the seven platform system roles only.

-- Organizations ----------------------------------------------------------------------------

create table app.organizations (
  id uuid primary key default private.uuid_v7(),
  slug text not null,
  name text not null,
  parent_org_id uuid references app.organizations (id),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  constraint organizations_slug_format check (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 2 and 48
  ),
  constraint organizations_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint organizations_not_own_parent check (parent_org_id <> id)
);

create unique index organizations_slug_key on app.organizations (slug);
create index organizations_parent_org_id_idx on app.organizations (parent_org_id);

comment on table app.organizations is 'Every company on the platform: a tenant (with a subscription), an external account, or both (Section 4.8.1). Holds only organization-owned identity facts.';
comment on column app.organizations.id is 'Organization id. Tenant tables store it as org_id.';
comment on column app.organizations.slug is 'Lowercase hyphenated URL segment, unique across the platform (Section 4.5.3).';
comment on column app.organizations.name is 'Organization display name.';
comment on column app.organizations.parent_org_id is 'Partner org of a client org (Section 4.6.1). Three levels at most: a partner cannot have a parent partner.';

-- People -------------------------------------------------------------------------------------

create table app.people (
  id uuid primary key default private.uuid_v7(),
  user_id uuid references auth.users (id) on delete set null,
  full_name text,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint people_full_name_length check (full_name is null or char_length(btrim(full_name)) between 1 and 200)
);

create unique index people_user_id_key on app.people (user_id);

comment on table app.people is 'One human, linked to at most one sign-in (Section 4.8.1). Global across orgs; profile facts live with A30 person profiles, which must not restate full_name.';
comment on column app.people.id is 'Person id.';
comment on column app.people.user_id is 'Supabase Auth user this person signs in as. Null once the sign-in is deleted.';
comment on column app.people.full_name is 'The name the person gives for themselves. Null until the person provides it.';

alter table app.organizations
  add constraint organizations_created_by_fkey foreign key (created_by) references app.people (id),
  add constraint organizations_updated_by_fkey foreign key (updated_by) references app.people (id);

-- Current person ----------------------------------------------------------------------------

create or replace function private.current_person_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from app.people p
  where p.user_id = (select auth.uid()) and p.deleted_at is null;
$$;

comment on function private.current_person_id() is 'Person id of the signed-in user, or null for anon and platform processes.';
revoke all on function private.current_person_id() from public, anon;
grant execute on function private.current_person_id() to authenticated, service_role;

call private.install_audit_columns('app.organizations');
call private.install_audit_columns('app.people');

-- Subscriptions -----------------------------------------------------------------------------

create table app.subscriptions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  plan_code text not null references app.plans (code),
  subscription_state app.subscription_state not null,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz
);

create index subscriptions_org_id_idx on app.subscriptions (org_id);
create unique index subscriptions_one_current_per_org on app.subscriptions (org_id)
  where subscription_state <> 'canceled' and deleted_at is null;
create index subscriptions_plan_code_idx on app.subscriptions (plan_code);

comment on table app.subscriptions is 'Present only when an organization uses Atlas (Section 4.8.1). At most one subscription per org is not canceled.';
comment on column app.subscriptions.id is 'Subscription id.';
comment on column app.subscriptions.org_id is 'Subscribing organization.';
comment on column app.subscriptions.plan_code is 'Current plan.';
comment on column app.subscriptions.subscription_state is 'Lifecycle state, changed only by private.transition_subscription.';

create table app.subscription_state_transitions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  subscription_id uuid not null references app.subscriptions (id),
  from_state app.subscription_state,
  to_state app.subscription_state not null,
  reason text not null,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint subscription_state_transitions_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index subscription_state_transitions_org_id_idx on app.subscription_state_transitions (org_id);
create index subscription_state_transitions_subscription_id_idx on app.subscription_state_transitions (subscription_id);

comment on table app.subscription_state_transitions is 'Append-only ledger of subscription state changes, written only by private.transition_subscription and subscription creation.';
comment on column app.subscription_state_transitions.id is 'Transition id.';
comment on column app.subscription_state_transitions.org_id is 'Org of the subscription, derived from it.';
comment on column app.subscription_state_transitions.subscription_id is 'Subscription that changed state.';
comment on column app.subscription_state_transitions.from_state is 'State before the change; null for the creation entry.';
comment on column app.subscription_state_transitions.to_state is 'State after the change.';
comment on column app.subscription_state_transitions.reason is 'Why the state changed, for example a billing event.';

-- Workspaces ----------------------------------------------------------------------------------

create table app.workspaces (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  slug text not null,
  name text not null,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint workspaces_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 1 and 48),
  constraint workspaces_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint workspaces_org_slug_key unique (org_id, slug)
);

comment on table app.workspaces is 'A division of an org, for example a city office or a venue group, that scopes projects and members (Section 4.5.1).';
comment on column app.workspaces.id is 'Workspace id.';
comment on column app.workspaces.org_id is 'Owning org.';
comment on column app.workspaces.slug is 'Lowercase hyphenated key, unique within the org.';
comment on column app.workspaces.name is 'Workspace display name.';

-- Memberships ----------------------------------------------------------------------------------

create table app.memberships (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint memberships_valid_period check (valid_to is null or valid_to >= valid_from)
);

create index memberships_org_id_idx on app.memberships (org_id);
create index memberships_person_org_idx on app.memberships (person_id, org_id);

comment on table app.memberships is 'A person in an organization as an internal member (Section 4.8.1). Access holds only between valid_from and valid_to; periods for one person in one org never overlap.';
comment on column app.memberships.id is 'Membership id.';
comment on column app.memberships.org_id is 'Org the person belongs to.';
comment on column app.memberships.person_id is 'Member.';
comment on column app.memberships.valid_from is 'When access starts.';
comment on column app.memberships.valid_to is 'When access ends; null while open-ended. Leaving sets it to the current time.';

-- Roles ------------------------------------------------------------------------------------------

create table app.roles (
  id uuid primary key default private.uuid_v7(),
  org_id uuid references app.organizations (id),
  code text not null,
  name text,
  band smallint not null,
  description text,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint roles_code_format check (code ~ '^[a-z][a-z0-9_]{1,47}$'),
  constraint roles_band_range check (band between 1 and 7),
  constraint roles_custom_band check (org_id is null or band between 2 and 7),
  constraint roles_custom_name check ((org_id is null) = (name is null)),
  constraint roles_name_length check (name is null or char_length(btrim(name)) between 1 and 100)
);

create unique index roles_system_code_key on app.roles (code) where org_id is null;
create unique index roles_org_code_key on app.roles (org_id, code) where org_id is not null;

comment on table app.roles is 'Platform system roles (org_id null, generated from capabilities.yaml) and org custom roles built from the capability set (Section 8).';
comment on column app.roles.id is 'Role id.';
comment on column app.roles.org_id is 'Org that owns a custom role; null for the seven platform system roles.';
comment on column app.roles.code is 'Role code. System role labels come from the i18n catalogs keyed by it; custom role codes never reuse a system code.';
comment on column app.roles.name is 'Display name of a custom role; null for system roles.';
comment on column app.roles.band is 'Band in Section 8 order, 1 Owner to 7 Viewer. Custom roles take 2 to 7. A person may assign only roles at or below their own band; seats count members whose best band is above Field.';
comment on column app.roles.description is 'What the role is for.';

create table app.role_capabilities (
  id uuid primary key default private.uuid_v7(),
  org_id uuid,
  role_id uuid not null references app.roles (id),
  capability_code text not null references app.capabilities (code),
  reach app.capability_reach not null,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint role_capabilities_org_id_fkey foreign key (org_id) references app.organizations (id)
);

create index role_capabilities_org_id_idx on app.role_capabilities (org_id);
create index role_capabilities_role_id_idx on app.role_capabilities (role_id);
create unique index role_capabilities_role_capability_key on app.role_capabilities (role_id, capability_code)
  where deleted_at is null;
create index role_capabilities_capability_code_idx on app.role_capabilities (capability_code);

comment on table app.role_capabilities is 'Capabilities a role grants and how far each reaches. System role rows are generated; custom role rows are edited by the org.';
comment on column app.role_capabilities.id is 'Grant id.';
comment on column app.role_capabilities.org_id is 'Org of the role, derived from it; null for system roles.';
comment on column app.role_capabilities.role_id is 'Role that grants the capability.';
comment on column app.role_capabilities.capability_code is 'Granted capability.';
comment on column app.role_capabilities.reach is 'Own rows, assigned scopes, or the whole org.';

create table app.membership_roles (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  role_id uuid not null references app.roles (id),
  granted_by uuid references app.people (id),
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz
);

create index membership_roles_org_id_idx on app.membership_roles (org_id);
create index membership_roles_membership_id_idx on app.membership_roles (membership_id);
create unique index membership_roles_membership_role_key on app.membership_roles (membership_id, role_id)
  where deleted_at is null;
create index membership_roles_role_id_idx on app.membership_roles (role_id);
create index membership_roles_granted_by_idx on app.membership_roles (granted_by);

comment on table app.membership_roles is 'Roles held through a membership; a member may hold several and capabilities are their union (Section 4.8.1).';
comment on column app.membership_roles.id is 'Assignment id.';
comment on column app.membership_roles.org_id is 'Org of the membership, derived from it.';
comment on column app.membership_roles.membership_id is 'Membership that holds the role.';
comment on column app.membership_roles.role_id is 'Held role: a system role or a custom role of the same org.';
comment on column app.membership_roles.granted_by is 'Person accountable for the grant (the inviter for an accepted invite); null when the platform granted the first Owner of a new org.';

-- Workspace members ------------------------------------------------------------------------------

create table app.workspace_members (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  workspace_id uuid not null references app.workspaces (id),
  membership_id uuid not null references app.memberships (id),
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz
);

create index workspace_members_org_id_idx on app.workspace_members (org_id);
create index workspace_members_workspace_id_idx on app.workspace_members (workspace_id);
create unique index workspace_members_workspace_membership_key on app.workspace_members (workspace_id, membership_id)
  where deleted_at is null;
create index workspace_members_membership_id_idx on app.workspace_members (membership_id);

comment on table app.workspace_members is 'Members assigned to a workspace. Assignment gives assigned-reach capabilities in that workspace.';
comment on column app.workspace_members.id is 'Assignment id.';
comment on column app.workspace_members.org_id is 'Org of the workspace, derived from it.';
comment on column app.workspace_members.workspace_id is 'Workspace.';
comment on column app.workspace_members.membership_id is 'Membership assigned to the workspace, in the same org.';

-- Teams -------------------------------------------------------------------------------------------

create table app.teams (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint teams_name_length check (char_length(btrim(name)) between 1 and 100)
);

create index teams_org_id_idx on app.teams (org_id);
create unique index teams_org_name_key on app.teams (org_id, lower(name)) where deleted_at is null;

comment on table app.teams is 'Working groups inside an org, distinct from canon teams (Section 7.3).';
comment on column app.teams.id is 'Team id.';
comment on column app.teams.org_id is 'Owning org.';
comment on column app.teams.name is 'Team name, unique within the org ignoring case.';
comment on column app.teams.description is 'What the team does.';

create table app.team_members (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  team_id uuid not null references app.teams (id),
  membership_id uuid not null references app.memberships (id),
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz
);

create index team_members_org_id_idx on app.team_members (org_id);
create index team_members_team_id_idx on app.team_members (team_id);
create unique index team_members_team_membership_key on app.team_members (team_id, membership_id)
  where deleted_at is null;
create index team_members_membership_id_idx on app.team_members (membership_id);

comment on table app.team_members is 'Members of a team. Membership gives assigned-reach capabilities scoped to the team.';
comment on column app.team_members.id is 'Team membership id.';
comment on column app.team_members.org_id is 'Org of the team, derived from it.';
comment on column app.team_members.team_id is 'Team.';
comment on column app.team_members.membership_id is 'Member, in the same org.';

-- Direct capability grants --------------------------------------------------------------------------

create table app.user_capability_grants (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  capability_code text not null references app.capabilities (code),
  scope_kind app.grant_target_kind,
  scope_id uuid,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  granted_by uuid references app.people (id),
  reason text not null,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint user_capability_grants_scope_pair check ((scope_kind is null) = (scope_id is null)),
  constraint user_capability_grants_scope_not_org check (scope_kind is distinct from 'organization'),
  constraint user_capability_grants_valid_period check (valid_to is null or valid_to >= valid_from),
  constraint user_capability_grants_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index user_capability_grants_org_id_idx on app.user_capability_grants (org_id);
create index user_capability_grants_membership_id_idx on app.user_capability_grants (membership_id, capability_code);
create index user_capability_grants_capability_code_idx on app.user_capability_grants (capability_code);
create index user_capability_grants_scope_id_idx on app.user_capability_grants (scope_id);
create index user_capability_grants_granted_by_idx on app.user_capability_grants (granted_by);

comment on table app.user_capability_grants is 'A capability granted to one member beyond their roles, org-wide or for one scope, time-boxed (Section 8).';
comment on column app.user_capability_grants.id is 'Grant id.';
comment on column app.user_capability_grants.org_id is 'Org of the membership, derived from it.';
comment on column app.user_capability_grants.membership_id is 'Membership that receives the capability.';
comment on column app.user_capability_grants.capability_code is 'Granted capability.';
comment on column app.user_capability_grants.scope_kind is 'Kind of scope the grant is limited to; null for an org-wide grant.';
comment on column app.user_capability_grants.scope_id is 'Workspace, team, project or record the grant is limited to; null for an org-wide grant.';
comment on column app.user_capability_grants.valid_from is 'When the grant starts.';
comment on column app.user_capability_grants.valid_to is 'When the grant ends; null while open-ended.';
comment on column app.user_capability_grants.granted_by is 'Person who granted it; never the grantee.';
comment on column app.user_capability_grants.reason is 'Why the grant was made.';

-- Record grants ------------------------------------------------------------------------------------

create table app.record_grants (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  target_kind app.grant_target_kind not null,
  target_id uuid not null,
  capability_code text not null references app.capabilities (code),
  grantee_person_id uuid references app.people (id),
  grantee_org_id uuid references app.organizations (id),
  valid_from timestamptz not null default now(),
  valid_to timestamptz not null,
  granted_by uuid references app.people (id),
  reason text not null,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint record_grants_one_grantee check (num_nonnulls(grantee_person_id, grantee_org_id) = 1),
  constraint record_grants_not_own_org check (grantee_org_id is distinct from org_id),
  constraint record_grants_valid_period check (valid_to >= valid_from),
  constraint record_grants_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index record_grants_org_id_idx on app.record_grants (org_id);
create index record_grants_target_idx on app.record_grants (target_id, capability_code);
create index record_grants_capability_code_idx on app.record_grants (capability_code);
create index record_grants_grantee_person_id_idx on app.record_grants (grantee_person_id);
create index record_grants_grantee_org_id_idx on app.record_grants (grantee_org_id);
create index record_grants_granted_by_idx on app.record_grants (granted_by);

comment on table app.record_grants is 'Access to an org, workspace, team, project or record granted to a person or another organization with scope and expiry, for example a standing partner grant (Section 4.6.1).';
comment on column app.record_grants.id is 'Grant id.';
comment on column app.record_grants.org_id is 'Org that owns the target, derived from it by private.scope_org.';
comment on column app.record_grants.target_kind is 'Kind of target.';
comment on column app.record_grants.target_id is 'Target row id.';
comment on column app.record_grants.capability_code is 'Capability the grant allows on the target.';
comment on column app.record_grants.grantee_person_id is 'Person who receives access; null when an organization does.';
comment on column app.record_grants.grantee_org_id is 'Organization whose active members receive access; null when a person does.';
comment on column app.record_grants.valid_from is 'When access starts.';
comment on column app.record_grants.valid_to is 'When access ends. Record grants always expire.';
comment on column app.record_grants.granted_by is 'Person who granted it; never the grantee.';
comment on column app.record_grants.reason is 'Why the grant was made, for example the partner agreement clause.';

-- Delegations ----------------------------------------------------------------------------------------

create table app.delegations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  delegator_membership_id uuid not null references app.memberships (id),
  delegate_membership_id uuid not null references app.memberships (id),
  capability_code text references app.capabilities (code),
  valid_from timestamptz not null,
  valid_to timestamptz not null,
  reason text not null,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint delegations_distinct_members check (delegator_membership_id <> delegate_membership_id),
  constraint delegations_valid_period check (valid_to > valid_from),
  constraint delegations_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index delegations_org_id_idx on app.delegations (org_id);
create index delegations_delegator_membership_id_idx on app.delegations (delegator_membership_id);
create index delegations_delegate_membership_id_idx on app.delegations (delegate_membership_id);
create index delegations_capability_code_idx on app.delegations (capability_code);

comment on table app.delegations is 'Time-boxed delegation of a member''s capability to another member of the same org, for example approvals while out of office. One hop only: delegated capabilities are not delegated again.';
comment on column app.delegations.id is 'Delegation id.';
comment on column app.delegations.org_id is 'Org of the delegator, derived from the membership.';
comment on column app.delegations.delegator_membership_id is 'Member who delegates.';
comment on column app.delegations.delegate_membership_id is 'Member who acts for the delegator; never the delegator.';
comment on column app.delegations.capability_code is 'Delegated capability; null delegates every approve-class capability the delegator holds.';
comment on column app.delegations.valid_from is 'When the delegation starts.';
comment on column app.delegations.valid_to is 'When the delegation ends. Delegations always expire.';
comment on column app.delegations.reason is 'Why the delegation exists.';

-- Invites -------------------------------------------------------------------------------------------

create table app.invites (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  email text not null,
  role_id uuid not null references app.roles (id),
  token_hash bytea not null,
  expires_at timestamptz not null,
  invited_by uuid not null references app.people (id),
  partner_bootstrap boolean not null default false,
  failed_attempts smallint not null default 0,
  accepted_at timestamptz,
  accepted_person_id uuid references app.people (id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint invites_email_format check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint invites_token_hash_length check (octet_length(token_hash) = 32),
  constraint invites_accepted_pair check ((accepted_at is null) = (accepted_person_id is null)),
  constraint invites_not_accepted_and_revoked check (accepted_at is null or revoked_at is null),
  constraint invites_failed_attempts_range check (failed_attempts between 0 and 5)
);

create unique index invites_token_hash_key on app.invites (token_hash);
create index invites_org_email_idx on app.invites (org_id, email);
create index invites_role_id_idx on app.invites (role_id);
create index invites_invited_by_idx on app.invites (invited_by);
create index invites_accepted_person_id_idx on app.invites (accepted_person_id);

comment on table app.invites is 'Invitation of an email address to an org with a role and expiry (Section 4.8.1). Only a SHA-256 hash of the token is stored; the token is shown once.';
comment on column app.invites.id is 'Invite id.';
comment on column app.invites.org_id is 'Org the invite joins.';
comment on column app.invites.email is 'Lowercased email the invite is for. Acceptance requires a confirmed sign-in with this email.';
comment on column app.invites.role_id is 'Role granted on acceptance: a system role or a custom role of the org.';
comment on column app.invites.token_hash is 'SHA-256 of the invite token.';
comment on column app.invites.expires_at is 'After this time the invite cannot be accepted.';
comment on column app.invites.invited_by is 'Person who issued the invite and is accountable for the role it grants.';
comment on column app.invites.partner_bootstrap is 'True for the first Owner invite a partner issues when it creates a client org (Section 4.6.1).';
comment on column app.invites.failed_attempts is 'Acceptance attempts with this token by a sign-in whose email did not match. The token locks at 5.';
comment on column app.invites.accepted_at is 'When the invite was accepted.';
comment on column app.invites.accepted_person_id is 'Person who accepted.';
comment on column app.invites.revoked_at is 'When the invite was revoked.';

-- Acceptance rate limit -----------------------------------------------------------------------------

create table private.invite_accept_failures (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  attempted_at timestamptz not null default now()
);

create index invite_accept_failures_user_idx on private.invite_accept_failures (user_id, attempted_at);

comment on table private.invite_accept_failures is 'Failed invite resolutions per sign-in, used to rate-limit token guessing (Section 9).';
comment on column private.invite_accept_failures.id is 'Attempt id.';
comment on column private.invite_accept_failures.user_id is 'Auth user who presented a token that did not resolve.';
comment on column private.invite_accept_failures.attempted_at is 'When the attempt happened.';

alter table private.invite_accept_failures enable row level security;
revoke all on private.invite_accept_failures from public, anon, authenticated;

-- Machinery --------------------------------------------------------------------------------------

call private.install_audit_columns('app.subscriptions');
call private.install_audit_columns('app.subscription_state_transitions');
call private.install_audit_columns('app.workspaces');
call private.install_audit_columns('app.memberships');
call private.install_audit_columns('app.roles');
call private.install_audit_columns('app.role_capabilities');
call private.install_audit_columns('app.membership_roles');
call private.install_audit_columns('app.workspace_members');
call private.install_audit_columns('app.teams');
call private.install_audit_columns('app.team_members');
call private.install_audit_columns('app.user_capability_grants');
call private.install_audit_columns('app.record_grants');
call private.install_audit_columns('app.delegations');
call private.install_audit_columns('app.invites');

call private.install_tenant_guards('app.subscriptions');
call private.install_tenant_guards('app.subscription_state_transitions', 'app.subscriptions', 'subscription_id');
call private.install_tenant_guards('app.workspaces');
call private.install_tenant_guards('app.memberships');
call private.install_tenant_guards('app.roles');
call private.install_tenant_guards('app.role_capabilities', 'app.roles', 'role_id');
call private.install_tenant_guards('app.membership_roles', 'app.memberships', 'membership_id',
  array['app.roles', 'role_id']);
call private.install_tenant_guards('app.workspace_members', 'app.workspaces', 'workspace_id',
  array['app.memberships', 'membership_id']);
call private.install_tenant_guards('app.teams');
call private.install_tenant_guards('app.team_members', 'app.teams', 'team_id',
  array['app.memberships', 'membership_id']);
call private.install_tenant_guards('app.user_capability_grants', 'app.memberships', 'membership_id');
call private.install_tenant_guards('app.record_grants');
call private.install_tenant_guards('app.delegations', 'app.memberships', 'delegator_membership_id',
  array['app.memberships', 'delegate_membership_id']);
call private.install_tenant_guards('app.invites', null, null, array['app.roles', 'role_id']);

create trigger t95_append_only before update or delete on app.subscription_state_transitions
  for each row execute function private.refuse_ledger_change();

-- Every table here is protected by row level security (policies in 0205).
alter table app.organizations enable row level security;
alter table app.people enable row level security;
alter table app.subscriptions enable row level security;
alter table app.subscription_state_transitions enable row level security;
alter table app.workspaces enable row level security;
alter table app.memberships enable row level security;
alter table app.roles enable row level security;
alter table app.role_capabilities enable row level security;
alter table app.membership_roles enable row level security;
alter table app.workspace_members enable row level security;
alter table app.teams enable row level security;
alter table app.team_members enable row level security;
alter table app.user_capability_grants enable row level security;
alter table app.record_grants enable row level security;
alter table app.delegations enable row level security;
alter table app.invites enable row level security;
