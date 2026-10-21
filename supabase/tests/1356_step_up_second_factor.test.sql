-- pgTAP: migration 1356 (A79, RRR-124). The org lifecycle's step-up runs A77's check (1333): deleting the org and
-- either side of an ownership transfer need a second factor passed within the last 15 minutes, and an API key never
-- passes.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(6);

-- A session with the given aal and, optionally, a second factor p_second_ago (NULL for none); p_key true for an API key.
create function pg_temp.as_session(p_aal text, p_second_ago interval, p_key boolean default false)
returns void
language plpgsql as $$
declare
  v_amr jsonb := jsonb_build_array(jsonb_build_object('method', case when p_key then 'xos_api_key' else 'password' end,
    'timestamp', extract(epoch from now() - interval '2 hours')::bigint));
begin
  if p_second_ago is not null then
    v_amr := jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - p_second_ago)::bigint)) || v_amr;
  end if;
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'aal', p_aal, 'amr', v_amr,
      'scopes', case when p_key then '["projects.read"]'::jsonb end)::text, true);
end $$;

select ok(pg_get_functiondef('private.require_step_up(text)'::regprocedure) like '%private.require_second_factor(p_action)%',
  'the lifecycle step-up is A77''s check');

select pg_temp.as_session('aal1', null);
select throws_ok($$select private.require_step_up('delete the organization')$$, 'XR001',
  'step_up_required: Confirm it is you with your second factor to delete the organization.',
  'a session without a second factor is refused');

select pg_temp.as_session('aal2', interval '1 minute');
select lives_ok($$select private.require_step_up('delete the organization')$$, 'a second factor a minute old passes');

select pg_temp.as_session('aal2', interval '20 minutes');
select throws_ok($$select private.require_step_up('transfer ownership')$$, 'XR001',
  'step_up_required: Confirm it is you with your second factor to transfer ownership.',
  'one 20 minutes old is not recent enough, where 1351 let any aal2 session through');

select pg_temp.as_session('aal2', interval '1 minute', true);
select throws_ok($$select private.require_step_up('accept ownership')$$, 'XR001',
  'step_up_session_only: accept ownership needs a signed-in session, never an API key.',
  'an API key never passes');

select set_config('role', 'authenticated', true);
select throws_ok($$select private.require_step_up('delete the organization')$$, '42501', null,
  'members cannot call it directly');

select * from finish();
rollback;
