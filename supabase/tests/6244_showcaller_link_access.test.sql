-- pgTAP: migration 6244, B3 (RRR-227, ADR 0142). The outside side of showcaller links, the owner's ruling of 2026-11-06
-- that a token and code open nothing without a signed-in person on the project, and the proof that a valid
-- token and grant for running order R1 reach nothing else: every write aimed at a cue of another running order of the
-- same stage (R1B), of another stage (R2), of another project, of another org, or at an id that does not exist answers the same showcaller_link_scope body and
-- changes no cue, department call or audit event; 20 such answers delete the grant; the read answers R1's rows only,
-- never a person or the note. Also: a read-only transaction is refused first, tokens never cross kinds or links, the
-- writes the portal may make (attributed to the link), the field allowlist and stale edits, the device cap, a locked
-- link still serving its devices, the per-cue flags the portal needs (called through a link, an artist's set time), the
-- rate ceilings, and the portal stopping when a column it shows is reclassified, the link expires or signs its devices
-- out, the creator loses membership or either capability, the org turns read-only, or the running order or its project
-- is trashed. P2's own suite (6110) runs unchanged over the cores.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update, delete on k to public;

create function pg_temp.k(p_key text) returns uuid
language sql stable as $$ select id from k where key = p_key $$;
create function pg_temp.val(p_key text) returns text
language sql stable as $$ select val from k where key = p_key $$;

create function pg_temp.link(p_user text, p_key text, p_run text) returns void
language plpgsql as $$
declare v record;
begin
  perform pg_temp.as_user(p_user);
  select * into v from app.create_showcaller_link(pg_temp.id(p_run), 'Sam Okafor', null, 'Night one guest caller') limit 1;
  perform pg_temp.as_platform();
  insert into k values (p_key, v.showcaller_link_id, v.token), (p_key || ':code', null, v.access_code);
end $$;

-- Runs a token RPC as a signed-in person on the project (owner ruling of 2026-11-06), relayed from an address; answers its JSON.
create function pg_temp.anon(p_sql text, p_client text default '198.51.100.7') returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user('alice');
  perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
  execute p_sql into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Opens a link; keeps the grant under p_grant_key on success.
create function pg_temp.open(p_key text, p_code text, p_grant_key text, p_client text default '198.51.100.7') returns text
language plpgsql as $$
declare v jsonb;
begin
  v := pg_temp.anon(format('select api_public.open_showcaller_link(%L, %L, %L)', pg_temp.val(p_key), p_code, p_client), p_client);
  if v ->> 'status' = 'ok' then
    insert into k values (p_grant_key, null, v ->> 'grant') on conflict (key) do update set val = excluded.val;
    return 'ok';
  end if;
  return v ->> 'reason';
end $$;

create function pg_temp.run(p_key text, p_grant_key text) returns jsonb
language sql as $$
  select pg_temp.anon(format('select api_public.showcaller_run(%L, %L, %L)', pg_temp.val(p_key), pg_temp.val(p_grant_key), '198.51.100.7'))
$$;

-- A write: the RPC's name and its arguments after the token, grant and address, as SQL literals.
create function pg_temp.w(p_key text, p_grant_key text, p_fn text, p_args text) returns jsonb
language sql as $$
  select pg_temp.anon(format('select api_public.%s(%L, %L, %L, %s)', p_fn, pg_temp.val(p_key), pg_temp.val(p_grant_key), '198.51.100.7', p_args))
$$;

create function pg_temp.snapshot() returns text
language sql as $$
  select md5(coalesce((select string_agg(concat_ws('|', c.id, c.position, c.label, c.segment, c.description, c.script, c.planned_at,
      c.duration, c.called_at, c.called_by, c.called_via_link_id, c.standby_at, c.deleted_at, c.updated_at), ',' order by c.id) from app.cues c), '')
    || coalesce((select string_agg(concat_ws('|', x.id, x.instruction, x.deleted_at), ',' order by x.id) from app.cue_calls x), '')
    || (select count(*)::text from app.audit_events))
$$;

create function pg_temp.order_of(p_run text) returns text
language sql as $$
  select string_agg(c.label || '@' || c.position, ',' order by c.position)
  from app.cues c where c.run_of_show_id = pg_temp.id(p_run) and c.deleted_at is null
$$;

-- R1 and R2 on NWL, a running order of NWX and one of org_b ---------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night', current_date + 5) returning id)
  insert into world select 'r1', id from x;
insert into app.cues (run_of_show_id, position, label, segment, planned_at, duration) values
  (pg_temp.id('r1'), 1, 'House to Half', 'Act I', now() + interval '5 days', interval '2 minutes'),
  (pg_temp.id('r1'), 2, 'Host Welcome', 'Act I', now() + interval '5 days 2 minutes', interval '5 minutes'),
  (pg_temp.id('r1'), 3, 'Award One', 'Act II', now() + interval '5 days 7 minutes', null),
  (pg_temp.id('r1'), 4, 'Headliner On', 'Act II', now() + interval '5 days 10 minutes', null),
  (pg_temp.id('r1'), 5, 'House Lights Up', null, null, null);
insert into world select 'q' || c.position, c.id from app.cues c where c.run_of_show_id = pg_temp.id('r1');
select app.save_cue_calls(pg_temp.id('q1'), '{"Lighting": "LX 1 GO"}');
select app.set_segment_color(pg_temp.id('r1'), 'Act II', 'cat-6');
-- R1B: the same stage on another show date. R2: another stage of the same project.
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Closing Night', current_date + 8) returning id)
  insert into world select 'r1b', id from x;
insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('r1b'), 1, 'R1B Doors');
insert into world select 'r1bq1', c.id from app.cues c where c.run_of_show_id = pg_temp.id('r1b');
select pg_temp.as_platform();
insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name)
values (pg_temp.id('prj_a'), pg_temp.id('root_a'), 'Show', 'NWL-E02', 'Second Stage');
insert into world select 'stage_2', n.id from app.scope_nodes n where n.project_id = pg_temp.id('prj_a') and n.scope_code = 'NWL-E02';
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('stage_2'), 'Second Night', current_date + 6) returning id)
  insert into world select 'r2', id from x;
insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('r2'), 1, 'R2 Doors');
insert into world select 'r2q1', c.id from app.cues c where c.run_of_show_id = pg_temp.id('r2');
select pg_temp.as_user('alice');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a2'), 'Gala', current_date + 9) returning id)
  insert into world select 'r3', id from x;
insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('r3'), 1, 'Gala Doors');
insert into world select 'r3q1', c.id from app.cues c where c.run_of_show_id = pg_temp.id('r3');
select pg_temp.as_user('xavier');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_b'), 'Pier Night', current_date + 7) returning id)
  insert into world select 'r4', id from x;
insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('r4'), 1, 'Pier Doors');
insert into world select 'r4q1', c.id from app.cues c where c.run_of_show_id = pg_temp.id('r4');
select pg_temp.as_platform();

-- A Showcaller field and a Crew-only field on the cues.
select pg_temp.as_user('alice');
with d as (insert into app.custom_field_definitions (org_id, target_table, field_key, label, data_type, sort_order)
  values (pg_temp.id('org_a'), 'app.cues', 'camera', 'Camera', 'Text', 1), (pg_temp.id('org_a'), 'app.cues', 'crew_only', 'Crew only', 'Text', 2)
  returning id, field_key)
  insert into k select 'f:' || field_key, id, null from d;
insert into app.cue_field_audiences (custom_field_definition_id, audience) values (pg_temp.k('f:camera'), 'Showcaller');
select pg_temp.as_user('dave');
insert into app.custom_field_values (custom_field_definition_id, target_id, value_text) values
  (pg_temp.k('f:camera'), pg_temp.id('q1'), 'Cam 2 wide'), (pg_temp.k('f:crew_only'), pg_temp.id('q1'), 'Payroll note');
select pg_temp.as_platform();

select pg_temp.link('dave', 'l1', 'r1');
select pg_temp.link('dave', 'l2', 'r2');
select pg_temp.link('dave', 'l3', 'r1');
select pg_temp.link('carol', 'l4', 'r1');
select pg_temp.link('alice', 'l5', 'r3');

-- Owner ruling of 2026-11-06: a token and code alone open nothing --------------------------------------------------------
select pg_temp.link('dave', 'p1', 'r1');
insert into k values ('p1:good', null, pg_temp.anon(format('select api_public.open_showcaller_link(%L, %L, null)', pg_temp.val('p1'), pg_temp.val('p1:code'))) ->> 'grant');
select ok(pg_temp.val('p1:good') like 'xcgr_%', 'a person on the project opens the link with its code');

-- No session: anon holds no grant on any of them, and the database refuses a call with no person.
select is_empty($$
  select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api_public' and (p.proname = 'open_showcaller_link' or p.proname like 'showcaller\_%')
    and p.proname <> 'showcaller_channel_open' and has_function_privilege('anon', p.oid, 'execute')
$$, 'no session: anon executes no showcaller read or write RPC');
select pg_temp.as_anon();
select throws_ok(format('select api_public.open_showcaller_link(%L, %L, null)', pg_temp.val('p1'), pg_temp.val('p1:code')), '42501', null, 'no session: the token and the right code open nothing');
select throws_ok(format('select api_public.showcaller_run(%L, %L, null)', pg_temp.val('p1'), pg_temp.val('p1:good')), '42501', null, 'no session: the token and a grant read nothing');
select throws_ok(format('select api_public.showcaller_call_cue(%L, %L, null, %L)', pg_temp.val('p1'), pg_temp.val('p1:good'), pg_temp.id('q5')), '42501', null, 'no session: the token and a grant write nothing');
select pg_temp.as_platform();
select is(api_public.open_showcaller_link(pg_temp.val('p1'), pg_temp.val('p1:code'), null) ->> 'reason', 'showcaller_link_sign_in', 'with no person the open itself refuses');
select is(api_public.showcaller_run(pg_temp.val('p1'), pg_temp.val('p1:good'), null) ->> 'reason', 'showcaller_link_sign_in', 'and so does the read');
select is(api_public.showcaller_call_cue(pg_temp.val('p1'), pg_temp.val('p1:good'), null, pg_temp.id('q5')) ->> 'reason', 'showcaller_link_sign_in', 'and a write');

-- A signed-in person off the project: quinn is engaged only on another org's project.
create function pg_temp.as_person(p_user text, p_sql text) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_user);
  execute p_sql into v;
  perform pg_temp.as_platform();
  return v;
end $$;
select is(pg_temp.as_person('quinn', format('select api_public.open_showcaller_link(%L, %L, null)', pg_temp.val('p1'), pg_temp.val('p1:code'))) ->> 'reason', 'showcaller_link_not_on_project', 'off the project: the right code opens nothing');
select is(pg_temp.as_person('quinn', format('select api_public.open_showcaller_link(%L, %L, null)', pg_temp.val('p1'), '000000')) ->> 'reason', 'showcaller_link_not_on_project', 'and a wrong code gets the same answer');
select is((select failed_attempts::int from app.showcaller_links where id = pg_temp.k('p1')), 0, 'without using up an attempt');
select is(pg_temp.as_person('quinn', format('select api_public.showcaller_run(%L, %L, null)', pg_temp.val('p1'), pg_temp.val('p1:good'))) ->> 'reason', 'showcaller_link_not_on_project', 'off the project: a valid grant reads nothing');
select is(pg_temp.as_person('quinn', format('select api_public.showcaller_call_cue(%L, %L, null, %L)', pg_temp.val('p1'), pg_temp.val('p1:good'), pg_temp.id('q5'))) ->> 'reason', 'showcaller_link_not_on_project', 'and writes nothing');
select ok((select called_at is null from app.cues where id = pg_temp.id('q5')), 'the cue is not called');

