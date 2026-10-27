-- pgTAP: migration 2011, supplier diversity certificate numbers encrypted at rest (A100, RRR-145, S9-12) under the
-- government identifier rule of decision 38. The table holds only ciphertext under xos_supplier_certificate_number_key
-- and the last four; the owner sets the number only through app.set_supplier_diversity_certificate_number; an org sees
-- the last four, and the whole number only through app.reveal_shared_supplier_diversity_number with
-- data.restricted.read.government_id, step-up and a reason, logged for the owner and the org. Also the release check:
-- no Restricted banking or government identifier column anywhere stores plain text.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(35);

-- Key, shape and the catalog-wide check -----------------------------------------------------------------------------------
select is((select count(*)::integer from vault.secrets where name = 'xos_supplier_certificate_number_key'), 1,
  'the migration created the Vault key xos_supplier_certificate_number_key');
select ok(not has_function_privilege('authenticated', 'private.supplier_certificate_number_key()', 'execute'),
  'signed-in callers cannot read the key');
select results_eq($$select a.attname::text collate "default", format_type(a.atttypid, a.atttypmod) from pg_attribute a
  where a.attrelid = 'app.supplier_diversity_certifications'::regclass and a.attname like 'certificate_number%' and not a.attisdropped
  order by a.attname$$,
  $$values ('certificate_number'::text, 'bytea'::text), ('certificate_number_last4', 'text')$$,
  'the number is bytea ciphertext beside its last four');
select results_eq($$select column_name, classification::text, read_capability from app.column_classifications
  where table_name = 'app.supplier_diversity_certifications' and column_name like 'certificate_number%' order by column_name$$,
  $$values ('certificate_number'::text, 'Restricted'::text, 'data.restricted.read.government_id'::text),
           ('certificate_number_last4', 'Confidential', null)$$,
  'the number stays a Restricted government identifier and its last four is Confidential');
select is_empty($$select c.table_name || '.' || c.column_name from private.column_classifications c
  join pg_attribute a on a.attrelid = c.table_name::regclass and a.attname = c.column_name and not a.attisdropped
  where c.read_capability in ('data.restricted.read.banking', 'data.restricted.read.government_id')
    and format_type(a.atttypid, a.atttypmod) <> 'bytea'$$,
  'no Restricted banking or government identifier column stores plain text: every one is pgcrypto ciphertext');
select ok(not has_column_privilege('authenticated', 'app.supplier_diversity_certifications', 'certificate_number', 'SELECT')
  and not has_column_privilege('authenticated', 'app.supplier_diversity_certifications', 'certificate_number', 'INSERT')
  and not has_column_privilege('authenticated', 'app.supplier_diversity_certifications', 'certificate_number', 'UPDATE')
  and not has_column_privilege('authenticated', 'app.supplier_diversity_certifications', 'certificate_number_last4', 'UPDATE'),
  'signed-in callers neither select nor write the ciphertext or its last four');

-- The owner sets the number -------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
insert into app.supplier_diversity_certifications (person_id, diversity_kind, certifying_body, issued_on, expires_on)
  values (pg_temp.id('ivy'), 'Women-Owned', 'Florida Office of Supplier Diversity', '2026-01-15', '2028-01-15');
select id as v_cert from app.supplier_diversity_certifications where person_id = pg_temp.id('ivy') \gset
select throws_ok(format($$update app.supplier_diversity_certifications set certificate_number = 'x'::bytea where id = %L$$, :'v_cert'),
  '42501', null, 'the owner cannot write the ciphertext directly');
select lives_ok(format($$select app.set_supplier_diversity_certificate_number(%L, 'fl-wbe-2026-118842')$$, :'v_cert'),
  'the owner sets the number through the encrypting RPC');
select is((select certificate_number_last4 from app.my_supplier_diversity()), '8842', 'and sees its last four');
select throws_ok(format($$select app.set_supplier_diversity_certificate_number(%L, '---')$$, :'v_cert'),
  'XR001', 'certificate_number_format: A certificate number has 1 to 100 letters and digits.', 'a number needs a letter or digit');
