-- pgTAP: migration 1591, the invariant 8 row in the words ADR 0033 decision 56 gives Section 7.5 (RRR-125; finding
-- A54-001). Recovery codes join the hashed secrets, second factors leave them for the auth service, and the row keeps
-- its code and number, so the assertions that name inv_08_token_rpcs_hashed_secrets still count for it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(4);

select is(
  (select statement from private.invariants where code = 'inv_08_token_rpcs_hashed_secrets'),
  'Token RPCs require a token and an access code, expire, rate-limit failed attempts, and return only the fields the page renders. Access codes, recovery codes and kiosk PINs are stored hashed and shown once. Second-factor secrets are held encrypted by the auth service and are never selectable by tenants.',
  'inv_08_token_rpcs_hashed_secrets: the registry states invariant 8 as the spec now words it');
select ok(
  (select statement not like '%second factors, recovery codes%' from private.invariants where code = 'inv_08_token_rpcs_hashed_secrets'),
  'inv_08_token_rpcs_hashed_secrets: second factors are no longer counted among the hashed secrets');
select ok(
  (select enforced_by like '%private.recovery_codes%' and enforced_by like '%auth.mfa_factors%'
   from private.invariants where code = 'inv_08_token_rpcs_hashed_secrets'),
  'inv_08_token_rpcs_hashed_secrets: enforced_by names the recovery code table and the second factors Supabase Auth holds');
select is(
  (select row(number, area)::text from private.invariants where code = 'inv_08_token_rpcs_hashed_secrets'),
  row(8, 'Tokens and secrets')::text,
  'inv_08_token_rpcs_hashed_secrets: the row keeps its number and area');

select * from finish();
rollback;