-- Invitation and onboarding, then the route: ivy is engaged on the project, and it opens once the engagement is Active.
select is(pg_temp.as_person('ivy', format('select api_public.open_showcaller_link(%L, %L, null)', pg_temp.val('p1'), pg_temp.val('p1:code'))) ->> 'reason', 'showcaller_link_not_on_project', 'a person still onboarding is not yet on the project');
set local session_replication_role = replica;
update app.engagements set engagement_state = 'Active' where id = pg_temp.id('eng_ivy_a');
set local session_replication_role = origin;
select is(pg_temp.as_person('ivy', format('select api_public.open_showcaller_link(%L, %L, null)', pg_temp.val('p1'), pg_temp.val('p1:code'))) ->> 'status', 'ok', 'once Active, a person with no membership opens it with the code');
select is(pg_temp.as_person('ivy', format('select api_public.showcaller_run(%L, %L, null)', pg_temp.val('p1'), pg_temp.val('p1:good'))) ->> 'status', 'ok', 'reads');
select is(pg_temp.as_person('ivy', format('select api_public.showcaller_call_cue(%L, %L, null, %L)', pg_temp.val('p1'), pg_temp.val('p1:good'), pg_temp.id('q5'))) ->> 'status', 'ok', 'and writes');
select ok((select called_via_link_id = pg_temp.k('p1') from app.cues where id = pg_temp.id('q5')), 'and the call still reads through the link');
select is(pg_temp.as_person('ivy', format('select api_public.open_showcaller_link(%L, null, null)', pg_temp.val('p1'))) ->> 'reason', 'showcaller_link_access_code_required', 'the code is still required');
set local session_replication_role = replica;
update app.engagements set engagement_state = 'Blocked' where id = pg_temp.id('eng_ivy_a');
set local session_replication_role = origin;
select is(pg_temp.as_person('ivy', format('select api_public.showcaller_run(%L, %L, null)', pg_temp.val('p1'), pg_temp.val('p1:good'))) ->> 'reason', 'showcaller_link_not_on_project', 'and an engagement that stops being Active stops its grant at once');
create function pg_temp.end_project(p_id uuid, p_state text) returns void language plpgsql as $f$
begin
  perform set_config('t.state', (select project_state::text from app.projects where id = p_id), true);
  set local session_replication_role = replica;
  update app.projects set project_state = p_state::app.project_state where id = p_id;
  set local session_replication_role = origin;
end $f$;
create function pg_temp.reopen_project(p_id uuid) returns void language plpgsql as $f$
begin
  set local session_replication_role = replica;
  update app.projects set project_state = current_setting('t.state')::app.project_state, archived_at = null, deleted_at = null where id = p_id;
  set local session_replication_role = origin;
end $f$;
select pg_temp.end_project(pg_temp.id('prj_a'), 'Complete');
select is(pg_temp.anon(format('select api_public.open_showcaller_link(%L, %L, null)', pg_temp.val('p1'), pg_temp.val('p1:code'))) ->> 'reason', 'showcaller_link_ended', 'a showcaller link stops opening when its project ends');
select is(pg_temp.anon(format('select api_public.showcaller_run(%L, %L, null)', pg_temp.val('p1'), pg_temp.val('p1:good'))) ->> 'reason', 'showcaller_link_ended', 'and its grant reads nothing');
select pg_temp.reopen_project(pg_temp.id('prj_a'));
select pg_temp.as_user('dave');
select app.revoke_showcaller_link(pg_temp.k('p1'));
select pg_temp.as_platform();
-- The suite below starts from an uncalled cue.
set local session_replication_role = replica;
update app.cues set called_at = null, called_by = null, called_via_link_id = null where id = pg_temp.id('q5');
set local session_replication_role = origin;

-- A read-only (GET) transaction is refused before anything ------------------------------------------------------------------------
create function pg_temp.read_only_open() returns text
language plpgsql as $$
begin
  perform pg_temp.as_user('alice');
  begin
    perform set_config('transaction_read_only', 'on', true);
    perform api_public.showcaller_run(pg_temp.val('l1'), 'xcgr_' || repeat('0', 64), null);
  exception when others then
    perform set_config('transaction_read_only', 'off', true);
    perform pg_temp.as_platform();
    return sqlstate;
  end;
  perform set_config('transaction_read_only', 'off', true);
  perform pg_temp.as_platform();
  return 'ran';
end $$;
select is(pg_temp.read_only_open(), '25006', 'a read-only (GET) call is refused before any lookup');

-- Opening ---------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.open('l1', null, 'g1'), 'showcaller_link_access_code_required', 'opening asks for the access code');
select is(pg_temp.open('l1', case when pg_temp.val('l1:code') = '000000' then '000001' else '000000' end, 'g1'), 'showcaller_link_access_code',
  'a wrong code is refused');
select is(pg_temp.open('l1', pg_temp.val('l1:code'), 'g1'), 'ok', 'the correct code opens the link');
select matches(pg_temp.val('g1'), '^xcgr_[0-9a-f]{64}$', 'and earns a device grant');
select ok((select expires_at <= now() + interval '48 hours' from private.showcaller_link_grants
  where grant_hash = private.share_token_hash(pg_temp.val('g1'))), 'that lasts at most 48 hours');
select is(pg_temp.open('l2', pg_temp.val('l2:code'), 'g_l2'), 'ok', 'another link opens with its own code');

-- Tokens never cross kinds or links ----------------------------------------------------------------------------------------------
select is(pg_temp.anon(format('select api_public.showcaller_run(%L, %L, null)', 'xshv_' || repeat('a', 64), pg_temp.val('g1'))) ->> 'reason',
  'showcaller_link_invalid', 'a saved view token reads no running order');
select is(pg_temp.anon(format('select api_public.showcaller_run(%L, %L, null)', 'xscr_' || repeat('a', 64), pg_temp.val('g1'))) ->> 'reason',
  'showcaller_link_invalid', 'nor a display screen token');
select is(pg_temp.anon(format('select api_public.showcaller_call_cue(%L, %L, null, %L)', 'xscr_' || repeat('a', 64), pg_temp.val('g1'), pg_temp.id('q1'))) ->> 'reason',
  'showcaller_link_invalid', 'and calls no cue');
select is(pg_temp.anon(format('select api_public.open_live_link(%L, %L, null)', pg_temp.val('l1'), pg_temp.val('l1:code'))) ->> 'reason',
  'live_link_invalid', 'a showcaller token opens no live link');
