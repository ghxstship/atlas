-- pgTAP: migration 2781, P1 (RRR-215, ADR 0130). The anonymous token RPCs of live links: opening needs the access code
-- (a read-only call refused first, 5 wrong codes lock, 20 failures per address), a correct code earns a device grant,
-- reads need the grant and are limited per grant and per link, rows carry allowlisted keys only, filtered, searched,
-- sorted and capped as the saved view says, and a link stops when its creator loses access, its view is removed or
-- widened, or a field is reclassified. Day sheets show published sheets only; display screens never show who called a
-- cue; regenerated and revoked tokens answer live_link_invalid.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(48);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update, delete on k to public;

create function pg_temp.id_k(p_key text) returns uuid
language sql stable as $$ select id from k where key = p_key $$;
create function pg_temp.val(p_key text) returns text
language sql stable as $$ select val from k where key = p_key $$;

create function pg_temp.record(p_project text, p_kind text, p_title text, p_starts timestamptz, p_due timestamptz) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, title, xyz, xyz_basis, starts_at, due_at, owner_party_id, accountable_party_id)
  values (pg_temp.id(p_project), p_kind, p_title, 'Y', 'Declared', p_starts, p_due, pg_temp.id('dave'), pg_temp.id('erin'))
  returning id into v;
  return v;
end $$;

create function pg_temp.view(p_collection text, p_name text, p_filters text[] default '{}', p_sort text default null) returns uuid
language plpgsql as $$
declare
  v_id uuid;
  i integer;
begin
  perform pg_temp.as_user('dave');
  insert into app.saved_views (membership_id, collection_key, name, view_type, shared)
  values (pg_temp.id('dave@org_a'), p_collection, p_name, 'List', true) returning id into v_id;
  for i in 1 .. coalesce(array_length(p_filters, 1), 0) / 3 loop
    insert into app.saved_view_filters (saved_view_id, field, operator, value_text)
    values (v_id, p_filters[i * 3 - 2], p_filters[i * 3 - 1]::app.filter_operator, p_filters[i * 3]);
  end loop;
  if p_sort is not null then
    insert into app.saved_view_sorts (saved_view_id, field, direction, position) values (v_id, p_sort, 'Ascending', 1);
  end if;
  perform pg_temp.as_platform();
  insert into k values (p_name, v_id, null);
  return v_id;
end $$;

-- Makes a link as dave and keeps its id, token and the access code it returns once.
create function pg_temp.view_link(p_key text, p_view text) returns void
language plpgsql as $$
declare
  v record;
begin
  perform pg_temp.as_user('dave');
  select * into v from app.create_view_link(pg_temp.id_k(p_view), pg_temp.id('prj_a'), now() + interval '30 days') limit 1;
  perform pg_temp.as_platform();
  insert into k values (p_key, v.live_link_id, v.token), (p_key || ':code', null, v.access_code);
end $$;

create function pg_temp.display_link(p_key text, p_run text) returns void
language plpgsql as $$
declare
  v record;
begin
  perform pg_temp.as_user('dave');
  select * into v from app.create_display_link(pg_temp.id(p_run)) limit 1;
  perform pg_temp.as_platform();
  insert into k values (p_key, v.live_link_id, v.token), (p_key || ':code', null, v.access_code);
end $$;

-- Opens a link as an anonymous caller from a relayed address; answers the reason, or ok with the grant kept.
create function pg_temp.open(p_key text, p_token text, p_code text, p_client text default '198.51.100.7') returns text
language plpgsql as $$
declare
  v jsonb;
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
  v := api_public.open_live_link(p_token, p_code, p_client);
  perform pg_temp.as_platform();
  if v ->> 'status' = 'ok' then
    insert into k values (p_key || ':grant', null, v ->> 'grant') on conflict (key) do update set val = excluded.val;
    return 'ok';
  end if;
  return v ->> 'reason';
end $$;

create function pg_temp.read(p_key text, p_client text default '198.51.100.7') returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
  v := api_public.live_view(pg_temp.val(p_key), pg_temp.val(p_key || ':grant'), p_client);
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.display(p_key text, p_client text default '198.51.100.7') returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
  v := api_public.live_display(pg_temp.val(p_key), pg_temp.val(p_key || ':grant'), p_client);
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.titles(p jsonb) returns text
language sql immutable as $$ select string_agg(e ->> 'title', ', ' order by n) from jsonb_array_elements(p -> 'rows') with ordinality x (e, n) $$;

