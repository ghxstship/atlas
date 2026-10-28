-- pgTAP: migration 2350, a supplier diversity certification and its certificate number declared in one call (A100,
-- RRR-145). app.add_supplier_diversity_certification admits only the owner, refuses a bad number before any row
-- exists, encrypts the number in the same insert and logs the declaration once, as created.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(17);

select ok(has_function_privilege('authenticated', 'app.add_supplier_diversity_certification(app.supplier_diversity_kind, text, uuid, uuid, text, date, date)', 'execute')
  and not has_function_privilege('anon', 'app.add_supplier_diversity_certification(app.supplier_diversity_kind, text, uuid, uuid, text, date, date)', 'execute'),
  'signed-in callers may declare through the RPC, anonymous callers may not');
select is((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p
           where p.oid = 'app.add_supplier_diversity_certification(app.supplier_diversity_kind, text, uuid, uuid, text, date, date)'::regprocedure),
  true, 'the RPC is security definer with an empty search path');

-- A refused number leaves no row ------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select throws_ok($$select app.add_supplier_diversity_certification('Women-Owned', 'Florida Office of Supplier Diversity',
  p_person_id => pg_temp.id('ivy'), p_certificate_number => '---')$$,
  'XR001', 'certificate_number_format: A certificate number has 1 to 100 letters and digits.', 'a number needs a letter or digit');
select throws_ok(format($$select app.add_supplier_diversity_certification('Women-Owned', 'Florida Office of Supplier Diversity',
  p_person_id => pg_temp.id('ivy'), p_certificate_number => %L)$$, repeat('7', 101)),
  'XR001', 'certificate_number_format: A certificate number has 1 to 100 letters and digits.', 'and at most 100');
select pg_temp.as_platform();
select is((select count(*)::integer from app.supplier_diversity_certifications where person_id = pg_temp.id('ivy')), 0,
  'a refused number leaves no certification behind');
select is((select count(*)::integer from app.supplier_diversity_events where person_id = pg_temp.id('ivy')), 0,
  'and nothing in the owner''s access log');

-- Only the owner declares ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('quinn');
select throws_ok($$select app.add_supplier_diversity_certification('Veteran-Owned', 'Self-Declared', p_person_id => pg_temp.id('ivy'))$$,
  'XR001', 'supplier_diversity_not_yours: Only the owner declares a supplier diversity certification.', 'nobody declares one for someone else');
select pg_temp.as_user('sam');
select throws_ok($$select app.add_supplier_diversity_certification('Minority-Owned', 'Self-Declared', p_account_id => pg_temp.id('acct_v'))$$,
  'XR001', 'supplier_diversity_not_yours: Only the owner declares a supplier diversity certification.',
  'a plain account member does not declare one for the company');
select pg_temp.as_anon();
select throws_ok($$select app.add_supplier_diversity_certification('Veteran-Owned', 'Self-Declared', p_person_id => gen_random_uuid())$$,
  '42501', null, 'an anonymous caller declares nothing');

-- One call, one insert, one log entry ------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select app.add_supplier_diversity_certification('Women-Owned', ' Florida Office of Supplier Diversity ',
  p_person_id => pg_temp.id('ivy'), p_certificate_number => 'fl-wbe-2026-118842', p_issued_on => '2026-01-15',
  p_expires_on => '2028-01-15') as v_cert \gset
select results_eq($$select id, certifying_body, certificate_number_last4, issued_on from app.my_supplier_diversity()$$,
  format($$values (%L::uuid, 'Florida Office of Supplier Diversity'::text, '8842'::text, '2026-01-15'::date)$$, :'v_cert'),
  'the owner declares a certification with its number in one call and sees its last four');
select pg_temp.as_platform();
select is((select extensions.pgp_sym_decrypt(certificate_number, private.supplier_certificate_number_key())
           from app.supplier_diversity_certifications where id = :'v_cert'), 'FLWBE2026118842',
  'the stored number is ciphertext of its letters and digits, upper-cased');
select is((select created_by from app.supplier_diversity_certifications where id = :'v_cert'), pg_temp.id('ivy'),
  'the declaration is attributed to the caller');
select results_eq(format($$select action, actor_person_id from app.supplier_diversity_events where supplier_diversity_certification_id = %L$$, :'v_cert'),
  format($$values ('supplier_diversity.created'::text, %L::uuid)$$, pg_temp.id('ivy')),
  'the owner''s access log records the declaration once, as created, with no update for the number');

select pg_temp.as_user('ivy');
select app.add_supplier_diversity_certification('Veteran-Owned', 'Self-Declared', p_person_id => pg_temp.id('ivy')) as v_plain \gset
select is((select certificate_number_last4 from app.my_supplier_diversity() where id = :'v_plain'), null,
  'a declaration without a number stores none');

select pg_temp.as_user('victor');
select app.add_supplier_diversity_certification('Minority-Owned', 'National Minority Supplier Development Council',
  p_account_id => pg_temp.id('acct_v'), p_certificate_number => 'NMSDC-55-0912') as v_acct_cert \gset
select is((select certificate_number_last4 from app.my_supplier_diversity(pg_temp.id('acct_v'))), '0912',
  'an account Owner declares one for the company with its number');
select pg_temp.as_platform();
select results_eq(format($$select action from app.audit_events where subject_id = %L order by action$$, :'v_acct_cert'),
  $$values ('supplier_diversity.created'::text)$$,
  'the company''s audit ledger records the declaration once, as created');
select is((select person_id from app.supplier_diversity_certifications where id = :'v_acct_cert'), null,
  'and the company, not the person, owns it');

select * from finish();
rollback;
