-- A22-012: the public API rate limit is counted in Postgres, shared by every server instance, per
-- signed-in caller, with an atomic upsert.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(11);

-- Two API server instances are two sessions calling the same RPC; one database counts for both.
select pg_temp.as_user('alice');
select is((select allowed from app.take_api_rate_limit(3, 60)), true, 'first request in the window is allowed');
select is((select remaining from app.take_api_rate_limit(3, 60)), 1, 'a second instance sees the first instance''s request');
select is((select allowed from app.take_api_rate_limit(3, 60)), true, 'the third request is still within the limit');
select is((select allowed from app.take_api_rate_limit(3, 60)), false, 'the fourth request in the window is refused');
select ok((select reset_seconds from app.take_api_rate_limit(3, 60)) between 1 and 60, 'the decision says when the window resets');

-- Another caller has their own window.
select pg_temp.as_user('bob');
select is((select remaining from app.take_api_rate_limit(3, 60)), 2, 'another caller''s requests do not count against alice');

-- A different window length is its own window.
select pg_temp.as_user('alice');
select is((select remaining from app.take_api_rate_limit(3, 1)), 2, 'a different window length counts separately');

select throws_ok($$select * from app.take_api_rate_limit(0, 60)$$, 'XR001', null, 'a limit below 1 is refused');
select throws_ok($$select * from app.take_api_rate_limit(10, 7200)$$, 'XR001', null, 'a window over an hour is refused');

select pg_temp.as_anon();
select throws_ok($$select * from app.take_api_rate_limit(3, 60)$$, '42501', null, 'anonymous callers cannot call the rate limit RPC');

select pg_temp.as_platform();
select is(
  (select count(*)::integer from private.api_rate_windows w
   where w.caller_hash = extensions.digest(pg_temp.id('alice_user')::text, 'sha256') and w.window_seconds = 60),
  1,
  'one row per caller and window: the count is upserted, never appended');

select * from finish();
rollback;
