-- pgTAP: service-role endpoints for reply addresses and one-click unsubscribe (Section 4.6.5, Section 14.5).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(9);

select pg_temp.as_platform();
select is(app.reply_address_local_part(pg_temp.id('dave'), pg_temp.id('org_a')), private.reply_local_part(pg_temp.id('dave'), pg_temp.id('org_a')),
  'the reply address wrapper returns the signed local part');
select ok(not has_function_privilege('authenticated', 'app.unsubscribe_by_token(text)', 'execute')
  and not has_function_privilege('anon', 'app.unsubscribe_token(uuid, uuid, text)', 'execute'), 'only the service role reaches the endpoints');
select throws_ok($$select app.unsubscribe_token(pg_temp.id('org_a'), pg_temp.id('dave'), 'parties')$$, 'XR001', null, 'tokens name real categories');

create temporary table t as select app.unsubscribe_token(pg_temp.id('org_a'), pg_temp.id('dave'), 'comments') as token;
select is(app.unsubscribe_by_token((select token from t)), 'northwind-live', 'a signed token unsubscribes and names the org for the redirect');
select results_eq($$select address, reason::text, category_code from app.suppression_list$$,
  $$values ('dave@northwind.test'::text, 'Unsubscribe'::text, 'comments'::text)$$, 'the person''s email is suppressed for the category');
select is(app.unsubscribe_by_token((select token from t)), 'northwind-live', 'a repeated click is harmless');
select is((select count(*)::integer from app.suppression_list), 1, 'and adds nothing');
select is(app.unsubscribe_by_token(regexp_replace((select token from t), '.$', 'x')), null, 'a forged token changes nothing');
select is(app.unsubscribe_by_token(replace((select token from t), '.comments.', '.mentions.')), null, 'a token cannot be moved to another category');

select * from finish();
rollback;
