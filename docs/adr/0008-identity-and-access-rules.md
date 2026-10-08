# ADR 0008: Identity and Access Rules

- Status: Accepted (part of the Wave 1 contract freeze)
- Date: 2026-10-08
- Decider: Orchestrator, on A02's proposal with the identity core (migrations 0200 to 0206)

## Context

Building the identity core and its row level security surfaced rules that ADR 0002 and Section 8 imply but do not state.

## Decision

1. **Identity rows outside the tenant rule.** `app.organizations` and `app.people` are platform identity rows without `org_id`; the organization is the tenant root. `app.roles` and `app.role_capabilities` allow a null `org_id` only for the seven generated system roles. Custom roles take bands 2 to 7 and never reuse a system code.
2. **Capability reach.** Every grant carries a reach: own, assigned or organization. `private.has_capability(org, capability, scope)` is true when the person holds the capability with organization reach; with own reach when the scope is the person; with assigned reach when the person is assigned to the scope; or through a grant scoped to it. A person's capabilities are the union of their roles, direct grants, organization-level record grants and one-hop delegations. Managers hold organization reach, matching the "Full" cells in Section 4.5.9; a Member's writes in project-scoped modules reach only assigned projects.
3. **Refusal SQLSTATE.** Rule refusals raise SQLSTATE `XR001` with the message `<rule_code>: <sentence>` and the hint `<rule_code>`. The API maps them to 422 with `refusal: REFUSE` and the rule code. Authorization failures raise `42501` and map to 404 under ADR 0003.
4. **Trusted operations.** A SECURITY DEFINER RPC that has already authorized an act writes a marker for the current transaction into `private.trusted_operations`, and guards skip only the rules that RPC replaced. Signed-in callers cannot write private tables, so the marker cannot be forged.
5. **Granting limits.** A person grants only what they hold, at the same reach or wider, and only roles at or below their own band. An organization always keeps at least one open-ended Owner. Accepting an invite requires a confirmed sign-in email matching the invite.
6. **One home for a person's name.** `people.full_name` is the canonical name; person profiles (A30) reference it and never restate it.

## Consequences

- A03 extends `private.scope_org` and `private.is_assigned_to_scope` to projects and records with `create or replace` in its own range. Until then, grants scoped to a project or record are refused with `scope_unknown`.
- `packages/schemas/plans.yaml` becomes the single source for plans, limits and features (Section 3.15), with plan rows generated from it; the SQL seed in 0201 is replaced by generated rows in the same change.
- Retention rows for platform tables arrive with `app.retention_policies` (A18).
- Capability and role labels get i18n keys when A30 builds the Roles and Capabilities page.
