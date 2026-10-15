-- pgTAP: People (Section 7.4 People, RRR-71). Same-tenant allow, cross-tenant deny, anon deny, role
-- bands, invariant 8 (signing tokens and access codes hashed, expiring, locking at 5), invariant 10
-- (closed production), invariant 18 (approver never the requester), spend authority for requisitions
-- (Section 8.1), every state machine, and the rule that a
-- signed agreement is never revoked or unsigned (journey 9).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(101);

create temporary table tokens (key text primary key, token text not null, code text not null);
grant select, insert on tokens to public;

-- World -----------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.cost_centers (org_id, code, name, kind) values (pg_temp.id('org_a'), 'CC-VENUE', 'Venue Operations', 'Standing') returning id) insert into world select 'cc_venue', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD') returning id) insert into world select 'bud_a', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, cost_center_id, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_a'), 1, 'Production crew labor.', '5000.01.01', pg_temp.id('cc_venue'), 1, 900000, 'X', 'Declared') returning id) insert into world select 'line_labor', id from x;
select pg_temp.as_user('alice');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor, dual_approval_above_minor) values
  (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Requisition', 'USD', 1000000, 500000),
  (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Contract', 'USD', 1000000, null);
select pg_temp.as_user('bob');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values
  (pg_temp.id('org_a'), pg_temp.system_role('owner'), 'Requisition', 'USD', 5000000);
select pg_temp.as_user('xavier');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_b'), 'Pier Nights Budget', 'USD') returning id) insert into world select 'bud_b', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_b'), 1, 'Dock crew.', '5000.01.01', 1, 100, 'X', 'Declared') returning id) insert into world select 'line_b', id from x;
select pg_temp.as_platform();

-- Requisitions ------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.requisitions (project_id, budget_line_id, role_type, role_code, worker_classification, pay_basis, arrangement,
    headcount, units_per_head, rate_minor, currency_code, starts_on, ends_on, justification)
  values (pg_temp.id('prj_a'), pg_temp.id('line_labor'), 'Contractor', '5000.50.01', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Retainer',
    1, 4, 60000, 'USD', '2027-06-01', '2027-06-04', 'Production manager for the opening weekend.') returning id) insert into world select 'req1', id from x;
with x as (insert into app.requisitions (project_id, role_code, headcount, currency_code, justification)
  values (pg_temp.id('prj_a'), '5000.50.01', 2, 'USD', 'Rate still under negotiation.') returning id) insert into world select 'req_unpriced', id from x;
