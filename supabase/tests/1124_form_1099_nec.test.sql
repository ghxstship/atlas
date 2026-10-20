-- pgTAP: A43 (RRR-87), migration 1124, finding A38-006. The 1099-NEC rows of a tax year: approved USD payments
-- from $600 to people and accounts engaged as independent contractors, with the W-9 on file and its address;
-- the full TIN only as a Restricted export with step-up, written to the audit log. Same-tenant allow,
-- cross-tenant deny, anon deny, role band; the payee alone completes its form's address.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(28);

create function pg_temp.pay(p_payee text, p_cp text, p_amount bigint, p_currency text, p_on date, p_approve boolean) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_platform();
  insert into app.payments (org_id, payee_person_id, counterparty_id, direction, amount_minor, currency_code, paid_on)
  values (pg_temp.id('org_a'), case when p_payee is not null then pg_temp.id(p_payee) end,
          case when p_cp is not null then pg_temp.id(p_cp) end, 'Payable', p_amount, p_currency, p_on)
  returning id into v_id;
  if p_approve then
    perform private.transition_lifecycle('payment', 'app.payments', 'payment_state', 'app.payment_state_transitions',
      'payment_id', v_id, 'Proposed', 'Approved', 'Fixture.');
  end if;
  return v_id;
end $$;

create function pg_temp.step_up() returns void language sql as $$
  select set_config('request.jwt.claims', (current_setting('request.jwt.claims')::jsonb || jsonb_build_object('aal', 'aal2',
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint))))::text, true);
$$;

-- World: ivy and art are individual independent contractors of org_a; acct_v is a vendor account (VENDOR_SUPPLIED).
select pg_temp.pay('ivy', null, 45000, 'USD', '2025-03-10', true);
select pg_temp.pay('ivy', null, 30000, 'USD', '2025-11-20', true);
select pg_temp.pay('ivy', null, 99000, 'USD', '2025-12-01', false);
select pg_temp.pay('ivy', null, 99000, 'EUR', '2025-12-02', true);
select pg_temp.pay('ivy', null, 70000, 'USD', '2024-12-31', true);
select pg_temp.pay('art', null, 59999, 'USD', '2025-06-02', true);
select pg_temp.pay(null, 'cp_v_a', 500000, 'USD', '2025-06-03', true);

select pg_temp.as_user('ivy');
insert into world values ('w9_ivy', app.submit_tax_form(pg_temp.id('org_a'), 'W-9', '123-45-6789'));

-- Rows -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select is((select count(*)::int from app.form_1099_nec_rows(pg_temp.id('org_a'), 2025)), 1,
  'one payee: approved USD payments of the year from $600 to an independent contractor');
select is((select amount_minor from app.form_1099_nec_rows(pg_temp.id('org_a'), 2025)), 75000::bigint,
  'the amount sums the year''s approved USD payments; Proposed, other currencies and other years stay out');
select is((select payment_count from app.form_1099_nec_rows(pg_temp.id('org_a'), 2025)), 2, 'with the payment count');
select is((select payee_person_id from app.form_1099_nec_rows(pg_temp.id('org_a'), 2025)), pg_temp.id('ivy'), 'the payee is the person');
select is((select payee_name from app.form_1099_nec_rows(pg_temp.id('org_a'), 2025)), 'Ivy Marchetti', 'named from their profile until the form names them');
select is((select w9_on_file from app.form_1099_nec_rows(pg_temp.id('org_a'), 2025)), true, 'with the W-9 on file');
select is((select tin_type from app.form_1099_nec_rows(pg_temp.id('org_a'), 2025)), 2::smallint, 'TIN type 2 (SSN) for a person');
select is((select tin_last4 from app.form_1099_nec_rows(pg_temp.id('org_a'), 2025)), '6789', 'the last four show');
select is((select tin from app.form_1099_nec_rows(pg_temp.id('org_a'), 2025)), null::text, 'the full TIN stays out without the Restricted export');
select is((select address_complete from app.form_1099_nec_rows(pg_temp.id('org_a'), 2025)), false, 'an address not yet given is flagged');
select ok(not exists (select 1 from app.form_1099_nec_rows(pg_temp.id('org_a'), 2025) where payee_person_id = pg_temp.id('art')),
  'a payee under $600 is left out');