select is(pg_temp.anon(format('select api_public.live_display(%L, %L, null)', pg_temp.val('l1'), pg_temp.val('g1'))) ->> 'reason',
  'live_link_invalid', 'nor reads a display screen');
select is(pg_temp.anon(format('select api_public.live_view(%L, %L, null)', pg_temp.val('l1'), pg_temp.val('g1'))) ->> 'reason',
  'live_link_invalid', 'nor a saved view');
select is(pg_temp.anon(format('select api_public.showcaller_run(%L, %L, null)', pg_temp.val('l1'), pg_temp.val('g_l2'))) ->> 'reason',
  'showcaller_link_grant', 'link B''s grant with link A''s token reads nothing');
select is(pg_temp.w('l1', 'g_l2', 'showcaller_call_cue', quote_literal(pg_temp.id('q1'))) ->> 'reason',
  'showcaller_link_grant', 'and writes nothing');

-- Reading R1 ------------------------------------------------------------------------------------------------------------------------
insert into k values ('read', null, pg_temp.run('l1', 'g1')::text);
select is((pg_temp.val('read')::jsonb) ->> 'status', 'ok', 'the grant reads the running order');
select is((select array_agg((e ->> 'id')::uuid order by (e ->> 'position')::int) from jsonb_array_elements((pg_temp.val('read')::jsonb) -> 'cues') e),
  (select array_agg(id order by position) from app.cues where run_of_show_id = pg_temp.id('r1') and deleted_at is null),
  'its cues are exactly R1''s live cues, in order');
select is((pg_temp.val('read')::jsonb) -> 'meta' ->> 'stage', 'Opening Night', 'the heading names the stage');
select is((pg_temp.val('read')::jsonb) -> 'meta' ->> 'caller_name', 'Sam Okafor', 'and the caller');
select is((select e ->> 'segment_color' from jsonb_array_elements((pg_temp.val('read')::jsonb) -> 'cues') e where e ->> 'label' = 'Award One'),
  'cat-6', 'cues carry their segment''s color');
select is((select e -> 'calls' from jsonb_array_elements((pg_temp.val('read')::jsonb) -> 'cues') e where e ->> 'label' = 'House to Half'),
  '[{"kind": "Lighting", "instruction": "LX 1 GO"}]'::jsonb, 'and their department calls');
select is((select jsonb_array_length(e -> 'fields') from jsonb_array_elements((pg_temp.val('read')::jsonb) -> 'cues') e where e ->> 'label' = 'House to Half'),
  1, 'and only the Showcaller-audience custom values');
select ok(strpos(pg_temp.val('read'), 'Payroll note') = 0, 'never a Crew-only value');
select ok(strpos(pg_temp.val('read'), pg_temp.id('dave')::text) = 0 and strpos(pg_temp.val('read'), 'Lindqvist') = 0,
  'never a person''s id or name');
select ok(strpos(pg_temp.val('read'), 'Night one guest caller') = 0, 'never the link''s note');
select ok(strpos(pg_temp.val('read'), pg_temp.id('r2q1')::text) = 0 and strpos(pg_temp.val('read'), 'R2 Doors') = 0,
  'never another running order''s cue');
select ok((pg_temp.val('read')::jsonb) ->> 'channel' ~ '^xcall:xcch_[0-9a-f]{64}$', 'and hands over its Realtime channel');

-- What the portal may write -------------------------------------------------------------------------------------------------------
select is(pg_temp.w('l1', 'g1', 'showcaller_standby_cue', quote_literal(pg_temp.id('q1'))) ->> 'status', 'ok', 'the showcaller stands by a cue');
select ok((select standby_at is not null from app.cues where id = pg_temp.id('q1')), 'which is on standby');
select is(pg_temp.w('l1', 'g1', 'showcaller_standby_cue', 'null') ->> 'status', 'ok', 'and clears the standby');
select is(pg_temp.w('l1', 'g1', 'showcaller_call_cue', quote_literal(pg_temp.id('q1'))) ->> 'status', 'ok', 'calls a cue');
select results_eq(format('select called_by is null, called_via_link_id = %L from app.cues where id = %L', pg_temp.k('l1'), pg_temp.id('q1')),
  $$values (true, true)$$, 'attributed to the link, with no person');
select is(pg_temp.w('l1', 'g1', 'showcaller_call_cue', quote_literal(pg_temp.id('q1'))) ->> 'reason', 'cue_already_called', 'once');
select is(pg_temp.w('l1', 'g1', 'showcaller_shift_plan', '60') ->> 'moved', '3', 'nudges the remaining plan');
select is(pg_temp.w('l1', 'g1', 'showcaller_shift_plan', '3601') ->> 'reason', 'cue_shift_range', 'by up to an hour');
select is(pg_temp.w('l1', 'g1', 'showcaller_move_cue', format('%L, 3', pg_temp.id('q4'))) ->> 'position', '3', 'moves a cue');
select is(pg_temp.order_of('r1'), 'House to Half@1,Host Welcome@2,Headliner On@3,Award One@4,House Lights Up@5', 'renumbering the run');
select is(pg_temp.w('l1', 'g1', 'showcaller_move_cue', format('%L, 1', pg_temp.id('q4'))) ->> 'reason', 'cue_move_before_called',
  'never before the last called cue');
select is(pg_temp.w('l1', 'g1', 'showcaller_save_cue', $$null, '{"label": "Encore", "duration_seconds": 300, "script": "Thank you, goodnight."}'$$) ->> 'status',
  'ok', 'adds a cue');
select is(pg_temp.order_of('r1'), 'House to Half@1,Host Welcome@2,Headliner On@3,Award One@4,House Lights Up@5,Encore@6', 'at the end');
select is(pg_temp.w('l1', 'g1', 'showcaller_save_cue', format($$%L, '{"label": "Award One (Gold)"}', %L$$, pg_temp.id('q3'),
  (select updated_at from app.cues where id = pg_temp.id('q3')))) ->> 'status', 'ok', 'edits a cue');
