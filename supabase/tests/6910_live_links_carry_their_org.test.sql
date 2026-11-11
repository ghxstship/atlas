-- pgTAP: migration 6910 (RRR-243). P1's live links never stop their org's purge: private.live_link_channels and
-- private.live_link_grants carry the link's org, so private.purge_organization (1351) and private.purge_sandbox_org
-- (1530) count them as the org's own rows, as 6243 made showcaller links do. Making a link stamps its channel with the
-- org and opening it stamps the grant, from the link whatever the row names. A project-tied link still ends when
-- its project is Complete, Canceled, archived or in Trash (6280), and opens again when the project is reopened.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(30);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update, delete on k to public;

create function pg_temp.k(p_key text) returns uuid
language sql stable as $$ select id from k where key = p_key $$;
create function pg_temp.val(p_key text) returns text
language sql stable as $$ select val from k where key = p_key $$;

-- Makes a display screen link to a running order as a person and keeps its id, token and code.
create function pg_temp.display_link(p_user text, p_key text, p_run text) returns void
language plpgsql as $$
declare
  v record;
begin
  perform pg_temp.as_user(p_user);
  select * into v from app.create_display_link(pg_temp.id(p_run)) limit 1;
  perform pg_temp.as_platform();
  insert into k values (p_key, v.live_link_id, v.token), (p_key || ':code', null, v.access_code);
end $$;

-- Makes a saved view of the project schedule and a live link to it on a project, as a person of an org.
create function pg_temp.view_link(p_user text, p_org text, p_key text, p_project text) returns void
language plpgsql as $$
declare
  v_view uuid;
  v record;
begin
  perform pg_temp.as_user(p_user);
  insert into app.saved_views (membership_id, collection_key, name, view_type, shared)
  values (pg_temp.id(p_user || '@' || p_org), 'project/schedule', 'Milestones ' || p_key, 'List', true) returning id into v_view;
  select * into v from app.create_view_link(v_view, pg_temp.id(p_project), now() + interval '30 days') limit 1;
  perform pg_temp.as_platform();
  insert into k values (p_key, v.live_link_id, v.token), (p_key || ':code', null, v.access_code);
end $$;

-- Opens a link as an anonymous caller; answers the reason, or ok with the grant kept.
create function pg_temp.open(p_key text) returns text
language plpgsql as $$
declare
  v jsonb;
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
  v := api_public.open_live_link(pg_temp.val(p_key), pg_temp.val(p_key || ':code'), '198.51.100.7');
  perform pg_temp.as_platform();
  if v ->> 'status' = 'ok' then
    insert into k values (p_key || ':grant', null, v ->> 'grant') on conflict (key) do update set val = excluded.val;
    return 'ok';
  end if;
  return v ->> 'reason';
end $$;

create function pg_temp.read(p_key text) returns text
language plpgsql as $$
declare
  v jsonb;
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
  v := api_public.live_display(pg_temp.val(p_key), pg_temp.val(p_key || ':grant'), '198.51.100.7');
  perform pg_temp.as_platform();
  return coalesce(v ->> 'reason', 'ok');
end $$;

-- The columns -----------------------------------------------------------------------------------------------------------
select col_not_null('private', 'live_link_channels', 'org_id', 'a live link''s channel key names its org');
select col_not_null('private', 'live_link_grants', 'org_id', 'and so does each device grant');
select fk_ok('private', 'live_link_channels', 'org_id', 'app', 'organizations', 'id', 'the channel''s org is an organization');
select fk_ok('private', 'live_link_grants', 'org_id', 'app', 'organizations', 'id', 'and the grant''s');
select has_index('private', 'live_link_channels', 'live_link_channels_org_idx', 'the purge finds the channels by org');
select has_index('private', 'live_link_grants', 'live_link_grants_org_idx', 'and the grants');

-- Making and opening stamp the org --------------------------------------------------------------------------------------
select pg_temp.as_user('xavier');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_b'), 'Pier Night', current_date + 7) returning id)
  insert into world select 'ros_b', id from x;
select pg_temp.as_platform();
select pg_temp.display_link('xavier', 'lb', 'ros_b');
select pg_temp.view_link('xavier', 'org_b', 'vb', 'prj_b');
select is((select org_id from private.live_link_channels where live_link_id = pg_temp.k('lb')), pg_temp.id('org_b'),
  'a new display link''s channel carries its org');
select is((select org_id from private.live_link_channels where live_link_id = pg_temp.k('vb')), pg_temp.id('org_b'),
  'and a view link''s');
