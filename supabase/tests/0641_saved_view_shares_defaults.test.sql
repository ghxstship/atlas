-- pgTAP: saved view team shares, defaults per page and the widened view types (A31, Section 11.15).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(24);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- View types ----------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$insert into app.saved_views (membership_id, collection_key, name, view_type) values
  (pg_temp.id('dave@org_a'), 'places/venues', 'Venues On The Map', 'Map')$$, 'a map view can be saved');
insert into app.saved_views (membership_id, collection_key, name, view_type, search_text) values
  (pg_temp.id('dave@org_a'), 'logistics/shipments', 'Inbound This Week', 'Board', 'inbound'),
  (pg_temp.id('dave@org_a'), 'logistics/shipments', 'All Shipments', 'Table', null);
insert into k select 'inbound', id from app.saved_views where name = 'Inbound This Week';
insert into k select 'all', id from app.saved_views where name = 'All Shipments';
insert into k select 'map', id from app.saved_views where name = 'Venues On The Map';
insert into app.saved_view_filters (saved_view_id, field, operator, value_text) values ((select id from k where key = 'inbound'), 'direction', 'eq', 'Inbound');

-- Team shares ------------------------------------------------------------------------------------------------
select pg_temp.as_user('erin');
select is((select count(*)::integer from app.saved_views where membership_id = pg_temp.id('dave@org_a')), 0, 'a private view is hidden from teammates');
select throws_ok($$insert into app.saved_view_shares (saved_view_id, team_id) values ((select id from k where key = 'inbound'), pg_temp.id('team_a'))$$,
  '42501', null, 'only the owner shares a view');

select pg_temp.as_user('dave');
select lives_ok($$insert into app.saved_view_shares (saved_view_id, team_id) values ((select id from k where key = 'inbound'), pg_temp.id('team_a'))$$,
  'the owner shares a view with a team');
select throws_ok($$insert into app.saved_view_shares (saved_view_id, team_id) values ((select id from k where key = 'inbound'), pg_temp.id('team_a'))$$,
  '23505', null, 'a view is shared with a team once');

select pg_temp.as_user('erin');
select is((select count(*)::integer from app.saved_views where membership_id = pg_temp.id('dave@org_a')), 1, 'a team member reads the view shared with the team');
select is((select count(*)::integer from app.saved_view_filters where saved_view_id = (select id from k where key = 'inbound')), 1,
  'a team member reads the shared view''s filters');
select is((select count(*)::integer from app.saved_view_shares), 1, 'a team member reads the share');

select pg_temp.as_user('gina');
select is((select count(*)::integer from app.saved_views where membership_id = pg_temp.id('dave@org_a')), 0, 'a member outside the team does not read a team view');
select is((select count(*)::integer from app.saved_view_shares), 0, 'a member outside the team does not read the share');

select pg_temp.as_user('xavier');
insert into app.teams (org_id, name) values (pg_temp.id('org_b'), 'Harbor Crew Leads');
insert into k select 'team_b', id from app.teams where name = 'Harbor Crew Leads';
select is((select count(*)::integer from app.saved_view_shares), 0, 'no cross-tenant share reads');

select pg_temp.as_user('dave');
select throws_ok($$insert into app.saved_view_shares (saved_view_id, team_id) values ((select id from k where key = 'inbound'), (select id from k where key = 'team_b'))$$,
  'XR001', null, 'a view is never shared with another org''s team');
select throws_ok($$update app.saved_view_shares set team_id = (select id from k where key = 'team_b')$$,
  'XR001', null, 'a share keeps its team');
select lives_ok($$update app.saved_view_shares set deleted_at = now()$$, 'the owner unshares a view');
select pg_temp.as_user('erin');
select is((select count(*)::integer from app.saved_views where membership_id = pg_temp.id('dave@org_a')), 0, 'unsharing hides the view again');

-- Defaults per page -----------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
update app.saved_views set shared = true where id = (select id from k where key = 'inbound');
select pg_temp.as_user('erin');
select lives_ok($$select app.set_saved_view_default((select id from k where key = 'inbound'))$$, 'a member makes a view shared with them their default');
select is((select saved_view_id from app.saved_view_defaults where deleted_at is null and collection_key = 'logistics/shipments'),
  (select id from k where key = 'inbound'), 'the default is recorded for the page');
select throws_ok($$select app.set_saved_view_default((select id from k where key = 'all'))$$,
  '42501', null, 'a private view of someone else cannot be a default');
select throws_ok($$insert into app.saved_view_defaults (membership_id, collection_key, saved_view_id) values
  (pg_temp.id('erin@org_a'), 'logistics/shipments_b', (select id from k where key = 'all'))$$,
  'XR001', null, 'a default must be readable');
select throws_ok($$insert into app.saved_view_defaults (membership_id, collection_key, saved_view_id) values
  (pg_temp.id('erin@org_a'), 'places/venues', (select id from k where key = 'inbound'))$$,
  'XR001', null, 'a default belongs to its view''s page');

select pg_temp.as_user('dave');
select app.set_saved_view_default((select id from k where key = 'inbound'));
select app.set_saved_view_default((select id from k where key = 'all'));
select is((select count(*)::integer from app.saved_view_defaults where deleted_at is null and collection_key = 'logistics/shipments'), 1,
  'choosing a new default replaces the earlier one');
select pg_temp.as_user('erin');
select is((select count(*)::integer from app.saved_view_defaults where membership_id = pg_temp.id('dave@org_a')), 0, 'defaults are private to their member');

select pg_temp.as_anon();
select throws_ok($$select count(*) from app.saved_view_defaults$$, '42501', null, 'anon reads no defaults');
select throws_ok($$select count(*) from app.saved_view_shares$$, '42501', null, 'anon reads no shares');

select * from finish();
rollback;
