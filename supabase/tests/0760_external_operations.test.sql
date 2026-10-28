-- pgTAP: Section 8.7 operational projections for external Compass (migration 0760): run of show and cues (Client
-- reads all, Artist reads only their set), day sheets, dock slots (Vendor reads its own shipments), credentials (own
-- badges, and the artist's through an Advance representation). For each: access through the party's own
-- engagement, an account engagement and a representation where they apply, denial for another party, denial
-- before Active and after Complete. Also app.engagement_cues: RLS (same tenant, cross tenant, anon, role band),
-- its invariants and their refusals.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Fixture: a Client party (cleo of Coral Group), a running order with the artist's set, day sheets, dock slots and
-- badges. --------------------------------------------------------------------------------------------------------------
create function pg_temp.build_operations() returns void
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.new_user('cleo', 'cleo@coral-group.test', 'Cleo Marsh');
  perform pg_temp.as_user('cleo');
  insert into world values ('acct_c', app.create_external_account('Coral Group', 'coral-group'));

  perform pg_temp.as_user('alice');
  insert into world values ('cp_c_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_c')));
  insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cleo'), pg_temp.id('cp_c_a'), 'Client', '2027-06-01') returning id into v_id;
  insert into world values ('eng_client_a', v_id);

  insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night Running Order', '2027-06-02') returning id into v_id;
  insert into world values ('ros_a', v_id);
  insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros_a'), 1, 'Doors') returning id into v_id;
  insert into world values ('cue_doors', v_id);
  insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros_a'), 2, 'Headliner Set') returning id into v_id;
  insert into world values ('cue_set', v_id);
  insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros_a'), 3, 'House Lights') returning id into v_id;
  insert into world values ('cue_house', v_id);
  insert into app.run_of_show (project_id, name, show_date)
  values (pg_temp.id('prj_a2'), 'Winter Gala Running Order', '2027-12-12') returning id into v_id;
  insert into world values ('ros_a2', v_id);
  insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros_a2'), 1, 'Gala Welcome') returning id into v_id;
  insert into world values ('cue_gala', v_id);
  insert into app.engagement_cues (engagement_id, cue_id) values (pg_temp.id('eng_art_a'), pg_temp.id('cue_set')) returning id into v_id;
  insert into world values ('set_art', v_id);

  insert into app.day_sheets (project_id, day, body) values (pg_temp.id('prj_a'), '2027-06-02', 'Load in 08:00. Doors 19:00.');

  insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'DOCK-A', 'North Loading Dock') returning id into v_id;
  insert into world values ('zone_dock', v_id);
  insert into app.shipments (project_id, direction, carrier_counterparty_id, tracking_identifier)
  values (pg_temp.id('prj_a'), 'Inbound', pg_temp.id('cp_v_a'), 'BAY-1001') returning id into v_id;
  insert into world values ('ship_v', v_id);
  insert into app.shipments (project_id, direction, tracking_identifier)
  values (pg_temp.id('prj_a'), 'Inbound', 'OTHER-2002') returning id into v_id;
  insert into world values ('ship_other', v_id);
  insert into app.dock_slots (project_id, zone_id, shipment_id, starts_at, ends_at) values
    (pg_temp.id('prj_a'), pg_temp.id('zone_dock'), pg_temp.id('ship_v'), '2027-06-01 08:00+00', '2027-06-01 09:00+00'),
    (pg_temp.id('prj_a'), pg_temp.id('zone_dock'), pg_temp.id('ship_other'), '2027-06-01 10:00+00', '2027-06-01 11:00+00');

  insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id into v_id;
  insert into world values ('cat_crew', v_id);
  insert into app.credentials (credential_category_id, holder_person_id) values
    (pg_temp.id('cat_crew'), pg_temp.id('ivy')), (pg_temp.id('cat_crew'), pg_temp.id('art')), (pg_temp.id('cat_crew'), pg_temp.id('sam'));

  perform pg_temp.as_xavier_day_sheet();
end $$;

create function pg_temp.as_xavier_day_sheet() returns void
language plpgsql as $$
begin
  perform pg_temp.as_user('xavier');
  insert into app.day_sheets (project_id, day, body) values (pg_temp.id('prj_b'), '2027-07-01', 'Harbor load in 07:00.');
  perform pg_temp.as_platform();
end $$;

select pg_temp.build_operations();

