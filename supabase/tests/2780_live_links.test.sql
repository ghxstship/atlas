-- pgTAP: migration 2780, P1 (RRR-215, ADR 0130). Live links to saved views and display screens: only members of the
-- link's org who hold the collection's share capability make them, every link has an expiry within 90 days and an
-- access code, tokens and codes are stored only as hashes, at most 20 live links per view or running order, nothing
-- in a read-only org but revocation, a state computed when read, regeneration and revocation by the creator or a
-- share capability holder, the field allowlist refusing classified columns, and live links kept out of Trash.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(65);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update, delete on k to public;

-- A saved view of a collection, owned by a person, with filters as field, operator, value triples.
create function pg_temp.view(p_owner text, p_collection text, p_name text, p_shared boolean, p_filters text[] default '{}',
  p_sort text default null) returns uuid
language plpgsql as $$
declare
  v_id uuid;
  i integer;
begin
  perform pg_temp.as_user(p_owner);
  insert into app.saved_views (membership_id, collection_key, name, view_type, shared)
  values (pg_temp.id(p_owner || '@org_a'), p_collection, p_name, 'List', p_shared) returning id into v_id;
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

-- Makes a view link as a person and keeps its id, token and code; answers the refusal rule or the SQLSTATE on failure.
create function pg_temp.view_link(p_user text, p_key text, p_view text, p_project text, p_expires timestamptz) returns text
language plpgsql as $$
declare
  v_row record;
begin
  perform pg_temp.as_user(p_user);
  begin
    select * into v_row from app.create_view_link(pg_temp.id_k(p_view), pg_temp.id(p_project), p_expires, 'For the venue') limit 1;
  exception when sqlstate 'XR001' then
    perform pg_temp.as_platform();
    return split_part(sqlerrm, ':', 1);
  when insufficient_privilege then
    perform pg_temp.as_platform();
    return '42501';
  end;
  perform pg_temp.as_platform();
  insert into k values (p_key, v_row.live_link_id, v_row.token), (p_key || ':code', null, v_row.access_code)
  on conflict (key) do update set id = excluded.id, val = excluded.val;
  return 'ok';
end $$;

create function pg_temp.id_k(p_key text) returns uuid
language sql stable as $$ select id from k where key = p_key $$;

create function pg_temp.val(p_key text) returns text
language sql stable as $$ select val from k where key = p_key $$;

create function pg_temp.display_link(p_user text, p_key text, p_run text, p_expires timestamptz default null) returns text
language plpgsql as $$
declare
  v_row record;
begin
  perform pg_temp.as_user(p_user);
  begin
    select * into v_row from app.create_display_link(pg_temp.id(p_run), p_expires) limit 1;
  exception when sqlstate 'XR001' then
    perform pg_temp.as_platform();
    return split_part(sqlerrm, ':', 1);
  when insufficient_privilege then
    perform pg_temp.as_platform();
    return '42501';
  end;
  perform pg_temp.as_platform();
  insert into k values (p_key, v_row.live_link_id, v_row.token), (p_key || ':code', null, v_row.access_code)
  on conflict (key) do update set id = excluded.id, val = excluded.val;
  return 'ok';
end $$;

-- gina, a Viewer, is assigned to prj_a, so she reads its show without editing it.
select pg_temp.as_user('alice');
insert into app.project_members (project_id, membership_id, project_role) values (pg_temp.id('prj_a'), pg_temp.id('gina@org_a'), 'Field');

-- Running orders on prj_a: one far ahead, one next week, one already past.
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night Running Order', current_date + 200) returning id)
  insert into world select 'ros', id from x;
with x as (insert into app.run_of_show (project_id, name, show_date)
  values (pg_temp.id('prj_a'), 'Matinee Running Order', current_date + 5) returning id)
  insert into world select 'ros_soon', id from x;
with x as (insert into app.run_of_show (project_id, name, show_date)
  values (pg_temp.id('prj_a'), 'Preview Running Order', current_date - 3) returning id)
  insert into world select 'ros_past', id from x;
select pg_temp.as_platform();

select pg_temp.view('dave', 'project/schedule', 'Milestones', true, array['kind', 'eq', 'Milestone'], 'next');
select pg_temp.view('dave', 'project/schedule', 'Private milestones', false, array['kind', 'eq', 'Milestone']);
select pg_temp.view('dave', 'work/all_records', 'All records', true);
select pg_temp.view('dave', 'project/schedule', 'Custom field view', true, array['cf.seats', 'gte', '100']);
select pg_temp.view('dave', 'project/schedule', 'Owner view', true, array['f.owner', 'eq', 'Dave']);
select pg_temp.view('dave', 'project/schedule', 'Calendar month', true, array['month', 'eq', '2027-06-01', 'f.title', 'contains', 'doors']);
select pg_temp.view('dave', 'project/schedule', 'Other project', true, array['project', 'eq', 'NWX']);
select pg_temp.view('dave', 'project/schedule', 'Updated sort', true, '{}', 'updated');

