-- pgTAP: migration 1383, finding A65-014 (RRR-127). Re-acceptance after a material change: only the platform team announces
-- one, at least 30 days ahead; the prompt reaches those who may accept for an org until the org accepts, and each person who
-- accepted an earlier personal document until they accept; Upcoming turns Required on the effective date; a withdrawn
-- notice prompts no one.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(18);

create function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;

-- Announcing ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok($$select app.announce_legal_change('terms-of-service', '2.0.0', 'Org', 'Clearer limits of liability.', current_date + 40)$$,
  '42501', null, 'only the platform team announces a change');

select pg_temp.as_service();
select throws_ok($$select app.announce_legal_change('terms-of-service', '2.0.0', 'Org', 'Clearer limits of liability.', current_date + 29)$$,
  'XR001', null, 'a change takes effect at least 30 days after its notice');
select lives_ok($$select app.announce_legal_change('terms-of-service', '2.0.0', 'Org', 'Clearer limits of liability.', current_date + 30)$$,
  'a change 30 days ahead is announced');
select lives_ok($$select app.announce_legal_change('worker-terms', '2.0.0', 'Personal', 'New rules for payout disputes.', current_date + 45)$$,
  'a personal document change is announced');
select throws_ok($$select app.announce_legal_change('terms-of-service', '2.0.0', 'Org', 'Again.', current_date + 60)$$,
  '23505', null, 'a version is announced once');
select pg_temp.as_platform();
select ok((select noticed_at > now() - interval '1 minute' from private.legal_change_notices where document_slug = 'terms-of-service'),
  'the notice time comes from the database');

-- Org documents: those who may accept for the org ----------------------------------------------------------------------
select pg_temp.as_user('alice');
select results_eq($$select document_slug, document_version, required from app.pending_legal_reacceptances(pg_temp.id('org_a'))$$,
  $$values ('terms-of-service'::text, '2.0.0'::text, false)$$, 'an Owner is asked to accept for the org, Upcoming');
select is((select count(*)::int from app.pending_legal_reacceptances()), 0,
  'and is not asked about a personal document she never accepted');
select pg_temp.as_user('bob');
select is((select count(*)::int from app.pending_legal_reacceptances(pg_temp.id('org_a'))), 0,
  'an Admin without org.legal.accept is not asked');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.pending_legal_reacceptances(pg_temp.id('org_a'))), 0,
  'nor is the Owner of another org about this one');
select is((select count(*)::int from app.pending_legal_reacceptances(pg_temp.id('org_b'))), 1,
  'who is asked about his own');

select pg_temp.as_user('alice');
select is(app.record_legal_acceptances(pg_temp.id('org_a'), array['terms-of-service'], array['2.0.0'], '203.0.113.7'), 1,
  'the Owner accepts the announced version for the org');
select is((select count(*)::int from app.pending_legal_reacceptances(pg_temp.id('org_a'))), 0, 'and the prompt ends');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.pending_legal_reacceptances(pg_temp.id('org_b'))), 1, 'other orgs are still asked');

-- Personal documents: each person who accepted an earlier version --------------------------------------------------------
select pg_temp.as_user('mia');
select app.record_legal_acceptances(null, array['worker-terms'], array['1.0.0-draft'], '203.0.113.8');
select results_eq($$select document_slug, document_version from app.pending_legal_reacceptances()$$,
  $$values ('worker-terms'::text, '2.0.0'::text)$$, 'a person who accepted the Worker Terms before is asked to accept the new version');
select app.record_legal_acceptances(null, array['worker-terms'], array['2.0.0'], '203.0.113.8');
select is((select count(*)::int from app.pending_legal_reacceptances()), 0, 'until she accepts it');

-- Required from the effective date; withdrawn prompts no one ---------------------------------------------------------------
select pg_temp.as_platform();
insert into private.legal_change_notices (document_slug, document_version, acceptance, summary, noticed_at, effective_on)
values ('data-processing-agreement', '2.0.0', 'Org', 'New international transfer terms.', now() - interval '40 days', current_date - 5);
select pg_temp.as_user('xavier');
select results_eq($$select document_slug, required from app.pending_legal_reacceptances(pg_temp.id('org_b')) order by 1$$,
  $$values ('data-processing-agreement'::text, true), ('terms-of-service'::text, false)$$,
  'a change past its effective date is Required');
select pg_temp.as_service();
select app.withdraw_legal_change('data-processing-agreement', '2.0.0');
select pg_temp.as_user('xavier');
select results_eq($$select document_slug from app.pending_legal_reacceptances(pg_temp.id('org_b'))$$,
  $$values ('terms-of-service'::text)$$, 'a withdrawn notice prompts no one');

select * from finish();
rollback;
