# ADR 0005: Wave 1 Ownership Clarifications

- Status: Accepted
- Date: 2026-10-08
- Decider: Orchestrator (Wave 1 kickoff)

## Context

Section 19.1 assigns "identity" to both A02 (tenancy, identity, access) and A30 (identity model, profiles, settings), names `packages/schemas` as A04's while the permissions registry is enforced by A02's RLS, and leaves the `/api/v1` mount inside `apps/atlas`, which A06 owns. Wave 1 agents run in parallel worktrees and need these seams fixed before they start.

## Decision

1. **Identity core belongs to A02 (0200 to 0299).** A02 creates the canonical identity tables that tenancy and RLS depend on: `organizations`, `subscriptions`, `people`, `workspaces`, `workspace_members`, `memberships`, `membership_roles`, `roles`, `capabilities`, `role_capabilities`, `user_capability_grants`, `record_grants`, `delegations`, `invites`, `teams`, `team_members`, and the `private` helpers (`has_capability`, `is_member`, tenant derivation and cross-org refusal triggers). Final names from the Section 7.3 name mapping apply. A30 (0850 to 0899) extends this core with profiles, profile visibility, handles, verifications, blocks, join requests, invitation links, verified domains, offboarding and the settings registry.
2. **`packages/schemas/capabilities.yaml` is authored by A02 in Wave 1.** It is the permissions contract RLS enforces. A04 consumes it for API scopes and owns the rest of `packages/schemas`.
3. **A04 owns `apps/atlas/app/api/v1/`.** In Wave 1 it serves only the generated OpenAPI document. Operation handlers mount when their module implements them; no unimplemented handler is mounted.
4. **One information architecture agent writes all three sitemaps in Wave 1** (`apps/atlas/ia/sitemap.yaml`, `apps/gateway/ia/sitemap.yaml`, `apps/compass/ia/sitemap.yaml`) and the shared sitemap schema and validator in a new package, `packages/ia`. Ownership of each sitemap then passes to A06, A27 and A17. Navigation labels are i18n keys under the `nav` namespace in `packages/i18n`.
5. **A05 runs in Claude Design.** The design system deliverable (Section 11.5, item 1) is produced outside Claude Code and lands in `design/tokens.json`; Wave 2 starts `packages/tokens` from that export.
6. **Local databases per worktree.** Each agent that runs Supabase locally sets its own `project_id` and port block in its worktree copy of `supabase/config.toml` and never commits that change: A01 uses `xos4-a01` on 556xx, A02 uses `xos4-a02` on 557xx.

## Consequences

The contract freeze at the end of Wave 1 covers ADR 0002, the Playbook column map, the three sitemaps, `capabilities.yaml`, OpenAPI v1 and the token export.
