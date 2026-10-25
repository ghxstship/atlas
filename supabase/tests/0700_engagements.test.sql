-- pgTAP: the engagement contract (decisions D16 and D17, ADR 0012). Organization type, the engagement
-- compliance rules XOS-ENG-1 to XOS-ENG-6 (the engagement part of design/xos-design-system/export/canon/
-- checks.sql, ported with the CSMIA26 fixture loaded only inside this transaction), engagement_resolved,
-- the engagement and Engagement-Document state machines (allowed and refused), Restricted rate masking,
-- internal row level security and the monthly external engagement plan limit (Section 16).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

-- CSMIA26 fixture (fixture_csmia26.sql), kept inside this transaction (ADR 0014 open decision 8) ---------------
select pg_temp.new_user('jules', 'jules@ghxstship.test', 'Jules Contract');
select pg_temp.as_user('jules');
insert into world values ('GHXSTSHIP', app.create_organization('GHXSTSHIP Industries LLC', 'ghxstship-check'));
select pg_temp.as_platform();
select is((select organization_type from app.organizations where id = pg_temp.id('GHXSTSHIP')), 'For-Profit',
  'a new organization is For-Profit until it declares otherwise (D17)');
select throws_ok($$update app.organizations set organization_type = 'Partnership' where id = (select id from world where key = 'GHXSTSHIP')$$,
  '23503', null, 'organization type comes from the canon list');
select pg_temp.as_user('jules');
with v as (insert into app.venues (org_id, name, jurisdiction_id, time_zone)
  values (pg_temp.id('GHXSTSHIP'), 'Mana Wynwood Convention Center & Grounds', 'US-FL-MIAMI-DADE', 'America/New_York') returning id)
  insert into world select 'mana-wynwood', id from v;
with p as (insert into app.projects (org_id, project_key, name, venue_id, time_zone)
  values (pg_temp.id('GHXSTSHIP'), 'CSMIA', 'Brand House Miami', pg_temp.id('mana-wynwood'), 'America/New_York') returning id)
  insert into world select 'CSMIA26', id from p;
select pg_temp.as_platform();
with p as (insert into app.people (full_name) values ('Check Person') returning id) insert into world select 'PER-T01', id from p;
select pg_temp.as_user('jules');
insert into world values ('CPY-T01', app.create_counterparty(pg_temp.id('GHXSTSHIP'), 'Check Vendor', null));
with l as (insert into app.labor_agreements (org_id, name, union_local, effective_from)
  values (pg_temp.id('GHXSTSHIP'), 'Check Agreement', 'Check Local', '2026-01-01') returning id)
  insert into world select 'LAG-T01', id from l;

create function pg_temp.engage(p_role text, p_wc text, p_basis text, p_arr text, p_emp text default null,
  p_flsa text default null, p_lag text default null, p_cp text default null, p_project text default 'CSMIA26')
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis,
    arrangement, employment_status, flsa_status, labor_agreement_id, start_date)
  values (pg_temp.id(p_project), pg_temp.id('PER-T01'), pg_temp.id(p_cp), 'Crew', p_role, p_wc, p_basis, p_arr, p_emp, p_flsa,
    pg_temp.id(p_lag), '2026-10-16') returning id into v;
  return v;
end $$;
grant execute on function pg_temp.engage(text, text, text, text, text, text, text, text, text) to public;

-- checks.sql 1 to 3 are canon (rate cards); A01's suites own them. 4 to 10 follow.
select throws_ok($$select pg_temp.engage('5000.51.01', 'INDEPENDENT_CONTRACTOR', 'Hourly', 'Per Engagement')$$,
  '23503', null, 'check 4: an engagement must match an existing rate card');
select throws_ok($$select pg_temp.engage('5000.51.01', 'EMPLOYEE', 'Day Rate', 'Per Engagement')$$,
  'XR001', 'XOS-ENG-2: Employee engagements require employment status and FLSA status.', 'check 5: employees need employment and FLSA status (XOS-ENG-2)');
select throws_ok($$select pg_temp.engage('5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', null, 'Exempt')$$,
  'XR001', 'XOS-ENG-3: Employment status, FLSA status and labor agreements apply only to employees.', 'check 6: FLSA status only for employees (XOS-ENG-3)');
