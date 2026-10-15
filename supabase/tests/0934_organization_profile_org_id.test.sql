-- pgTAP: the public organization profile returns the org id (0934).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(2);

set local role anon;
select is(
  (select org_id from api_public.organization_profile('demo-productions')),
  '01920000-0000-7000-8000-000000000001'::uuid,
  'the demo org''s public profile returns its org id to anon'
);
select is(
  (select count(*)::integer from api_public.organization_profile('no-such-company')),
  0,
  'an unknown handle returns nothing'
);

select * from finish();
rollback;
