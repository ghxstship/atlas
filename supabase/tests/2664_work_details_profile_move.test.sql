-- pgTAP: migration 2664 (R6a, ADR 0102 decision 2), uniform sizes and travel preferences leave the profile. Ivy held both,
-- Quinn uniform sizes only and Art a seat preference only, as profiles did before R6a. The move deletes every value,
-- logs which columns held one (never the values), and sends each of them account.work_details_moved once, naming what
-- moved. Ivy's share of Uniform Sizes and Dietary Needs keeps Dietary Needs; Quinn's Uniform Sizes-only share is revoked
-- and its consent withdrawn with it. Loyalty programs, accessibility and dietary needs and the passport stay. Afterwards a
-- retired column takes no value, Uniform Sizes cannot be shared, and no live share names it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(22);

create function pg_temp.moved(p_person text) returns text
language sql as $$
  select string_agg(n.message_args ->> 'moved', ',') from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_person) and n.kind = 'account.work_details_moved'
$$;

-- Fixture: profiles as R6a found them, and shares naming Uniform Sizes -----------------------------------------------------
select pg_temp.as_user('ivy');
select app.ensure_my_work_details();
select app.set_my_passport_number('YA0000TEST');
insert into app.person_loyalty_programs (person_id, program_kind, program_name, member_number)
values (pg_temp.id('ivy'), 'Airline', 'SkyMiles', 'SM-0000-TEST');
select pg_temp.as_user('quinn');
select app.ensure_my_work_details();
select pg_temp.as_user('art');
select app.ensure_my_work_details();
select pg_temp.as_platform();

select private.begin_trusted_operation('work_details_profile_move');
update app.person_work_details set shirt_size = 'M', shoe_size = 'US 9', seat_preference = 'Aisle', home_airport = 'MIA',
  dietary_needs = '{Vegan}', allergies = 'Peanuts', accessibility_needs = '{Seating}', passport_name = 'IVY MARCHETTI'
where person_id = pg_temp.id('ivy');
update app.person_work_details set jacket_size = 'L', uniform_notes = 'Relaxed cut.' where person_id = pg_temp.id('quinn');
update app.person_work_details set seat_preference = 'Window' where person_id = pg_temp.id('art');
select private.end_trusted_operation('work_details_profile_move');

-- Shares as they stood before R6a.
alter table app.work_detail_shares drop constraint work_detail_shares_no_retired_category;
with c as (insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
  values (pg_temp.id('org_a'), pg_temp.id('ivy'), 'work_details_sharing', '1.0.0', 'Web') returning id),
s as (insert into app.work_detail_shares (engagement_id, person_id, consent_record_id, categories, roster_entry_id)
  select pg_temp.id('eng_ivy_a'), pg_temp.id('ivy'), c.id, '{Uniform Sizes,Dietary Needs}',
    (select r.id from app.engagement_roster_entries r where r.engagement_id = pg_temp.id('eng_ivy_a') and r.is_self) from c returning id)
insert into world select 'share_ivy', id from s;
with c as (insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
  values (pg_temp.id('org_b'), pg_temp.id('quinn'), 'work_details_sharing', '1.0.0', 'Web') returning id),
s as (insert into app.work_detail_shares (engagement_id, person_id, consent_record_id, categories, roster_entry_id)
  select pg_temp.id('eng_quinn_b'), pg_temp.id('quinn'), c.id, '{Uniform Sizes}',
    (select r.id from app.engagement_roster_entries r where r.engagement_id = pg_temp.id('eng_quinn_b') and r.is_self) from c returning id)
insert into world select 'share_quinn', id from s;
insert into world select 'consent_quinn', consent_record_id from app.work_detail_shares where id = pg_temp.id('share_quinn');

-- The move -----------------------------------------------------------------------------------------------------------------------
select is(private.move_profile_work_details(), 3, 'the move changes the three people who held a value');
alter table app.work_detail_shares add constraint work_detail_shares_no_retired_category
  check (revoked_at is not null or deleted_at is not null or not ('Uniform Sizes' = any (categories)));
