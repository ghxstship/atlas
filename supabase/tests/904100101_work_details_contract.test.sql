-- pgTAP: migration 904100101 (R6b, 4.10), the contract half of R6a. The ten retired profile columns are gone and the
-- rest of the row stays. Ivy shares her dietary needs and her travel profile with her crew engagement; the Owner reads
-- uniform as null and a travel object that keeps seat_preference, meal_preference and home_airport, null, beside her
-- loyalty programs, and her allergies as R6a and ADR 0164 left them. Dietary and passport writes still pass the guard,
-- the erasure still erases, Uniform Sizes stays a category that no live share may name while the access log rows naming
-- it still read, and R6a's move function is gone. The migration's guard refuses while a retired value or a live Uniform
-- Sizes share remains (its query run again here, in this transaction).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(32);

create function pg_temp.read(p_who text, p_engagement text) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_who);
  v := app.shared_work_details(pg_temp.id(p_engagement));
  perform pg_temp.as_platform();
  return v;
end $$;

-- The migration's guard, as it ran: raises while a retired value or a live Uniform Sizes share remains.
create function pg_temp.contract_guard(p_retired_check text) returns void
language plpgsql as $$
begin
  if p_retired_check is not null then
    execute p_retired_check;
  end if;
  if exists (select 1 from app.work_detail_shares s
             where 'Uniform Sizes' = any (s.categories) and s.revoked_at is null and s.deleted_at is null) then
    raise exception using errcode = 'P0001', message = 'R6b: a live work detail share still names Uniform Sizes';
  end if;
end $$;

-- Schema ---------------------------------------------------------------------------------------------------------------------------
select hasnt_column('app', 'person_work_details', 'shirt_size', 'shirt_size is dropped');
select hasnt_column('app', 'person_work_details', 'jacket_size', 'jacket_size is dropped');
select hasnt_column('app', 'person_work_details', 'pants_size', 'pants_size is dropped');
select hasnt_column('app', 'person_work_details', 'shoe_size', 'shoe_size is dropped');
select hasnt_column('app', 'person_work_details', 'glove_size', 'glove_size is dropped');
select hasnt_column('app', 'person_work_details', 'hat_size', 'hat_size is dropped');
select hasnt_column('app', 'person_work_details', 'uniform_notes', 'uniform_notes is dropped');
select hasnt_column('app', 'person_work_details', 'seat_preference', 'seat_preference is dropped');
select hasnt_column('app', 'person_work_details', 'meal_preference', 'meal_preference is dropped');
select hasnt_column('app', 'person_work_details', 'home_airport', 'home_airport is dropped');
select ok((select count(*) = 9 from information_schema.columns where table_schema = 'app' and table_name = 'person_work_details'
  and column_name in ('dietary_needs', 'allergies', 'dietary_notes', 'accessibility_needs', 'accessibility_notes',
    'passport_number', 'passport_number_last4', 'passport_issuing_country', 'passport_name')),
  'dietary, allergy, accessibility and passport columns stay');
select has_column('app', 'person_work_details', 'passport_expires_on', 'and the passport expiry');
select ok(exists (select 1 from information_schema.columns where table_schema = 'app' and table_name = 'roster_uniform_sizes'
  and column_name = 'shirt_size') and exists (select 1 from information_schema.columns where table_schema = 'app'
  and table_name = 'roster_travel_requests' and column_name = 'seat_preference'), 'the roster tables keep their own columns (R5)');
select hasnt_function('private', 'move_profile_work_details', array[]::text[], 'R6a''s one-time move is gone');
select ok('Uniform Sizes' = any (enum_range(null::app.work_detail_category)), 'Uniform Sizes stays a work detail category');
select has_type('app', 'garment_letter_size', 'app.garment_letter_size stays for the roster');
select has_type('app', 'seat_preference', 'app.seat_preference stays for the roster');

-- Fixture: Ivy's details and share ------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select app.ensure_my_work_details();
select app.give_sensitive_consent('Dietary and Allergies', '2026-11-06', 'en-US', 'Atlas');
select lives_ok($$update app.person_work_details set dietary_needs = '{Vegan}', allergies = 'Peanuts', passport_name = 'IVY MARCHETTI'
  where person_id = (select id from world where key = 'ivy')$$, 'the guard lets dietary and passport details through');