select is((select label from app.cues where id = pg_temp.id('q3')), 'Award One (Gold)', 'which reads the new label');
select is(pg_temp.w('l1', 'g1', 'showcaller_save_cue', format($$%L, '{"label": "Stale"}', %L$$, pg_temp.id('q3'), now() - interval '1 day')) ->> 'reason',
  'showcaller_cue_changed', 'an edit of a cue that changed since it was read is refused');
select is(pg_temp.w('l1', 'g1', 'showcaller_save_cue', format($$%L, '{"called_at": "2027-01-01T00:00:00Z"}', %L$$, pg_temp.id('q3'),
  (select updated_at from app.cues where id = pg_temp.id('q3')))) ->> 'reason', 'showcaller_cue_field', 'a field outside the allowlist is refused');
select is(pg_temp.w('l1', 'g1', 'showcaller_save_cue', format($$%L, '{"segment_color": "cat-1"}', %L$$, pg_temp.id('q3'),
  (select updated_at from app.cues where id = pg_temp.id('q3')))) ->> 'reason', 'showcaller_cue_field', 'the segment color is a member''s');
select is(pg_temp.w('l1', 'g1', 'showcaller_save_cue', format($$%L, '{"duration_seconds": 90000}', %L$$, pg_temp.id('q3'),
  (select updated_at from app.cues where id = pg_temp.id('q3')))) ->> 'reason', 'showcaller_cue_field', 'and so is a bad value');
select is(pg_temp.w('l1', 'g1', 'showcaller_save_cue', format($$%L, '{"planned_at": "not a time"}', %L$$, pg_temp.id('q3'),
  (select updated_at from app.cues where id = pg_temp.id('q3')))) ->> 'reason', 'showcaller_cue_field', 'or a time that does not parse');
select is(pg_temp.w('l1', 'g1', 'showcaller_save_cue', format($$%L, '{"label": "Recalled"}', %L$$, pg_temp.id('q1'),
  (select updated_at from app.cues where id = pg_temp.id('q1')))) ->> 'reason', 'showcaller_cue_called', 'a called cue is not edited');
select is(pg_temp.w('l1', 'g1', 'showcaller_save_cue_calls', format($$%L, '{"Video": "Roll VT 2"}'$$, pg_temp.id('q2'))) ->> 'status', 'ok',
  'saves department calls');
select is((select instruction from app.cue_calls where cue_id = pg_temp.id('q2') and call_kind = 'Video' and deleted_at is null), 'Roll VT 2',
  'which the crew reads');
select is(pg_temp.w('l1', 'g1', 'showcaller_save_cue_calls', format($$%L, '{"Pyro": "Gerbs"}'$$, pg_temp.id('q2'))) ->> 'reason', 'cue_call_kind',
  'only to the five departments');
insert into app.engagement_cues (engagement_id, cue_id) values (pg_temp.id('eng_art_a'), pg_temp.id('q4'));
select is(pg_temp.w('l1', 'g1', 'showcaller_remove_cue', quote_literal(pg_temp.id('q4'))) ->> 'reason', 'showcaller_cue_linked',
  'never removes an artist''s set time');
select is(pg_temp.w('l1', 'g1', 'showcaller_remove_cue', quote_literal(pg_temp.id('q5'))) ->> 'status', 'ok', 'removes an uncalled cue');
select ok((select deleted_at is not null from app.cues where id = pg_temp.id('q5')), 'as a soft delete');
select is(pg_temp.w('l1', 'g1', 'showcaller_remove_cue', quote_literal(pg_temp.id('q1'))) ->> 'reason', 'showcaller_cue_called', 'never a called cue');
select is((select count(*)::int from app.audit_events where action = 'showcaller_link.write' and diff ->> 'link_id' = pg_temp.k('l1')::text), 9,
  'each write made adds one showcaller_link.write audit event');
select is((select array_agg(distinct k order by k) from app.audit_events a cross join lateral jsonb_object_keys(a.diff) k
  where a.action = 'showcaller_link.write'), array['cue_id', 'link_id', 'operation'], 'naming the link, the operation and the cue, nothing more');
select pg_temp.as_user('dave');
select app.call_cue(pg_temp.id('q2'));
select pg_temp.as_platform();
select results_eq(format('select called_by = %L, called_via_link_id is null from app.cues where id = %L', pg_temp.id('dave'), pg_temp.id('q2')),
  $$values (true, true)$$, 'a signed-in call still names the person');

-- A nudge moves a linked set time and leaves its link -------------------------------------------------------------------------
insert into k values ('q4_planned', null, (select planned_at::text from app.cues where id = pg_temp.id('q4')));
insert into k select 'q4_link', ec.id, null from app.engagement_cues ec where ec.cue_id = pg_temp.id('q4');
select is(pg_temp.w('l1', 'g1', 'showcaller_shift_plan', '60') ->> 'status', 'ok', 'a nudge on a late show');
select is((select planned_at from app.cues where id = pg_temp.id('q4')), pg_temp.val('q4_planned')::timestamptz + interval '60 seconds',
  'moves a cue linked to an artist''s set, so the artist reads the new time');
select results_eq(format('select id, engagement_id from app.engagement_cues where cue_id = %L', pg_temp.id('q4')),
  format('values (%L::uuid, %L::uuid)', pg_temp.k('q4_link'), pg_temp.id('eng_art_a')), 'and its set-time link stays as it was');
select is((select deleted_at from app.cues where id = pg_temp.id('q4')), null::timestamptz, 'and so does the cue');

-- The per-cue flags the portal needs: called through a link, and an artist's set time ---------------------------------------------
insert into k values ('read2', null, pg_temp.run('l1', 'g1')::text);
create function pg_temp.cue_of(p_label text) returns jsonb
language sql as $$
  select e from jsonb_array_elements((pg_temp.val('read2')::jsonb) -> 'cues') e where e ->> 'label' = p_label
$$;
select results_eq($$select (pg_temp.cue_of('House to Half') ->> 'called_via_link')::boolean, (pg_temp.cue_of('Host Welcome') ->> 'called_via_link')::boolean,
    (pg_temp.cue_of('Host Welcome') ->> 'called')::boolean$$,
  $$values (true, false, true)$$, 'a cue says whether it was called through a link, not by a member');
