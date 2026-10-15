-- pgTAP: A15 late slot (0990 to 0992). The audit trail on finance tables, finance comment subjects and
-- the self-billing setting (0990); settlements with their lifecycle, NULL-aware totals, spend authority,
-- separation of duties and party access (0991); shared reports and self-billed invoices (0992).
-- Same-tenant allow, cross-tenant deny, anon deny, external access through the engagement (Section 8.7).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(56);

-- Audit trail and comment subjects (0990) ----------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.cost_centers (org_id, code, name, kind) values (pg_temp.id('org_a'), 'CC-VENUE', 'Venue Operations', 'Standing') returning id) insert into world select 'cc_venue', id from x;
with x as (insert into app.budgets (project_id, name, currency_code, is_baseline) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD', true) returning id) insert into world select 'bud_a', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, cost_center_id, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_a'), 1, 'Stage deck rental.', '5000.04.02', pg_temp.id('cc_venue'), 2, 15000, 'X', 'Declared') returning id) insert into world select 'line_stage', id from x;
update app.budget_lines set unit_price_minor = 16000 where id = pg_temp.id('line_stage');
select pg_temp.as_platform();
select ok(exists (select 1 from app.audit_events where subject_table = 'app.budget_lines' and subject_id = pg_temp.id('line_stage') and action = 'budget_lines.insert'),
  'a budget line insert lands in the audit ledger');
select ok(exists (select 1 from app.audit_events where subject_table = 'app.budget_lines' and subject_id = pg_temp.id('line_stage')
  and action = 'budget_lines.update' and diff -> 'new' ? 'unit_price_minor'), 'a price change lands with its diff');
select is((select actor_person_id from app.audit_events where subject_table = 'app.budget_lines' and subject_id = pg_temp.id('line_stage') and action = 'budget_lines.update'),
  pg_temp.id('carol'), 'and names the person who changed it');
select ok(exists (select 1 from app.audit_events where subject_table = 'app.cost_centers' and subject_id = pg_temp.id('cc_venue')), 'cost centers are audited');
select ok(exists (select 1 from app.audit_events where subject_table = 'app.budgets' and subject_id = pg_temp.id('bud_a')), 'budgets are audited');
select ok(exists (select 1 from private.comment_subjects where table_name = 'app.budgets'), 'budgets take comments and attachments');
select ok(exists (select 1 from private.comment_subjects where table_name = 'app.journal_entries'), 'journal entries take comments and attachments');
select ok(exists (select 1 from private.comment_subjects where table_name = 'app.settlements'), 'settlements take comments and attachments');
select is((select default_boolean from private.setting_definitions where setting_key = 'finance.self_billing_enabled'), false,
  'self-billing is off by default');

-- Settlements (0991) ----------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
with x as (insert into app.settlements (engagement_id, title, currency_code, settled_on) values (pg_temp.id('eng_art_a'), 'Opening Night', 'USD', '2027-06-02') returning id) insert into world select 'stl', id from x;
select is((select project_id from app.settlements where id = pg_temp.id('stl')), pg_temp.id('prj_a'), 'the project comes from the engagement');
select ok((select settlement_number > 0 from app.settlements where id = pg_temp.id('stl')), 'the number comes from the project sequence');
insert into app.settlement_lines (settlement_id, line_number, line_kind, description, amount_minor) values
  (pg_temp.id('stl'), 1, 'Guarantee', 'Guarantee.', 500000),
  (pg_temp.id('stl'), 2, 'Deduction', 'Production rider buyout.', 40000),
  (pg_temp.id('stl'), 3, 'Bonus', 'Sellout bonus.', null);
select pg_temp.as_platform();
select is((select net_minor from app.settlement_totals where settlement_id = pg_temp.id('stl')), null::bigint, 'an unpriced line leaves the net blank, never zero');
select is((select unpriced_count::int from app.settlement_totals where settlement_id = pg_temp.id('stl')), 1, 'with the unpriced count');
select is((select count(*)::int from app.domain_events where event_type = 'settlement.drafted' and subject_id = pg_temp.id('stl')), 1, 'drafting emits settlement.drafted');

select pg_temp.as_user('alice');
select throws_ok(format($$select app.submit_settlement('%s', 'Send.')$$, pg_temp.id('stl')), 'XR001', null, 'an unpriced settlement cannot be submitted');
select pg_temp.as_user('carol');
update app.settlement_lines set amount_minor = 50000 where settlement_id = pg_temp.id('stl') and line_number = 3;
select throws_ok(format($$select app.submit_settlement('%s', 'Send.')$$, pg_temp.id('stl')), 'XR001', null, 'the drafter cannot submit their own settlement');
select pg_temp.as_platform();
select is((select net_minor from app.settlement_totals where settlement_id = pg_temp.id('stl')), 510000::bigint, 'the net adds guarantees and bonuses and subtracts deductions');
select pg_temp.as_user('alice');
select throws_ok(format($$select app.submit_settlement('%s', 'Send.')$$, pg_temp.id('stl')), 'XR001',
  'spend_authority_missing: No spend authority lets this person approve a Contract in USD.', 'no spend authority is an absent claim and refuses');