select is((select count(*)::int from app.person_work_details where num_nonnulls(shirt_size, jacket_size, pants_size, shoe_size,
  glove_size, hat_size, uniform_notes, seat_preference, meal_preference, home_airport) > 0), 0, 'the ten columns are NULL everywhere');
select is((select changed_columns from app.work_detail_events where person_id = pg_temp.id('ivy') and action = 'work_details.fields_removed'),
  array['home_airport', 'seat_preference', 'shirt_size', 'shoe_size'], 'the access log names the columns that held a value');
select is((select changed_columns from app.work_detail_events where person_id = pg_temp.id('quinn') and action = 'work_details.fields_removed'),
  array['jacket_size', 'uniform_notes'], 'for each person');
select is((select count(*)::int from app.work_detail_events where action = 'work_details.fields_removed'
  and (changed_columns::text || coalesce(reason, '')) ~ '(MIA|Aisle|Relaxed|US 9)'), 0, 'never the values');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('ivy') and action = 'person_work_details.update'
  and changed_columns && array['shirt_size', 'home_airport']), 0, 'the move writes no owner change entry');
select is(pg_temp.moved('ivy'), 'both', 'Ivy is told her uniform sizes and travel preferences moved');
select is(pg_temp.moved('quinn'), 'uniform', 'Quinn that her uniform sizes did');
select is(pg_temp.moved('art'), 'travel', 'Art that his travel preferences did');
select is(pg_temp.moved('alice'), null, 'nobody else is told');

select results_eq($$select dietary_needs::text, allergies, accessibility_needs::text, passport_name, passport_number_last4
  from app.person_work_details where person_id = (select id from world where key = 'ivy')$$,
  $$values ('{Vegan}'::text, 'Peanuts'::text, '{Seating}'::text, 'IVY MARCHETTI'::text, 'TEST'::text)$$,
  'dietary and accessibility needs and the passport are untouched');
select is((select count(*)::int from app.person_loyalty_programs where person_id = pg_temp.id('ivy') and deleted_at is null), 1,
  'and the loyalty programs');

-- Shares -------------------------------------------------------------------------------------------------------------------------
select is((select categories::text from app.work_detail_shares where id = pg_temp.id('share_ivy') and revoked_at is null),
  '{"Dietary Needs"}', 'a share of Uniform Sizes and Dietary Needs keeps Dietary Needs');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('ivy') and action = 'work_details.share_changed'), 1,
  'logged as a share change');
select ok((select revoked_at is not null from app.work_detail_shares where id = pg_temp.id('share_quinn')), 'a Uniform Sizes-only share is revoked');
select ok((select withdrawn_at is not null from app.consent_records where id = pg_temp.id('consent_quinn')),
  'and its consent is withdrawn with the last share');
select ok(exists (select 1 from pg_constraint where conname = 'work_detail_shares_no_retired_category'
  and conrelid = 'app.work_detail_shares'::regclass), 'the constraint work_detail_shares_no_retired_category exists');
select throws_ok(format($$update app.work_detail_shares set categories = '{Uniform Sizes,Dietary Needs}' where id = %L$$, pg_temp.id('share_ivy')),
  '23514', null, 'no live share names Uniform Sizes');

-- Afterwards ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select throws_like($$update app.person_work_details set shirt_size = 'L' where person_id = (select id from world where key = 'ivy')$$,
  'work_detail_field_moved:%', 'writing a retired column is refused');
select lives_ok($$update app.person_work_details set seat_preference = null, dietary_needs = '{Vegan,Halal}'
  where person_id = (select id from world where key = 'ivy')$$, 'clearing one, or changing the others, is not');
select throws_like(format($$select app.share_work_details(%L, '{Uniform Sizes,Dietary Needs}')$$, pg_temp.id('eng_ivy_a')),
  'work_detail_category_retired:%', 'sharing Uniform Sizes is refused');
select pg_temp.as_user('art');
select throws_like($$insert into app.person_work_details (person_id, home_airport) values ((select id from world where key = 'art'), 'FLL')$$,
  'work_detail_field_moved:%', 'so is a new row with a retired value');
select pg_temp.as_platform();

select * from finish();
rollback;