select throws_ok($$select pg_temp.engage('5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', null, null, 'LAG-T01')$$,
  'XR001', null, 'labor agreements only for employees (XOS-ENG-3)');
select throws_ok($$select pg_temp.engage('9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement')$$,
  'XR001', 'XOS-ENG-4: Vendor-supplied engagements must name the vendor.', 'check 7: vendor-supplied labor names the vendor (XOS-ENG-4)');
select throws_ok($$select pg_temp.engage('5000.51.01', 'VOLUNTEER', 'Day Rate', 'Per Engagement')$$,
  'XR001', 'XOS-ENG-1: Volunteer engagements cannot have a pay basis.', 'check 8: unpaid engagements carry no pay basis (XOS-ENG-1)');
select pg_temp.as_platform();
insert into xpms.rate_card (rate_card_id, role_code, worker_classification, pay_basis, arrangement, standard_rate_minor, currency_code, overtime_rule_id)
  values ('LRC-909', '6000.51.01', 'EMPLOYEE', 'Hourly', 'Per Engagement', 3000, 'USD', 'OTR-002');
select pg_temp.as_user('jules');
select throws_ok($$select pg_temp.engage('6000.51.01', 'EMPLOYEE', 'Hourly', 'Per Engagement', 'Temporary', 'Nonexempt')$$,
  'XR001', 'XOS-ENG-5: Nonexempt employees need an overtime multiplier of at least 1.5 here; the rate card rule gives 1.', 'check 9: overtime below the legal minimum (XOS-ENG-5)');
select throws_ok($$select pg_temp.engage('6000.51.01', 'VOLUNTEER', null, null)$$,
  'XR001', 'XOS-ENG-6: Volunteer engagements are not permitted for this organization type.', 'check 10: no volunteers at a for-profit (XOS-ENG-6)');
select throws_ok($$select pg_temp.engage('5000.51.02', 'INDEPENDENT_CONTRACTOR', null, null)$$,
  'XR001', 'XOS-ENG-1: Independent Contractor engagements require a pay basis.', 'paid classifications need a pay basis (XOS-ENG-1)');

-- Valid engagements, one per classification.
select lives_ok($$insert into world values ('ENG-T10', pg_temp.engage('5000.51.01', 'EMPLOYEE', 'Day Rate', 'Per Engagement', 'Temporary', 'Nonexempt', 'LAG-T01'))$$,
  'an employee engagement with status and agreement');
