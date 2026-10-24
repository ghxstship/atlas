# ADR 0060: Objects Over the Plan's Limits Become Read-Only

- Status: Proposed
- Date: 2026-10-23
- Decider: A107 (RRR-152), for the orchestrator's review
- Addresses: requirement S16-07; finding A65-015 (downgrades); Section 16; Terms of Service 5.2 and 5.8
- Migrations: 1720 and 1721 (range 1720 to 1729)

## Context

Section 16 says: "Downgrades never delete data. They make over-limit objects read-only with a clear explanation." Terms of Service 5.2 says the same of a trial that ends on the Access plan. Since 1350 a trial ends on Access with its data kept, and `private.assert_within_plan_limit` refuses new objects over a limit. Objects that were already over a limit stayed writable, so an org whose 14-day Pro trial ended kept every project and every member's seat on the free plan (A65-015).

Plan limits are `seats`, `active_projects`, `field_members`, `active_external_engagements_per_month` and `aurora_requests_per_month` (`packages/schemas/plans.yaml`, ADR 0035). `private.org_plan_limits` gives the limit in force, with extra seats added.

## Decision

1. **Only limits that count standing objects make objects read-only.**
   - `active_projects` counts projects that are not archived, deleted, completed or canceled.
   - `seats` counts active memberships whose best role is above Field.
   - `field_members` counts active memberships whose best role is Field.

   These match the counts that already refuse new objects (0301, 0204). The two monthly limits count acts within a month: engagements created and Aurora requests. They keep refusing the next act and never make an object read-only. A month's count starts again on the 1st, and nothing older than the month counts.

2. **Selection rule.** Within each limit, objects are ranked as follows, and those ranked past the limit are read-only:
   - Owners' seats rank first and are never read-only, even when Owners alone exceed `seats`, so an Owner can always reach Billing and Plan.
   - Then come the objects the Owner chose to keep writable (`app.plan_limit_choices`).
   - Then come the oldest, by `created_at`, with the id as the tiebreak.

   Without a choice, the oldest stay writable. A choice stays stored for later plan changes, so an org that downgrades again keeps what its Owner chose. An unlimited limit makes nothing read-only.

3. **The Owner chooses per limit.** `app.choose_plan_limit_keeps` is open to `org.billing.manage` (the Owner). It replaces a limit's choice as a set, with at most the limit less the seats Owners hold, among the objects the limit counts. It changes no plan and no payment, so it asks for no step-up (unlike the billing acts of 1562). The panel sits in Settings, Billing and Plan.
4. **The database recomputes, not webhook code.** `app.over_limit_objects` holds the read-only objects. `private.recompute_over_limit(org)` rewrites an org's rows. After-triggers call it when any of these change:
   - a subscription's plan, state, extra seats, grandfathering or deletion: a trial ending, a downgrade, an upgrade, a cancellation, or Stripe, a partner or the console setting the plan;
   - a console Plan or Limit override made or ended early (1471);
   - a project's archive, deletion or state: archive, restore, delete, complete or reopen;
   - a role assignment;
   - a membership's validity or deletion;
   - the plan limits themselves (a plan seed migration recomputes every org).

   The Owner's choice recomputes at once. The hourly lifecycle job (`private.run_org_lifecycle`) refreshes orgs with read-only objects, so a membership that ends at its `valid_to` frees its seat on time. It also refreshes orgs whose memberships began, or whose overrides started or expired, in the last two hours. The guard lifts as soon as the org is back within the limit. An org being purged is skipped.

5. **The guard extends the read-only row guard.** `private.refuse_read_only_org` (1063, 1353) already runs on every app table with `org_id` that is not exempt. For a person's write in an org with read-only objects, it now also refuses:
   - any write by a person whose own seat is read-only;
   - any write to a read-only project or anything of it: a row that carries the project's id, belongs to one of its records or engagements, or extends one of its records.

   Archiving or deleting a read-only project stays allowed, since it brings the org back within the limit. The refusal is `plan_limit_read_only`, and its message names the plan, the limit, the count and how to lift it. Workers, billing and retention (no person) still write, as with the other read-only states.

6. **Personal rows stay writable.** `private.over_limit_personal_tables` lists the app tables that stay writable for a person with a read-only seat, and for anyone reading a read-only project: the person's membership and roles, preferences, saved views and searches, favorites, follows, reading marks, consents, legal acceptances, SOP acknowledgments and personal tokens. Leaving the org, accepting new terms and marking a conversation read must keep working. Admins can still end a membership or change a role to free a seat.
7. **Restoring counts like creating.** `private.guard_project` now applies `active_projects` when an archived or deleted project is restored, as it already did on create and reopen. Otherwise a restore would silently turn another project read-only.
8. **Atlas explains before anyone meets a refusal.** `app.org_banner_status` (the one banner call) adds the plan, how many projects, seats and field seats are read-only, and whether the caller's own seat is. Atlas shows these banners:
   - above every page, a summary for billing readers and a notice to a person whose seat is read-only;
   - a banner on each page of a read-only project;
   - counts on Projects and Members.

   Each banner links the Owner to the choice and tells everyone else what an Owner can do. `app.plan_limit_usage` gives the limits with extra seats included.

## Consequences

- `app.over_limit_objects` is a stored derived value and is listed in the denormalization register. It is rewritten on every change it depends on, so it cannot drift from the counts.
- A downgrade can make most of an org read-only at once, Owners excepted. Nothing is deleted, and upgrading, archiving or ending memberships restores writes at once (pgTAP 1720).
- Personal tables and the guard both sit in the database. Adding a personal app table later means adding it to the list in a migration, and pgTAP 1720 checks that every listed table exists and carries the guard.
- Public API v1 is unchanged. API writes meet the same refusal through the row guard, and the refusal shape is the existing one.
