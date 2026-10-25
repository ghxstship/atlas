-- pgTAP: migration 1464, supplier diversity certifications (A89, RRR-134, A65-031). Self-declared by a person or a
-- company, read and written only by the owner, shared one org at a time under separate supplier_diversity consent and
-- only with an org that runs a program (gateway.supplier_diversity_program), read by that org only through the audited
-- RPC, with the Restricted certificate number masked to its last four for every reader (2011; the reveal is tested
-- in 2011_supplier_certificate_number_encryption.test.sql).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(23);

-- ivy declares one for herself; victor (Account Owner) one for the vendor account acct_v.
select pg_temp.as_user('ivy');
select lives_ok($$insert into app.supplier_diversity_certifications (person_id, diversity_kind, certifying_body, issued_on, expires_on)
  values (pg_temp.id('ivy'), 'Women-Owned', 'Florida Office of Supplier Diversity', '2026-01-15', '2028-01-15')$$,
  'a person declares a supplier diversity certification for herself');
select id as v_ivy_cert from app.supplier_diversity_certifications where person_id = pg_temp.id('ivy') \gset
select app.set_supplier_diversity_certificate_number(:'v_ivy_cert', 'FL-WBE-2026-118842');
select throws_ok($$select certificate_number from app.supplier_diversity_certifications$$, '42501', null,
  'the certificate number is Restricted: nobody signed in selects it, the owner included');
select is((select certificate_number_last4 from app.my_supplier_diversity()), '8842', 'the owner sees its last four characters');
select throws_ok($$insert into app.supplier_diversity_certifications (person_id, diversity_kind, certifying_body)
  values (pg_temp.id('quinn'), 'Veteran-Owned', 'Self-Declared')$$, '42501', null, 'nobody declares one for someone else');

select pg_temp.as_user('victor');
select lives_ok(format($$insert into app.supplier_diversity_certifications (account_id, diversity_kind, certifying_body)
  values (%L, 'Minority-Owned', 'National Minority Supplier Development Council')$$, pg_temp.id('acct_v')),
  'an account Owner declares one for the company');
select id as v_acct_cert from app.supplier_diversity_certifications where account_id = pg_temp.id('acct_v') \gset
select pg_temp.as_user('sam');
select is((select count(*)::integer from app.supplier_diversity_certifications), 0, 'a plain account member does not see the company''s');
select pg_temp.as_user('carol');
select is((select count(*)::integer from app.supplier_diversity_certifications), 0, 'no org member reads the table');

-- Sharing needs a program.
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.share_supplier_diversity(%L, %L)$$, :'v_ivy_cert', pg_temp.id('org_a')), 'XR001',
  'supplier_diversity_no_program: This organization does not run a supplier diversity program, so it takes no diversity certifications.',
  'an org without a supplier diversity program takes none');
select is((select count(*)::integer from app.supplier_diversity_programs()), 0, 'and is not offered');

select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'gateway.supplier_diversity_program', 'Organization', pg_temp.id('org_a'), p_value_boolean => true);
select pg_temp.as_user('ivy');
select results_eq($$select org_name from app.supplier_diversity_programs()$$, $$values ('Northwind Live'::text)$$,
  'once org_a runs a program, ivy (engaged by it) is offered it');
select app.share_supplier_diversity(:'v_ivy_cert', pg_temp.id('org_a')) as v_share \gset
select isnt(:'v_share'::uuid, null, 'she shares her certification with org_a');
select is(app.share_supplier_diversity(:'v_ivy_cert', pg_temp.id('org_a')), :'v_share'::uuid, 'sharing again returns the same live share');
select pg_temp.as_platform();
select results_eq($$select r.purpose_code, r.withdrawn_at is null from app.consent_records r
  where r.person_id = pg_temp.id('ivy') and r.org_id = pg_temp.id('org_a') and r.purpose_code like 'supplier%'$$,
  $$values ('supplier_diversity'::text, true)$$, 'under its own supplier_diversity consent, never profile sharing');

-- The org reads it through the audited RPC only.
select pg_temp.as_user('alice');
select results_eq($$select person_name, diversity_kind::text, certificate_number_last4 from app.shared_supplier_diversity(pg_temp.id('org_a'))$$,
  $$values ('Ivy Marchetti'::text, 'Women-Owned'::text, '8842'::text)$$,
  'the Owner reads the shared certification, the number masked to its last four even with the government identifier capability');
select pg_temp.as_user('dave');
select results_eq($$select certificate_number_last4 from app.shared_supplier_diversity(pg_temp.id('org_a'))$$,
  $$values ('8842'::text)$$, 'a member with vendors.vendor.read sees the same last four');
select pg_temp.as_user('gina');
select throws_ok($$select * from app.shared_supplier_diversity(pg_temp.id('org_a'))$$, '42501', null,
  'a viewer without vendors.vendor.read reads nothing');
select pg_temp.as_platform();
select ok((select count(*) from app.supplier_diversity_events e where e.supplier_diversity_certification_id = :'v_ivy_cert'
           and e.action = 'supplier_diversity.viewed' and e.org_id = pg_temp.id('org_a')) = 2, 'each read lands in ivy''s access log');
select ok(exists (select 1 from app.audit_events a where a.org_id = pg_temp.id('org_a') and a.action = 'supplier_diversity.viewed'),
  'and in the org''s audit ledger');
select pg_temp.as_user('ivy');
select set_eq($$select action from app.supplier_diversity_events$$,
  $$values ('supplier_diversity.created'), ('supplier_diversity.updated'), ('supplier_diversity.shared'), ('supplier_diversity.viewed')$$,
  'ivy sees every change, share and read in her own log');

-- Turning the program off hides it; revoking ends it.
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'gateway.supplier_diversity_program', 'Organization', pg_temp.id('org_a'), p_value_boolean => false);
select is_empty($$select * from app.shared_supplier_diversity(pg_temp.id('org_a'))$$, 'with the program off the org reads none');
select app.set_setting(pg_temp.id('org_a'), 'gateway.supplier_diversity_program', 'Organization', pg_temp.id('org_a'), p_value_boolean => true);
select pg_temp.as_user('ivy');
select lives_ok(format($$select app.revoke_supplier_diversity_share(%L)$$, :'v_share'), 'ivy revokes the share');
select pg_temp.as_platform();
select ok((select r.withdrawn_at is not null from app.consent_records r
           where r.person_id = pg_temp.id('ivy') and r.org_id = pg_temp.id('org_a') and r.purpose_code = 'supplier_diversity'),
  'the consent is withdrawn with the last share');
select pg_temp.as_user('alice');
select is_empty($$select * from app.shared_supplier_diversity(pg_temp.id('org_a'))$$, 'and the org reads nothing more');

select * from finish();
rollback;