select is(pg_temp.open('lb'), 'ok', 'opening with the code earns a device grant');
select is(pg_temp.open('vb'), 'ok', 'on either kind');
select is((select array_agg(distinct org_id) from private.live_link_grants where live_link_id in (pg_temp.k('lb'), pg_temp.k('vb'))),
  array[pg_temp.id('org_b')], 'each grant carries the link''s org');
select is(pg_temp.read('lb'), 'ok', 'and the screen reads with it');
insert into private.live_link_grants (grant_hash, live_link_id, org_id, expires_at)
values (private.share_token_hash('xlgr_' || repeat('f', 64)), pg_temp.k('lb'), pg_temp.id('org_a'), now() + interval '1 hour');
select is((select org_id from private.live_link_grants where grant_hash = private.share_token_hash('xlgr_' || repeat('f', 64))),
  pg_temp.id('org_b'), 'a grant always takes its link''s org, whatever it names');

-- A project that ends still ends its links (6280) --------------------------------------------------------------------------
create function pg_temp.set_project(p_state text, p_archived boolean default false, p_trashed boolean default false) returns void
language plpgsql as $f$
begin
  set local session_replication_role = replica;
  update app.projects set project_state = p_state::app.project_state,
    archived_at = case when p_archived then now() end, deleted_at = case when p_trashed then now() end
  where id = pg_temp.id('prj_b');
  set local session_replication_role = origin;
end $f$;
select set_config('t.state', (select project_state::text from app.projects where id = pg_temp.id('prj_b')), true);
select pg_temp.set_project('Complete');
select is(pg_temp.read('lb'), 'live_link_ended', 'a screen on a Complete project reads nothing');
select is(pg_temp.open('vb'), 'live_link_ended', 'and its view link no longer opens');
select pg_temp.set_project('Canceled');
select is(pg_temp.read('lb'), 'live_link_ended', 'nor on a Canceled project');
select pg_temp.set_project(current_setting('t.state'), true);
select is(pg_temp.read('lb'), 'live_link_ended', 'nor on an archived one');
select pg_temp.set_project(current_setting('t.state'), false, true);
select is(pg_temp.read('lb'), 'live_link_ended', 'nor on one in Trash');
select pg_temp.set_project(current_setting('t.state'));
select is(pg_temp.read('lb'), 'ok', 'reopening the project lets the screen read again');
select is(pg_temp.open('vb'), 'ok', 'and the view link open');

-- A link never stops its org being purged --------------------------------------------------------------------------------
insert into world select 'cert_b', private.write_deletion_certificate(pg_temp.id('org_b'), 'cancellation', now(), now(), null);
update app.deletion_certificates set storage_cleared_at = now() where id = pg_temp.id('cert_b');
select cmp_ok(private.purge_organization(pg_temp.id('cert_b')), '>', 0::bigint, 'an org that made live links is purged');
select is((select blocked_reason from app.deletion_certificates where id = pg_temp.id('cert_b')), null, 'with nothing blocking it');
select is((select count(*)::int from app.live_links where id in (pg_temp.k('lb'), pg_temp.k('vb'))), 0, 'its links go with it');
select is((select count(*)::int from private.live_link_channels where live_link_id in (pg_temp.k('lb'), pg_temp.k('vb'))), 0,
  'their channel keys');
select is((select count(*)::int from private.live_link_grants where live_link_id in (pg_temp.k('lb'), pg_temp.k('vb'))), 0,
  'and their device grants');

-- And a sandbox with a live link is purged whole -------------------------------------------------------------------------
select pg_temp.as_user('nina');
insert into world select 'sandbox', s.org_id from app.open_my_sandbox() s;
with x as (insert into app.run_of_show (project_id, name, show_date)
  values ((select p.id from app.projects p where p.org_id = pg_temp.id('sandbox') order by p.project_key limit 1), 'Sandbox Night', current_date + 3) returning id)
  insert into world select 'ros_sb', id from x;
select pg_temp.as_platform();
select pg_temp.display_link('nina', 'lsb', 'ros_sb');
select is(pg_temp.open('lsb'), 'ok', 'a sandbox with an opened display link');
update app.sandbox_orgs set expires_at = now() - interval '1 second' where org_id = pg_temp.id('sandbox');
select lives_ok(format('select private.purge_sandbox_org(%L)', pg_temp.id('sandbox')), 'is purged');
select is((select count(*)::int from app.organizations where id = pg_temp.id('sandbox')), 0, 'whole');
select is((select count(*)::int from private.live_link_channels where live_link_id = pg_temp.k('lsb')), 0, 'its channel key included');
select is((select count(*)::int from private.live_link_grants where live_link_id = pg_temp.k('lsb')), 0, 'and its device grants');

select * from finish();
rollback;
