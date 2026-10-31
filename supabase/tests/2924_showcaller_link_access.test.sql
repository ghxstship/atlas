-- pgTAP: migration 2924, B3 (RRR-227, ADR 0142). The anonymous side of showcaller links, and the proof that a valid
-- token and grant for running order R1 reach nothing else: every write aimed at a cue of R2 in the same project, of
-- another project, of another org, or at an id that does not exist answers the same showcaller_link_scope body and
-- changes no cue, department call or audit event; 20 such answers delete the grant; the read answers R1's rows only,
-- never a person or the note. Also: a read-only transaction is refused first, tokens never cross kinds or links, the
-- writes the portal may make (attributed to the link), the field allowlist and stale edits, the device cap, a locked
-- link still serving its devices, the per-cue flags the portal needs (called through a link, an artist's set time), and
-- the portal stopping when a column it shows is reclassified, the creator loses access, the org turns read-only, or the
-- running order or its project is trashed. P2's own suite (2790) runs unchanged over the cores.
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

-- Runs a token RPC as an anonymous caller relayed from an address; answers its JSON.
create function pg_temp.anon(p_sql text, p_client text default '198.51.100.7') returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_anon();
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
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Second Night', current_date + 6) returning id)
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

-- A read-only (GET) transaction is refused before anything ------------------------------------------------------------------------
create function pg_temp.read_only_open() returns text
language plpgsql as $$
begin
  perform pg_temp.as_anon();
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
    foreach v_target in array array[pg_temp.id('r2q1')::text, pg_temp.id('r3q1')::text, pg_temp.id('r4q1')::text, gen_random_uuid()::text] loop
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
select is((select count(*)::int from scope_answers), 24, 'every write was aimed at a cue of R2, another project, another org and a random id');
select is((select array_agg(distinct body::text) from scope_answers), array['{"reason": "showcaller_link_scope", "status": "refused"}'],
  'and every one answered the same showcaller_link_scope body');
select is(pg_temp.snapshot(), pg_temp.val('before'), 'no cue, department call or audit event changed anywhere');
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

-- The creator leaves the project: writes stop -------------------------------------------------------------------------------------
insert into k values ('before2', null, pg_temp.snapshot());
select pg_temp.as_user('alice');
update app.project_members set deleted_at = now() where project_id = pg_temp.id('prj_a') and membership_id = pg_temp.id('dave@org_a');
select pg_temp.as_platform();
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
select is(pg_temp.run('l5', 'g5') ->> 'reason', 'showcaller_link_run_removed', 'and while its project is in Trash, the portal reads nothing');

select * from finish();
rollback;