select lives_ok($$select app.set_my_passport_number('YA0000TEST')$$, 'and the encrypting passport RPC');
insert into app.person_loyalty_programs (person_id, program_kind, program_name, member_number)
values (pg_temp.id('ivy'), 'Airline', 'SkyMiles', 'SM-0000-TEST');
select lives_ok(format($$select app.share_work_details(%L, '{Dietary Needs,Travel Profile}')$$, pg_temp.id('eng_ivy_a')),
  'Ivy shares her dietary needs and travel profile');
select pg_temp.as_platform();

-- The read ---------------------------------------------------------------------------------------------------------------------------
select ok(pg_temp.read('alice', 'eng_ivy_a') -> 'uniform' = 'null'::jsonb, 'uniform reads as null');
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.read('alice', 'eng_ivy_a') -> 'travel') k),
  array['home_airport', 'loyalty_programs', 'meal_preference', 'seat_preference'],
  'the travel object keeps its keys beside loyalty_programs');
select ok((select bool_and(pg_temp.read('alice', 'eng_ivy_a') -> 'travel' -> k = 'null'::jsonb)
  from unnest(array['seat_preference', 'meal_preference', 'home_airport']) k), 'and the three retired keys are null');
select is(pg_temp.read('alice', 'eng_ivy_a') #>> '{travel,loyalty_programs,0,program_name}', 'SkyMiles', 'the loyalty programs still read');
select is(pg_temp.read('alice', 'eng_ivy_a') #>> '{dietary,allergies}', 'Peanuts', 'the Owner reads the allergies, as R6a');
select is(pg_temp.read('bob', 'eng_ivy_a') #>> '{dietary,allergies_masked}', 'true', 'and a hospitality reader reads them masked');

-- Uniform Sizes in shares and the access log ---------------------------------------------------------------------------------------
select throws_ok(format($$update app.work_detail_shares set categories = '{Uniform Sizes,Dietary Needs}'
  where engagement_id = %L and revoked_at is null$$, pg_temp.id('eng_ivy_a')), '23514', null, 'no live share may name Uniform Sizes');
insert into app.work_detail_events (person_id, action, categories, changed_columns)
values (pg_temp.id('ivy'), 'work_details.viewed', array['Uniform Sizes']::app.work_detail_category[], '{}');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('ivy') and 'Uniform Sizes' = any (categories)), 1,
  'an access log row naming Uniform Sizes still reads');

-- The migration's guard ----------------------------------------------------------------------------------------------------------------
alter table app.person_work_details add column shirt_size text;
update app.person_work_details set shirt_size = 'M' where person_id = pg_temp.id('ivy');
select throws_ok($$select pg_temp.contract_guard($q$
  do $g$ begin
    if exists (select 1 from app.person_work_details where shirt_size is not null) then
      raise exception using errcode = 'P0001', message = 'R6b: a retired work detail column still holds a value';
    end if;
  end $g$ $q$)$$, 'P0001', 'R6b: a retired work detail column still holds a value', 'the guard refuses while a retired value remains');
alter table app.person_work_details drop column shirt_size;
alter table app.work_detail_shares drop constraint work_detail_shares_no_retired_category;
update app.work_detail_shares set categories = '{Uniform Sizes,Dietary Needs}' where engagement_id = pg_temp.id('eng_ivy_a') and revoked_at is null;
select throws_ok($$select pg_temp.contract_guard(null)$$, 'P0001', 'R6b: a live work detail share still names Uniform Sizes',
  'and while a live share names Uniform Sizes');

-- The erasure ------------------------------------------------------------------------------------------------------------------------
-- private.erase_work_details runs when the person is deleted (t60_erase_work_details on app.people, 1340).
select lives_ok(format($$update app.people set deleted_at = now() where id = %L$$, pg_temp.id('ivy')),
  'deleting the person runs the erasure');
select is((select count(*)::int from app.person_work_details where person_id = pg_temp.id('ivy')), 0,
  'and leaves nothing of the details');

select * from finish();
rollback;