select results_eq($$select (pg_temp.cue_of('Headliner On') ->> 'set_time')::boolean, (pg_temp.cue_of('Award One (Gold)') ->> 'set_time')::boolean$$,
  $$values (true, false)$$, 'and whether it is an artist''s set time, so the portal disables Remove');
select ok(strpos(pg_temp.val('read2'), pg_temp.k('l1')::text) = 0, 'never which link called it');
select ok(strpos(pg_temp.val('read2'), pg_temp.id('dave')::text) = 0 and strpos(pg_temp.val('read2'), 'Lindqvist') = 0,
  'nor any person''s id or name, a member''s call included');

-- Reclassifying any column the portal shows stops it --------------------------------------------------------------------------------
insert into private.column_classifications (table_name, column_name, classification) values ('app.custom_field_values', 'value_text', 'Confidential');
select is(pg_temp.run('l1', 'g1') ->> 'reason', 'showcaller_link_reclassified', 'a custom value classified above Internal stops the portal');
select is(pg_temp.w('l1', 'g1', 'showcaller_standby_cue', 'null') ->> 'reason', 'showcaller_link_reclassified', 'its writes too');
delete from private.column_classifications where table_name = 'app.custom_field_values' and column_name = 'value_text';
insert into private.column_classifications (table_name, column_name, classification) values ('app.cues', 'script', 'Confidential');
select is(pg_temp.run('l1', 'g1') ->> 'reason', 'showcaller_link_reclassified', 'as does a cue column');
delete from private.column_classifications where table_name = 'app.cues' and column_name = 'script';
select is(pg_temp.run('l1', 'g1') ->> 'status', 'ok', 'and the portal reads again once the classification is back');

-- Scope: nothing outside R1 -------------------------------------------------------------------------------------------------------
select is(pg_temp.open('l1', pg_temp.val('l1:code'), 'g2'), 'ok', 'a second device');
create temporary table scope_answers (n serial, body jsonb);
grant select, insert on scope_answers to public;
grant usage on sequence scope_answers_n_seq to public;
insert into k values ('before', null, pg_temp.snapshot());
create function pg_temp.scope_round(p_grant text, p_ops text[]) returns void
language plpgsql as $$
declare
  v_target text;
  v_op text;
  v_args text;
begin
  foreach v_op in array p_ops loop
    foreach v_target in array array[pg_temp.id('r1bq1')::text, pg_temp.id('r2q1')::text, pg_temp.id('r3q1')::text, pg_temp.id('r4q1')::text,
        gen_random_uuid()::text] loop
      v_args := case v_op
        when 'showcaller_move_cue' then format('%L, 1', v_target)
        when 'showcaller_save_cue' then format($a$%L, '{"label": "Hijack"}', now()$a$, v_target)
        when 'showcaller_save_cue_calls' then format($a$%L, '{"Audio": "Hijack"}'$a$, v_target)
        else quote_literal(v_target) end;
      insert into scope_answers (body) values (pg_temp.w('l1', p_grant, v_op, v_args));
    end loop;
  end loop;
end $$;
select pg_temp.scope_round('g1', array['showcaller_call_cue', 'showcaller_standby_cue', 'showcaller_move_cue']);
select pg_temp.scope_round('g2', array['showcaller_save_cue', 'showcaller_remove_cue', 'showcaller_save_cue_calls']);
select is((select count(*)::int from scope_answers), 30,
  'every write was aimed at a cue of another running order of the stage, another stage, another project, another org and a random id');
select is((select array_agg(distinct body::text) from scope_answers), array['{"reason": "showcaller_link_scope", "status": "refused"}'],
  'and every one answered the same showcaller_link_scope body');
select is(pg_temp.snapshot(), pg_temp.val('before'), 'no cue, department call or audit event changed anywhere');
select is((select label from app.cues where id = pg_temp.id('r1bq1')), 'R1B Doors', 'the same stage''s other night is untouched');
select is((select label from app.cues where id = pg_temp.id('r2q1')), 'R2 Doors', 'R2''s cue is untouched');
select is((select called_at from app.cues where id = pg_temp.id('r4q1')), null::timestamptz, 'and another org''s cue was not called');

select is(pg_temp.open('l1', pg_temp.val('l1:code'), 'g3'), 'ok', 'a third device');
create function pg_temp.probe(p_times integer) returns void
language plpgsql as $$
begin
  for i in 1 .. p_times loop
    perform pg_temp.w('l1', 'g3', 'showcaller_call_cue', quote_literal(gen_random_uuid()));
  end loop;
end $$;
select pg_temp.probe(19);
select is(pg_temp.run('l1', 'g3') ->> 'status', 'ok', '19 out-of-scope writes leave the grant');
select pg_temp.probe(1);
select is(pg_temp.run('l1', 'g3') ->> 'reason', 'showcaller_link_grant', 'the 20th in 10 minutes deletes it');
select is(pg_temp.run('l1', 'g1') ->> 'status', 'ok', 'while the other devices keep reading');

-- Devices and locking ----------------------------------------------------------------------------------------------------------
select is(pg_temp.open('l3', pg_temp.val('l3:code'), 'd1'), 'ok', 'device 1');
select is(pg_temp.open('l3', pg_temp.val('l3:code'), 'd2'), 'ok', 'device 2');
select is(pg_temp.open('l3', pg_temp.val('l3:code'), 'd3'), 'ok', 'device 3');
select is(pg_temp.open('l3', pg_temp.val('l3:code'), 'd4'), 'ok', 'device 4');
select is(pg_temp.open('l3', pg_temp.val('l3:code'), 'd5'), 'ok', 'device 5');
select is(pg_temp.open('l3', pg_temp.val('l3:code'), 'd6'), 'showcaller_link_devices', 'a sixth device is refused');
select pg_temp.as_user('dave');
select is(app.showcaller_link_devices(pg_temp.k('l3')), 5, 'and the list counts five');
select pg_temp.as_platform();
create function pg_temp.wrong(p_times integer) returns void
language plpgsql as $$
begin
  for i in 1 .. p_times loop
    perform pg_temp.open('l3', case when pg_temp.val('l3:code') = '000000' then '000001' else '000000' end, 'x', '198.51.100.' || (60 + i));
  end loop;