select throws_ok(format($$select app.set_supplier_diversity_certificate_number(%L, %L)$$, :'v_cert', repeat('7', 101)),
  'XR001', 'certificate_number_format: A certificate number has 1 to 100 letters and digits.', 'and at most 100');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.set_supplier_diversity_certificate_number(%L, 'Q1234')$$, :'v_cert'),
  'XR001', 'supplier_diversity_not_yours: Only the owner sets a certificate number.', 'nobody else sets it');

-- No readable plain text at rest --------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok((select position(convert_to('FLWBE2026118842', 'UTF8') in certificate_number) = 0
             and position(convert_to('fl-wbe-2026-118842', 'UTF8') in certificate_number) = 0
           from app.supplier_diversity_certifications where id = :'v_cert'),
  'the number does not appear in the stored bytes');
select is((select extensions.pgp_sym_decrypt(certificate_number, private.supplier_certificate_number_key())
           from app.supplier_diversity_certifications where id = :'v_cert'), 'FLWBE2026118842',
  'the ciphertext decrypts under the Vault key to the number''s letters and digits, upper-cased');
select results_eq(format($$select action from app.supplier_diversity_events where supplier_diversity_certification_id = %L order by created_at, action$$, :'v_cert'),
  $$values ('supplier_diversity.created'::text), ('supplier_diversity.updated')$$,
  'setting the number lands in the owner''s access log as an update, never the value');
select throws_ok(format($$update app.supplier_diversity_certifications set certificate_number_last4 = '0000' where id = %L$$, :'v_cert'),
  'XR001', 'certificate_number_rpc_only: A certificate number is written only through app.set_supplier_diversity_certificate_number, which encrypts it.',
  'outside the RPC even the table owner cannot change the last four');
select private.begin_trusted_operation('supplier_certificate_number_write');
select throws_ok(format($$update app.supplier_diversity_certifications set certificate_number_last4 = 'ab' where id = %L$$, :'v_cert'),
  '23514', null, 'the last four is checked: one to four upper-case letters or digits');
select throws_ok(format($$update app.supplier_diversity_certifications set certificate_number = null where id = %L$$, :'v_cert'),
  '23514', null, 'and comes and goes with the number');
select private.end_trusted_operation('supplier_certificate_number_write');

-- The org sees the last four ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'gateway.supplier_diversity_program', 'Organization', pg_temp.id('org_a'), p_value_boolean => true);
select pg_temp.as_user('ivy');
select app.share_supplier_diversity(:'v_cert', pg_temp.id('org_a')) as v_share \gset
select pg_temp.as_user('victor');
insert into app.supplier_diversity_certifications (account_id, diversity_kind, certifying_body)
  values (pg_temp.id('acct_v'), 'Minority-Owned', 'National Minority Supplier Development Council');
select id as v_acct_cert from app.supplier_diversity_certifications where account_id = pg_temp.id('acct_v') \gset
select app.share_supplier_diversity(:'v_acct_cert', pg_temp.id('org_a')) as v_acct_share \gset
select pg_temp.as_user('alice');
select results_eq($$select certifying_body, certificate_number_last4 from app.shared_supplier_diversity(pg_temp.id('org_a')) order by certifying_body$$,
  $$values ('Florida Office of Supplier Diversity'::text, '8842'::text), ('National Minority Supplier Development Council', null)$$,
  'the org lists shared certifications with the last four only, even for a holder of the government identifier capability');
select ok(pg_get_function_result('app.shared_supplier_diversity(uuid)'::regprocedure) not like '%certificate_number text%',
  'the list no longer returns the whole number');

-- The audited reveal -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select app.reveal_shared_supplier_diversity_number(%L, 'Annual program audit.')$$, :'v_share'),
  '42501', 'vendors.vendor.read is required', 'a viewer without vendors.vendor.read reveals nothing');
