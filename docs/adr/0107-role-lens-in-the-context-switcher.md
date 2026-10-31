# ADR 0107: The Role Lens in the Context Switcher

- Status: Accepted
- Date: 2026-10-27
- Decider: A128 (RRR-173), trace row S4.8.1-06, finding A65-024
- Migrations: 2210 (`app.role_lens_capabilities`), 2211 (the step's approver on `app.inbox_items`,
  `app.role_lens_personal_capabilities`); seed 2210_a128

## Context

Section 4.8.1 gives each shell's context switcher a role lens: "All roles", or one role the person holds.
A person can hold several roles in one org (S4.8.1-03), and their capabilities are the union, so a
Producer who is also a Member sees both roles' navigation, Inbox and controls at once. View as role
(Section 8.4, A36, migration 1062) is an Admin's preview of any role at or below their band; it is not a
personal lens and is closed to most members. Gateway has no org roles at all: an external person's roles
there are the role types of their engagements (Crew, Artist, Vendor and the rest, Section 4.4.2).

The plan named this ADR 0062. Packages built since 4.0 take the next number above those in use on
batch-c and on every package branch, rather than a gap left in the older range: batch-c ends at 0104
in that sequence, R6a holds 0105 and A127 holds 0106, so this ADR is 0107.

## Decisions

### 1. A lens only narrows what a shell shows

A lens is the chosen role's capabilities intersected with the person's own. It narrows navigation,
search, the command and Create menus, Home, My Work, the Inbox and every control the shell hides by
capability. It never widens anything, and server-side authorization does not change: row level security
and the RPCs decide every read and write with the person's full standing, whatever the lens.
`lensCapabilities` (`packages/data/src/role-lens.ts`) is the one intersection the shells share; its unit
test runs every pair of subsets of a six-capability universe and finds no capability outside the person's
own.

### 2. `app.role_lens_capabilities` reuses View as role's resolution

The new RPC returns the same shape as `app.view_as_capabilities`: each capability of the role with the
role's reach, the person's own reach (`private.person_capability_reach`, so grants, delegations and an API
key's or app's scope count) and the lens reach, the lesser of the two. A capability the person does not
reach is left out. Unlike View as, it needs no `org.view_as_role.use`, and it accepts only a role the
person's active membership holds; any other role is refused (`role_lens_role_not_held`). Atlas narrows its
org context with it, and View as previews inside the lens: a preview's capabilities are intersected with
the lens's.

Alternative: compute the lens in each shell from `role_capabilities` alone. Rejected: the reach cap and the
held-role check would live in three places, and pgTAP could not hold them.

### 3. The Inbox lens follows how each sender picks its recipients

Notifications do not record a role, so `inboxItemRoute` (`packages/data/src/role-lens.ts`) reads why an item
reached the person from how its sender picks recipients, and `inboxItemInLens` keeps it under a lens on that
basis:

- A spend approval request follows the step it waits on, as `private.step_approver_person_ids` (1395) picks
  approvers: everyone holding the role a step names, or the one member it names, with an away approver's
  delegates asked in their place. Migration 2211 adds that step's `approver_role_id` and
  `approver_membership_id` to `app.inbox_items`. A step naming a role the person holds shows under that role's
  lens only, even when the role lacks the document's approve capability, because the role is why it arrived
  (deciding still needs that capability, which `app.decide_approval` checks). A step naming a member is
  addressed to that person, and a step naming a role the person does not hold reached them as a delegate, so
  both show under every lens.
- A kind whose sender picks by capability (`ROLE_ROUTED_KINDS`) shows under a lens holding one of those
  capabilities at any reach, so a Member keeps what reaches them on assigned projects: a timesheet request by
  `crew.timesheet.approve`, an incident or occupancy alert by `safety.incident.dispatch`, every billing notice
  (trials included) by `org.billing.read`, which `private.billing_owner_ids` and the dunning run pick by, and
  so on. A capability the person holds through no role (a direct grant, an org-level record grant, a
  delegation or their own break-glass session, all of which `private.person_capability_reach` counts) is
  addressed to them, so its notices show under every lens; `app.role_lens_personal_capabilities` (2211) lists
  those capabilities per org.
- Deletion and white-label notices go to the platform Owner role (`private.org_owner_ids`) and break-glass
  notices to the platform Owner and Admin roles, so only those roles' lenses keep them
  (`SYSTEM_ROLE_ROUTED_KINDS`). A custom role holding the same capabilities did not bring them.
- A weather alert also reaches the project roles a weather plan names, which are the person's own
  assignments, so it is not routed and shows under every lens. Everything else (a mention, an assignment, the
  person's own shift, account notice or report) is addressed to the person and shows under every lens.

A unit test reads the latest migration that sends each routed kind and checks the route against how the
sender picks recipients: the capability for capability-picked kinds, the platform roles for the Owner's and
break-glass notices, and the step's role or member for spend approval requests. No Inbox RPC needed a role
parameter: the Inbox reads `app.inbox_items` and filters in the shell.

Alternative: route spend approval requests by the document type's approve capability. Rejected: the sender
does not pick by it, so a request would show under roles that did not bring it, hide under the role that did,
and vanish under every lens for a person named on a step whose roles lack that capability.

### 4. The choice lasts for the session, per shell

Atlas and Gateway keep the lens in an httpOnly, SameSite=Lax cookie with no expiry (`xos-role-lens`), so it
ends with the browser session. Atlas's value names the org and the role id and applies only in that org;
Gateway's names a role type. Compass keeps it in the provider's memory per org and never writes it to the
device. A role the person no longer holds falls back to All roles. The lens is offered only to a person
with two or more roles, and in Atlas not while View as previews another role.

### 5. Links still open; navigation narrows

The proxy guards routes with the person's own roles, so the page guards (`requireNode` in Atlas and
Gateway) do too: a lens hides another role's pages from navigation, but a link to a page the person may
open still opens it, with the page's controls narrowed by the lens. Otherwise the proxy would pass a page
that its own guard then answers with 404.

### 6. Where each shell puts it

- Atlas: under the org switcher, a server-rendered disclosure with a plain form action
  (`components/shell/role-lens-switch.tsx`). It adds no JavaScript to any page, which matters because the
  shell's pages sit close to their bundle budget, and it works before hydration.
- Gateway: in the Switch org dialog, which loads on first use (`shell-overlays.tsx`). The lens narrows
  Home, Work (engagements, upcoming and applications), the orgs the switcher lists and the paid-work
  navigation to the chosen role type's engagements.
- Compass: in the org switcher sheet (`src/screens/OrgSwitcher.tsx`), which now opens for a person with one
  org and several roles. A member's lens narrows `resolved.identity` to the role's capabilities they hold
  (project roles add none under a lens); an engaged person's narrows it to one role type's engagements. The
  download scope does not change, so switching never re-syncs.

## Consequences

- Seed 2210_a128 gives Demo Multi-Role (multi@example.com, a Manager and a Member of the demo org, crew and
  an artist elsewhere) a timesheet approval request and a mention, for the Atlas and Gateway journeys and
  Compass's role-lens Maestro flow.
- A new notification kind routed by a capability or a platform role belongs in `ROLE_ROUTED_KINDS` or
  `SYSTEM_ROLE_ROUTED_KINDS` and in the sender check of `packages/data/test/role-lens.test.ts`, which fails
  when an entry lists a kind it does not check; until it is added it shows under every lens, which narrows
  less but never shows anything the person cannot see.
- An approval request shows the approver of the step it waits on now. A request whose step has moved on
  since it was sent keeps the new step's routing, and it leaves the Inbox once the person decides it from there.
