-- pgTAP: migration 1022, the api_external projections Compass's external sync buckets select (Section 8.7).
-- Projects, radio channels and the caller's own clock punches: engaged-party allow (own engagement and a
-- representation), unengaged deny, cross-org deny, anon deny, the time box and the internal columns that never appear.
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

select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');

insert into app.radio_channels (project_id, channel_number, name) values (pg_temp.id('prj_a'), 3, 'Stage Management');
insert into app.radio_channels (project_id, channel_number, name) values (pg_temp.id('prj_b'), 5, 'Harbor Security');
insert into app.clock_punches (id, project_id, engagement_id, punch_kind, device_time, received_at, effective_at, skew_flagged, source, latitude, longitude)
values (gen_random_uuid(), pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), 'In', '2027-06-01 12:00+00', '2027-06-01 12:00+00', '2027-06-01 12:00+00', false, 'Mobile', 25.7617, -80.1918);

-- Projects ------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from api_external.projects'), 1, 'own engagement: ivy reads the project she works on');
select pg_temp.as_user('ivy');
select is((select name from api_external.projects), 'Northwind Summer Series', 'by name');
select pg_temp.as_platform();
select is(pg_temp.n('rita', 'select 1 from api_external.projects'), 1, 'representation: the Advance representative reads the artist''s project');
select is(pg_temp.n('quinn', 'select 1 from api_external.projects'), 0, 'unengaged deny: an engagement still Onboarding opens no project');
select is(pg_temp.n('xavier', 'select 1 from api_external.projects'), 0, 'cross-org deny');
select hasnt_column('api_external', 'projects', 'production_state', 'internal project state never appears');
select hasnt_column('api_external', 'projects', 'client_counterparty_id', 'the client never appears');

-- Radio channels --------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from api_external.radio_channels'), 1, 'own engagement: the channel plan of ivy''s project only');
select is(pg_temp.n('quinn', 'select 1 from api_external.radio_channels'), 0, 'unengaged deny');
select is(pg_temp.n('xavier', 'select 1 from api_external.radio_channels'), 0, 'cross-org deny: internal members read channels in Atlas');

-- Clock punches ------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from api_external.clock_punches'), 1, 'own engagement: ivy reads her punch');
select is(pg_temp.n('art', 'select 1 from api_external.clock_punches'), 0, 'unengaged deny: another party on the same project');
select is(pg_temp.n('quinn', 'select 1 from api_external.clock_punches'), 0, 'unengaged deny');
select is(pg_temp.n('xavier', 'select 1 from api_external.clock_punches'), 0, 'cross-org deny');
select hasnt_column('api_external', 'clock_punches', 'latitude', 'location never appears');
select hasnt_column('api_external', 'clock_punches', 'kiosk_device_id', 'the kiosk device never appears');

-- Time box ------------------------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select is(pg_temp.n('ivy', 'select 1 from api_external.projects'), 0, 'Complete: the project closes with the operational area');
select is(pg_temp.n('ivy', 'select 1 from api_external.radio_channels'), 0, 'Complete: radio channels close');
select is(pg_temp.n('ivy', 'select 1 from api_external.clock_punches'), 0, 'Complete: punches close');

select pg_temp.as_anon();
select throws_ok('select 1 from api_external.projects', '42501', null, 'anon deny: projects');
select throws_ok('select 1 from api_external.radio_channels', '42501', null, 'anon deny: radio channels');
select throws_ok('select 1 from api_external.clock_punches', '42501', null, 'anon deny: clock punches');
select pg_temp.as_platform();

select * from finish();
rollback;