-- Making a view link ----------------------------------------------------------------------------------------------
select has_table('app', 'live_links', 'app.live_links exists');
select is(pg_temp.view_link('dave', 'v1', 'Milestones', 'prj_a', now() + interval '30 days'), 'ok',
  'a Member with schedule.timeline.export on the project shares a Schedule view live');
select matches(pg_temp.val('v1'), '^xshv_[0-9a-f]{64}$', 'the token is returned once: xshv_ and 32 random bytes');
select matches(pg_temp.val('v1:code'), '^[0-9]{6}$', 'with a 6-digit access code');
select ok((select token_hash = extensions.digest(pg_temp.val('v1'), 'sha256') from app.live_links where id = pg_temp.id_k('v1')),
  'only the SHA-256 of the token is stored');
select ok((select access_code_hash = extensions.digest(pg_temp.val('v1') || ':' || pg_temp.val('v1:code'), 'sha256')
  from app.live_links where id = pg_temp.id_k('v1')), 'and the code''s hash, salted by the token');
select results_eq($$select link_kind::text, project_id, org_id, token_hint, note from app.live_links where id = (select id from k where key = 'v1')$$,
  $$values ('View'::text, (select id from world where key = 'prj_a'), (select id from world where key = 'org_a'), right((select val from k where key = 'v1'), 4), 'For the venue'::text)$$,
  'the link names its project, org, kind, token hint and note');

select pg_temp.as_user('dave');
select throws_ok($$select token_hash from app.live_links where id = (select id from k where key = 'v1')$$, '42501', null,
  'inv_08_token_rpcs_hashed_secrets: the token hash is never readable by signed-in callers');
select throws_ok($$select access_code_hash from app.live_links where id = (select id from k where key = 'v1')$$, '42501', null,
  'inv_08_token_rpcs_hashed_secrets: nor the access code hash');
select throws_ok($$update app.live_links set expires_at = now() + interval '80 days' where id = (select id from k where key = 'v1')$$,
  '42501', null, 'a link is never edited directly');
select throws_ok($$insert into app.live_links (project_id, link_kind, saved_view_id, token_hash, token_hint, access_code_hash, expires_at)
  values ((select id from world where key = 'prj_a'), 'View', (select id from k where key = 'Milestones'), '\x00', 'abcd', '\x00', now() + interval '1 day')$$,
  '42501', null, 'nor inserted directly');
select is((select count(*)::int from app.live_links where id = pg_temp.id_k('v1')), 1, 'the creator reads the link, without the hashes');
select pg_temp.as_platform();
select throws_ok($$update app.live_links set note = 'changed' where id = (select id from k where key = 'v1')$$, 'XR001', null,
  'even the platform changes a link only through its RPCs');

-- Refusals --------------------------------------------------------------------------------------------------------
select is(pg_temp.view_link('dave', 'x', 'Milestones', 'prj_a', null), 'live_link_expiry', 'a link needs an expiry');
select is(pg_temp.view_link('dave', 'x', 'Milestones', 'prj_a', now() + interval '91 days'), 'live_link_expiry_range',
  'and expires within 90 days');
select is(pg_temp.view_link('dave', 'x', 'Milestones', 'prj_a', now() - interval '1 minute'), 'live_link_expiry_range',
  'and after now');
select is(pg_temp.view_link('dave', 'x', 'All records', 'prj_a', now() + interval '7 days'), 'live_link_view_unsupported',
  'a collection outside the four allowlisted ones is refused');
select is(pg_temp.view_link('dave', 'x', 'Custom field view', 'prj_a', now() + interval '7 days'), 'live_link_view_unsupported',
  'a custom field condition is refused');
select is(pg_temp.view_link('dave', 'x', 'Owner view', 'prj_a', now() + interval '7 days'), 'live_link_view_unsupported',
  'a condition on a field outside the allowlist is refused');
select is(pg_temp.view_link('dave', 'x', 'Other project', 'prj_a', now() + interval '7 days'), 'live_link_view_unsupported',
  'a project parameter naming another project is refused');
select is(pg_temp.view_link('dave', 'x', 'Updated sort', 'prj_a', now() + interval '7 days'), 'live_link_view_unsupported',
  'a sort on a field outside the allowlist is refused');
select is(pg_temp.view_link('dave', 'month', 'Calendar month', 'prj_a', now() + interval '7 days'), 'ok',
  'month is not a filter and is ignored; an f.<field> condition on a filterable field is allowed');