with x as (insert into app.requisitions (project_id, role_code, worker_classification, pay_basis, arrangement, headcount, units_per_head, rate_minor, currency_code, justification)
  values (pg_temp.id('prj_a'), '5000.50.01', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Retainer', 3, 4, 60000, 'USD', 'Three production managers.') returning id) insert into world select 'req_dual', id from x;
with x as (insert into app.requisitions (project_id, role_code, worker_classification, pay_basis, arrangement, headcount, units_per_head, rate_minor, currency_code, justification)
  values (pg_temp.id('prj_a'), '5000.50.01', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Retainer', 50, 10, 60000, 'USD', 'Too many.') returning id) insert into world select 'req_big', id from x;
select is((select requested_by from app.requisitions where id = pg_temp.id('req1')), pg_temp.id('carol'), 'the requester is the session person');
select throws_ok($$update app.requisitions set requested_by = (select id from world where key = 'dave') where id = (select id from world where key = 'req1')$$, 'XR001', null, 'the requester never changes');
select throws_ok($$insert into app.requisitions (project_id, budget_line_id, role_code, currency_code, justification) values ((select id from world where key = 'prj_a'), (select id from world where key = 'line_labor'), '5000.50.01', 'EUR', 'Euro.')$$,
  'XR001', null, 'a requisition is in its budget currency');
select throws_ok($$insert into app.requisitions (project_id, budget_line_id, role_code, currency_code, justification) values ((select id from world where key = 'prj_a'), (select id from world where key = 'line_b'), '5000.50.01', 'USD', 'Cross.')$$,
  'XR001', null, 'a requisition cannot spend against another org''s budget line');
select throws_ok($$insert into app.requisitions (project_id, role_code, worker_classification, pay_basis, arrangement, currency_code, justification) values ((select id from world where key = 'prj_a'), '5000.50.01', 'VOLUNTEER', 'Day Rate', 'Retainer', 'USD', 'Not canon.')$$,
  '23503', null, 'role, classification, pay basis and arrangement form a canon rate card combination');
select throws_ok($$insert into app.requisitions (project_id, role_code, rate_minor, currency_code, justification) values ((select id from world where key = 'prj_a'), '5000.50.01', 100, 'USD', 'No basis.')$$,
  '23514', null, 'a rate needs a pay basis');
select is((select estimated_minor from app.requisition_amounts where requisition_id = pg_temp.id('req1')), 240000::bigint, 'the estimate is headcount times units times rate');
select is((select estimated_minor from app.requisition_amounts where requisition_id = pg_temp.id('req_unpriced')), null::bigint, 'an unpriced requisition has no estimate, never zero');
select pg_temp.as_platform();

-- RLS
select pg_temp.as_user('dave');
select is((select count(*)::int from app.requisitions), 4, 'a Member reads the requisitions of their project');
select throws_ok($$insert into app.requisitions (project_id, role_code, currency_code, justification) values ((select id from world where key = 'prj_a'), '5000.50.01', 'USD', 'Member.')$$,
  '42501', null, 'a Member cannot request staff');
select is((select count(*)::int from app.requisition_state_transitions), 4, 'and reads their creation entries');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.requisitions), 0, 'a Viewer in no project reads no requisitions (invariant 2)');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.requisitions), 0, 'another org reads no requisitions');
select is((select count(*)::int from app.requisition_amounts), 0, 'nor their amounts');
select pg_temp.as_anon();
select throws_ok('select 1 from app.requisitions', '42501', null, 'anon cannot read requisitions');
select pg_temp.as_platform();

-- Approval (Section 8.1, invariant 18)
select pg_temp.as_user('carol');
select throws_ok($$select app.approve_requisition((select id from world where key = 'req1'), 'Self.')$$,
  'XR001', 'sod_approval_requester: An approval is decided by an eligible approver, never the requester.', 'the requester cannot approve their requisition');
select throws_ok($$select app.transition_requisition((select id from world where key = 'req1'), 'Proposed', 'Approved', 'Shortcut.')$$,
  'XR001', null, 'approval only through its RPC');
select throws_ok($$update app.requisitions set requisition_state = 'Approved' where id = (select id from world where key = 'req1')$$, 'XR001', null, 'the state changes only through the RPCs');
select pg_temp.as_user('dave');
select throws_ok($$select app.approve_requisition((select id from world where key = 'req1'), 'Member.')$$, '42501', null, 'a Member cannot approve a requisition');
select pg_temp.as_user('bob');
select throws_ok($$select app.approve_requisition((select id from world where key = 'req_unpriced'), 'Unpriced.')$$,
  'XR001', 'requisition_unpriced: A requisition needs a rate and the units per head before it is approved.', 'an unpriced requisition is never approved');
select throws_ok($$select app.approve_requisition((select id from world where key = 'req_big'), 'Too big.')$$,
  'XR001', null, 'an amount above the approver''s limit is refused');
select is(app.approve_requisition(pg_temp.id('req1'), 'Within budget.'), true, 'an Admin approves within their limit');
select is(app.approve_requisition(pg_temp.id('req_dual'), 'First.'), false, 'above the dual threshold one approval is not enough');
select pg_temp.as_user('alice');
select is(app.approve_requisition(pg_temp.id('req_dual'), 'Second.'), true, 'a second distinct approver completes it');
select pg_temp.as_platform();
select is((select requisition_state::text from app.requisitions where id = pg_temp.id('req1')), 'Approved', 'the requisition is Approved');
select is((select spend_authority_id is not null from app.spend_approvals where document_type = 'Requisition' and document_id = pg_temp.id('req1')), true, 'the approval is recorded against the limit');
select is((select count(*)::int from app.domain_events where event_type = 'requisition.approved' and subject_id = pg_temp.id('req1')), 1, 'requisition.approved was emitted');
select pg_temp.as_user('carol');
select throws_ok($$update app.requisitions set headcount = 5 where id = (select id from world where key = 'req1')$$,
  'XR001', 'requisition_locked: A requisition''s role, terms and headcount change only while it is Proposed.', 'an approved requisition keeps its terms');