-- Records of prj_a, and one of prj_a2 -----------------------------------------------------------------------------
select pg_temp.as_user('dave');
select pg_temp.record('prj_a', 'Milestone', 'Curfew Reached', null, now() + interval '3 days');
select pg_temp.record('prj_a', 'Milestone', 'Doors Open', now() + interval '2 days', null);
select pg_temp.record('prj_a', 'Task', 'Hang banners', null, now() + interval '1 day');
select pg_temp.record('prj_a', 'Milestone', 'Undated Goal Reached', null, null);
select pg_temp.as_user('alice');
select pg_temp.record('prj_a2', 'Milestone', 'Winter Goal Reached', null, now() + interval '1 day');
select pg_temp.as_platform();

select pg_temp.view('project/schedule', 'Milestones', array['kind', 'eq', 'Milestone', 'month', 'eq', '2027-06-01'], 'next');

select pg_temp.view_link('v', 'Milestones');

-- Opening -----------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
create function pg_temp.read_only_open() returns text
language plpgsql as $$
begin
  begin
    perform set_config('transaction_read_only', 'on', true);
    perform api_public.open_live_link(pg_temp.val('v'), '000000', null);
  exception when others then
    perform set_config('transaction_read_only', 'off', true);
    return sqlstate;
  end;
  perform set_config('transaction_read_only', 'off', true);
  return 'ran';
end $$;
select is(pg_temp.read_only_open(), '25006', 'a read-only (GET) call of open_live_link is refused before any lookup');
select pg_temp.as_platform();


select is(pg_temp.open('v', pg_temp.val('v'), null), 'live_link_access_code_required', 'opening asks for the access code');
select is(pg_temp.open('v', pg_temp.val('v'), case when pg_temp.val('v:code') = '000000' then '000001' else '000000' end),
  'live_link_access_code', 'a wrong code is refused');
select is((select failed_attempts::int from app.live_links where id = pg_temp.id_k('v')), 1, 'and counted on the link');
select is(pg_temp.open('v', pg_temp.val('v'), pg_temp.val('v:code')), 'ok', 'the correct code opens the link');
select matches(pg_temp.val('v:grant'), '^xlgr_[0-9a-f]{64}$', 'and earns a device grant');
select results_eq($$select open_count, last_opened_at is not null from app.live_links where id = (select id from k where key = 'v')$$,
  $$values (1, true)$$, 'the open is counted');
select ok((select expires_at <= now() + interval '7 days' from private.live_link_grants where grant_hash = extensions.digest(pg_temp.val('v:grant'), 'sha256')),
  'a grant lasts at most 7 days');

-- Reading -------------------------------------------------------------------------------------------------------------
insert into k values ('nogrant', null, pg_temp.val('v')), ('nogrant:grant', null, 'xlgr_' || repeat('0', 64));
select is(pg_temp.read('nogrant') ->> 'reason', 'live_link_grant', 'a read without a valid device grant is refused');
select is(pg_temp.read('v') ->> 'status', 'ok', 'a read with the grant succeeds');
select is(pg_temp.titles(pg_temp.read('v')), 'Doors Open, Curfew Reached',
  'the milestones of NWL only, dated ones only, sorted by next; month is ignored');
select is((select array_agg(distinct key order by key) from jsonb_array_elements(pg_temp.read('v') -> 'rows') e, jsonb_object_keys(e) key),
  (select array_agg(field_key order by field_key)::text[] from private.live_view_fields
   where collection_key = 'project/schedule' and part = 'row' and shown),
  'every row carries exactly the allowlisted keys: never an owner, accountable person, blocker text or replan reason');
select is((select (e ->> 'key') from jsonb_array_elements(pg_temp.read('v') -> 'rows') e limit 1) ~ '^NWL-[0-9]+$', true,
  'a record''s key is the project key and its number');
select results_eq($$select r -> 'meta' ->> 'project_name', r -> 'meta' ->> 'time_zone', r ->> 'channel' ~ '^xlink:xlch_[0-9a-f]{64}$', r ? 'server_now', r -> 'meta' ? 'note'
  from (select pg_temp.read('v') as r) x$$,
  $$values ('Northwind Summer Series'::text, 'America/New_York'::text, true, true, false)$$,
  'the heading names the project and its zone, the channel and the server time, never the note');