select is(pg_temp.view_link('erin', 'x', 'Milestones', 'prj_a', now() + interval '7 days'), 'live_link_capability',
  'a Collaborator without schedule.timeline.export cannot share the view');
select is(pg_temp.view_link('erin', 'x', 'Private milestones', 'prj_a', now() + interval '7 days'), '42501',
  'nor share a view she cannot read');
select is(pg_temp.view_link('dave', 'x', 'Milestones', 'prj_a2', now() + interval '7 days'), 'live_link_capability',
  'nor may dave share it on a project he is not assigned to');
select is(pg_temp.view_link('xavier', 'x', 'Milestones', 'prj_a', now() + interval '7 days'), '42501',
  'another org''s Owner never reaches the view');

do $$
begin
  for i in 1 .. 18 loop
    perform pg_temp.view_link('dave', 'bulk' || i, 'Milestones', 'prj_a', now() + interval '7 days');
  end loop;
end $$;
select is((select count(*)::int from app.live_links where saved_view_id = pg_temp.id_k('Milestones')), 19, 'the view holds 19 live links');
select is(pg_temp.view_link('dave', 'v20', 'Milestones', 'prj_a', now() + interval '7 days'), 'ok', 'the 20th is allowed');
select is(pg_temp.view_link('dave', 'x', 'Milestones', 'prj_a', now() + interval '7 days'), 'live_link_limit',
  'the 21st live link of a view is refused');

-- Display links ---------------------------------------------------------------------------------------------------
select is(pg_temp.display_link('dave', 'd1', 'ros'), 'ok', 'a holder of show.run_of_show.write makes a display screen link');
select results_eq($$select link_kind::text, default_mode::text, project_id from app.live_links where id = (select id from k where key = 'd1')$$,
  $$values ('Display'::text, 'Backstage'::text, (select id from world where key = 'prj_a'))$$,
  'it opens in Backstage, and its project is stamped from the running order');
select matches(pg_temp.val('d1'), '^xscr_[0-9a-f]{64}$', 'a display token is xscr_ and 32 random bytes');
select ok((select expires_at between now() + interval '89 days' and now() + interval '90 days' from app.live_links where id = pg_temp.id_k('d1')),
  'a show more than 90 days ahead defaults to 90 days');
select is(pg_temp.display_link('dave', 'd_soon', 'ros_soon'), 'ok', 'a link to next week''s show');
select is((select expires_at from app.live_links where id = pg_temp.id_k('d_soon')),
  ((current_date + 7)::timestamp at time zone 'America/New_York'),
  'defaults to the end of the day after the show, in the project''s zone');
select is(pg_temp.display_link('dave', 'd_past', 'ros_past'), 'ok', 'a link to a show already past');
select ok((select expires_at between now() + interval '23 hours' and now() + interval '25 hours' from app.live_links where id = pg_temp.id_k('d_past')),
  'gets a day from now');
select is(pg_temp.display_link('gina', 'x', 'ros'), 'live_link_capability', 'a Viewer with only show.run_of_show.read is refused');

-- A partner org that reaches the project through a share, even with the write capability, never publishes it.
select pg_temp.as_platform();
insert into private.project_role_capabilities (project_role, capability_code) values
  ('Field Supervisor', 'show.run_of_show.read'), ('Field Supervisor', 'show.run_of_show.write') on conflict do nothing;
select pg_temp.as_user('bob');
insert into app.project_shares (project_id, partner_organization_id, project_role)
values (pg_temp.id('prj_a'), pg_temp.id('org_p'), 'Field Supervisor');
select pg_temp.claims('paul');
select ok(private.can_on_project(pg_temp.id('prj_a'), 'show.run_of_show.write'), 'the partner holds the write capability through the share');
select is(pg_temp.display_link('paul', 'x', 'ros'), '42501', 'but a partner-org member cannot make a public link to the owner org''s show');
select pg_temp.as_platform();

-- Every link has a code.
select is((select count(*)::int from app.live_links where access_code_hash is null or octet_length(access_code_hash) <> 32), 0,
  'every link carries an access code hash');

-- Reading the list ------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select is((select count(*)::int from app.live_links where link_kind = 'Display'), 3, 'a Viewer with show.run_of_show.read sees the display links');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.live_links), 0, 'another org reads none');
select pg_temp.as_user('paul');
select is((select count(*)::int from app.live_links), 0, 'nor does the partner org');

-- States, regeneration and revocation -----------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select link_state from app.live_link_states where id = pg_temp.id_k('v1')), 'Active', 'a new link is Active');
select pg_temp.as_platform();
insert into private.live_link_grants (grant_hash, live_link_id, expires_at)
values (extensions.digest('xlgr_test', 'sha256'), pg_temp.id_k('v1'), now() + interval '1 day');
insert into k select 'v1:channel', null, channel_key from private.live_link_channels where live_link_id = pg_temp.id_k('v1');
insert into k select 'v1:old_hash', null, encode(token_hash, 'hex') from app.live_links where id = pg_temp.id_k('v1');