end $$;
select pg_temp.wrong(5);
select is((select link_state from app.showcaller_link_states where id = pg_temp.k('l3')), 'Locked', '5 wrong codes lock the link');
select is(pg_temp.open('l3', pg_temp.val('l3:code'), 'd7', '198.51.100.90'), 'showcaller_link_locked', 'and the right code no longer opens it');
select is(pg_temp.anon(format('select api_public.showcaller_run(%L, %L, null)', pg_temp.val('l3'), pg_temp.val('d1'))) ->> 'status', 'ok',
  'but a device that proved the code keeps reading');

-- Regenerating and revoking --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into k select 'l3:new', null, r.token from app.regenerate_showcaller_link(pg_temp.k('l3')) r;
select pg_temp.as_platform();
insert into k values ('failures', null, (select count(*) from private.rate_limit_events where bucket = 'live_link.failure')::text);
select is(pg_temp.anon(format('select api_public.showcaller_run(%L, %L, null)', pg_temp.val('l3'), pg_temp.val('d1'))) ->> 'reason',
  'showcaller_link_invalid', 'a regenerated token reads nothing');
select is((select count(*) from private.rate_limit_events where bucket = 'live_link.failure')::text, pg_temp.val('failures'),
  'without counting a failure against the address');
select is(pg_temp.anon(format('select api_public.showcaller_run(%L, %L, null)', 'xscl_' || repeat('e', 64), pg_temp.val('d1'))) ->> 'reason',
  'showcaller_link_invalid', 'an unknown token reads nothing');
select is((select count(*) from private.rate_limit_events where bucket = 'live_link.failure')::text, (pg_temp.val('failures')::int + 1)::text,
  'and does count as a failure');

-- A fourth night, for what stops one link and leaves the others ---------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Fourth Night', current_date + 10) returning id)
  insert into world select 'r5', id from x;
insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('r5'), 1, 'R5 Doors'), (pg_temp.id('r5'), 2, 'R5 Curtain');
insert into world select 'r5q' || c.position, c.id from app.cues c where c.run_of_show_id = pg_temp.id('r5');
select pg_temp.as_platform();

-- Expiry: the next read and the next write stop.
select pg_temp.link('dave', 'lx', 'r5');
select is(pg_temp.open('lx', pg_temp.val('lx:code'), 'g_x'), 'ok', 'a link to the fourth night opens');
select is(pg_temp.run('lx', 'g_x') ->> 'status', 'ok', 'and reads');
select private.begin_trusted_operation('showcaller_link_service');
update app.showcaller_links set expires_at = now() - interval '1 minute' where id = pg_temp.k('lx');
select private.end_trusted_operation('showcaller_link_service');
select is(pg_temp.run('lx', 'g_x') ->> 'reason', 'showcaller_link_expired', 'past its expiry the portal reads nothing');
select is(pg_temp.w('lx', 'g_x', 'showcaller_standby_cue', quote_literal(pg_temp.id('r5q1'))) ->> 'reason', 'showcaller_link_expired', 'and writes nothing');
select is((select standby_at from app.cues where id = pg_temp.id('r5q1')), null::timestamptz, 'the cue is unchanged');

-- Signing devices out: the next read and the next write stop, and the code opens it again.
select pg_temp.link('dave', 'ls', 'r5');
select is(pg_temp.open('ls', pg_temp.val('ls:code'), 'g_s'), 'ok', 'a device on another link');
select is(pg_temp.run('ls', 'g_s') ->> 'status', 'ok', 'reads');
select pg_temp.as_user('dave');
select is(app.sign_out_showcaller_devices(pg_temp.k('ls')), 1, 'until the creator signs it out');
select pg_temp.as_platform();
select is(pg_temp.run('ls', 'g_s') ->> 'reason', 'showcaller_link_grant', 'then its next read is refused');
select is(pg_temp.w('ls', 'g_s', 'showcaller_standby_cue', quote_literal(pg_temp.id('r5q1'))) ->> 'reason', 'showcaller_link_grant', 'and its next write');

-- The creator's access, each part alone. gina is a viewer: only these grants let her make the link.
select pg_temp.as_user('alice');
insert into app.user_capability_grants (membership_id, capability_code, scope_kind, scope_id, reason) values
  (pg_temp.id('gina@org_a'), 'show.run_of_show.read', 'project', pg_temp.id('prj_a'), 'Guest calling.'),
  (pg_temp.id('gina@org_a'), 'show.run_of_show.write', 'project', pg_temp.id('prj_a'), 'Guest calling.'),
  (pg_temp.id('gina@org_a'), 'show.cue.call', 'project', pg_temp.id('prj_a'), 'Guest calling.');
select pg_temp.as_platform();
select pg_temp.link('gina', 'lg', 'r5');
select is(pg_temp.open('lg', pg_temp.val('lg:code'), 'g_g'), 'ok', 'gina''s link opens');
select is(pg_temp.run('lg', 'g_g') ->> 'status', 'ok', 'and reads while she holds both capabilities');
create function pg_temp.set_gina_capability(p_capability text, p_held boolean) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user('alice');
  update app.user_capability_grants set deleted_at = case when p_held then null else now() end
  where membership_id = pg_temp.id('gina@org_a') and capability_code = p_capability and scope_id = pg_temp.id('prj_a');
  perform pg_temp.as_platform();
