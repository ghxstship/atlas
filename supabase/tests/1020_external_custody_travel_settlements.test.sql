-- pgTAP: migration 1020, api_external projections over the module late slots (Section 8.7, ADR 0019 item 5).
-- Asset custody, travel, settlements and their lines, shared reports, per diems, cue projects and opportunity
-- coordinates. Each view: engaged-party allow (own engagement, and a representation or account where it applies),
-- cross-org deny, unengaged deny, anon deny, the time box and the internal-only columns that never appear.
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
select pg_temp.move_engagement('eng_quinn_b', 'Onboarding', 'Active');

-- Fixture (written as the platform; the views decide what each party reads) ------------------------------------------------
with x as (insert into app.asset_classes (org_id, element_id, name) values (pg_temp.id('org_a'), '9000.03.01-XPMS-003', 'Digital Two-Way Radio') returning id)
  insert into world select 'cls', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag, home_venue_id) values (pg_temp.id('cls'), 'NWL-RAD-101', pg_temp.id('venue_a')) returning id)
  insert into world select 'radio', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag, home_venue_id) values (pg_temp.id('cls'), 'NWL-RAD-102', pg_temp.id('venue_a')) returning id)
  insert into world select 'radio_returned', id from x;
insert into app.asset_custody (asset_unit_id, custodian_engagement_id, project_id, note, created_at)
values (pg_temp.id('radio'), pg_temp.id('eng_ivy_a'), pg_temp.id('prj_a'), 'Spare battery in the case.', now() - interval '2 hours'),
       (pg_temp.id('radio_returned'), pg_temp.id('eng_ivy_a'), pg_temp.id('prj_a'), null, now() - interval '3 hours');
insert into app.asset_custody (asset_unit_id, venue_id, created_at)
values (pg_temp.id('radio_returned'), pg_temp.id('venue_a'), now() - interval '1 hour');

insert into app.travel_segments (project_id, person_id, engagement_id, travel_mode, operator_name, service_identifier, confirmation_identifier,
  departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_at, arrives_time_zone, price_minor, currency_code)
values (pg_temp.id('prj_a'), pg_temp.id('ivy'), pg_temp.id('eng_ivy_a'), 'Flight', 'Fictional Air', 'FA 212', 'QZK4PL',
  'Newark', '2027-05-31 14:00+00', 'America/New_York', 'Miami', '2027-05-31 17:10+00', 'America/New_York', 41800, 'USD'),
  (pg_temp.id('prj_a'), pg_temp.id('art'), pg_temp.id('eng_art_a'), 'Ground', 'Harbor Car Service', null, null,
  'Miami Airport', '2027-06-01 15:00+00', 'America/New_York', 'Harbor Inn', null, 'America/New_York', null, null);

with x as (insert into app.settlements (engagement_id, title, currency_code, settled_on) values (pg_temp.id('eng_art_a'), 'Opening Night', 'USD', '2027-06-02') returning id)
  insert into world select 'stl', id from x;
insert into app.settlement_lines (settlement_id, line_number, line_kind, description, amount_minor) values
  (pg_temp.id('stl'), 1, 'Guarantee', 'Guarantee.', 500000),
  (pg_temp.id('stl'), 2, 'Withholding', 'Foreign performer withholding.', 60000);
with x as (insert into app.settlements (engagement_id, title, currency_code) values (pg_temp.id('eng_art_a'), 'Second Night Draft', 'USD') returning id)
  insert into world select 'stl_draft', id from x;

with x as (insert into app.report_definitions (membership_id, name, source_code) values (pg_temp.id('carol@org_a'), 'Show Spend', 'finance') returning id)
  insert into world select 'rdef', id from x;
with x as (insert into app.report_runs (report_definition_id, run_for_membership_id, export_format, run_status, started_at, finished_at, row_count, unpriced_count)
  values (pg_temp.id('rdef'), pg_temp.id('carol@org_a'), 'PDF', 'Succeeded', now(), now(), 12, 1) returning id)
  insert into world select 'run', id from x;
with x as (insert into app.shared_reports (engagement_id, project_id, report_run_id, title) values (pg_temp.id('eng_ivy_a'), pg_temp.id('prj_a'), pg_temp.id('run'), 'Show Spend to Date') returning id)
  insert into world select 'share', id from x;

-- Per diem is an offering since R3 (2625): prj_a offers it.
insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_text, locked)
values (pg_temp.id('org_a'), 'offerings.per_diem', 'Project', pg_temp.id('prj_a'), 'provided', false);
insert into app.per_diems (project_id, engagement_id, day, amount_minor, currency_code)
values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-06-01', 6500, 'USD');

