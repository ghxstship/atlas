-- 1220_invariant_registry.sql
-- A54 (RRR-99), Section 18 gate 4 and Section 7.5. Section 7.5 lists 24 database-enforced invariants, "each implemented
-- in SQL and covered by a pgTAP test". The tests existed but named invariants only by number in comments, so nothing
-- failed when an invariant lost its test. This registry gives each invariant a stable code, the way
-- private.separation_of_duties_rules does for gate 18. Every pgTAP assertion that covers an invariant puts the code at
-- the start of its description, and packages/testing/test/invariant-coverage.test.ts fails when a registered code is
-- named by no assertion under supabase/tests. pgTAP 1220 checks the registry itself.

create table private.invariants (
  code text primary key,
  number integer not null unique,
  area text not null,
  statement text not null,
  enforced_by text not null,
  constraint invariants_code_format check (code ~ '^inv_[0-9]{2}_[a-z0-9_]+$'),
  constraint invariants_number_range check (number between 1 and 24),
  constraint invariants_code_number check (substring(code from 5 for 2)::integer = number),
  constraint invariants_area check (area in ('Tenancy', 'Policies and grants', 'Tokens and secrets', 'Lifecycle', 'Money',
    'Approvals and time', 'Incidents', 'Retention and copy'))
);

comment on table private.invariants is 'The Section 7.5 database-enforced invariants, one row each, with the code pgTAP assertions name in their descriptions (gate 4 traceability).';
comment on column private.invariants.code is 'Stable invariant code, inv_ then the two-digit Section 7.5 number then a slug. pgTAP descriptions start with it.';
comment on column private.invariants.number is 'The invariant number in Section 7.5.';
comment on column private.invariants.area is 'The Section 7.5 heading the invariant sits under.';
comment on column private.invariants.statement is 'The invariant as Section 7.5 states it.';
comment on column private.invariants.enforced_by is 'The database objects that enforce it: constraints, triggers, functions or catalog rules.';

alter table private.invariants enable row level security;
revoke all on private.invariants from public, anon, authenticated;
grant select on private.invariants to service_role;