select throws_ok($$update app.requisitions set project_id = (select id from world where key = 'prj_a2') where id = (select id from world where key = 'req1')$$,
  'XR001', null, 'a requisition stays on its project');
select pg_temp.as_user('bob');
select lives_ok($$select app.reject_requisition((select id from world where key = 'req_big'), 'Over budget.')$$, 'Proposed to Rejected');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_requisition((select id from world where key = 'req_big'), 'Rejected', 'Proposed', 'Reduced.')$$, 'the requester resubmits');
select lives_ok($$select app.transition_requisition((select id from world where key = 'req_big'), 'Proposed', 'Canceled', 'Withdrawn.')$$, 'and cancels');
select throws_ok($$select app.transition_requisition((select id from world where key = 'req_big'), 'Canceled', 'Proposed', 'Revive.')$$, 'XR001', null, 'Canceled is terminal');
select pg_temp.as_platform();
select is((select string_agg(from_state || '>' || to_state, ' ' order by from_state, to_state) from app.lifecycle_transition_rules where lifecycle = 'requisition'),
  'Approved>Canceled Approved>Filled Proposed>Approved Proposed>Canceled Proposed>Rejected Rejected>Proposed', 'the requisition lifecycle moves');

-- The A28 publish check
select lives_ok($$select private.assert_requisition_approved((select id from world where key = 'req1'), (select id from world where key = 'prj_a'), '5000.50.01')$$,
  'an Approved requisition passes the publish check');
select throws_ok($$select private.assert_requisition_approved((select id from world where key = 'req_unpriced'), (select id from world where key = 'prj_a'), null)$$,
  'XR001', null, 'a Proposed requisition fails the publish check');
select throws_ok($$select private.assert_requisition_approved((select id from world where key = 'req1'), (select id from world where key = 'prj_a2'), null)$$,
  'XR001', null, 'and so does one for another project');

-- Invariant 10
select pg_temp.as_platform();
select private.begin_trusted_operation('production_transition');
update app.projects set production_state = 'Closed' where id = pg_temp.id('prj_a2');
select private.end_trusted_operation('production_transition');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.requisitions (project_id, role_code, currency_code, justification) values ((select id from world where key = 'prj_a2'), '5000.50.01', 'USD', 'Closed.')$$,
  'XR001', null, 'a closed production refuses new requisitions');
select pg_temp.as_platform();

-- Filling
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_requisition((select id from world where key = 'req1'), 'Approved', 'Filled', 'Hired.')$$, 'an Approved requisition is Filled');
select throws_ok($$select app.transition_requisition((select id from world where key = 'req1'), 'Filled', 'Approved', 'Reopen.')$$, 'XR001', null, 'Filled is terminal');
select pg_temp.as_platform();

-- Role assignments --------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.role_assignments (project_id, role_code, person_id, requisition_id, staffing_basis, starts_on)
  values (pg_temp.id('prj_a'), '6000.52.02', pg_temp.id('frank'), pg_temp.id('req1'), 'Ratio', '2027-06-01') returning id) insert into world select 'ra1', id from x;
with x as (insert into app.role_assignments (project_id, role_code, person_id, staffing_basis)
  values (pg_temp.id('prj_a'), '2000.50.01', pg_temp.id('dave'), 'Fixed') returning id) insert into world select 'ra2', id from x;
select throws_ok($$insert into app.role_assignments (project_id, role_code, person_id, staffing_basis) values ((select id from world where key = 'prj_a'), '0000.50.01', (select id from world where key = 'erin'), 'Ratio')$$,
  'XR001', 'role_assignment_basis: The canon role has no staffing ratio; plan it as Fixed or Declared.', 'Ratio needs a canon staffing ratio');
select throws_ok($$insert into app.role_assignments (project_id, role_code, person_id, staffing_basis) values ((select id from world where key = 'prj_a'), '6000.52.02', (select id from world where key = 'erin'), 'Fixed')$$,
  'XR001', null, 'Fixed needs a canon fixed-per-tier basis');
