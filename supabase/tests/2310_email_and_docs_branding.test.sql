-- pgTAP: the brand lookups of notification email and the docs site (2310, A138, S12-01, ADR 0066). The email lookup is
-- the worker's alone and answers only while white label is in force; the docs lookup is public, answers only for an
-- Enterprise org with white label in force, and returns the name, logos and accent and nothing else.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(18);

-- Northwind (org_a, Team) and Harbor Lights (org_b, Access) both save a brand.
select pg_temp.as_platform();
insert into app.org_brands (org_id, display_name, logo_light_path, logo_dark_path, accent_hex, email_sender_name, support_email, legal_entity_name)
values (pg_temp.id('org_a'), 'Northwind', pg_temp.id('org_a') || '/logo-light.png', pg_temp.id('org_a') || '/logo-dark.png', '#0B5FFF',
  'Northwind Crew Desk', 'crew@northwind-live.com', 'Northwind Live LLC'),
  (pg_temp.id('org_b'), 'Harbor Lights', null, null, '#0B5FFF', 'Harbor Desk', 'desk@harbor-lights.com', null);

-- Email ----------------------------------------------------------------------------------------------------------------
select is(
  (select row(brand_name, sender_name, reply_to, logo_path, accent_hex)::text from app.email_brand_for_org(pg_temp.id('org_a'))),
  row('Northwind', 'Northwind Crew Desk', 'crew@northwind-live.com', pg_temp.id('org_a') || '/logo-light.png', '#0B5FFF')::text,
  'with white label in force, email wears the brand name, sender name, support address, light logo and accent'
);
select is((select count(*)::int from app.email_brand_for_org(pg_temp.id('org_b'))), 0,
  'an org whose plan has no white label gets no email brand, whatever it saved');
update app.org_brands set email_sender_name = null where org_id = pg_temp.id('org_a');
select is((select sender_name from app.email_brand_for_org(pg_temp.id('org_a'))), 'Northwind',
  'without a sender name the From name is the brand name');
select ok(not has_function_privilege('authenticated', 'app.email_brand_for_org(uuid)', 'execute'),
  'no signed-in person reads an org''s email brand');
select ok(not has_function_privilege('anon', 'app.email_brand_for_org(uuid)', 'execute'), 'nor does anyone signed out');
select ok(has_function_privilege('service_role', 'app.email_brand_for_org(uuid)', 'execute'), 'the notification worker does');

-- Docs site ------------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select count(*)::int from api_public.docs_brand_for_slug('northwind-live')), 0,
  'a Team org with white label has no branded docs site: the docs site is Enterprise');

select pg_temp.as_platform();
update app.subscriptions set plan_code = 'enterprise' where org_id = pg_temp.id('org_a') and subscription_state <> 'canceled';
select pg_temp.as_anon();
select is(
  (select row(name, logo_light_path, logo_dark_path, accent_hex)::text from api_public.docs_brand_for_slug('northwind-live')),
  row('Northwind', pg_temp.id('org_a') || '/logo-light.png', pg_temp.id('org_a') || '/logo-dark.png', '#0B5FFF')::text,
  'on Enterprise, anyone reads the docs brand: name, logos and accent'
);
select is((select count(*)::int from api_public.docs_brand_for_slug('  Northwind-Live ')), 1,
  'the slug is matched trimmed and lowercased');
select is(
  pg_get_function_result('api_public.docs_brand_for_slug(text)'::regprocedure),
  'TABLE(name text, logo_light_path text, logo_dark_path text, accent_hex text)',
  'it returns the public fields only: no org id, slug, sender, support address or legal entity'
);
select is((select count(*)::int from api_public.docs_brand_for_slug('harbor-lights')), 0,
  'an Access org with a saved brand has no branded docs site');
select is((select count(*)::int from api_public.docs_brand_for_slug('no-such-org')), 0,
  'an unknown slug returns nothing, the same answer as an org without one');

select pg_temp.as_platform();
select app.sync_subscription_from_stripe(pg_temp.id('org_b'), 'cus_A138Harbor', 'sub_A138Harbor', 'enterprise', 'Annual', 'active',
  now() + interval '300 days', false);
select pg_temp.as_anon();
select is((select name from api_public.docs_brand_for_slug('harbor-lights')), 'Harbor Lights',
  'an org that moves to Enterprise gets its branded docs site');

select pg_temp.as_platform();
insert into app.plan_overrides (org_id, override_kind, feature_code, feature_enabled, starts_at, expires_at, reason)
values (pg_temp.id('org_b'), 'Feature', 'white_label', false, now() - interval '1 minute', now() + interval '30 days',
  'A138 fixture: white label turned off for this org.');
select pg_temp.as_anon();
select is((select count(*)::int from api_public.docs_brand_for_slug('harbor-lights')), 0,
  'an Enterprise org without white label in force has no branded docs site');
select pg_temp.as_platform();
select is((select count(*)::int from app.email_brand_for_org(pg_temp.id('org_b'))), 0, 'and no branded email');

update app.subscriptions set plan_code = 'team' where org_id = pg_temp.id('org_a') and subscription_state <> 'canceled';
select pg_temp.as_anon();
select is((select count(*)::int from api_public.docs_brand_for_slug('northwind-live')), 0,
  'a downgrade below Enterprise reverts the docs site at once');
select pg_temp.as_platform();
select is((select brand_name from app.email_brand_for_org(pg_temp.id('org_a'))), 'Northwind',
  'while email keeps the brand, since Team keeps white label');

select pg_temp.as_platform();
update app.organizations set deleted_at = now() where id = pg_temp.id('org_b');
select pg_temp.as_anon();
select is((select count(*)::int from api_public.docs_brand_for_slug('harbor-lights')), 0, 'a deleted org has no docs site');

select * from finish();
rollback;
