-- pgTAP: migration 2911, B2 (RRR-226, ADR 0141). The refactor of P1's live link reads changes nothing: the public
-- reads answer exactly what the extracted payload helpers answer, the owner check restores the caller's claims, and the
-- helpers stay private. P1's own suites (2780 to 2782) run unchanged beside this one.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(9);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update, delete on k to public;

create function pg_temp.k(p_key text) returns uuid language sql stable as $$ select id from k where key = p_key $$;
create function pg_temp.v(p_key text) returns text language sql stable as $$ select val from k where key = p_key $$;

select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Doors Order', current_date + 4) returning id)
  insert into k select 'ros', id, null from x;
insert into app.cues (run_of_show_id, position, label, planned_at, duration)
values (pg_temp.k('ros'), 1, 'House opens', now() + interval '4 days', interval '15 minutes'),
       (pg_temp.k('ros'), 2, 'Walk-in music', now() + interval '4 days 15 minutes', interval '10 minutes');
insert into k select 'display', d.live_link_id, d.token || ' ' || d.access_code
from app.create_display_link(pg_temp.k('ros'), now() + interval '10 days') d;
insert into k values ('fresh', null, pg_temp.v('display'));
select pg_temp.as_platform();

-- Opening for a grant, then reading through the public RPC and through the helper.
select pg_temp.as_anon();
select set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.40')::text, true);
insert into k select 'grant', null, (api_public.open_live_link(split_part(pg_temp.v('fresh'), ' ', 1), split_part(pg_temp.v('fresh'), ' ', 2), '198.51.100.9')) ->> 'grant';
insert into k select 'public', null, api_public.live_display(split_part(pg_temp.v('fresh'), ' ', 1), pg_temp.v('grant'), '198.51.100.9')::text;
select pg_temp.as_platform();

select is((pg_temp.v('public'))::jsonb ->> 'status', 'ok', 'the display link reads through the public RPC');
select is((pg_temp.v('public'))::jsonb,
  private.live_display_payload((select l from app.live_links l where l.id = pg_temp.k('display')),
    (select c from private.live_view_collections c where c.collection_key = 'display')),
  'api_public.live_display answers exactly what private.live_display_payload answers');
select is(jsonb_array_length((pg_temp.v('public'))::jsonb -> 'cues'), 2, 'with the running order''s cues');

-- The owner check reads as the creator and gives the claims back.
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(private.live_link_owner_reason((select l from app.live_links l where l.id = pg_temp.k('display')),
  (select c from private.live_view_collections c where c.collection_key = 'display')), null::text,
  'the creator still reads the running order, so the link shows');
select is(current_setting('request.jwt.claims', true), '{"role":"anon"}', 'and the caller''s claims are restored');
select is(private.live_display_payload((select l from app.live_links l where l.id = pg_temp.k('display')),
  (select c from private.live_view_collections c where c.collection_key = 'display')) ->> 'status', 'ok', 'the payload reads as the creator');
select is(current_setting('request.jwt.claims', true), '{"role":"anon"}', 'and restores the claims too');
select pg_temp.as_platform();

select ok(not has_function_privilege('anon', 'private.live_view_payload(app.live_links, private.live_view_collections)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.live_display_payload(app.live_links, private.live_view_collections)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.live_link_owner_reason(app.live_links, private.live_view_collections)', 'EXECUTE'),
  'the payload helpers and the owner check are private');
select is(obj_description('api_public.live_view(text, text, text)'::regprocedure, 'pg_proc'),
  'Reads a saved view live link with its device grant (ADR 0130; Section 7.5 invariant 8), acting as the link''s creator. Refuses as private.live_link_reader does, and live_link_view_removed when the saved view is deleted or no longer readable by the creator, live_link_view_unsupported when it now filters, sorts or groups by a field outside the allowlist. Answers JSON: meta (brand, project name and zone, view name, type and grouping, expiry), the Realtime channel, server_now, and rows built from allowlisted columns only, filtered, searched, sorted and capped with a truncated flag. Writes only rate events.',
  'api_public.live_view keeps its comment');

select * from finish();
rollback;
