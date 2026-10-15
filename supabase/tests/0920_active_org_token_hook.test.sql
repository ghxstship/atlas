-- pgTAP: the context switcher's active org selection and the custom access token hook that writes the
-- org_id claim (ADR 0007 item 1).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(17);

create function pg_temp.hook(p_key text, p_claims jsonb default '{"role": "authenticated"}') returns jsonb
language sql as $$
  select private.custom_access_token_hook(jsonb_build_object('user_id', pg_temp.id(p_key || '_user'), 'claims', p_claims))
$$;

-- Selection -------------------------------------------------------------------------------------------------
select pg_temp.as_user('mia');
select lives_ok($$select app.set_active_org(pg_temp.id('org_b'))$$, 'a member selects an org she belongs to');
select is((select org_id from app.active_org_selections), pg_temp.id('org_b'), 'she reads her own selection');
select lives_ok($$select app.set_active_org(pg_temp.id('org_a'))$$, 'selecting again replaces the choice');
select is((select count(*)::integer from app.active_org_selections), 1, 'one selection per sign-in');
select throws_ok($$select app.set_active_org(pg_temp.id('org_p'))$$, '42501', 'organization not found',
  'an org without a membership is not found');
select throws_ok($$select app.set_active_org(null)$$, '42501', 'organization not found', 'a null org is not found');
select throws_ok($$insert into app.active_org_selections (user_id, org_id) values (auth.uid(), pg_temp.id('org_p'))$$,
  '42501', null, 'selections are never written directly');

select pg_temp.as_user('dave');
select is((select count(*)::integer from app.active_org_selections), 0, 'another person cannot read the selection');
select pg_temp.as_anon();
select throws_ok($$select app.set_active_org(gen_random_uuid())$$, '42501', null, 'anon cannot select an org');

-- Hook ------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(pg_temp.hook('mia') -> 'claims' ->> 'org_id', pg_temp.id('org_a')::text, 'the hook writes the selected org');
select is(pg_temp.hook('mia') -> 'claims' ->> 'role', 'authenticated', 'the hook keeps the other claims');
select is(pg_temp.hook('dave', '{"org_id": "stale"}') -> 'claims' -> 'org_id', null,
  'without a selection the hook removes any org_id claim');

-- Ending the membership drops the claim at the next refresh (Section 7.5 invariant 3).
update app.memberships set valid_to = now() - interval '1 second', valid_from = now() - interval '1 day'
where id = pg_temp.id('mia@org_a');
select is(pg_temp.hook('mia') -> 'claims' -> 'org_id', null, 'an ended membership no longer reaches the token');
select ok(not private.user_holds_active_membership(pg_temp.id('mia_user'), pg_temp.id('org_a')), 'the membership check sees the end');
select ok(private.user_holds_active_membership(pg_temp.id('mia_user'), pg_temp.id('org_b')), 'other memberships stay active');

-- Privileges --------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'private.custom_access_token_hook(jsonb)', 'execute')
  and not has_function_privilege('anon', 'private.custom_access_token_hook(jsonb)', 'execute'),
  'signed-in and anonymous callers cannot run the hook');
select ok(not exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_auth_admin')
  or has_function_privilege('supabase_auth_admin', 'private.custom_access_token_hook(jsonb)', 'execute'),
  'Supabase Auth can run the hook');

select * from finish();
rollback;
