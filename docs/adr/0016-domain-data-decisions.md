# ADR 0016: Domain Data Decisions

- Status: Accepted
- Date: 2026-10-11
- Decider: Orchestrator, on A03's proposal with the domain schema (migrations 0300 to 0353)

## Context

A03 built 190 tenant tables, 21 lifecycles and 504 policies for Section 7.4. Several choices go beyond what Section 7 states, and one Postgres 17 failure mode affects every agent writing policies.

## Decision

1. **Project oversight (invariant 2).** `private.project_ids_with(capability)` grants project access to:
   - active project members holding the capability at assigned or organization reach;
   - people holding it org-wide together with `projects.members.manage` org-wide;
   - holders of a project-scoped grant.

   Member and Viewer org-reach reads stop at project membership.

2. **Scope helpers.** `private.scope_org` and `private.is_assigned_to_scope` resolve projects, scope nodes and records. Assignment to a record means owner, accountable party or a `record_assignments` row.
3. **Two project lifecycles.** `project_state` is Proposed, Active, Blocked, Complete, Canceled. `production_state` adds Closed as a declared extension, and only Closed refuses new spend (invariant 10). Passing gate 9 leaves the project in CLS with `to_phase_code` NULL.
4. **One lifecycle engine.** Every lifecycle uses Title Case enums, the shared `private.lifecycle_transition_rules` table and `private.transition_lifecycle`, which does compare-and-set and writes the ledger. Every transition needs a reason.
5. **Non-tenant reference data** lives in `private` tables shown through `app` views: currencies, domain event types, separation of duties rules and column classifications.
6. **Third Normal Form over Section 7.4 wording.**
   - `record_class` is computed by `app.record_class`, not stored.
   - GL accounts are never stored; `private.gl_account_for` resolves them by class (D13).
   - `posting_lines` (the Universal Posting Line) is a view over posted journal lines, and totals are NULL-aware views.
   - Requirements and capabilities are one `capability_statements` table, exposed as `app.project_requirements` and `app.project_capabilities`, because A02 owns `app.capabilities`.
7. **Record titles** are checked against the grammar class from canon `title_grammar` with a heuristic validator. It refuses gerunds, regular past tenses ending in "ed", articles and sentence verbs in noun phrases. Irregular past tenses pass.
8. **Canon enumeration values** are stored as `xpms.std_enumeration` row ids checked against their domain, never retyped. "Critical" is the first Incident Severity in canon order.
9. **Spend authority.** The widest applicable limit decides. No applicable row means refusal. Above the dual threshold, two distinct approvers are required. Only expenses post automatically; invoice and payroll postings arrive with RRR-71.
10. **Restricted masking.** Restricted columns have column SELECT revoked from `authenticated` and are read through `*_masked` SECURITY DEFINER views that set `is_masked`. They are registered in `private.column_classifications`.
11. **Time entry overlap** is checked per person within one org, so the check cannot reveal another tenant's data.
12. **Webhook payloads.** `app.domain_events.data` is an outbound provider payload (an allowed JSON column). It carries only named, non-restricted columns. Rows are written only by triggers; 41 event types are catalogued in `private.domain_event_types`.
13. **Counterparty names.** A counterparty's organization row stays hidden by `organizations_read`. Its display name is read only through `app.counterparty_name`. The policy is not widened.
14. **Postgres 17 crash rule, binding for every agent.** A SECURITY DEFINER function that re-reads the table being scanned under RLS, when called from a `security_invoker` view, crashes the backend. Policy helpers must take column values as arguments instead of re-querying the scanned table.

## Consequences

- Refusals use SQLSTATE `XR001` (ADR 0008). The ten separation of duties rule codes are catalogued in `app.separation_of_duties_rules`; about 170 domain rule codes are raised through `private.refuse`.
- Follow-ups tracked in Linear (RRR-71):
  - the Section 7.4 People tables (role assignments, requisitions, offers, agreements with signed-cannot-revoke);
  - invoice and payroll journal postings;
  - indexes or rewrites found by the RLS benchmark.
- A28 adds `organization_type` to `app.organizations` and keys the engagement contract to `app.projects`, `app.people` and `app.counterparties`, reusing `app.external_role_type`.
- A18 owns retention rows for these tables, webhook delivery from `app.domain_events`, the kiosk PIN service and rate limiting for `api_public.verify_certification`.
