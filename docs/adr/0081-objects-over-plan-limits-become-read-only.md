# ADR 0081: Objects Over the Plan's Limits Become Read-Only

- Status: Proposed
- Date: 2026-10-27
- Decider: A107 (RRR-152), for the orchestrator's review
- Addresses: requirement S16-07; finding A65-015 (downgrades); Section 16; Terms of Service 5.2 and 5.8
- Migrations: 2070 and 2071 (range 2070 to 2079)

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
   - any write to a read-only project or anything of it, however deep. `private.row_project_id` finds a row's project in this order:
     - the row's own `project_id`, or the project of the record or engagement it names (`record_id`, `engagement_id`);
     - the project, or the project of the record, that an access grant targets (`target_kind` and `target_id` on `app.record_grants`), so a read-only project cannot be shared;
     - the row it is about, named by `subject_table` and `subject_id` or `target_table` and `target_id` (comment threads, attachments, import results);
     - the parent it takes its org from, which `install_domain_table` records as the arguments of its `t10_derive_org_id` trigger: a budget line's budget, a PO line's purchase order, a comment's thread, a BEO line's BEO. A custom field value follows its definition's `target_table` to its subject;
     - the record it extends (a table keyed by the record's id).

     Each step is followed up to six levels. The chain is read from the catalog when a write happens, so a table added later is covered without a new list. It is resolved only in an org that has a read-only project. On a partitioned table (time entries, access scans) the trigger runs on a month partition, so the guard asks about the table the trigger was declared on.

   Archiving or deleting a read-only project stays allowed, since it brings the org back within the limit. The refusal is `plan_limit_read_only`, and its message names the plan, the limit, the count and how to lift it. Workers, billing and retention (no person) still write, as with the other read-only states.

6. **Personal rows stay writable.** `private.over_limit_personal_tables` lists the app tables that stay writable for a person with a read-only seat, and for anyone reading a read-only project: the person's membership and roles, preferences, saved views and searches, favorites, follows, reading marks, consents, legal acceptances, SOP acknowledgments and personal tokens. Leaving the org, accepting new terms and marking a conversation read must keep working. So must asking Aurora about what a person may read (`app.ai_requests`); whatever Aurora drafts is saved through the guarded tables. Admins with a writable seat can still end a membership or change a role to free a seat. A person whose own seat is read-only writes memberships and roles only to leave the org or drop their own roles. They cannot add a role, turn one of their roles into another, or change another member's, so they cannot free a seat for themselves ahead of the Owner's choice by demoting someone.
7. **Restoring counts like creating.** `private.guard_project` now applies `active_projects` when an archived or deleted project is restored, as it already did on create and reopen. Otherwise a restore would silently turn another project read-only.
8. **Atlas explains before anyone meets a refusal.** `app.org_banner_status` (the one banner call) adds the plan, how many projects, seats and field seats are read-only, and whether the caller's own seat is. Atlas shows these banners:
   - above every page, a summary for billing readers and a notice to a person whose seat is read-only;
   - a banner on each page of a read-only project;
   - counts on Projects and Members.

   Each banner links the Owner to the choice and tells everyone else what an Owner can do. `app.plan_limit_usage` gives the limits with extra seats included.

## Consequences

- `app.over_limit_objects` is a stored derived value and is listed in the denormalization register. It is rewritten on every change it depends on, so it cannot drift from the counts.
- An org with nothing read-only whose counts are within every limit only counts on a role or membership change, without ranking. A bulk role import or SCIM sync then pays one count of the org's memberships per row, never a ranking.
- On release, migration 2070 recomputes every org. A live org on Access that is already past a limit (after a trial, a cancellation or a reactivation) turns read-only when the migration applies, with the banners as its notice. The release owner counts those orgs first and decides on notice under Terms of Service 5.2. The count reads only objects 4.0 already has, so it runs on production before 2070 applies:

  ```sql
  select o.slug, l.plan_code, l.limit_code, l.limit_value, c.used
  from app.organizations o
  join private.org_plan_limits l on l.org_id = o.id
  cross join lateral private.membership_band_counts(o.id) b
  cross join lateral (select case l.limit_code
      when 'seats' then b.seats
      when 'field_members' then b.field_members
      else (select count(*) from app.projects p
            where p.org_id = o.id and p.deleted_at is null and p.archived_at is null
              and p.project_state in ('Proposed', 'Active', 'Blocked'))
    end as used) c
  where o.deleted_at is null and l.limit_value is not null and c.used > l.limit_value
    and l.limit_code in ('seats', 'field_members', 'active_projects')
  order by o.slug, l.limit_code;
  ```

  Each row is an org that turns partly read-only. An org whose Owners alone exceed `seats` is listed but loses nothing, since Owners' seats are never read-only.

- A downgrade can make most of an org read-only at once, Owners excepted. Nothing is deleted, and upgrading, archiving or ending memberships restores writes at once (pgTAP 2070).
- Personal tables and the guard both sit in the database. Adding a personal app table later means adding it to the list in a migration, and pgTAP 2070 checks that every listed table exists and carries the guard.
- Public API v1 is unchanged. API writes meet the same refusal through the row guard, and the refusal shape is the existing one.