-- Asset custody -------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from api_external.asset_custody'), 1, 'own engagement: the unit ivy holds now, not the one she returned');
select pg_temp.as_user('ivy');
select is((select asset_tag from api_external.asset_custody), 'NWL-RAD-101', 'the unit reads by its tag');
select is((select class_name from api_external.asset_custody), 'Digital Two-Way Radio', 'with its class');
select pg_temp.as_platform();
select is(pg_temp.n('quinn', 'select 1 from api_external.asset_custody'), 0, 'unengaged deny: another freelancer');
select is(pg_temp.n('xavier', 'select 1 from api_external.asset_custody'), 0, 'cross-org deny: another tenant''s member');
select is(pg_temp.n('alice', 'select 1 from api_external.asset_custody'), 0, 'internal members read custody in Atlas, never through api_external');
select hasnt_column('api_external', 'asset_custody', 'note', 'handover notes never reach externals');

-- Travel -------------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from api_external.travel'), 1, 'own engagement: ivy reads her flight only');
select is(pg_temp.n('art', 'select 1 from api_external.travel'), 1, 'own engagement: the artist reads the car');
select is(pg_temp.n('rita', 'select 1 from api_external.travel'), 1, 'representation: the Advance representative reads the artist''s travel');
select is(pg_temp.n('quinn', 'select 1 from api_external.travel'), 0, 'unengaged deny');
select is(pg_temp.n('xavier', 'select 1 from api_external.travel'), 0, 'cross-org deny');
select is(pg_temp.n('victor', 'select 1 from api_external.travel'), 0, 'deny: a vendor account with its own engagement');
select hasnt_column('api_external', 'travel', 'price_minor', 'what the org paid never reaches externals');

-- Settlements ----------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('art', 'select 1 from api_external.settlements'), 0, 'a draft settlement never reaches the party');
select private.transition_lifecycle('settlement', 'app.settlements', 'settlement_state', 'app.settlement_state_transitions',
  'settlement_id', pg_temp.id('stl'), 'Proposed', 'Submitted', 'Fixture submission.');
select is(pg_temp.n('art', 'select 1 from api_external.settlements'), 1, 'own engagement: the submitted settlement, not the draft');
select is(pg_temp.n('art', 'select 1 from api_external.settlement_lines'), 2, 'with its lines');
select pg_temp.as_user('art');
select is((select net_minor from api_external.settlements), 440000::bigint, 'the net subtracts withholding');
select ok((select submitted_at is not null and responded_at is null from api_external.settlements), 'submitted, not yet answered');
select pg_temp.as_platform();
select is(pg_temp.n('ivy', 'select 1 from api_external.settlements'), 0, 'unengaged deny: another party');
select is(pg_temp.n('ivy', 'select 1 from api_external.settlement_lines'), 0, 'unengaged deny on lines');
select is(pg_temp.n('xavier', 'select 1 from api_external.settlements'), 0, 'cross-org deny');
select is(pg_temp.n('rita', 'select 1 from api_external.settlements'), 0, 'a representative without a money scope reads none');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.respond_to_settlement('%s', true, 'Not mine.')$$, pg_temp.id('stl')), '42501', null, 'another party cannot answer');
select pg_temp.as_user('art');
select lives_ok(format($$select app.respond_to_settlement('%s', false, 'The withholding rate is wrong.')$$, pg_temp.id('stl')), 'the artist disputes through the RPC');
select is((select settlement_state::text from api_external.settlements), 'Disputed', 'the dispute shows');
select ok((select responded_at is not null from api_external.settlements), 'with when it was answered');
select pg_temp.as_platform();
select private.transition_lifecycle('settlement', 'app.settlements', 'settlement_state', 'app.settlement_state_transitions',
  'settlement_id', pg_temp.id('stl'), 'Disputed', 'Proposed', 'Rework the withholding.');
select is(pg_temp.n('art', 'select 1 from api_external.settlements'), 0, 'a reworked settlement hides until submitted again');

