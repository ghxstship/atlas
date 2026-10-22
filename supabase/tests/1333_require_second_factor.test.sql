-- pgTAP: migration 1333, the one step-up check (A77, RRR-122). private.require_second_factor refuses an API key, a session
-- that never passed a second factor and, by default, one whose second factor is older than 15 minutes; with p_recent false
-- any aal2 session passes. Callers outside the database cannot call it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(10);

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

select has_function('private', 'require_second_factor', array['text', 'boolean'], 'the step-up check exists');
select ok(obj_description('private.require_second_factor(text, boolean)'::regprocedure, 'pg_proc') is not null,
  'and is commented');

select pg_temp.as_session('aal1', null);
select throws_ok($$select private.require_second_factor('delete the organization')$$, 'XR001',
  'step_up_required: Confirm it is you with your second factor to delete the organization.',
  'a session without a second factor is refused, naming the action');
select throws_ok($$select private.require_second_factor('export Restricted columns', false)$$, 'XR001',
  'step_up_required: Confirm it is you with your second factor to export Restricted columns.',
  'with or without recency');

select pg_temp.as_session('aal2', interval '1 minute');
select lives_ok($$select private.require_second_factor('delete the organization')$$, 'a code a minute old passes');

select pg_temp.as_session('aal2', interval '20 minutes');
select throws_ok($$select private.require_second_factor('transfer ownership')$$, 'XR001',
  'step_up_required: Confirm it is you with your second factor to transfer ownership.',
  'a code 20 minutes old is not recent enough by default');
select lives_ok($$select private.require_second_factor('export Restricted columns', false)$$,
  'but the aal2 session still passes when recency is not asked');

select set_config('request.jwt.claims', '', true);
select throws_ok($$select private.require_second_factor('delete the organization', false)$$, 'XR001', null,
  'no session at all is refused');

select pg_temp.as_session('aal2', interval '1 minute', true);
select throws_ok($$select private.require_second_factor('delete the organization')$$, 'XR001',
  'step_up_session_only: delete the organization needs a signed-in session, never an API key.',
  'an API key is refused whatever its claims');

select set_config('role', 'authenticated', true);
select throws_ok($$select private.require_second_factor('delete the organization')$$, '42501', null,
  'members cannot call the check directly');

select * from finish();
rollback;