select throws_ok($$insert into app.role_assignments (project_id, role_code, person_id) values ((select id from world where key = 'prj_a'), '6000.52.02', (select id from world where key = 'paul'))$$,
  'XR001', 'role_assignment_person: Assign an active member of the org; external people work through engagements.', 'a person outside the org cannot be assigned');
select throws_ok($$insert into app.role_assignments (project_id, role_code, person_id) values ((select id from world where key = 'prj_a'), '6000.52.02', (select id from world where key = 'frank'))$$,
  '23505', null, 'a person holds a role on a project once');
select throws_ok($$insert into app.role_assignments (project_id, role_code, person_id, requisition_id) values ((select id from world where key = 'prj_a'), '6000.52.01', (select id from world where key = 'erin'), (select id from world where key = 'req_unpriced'))$$,
  'XR001', null, 'an assignment fills only an Approved or Filled requisition');
select throws_ok($$update app.role_assignments set person_id = (select id from world where key = 'erin') where id = (select id from world where key = 'ra1')$$,
  'XR001', null, 'an assignment keeps its person');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.role_assignments), 2, 'a Member reads the role assignments of their project');
select throws_ok($$insert into app.role_assignments (project_id, role_code, person_id) values ((select id from world where key = 'prj_a'), '6000.52.01', (select id from world where key = 'erin'))$$,
  '42501', null, 'a Member cannot assign roles');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.role_assignments where person_id = pg_temp.id('frank')), 1, 'the person assigned reads their own assignment');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.role_assignments), 0, 'a Viewer in no project reads none');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.role_assignments), 0, 'another org reads none');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_role_assignment((select id from world where key = 'ra1'), 'Proposed', 'Active', 'Started.')$$, 'Proposed to Active');
select lives_ok($$select app.transition_role_assignment((select id from world where key = 'ra1'), 'Active', 'Complete', 'Wrapped.')$$, 'Active to Complete');
select throws_ok($$select app.transition_role_assignment((select id from world where key = 'ra1'), 'Complete', 'Active', 'Again.')$$, 'XR001', null, 'Complete is terminal');
select throws_ok($$select app.transition_role_assignment((select id from world where key = 'ra2'), 'Active', 'Complete', 'Stale.')$$, 'XR001', null, 'compare-and-set refuses a stale expected state');
select pg_temp.as_user('dave');
select throws_ok($$select app.transition_role_assignment((select id from world where key = 'ra2'), 'Proposed', 'Canceled', 'Member.')$$, '42501', null, 'a Member cannot move assignments');
select pg_temp.as_platform();

-- Agreements --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.agreements (project_id, person_id, agreement_kind, title, body)
  values (pg_temp.id('prj_a'), pg_temp.id('nina'), 'Offer Letter', 'Production Manager Offer Letter', 'Nina joins the Summer Series as production manager at the agreed day rate.') returning id) insert into world select 'agr1', id from x;
with x as (insert into app.agreements (org_id, person_id, agreement_kind, title, body)
  values (pg_temp.id('org_a'), pg_temp.id('nina'), 'Non-Disclosure Agreement', 'Mutual Non-Disclosure Agreement', 'Both parties keep the other''s confidential information private.') returning id) insert into world select 'agr_nda', id from x;
with x as (insert into app.agreements (org_id, person_id, agreement_kind, title, body)
  values (pg_temp.id('org_a'), pg_temp.id('mia'), 'Contractor Agreement', 'Contractor Agreement', 'Mia provides services as an independent contractor.') returning id) insert into world select 'agr_lock', id from x;
select throws_ok($$insert into app.agreements (agreement_kind, title, body, org_id) values ('Offer Letter', 'Nobody', 'Text.', (select id from world where key = 'org_a'))$$,
  '23514', null, 'an agreement names a person or an organization');
select throws_ok($$insert into app.agreements (project_id, person_id, agreement_kind, title, body) values ((select id from world where key = 'prj_b'), (select id from world where key = 'mia'), 'Offer Letter', 'Cross', 'Text.')$$,
  '42501', null, 'an agreement cannot cover another org''s project');