-- Shared reports ----------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from api_external.shared_reports'), 1, 'own engagement: the shared report');
select pg_temp.as_user('ivy');
select is((select row_count from api_external.shared_reports), 12, 'with the run''s row count');
select pg_temp.as_platform();
select is(pg_temp.n('art', 'select 1 from api_external.shared_reports'), 0, 'unengaged deny: another engagement of the same project');
select is(pg_temp.n('quinn', 'select 1 from api_external.shared_reports'), 0, 'unengaged deny');
select is(pg_temp.n('xavier', 'select 1 from api_external.shared_reports'), 0, 'cross-org deny');
select hasnt_column('api_external', 'shared_reports', 'revoked_by', 'who revoked a share never appears');
select hasnt_column('api_external', 'shared_reports', 'report_run_id', 'the internal run id never appears');
update app.shared_reports set expires_at = now() - interval '1 minute' where id = pg_temp.id('share');
select is(pg_temp.n('ivy', 'select 1 from api_external.shared_reports'), 0, 'an expired share no longer opens');
update app.shared_reports set expires_at = null, revoked_at = now(), revoked_by = pg_temp.id('carol') where id = pg_temp.id('share');
select is(pg_temp.n('ivy', 'select 1 from api_external.shared_reports'), 0, 'a revoked share no longer opens');

-- Per diems ----------------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from api_external.per_diems'), 1, 'own engagement: the per diem');
select pg_temp.as_user('ivy');
select is((select amount_minor from api_external.per_diems), 6500::bigint, 'in minor units');
select pg_temp.as_platform();
select is(pg_temp.n('quinn', 'select 1 from api_external.per_diems'), 0, 'unengaged deny');
select is(pg_temp.n('xavier', 'select 1 from api_external.per_diems'), 0, 'cross-org deny');

-- Cues carry their project ---------------------------------------------------------------------------------------------------------------------
select has_column('api_external', 'cues', 'project_id', 'cues carry the project of their running order');
select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
  where table_schema = 'api_external' and table_name = 'cues'),
  array['id', 'run_of_show_id', 'position', 'label', 'planned_at', 'duration', 'called_at', 'is_my_set', 'project_id', 'start_tbc'],
  'project_id is appended, then start_tbc (2790); earlier columns keep their order');

-- Opportunity coordinates ------------------------------------------------------------------------------------------------------------------------
update app.venues set location = extensions.st_setsrid(extensions.st_makepoint(-80.1918, 25.7617), 4326)::extensions.geography where id = pg_temp.id('venue_a');
select pg_temp.as_user('carol');
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, venue_id, starts_on, ends_on, requisition_id)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Summer Series Riggers', 'Invited', pg_temp.id('venue_a'), '2027-06-01', '2027-06-03', pg_temp.id('requisition_a'))
  returning id) insert into world select 'opp', id from o;
insert into app.opportunity_invitations (opportunity_id, person_id) values (pg_temp.id('opp'), pg_temp.id('ivy'));
select app.transition_opportunity(pg_temp.id('opp'), 'Draft', 'Pending Approval', 'Ready.');
select app.transition_opportunity(pg_temp.id('opp'), 'Pending Approval', 'Published', 'Approved.');
select pg_temp.as_user('ivy');
select is((select round(venue_latitude::numeric, 4) from api_external.opportunities where id = pg_temp.id('opp')), 25.7617, 'the listing carries the venue latitude');
select is((select round(venue_longitude::numeric, 4) from api_external.opportunities where id = pg_temp.id('opp')), -80.1918, 'and longitude');
select pg_temp.as_platform();
update app.venues set location = null where id = pg_temp.id('venue_a');
select pg_temp.as_user('ivy');
select ok((select venue_latitude is null and venue_longitude is null from api_external.opportunities where id = pg_temp.id('opp')),
  'a venue that is not located has no coordinates, never a guessed position');
select pg_temp.as_platform();
select is(pg_temp.n('quinn', 'select 1 from api_external.opportunities where id = ''' || pg_temp.id('opp') || ''''), 0, 'an uninvited person never reads the invited listing');

-- Time box ---------------------------------------------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select is(pg_temp.n('ivy', 'select 1 from api_external.asset_custody'), 0, 'Complete: custody closes with the operational area');
select is(pg_temp.n('ivy', 'select 1 from api_external.travel'), 0, 'Complete: travel closes');
select is(pg_temp.n('ivy', 'select 1 from api_external.per_diems'), 0, 'Complete: per diems close');

-- Anon ----------------------------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok('select 1 from api_external.asset_custody', '42501', null, 'anon deny: asset custody');
select throws_ok('select 1 from api_external.travel', '42501', null, 'anon deny: travel');
select throws_ok('select 1 from api_external.settlements', '42501', null, 'anon deny: settlements');
select throws_ok('select 1 from api_external.settlement_lines', '42501', null, 'anon deny: settlement lines');
select throws_ok('select 1 from api_external.shared_reports', '42501', null, 'anon deny: shared reports');
select throws_ok('select 1 from api_external.per_diems', '42501', null, 'anon deny: per diems');
select pg_temp.as_platform();

select * from finish();
rollback;
