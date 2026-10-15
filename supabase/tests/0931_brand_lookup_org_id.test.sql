-- pgTAP: the public brand lookups return the org id (0931).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(3);

set local role anon;
select is(
  (select org_id from api_public.org_brand_for_slug('demo-productions')),
  '01920000-0000-7000-8000-000000000001'::uuid,
  'the slug lookup returns the demo org id to anon'
);
select is(
  (select count(*)::integer from api_public.org_brand_for_slug('no-such-org')),
  0,
  'an unknown slug returns nothing'
);
select ok(
  has_function_privilege('anon', 'api_public.org_brand_for_host(text)', 'execute'),
  'anon may look up a brand by host'
);

select * from finish();
rollback;