end $$;
select pg_temp.set_gina_capability('show.cue.call', false);
select is(pg_temp.run('lg', 'g_g') ->> 'reason', 'showcaller_link_owner_access', 'it stops when she loses show.cue.call alone');
select is(pg_temp.w('lg', 'g_g', 'showcaller_standby_cue', quote_literal(pg_temp.id('r5q1'))) ->> 'reason', 'showcaller_link_owner_access', 'writes too');
select pg_temp.set_gina_capability('show.cue.call', true);
select is(pg_temp.run('lg', 'g_g') ->> 'status', 'ok', 'and reads again once she has it back');
select pg_temp.set_gina_capability('show.run_of_show.write', false);
select is(pg_temp.run('lg', 'g_g') ->> 'reason', 'showcaller_link_owner_access', 'it stops when she loses show.run_of_show.write alone');
select pg_temp.set_gina_capability('show.run_of_show.write', true);
select is(pg_temp.run('lg', 'g_g') ->> 'status', 'ok', 'and reads again');
update app.memberships set deleted_at = now() where id = pg_temp.id('gina@org_a');
select is(pg_temp.run('lg', 'g_g') ->> 'reason', 'showcaller_link_owner_access', 'it stops when she leaves the org, whatever grants remain');
select is(pg_temp.w('lg', 'g_g', 'showcaller_standby_cue', quote_literal(pg_temp.id('r5q1'))) ->> 'reason', 'showcaller_link_owner_access', 'writes too');
update app.memberships set deleted_at = null where id = pg_temp.id('gina@org_a');

-- Rate ceilings: seeded to one short, the next call is the last, and the one after answers the rate refusal --------------------------
create function pg_temp.seed_rate(p_bucket text, p_subject text, p_events integer) returns void
language sql as $$
  insert into private.rate_limit_events (bucket, subject_hash)
  select p_bucket, extensions.digest(p_subject, 'sha256') from generate_series(1, p_events);
$$;
create function pg_temp.grant_subject(p_grant_key text) returns text
language sql as $$ select encode(private.share_token_hash(pg_temp.val(p_grant_key)), 'hex') $$;

select pg_temp.link('dave', 'lr', 'r5');
select is(pg_temp.open('lr', pg_temp.val('lr:code'), 'g_r'), 'ok', 'a device with its own rate counts');
select pg_temp.seed_rate('showcaller_link.read', pg_temp.grant_subject('g_r'), 7199);
select is(pg_temp.run('lr', 'g_r') ->> 'status', 'ok', 'read 7200 in the hour is served');
select is(pg_temp.run('lr', 'g_r') ->> 'reason', 'showcaller_link_rate_limited', 'read 7201 is refused: 7200 an hour per grant');
select pg_temp.seed_rate('showcaller_link.write', pg_temp.grant_subject('g_r'), 1799);
select is(pg_temp.w('lr', 'g_r', 'showcaller_standby_cue', quote_literal(pg_temp.id('r5q1'))) ->> 'status', 'ok', 'write 1800 in the hour is served');
insert into k values ('before_rate', null, pg_temp.snapshot());
select is(pg_temp.w('lr', 'g_r', 'showcaller_standby_cue', 'null') ->> 'reason', 'showcaller_link_rate_limited', 'write 1801 is refused: 1800 an hour per grant');
select is(pg_temp.snapshot(), pg_temp.val('before_rate'), 'and changes nothing');

select is(pg_temp.open('lr', pg_temp.val('lr:code'), 'g_r2'), 'ok', 'another device on the same link');
select is(pg_temp.run('lr', 'g_r2') ->> 'status', 'ok', 'has its own read count');
select pg_temp.seed_rate('showcaller_link.link_read', pg_temp.k('lr')::text, 40000);
select is(pg_temp.run('lr', 'g_r2') ->> 'reason', 'showcaller_link_rate_limited', 'until the link itself passes 40000 reads an hour');
select is(pg_temp.open('lr', pg_temp.val('lr:code'), 'g_r3'), 'ok', 'even a new device is held to the link''s count');
select is(pg_temp.run('lr', 'g_r3') ->> 'reason', 'showcaller_link_rate_limited', 'and is refused too');

-- The creator leaves the project: writes stop -------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
update app.project_members set deleted_at = now() where project_id = pg_temp.id('prj_a') and membership_id = pg_temp.id('dave@org_a');
select pg_temp.as_platform();
insert into k values ('before2', null, pg_temp.snapshot());
select is(pg_temp.w('l1', 'g1', 'showcaller_call_cue', quote_literal(pg_temp.id('q3'))) ->> 'reason', 'showcaller_link_owner_access',
  'a link stops when its creator loses show.run_of_show.write or show.cue.call');
select is(pg_temp.run('l1', 'g1') ->> 'reason', 'showcaller_link_owner_access', 'reads too');
select is(pg_temp.snapshot(), pg_temp.val('before2'), 'and nothing was written');

-- A read-only org: writes stop, carol's link included ------------------------------------------------------------------------------
select is(pg_temp.open('l4', pg_temp.val('l4:code'), 'g4'), 'ok', 'carol''s link opens');
select pg_temp.as_user('alice');
select app.cancel_organization(pg_temp.id('org_a'), 'Northwind Live', 'Season over; moving to another tool.');
select pg_temp.as_platform();
insert into k values ('before3', null, pg_temp.snapshot());
select is(pg_temp.w('l4', 'g4', 'showcaller_call_cue', quote_literal(pg_temp.id('q3'))) ->> 'reason', 'org_read_only',
  'every write in a read-only org is refused');
select is(pg_temp.w('l4', 'g4', 'showcaller_save_cue', $$null, '{"label": "Late add"}'$$) ->> 'reason', 'org_read_only', 'adding too');
select is(pg_temp.snapshot(), pg_temp.val('before3'), 'and nothing was written');

-- The running order or its project is trashed -----------------------------------------------------------------------------------
update app.run_of_show set deleted_at = now() where id = pg_temp.id('r2');
select is(pg_temp.run('l2', 'g_l2') ->> 'reason', 'showcaller_link_invalid', 'trashing a running order revokes its link, so the portal reads nothing');
select is(pg_temp.open('l5', pg_temp.val('l5:code'), 'g5'), 'ok', 'a link to the gala opens');
update app.projects set deleted_at = now() where id = pg_temp.id('prj_a2');
select is(pg_temp.run('l5', 'g5') ->> 'reason', 'showcaller_link_not_on_project', 'and while its project is in Trash, the portal reads nothing');

select * from finish();
rollback;