select lives_ok($$insert into world values ('ENG-T11', pg_temp.engage('0000.50.01', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Retainer'))$$,
  'a retainer independent contractor engagement');
select lives_ok($$insert into world values ('ENG-T12', pg_temp.engage('9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', null, null, null, 'CPY-T01'))$$,
  'a vendor-supplied engagement naming the vendor');
select pg_temp.as_platform();
with o as (insert into app.organizations (slug, name, organization_type) values ('check-nonprofit', 'Check Nonprofit', 'Nonprofit') returning id)
  insert into world select 'ORG-T01', id from o;
with v as (insert into app.venues (org_id, name, jurisdiction_id, time_zone) values (pg_temp.id('ORG-T01'), 'Benefit Hall', 'US-FL-MIAMI-DADE', 'America/New_York') returning id)
  insert into world select 'venue_t01', id from v;
with p as (insert into app.projects (org_id, project_key, name, venue_id, time_zone) values (pg_temp.id('ORG-T01'), 'BEN', 'Check Benefit Night', pg_temp.id('venue_t01'), 'America/New_York') returning id)
  insert into world select 'PRJ-T01', id from p;
select lives_ok($$insert into world values ('ENG-T13', pg_temp.engage('6000.51.01', 'VOLUNTEER', null, null, null, null, null, null, 'PRJ-T01'))$$,
  'volunteers are permitted at a nonprofit (XOS-ENG-6)');
select throws_ok($$update app.engagements set pay_basis = 'Day Rate', arrangement = 'Per Engagement' where id = (select id from world where key = 'ENG-T13')$$,
  'XR001', null, 'the rules hold on update too');
select throws_ok($$update app.engagements set agreed_rate_minor = 1 where id = (select id from world where key = 'ENG-T13')$$,
  '23514', null, 'an unpaid engagement carries no agreed rate');

select pg_temp.as_user('jules');
select is((select count(*)::int from app.engagement_resolved where engagement_id in (pg_temp.id('ENG-T10'), pg_temp.id('ENG-T11'), pg_temp.id('ENG-T12'))), 3,
  'engagement_resolved returns every engagement of the org');
select is((select rate_minor from app.engagement_resolved where engagement_id = pg_temp.id('ENG-T11')), 180000::bigint,
  'the retainer reads the canon rate card rate (1800.00 USD in minor units)');
select is((select job_title from app.engagement_resolved where engagement_id = pg_temp.id('ENG-T10')),
  (select job_title from xpms.role where role_code = '5000.51.01'), 'job titles are joined from the Roles Library, never stored');
select is((select ot_multiplier from app.engagement_resolved where engagement_id = pg_temp.id('ENG-T10')), 1.5, 'overtime multipliers come from the rule');
with c as (insert into app.rate_cards (org_id, name, currency_code, effective_from) values (pg_temp.id('GHXSTSHIP'), 'Check Card', 'USD', '2026-01-01') returning id)
  insert into world select 'card', id from c;
insert into app.rate_card_lines (rate_card_id, role_code, worker_classification, pay_basis, arrangement, overtime_rule_id, rate_minor)
  values (pg_temp.id('card'), '0000.50.01', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Retainer', 'OTR-002', 170000);
select is((select rate_minor from app.engagement_resolved where engagement_id = pg_temp.id('ENG-T11')), 170000::bigint,
  'an org rate card line in force overrides the canon rate');
update app.engagements set agreed_rate_minor = 165000, currency_code = 'USD' where id = pg_temp.id('ENG-T11');
select is((select rate_minor from app.engagement_resolved where engagement_id = pg_temp.id('ENG-T11')), 165000::bigint,
  'an agreed rate overrides the rate card (agreed_rate_minor, ADR 0014)');
select throws_ok($$update app.engagements set agreed_rate_minor = 2, currency_code = null where id = (select id from world where key = 'ENG-T11')$$,
  '23514', null, 'an agreed rate carries its currency');
select pg_temp.as_platform();

-- Restricted rate (Section 8.3) ----------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok('select agreed_rate_minor from app.engagements', '42501', null, 'the agreed rate is never selectable directly');
select is((select rate_minor from app.engagement_resolved where engagement_id = pg_temp.id('eng_ivy_a')), 99000::bigint, 'the Owner reads the rate unmasked');
select pg_temp.as_user('dave');
select is((select is_masked from app.engagement_resolved where engagement_id = pg_temp.id('eng_ivy_a')), true, 'a project Member reads the rate masked');
select is((select rate_minor from app.engagement_resolved where engagement_id = pg_temp.id('eng_ivy_a')), null::bigint, 'masked rates are NULL, never zero');
select pg_temp.as_platform();

-- Internal row level security ------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::int from app.engagements), 3, 'a project member reads the project''s engagements (invariant 2)');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.engagements), 0, 'a Viewer outside the project reads none');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.engagements where org_id = pg_temp.id('org_a')), 0, 'another org reads none');
select is((select count(*)::int from app.engagements), 3, 'Harbor Lights reads its own three');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.engagements), 0, 'an engaged party never reads the internal table (Section 8.7 projections)');
select is((select count(*)::int from app.engagement_resolved), 0, 'nor the resolved view');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date) values ((select id from world where key = 'prj_a'), (select id from world where key = 'quinn'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01')$$,
  '42501', null, 'a Member cannot create engagements');
select pg_temp.as_user('carol');
select throws_ok($$update app.engagements set person_id = (select id from world where key = 'quinn') where id = (select id from world where key = 'eng_ivy_a')$$,
  '42501', null, 'the party column is not writable');
select throws_ok($$update app.engagements set engagement_state = 'Active' where id = (select id from world where key = 'eng_ivy_a')$$,
  '42501', null, 'the state column is not writable');
select throws_ok($$insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date, org_id) values ((select id from world where key = 'prj_a'), (select id from world where key = 'quinn'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01', (select id from world where key = 'org_b'))$$,
  '42501', null, 'org_id is never accepted from the caller');
select throws_ok($$insert into app.engagements (project_id, counterparty_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date) values ((select id from world where key = 'prj_a'), (select id from world where key = 'cp_v_b'), 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2027-06-01')$$,
  'XR001', 'cross_org_reference: engagements.counterparty_id points to a row of another org.', 'an engagement cannot name another org''s counterparty');
select throws_ok($$insert into app.engagements (project_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date) values ((select id from world where key = 'prj_a'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01')$$,
  '23514', null, 'an engagement names a person or a counterparty');
select pg_temp.as_anon();
select throws_ok('select 1 from app.engagements', '42501', null, 'anon cannot read engagements');
select throws_ok('select 1 from app.engagement_documents', '42501', null, 'anon cannot read engagement documents');
select throws_ok('select 1 from app.labor_agreements', '42501', null, 'anon cannot read labor agreements');
select pg_temp.as_platform();

-- Engagement state machine ----------------------------------------------------------------------------------
select is((select to_state::text from app.engagement_state_transitions where engagement_id = pg_temp.id('eng_ivy_a') and from_state is null),
  'Onboarding', 'creation writes the ledger entry');
select pg_temp.as_user('dave');
select throws_ok($$select app.transition_engagement((select id from world where key = 'eng_ivy_a'), 'Onboarding', 'Active', 'Ready.')$$,
  '42501', null, 'a Member cannot move an engagement');
select pg_temp.as_user('carol');
select throws_ok($$select app.transition_engagement((select id from world where key = 'eng_ivy_a'), 'Onboarding', 'Complete', 'Skip.')$$,
  'XR001', 'engagement_transition_not_allowed: A engagement cannot move from Onboarding to Complete.', 'Onboarding cannot jump to Complete');
select throws_ok($$select app.transition_engagement((select id from world where key = 'eng_ivy_a'), 'Active', 'Closing', 'Stale.')$$,
  'XR001', null, 'compare-and-set refuses a stale expected state');
select throws_ok($$select app.transition_engagement((select id from world where key = 'eng_ivy_a'), 'Onboarding', 'Blocked', '')$$,
  'XR001', 'transition_reason_required: Every state change carries a reason.', 'every move carries a reason');
select lives_ok($$select app.transition_engagement((select id from world where key = 'eng_ivy_a'), 'Onboarding', 'Blocked', 'Waiting on insurance.')$$, 'Onboarding to Blocked');
select lives_ok($$select app.transition_engagement((select id from world where key = 'eng_ivy_a'), 'Blocked', 'Onboarding', 'Insurance received.')$$, 'Blocked to Onboarding');
select lives_ok($$select app.transition_engagement((select id from world where key = 'eng_ivy_a'), 'Onboarding', 'Active', 'Onboarded.')$$, 'Onboarding to Active');
select lives_ok($$select app.transition_engagement((select id from world where key = 'eng_ivy_a'), 'Active', 'Closing', 'Show over.')$$, 'Active to Closing');
select lives_ok($$select app.transition_engagement((select id from world where key = 'eng_ivy_a'), 'Closing', 'Active', 'Extra day.')$$, 'Closing back to Active');
select lives_ok($$select app.transition_engagement((select id from world where key = 'eng_ivy_a'), 'Active', 'Closing', 'Done.')$$, 'Active to Closing again');
select lives_ok($$select app.transition_engagement((select id from world where key = 'eng_ivy_a'), 'Closing', 'Complete', 'Paid and rated.')$$, 'Closing to Complete');
select throws_ok($$select app.transition_engagement((select id from world where key = 'eng_ivy_a'), 'Complete', 'Active', 'Reopen.')$$, 'XR001', 'engagement_transition_not_allowed: A engagement cannot move from Complete to Active.', 'Complete is terminal');
select throws_ok($$select app.transition_engagement((select id from world where key = 'eng_art_a'), 'Onboarding', 'Closing', 'Skip.')$$, 'XR001', 'engagement_transition_not_allowed: A engagement cannot move from Onboarding to Closing.', 'Onboarding cannot jump to Closing');
select lives_ok($$select app.transition_engagement((select id from world where key = 'eng_art_a'), 'Onboarding', 'Canceled', 'Date moved.')$$, 'Onboarding to Canceled');
select throws_ok($$select app.transition_engagement((select id from world where key = 'eng_art_a'), 'Canceled', 'Onboarding', 'Back.')$$, 'XR001', 'engagement_transition_not_allowed: A engagement cannot move from Canceled to Onboarding.', 'Canceled is terminal');
select is((select count(*)::int from app.engagement_state_transitions where engagement_id = pg_temp.id('eng_ivy_a')), 8,
  'every move is in the ledger');
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'engagement'), 11, 'the engagement lifecycle declares eleven moves');
select throws_ok($$update app.engagement_state_transitions set reason = 'x'$$, '42501', null, 'the ledger is not writable');
select pg_temp.as_platform();
select throws_ok($$update app.engagement_state_transitions set reason = 'x' where engagement_id = (select id from world where key = 'eng_ivy_a')$$,
  'XR001', null, 'the ledger is append-only even for the platform');
select throws_ok($$update app.engagements set engagement_state = 'Active' where id = (select id from world where key = 'eng_quinn_b')$$,
  'XR001', 'engagement_transition_rpc_only: engagement_state changes only through its transition RPC, which logs the change.', 'the state column changes only through the RPC');
select throws_ok($$update app.engagements set role_type = 'Staff' where id = (select id from world where key = 'eng_quinn_b')$$,
  'XR001', null, 'the role type never changes');

-- Engagement-Document state machine -------------------------------------------------------------------------
select pg_temp.as_user('carol');
with d as (insert into app.engagement_documents (engagement_id, document_kind, title) values (pg_temp.id('eng_vendor_a'), 'Agreement', 'Audio Supply Agreement') returning id)
  insert into world select 'doc_v', id from d;
select throws_ok($$select app.transition_engagement_document((select id from world where key = 'doc_v'), 'Proposed', 'Executed', 'Skip.')$$, 'XR001', 'engagement_document_transition_not_allowed: A engagement document cannot move from Proposed to Executed.', 'a draft cannot be executed before it is sent and signed');
select lives_ok($$select app.transition_engagement_document((select id from world where key = 'doc_v'), 'Proposed', 'Sent', 'Sent for signature.')$$, 'Proposed to Sent');
select throws_ok($$select app.transition_engagement_document((select id from world where key = 'doc_v'), 'Sent', 'Signed', 'Org signs.')$$,
  'XR001', 'engagement_document_party_signs: Only the engaged party signs; the org countersigns to execute.', 'the org cannot sign for the party');
select lives_ok($$select app.transition_engagement_document((select id from world where key = 'doc_v'), 'Sent', 'Proposed', 'Revising terms.')$$, 'Sent back to Proposed');
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'engagement_document'), 10, 'the document lifecycle declares ten moves');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.engagement_documents), 1, 'a project member reads engagement documents');
select throws_ok($$select app.transition_engagement_document((select id from world where key = 'doc_v'), 'Proposed', 'Sent', 'Send.')$$,
  '42501', null, 'a Member cannot move documents');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.engagement_documents), 0, 'another org reads no documents');
select pg_temp.as_platform();

-- Plan limit: active external engagements per month (Section 16) -----------------------------------------------
select is((select limit_value from private.org_plan_limits where org_id = pg_temp.id('org_b') and limit_code = 'active_external_engagements_per_month'),
  25::bigint, 'Harbor Lights on Access may start 25 engagements a month');
insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
select pg_temp.id('prj_b'), pg_temp.id('quinn'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-08-01'
from generate_series(1, 22);
select throws_ok($$insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date) values ((select id from world where key = 'prj_b'), (select id from world where key = 'quinn'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-08-01')$$,
  'XR001', 'plan_limit_exceeded: The plan allows 25 active_external_engagements_per_month; this change needs 26.', 'the 26th engagement of the month is refused on Access');

select * from finish();
rollback;