insert into private.invariants (code, number, area, statement, enforced_by) values
  ('inv_01_tenant_derivation', 1, 'Tenancy',
    'Tenant column derived from parent; no tenant move; cross-org foreign keys refused.',
    'private.install_tenant_guards triggers on every tenant table: org_id from the parent row, tenant_move and cross_org_reference refusals.'),
  ('inv_02_project_read_scope', 2, 'Tenancy',
    'A project record is readable by project members and by crew assigned to it, not by the whole org.',
    'Read policies built on private.can_on_project, which admits project members and crew assigned to the project.'),
  ('inv_03_leaving_ends_access', 3, 'Tenancy',
    'Leaving an org ends access immediately, including to notifications.',
    'private.is_member and every capability helper read live memberships; notification and feed policies require a current membership.'),
  ('inv_04_sole_owner', 4, 'Tenancy',
    'A sole Owner cannot remove or demote themselves.',
    'sole_owner refusal on membership and membership role changes and in app.leave_organization.'),
  ('inv_05_policy_shape', 5, 'Policies and grants',
    'RLS policies wrap auth.uid() in a subselect, call helpers from private, and pair read and write halves that agree.',
    'private.install_policies writes read and write halves from one expression; catalog checks over pg_policies.'),
  ('inv_06_function_hardening', 6, 'Policies and grants',
    'Every function pins search_path. SECURITY DEFINER functions are revoked from anon except named token RPCs.',
    'set search_path = '''' on every function; execute revoked from public and anon; token RPCs live in api_public.'),
  ('inv_07_anon_surface', 7, 'Policies and grants',
    'Anonymous access goes only through column-scoped api_public views or token RPCs. No select * projection reaches anon.',
    'No table or view privilege for anon in any application schema; anon executes only api_public functions.'),
  ('inv_08_token_rpcs_hashed_secrets', 8, 'Tokens and secrets',
    'Token RPCs require a token and an access code, expire, rate-limit failed attempts, and return only the fields the page renders. Access codes, second factors, recovery codes and kiosk PINs are stored hashed and shown once.',
    'api_public token RPCs with private.rate_limit_exceeded and token lock; hashed columns for access codes, recovery codes and kiosk PINs.'),
  ('inv_09_gate_transition', 9, 'Lifecycle',
    'Gate transition uses compare-and-set on the expected current phase. It refuses when any blocking criterion lacks evidence.',
    'app.pass_gate: compare-and-set on current_phase_code and the gate_criteria_unmet refusal.'),
  ('inv_10_closed_production', 10, 'Lifecycle',
    'A closed production refuses new invoices, POs, expenses, time entries and change orders.',
    'private.assert_production_open in the insert triggers of invoices, purchase orders, expenses, time entries and change orders (production_closed).'),
  ('inv_11_null_price', 11, 'Money',
    'NULL price propagates. An unpriced change order cannot be stored at zero. Aggregates of NULL are NULL with an unpriced count.',
    'Nullable unit prices, the no-cost declaration check, and the NULL-aware totals views with unpriced_count.'),
  ('inv_12_expense_one_line', 12, 'Money',
    'One expense posts to exactly one budget line.',
    'expenses.budget_line_id not null and the expense_budget_line_immutable refusal.'),
  ('inv_13_period_postings', 13, 'Money',
    'A closed accounting period refuses postings. An open period cannot become Audited without passing through Closed.',
    'period_closed and period_missing refusals in posting; the accounting_period lifecycle rules.'),
  ('inv_14_pay_period_no_reopen', 14, 'Money',
    'A posted pay period cannot reopen.',
    'The pay_period lifecycle rules have no move out of Posted.'),
  ('inv_15_payroll_no_jump', 15, 'Money',
    'A payroll run cannot jump from Draft to Accepted.',
    'The payroll_run lifecycle rules have no Draft to Accepted move.'),
  ('inv_16_billed_once', 16, 'Money',
    'Billed-to-date counts each payment once.',
    'Unique payment application per payment and invoice; app.project_billing sums applications once.'),
  ('inv_17_three_way_match', 17, 'Money',
    'Three-way match refuses a duplicate receipt and never auto-approves a mismatched invoice.',
    'Unique receipt per invoice match and the invoice_match_mismatch refusal in invoice approval.'),
  ('inv_18_eligible_approver', 18, 'Approvals and time',
    'Approvals are decided by an eligible approver, never the requester. A crew member cannot approve their own swap or timesheet.',
    'private.assert_separation with the sod_ rules in every approval RPC.'),
  ('inv_19_timesheet_void', 19, 'Approvals and time',
    'A timesheet approval is voided when its hours change.',
    'private.void_timesheet_approvals on time entry changes returns the timesheet to Proposed.'),
  ('inv_20_time_overlap', 20, 'Approvals and time',
    'Time entries cannot overlap for one person. A shift cannot end before it starts.',
    'time_entry_overlap refusal and the shift time order check constraint.'),
  ('inv_21_no_self_issue', 21, 'Approvals and time',
    'Certifications and credentials cannot be self-issued. A certificate verifies publicly only if the holder consented.',
    'credential_self_issue refusal; api_public.verify_certification requires holder consent.'),
  ('inv_22_critical_incident_close', 22, 'Incidents',
    'A critical incident cannot be relabeled and closed in one statement. Closing requires sign-off.',
    'incident_relabel_and_close and incident_close_rpc refusals; app.close_incident records the sign-off.'),
  ('inv_23_audit_retention', 23, 'Retention and copy',
    'Audit plaintext containing personal data is redacted at 90 days at every JSON depth. The audit ledger itself is append-only for 7 years.',
    'private.redact_audit_events and private.redact_personal_data at every JSON depth; append-only trigger and the 7 year retention policy on app.audit_events.'),
  ('inv_24_no_em_dash', 24, 'Retention and copy',
    'No em dash is accepted in canon or verbiage text (check constraint).',
    'Check constraints on canon and verbiage text columns.');