-- Filters, search and widening.
select pg_temp.as_user('dave');
insert into app.saved_view_filters (saved_view_id, field, operator, value_text) values (pg_temp.id_k('Milestones'), 'f.title', 'contains', 'CURFEW');
select pg_temp.as_platform();
select is(pg_temp.titles(pg_temp.read('v')), 'Curfew Reached', 'an f.<field> condition on a filterable field is applied, ignoring case');
select pg_temp.as_user('dave');
update app.saved_view_filters set deleted_at = now() where saved_view_id = pg_temp.id_k('Milestones') and field = 'f.title';
update app.saved_views set search_text = 'door' where id = pg_temp.id_k('Milestones');
select pg_temp.as_platform();
select is(pg_temp.titles(pg_temp.read('v')), 'Doors Open', 'the saved search matches titles');
select pg_temp.as_user('dave');
update app.saved_views set search_text = null where id = pg_temp.id_k('Milestones');
insert into app.saved_view_filters (saved_view_id, field, operator, value_text) values (pg_temp.id_k('Milestones'), 'cf.seats', 'gte', '100');
select pg_temp.as_platform();
select is(pg_temp.read('v') ->> 'reason', 'live_link_view_unsupported', 'a filter outside the allowlist stops the link instead of widening it');
select pg_temp.as_user('dave');
update app.saved_view_filters set deleted_at = now() where saved_view_id = pg_temp.id_k('Milestones') and field = 'cf.seats';
select pg_temp.as_platform();
select is(pg_temp.titles(pg_temp.read('v')), 'Doors Open, Curfew Reached', 'removing the filter restores it');
select pg_temp.as_user('dave');
insert into app.saved_view_filters (saved_view_id, field, operator, value_text) values (pg_temp.id_k('Milestones'), 'live', 'eq', '1');
select pg_temp.as_platform();
select is(pg_temp.titles(pg_temp.read('v')), 'Doors Open, Curfew Reached', 'show mode (live) is not a filter and is ignored, as month is');
select pg_temp.as_user('dave');
insert into app.saved_view_filters (saved_view_id, field, operator, value_text) values (pg_temp.id_k('Milestones'), 'f.blocker_text', 'contains', 'rain');
select pg_temp.as_platform();
select is(pg_temp.read('v') ->> 'reason', 'live_link_view_unsupported', 'an f.<field> condition on a field the allowlist does not mark filterable is refused');
select pg_temp.as_user('dave');
update app.saved_view_filters set deleted_at = now() where saved_view_id = pg_temp.id_k('Milestones') and field in ('live', 'f.blocker_text');
select pg_temp.as_platform();

-- Reclassification.
insert into private.column_classifications (table_name, column_name, classification) values ('app.records', 'title', 'Confidential');
select is(pg_temp.read('v') ->> 'reason', 'live_link_reclassified', 'a field classified above Internal stops every link that shows it');
delete from private.column_classifications where table_name = 'app.records' and column_name = 'title';

-- Limits per grant and per link.
insert into private.rate_limit_events (bucket, subject_hash)
select 'live_link.fetch', extensions.digest(encode(extensions.digest(pg_temp.val('v:grant'), 'sha256'), 'hex'), 'sha256') from generate_series(1, 1200);
select is(pg_temp.read('v') ->> 'reason', 'live_link_rate_limited', 'a grant fetches at most 1200 times an hour');
delete from private.rate_limit_events where bucket = 'live_link.fetch';
insert into private.rate_limit_events (bucket, subject_hash)
select 'live_link.link_fetch', extensions.digest(pg_temp.id_k('v')::text, 'sha256') from generate_series(1, 60000);
select is(pg_temp.read('v') ->> 'reason', 'live_link_rate_limited', 'and a link at most 60000 times an hour across its screens');
delete from private.rate_limit_events where bucket = 'live_link.link_fetch';
select is(pg_temp.read('v') ->> 'status', 'ok', 'below both limits the link reads again');

