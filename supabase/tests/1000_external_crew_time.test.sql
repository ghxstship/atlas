-- pgTAP: migrations 0767 and 1000, crew and party projections over late-slot columns (Section 4.4.4, Section 8.7).
-- Shifts (published only), the engaged person's shift acceptance, time entries and timesheets with derived minutes,
-- party badges, vendor engagement dock slots and lodging. Access through the person's own engagement, an account
-- and a representation where they apply; denial for another party, another tenant and anon; the time box.
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
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');

-- Fixture -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with s as (insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '5000.51.02', '2027-06-01 12:00+00', '2027-06-01 22:00+00', 'America/New_York')
  returning id) insert into world select 'shift', id from s;
with s as (insert into app.shifts (project_id, engagement_id, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-06-02 12:00+00', '2027-06-02 22:00+00', 'America/New_York')
  returning id) insert into world select 'shift_draft', id from s;
with c as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'ARTIST', 'Artist Party') returning id)
  insert into world select 'cat_artist', id from c;
insert into app.credentials (credential_category_id, holder_person_id, engagement_id) values (pg_temp.id('cat_artist'), pg_temp.id('nina'), pg_temp.id('eng_art_a'));
with z as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'DOCK-A', 'North Loading Dock') returning id)
  insert into world select 'zone', id from z;
insert into app.dock_slots (project_id, zone_id, engagement_id, starts_at, ends_at)
values (pg_temp.id('prj_a'), pg_temp.id('zone'), pg_temp.id('eng_vendor_a'), '2027-06-01 08:00+00', '2027-06-01 09:00+00');
with b as (insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held, nightly_rate_minor, currency_code)
  values (pg_temp.id('prj_a'), 'Harbor Inn Crew Block', '2027-05-31', '2027-06-04', 4, 18900, 'USD') returning id)
  insert into world select 'block', id from b;
insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on) values
  (pg_temp.id('block'), pg_temp.id('ivy'), '2027-05-31', '2027-06-03'),
  (pg_temp.id('block'), pg_temp.id('art'), '2027-06-01', '2027-06-03');
select pg_temp.as_platform();

-- Shifts -----------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from api_external.shifts'), 0, 'a draft shift never reaches the worker');
select pg_temp.as_user('alice');
select app.transition_shift(pg_temp.id('shift'), 'Draft', 'Published', 'Published to crew.');
select pg_temp.as_platform();
select is(pg_temp.n('ivy', 'select 1 from api_external.shifts'), 1, 'own engagement: the published shift');
select is(pg_temp.n('quinn', 'select 1 from api_external.shifts'), 0, 'denial: another party');
select is(pg_temp.n('xavier', 'select 1 from api_external.shifts'), 0, 'denial: another tenant');
select pg_temp.as_user('ivy');
select is((select job_title from api_external.shifts), 'Head Arena / Festival Rigger', 'the role reads as a plain job title');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.accept_engaged_shift('%s')$$, pg_temp.id('shift')), '42501', null, 'another person cannot accept the shift');
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.accept_engaged_shift('%s')$$, pg_temp.id('shift_draft')), 'XR001', 'shift_state_conflict: The shift is not in the expected state Published.', 'a draft shift cannot be accepted');
select lives_ok(format($$select app.accept_engaged_shift('%s')$$, pg_temp.id('shift')), 'the engaged person accepts the published shift');
select is((select shift_state::text from api_external.shifts), 'Accepted', 'the shift is Accepted');
select pg_temp.as_platform();

-- Time entries and timesheets -------------------------------------------------------------------------------------------------------
insert into app.time_entries (project_id, engagement_id, shift_id, clock_in, clock_out, break_minutes)
values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), pg_temp.id('shift'), '2027-06-01 12:00+00', '2027-06-01 21:00+00', 30);
with t as (insert into app.timesheets (project_id, engagement_id, period_start, period_end) values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-06-01', '2027-06-07')
  returning id) insert into world select 'sheet', id from t;
select is(pg_temp.n('ivy', 'select 1 from api_external.time_entries'), 1, 'own engagement: the time entry');
select is(pg_temp.n('quinn', 'select 1 from api_external.time_entries'), 0, 'denial: another party''s time');
select pg_temp.as_user('ivy');
select is((select worked_minutes from api_external.timesheets), 510, 'timesheet minutes derive from the entries less breaks');
select lives_ok(format($$select app.submit_timesheet('%s')$$, pg_temp.id('sheet')), 'the engaged person submits through A13''s RPC');
select ok((select submitted_at is not null and timesheet_state = 'Submitted' from api_external.timesheets), 'the submission shows with its date');
select pg_temp.as_platform();
select is(pg_temp.n('xavier', 'select 1 from api_external.timesheets'), 0, 'denial: another tenant');

-- Party badges -------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('art', 'select 1 from api_external.credentials where engagement_id is not null'), 1, 'the artist reads the party badge issued under their engagement');
select is(pg_temp.n('rita', 'select 1 from api_external.credentials where engagement_id is not null'), 1, 'representation: the Advance representative reads it');
select is(pg_temp.n('ivy', 'select 1 from api_external.credentials'), 0, 'denial: another party');
select is(pg_temp.n('victor', 'select 1 from api_external.credentials'), 0, 'denial: a vendor account');

-- Dock slots of the vendor's engagement ---------------------------------------------------------------------------------------------------
select is(pg_temp.n('victor', 'select 1 from api_external.dock_slots'), 1, 'account: the vendor reads the slot booked for its engagement');
select is(pg_temp.n('ivy', 'select 1 from api_external.dock_slots'), 0, 'denial: another party');

-- Lodging ----------------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from api_external.lodging'), 1, 'own engagement: ivy reads her own room only');
select is(pg_temp.n('rita', 'select 1 from api_external.lodging'), 1, 'representation: the Advance representative reads the artist''s room');
select is(pg_temp.n('victor', 'select 1 from api_external.lodging'), 0, 'denial: a vendor account');
select hasnt_column('api_external', 'lodging', 'nightly_rate_minor', 'contracted rates never reach externals');

-- Time box ------------------------------------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select is(pg_temp.n('ivy', 'select 1 from api_external.shifts'), 1, 'Closing: shifts stay readable');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select is(pg_temp.n('ivy', 'select 1 from api_external.shifts'), 0, 'Complete: shifts close with the operational area');
select is(pg_temp.n('ivy', 'select 1 from api_external.timesheets'), 0, 'Complete: timesheets close');
select is(pg_temp.n('ivy', 'select 1 from api_external.lodging'), 0, 'Complete: lodging closes');
select pg_temp.as_anon();
select throws_ok('select 1 from api_external.shifts', '42501', null, 'anon deny');
select throws_ok('select 1 from api_external.lodging', '42501', null, 'anon deny on lodging');
select pg_temp.as_platform();

select * from finish();
rollback;
