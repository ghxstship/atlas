-- pgTAP: account deletion names the renewal consent it keeps (6143, ADR 0161 D6.4). A person who agreed to a paid plan's
-- renewal terms is told their sign-in email and initials stay on that record; anyone else is not.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(3);

select pg_temp.as_user('nina');
insert into world values ('org_n', app.create_organization('Nina Lighting', 'nina-lighting'));
select app.record_renewal_consent(pg_temp.id('org_n'), 'core', 'Monthly', 14900, 'USD', (now() at time zone 'UTC')::date, '2026-11-06', 'en-US',
  'Core renews automatically.', '', true);

select pg_temp.as_platform();
select ok(private.account_deletion_kept(pg_temp.id('nina')) @> '[{"category": "billing_consent", "retention": "7 years"}]'::jsonb,
  'the person who agreed to renewal terms is told that record is kept');
select ok(not private.account_deletion_kept(pg_temp.id('dave')) @> '[{"category": "billing_consent"}]'::jsonb, 'anyone else is not');
select is((select jsonb_agg(k ->> 'category') from jsonb_array_elements(private.account_deletion_kept(pg_temp.id('nina'))) k),
  '["org_records", "billing_consent", "audit_trail", "erasure_request"]'::jsonb, 'in its place in the list');

select * from finish();
rollback;