select pg_temp.as_platform();
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values (pg_temp.id('org_a'), pg_temp.system_role('owner'), 'Contract', 'USD', 10000000);
select pg_temp.as_user('alice');
select is(app.submit_settlement(pg_temp.id('stl'), 'Send to the artist.'), true, 'an eligible approver submits within limit');
select throws_ok(format($$update app.settlement_lines set amount_minor = 1 where settlement_id = '%s'$$, pg_temp.id('stl')), 'XR001', null, 'lines lock once submitted');
select throws_ok(format($$select app.transition_settlement('%s', 'Submitted', 'Accepted', 'Self.')$$, pg_temp.id('stl')), 'XR001', null,
  'the org cannot accept on the party''s behalf');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.respond_to_settlement('%s', true, 'Mine.')$$, pg_temp.id('stl')), '42501', null, 'another party cannot respond');
select is((select count(*)::int from app.settlements), 0, 'another party reads no settlements');
select pg_temp.as_user('art');
select is((select count(*)::int from app.settlements), 1, 'own engagement: the artist reads the settlement');
select is((select count(*)::int from app.settlement_lines), 3, 'and its lines');
select lives_ok(format($$select app.respond_to_settlement('%s', false, 'The bonus should be higher.')$$, pg_temp.id('stl')), 'the artist disputes');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.transition_settlement('%s', 'Disputed', 'Proposed', 'Rework the bonus.')$$, pg_temp.id('stl')), 'the org reworks a disputed settlement');
update app.settlement_lines set amount_minor = 60000 where settlement_id = pg_temp.id('stl') and line_number = 3;
select pg_temp.as_user('alice');
select is(app.submit_settlement(pg_temp.id('stl'), 'Resend.'), true, 'and resubmits it');
select pg_temp.as_user('art');
select lives_ok(format($$select app.respond_to_settlement('%s', true, 'Agreed.')$$, pg_temp.id('stl')), 'the artist accepts');
select throws_ok(format($$select app.respond_to_settlement('%s', true, 'Again.')$$, pg_temp.id('stl')), 'XR001', null, 'an accepted settlement cannot be answered again');
select pg_temp.as_user('dave');
select throws_ok(format($$select app.transition_settlement('%s', 'Accepted', 'Paid', 'Paid.')$$, pg_temp.id('stl')), '42501', null, 'a Member cannot mark a settlement paid');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.transition_settlement('%s', 'Accepted', 'Paid', 'Wire sent.')$$, pg_temp.id('stl')), 'a Manager marks it paid');
select is((select settlement_state::text from app.settlements where id = pg_temp.id('stl')), 'Paid', 'the settlement is Paid');
select pg_temp.as_platform();
select is((select count(*)::int from app.settlement_state_transitions where settlement_id = pg_temp.id('stl')), 7, 'the ledger holds every move');
select is((select count(*)::int from app.domain_events where event_type = 'settlement.state_changed' and subject_id = pg_temp.id('stl')), 6, 'each move emits settlement.state_changed');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.settlements), 0, 'cross tenant: no settlements');
select pg_temp.as_anon();
select throws_ok('select 1 from app.settlements', '42501', null, 'anon cannot read settlements');
select pg_temp.as_platform();