select pg_temp.as_user('gina');
select throws_ok($$select * from app.regenerate_live_link((select id from k where key = 'v1'))$$, '42501', null,
  'someone who neither made the link nor holds the share capability cannot regenerate it');
select pg_temp.as_user('dave');
insert into k select 'v1:new', null, r.token from app.regenerate_live_link(pg_temp.id_k('v1')) r;
select pg_temp.as_platform();
select ok(pg_temp.val('v1:new') ~ '^xshv_[0-9a-f]{64}$' and pg_temp.val('v1:new') <> pg_temp.val('v1'), 'regenerating returns a new token');
select results_eq($$select token_hash = extensions.digest((select val from k where key = 'v1:new'), 'sha256'), rotated_at is not null, failed_attempts::int
  from app.live_links where id = (select id from k where key = 'v1')$$, $$values (true, true, 0)$$,
  'the new token''s hash replaces the old one and rotated_at is set');
select ok(exists (select 1 from private.retired_live_link_tokens where token_hash = decode(pg_temp.val('v1:old_hash'), 'hex')),
  'the old token is retired');
select is((select count(*)::int from private.live_link_grants where live_link_id = pg_temp.id_k('v1')), 0, 'every device grant is dropped');
select isnt((select channel_key from private.live_link_channels where live_link_id = pg_temp.id_k('v1')), pg_temp.val('v1:channel'),
  'and the channel key is redrawn');

select pg_temp.as_user('dave');
insert into k values ('v1:revoked', null, app.revoke_live_link(pg_temp.id_k('v1'))::text);
select is(app.revoke_live_link(pg_temp.id_k('v1'))::text, pg_temp.val('v1:revoked'), 'revoking twice answers the first revocation time');
select is((select link_state from app.live_link_states where id = pg_temp.id_k('v1')), 'Revoked', 'a revoked link is Revoked');
select throws_ok($$select * from app.regenerate_live_link((select id from k where key = 'v1'))$$, 'XR001', null,
  'a revoked link is never regenerated');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type in ('live_link.created', 'live_link.regenerated', 'live_link.revoked')
  and subject_id = pg_temp.id_k('v1')), 3, 'making, regenerating and revoking emit their events');

-- The allowlist -----------------------------------------------------------------------------------------------------
select throws_ok($$insert into private.live_view_fields (collection_key, field_key, part, source_table, source_columns, value_type)
  select 'project/schedule', 'secret', 'row', c.table_name, array[c.column_name], 'text' from private.column_classifications c
  where c.classification in ('Confidential', 'Restricted') and c.table_name like 'app.%' limit 1$$,
  'XR001', null, 'a Confidential or Restricted source column is refused (live_view_field_classified)');
select is_empty($$
  select f.collection_key || ' ' || f.field_key from private.live_view_fields f
  cross join lateral unnest(f.source_columns) as col (name)
  join private.column_classifications c on c.table_name = f.source_table and c.column_name = col.name
  where c.classification in ('Confidential', 'Restricted')
$$, 'no allowlisted source column is classified Confidential or Restricted');

-- Trash, backups and the read-only exemption ---------------------------------------------------------------------
select ok(exists (select 1 from private.trash_excluded_tables where table_name = 'live_links'), 'live links are kept out of Trash');
select ok(not exists (select 1 from private.trash_tables where table_name = 'live_links'), 'and sync_trash_tables leaves them out');
select ok(not has_table_privilege('xos_backup', 'app.live_link_states', 'select'), 'the backup login reads no computed link state');
select ok(exists (select 1 from private.read_only_exempt_tables where table_name = 'app.live_links'), 'revocation is exempt from the read-only guard');
select hasnt_trigger('app', 'live_links', 't15_refuse_read_only_org', 'so the read-only guard is not installed on live links');

-- A read-only org: nothing new, but revocation still works.
select pg_temp.as_user('alice');
select app.cancel_organization(pg_temp.id('org_a'), 'Northwind Live', 'Season over; moving to another tool.');
select pg_temp.as_platform();
select is(pg_temp.display_link('dave', 'x', 'ros_soon'), 'org_read_only', 'a read-only org makes no new link');
select pg_temp.as_user('dave');
select throws_ok($$select * from app.regenerate_live_link((select id from k where key = 'd1'))$$, 'XR001', null,
  'nor regenerates one');
select lives_ok($$select app.revoke_live_link((select id from k where key = 'd1'))$$, 'but revoking still withdraws access');

select * from finish();
rollback;