-- Before Active, no operational area is open ------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from api_external.credentials'), 0, 'Onboarding: a badge stays hidden until the engagement is Active');
select is(pg_temp.n('cleo', 'select 1 from api_external.run_of_show'), 0, 'Onboarding: the client reads no running order yet');
select is(pg_temp.n('ivy', 'select 1 from api_external.day_sheets'), 0, 'Onboarding: no day sheets yet');
select is(pg_temp.n('victor', 'select 1 from api_external.dock_slots'), 0, 'Onboarding: no dock slots yet');

select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_client_a', 'Onboarding', 'Active');

-- Run of show and cues ------------------------------------------------------------------------------------------------
select is(pg_temp.n('cleo', 'select 1 from api_external.run_of_show'), 1, 'own engagement: the Client reads the running order of their project');
select is(pg_temp.n('cleo', 'select 1 from api_external.cues'), 3, 'the Client reads every cue of it');
select is(pg_temp.n('cleo', $$select 1 from api_external.run_of_show where id = '$$ || pg_temp.id('ros_a2') || $$'$$), 0,
  'denial: no running order of a project the Client is not engaged on');
select is(pg_temp.n('art', 'select 1 from api_external.run_of_show'), 1, 'the artist reads the running order that holds their set');
select is(pg_temp.n('art', 'select 1 from api_external.cues'), 1, 'the artist reads only their set time');
select pg_temp.as_user('art');
select is((select label from api_external.cues), 'Headliner Set', 'the artist''s cue is their set');
select ok((select is_my_set from api_external.cues), 'the set is flagged as the caller''s own');
select pg_temp.as_platform();
select is(pg_temp.n('rita', 'select 1 from api_external.cues'), 1, 'representation: the Advance representative reads the artist''s set');
select is(pg_temp.n('ivy', 'select 1 from api_external.run_of_show'), 0, 'denial: Crew read no running order');
select is(pg_temp.n('ivy', 'select 1 from api_external.cues'), 0, 'denial: Crew read no cues');
select is(pg_temp.n('quinn', 'select 1 from api_external.cues'), 0, 'denial: a stranger to the project reads no cues');
select is(pg_temp.n('dave', 'select 1 from api_external.cues'), 0, 'internal members read no external projections');

-- Day sheets -----------------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from api_external.day_sheets'), 1, 'own engagement: Crew read the day sheet of their Active project only');
select is(pg_temp.n('cleo', 'select 1 from api_external.day_sheets'), 1, 'the Client reads the day sheet');
select is(pg_temp.n('rita', 'select 1 from api_external.day_sheets'), 1, 'representation: the Advance representative reads the day sheet');
select is(pg_temp.n('quinn', 'select 1 from api_external.day_sheets'), 0, 'denial: another org''s Onboarding party reads none');
select is(pg_temp.n('fiona', 'select 1 from api_external.day_sheets'), 0, 'denial: Account Finance has no operational area');

-- Dock slots -----------------------------------------------------------------------------------------------------------
select is(pg_temp.n('victor', 'select 1 from api_external.dock_slots'), 1, 'account engagement: the vendor''s Owner reads its own shipment''s slot only');
select pg_temp.as_user('victor');
select is((select tracking_identifier from api_external.dock_slots), 'BAY-1001', 'the slot is the vendor''s own shipment');
select pg_temp.as_platform();
select is(pg_temp.n('sam', 'select 1 from api_external.dock_slots'), 1, 'own engagement: the supplied technician reads the slot');
select is(pg_temp.n('fiona', 'select 1 from api_external.dock_slots'), 0, 'denial: Account Finance has no operational area');
select is(pg_temp.n('cleo', 'select 1 from api_external.dock_slots'), 0, 'denial: a Client reads no dock slots');
select is(pg_temp.n('ivy', 'select 1 from api_external.dock_slots'), 0, 'denial: Crew read no dock slots');

-- Credentials ----------------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from api_external.credentials'), 1, 'own engagement: ivy reads her own badge only');
select is(pg_temp.n('art', 'select 1 from api_external.credentials'), 1, 'the artist reads their own badge');
select is(pg_temp.n('rita', 'select 1 from api_external.credentials'), 1, 'representation: the Advance representative reads the artist''s badge');
select is(pg_temp.n('sam', 'select 1 from api_external.credentials'), 1, 'the supplied technician reads his own badge');
select is(pg_temp.n('victor', 'select 1 from api_external.credentials'), 1, 'the account Owner reads the badge of the person the account supplies (R1, migration 2601)');
select is(pg_temp.n('fiona', 'select 1 from api_external.credentials'), 0, 'denial: Account Finance never reads a supplied person''s badge');
select is(pg_temp.n('quinn', 'select 1 from api_external.credentials'), 0, 'denial: another party reads no badge');