-- Lockout and the address limit.
select pg_temp.view_link('locked', 'Milestones');
insert into k values ('wrong', null, case when pg_temp.val('locked:code') = '111111' then '222222' else '111111' end);
select pg_temp.open('locked', pg_temp.val('locked'), pg_temp.val('wrong'), '198.51.100.20') from generate_series(1, 4);
select is(pg_temp.open('locked', pg_temp.val('locked'), pg_temp.val('wrong'), '198.51.100.20'), 'live_link_locked', 'the fifth wrong code locks the link');
select is(pg_temp.open('locked', pg_temp.val('locked'), pg_temp.val('locked:code'), '198.51.100.21'), 'live_link_locked', 'even the right code no longer opens it');

select pg_temp.open('guess', 'xshv_' || lpad(g::text, 64, '0'), '000000', '198.51.100.30') from generate_series(1, 20) g;
select is(pg_temp.open('v', pg_temp.val('v'), pg_temp.val('v:code'), '198.51.100.30'), 'live_link_rate_limited',
  'after 20 failed lookups in 10 minutes an address is refused');
select is(pg_temp.open('v', pg_temp.val('v'), pg_temp.val('v:code'), '198.51.100.31'), 'ok', 'another address is not');
-- The failure limits stop guessing; they never blank a device that already proved the code.
insert into k values ('v_ungranted', null, pg_temp.val('v')), ('v_ungranted:grant', null, null);
select is(pg_temp.read('v', '198.51.100.30') ->> 'status', 'ok',
  'a device holding a valid grant still reads from an address past its failure limit');
select is(pg_temp.read('v_ungranted', '198.51.100.30') ->> 'reason', 'live_link_rate_limited',
  'while a fetch from that address without a grant is refused');
select set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
insert into private.rate_limit_events (bucket, subject_hash)
select 'live_link.hop_failure', extensions.digest((select o_hop from private.live_link_subjects(null)), 'sha256') from generate_series(1, 2000);
select is(pg_temp.read('v', '198.51.100.32') ->> 'status', 'ok',
  'and when the reaching address (the Atlas server''s egress) used up its 2000 failures, granted screens keep reading');
select is(pg_temp.read('v_ungranted', '198.51.100.32') ->> 'reason', 'live_link_rate_limited',
  'while ungranted fetches through it are refused');
delete from private.rate_limit_events where bucket = 'live_link.hop_failure';

-- Day sheets: published ones only ----------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.day_sheets (project_id, day, body) values (pg_temp.id('prj_a'), current_date + 10, '<b>Doors 7 pm.</b> Load-out after curfew.') returning id)
  insert into world select 'ds', id from x;
update app.day_sheets set published_at = now() where id = pg_temp.id('ds');
insert into app.day_sheets (project_id, day, body) values (pg_temp.id('prj_a'), current_date + 11, 'Draft plan.');
select pg_temp.as_platform();
select pg_temp.view('show/day_sheets', 'Sheets');
select pg_temp.view_link('ds', 'Sheets');
select pg_temp.open('ds', pg_temp.val('ds'), pg_temp.val('ds:code')) is not null as opened;
select results_eq($$select jsonb_array_length(r -> 'rows'), r -> 'rows' -> 0 ->> 'body' from (select pg_temp.read('ds') as r) x$$,
  $$values (1, '<b>Doors 7 pm.</b> Load-out after curfew.'::text)$$, 'a day-sheets link shows only published sheets, the body as stored text');

-- Running orders and display screens --------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Opening Night', current_date + 5) returning id)
  insert into world select 'ros', id from x;
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Matinee', current_date + 6) returning id)
  insert into world select 'ros2', id from x;
insert into app.cues (run_of_show_id, position, label, segment, description, planned_at, duration) values
  (pg_temp.id('ros'), 1, 'House to Half', 'Act I', 'Dim the house lights.', now(), interval '5 minutes'),
  (pg_temp.id('ros'), 2, 'Headliner On', 'Act I', 'Band walks on.', now() + interval '5 minutes', interval '45 minutes');
select pg_temp.as_platform();
select pg_temp.view('project/show', 'Shows');
select pg_temp.view_link('runs', 'Shows');
select pg_temp.display_link('d', 'ros');
select pg_temp.open('runs', pg_temp.val('runs'), pg_temp.val('runs:code')) is not null as opened;
select pg_temp.open('d', pg_temp.val('d'), pg_temp.val('d:code')) is not null as opened;