-- Shared reports (0992) -----------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.report_definitions (membership_id, name, source_code) values (pg_temp.id('carol@org_a'), 'Show Spend', 'finance') returning id) insert into world select 'rdef', id from x;
select pg_temp.as_platform();
with x as (insert into app.report_runs (report_definition_id, run_for_membership_id, export_format) values (pg_temp.id('rdef'), pg_temp.id('carol@org_a'), 'PDF') returning id) insert into world select 'run', id from x;
select pg_temp.as_user('carol');
select throws_ok(format($$select app.share_report('%s', '%s', 'Show spend')$$, pg_temp.id('run'), pg_temp.id('eng_art_a')), 'XR001', null, 'an unfinished run cannot be shared');
select pg_temp.as_platform();
update app.report_runs set run_status = 'Succeeded', started_at = now(), finished_at = now(), row_count = 3 where id = pg_temp.id('run');
select pg_temp.as_user('dave');
select throws_ok(format($$select app.share_report('%s', '%s', 'Show spend')$$, pg_temp.id('run'), pg_temp.id('eng_art_a')), '42501', null, 'only the runner with the export capability shares');
select pg_temp.as_user('carol');
select lives_ok(format($$insert into world values ('share', app.share_report('%s', '%s', 'Show spend'))$$, pg_temp.id('run'), pg_temp.id('eng_art_a')), 'the runner shares the finished run');
select throws_ok(format($$select app.share_report('%s', '%s', 'Twice')$$, pg_temp.id('run'), pg_temp.id('eng_art_a')), '23505', null, 'one live share per run and engagement');
select throws_ok(format($$select app.share_report('%s', '%s', 'Past', now() - interval '1 day')$$, pg_temp.id('run'), pg_temp.id('eng_ivy_a')), 'XR001', null, 'a share cannot expire in the past');
select pg_temp.as_user('art');
select is((select count(*)::int from app.shared_reports), 1, 'own engagement: the party reads the share');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.shared_reports), 0, 'another engagement reads nothing');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.revoke_shared_report('%s')$$, pg_temp.id('share')), 'the org revokes the share');
select pg_temp.as_user('art');
select is((select count(*)::int from app.shared_reports), 0, 'a revoked share no longer opens');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type in ('report.shared', 'report.share_revoked') and subject_id = pg_temp.id('share')), 2, 'sharing and revoking emit events');

-- Self-billing (0992) ---------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
update app.engagements set agreed_rate_minor = 65000, currency_code = 'USD' where id = pg_temp.id('eng_vendor_a');
insert into app.time_entries (project_id, engagement_id, clock_in, clock_out, break_minutes)
values (pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a'), '2027-06-01 12:00+00', '2027-06-01 20:30+00', 30),
  (pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a'), '2027-06-02 12:00+00', '2027-06-02 16:00+00', 0);
with t as (insert into app.timesheets (project_id, engagement_id, period_start, period_end) values (pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a'), '2027-06-01', '2027-06-07') returning id)
  insert into world select 'sheet', id from t;
select private.transition_lifecycle('timesheet', 'app.timesheets', 'timesheet_state', 'app.timesheet_state_transitions', 'timesheet_id',
  pg_temp.id('sheet'), 'Proposed', 'Submitted', 'Fixture.');
select private.transition_lifecycle('timesheet', 'app.timesheets', 'timesheet_state', 'app.timesheet_state_transitions', 'timesheet_id',
  pg_temp.id('sheet'), 'Submitted', 'Approved', 'Fixture.');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.generate_self_billed_invoice('%s', '2027-06-01', '2027-06-30')$$, pg_temp.id('eng_vendor_a')), 'XR001',
  'self_billing_disabled: Self-billing is off for this project; turn it on in Legal Entities and Fiscal settings first.', 'self-billing off refuses');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'finance.self_billing_enabled', 'Organization', pg_temp.id('org_a'), null, true, null, false);
select pg_temp.as_user('carol');
select throws_ok(format($$select app.generate_self_billed_invoice('%s', '2027-06-01', '2027-06-30')$$, pg_temp.id('eng_vendor_a')), 'XR001',
  'self_billing_not_agreed: The party has not agreed to self-billing on this engagement; they agree in Gateway.', 'no live agreement refuses');
select pg_temp.as_user('fiona');
select app.agree_self_billing(pg_temp.id('eng_vendor_a'));
select pg_temp.as_user('dave');
select throws_ok(format($$select app.generate_self_billed_invoice('%s', '2027-06-01', '2027-06-30')$$, pg_temp.id('eng_vendor_a')), '42501', null,
  'a Member without assigned invoice write cannot generate');
select pg_temp.as_user('carol');
select lives_ok(format($$insert into world values ('sb_inv', app.generate_self_billed_invoice('%s', '2027-06-01', '2027-06-30'))$$, pg_temp.id('eng_vendor_a')),
  'with the setting and a live agreement the org generates the invoice');
select is((select direction::text || ' ' || invoice_state::text from app.invoices where id = pg_temp.id('sb_inv')), 'Payable Proposed', 'a Proposed payable');
select is((select quantity from app.invoice_lines where invoice_id = pg_temp.id('sb_inv')), 2::numeric, 'one line per timesheet billing its worked days at a day rate');
select is((select unit_price_minor from app.invoice_lines where invoice_id = pg_temp.id('sb_inv')), 65000::bigint, 'priced at the agreed day rate');
select throws_ok(format($$select app.generate_self_billed_invoice('%s', '2027-06-01', '2027-06-30')$$, pg_temp.id('eng_vendor_a')), 'XR001', null,
  'a timesheet is billed once');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.self_billed_timesheets), 0, 'cross tenant: no self-billing links');
select pg_temp.as_platform();

select * from finish();
rollback;