-- Complete closes the operational area -----------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select is(pg_temp.n('ivy', 'select 1 from api_external.credentials'), 0, 'Complete: the badge closes with the operational area');
select is(pg_temp.n('ivy', 'select 1 from api_external.day_sheets'), 0, 'Complete: day sheets close');

-- Projection hygiene (caught by the 0750 catalog checks too) -----------------------------------------------------------------
select hasnt_column('api_external', 'cues', 'called_by', 'who called a cue never reaches externals');
select hasnt_column('api_external', 'credentials', 'issued_by', 'who issued a badge never reaches externals');
select hasnt_column('api_external', 'credentials', 'revoked_by', 'who revoked a badge never reaches externals');
select pg_temp.as_anon();
select throws_ok('select 1 from api_external.cues', '42501', null, 'anon cannot read cues');
select throws_ok('select 1 from api_external.credentials', '42501', null, 'anon cannot read badges');
select pg_temp.as_platform();

-- app.engagement_cues: RLS ----------------------------------------------------------------------------------------------------
select is(pg_temp.n('alice', 'select 1 from app.engagement_cues'), 1, 'same tenant: the Owner reads set times');
select is(pg_temp.n('xavier', 'select 1 from app.engagement_cues'), 0, 'cross tenant: another org reads none');
select is(pg_temp.n('art', 'select 1 from app.engagement_cues'), 0, 'the app table is internal; externals read through api_external');
select pg_temp.as_anon();
select throws_ok('select 1 from app.engagement_cues', '42501', null, 'anon deny');
select pg_temp.as_platform();
select pg_temp.as_user('gina');
select throws_ok(format($$insert into app.engagement_cues (engagement_id, cue_id) values ('%s', '%s')$$,
  pg_temp.id('eng_art_a'), pg_temp.id('cue_doors')), '42501', null, 'role band: a Viewer cannot add a set time');
select pg_temp.as_platform();
select pg_temp.as_user('carol');
select lives_ok(format($$insert into app.engagement_cues (engagement_id, cue_id) values ('%s', '%s')$$,
  pg_temp.id('eng_art_a'), pg_temp.id('cue_house')), 'role band: a Manager adds a set time');

-- app.engagement_cues: invariants ---------------------------------------------------------------------------------------------
select throws_ok(format($$insert into app.engagement_cues (engagement_id, cue_id) values ('%s', '%s')$$,
  pg_temp.id('eng_ivy_a'), pg_temp.id('cue_doors')), 'XR001', null, 'set times belong only to artist engagements');
select throws_ok(format($$insert into app.engagement_cues (engagement_id, cue_id) values ('%s', '%s')$$,
  pg_temp.id('eng_art_a'), pg_temp.id('cue_gala')), 'XR001', null, 'a set time is a cue of the engagement''s own project');
select throws_ok(format($$update app.engagement_cues set cue_id = '%s' where id = '%s'$$,
  pg_temp.id('cue_doors'), pg_temp.id('set_art')), '42501', null, 'cue_id is not writable after insert');
select throws_ok(format($$insert into app.engagement_cues (engagement_id, cue_id) values ('%s', '%s')$$,
  pg_temp.id('eng_art_a'), pg_temp.id('cue_set')), '23505', null, 'a cue is one set time of an engagement once');
select pg_temp.as_platform();
select throws_ok(format($$update app.engagement_cues set cue_id = '%s' where id = '%s'$$,
  pg_temp.id('cue_doors'), pg_temp.id('set_art')), 'XR001', null, 'a set time keeps its engagement and cue on every path');
select pg_temp.as_user('carol');
select lives_ok(format($$update app.engagement_cues set deleted_at = now() where id = '%s'$$, pg_temp.id('set_art')),
  'a set time is removed by soft delete');
select pg_temp.as_platform();
select is(pg_temp.n('art', 'select 1 from api_external.cues where label = ''Headliner Set'''), 0, 'a removed set time leaves the artist''s view');

select * from finish();
rollback;