select is((select string_agg(e ->> 'name', ', ' order by n) from jsonb_array_elements(pg_temp.read('runs') -> 'rows') with ordinality x (e, n)),
  'Opening Night, Matinee', 'a show link lists the running orders by show day');
select is((select array_agg(key order by key) from jsonb_object_keys(pg_temp.read('runs') -> 'rows' -> 0) key),
  array['cues', 'name', 'show_date'], 'each with its name, show day and cues');
update private.live_view_collections set max_rows = 1 where collection_key = 'project/show';
select results_eq($$select jsonb_array_length(r -> 'rows'), (r ->> 'truncated')::boolean from (select pg_temp.read('runs') as r) x$$,
  $$values (1, true)$$, 'the payload is capped, with the truncated flag');
update private.live_view_collections set max_rows = 200 where collection_key = 'project/show';

select is(pg_temp.display('d') ->> 'status', 'ok', 'a display screen reads with its grant');
select is((select array_agg(distinct key order by key) from jsonb_array_elements(pg_temp.display('d') -> 'cues') e, jsonb_object_keys(e) key),
  array['called_at', 'duration_seconds', 'label', 'planned_at', 'position', 'segment'],
  'each cue carries position, label, segment, planned_at, duration_seconds and called_at, never called_by or description');
select results_eq($$select r -> 'meta' ->> 'name', r -> 'meta' ->> 'default_mode', (r -> 'cues' -> 1 ->> 'duration_seconds')::int from (select pg_temp.display('d') as r) x$$,
  $$values ('Opening Night'::text, 'Backstage'::text, 2700)$$, 'with the running order''s name, the default mode and durations in seconds');
select pg_temp.as_user('dave');
update app.cues set called_at = now() where run_of_show_id = pg_temp.id('ros') and position = 1;
select pg_temp.as_platform();
select ok((pg_temp.display('d') -> 'cues' -> 0 ->> 'called_at') is not null, 'a called cue shows when it was called');
insert into k values ('d_as_view', null, pg_temp.val('d')), ('d_as_view:grant', null, pg_temp.val('d:grant'));
select is(pg_temp.read('d_as_view') ->> 'reason', 'live_link_invalid', 'a display token never reads as a view');

-- Stopping ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
update app.run_of_show set deleted_at = now() where id = pg_temp.id('ros');
select pg_temp.as_platform();
select is(pg_temp.display('d') ->> 'reason', 'live_link_view_removed', 'a deleted running order stops its display screens');

select pg_temp.as_user('dave');
update app.saved_views set deleted_at = now() where id = pg_temp.id_k('Sheets');
select pg_temp.as_platform();
select is(pg_temp.read('ds') ->> 'reason', 'live_link_view_removed', 'a deleted saved view stops its links');

-- Regenerating: the old token answers live_link_invalid without counting a failure.
select pg_temp.as_user('dave');
insert into k select 'runs:new', null, r.token from app.regenerate_live_link(pg_temp.id_k('runs')) r;
select pg_temp.as_platform();
insert into k values ('failures', null, (select count(*) from private.rate_limit_events where bucket = 'live_link.failure')::text);
select is(pg_temp.open('runs', pg_temp.val('runs'), '000000', '198.51.100.40'), 'live_link_invalid', 'a regenerated token answers live_link_invalid');
select is((select count(*) from private.rate_limit_events where bucket = 'live_link.failure')::text, pg_temp.val('failures'),
  'without counting a failure against the visitor''s address');
select is(pg_temp.read('runs') ->> 'reason', 'live_link_invalid', 'and the old grant reads nothing');

-- Revoking.
select pg_temp.as_user('dave');
select app.revoke_live_link(pg_temp.id_k('locked'));
select pg_temp.as_platform();
select is(pg_temp.open('locked', pg_temp.val('locked'), pg_temp.val('locked:code'), '198.51.100.50'), 'live_link_invalid', 'a revoked link answers live_link_invalid');

-- The creator leaves the project.
select pg_temp.as_user('alice');
update app.project_members set deleted_at = now() where project_id = pg_temp.id('prj_a') and membership_id = pg_temp.id('dave@org_a');
select pg_temp.as_platform();
select is(pg_temp.read('v') ->> 'reason', 'live_link_owner_access', 'a link stops when its creator loses the collection''s read capability on the project');

select * from finish();
rollback;