select throws_ok($$select token_hash from app.agreements$$, '42501', null, 'the token hash is not selectable');
select throws_ok($$select access_code_hash from app.agreements$$, '42501', null, 'nor the access code hash');
select throws_ok($$update app.agreements set failed_attempts = 3 where id = (select id from world where key = 'agr1')$$,
  'XR001', null, 'signing columns change only through the RPCs');
select throws_ok($$update app.agreements set agreement_state = 'Signed' where id = (select id from world where key = 'agr1')$$, 'XR001', null, 'the state changes only through the RPCs');
select throws_ok($$select app.transition_agreement((select id from world where key = 'agr1'), 'Proposed', 'Signed', 'Org signs.')$$,
  'XR001', 'agreement_signed_by_signer: Only the signer signs, through the signing token or while signed in.', 'the org never signs for the signer');
select lives_ok($$update app.agreements set body = body || ' Payment within 30 days.' where id = (select id from world where key = 'agr1')$$, 'a Proposed agreement''s text is editable');
insert into tokens select 'agr1', t.signing_token, t.access_code from app.send_agreement(pg_temp.id('agr1'), 'Sent to Nina.') t;
insert into tokens select 'agr_lock', t.signing_token, t.access_code from app.send_agreement(pg_temp.id('agr_lock'), 'Sent to Mia.') t;
select matches((select token from tokens where key = 'agr1'), '^xagr_[0-9a-f]{64}$', 'the signing token is shown once');
select matches((select code from tokens where key = 'agr1'), '^[0-9]{8}$', 'with an 8 digit access code');
select throws_ok($$update app.agreements set body = 'Changed.' where id = (select id from world where key = 'agr1')$$,
  'XR001', null, 'a Sent agreement''s text is locked');
select pg_temp.as_platform();
select is((select token_hash = extensions.digest((select token from tokens where key = 'agr1'), 'sha256') from app.agreements where id = pg_temp.id('agr1')), true, 'only the token''s hash is stored');
select isnt((select access_code_hash from app.agreements where id = pg_temp.id('agr1')), (select code from tokens where key = 'agr1'), 'the access code is stored hashed');

select pg_temp.as_user('dave');
select is((select count(*)::int from app.agreements), 0, 'a Member reads no agreements');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.agreements), 0, 'another org reads no agreements');
select pg_temp.as_user('nina');
select is((select count(*)::int from app.agreements), 2, 'the signer reads the agreements naming them');
select pg_temp.as_anon();
select throws_ok('select 1 from app.agreements', '42501', null, 'anon cannot read the table');

-- Token signing (invariant 8)
select is((select count(*)::int from api_public.read_agreement((select token from tokens where key = 'agr1'), '00000000')), 0, 'a wrong access code reads nothing');
select is((select count(*)::int from api_public.read_agreement('xagr_unknown', (select code from tokens where key = 'agr1'))), 0, 'an unknown token reads nothing');
select is((select title from api_public.read_agreement((select token from tokens where key = 'agr1'), (select code from tokens where key = 'agr1'))),
  'Production Manager Offer Letter', 'the token and access code read the agreement');
select is(api_public.sign_agreement((select token from tokens where key = 'agr1'), (select code from tokens where key = 'agr1'), 'Nina Patel', repeat('0', 64)),
  false, 'a signature over other text is refused');
select is(api_public.sign_agreement((select token from tokens where key = 'agr1'), (select code from tokens where key = 'agr1'), 'Nina Patel',
  (select body_sha256 from api_public.read_agreement((select token from tokens where key = 'agr1'), (select code from tokens where key = 'agr1')))),
  true, 'the signer signs the text they read');
select is(api_public.sign_agreement((select token from tokens where key = 'agr1'), (select code from tokens where key = 'agr1'), 'Nina Patel', repeat('0', 64)),
  false, 'the token is spent once signed');
select pg_temp.as_platform();
select is((select failed_attempts::int from app.agreements where id = pg_temp.id('agr1')), 1, 'the wrong access code was counted');
select is((select agreement_state::text from app.agreements where id = pg_temp.id('agr1')), 'Signed', 'the agreement is Signed');
select is((select token_hash from app.agreements where id = pg_temp.id('agr1')), null::bytea, 'and the token is voided');
select is((select signed_body_sha256 = encode(extensions.digest(body, 'sha256'), 'hex') from app.agreements where id = pg_temp.id('agr1')), true, 'the hash of the signed text is kept');
select is((select count(*)::int from app.domain_events where event_type = 'agreement.signed' and subject_id = pg_temp.id('agr1')), 1, 'agreement.signed was emitted');

