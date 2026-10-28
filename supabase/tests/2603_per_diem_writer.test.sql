-- pgTAP: migration 2603 (R1), app.add_per_diems. Three days for a member and for an Active individual engagement;
-- the range, day taken, one worker and member org refusals; the engaged worker triggers still refuse a company
-- engagement and an Onboarding one; callers without crew.time_entry.write get 42501 and can_add_per_diems says false;
-- the engaged person reads their own per diems through api_external.per_diems.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, counterparty_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_v_a'), 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2027-06-01')
  returning id) insert into world select 'eng_company', id from x;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_company', 'Onboarding', 'Active');

select pg_temp.as_user('carol');
select is(app.add_per_diems(pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), null, '2027-06-01', '2027-06-03', 6500, 'USD'), 3,
  'three days are added for a member');
select is((select count(*)::int from app.per_diems where membership_id = pg_temp.id('dave@org_a') and deleted_at is null), 3, 'one row a day');
select is((select org_id from app.per_diems where membership_id = pg_temp.id('dave@org_a') limit 1), pg_temp.id('org_a'), 'with the project''s org');
select is(app.add_per_diems(pg_temp.id('prj_a'), null, pg_temp.id('eng_ivy_a'), '2027-06-01', '2027-06-03', 7000, 'USD'), 3,
  'three days are added for an Active individual engagement');

select throws_ok(format($$select app.add_per_diems(%L, %L, null, '2027-07-01', '2027-09-01', 6500, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('dave@org_a')),
  'XR001', 'per_diem_range: Per diems cover 1 to 62 days, from the first day to the last.', 'a 63-day range is refused');
select throws_ok(format($$select app.add_per_diems(%L, %L, null, '2027-06-05', '2027-06-04', 6500, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('dave@org_a')),
  'XR001', null, 'a range that runs backwards is refused');
select lives_ok(format($$select app.add_per_diems(%L, %L, null, '2027-07-01', '2027-08-31', 6500, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('dave@org_a')),
  '62 days are allowed');
select throws_ok(format($$select app.add_per_diems(%L, %L, null, '2027-05-30', '2027-06-02', 6500, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('dave@org_a')),
  'XR001', 'per_diem_day_taken: A per diem for 2027-06-01 is already recorded.', 'a day already taken is refused and named');
select throws_ok(format($$select app.add_per_diems(%L, null, %L, '2027-06-03', '2027-06-04', 6500, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a')),
  'XR001', 'per_diem_day_taken: A per diem for 2027-06-03 is already recorded.', 'for an engagement too');
select throws_ok(format($$select app.add_per_diems(%L, %L, %L, '2027-06-10', '2027-06-11', 6500, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), pg_temp.id('eng_ivy_a')),
  'XR001', 'per_diem_one_worker: A per diem goes to one member or one engagement.', 'two workers are refused');
select throws_ok(format($$select app.add_per_diems(%L, null, null, '2027-06-10', '2027-06-11', 6500, 'USD')$$, pg_temp.id('prj_a')),
  'XR001', 'per_diem_one_worker: A per diem goes to one member or one engagement.', 'no worker is refused');
select throws_ok(format($$select app.add_per_diems(%L, %L, null, '2027-06-10', '2027-06-11', 6500, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('xavier@org_b')),
  'XR001', 'per_diem_member_org: Per diems go to a current member of the project''s org.', 'another org''s membership is refused');
select throws_ok(format($$select app.add_per_diems(%L, null, %L, '2027-06-10', '2027-06-11', 6500, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('eng_company')),
  'XR001', 'engagement_worker_person: Time and shifts go to an engagement that names the person who works.', 'a company engagement is refused by the worker trigger');
select throws_ok(format($$select app.add_per_diems(%L, null, %L, '2027-06-10', '2027-06-11', 6500, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('eng_art_a')),
  'XR001', 'engagement_not_working: External crew record time only while their engagement is Active or Closing.', 'an Onboarding engagement is refused');
select throws_ok(format($$select app.add_per_diems(%L, null, %L, '2027-06-10', '2027-06-11', 6500, 'USD')$$, pg_temp.id('prj_a2'), pg_temp.id('eng_ivy_a')),
  'XR001', null, 'another project''s engagement is refused');
select is((select count(*)::int from app.per_diems where engagement_id = pg_temp.id('eng_ivy_a')), 3, 'a refused call adds nothing');

-- Who may add -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select app.add_per_diems(%L, %L, null, '2027-06-10', '2027-06-11', 6500, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('dave@org_a')),
  '42501', 'crew.time_entry.write is required on the project', 'without crew.time_entry.write: 42501');
select pg_temp.as_user('erin');
select throws_ok(format($$select app.add_per_diems(%L, %L, null, '2027-06-10', '2027-06-11', 6500, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('dave@org_a')),
  '42501', null, 'a Collaborator on the project has no crew.time_entry.write');
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.add_per_diems(%L, null, %L, '2027-06-10', '2027-06-11', 6500, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a')),
  '42501', null, 'the engaged person cannot add their own');
select pg_temp.as_anon();
select throws_ok(format($$select app.add_per_diems(%L, %L, null, '2027-06-10', '2027-06-11', 6500, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('dave@org_a')),
  '42501', null, 'anon is refused');

-- app.can_add_per_diems answers the same question for the Atlas controls.
select pg_temp.as_user('carol');
select ok(app.can_add_per_diems(pg_temp.id('prj_a')), 'can_add_per_diems: true with crew.time_entry.write on the project');
select pg_temp.as_user('gina');
select ok(not app.can_add_per_diems(pg_temp.id('prj_a')), 'can_add_per_diems: false without it');
select pg_temp.as_user('erin');
select ok(not app.can_add_per_diems(pg_temp.id('prj_a')), 'can_add_per_diems: false for a Collaborator on the project');
select pg_temp.as_user('ivy');
select ok(not app.can_add_per_diems(pg_temp.id('prj_a')), 'can_add_per_diems: false for the engaged person');
select pg_temp.as_anon();
select throws_ok(format($$select app.can_add_per_diems(%L)$$, pg_temp.id('prj_a')), '42501', null, 'can_add_per_diems: anon may not call it');

-- Reading and removing ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select is((select count(*)::int from api_external.per_diems), 3, 'the engaged person reads their own per diems');
select is((select sum(amount_minor)::bigint from api_external.per_diems), 21000::bigint, 'at the amount added');
select pg_temp.as_user('carol');
update app.per_diems set deleted_at = now() where engagement_id = pg_temp.id('eng_ivy_a') and day = '2027-06-02';
select is(app.add_per_diems(pg_temp.id('prj_a'), null, pg_temp.id('eng_ivy_a'), '2027-06-02', '2027-06-02', 7000, 'USD'), 1,
  'a removed day can be added again');
select pg_temp.as_user('ivy');
select is((select count(*)::int from api_external.per_diems), 3, 'a removed per diem no longer reads');

select * from finish();
rollback;