select ok(not exists (select 1 from app.form_1099_nec_rows(pg_temp.id('org_a'), 2025) where payee_organization_id is not null),
  'a vendor account engaged as VENDOR_SUPPLIED is left out');
select is((select count(*)::int from app.form_1099_nec_rows(pg_temp.id('org_a'), 2024)), 1, 'each tax year stands alone');
select throws_ok(format($$select * from app.form_1099_nec_rows('%s', 2019)$$, pg_temp.id('org_a')), 'XR001', null, 'a tax year before 2020 is refused');

-- Address on the form ------------------------------------------------------------------------------------------------
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.set_tax_form_address('%s', null, '1 Pier Way', 'Miami', 'FL', '33101')$$, pg_temp.id('w9_ivy')),
  '42501', null, 'another person cannot complete the form');
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.set_tax_form_address('%s', null, '1 Pier Way', 'Miami', 'FL', 'ABC')$$, pg_temp.id('w9_ivy')),
  '23514', null, 'a W-9 postal code is a ZIP code');
select throws_ok(format($$select app.set_tax_form_address('%s', null, ' ', 'Miami', 'FL', '33101')$$, pg_temp.id('w9_ivy')),
  'XR001', null, 'the street address is required');
select lives_ok(format($$select app.set_tax_form_address('%s', 'Ivy R. Marchetti', '1 Pier Way', 'Miami', 'fl', '33101-2040')$$, pg_temp.id('w9_ivy')),
  'the payee completes the name and address on the form');
select is((select region_code from api_external.tax_forms where id = pg_temp.id('w9_ivy')), 'FL', 'and reads it back, the state in capitals');
select pg_temp.as_user('alice');
select is((select payee_name || ' / ' || address_complete::text from app.form_1099_nec_rows(pg_temp.id('org_a'), 2025)),
  'Ivy R. Marchetti / true', 'the export uses the name on the form and the complete address');

-- Restricted export ---------------------------------------------------------------------------------------------------
select throws_ok(format($$select * from app.form_1099_nec_rows('%s', 2025, true)$$, pg_temp.id('org_a')), 'XR001',
  'step_up_required: Exporting Restricted columns needs step-up authentication.', 'the full TIN needs step-up');
select pg_temp.step_up();
select is((select tin from app.form_1099_nec_rows(pg_temp.id('org_a'), 2025, true)), '123456789', 'with step-up the Restricted export carries the full TIN');
select pg_temp.as_platform();
select is((select count(*)::int from app.audit_events where org_id = pg_temp.id('org_a') and action = 'finance.form_1099_nec_exported'
  and actor_person_id = pg_temp.id('alice')), 1, 'the Restricted export is written to the audit log');

-- Access ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select * from app.form_1099_nec_rows('%s', 2025)$$, pg_temp.id('org_a')), '42501', null, 'role band: a Viewer without payment read is refused');
select pg_temp.as_user('dave');
select throws_ok(format($$select * from app.form_1099_nec_rows('%s', 2025, true)$$, pg_temp.id('org_a')), 'XR001',
  'export_restricted: The 1099-NEC file carries Restricted tax identifiers and needs the restricted export capability.',
  'role band: a Member cannot take the Restricted export');
select pg_temp.as_user('xavier');
select throws_ok(format($$select * from app.form_1099_nec_rows('%s', 2025)$$, pg_temp.id('org_a')), '42501', null, 'cross tenant: another org is refused');
select is((select count(*)::int from app.form_1099_nec_rows(pg_temp.id('org_b'), 2025)), 0, 'same tenant: org_b has no 1099 payees');
select pg_temp.as_anon();
select throws_ok(format($$select * from app.form_1099_nec_rows('%s', 2025)$$, pg_temp.id('org_a')), '42501', null, 'anon deny');
select pg_temp.as_platform();

select * from finish();
rollback;