-- Lock at 5
select pg_temp.as_anon();
select is((select count(*)::int from generate_series(1, 5) g cross join lateral api_public.read_agreement((select token from tokens where key = 'agr_lock'), repeat('1', 8 + 0 * g)) r), 0, 'five wrong access codes');
select is((select count(*)::int from api_public.read_agreement((select token from tokens where key = 'agr_lock'), (select code from tokens where key = 'agr_lock'))), 0, 'lock the token even for the right code');
select pg_temp.as_platform();
select is((select failed_attempts::int from app.agreements where id = pg_temp.id('agr_lock')), 5, 'the token locked at 5');

-- Signed agreements are never revoked or unsigned (journey 9)
select pg_temp.as_user('carol');
select throws_ok($$select app.transition_agreement((select id from world where key = 'agr1'), 'Signed', 'Canceled', 'Revoke.')$$, 'XR001', null, 'a signed agreement cannot be revoked');
select throws_ok($$select app.transition_agreement((select id from world where key = 'agr1'), 'Signed', 'Proposed', 'Unsign.')$$, 'XR001', null, 'or unsigned');
select throws_ok($$update app.agreements set title = 'Edited' where id = (select id from world where key = 'agr1')$$,
  'XR001', 'agreement_signed_permanent: A signed agreement is never revoked, unsigned or edited; supersede it with a new agreement.', 'or edited');
select throws_ok($$update app.agreements set deleted_at = now() where id = (select id from world where key = 'agr1')$$, 'XR001', null, 'or deleted');
select lives_ok($$select app.transition_agreement((select id from world where key = 'agr1'), 'Signed', 'Superseded', 'Replaced by the revised letter.')$$, 'it can only be superseded');
select throws_ok($$select app.transition_agreement((select id from world where key = 'agr1'), 'Superseded', 'Signed', 'Back.')$$, 'XR001', null, 'Superseded is terminal');

-- Recall voids the token; signing while signed in
insert into tokens select 'agr_nda', t.signing_token, t.access_code from app.send_agreement(pg_temp.id('agr_nda'), 'Sent.') t;
select lives_ok($$select app.transition_agreement((select id from world where key = 'agr_nda'), 'Sent', 'Proposed', 'Recalled to fix a clause.')$$, 'Sent to Proposed recalls it');
select pg_temp.as_anon();
select is((select count(*)::int from api_public.read_agreement((select token from tokens where key = 'agr_nda'), (select code from tokens where key = 'agr_nda'))), 0, 'a recalled token reads nothing');
select pg_temp.as_user('carol');
select throws_ok($$select app.send_agreement((select id from world where key = 'agr_nda'), 'Too long.', interval '1 year')$$, 'XR001', null, 'a signing token lives at most 90 days');
select lives_ok($$select app.send_agreement((select id from world where key = 'agr_nda'), 'Sent again.')$$, 'it is sent again');
select pg_temp.as_user('mia');
select throws_ok($$select app.sign_agreement((select id from world where key = 'agr_nda'), 'Mia Takahashi', repeat('0', 64))$$, '42501', null, 'only the person named signs while signed in');
select pg_temp.as_user('nina');
select is(app.sign_agreement(pg_temp.id('agr_nda'), 'Nina Patel', (select encode(extensions.digest(body, 'sha256'), 'hex') from app.agreements where id = pg_temp.id('agr_nda'))),
  true, 'the person named signs while signed in');
select pg_temp.as_platform();
select is((select string_agg(from_state || '>' || to_state, ' ' order by from_state, to_state) from app.lifecycle_transition_rules where lifecycle = 'agreement'),
  'Proposed>Canceled Proposed>Sent Sent>Canceled Sent>Expired Sent>Proposed Sent>Signed Signed>Superseded', 'Signed moves only to Superseded');
select is((select count(*)::int from app.agreement_state_transitions where agreement_id = pg_temp.id('agr1')), 4, 'every agreement change is in the ledger');

select * from finish();
rollback;