select pg_temp.as_user('dave');
select throws_ok(format($$select app.reveal_shared_supplier_diversity_number(%L, 'Annual program audit.')$$, :'v_share'),
  '42501', 'data.restricted.read.government_id is required', 'a vendor reader without the government identifier capability reveals nothing');
select pg_temp.as_user('alice');
select throws_ok(format($$select app.reveal_shared_supplier_diversity_number(%L, 'Annual program audit.')$$, :'v_share'),
  'XR001', 'step_up_required: Confirm it is you with your second factor to reveal a certificate number.',
  'the Owner must step up first');
select pg_temp.as_user_stepped_up('alice');
select throws_ok(format($$select app.reveal_shared_supplier_diversity_number(%L, 'Audit')$$, :'v_share'),
  'XR001', 'certificate_reveal_reason: Write why you need the certificate number, in at least 10 characters.',
  'and write why');
select is(app.reveal_shared_supplier_diversity_number(:'v_share', 'Annual program audit.'), 'FLWBE2026118842',
  'with step-up and a reason the Owner reveals the whole number');
select throws_ok(format($$select app.reveal_shared_supplier_diversity_number(%L, 'Annual program audit.')$$, :'v_acct_share'),
  'XR001', 'certificate_number_missing: No certificate number is recorded.', 'a certification without a number has nothing to reveal');
select pg_temp.as_platform();
select results_eq(format($$select org_id, actor_person_id, reason from app.supplier_diversity_events
  where supplier_diversity_certification_id = %L and action = 'supplier_diversity.revealed'$$, :'v_cert'),
  format($$values (%L::uuid, %L::uuid, 'Annual program audit.'::text)$$, pg_temp.id('org_a'), pg_temp.id('alice')),
  'the reveal lands in the owner''s access log with the org, the person and the reason');
select is((select count(*)::integer from app.audit_events a where a.org_id = pg_temp.id('org_a') and a.action = 'supplier_diversity.number_revealed'
             and a.subject_id = :'v_share'::uuid and a.diff ->> 'reason' = 'Annual program audit.'), 1,
  'and in the org''s audit ledger with the reason, never the number');
select ok(not exists (select 1 from app.audit_events a where a.org_id = pg_temp.id('org_a') and a.diff::text like '%FLWBE2026118842%'),
  'no audit event carries the number');
select pg_temp.as_user('ivy');
select ok(exists (select 1 from app.supplier_diversity_events where action = 'supplier_diversity.revealed' and reason = 'Annual program audit.'),
  'ivy reads who revealed it and why in her own log');

-- Program off, share revoked, number cleared --------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'gateway.supplier_diversity_program', 'Organization', pg_temp.id('org_a'), p_value_boolean => false);
select pg_temp.as_user_stepped_up('alice');
select throws_ok(format($$select app.reveal_shared_supplier_diversity_number(%L, 'Annual program audit.')$$, :'v_share'),
  'XR001', 'supplier_diversity_not_shared: This certification is not shared with the organization.', 'with the program off nothing is revealed');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'gateway.supplier_diversity_program', 'Organization', pg_temp.id('org_a'), p_value_boolean => true);
select pg_temp.as_user('ivy');
select app.revoke_supplier_diversity_share(:'v_share');
select pg_temp.as_user_stepped_up('alice');
select throws_ok(format($$select app.reveal_shared_supplier_diversity_number(%L, 'Annual program audit.')$$, :'v_share'),
  '42501', null, 'nor once the owner revokes the share');
select pg_temp.as_user('ivy');
select lives_ok(format($$select app.set_supplier_diversity_certificate_number(%L, null)$$, :'v_cert'), 'the owner clears the number');
select is((select certificate_number_last4 from app.my_supplier_diversity()), null, 'and its last four goes with it');
select pg_temp.as_platform();
select is((select certificate_number from app.supplier_diversity_certifications where id = :'v_cert'), null, 'no ciphertext remains');

select * from finish();
rollback;
