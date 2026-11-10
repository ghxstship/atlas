-- pgTAP: migration 904090001 (ADR 0168), the worker schedules on Supabase's secret API keys. private.worker_request
-- sends the Vault key on the apikey header and never as a bearer, sends nothing without the Vault secrets, refuses a
-- name that is not a function's, and is not callable from the API; the four schedules the migrations make go through it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select no_plan();

-- Without the Vault secrets nothing is sent ----------------------------------------------------------------------------
delete from vault.secrets where name in ('xos_functions_url', 'xos_worker_key');
select is(private.worker_request('webhook-dispatch'), null, 'an unconfigured project sends nothing');
select throws_ok($$select private.worker_request('../rest/v1/x')$$, '22023', null, 'a path is not a function name');
select throws_ok($$select private.worker_request(null)$$, '22023', null, 'nor is null');

-- With them, the key goes on the apikey header -------------------------------------------------------------------------
select vault.create_secret('https://functions.example.test/functions/v1/', 'xos_functions_url');
select vault.create_secret('sb_secret_exampleexampleexample', 'xos_worker_key');
select isnt(private.worker_request('webhook-dispatch', 15000), null, 'a configured project queues the request');
select is((select r.url from net.http_request_queue r order by r.id desc limit 1),
  'https://functions.example.test/functions/v1/webhook-dispatch', 'to the function under the functions URL');
select is((select r.headers ->> 'apikey' from net.http_request_queue r order by r.id desc limit 1),
  'sb_secret_exampleexampleexample', 'with the Vault key on the apikey header');
select ok((select not (r.headers ? 'Authorization') from net.http_request_queue r order by r.id desc limit 1),
  'and no Authorization header, which the platform would parse as a JWT');
select is((select r.timeout_milliseconds from net.http_request_queue r order by r.id desc limit 1), 15000, 'with its timeout');

-- The schedules use it --------------------------------------------------------------------------------------------------
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private'
    and p.proname in ('request_fx_feed', 'request_export_render', 'request_guest_email_send', 'request_weather_feed')
    and p.prosrc like '%private.worker_request(%' and p.prosrc not like '%Authorization%'), 4,
  'the exchange rate, export, guest email and weather schedules call it, none with a bearer');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('app', 'private', 'api_public') and p.prosrc like '%name = ''xos_worker_key''%' and p.proname <> 'worker_request'), 0,
  'no other function reads the worker key');

-- Not from the API -----------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'private.worker_request(text, integer)', 'execute'), 'anon cannot call it');
select ok(not has_function_privilege('authenticated', 'private.worker_request(text, integer)', 'execute'), 'nor can a signed-in person');

select * from finish();
rollback;
